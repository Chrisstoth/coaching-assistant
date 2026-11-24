"""Usual sessions are one list, and the swimmer manager asks when the register
keeps saying otherwise (docs/design/season-planner-weeks.md, 4.4)."""
import os
import unittest
from datetime import date, datetime, timedelta, timezone

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import usual_sessions  # noqa: E402
from backend.tests import reset_database  # noqa: E402

MON = date(2026, 10, 5)


class UsualSessionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            slot = models.PoolSlot(day_of_week=0, time="18:00", end_time="19:30", squad="Silver 1", active=True)
            sam = models.Swimmer(name="Sam Regular", squad="Silver 1", active=True)
            ali = models.Swimmer(name="Ali Extra", squad="Silver 1", active=True)
            jo = models.Swimmer(name="Jo Steady", squad="Silver 1", active=True)
            db.add_all([slot, sam, ali, jo])
            db.flush()
            db.add_all([models.SwimmerSlot(swimmer_id=sam.id, pool_slot_id=slot.id),
                        models.SwimmerSlot(swimmer_id=jo.id, pool_slot_id=slot.id)])
            self.sessions = []
            for k in range(4):
                s = models.Session(date=MON + timedelta(weeks=k), squad="Silver 1", pool_slot_id=slot.id, status="completed",
                                   register_saved_at=datetime.now(timezone.utc))
                db.add(s)
                db.flush()
                db.add_all([models.SessionEntry(session_id=s.id, swimmer_id=sam.id, attended=False),
                            models.SessionEntry(session_id=s.id, swimmer_id=ali.id, attended=True),
                            models.SessionEntry(session_id=s.id, swimmer_id=jo.id, attended=k != 2)])
                self.sessions.append(s.id)
            db.commit()
            self.slot, self.sam, self.ali, self.jo = slot.id, sam.id, ali.id, jo.id

    def tearDown(self):
        reset_database()

    def check(self):
        with SessionLocal() as db:
            return [(n.swimmer_ids[0], n.proposed_action["payload"]["attend"], n.question)
                    for n in usual_sessions.check(db, db.get(models.Session, self.sessions[-1]))]

    def test_the_swimmer_manager_asks_when_the_register_keeps_saying_otherwise(self):
        found = sorted(self.check())
        self.assertEqual(found, sorted([
            (self.sam, False, "Take Monday PM off Sam's usual sessions?"),
            (self.ali, True, "Add Monday PM to Ali's usual sessions?"),
        ]), "Jo missed once: not a pattern")
        self.assertEqual(self.check(), [], "asked once, not after every register")

        http = TestClient(app)
        with http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            notes = http.get("/staff/notes", headers=h).json()
            notes = notes.get("notes", notes) if isinstance(notes, dict) else notes
            sam_note = next(n for n in notes if self.sam in (n.get("swimmer_ids") or []))
            self.assertEqual(sam_note["proposed_action"]["label"], "Change their usual sessions")
            self.assertEqual(http.post(f"/staff/notes/{sam_note['id']}/apply", headers=h).status_code, 200)
            slots = {s["id"]: s["attending"] for s in http.get(f"/schedule/swimmers/{self.sam}", headers=h).json()}
            self.assertFalse(slots[self.slot], "the coach said yes: off Sam's list, the same list the register uses")

    def test_time_away_is_not_a_pattern(self):
        with SessionLocal() as db:
            db.add(models.SwimmerException(swimmer_id=self.sam, reason="exams", date_from=MON + timedelta(weeks=1),
                                           date_to=MON + timedelta(weeks=1)))
            db.add(models.SwimmerCurrentNote(swimmer_id=self.ali, kind="injury", title="Shoulder", date_from=MON))
            db.commit()
        self.assertEqual(self.check(), [], "excused runs don't count")

    def test_an_extra_or_cancelled_session_is_not_looked_at(self):
        with SessionLocal() as db:
            s = db.get(models.Session, self.sessions[-1])
            s.extra_session = True
            db.commit()
        self.assertEqual(self.check(), [])


if __name__ == "__main__":
    unittest.main()
