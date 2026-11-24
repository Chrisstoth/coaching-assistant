"""A swimmer's goals are one list: edited on the swimmer's page or in the Season
Planner, either way the other sees it, and the athlete plan prints it."""
import copy
import json
import os
import unittest
from datetime import date
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
ROSTER = json.loads((DIR / "sample-roster.json").read_text(encoding="utf8"))
SQUAD = "/season-planner/Test Squad"


def planner_goal(gid, **kw):
    return {"id": gid, "text": "", "event": "", "target": None, "course": "SC", "meet": "", "done": False, **kw}


class GoalsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            a = models.Swimmer(name="Alex Test", squad="Test Squad", active=True, swimrankings_id="s1",
                               target_events=[{"event": "50 Butterfly", "course": "SCM"}])
            db.add(a)
            db.flush()
            db.add(models.SwimTime(swimmer_id=a.id, event="50 Butterfly SCM", course="SCM", time_seconds=28.4,
                                   date=date(2026, 6, 1)))
            # The planner's goals from before the two lists were joined
            roster = copy.deepcopy(ROSTER)
            roster["swimmers"][0]["goals"] = [
                planner_goal("g1", text="Sub 28 in 50 Fly", event="50 Fly", target=27.99, meet="c1"),
                planner_goal("g2", text="10m underwater off every wall"),
            ]
            db.add(models.PlanDoc(club="default", squad="Test Squad", key="plan", data=PLAN, revision=1))
            db.add(models.PlanDoc(club="default", squad="Test Squad", key="roster", data=roster, revision=1))
            db.commit()
            self.alex = a.id
        self.http = TestClient(app)
        self.http.__enter__()
        token = self.http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        self.h = {"Authorization": f"Bearer {token}"}

    def tearDown(self):
        self.http.__exit__(None, None, None)
        reset_database()

    def roster(self):
        doc = self.http.get(f"{SQUAD}/docs", headers=self.h).json()["roster"]
        return doc, next(s for s in doc["data"]["swimmers"] if s["id"] == "s1")["goals"]

    def goals(self):
        return self.http.get(f"/goals?swimmer_id={self.alex}", headers=self.h).json()["goals"]

    def test_the_planner_goals_become_the_swimmers_and_both_edit_the_same_list(self):
        doc, copy_ = self.roster()                       # the planner opens
        goals = self.goals()
        self.assertEqual([g["text"] for g in goals], ["Sub 28 in 50 Fly", "10m underwater off every wall"])
        fly = goals[0]
        self.assertEqual(fly["meet_name"], "County Champs", "the planner's meet is the meet in the Meets tab")
        self.assertEqual(fly["deadline"], "2026-11-08", "a goal for a meet is due by its last day")
        self.assertEqual(fly["course"], "SC")
        self.assertEqual(fly["status"], "PB 28.40 · 0.41s (1.5%) to find")
        self.assertEqual(copy_[0]["meet"], "c1", "the planner keeps its star on the County week")

        # Edited on the swimmer's page: the planner's copy follows, and an open planner reloads.
        self.assertEqual(self.http.patch(f"/goals/{fly['id']}", json={"target_time_seconds": 27.5}, headers=self.h).status_code, 200)
        new = self.http.post("/goals", json={"swimmer_id": self.alex, "text": "Final at Regionals"}, headers=self.h).json()
        after, copy_ = self.roster()
        self.assertGreater(after["revision"], doc["revision"])
        self.assertEqual(copy_[0]["target"], 27.5)
        self.assertEqual(copy_[2]["text"], "Final at Regionals")
        self.assertTrue(copy_[2]["id"], "a goal made in the app gets an id in the planner")

        # Edited in the planner: a goal changed, one removed, one added.
        data = copy.deepcopy(after["data"])
        sw = next(s for s in data["swimmers"] if s["id"] == "s1")
        sw["goals"][0]["done"] = True
        sw["goals"] = [g for g in sw["goals"] if g["text"] != "10m underwater off every wall"]
        sw["goals"].append(planner_goal("g9", event="100 Fly", target=62.0, course="LC"))
        r = self.http.put(f"{SQUAD}/docs/roster", json={"data": data, "revision": after["revision"]}, headers=self.h)
        self.assertEqual(r.status_code, 200)
        by_text = {g["label"]: g for g in self.goals()}
        self.assertNotIn("10m underwater off every wall", by_text, "removed in the planner, gone from the swimmer")
        self.assertTrue(by_text["Sub 28 in 50 Fly"]["achieved"])
        self.assertIn("100 Fly in 1:02.00 LC", by_text, "a goal with no words reads as its race")
        self.assertEqual(by_text["100 Fly in 1:02.00 LC"]["status"], "No LC PB yet")
        self.assertIn(new["id"], [g["id"] for g in by_text.values()])

        # Removed on the swimmer's page: gone from the planner too, and it doesn't come back.
        self.assertEqual(self.http.delete(f"/goals/{new['id']}", headers=self.h).status_code, 204)
        _, copy_ = self.roster()
        self.assertNotIn("Final at Regionals", [g["text"] for g in copy_])
        self.assertNotIn("Final at Regionals", [g["label"] for g in self.goals()])

    def test_a_meet_added_in_the_planner_keeps_its_goal_until_it_is_in_the_meets_tab(self):
        doc, _ = self.roster()
        plan = self.http.get(f"{SQUAD}/docs", headers=self.h).json()["plan"]
        p = copy.deepcopy(plan["data"])
        p["calendar"].append({"id": "c9", "name": "Winter Open", "start": "2026-12-05", "end": "2026-12-06", "course": "50m"})
        self.http.put(f"{SQUAD}/docs/plan", json={"data": p, "revision": plan["revision"]}, headers=self.h)
        data = copy.deepcopy(doc["data"])
        next(s for s in data["swimmers"] if s["id"] == "s1")["goals"].append(planner_goal("g5", text="PB at Winter Open", meet="c9"))
        self.http.put(f"{SQUAD}/docs/roster", json={"data": data, "revision": doc["revision"]}, headers=self.h)
        _, copy_ = self.roster()                          # opening ties Winter Open to the Meets tab
        self.assertEqual(next(g for g in copy_ if g["id"] == "g5")["meet"], "c9")
        winter = next(g for g in self.goals() if g["text"] == "PB at Winter Open")
        self.assertEqual(winter["meet_name"], "Winter Open")
        self.assertEqual(winter["course"], "LC", "the meet sets the course")

    def test_the_athlete_plan_prints_the_goals_and_a_final_plan_keeps_them(self):
        self.roster()
        with SessionLocal() as db:
            plan = models.SwimmerPlan(swimmer_id=self.alex, title="Alex: athlete plan", period_from=date(2026, 9, 1),
                                      period_to=date(2026, 12, 31), status="draft",
                                      sections=[{"key": "towards", "title": "What we're working towards", "role": "analyst",
                                                 "content": "County in November.", "included": True}])
            db.add(plan)
            db.add(models.SwimmerTarget(swimmer_id=self.alex, label="Next season", deadline=date(2027, 6, 1)))
            db.commit()
            pid = plan.id
        out = self.http.get(f"/swimmer-plans/{pid}", headers=self.h).json()
        self.assertEqual([g["label"] for g in out["goals"]], ["Sub 28 in 50 Fly", "10m underwater off every wall"],
                         "only the goals for the plan's dates")
        self.assertEqual(self.http.post(f"/swimmer-plans/{pid}/finalise", headers=self.h).status_code, 200)
        fly = next(g for g in self.goals() if g["text"] == "Sub 28 in 50 Fly")
        self.http.patch(f"/goals/{fly['id']}", json={"text": "Changed after"}, headers=self.h)
        final = self.http.get(f"/swimmer-plans/{pid}", headers=self.h).json()
        self.assertEqual(final["goals"][0]["label"], "Sub 28 in 50 Fly", "a final plan is kept as it was")

    def test_a_target_set_from_chat_is_a_goal_and_a_deleted_meet_leaves_its_goal(self):
        self.roster()
        self.http.post("/benchmarks/targets", json={"swimmer_id": self.alex, "label": "Aerobic 100 free 1:04",
                                                     "target_time_seconds": 64.0}, headers=self.h)
        _, copy_ = self.roster()
        self.assertIn("Aerobic 100 free 1:04", [g["text"] for g in copy_])
        fly = next(g for g in self.goals() if g["meet_id"])
        self.assertEqual(self.http.delete(f"/meets/{fly['meet_id']}", headers=self.h).status_code, 204)
        kept = next(g for g in self.goals() if g["id"] == fly["id"])
        self.assertIsNone(kept["meet_id"])
        self.assertEqual(kept["deadline"], "2026-11-08", "the meet's date stays as the goal's date")


if __name__ == "__main__":
    unittest.main()
