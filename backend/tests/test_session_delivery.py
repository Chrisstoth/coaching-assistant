"""Running a session: the coach marks the plan ready, then takes notes poolside.

The notes are the coach's own words at the time. They don't touch a swimmer's
record; the debrief reads them and proposes records for the coach to confirm.
"""
import os
import unittest
from datetime import date

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import session_notes  # noqa: E402
from backend.services.claude_service import build_session_debrief_context  # noqa: E402
from backend.tests import reset_database  # noqa: E402

FRIDAY = date(2026, 11, 13)


class SessionDeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            self.swimmers = {}
            for name in ("Amy", "Ben"):
                s = models.Swimmer(name=name, squad="Silver 1", active=True)
                db.add(s)
                db.flush()
                self.swimmers[name] = s.id
            slot = models.PoolSlot(day_of_week=4, time="20:30", end_time="21:30", squad="Silver 1", label="Fri PM")
            db.add(slot)
            db.commit()
            self.slot_id = slot.id

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def new_session(self, http, h):
        r = http.post("/session-builder/sessions", headers=h,
                      json={"date": FRIDAY.isoformat(), "pool_slot_id": self.slot_id})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def calendar_item(self, http, h, session_id):
        days = http.get(f"/sessions/calendar?week_start=2026-11-09", headers=h).json()
        return next(i for d in days for i in d["items"] if i["session_id"] == session_id)

    def test_the_coach_marks_a_written_session_ready_and_can_take_it_back(self):
        http, h = self.client()
        with http:
            sid = self.new_session(http, h)
            self.assertFalse(http.get(f"/session-builder/sessions/{sid}", headers=h).json()["plan_ready"])
            self.assertFalse(self.calendar_item(http, h, sid)["plan_ready"])

            r = http.put(f"/sessions/{sid}/ready", headers=h, json={"ready": True})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["plan_ready"])
            self.assertTrue(self.calendar_item(http, h, sid)["plan_ready"], "Home shows it as ready")
            self.assertTrue(http.get(f"/session-builder/sessions/{sid}", headers=h).json()["plan_ready"])
            self.assertTrue(http.get(f"/sessions/{sid}", headers=h).json()["plan_ready"])

            http.put(f"/sessions/{sid}/ready", headers=h, json={"ready": False})
            self.assertFalse(http.get(f"/sessions/{sid}", headers=h).json()["plan_ready"])

    def test_a_cancelled_session_cant_be_marked_ready(self):
        http, h = self.client()
        with http:
            sid = self.new_session(http, h)
            http.post("/sessions/calendar/cancel", headers=h,
                      json={"date": FRIDAY.isoformat(), "session_id": sid, "reason": "Pool closed"})
            r = http.put(f"/sessions/{sid}/ready", headers=h, json={"ready": True})
            self.assertEqual(r.status_code, 409)

    def test_notes_are_about_the_session_a_set_or_swimmers_and_a_retried_save_is_kept_once(self):
        http, h = self.client()
        amy, ben = self.swimmers["Amy"], self.swimmers["Ben"]
        with http:
            sid = self.new_session(http, h)
            note = {
                "client_id": "phone-1", "text": "  Breathing to the left again on the kick  ",
                "swimmer_ids": [amy, 9999, amy],
                "set_ref": {"block_id": "b1", "line_id": "l1", "label": "Kick · 8x50 kick @1:00"},
                "noted_at": "2026-11-13T20:42:00Z",
            }
            r = http.post(f"/sessions/{sid}/notes", headers=h, json=note)
            self.assertEqual(r.status_code, 201, r.text)
            saved = r.json()
            self.assertEqual(saved["text"], "Breathing to the left again on the kick")
            self.assertEqual(saved["swimmer_ids"], [amy], "unknown swimmers and repeats are dropped")
            self.assertEqual(saved["swimmer_names"], ["Amy"])
            self.assertEqual(saved["set_ref"]["label"], "Kick · 8x50 kick @1:00")

            again = http.post(f"/sessions/{sid}/notes", headers=h, json=note)
            self.assertEqual(again.json()["id"], saved["id"], "the phone retrying after losing signal")
            http.post(f"/sessions/{sid}/notes", headers=h, json={"text": "Main set cut to 3 rounds"})
            self.assertEqual(len(http.get(f"/sessions/{sid}/notes", headers=h).json()), 2)

            self.assertEqual(http.post(f"/sessions/{sid}/notes", headers=h, json={"text": "  "}).status_code, 422)

            edited = http.put(f"/sessions/{sid}/notes/{saved['id']}", headers=h,
                              json={"text": "Breathing left on the kick", "swimmer_ids": [amy, ben], "clear_set": True}).json()
            self.assertEqual(edited["swimmer_names"], ["Amy", "Ben"])
            self.assertIsNone(edited["set_ref"])

            other = self.new_other_session(http, h)
            self.assertEqual(http.delete(f"/sessions/{other}/notes/{saved['id']}", headers=h).status_code, 404,
                             "a note is only reachable through its own session")
            self.assertEqual(http.delete(f"/sessions/{sid}/notes/{saved['id']}", headers=h).status_code, 204)
            self.assertEqual(len(http.get(f"/sessions/{sid}/notes", headers=h).json()), 1)

    def new_other_session(self, http, h):
        r = http.post("/session-builder/sessions", headers=h, json={"date": "2026-11-14"})
        return r.json()["id"]

    def test_deleting_a_session_deletes_its_notes(self):
        http, h = self.client()
        with http:
            sid = self.new_session(http, h)
            http.post(f"/sessions/{sid}/notes", headers=h, json={"text": "Good energy tonight"})
            self.assertEqual(http.delete(f"/sessions/{sid}", headers=h).status_code, 204)
        with SessionLocal() as db:
            self.assertEqual(db.query(models.SessionNote).count(), 0)

    def test_the_staff_read_the_notes_in_pool_clock_time(self):
        http, h = self.client()
        with http:
            sid = self.new_session(http, h)
            # British Summer Time: 19:42 UTC is 20:42 on the pool clock.
            http.post(f"/sessions/{sid}/notes", headers=h, json={
                "text": "Held 1:20s", "swimmer_ids": [self.swimmers["Ben"]],
                "set_ref": {"label": "Main · 10x100 @1:30"}, "noted_at": "2026-07-03T19:42:00Z"})
        with SessionLocal() as db:
            text = session_notes.notes_text(db, sid)
        self.assertIn("20:42 [Ben · set: Main · 10x100 @1:30]: Held 1:20s", text)

    def test_the_debrief_starts_from_the_notes_and_can_be_finished_from_them_alone(self):
        http, h = self.client()
        with http:
            sid = self.new_session(http, h)
            bare = http.post("/session-debriefs", headers=h, json={"session_id": sid}).json()
            self.assertEqual(http.post(f"/session-debriefs/{bare['id']}/complete", headers=h).status_code, 400,
                             "nothing said and nothing noted: nothing to write up")
            http.delete(f"/session-debriefs/{bare['id']}", headers=h)

            http.post(f"/sessions/{sid}/notes", headers=h,
                      json={"text": "Amy flat on the main set", "swimmer_ids": [self.swimmers["Amy"]]})
            debrief = http.post("/session-debriefs", headers=h, json={"session_id": sid}).json()
            self.assertIn("1 note", debrief["messages"][0]["message"])
            r = http.post(f"/session-debriefs/{debrief['id']}/complete", headers=h)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["status"], "processing")

        with SessionLocal() as db:
            row = db.query(models.SessionDebrief).filter(models.SessionDebrief.id == debrief["id"]).first()
            context = build_session_debrief_context(row, db)
        self.assertIn("NOTES THE COACH TOOK DURING THE SESSION", context)
        self.assertIn("[Amy]: Amy flat on the main set", context)


if __name__ == "__main__":
    unittest.main()
