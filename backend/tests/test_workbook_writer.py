"""The first full loop: a finished register -> Fiona and Jess update their workbooks
-> their notes show at the top of the next session in the builder."""
import os
import unittest
from datetime import date
from unittest import mock

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.services import ai_operations, session_builder  # noqa: E402
from backend.services import workbook_writer as WW  # noqa: E402
from backend.services import workbooks as W  # noqa: E402
from backend.tests import reset_database  # noqa: E402

DAY = date(2026, 10, 5)


class FirstLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", active=True)
            leo = models.Swimmer(name="Leo Marsh", squad="Silver 1", active=True)
            db.add_all([ruby, leo])
            db.flush()
            s = models.Session(date=DAY, squad="Silver 1", status="completed",
                               as_swum={"status": "changed", "note": "Main set cut to 3 rounds"})
            db.add(s)
            db.flush()
            session_builder.apply_builder(db, s, {
                "date": DAY.isoformat(), "slot": "AM", "groups": [],
                "blocks": [{"id": "b1", "name": "Main", "groups": [], "items": [
                    {"id": "l1", "t": "line", "reps": 4, "dist": 100, "desc": "Race pace", "int": 100, "int2": None,
                     "rest": None, "est": None, "eff": "19"}]}]})
            db.add(models.SessionEntry(session_id=s.id, swimmer_id=ruby.id, attended=True, group_done=1, response="flat",
                                       coach_observation="Faded on the last two"))
            db.add(models.SessionEntry(session_id=s.id, swimmer_id=leo.id, attended=False))
            db.commit()
            self.session_id, self.ruby = s.id, ruby.id

    def fake_ask(self, seen):
        def ask(system, user):
            seen.append((system, user))
            if "Physiologist" in system:
                return {"edits": [
                    {"kind": "journal", "text": "Ruby flat on race pace (session %d)" % self.session_id},
                    {"kind": "section", "path": "swimmers/ruby-wheeler.md", "title": "Ruby Wheeler", "heading": "Recovery",
                     "text": "- Flat after race pace, 5 Oct (session %d)" % self.session_id, "confidence": "hypothesis",
                     "summary": "Possibly slow to recover from race pace", "swimmers": [self.ruby]},
                    {"kind": "section", "path": "../analyst/races.md", "heading": "x", "text": "not mine"},
                ]}
            return {"edits": [{"kind": "section", "path": "style/current-style.md", "heading": "Changes on deck",
                               "text": "- 5 Oct: main set cut to 3 rounds", "confidence": "seen-once"}]}
        return ask

    def test_the_staff_learn_from_a_finished_session(self):
        seen = []
        with SessionLocal() as db:
            out = WW.update_after_session(db, db.get(models.Session, self.session_id), ask=self.fake_ask(seen))
            self.assertEqual(out["physiologist"]["saved"], ["journal", "swimmers/ruby-wheeler.md"])
            self.assertEqual(len(out["physiologist"]["refused"]), 1, "a page outside her folders is refused")
            self.assertEqual(out["sessions"]["saved"], ["style/current-style.md"])

            physio_user = seen[0][1]
            self.assertIn("Ruby Wheeler (id %d, page swimmers/ruby-wheeler.md): swam" % self.ruby, physio_user)
            self.assertIn("went flat; coach's note: Faded on the last two", physio_user)
            self.assertIn("Leo Marsh: absent", physio_user)
            self.assertIn("changed on deck - Main set cut to 3 rounds", seen[1][1])

            page = W.get_page(db, "physiologist", "swimmers/ruby-wheeler.md")
            self.assertEqual((page.confidence, page.swimmer_ids, page.title), ("hypothesis", [self.ruby], "Ruby Wheeler"))
            self.assertEqual(W.history(db, "physiologist", "swimmers/ruby-wheeler.md")[0]["trigger"], f"session:{self.session_id}")
            notes = WW.recent_notes(db)
            self.assertEqual(notes[0]["name"], "Fiona")
            self.assertIn("Ruby flat on race pace", notes[0]["text"])
            # everything that session taught them can be undone together
            undone = W.undo_trigger(db, f"session:{self.session_id}")
            self.assertEqual(len(undone["undone"]), 3)
            self.assertIsNone(W.get_page(db, "physiologist", "swimmers/ruby-wheeler.md"))

    def test_it_runs_from_the_queue_after_the_session_is_assessed(self):
        seen = []
        with SessionLocal() as db:
            op = ai_operations.enqueue_operation(db, operation_type="workbook_update", title="t",
                                                 entity_type="session", entity_id=self.session_id)
            db.commit()
            op_id = op.id
        with mock.patch.object(WW, "_ask", self.fake_ask(seen)):
            self.assertTrue(ai_operations.process_operation(op_id))
        with SessionLocal() as db:
            row = db.get(models.AIOperation, op_id)
            self.assertEqual(row.status, "completed", row.error)
            self.assertIn("The staff made 3 workbook changes; 1 refused by the rules.", row.result_summary)

    def test_the_builder_shows_the_latest_notes(self):
        with SessionLocal() as db:
            WW.update_after_session(db, db.get(models.Session, self.session_id), ask=self.fake_ask([]))
            payload = session_builder.payload(db, db.get(models.Session, self.session_id))
            self.assertTrue(any("Ruby flat" in n["text"] for n in payload["staff_notes"]))


if __name__ == "__main__":
    unittest.main()
