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

    def test_galas_coming_up_say_who_is_going_and_how_much_it_matters(self):
        today = date.today()
        with SessionLocal() as db:
            amy = models.Swimmer(name="Amy", squad="Silver 1")
            ben = models.Swimmer(name="Ben", squad="Silver 1")
            cal = models.Swimmer(name="Cal", squad="Bronze")
            gone = models.Swimmer(name="Gone", squad="Bronze", active=False)
            db.add_all([amy, ben, cal, gone])
            county = models.Meet(name="County Champs", date=today + timedelta(days=12), date_to=today + timedelta(days=13))
            open_ = models.Meet(name="Club Open", date=today + timedelta(days=25))
            past = models.Meet(name="Last month", date=today - timedelta(days=30))
            later = models.Meet(name="Spring Meet", date=today + timedelta(days=40))
            db.add_all([county, open_, past, later])
            db.flush()
            db.add(models.MeetTarget(meet_id=county.id, swimmer_id=amy.id, priority="A", events=["100 Freestyle"]))
            # Ben has no targets, only entries: his best entry priority counts
            db.add(models.MeetEntry(meet_id=county.id, swimmer_id=ben.id, event_name="50 Back", canonical_event="50BK", priority="C"))
            db.add(models.MeetEntry(meet_id=county.id, swimmer_id=ben.id, event_name="100 Back", canonical_event="100BK", priority="B"))
            db.add(models.MeetEntry(meet_id=county.id, swimmer_id=cal.id, event_name="50 Free", canonical_event="50FR", status="withdrawn"))
            db.add(models.MeetEntry(meet_id=county.id, swimmer_id=gone.id, event_name="50 Free", canonical_event="50FR"))
            db.add(models.MeetTarget(meet_id=open_.id, swimmer_id=cal.id, priority="b"))
            db.commit()
        http, h = self.client()
        with http:
            out = http.get("/dashboard/galas", headers=h).json()
        self.assertEqual([m["name"] for m in out["meets"]], ["County Champs", "Club Open"],
                         "nearest first; past ones and anything over a month out aren't on Home")
        county = out["meets"][0]
        self.assertEqual(county["days_out"], 12)
        self.assertEqual([(s["name"], s["priority"]) for s in county["swimmers"]], [("Amy", "A"), ("Ben", "B")],
                         "A first; withdrawn and inactive swimmers aren't going")
        self.assertEqual(county["swimmers"][1]["events"], ["50 Back", "100 Back"])
        self.assertEqual(county["priority_counts"], {"A": 1, "B": 1, "C": 0})
        self.assertEqual(county["target_for"], ["Silver 1"])
        self.assertEqual(out["meets"][1]["target_for"], ["Bronze"])
        self.assertEqual(out["meets"][1]["swimmers"][0]["priority"], "B")
        self.assertEqual(out["swimmer_count"], 3)

    def test_injured_and_ill_swimmers_together(self):
        today = date.today()
        with SessionLocal() as db:
            amy = models.Swimmer(name="Amy", squad="Silver 1")
            ben = models.Swimmer(name="Ben", squad="Silver 1")
            cal = models.Swimmer(name="Cal", squad="Silver 1", status="injury")
            dan = models.Swimmer(name="Dan", squad="Silver 1")
            eve = models.Swimmer(name="Eve", squad="Silver 1")
            db.add_all([amy, ben, cal, dan, eve])
            db.flush()
            db.add(models.SwimmerCurrentNote(swimmer_id=amy.id, kind="illness", title="Flu", date_from=today))
            db.add(models.SwimmerCurrentNote(swimmer_id=ben.id, kind="injury", title="Left shoulder", date_from=today - timedelta(days=3),
                                             impact="No fly"))
            db.add(models.SwimmerCurrentNote(swimmer_id=eve.id, kind="other", title="Exams", date_from=today))
            db.add(models.SwimmerException(swimmer_id=dan.id, reason="injury", date_from=today, date_to=today + timedelta(days=5), notes="Ankle"))
            db.add(models.SwimmerException(swimmer_id=ben.id, reason="injury", date_from=today, date_to=today + timedelta(days=5)))
            db.commit()
        http, h = self.client()
        with http:
            items = http.get("/dashboard/unwell", headers=h).json()["items"]
        self.assertEqual([(i["name"], i["kind"], i["source"]) for i in items],
                         [("Ben", "injury", "note"), ("Cal", "injury", "profile"), ("Dan", "injury", "absence"), ("Amy", "illness", "note")],
                         "injuries then illness; once per swimmer; other notes aren't here")
        self.assertEqual(items[0]["impact"], "No fly")
        self.assertEqual(items[2]["title"], "Ankle")


if __name__ == "__main__":
    unittest.main()
