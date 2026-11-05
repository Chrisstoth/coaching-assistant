"""The coach's Season Planner in the app: the Python twin of its week logic gives
the planner's own answers, its documents and versions save, and a save makes the
app's training groups follow the plan."""
import json
import math
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
from backend.services import season_planner as SP  # noqa: E402
from backend.tests import reset_database  # noqa: E402

DIR = Path(__file__).resolve().parents[2] / "shared" / "planner"
PLAN = json.loads((DIR / "sample-plan.json").read_text(encoding="utf8"))
ROSTER = json.loads((DIR / "sample-roster.json").read_text(encoding="utf8"))


class PlannerTwinTests(unittest.TestCase):
    def test_every_week_matches_the_planner(self):
        cases = json.loads((DIR / "cases.json").read_text(encoding="utf8"))
        P = SP.Plan(PLAN, ROSTER)
        for bid, weeks in cases.items():
            for mine, ref in zip(P.timeline(bid), weeks):
                with self.subTest(bid=bid, week=ref["i"]):
                    self.assertEqual((mine["p"], mine["code"], mine["camp"]), (ref["p"], ref["code"], ref["camp"]))
                    self.assertTrue(math.isclose(mine["load"], ref["load"], abs_tol=1e-9), (mine["load"], ref["load"]))
                    for k in ("aer", "ana", "spd"):
                        self.assertTrue(math.isclose(mine["comps"][k], ref["comps"][k], abs_tol=1e-9))
                    self.assertEqual(bool(mine["away"]), ref["away"])
                    if bid.startswith("sw:"):
                        self.assertEqual(mine["group"], ref["group"])
        self.assertEqual(len(cases), 6, "three groups and the three swimmers on the plan")

    def test_intensity_carries_over_by_colour(self):
        self.assertEqual((SP.planner_level(16), SP.to_common(16)), ("Red", 17))     # the planner's Red is the common Red
        self.assertEqual((SP.planner_level(21), SP.to_common(21)), ("Gold", 21))
        self.assertEqual(SP.to_common(11), 13.5)
        targets = SP.Plan(PLAN, ROSTER).targets("General prep")
        self.assertEqual(targets[1]["levels"], ["Purple", "Blue"])
        self.assertEqual(targets[1]["common"], [18, 19.5])


class PlannerInTheAppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            a = models.Swimmer(name="Alex Test", squad="Test Squad", active=True, swimrankings_id="s1")
            b = models.Swimmer(name="Bo Test", squad="Test Squad", active=True)          # matched by name
            db.add_all([a, b])
            db.commit()
            self.alex, self.bo = a.id, b.id

    def test_the_planner_saves_and_the_app_follows(self):
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            self.assertEqual(http.get("/season-planner/Test Squad/docs", headers=h).json(), {"plan": None, "roster": None})
            self.assertEqual(http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": ROSTER}).status_code, 200)
            self.assertEqual(http.put("/season-planner/Test Squad/docs/plan", headers=h, json={"data": PLAN}).json()["revision"], 1)
            docs = http.get("/season-planner/Test Squad/docs", headers=h).json()
            self.assertEqual(docs["plan"]["data"]["settings"]["weeks"], 12)
            self.assertEqual(http.get("/season-planner/squads", headers=h).json(), ["Test Squad"])
            vid = http.post("/season-planner/Test Squad/versions", headers=h,
                            json={"name": "Start", "savedAt": "2026-11-05T10:00:00Z", "plan": PLAN, "roster": ROSTER}).json()["id"]
            self.assertEqual(http.get("/season-planner/Test Squad/versions", headers=h).json()[0]["name"], "Start")
            self.assertEqual(http.get(f"/season-planner/Test Squad/versions/{vid}", headers=h).json()["plan"]["settings"]["squad"], "Test Squad")
            self.assertEqual(http.delete(f"/season-planner/Test Squad/versions/{vid}", headers=h).status_code, 204)
        with SessionLocal() as db:
            groups = {g.name: g.id for g in db.query(models.TrainingGroup).filter_by(squad="Test Squad")}
            self.assertEqual(set(groups), {"Regionals", "Nationals", "Girls group"})
            bo = db.query(models.GroupMembership).filter_by(swimmer_id=self.bo).order_by(models.GroupMembership.date_from).all()
            self.assertEqual([(m.group_id, m.date_from, m.date_to) for m in bo],
                             [(groups["Regionals"], date(2026, 8, 24), date(2026, 10, 4)), (groups["Nationals"], date(2026, 10, 5), None)],
                             "Bo moves to Nationals in week 6, as the plan says")
            w = SP.week(db, "Test Squad", date(2026, 9, 23))
            self.assertEqual(w["week"], 4)
            self.assertEqual(w["swimmers"][str(self.bo)]["camp"], "e2", "on camp that week")
            self.assertEqual(next(g for g in w["groups"] if g["id"] == "girls")["load"], 0.65)
            self.assertEqual(SP.week_code(db, "Test Squad", date(2026, 9, 23)), "1.2.2")
            self.assertIn("Regionals: 1.2.2 Build", SP.staff_lines(db, "Test Squad", date(2026, 9, 23)))
            self.assertIn("Bo Test: core (camp)", SP.staff_lines(db, "Test Squad", date(2026, 9, 23)))
            from backend.services import staff_room
            ctx = staff_room.role_context("planner", db, staff_room.Subject(session_date=date(2026, 9, 23), squad="Test Squad"))
            self.assertIn("THE SEASON PLAN, week of 2026-09-21 (Test Squad)", ctx, "the staff read the coach's plan")


if __name__ == "__main__":
    unittest.main()
