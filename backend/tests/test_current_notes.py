"""Injuries and other notes that hold right now.

The coach says "Amy has a shoulder injury" in a debrief. The debrief proposes an
ongoing note; once the coach confirms it, it shows at the top of the Session Builder
for every session Amy is in, and the staff plan around it, until the coach clears it
or its end date passes.
"""
import os
import unittest
from datetime import date, timedelta
from unittest import mock

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import claude_service, current_notes  # noqa: E402
from backend.services.staff_room import Subject, role_context  # noqa: E402
from backend.tests import reset_database  # noqa: E402

TODAY = date.today()


class CurrentNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            self.ids = {}
            for name, squad in (("Amy", "Silver 1"), ("Ben", "Silver 1"), ("Cal", "Gold")):
                s = models.Swimmer(name=name, squad=squad, active=True)
                db.add(s)
                db.flush()
                self.ids[name] = s.id
            db.commit()

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def new_session(self, http, h, squad="Silver 1", audience=None):
        r = http.post("/session-builder/sessions", headers=h,
                      json={"date": TODAY.isoformat(), "squad": squad, "audience": audience})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def add(self, http, h, name, **body):
        r = http.post("/current-notes", headers=h, json={"swimmer_id": self.ids[name], **body})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def test_the_builder_shows_whats_on_now_for_the_swimmers_the_session_is_for(self):
        http, h = self.client()
        with http:
            self.add(http, h, "Amy", kind="injury", title="Left shoulder", impact="No fly, easy on pull")
            self.add(http, h, "Ben", kind="other", title="Mock exams", detail="Short on sleep")
            self.add(http, h, "Cal", kind="injury", title="Knee")

            squad = http.get(f"/current-notes/session/{self.new_session(http, h)}", headers=h).json()
            self.assertEqual(squad["scope"], "squad")
            self.assertEqual([n["title"] for n in squad["injuries"]], ["Left shoulder"], "Gold's swimmer isn't in this squad")
            self.assertEqual(squad["injuries"][0]["impact"], "No fly, easy on pull")
            self.assertEqual([n["title"] for n in squad["other"]], ["Mock exams"])

            ben_only = self.new_session(http, h, audience={"kind": "swimmer", "swimmer_ids": [self.ids["Ben"]]})
            just_ben = http.get(f"/current-notes/session/{ben_only}", headers=h).json()
            self.assertEqual(just_ben["scope"], "session")
            self.assertEqual(just_ben["injuries"], [])
            self.assertEqual([n["swimmer_name"] for n in just_ben["other"]], ["Ben"])

    def test_once_the_register_is_taken_it_is_who_came(self):
        http, h = self.client()
        with http:
            self.add(http, h, "Amy", kind="injury", title="Left shoulder")
            sid = self.new_session(http, h)
            with SessionLocal() as db:
                db.add(models.SessionEntry(session_id=sid, swimmer_id=self.ids["Amy"], attended=False))
                db.add(models.SessionEntry(session_id=sid, swimmer_id=self.ids["Ben"], attended=True))
                db.commit()
            shown = http.get(f"/current-notes/session/{sid}", headers=h).json()
            self.assertEqual(shown["injuries"], [], "Amy wasn't there")

    def test_a_note_goes_when_cleared_or_when_its_end_date_passes(self):
        http, h = self.client()
        with http:
            shoulder = self.add(http, h, "Amy", kind="injury", title="Left shoulder")
            self.add(http, h, "Ben", kind="illness", title="Cold", date_from=(TODAY - timedelta(days=5)).isoformat(),
                     until=(TODAY - timedelta(days=1)).isoformat())
            self.assertEqual([n["title"] for n in http.get("/current-notes", headers=h).json()], ["Left shoulder"])

            r = http.post(f"/current-notes/{shoulder['id']}/clear", headers=h, json={"why": "Back to full"})
            self.assertFalse(r.json()["active"])
            self.assertEqual(http.get("/current-notes", headers=h).json(), [])
            history = http.get(f"/current-notes?swimmer_id={self.ids['Amy']}&include_cleared=true", headers=h).json()
            self.assertEqual(history[0]["cleared_note"], "Back to full")

            self.assertTrue(http.post(f"/current-notes/{shoulder['id']}/reopen", headers=h).json()["active"])
            changed = http.patch(f"/current-notes/{shoulder['id']}", headers=h,
                                 json={"impact": "Kick only", "until": (TODAY + timedelta(days=7)).isoformat()}).json()
            self.assertEqual(changed["impact"], "Kick only")
            self.assertEqual(http.patch(f"/current-notes/{shoulder['id']}", headers=h,
                                        json={"until": (TODAY - timedelta(days=30)).isoformat()}).status_code, 422)

    def test_the_staff_are_told_and_plan_around_it(self):
        with SessionLocal() as db:
            current_notes.create(db, self.ids["Amy"], "injury", "Left shoulder", impact="No fly")
            db.commit()
            text = role_context("physiologist", db, Subject(session_date=TODAY, squad="Silver 1",
                                                            attendee_ids=[self.ids["Amy"], self.ids["Ben"]]))
            self.assertIn("RIGHT NOW", text)
            self.assertIn("Amy", text)
            self.assertIn("No fly", text)
            elsewhere = role_context("physiologist", db, Subject(session_date=TODAY, attendee_ids=[self.ids["Ben"]]))
            self.assertNotIn("Left shoulder", elsewhere)

    def _debrief(self, db, proposals, session_id=None):
        row = models.SessionDebrief(session_id=session_id, date=TODAY, title="Debrief", status="ready",
                                    messages=[], proposals=proposals)
        db.add(row)
        db.commit()
        return row.id

    def test_the_debrief_saves_an_ongoing_note_and_clears_one_when_the_coach_confirms(self):
        with SessionLocal() as db:
            cold = current_notes.create(db, self.ids["Ben"], "illness", "Cold")
            db.commit()
            debrief_id = self._debrief(db, [
                {"id": "1-0", "kind": "ongoing", "swimmer_id": self.ids["Amy"], "swimmer_name": "Amy",
                 "content": "Sore left shoulder after fly.", "ongoing_kind": "injury", "title": "Left shoulder",
                 "impact": "No fly", "until": None, "note_id": None, "status": "proposed"},
                {"id": "1-1", "kind": "ongoing_clear", "swimmer_id": self.ids["Ben"], "swimmer_name": "Ben",
                 "content": "Over his cold.", "note_id": cold.id, "status": "proposed"},
                {"id": "1-2", "kind": "ongoing", "swimmer_id": self.ids["Cal"], "swimmer_name": "Cal",
                 "content": "Tight hamstring.", "ongoing_kind": "injury", "title": "Hamstring", "status": "proposed"},
            ])
        http, h = self.client()
        with http:
            r = http.post(f"/session-debriefs/{debrief_id}/commit", headers=h, json={"decisions": [
                {"id": "1-0", "status": "accepted", "impact": "No fly, no paddles",
                 "until": (TODAY + timedelta(days=14)).isoformat()},
                {"id": "1-1", "status": "accepted"},
                {"id": "1-2", "status": "rejected"},
            ]})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["committed"]["ongoing"], 1)
            self.assertEqual(r.json()["committed"]["cleared"], 1)
            active = http.get("/current-notes", headers=h).json()
        self.assertEqual([(n["swimmer_name"], n["title"]) for n in active], [("Amy", "Left shoulder")])
        self.assertEqual(active[0]["impact"], "No fly, no paddles", "the coach's correction wins")
        self.assertEqual(active[0]["until"], (TODAY + timedelta(days=14)).isoformat())
        self.assertEqual(active[0]["source"], "debrief")
        with SessionLocal() as db:
            obs = db.query(models.SwimmerObservation).filter(models.SwimmerObservation.swimmer_id == self.ids["Amy"]).all()
            self.assertEqual(len(obs), 1, "it's also on Amy's history")

    def test_the_debrief_asks_about_an_active_note_and_can_propose_clearing_it(self):
        http, h = self.client()
        with http:
            sid = self.new_session(http, h)
        with SessionLocal() as db:
            shoulder = current_notes.create(db, self.ids["Amy"], "injury", "Left shoulder", impact="No fly")
            other = current_notes.create(db, self.ids["Ben"], "other", "Mock exams")
            db.add(models.SessionEntry(session_id=sid, swimmer_id=self.ids["Amy"], attended=True))
            db.commit()
            debrief_id = self._debrief(db, [], session_id=sid)
            row = db.get(models.SessionDebrief, debrief_id)
            row.messages = [{"role": "coach", "message": "Amy's shoulder is fine now, back to full."}]
            db.commit()
            self.assertIn("ongoing injury", claude_service.build_session_debrief_context(row, db))

            fake = (
                '[{"kind": "ongoing_clear", "swimmer_id": %d, "swimmer_name": "Amy", "content": "Shoulder fine",'
                ' "note_id": %d, "confidence": "high"},'
                ' {"kind": "ongoing_clear", "swimmer_id": %d, "swimmer_name": "Amy", "content": "wrong swimmer",'
                ' "note_id": %d}]' % (self.ids["Amy"], shoulder.id, self.ids["Amy"], other.id)
            )
            with mock.patch.object(claude_service, "create_message", return_value=None) as ask, \
                    mock.patch.object(claude_service, "response_text", return_value=fake):
                proposals = claude_service.extract_session_debrief(row, db)
            self.assertIn("Left shoulder", ask.call_args.kwargs["messages"][0]["content"])
        self.assertEqual([(p["kind"], p["note_id"]) for p in proposals], [("ongoing_clear", shoulder.id)],
                         "a note can only be cleared for the swimmer it belongs to")


if __name__ == "__main__":
    unittest.main()
