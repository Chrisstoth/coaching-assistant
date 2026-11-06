"""The Home screen: what the staff need from the coach, this week of the plan,
and the first-run checklist."""
import json
import os
import unittest
from datetime import date, timedelta
from pathlib import Path

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.tests import reset_database  # noqa: E402

DIR = Path(__file__).resolve().parents[2] / "shared" / "planner"
PLAN = json.loads((DIR / "sample-plan.json").read_text(encoding="utf8"))


class HomeScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def test_the_staff_asks_in_one_list(self):
        with SessionLocal() as db:
            s = models.Session(date=date(2026, 11, 2), squad="Silver 1")
            db.add(s)
            db.flush()
            db.add(models.StaffNote(role="physiologist", kind="concern", message="Load up 22% on last week for Group 2",
                                    session_id=s.id, flag="safety", status="open", trigger="builder"))
            db.add(models.StaffNote(role="planner", kind="observation", message="Fine", flag="preference", status="open", trigger="builder"))
            db.add(models.Prediction(role="manager", kind="attendance", statement="Year 11s drop to 2 sessions a week",
                                     due=date.today() - timedelta(days=1)))
            db.commit()
            sid = s.id
        http, h = self.client()
        with http:
            asks = http.get("/workbooks/review/asks", headers=h).json()
        kinds = [a["kind"] for a in asks["items"]]
        self.assertEqual(kinds.count("safety"), 1, "only safety flags, not preferences")
        safety = next(a for a in asks["items"] if a["kind"] == "safety")
        self.assertEqual((safety["who"], safety["link"]), ("Fiona", f"/builder/{sid}"))
        self.assertIn("prediction", kinds)
        self.assertEqual(asks["count"], len(asks["items"]))

    def test_this_week_of_the_plan_and_the_checklist(self):
        http, h = self.client()
        with http:
            first = http.get("/setup/checklist", headers=h).json()
            self.assertEqual((first["done"], first["total"]), (0, 5))
            plan = json.loads(json.dumps(PLAN))
            plan["settings"]["start"] = (date.today() - timedelta(days=date.today().weekday())).isoformat()
            http.put("/season-planner/Test Squad/docs/plan", headers=h, json={"data": plan})
            week = http.get("/season-planner/Test Squad/week", headers=h).json()
            self.assertEqual([g["name"] for g in week["groups"]], ["Regionals", "Nationals", "Girls group"])
            self.assertTrue(all(g["code"] for g in week["groups"]))
            with SessionLocal() as db:
                db.add(models.Swimmer(name="Alex Test", squad="Test Squad"))
                db.add(models.PoolSlot(day_of_week=0, time="05:30", squad="Test Squad", label="Mon AM"))
                db.commit()
            steps = {s["key"]: s["done"] for s in http.get("/setup/checklist", headers=h).json()["steps"]}
            self.assertEqual(steps, {"pool": True, "swimmers": True, "plan": True, "scale": False, "club": False})


if __name__ == "__main__":
    unittest.main()
