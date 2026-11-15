"""Planning ahead: a session written in the Session Builder for a later date
(before a holiday, say) stays "planned" in the calendar until its day comes,
rather than showing as in progress."""
import os
import unittest
from datetime import date, timedelta

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.tests import reset_database  # noqa: E402


class PlanAheadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        # Two weeks out, on whatever weekday that is, so the test never ages.
        self.day = date.today() + timedelta(days=14)
        with SessionLocal() as db:
            slot = models.PoolSlot(day_of_week=self.day.weekday(), time="18:00", end_time="19:30",
                                   squad="Silver 1", label="Eve")
            db.add(slot)
            db.commit()
            self.slot_id = slot.id

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def test_a_session_written_ahead_stays_planned_until_its_day(self):
        http, h = self.client()
        with http:
            r = http.post("/session-builder/sessions", headers=h,
                          json={"date": self.day.isoformat(), "pool_slot_id": self.slot_id})
            self.assertEqual(r.status_code, 201, r.text)
            sid = r.json()["id"]

            monday = self.day - timedelta(days=self.day.weekday())
            days = http.get(f"/sessions/calendar?week_start={monday.isoformat()}", headers=h).json()
            items = [i for d in days for i in d["items"] if i["slot_id"] == self.slot_id]
            self.assertEqual(len(items), 1, "One entry for the slot, not the slot plus a session")
            self.assertEqual(items[0]["session_id"], sid)
            self.assertEqual(items[0]["status"], "planned")

            http.put(f"/sessions/{sid}/ready", headers=h, json={"ready": True})
            days = http.get(f"/sessions/calendar?week_start={monday.isoformat()}", headers=h).json()
            item = next(i for d in days for i in d["items"] if i["session_id"] == sid)
            self.assertTrue(item["plan_ready"])


if __name__ == "__main__":
    unittest.main()
