"""The squad grid: a swimmer's row shows only what is different for them, and a
group shows how many of its members have something going on."""
import os
import unittest
from datetime import date, timedelta

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services.season_grid import UNGROUPED, build_grid  # noqa: E402
from backend.tests import reset_database  # noqa: E402

START = date(2026, 9, 7)          # Monday, week 0
TODAY = START + timedelta(weeks=3, days=2)


class SeasonGridTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver", active=True, para_class="S9")
            leo = models.Swimmer(name="Leo Park", squad="Silver", active=True)
            amy = models.Swimmer(name="Amy Stone", squad="Silver", active=True)
            db.add_all([ruby, leo, amy])
            db.flush()
            county = models.Meet(name="County Champs", date=START + timedelta(weeks=5, days=5))
            regionals = models.Meet(name="Regionals", date=START + timedelta(weeks=7, days=5))
            db.add_all([county, regionals])
            db.flush()
            macro = models.TrainingMacro(
                name="Autumn", squad="Silver", date_from=START, date_to=START + timedelta(weeks=8, days=-1),
                group_definitions={"G1": {"description": "Fast lane", "swimmer_ids": [ruby.id, leo.id]}})
            db.add(macro)
            db.flush()
            db.add(models.SeasonBlock(macro_id=macro.id, name="Base", phase_type="base", date_from=START,
                                      date_to=START + timedelta(weeks=4, days=-1), group_intents={"G1": "Aerobic volume"}))
            db.add(models.SeasonLoadPoint(macro_id=macro.id, week_start=START, overall=60))
            db.add(models.SwimmerException(swimmer_id=ruby.id, reason="exams", date_from=START + timedelta(weeks=2),
                                           date_to=START + timedelta(weeks=2, days=4)))
            db.add(models.MeetEntry(meet_id=county.id, swimmer_id=ruby.id, event_name="100 Freestyle",
                                    canonical_event="100 freestyle"))
            db.add(models.MeetTarget(meet_id=regionals.id, swimmer_id=leo.id, events=["200 Freestyle"]))
            standards = models.QualificationStandardSet(meet_id=regionals.id, name="Regional QTs", status="confirmed")
            db.add(standards)
            db.flush()
            standard = models.QualificationStandard(standard_set_id=standards.id, event_name="100 Freestyle",
                                                    canonical_event="100 freestyle", course="SCM",
                                                    standard_type="qualifying", time_seconds=65.0)
            db.add(standard)
            db.flush()
            db.add(models.QualificationAssessment(standard_set_id=standards.id, standard_id=standard.id,
                                                  swimmer_id=ruby.id, status="achieved"))
            # Week 1: Leo makes 1 of 3 sessions.
            for day, came in ((0, True), (2, False), (4, False)):
                session = models.Session(date=START + timedelta(weeks=1, days=day), squad="Silver", status="completed")
                db.add(session)
                db.flush()
                db.add(models.SessionEntry(session_id=session.id, swimmer_id=leo.id, attended=came))
            db.commit()
            self.macro_id, self.ruby_id, self.leo_id, self.amy_id = macro.id, ruby.id, leo.id, amy.id

    def tearDown(self):
        reset_database()

    def _grid(self):
        with SessionLocal() as db:
            return build_grid(db, self.macro_id, today=TODAY)

    def test_weeks_carry_the_block_load_and_meets(self):
        grid = self._grid()
        self.assertEqual(len(grid["weeks"]), 8)
        self.assertEqual((grid["weeks"][0]["block_name"], grid["weeks"][0]["load"]), ("Base", 60))
        self.assertEqual([m["name"] for m in grid["weeks"][5]["meets"]], ["County Champs"])
        self.assertTrue(grid["weeks"][3]["is_current"])

    def test_swimmers_sit_under_their_group_and_the_rest_are_not_lost(self):
        groups = {g["name"]: g for g in self._grid()["groups"]}
        self.assertEqual([s["name"] for s in groups["G1"]["swimmers"]], ["Ruby Wheeler", "Leo Park"])
        self.assertEqual([s["name"] for s in groups[UNGROUPED]["swimmers"]], ["Amy Stone"])
        self.assertEqual(groups["G1"]["intents"][0]["text"], "Aerobic volume")

    def test_a_swimmers_row_shows_only_what_is_different(self):
        groups = {g["name"]: g for g in self._grid()["groups"]}
        ruby = next(s for s in groups["G1"]["swimmers"] if s["id"] == self.ruby_id)
        self.assertEqual(ruby["cells"]["2"]["away"], ["exams"])
        self.assertEqual(ruby["cells"]["5"]["meets"][0]["state"], "entered")
        self.assertIn("Qualified for Regionals but not entered", ruby["cells"]["7"]["flags"])
        leo = next(s for s in groups["G1"]["swimmers"] if s["id"] == self.leo_id)
        self.assertEqual(leo["cells"]["7"]["meets"][0]["state"], "planned")
        self.assertEqual(leo["cells"]["1"]["attendance"], [1, 3])
        self.assertIn("Trained 1 of 3 sessions", leo["cells"]["1"]["flags"])
        amy = groups[UNGROUPED]["swimmers"][0]
        self.assertEqual(amy["cells"], {}, "A swimmer fully on plan is a quiet row.")

    def test_a_group_shows_how_many_members_need_a_look(self):
        g1 = next(g for g in self._grid()["groups"] if g["name"] == "G1")
        self.assertEqual(g1["rollup"], {"1": 1, "2": 1, "7": 1})

    def test_the_grid_is_served_for_a_macro(self):
        with TestClient(app) as http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            self.assertEqual(http.get(f"/season/grid?macro_id={self.macro_id}", headers=h).status_code, 200)
            self.assertEqual(http.get("/season/grid?macro_id=99999", headers=h).status_code, 404)


if __name__ == "__main__":
    unittest.main()
