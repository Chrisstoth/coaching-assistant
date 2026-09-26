"""Training groups belong to the squad and memberships are dated: a move from a
date leaves the weeks before it alone, and everything that reads groups -
the register, the grid, the plan, the staff - sees the same answer."""
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
from backend.services import groups as gs  # noqa: E402
from backend.services.season_grid import build_grid  # noqa: E402
from backend.services.staff_actions import execute, prepare  # noqa: E402
from backend.tests import reset_database  # noqa: E402

START = date(2026, 9, 7)          # a Monday
MOVE = START + timedelta(weeks=3)


class TrainingGroupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver", active=True)
            leo = models.Swimmer(name="Leo Park", squad="Silver", active=True)
            amy = models.Swimmer(name="Amy Stone", squad="Silver", active=True)
            db.add_all([ruby, leo, amy])
            db.flush()
            macro = models.TrainingMacro(
                name="Autumn", squad="Silver", date_from=START, date_to=START + timedelta(weeks=8, days=-1),
                group_definitions={"Senior": {"description": "Aerobic base, five a week"}})
            db.add(macro)
            db.flush()
            db.add(models.SeasonBlock(macro_id=macro.id, name="Base", phase_type="base", date_from=START,
                                      date_to=START + timedelta(weeks=4, days=-1),
                                      group_intents={"Senior": "Aerobic volume"}))
            senior = gs.create_group(db, "Senior", "Older, five sessions a week", "Silver")
            dev = gs.create_group(db, "Development", "Younger, three a week", "Silver")
            gs.move(db, ruby.id, dev.id, START)
            gs.move(db, leo.id, senior.id, START)
            db.commit()
            self.ids = {"ruby": ruby.id, "leo": leo.id, "amy": amy.id, "macro": macro.id,
                        "senior": senior.id, "dev": dev.id}

    def tearDown(self):
        reset_database()

    def _move_ruby_up(self):
        with SessionLocal() as db:
            gs.move(db, self.ids["ruby"], self.ids["senior"], MOVE, "Ready for more volume")
            db.commit()

    # --- dated membership ----------------------------------------------------
    def test_a_move_leaves_the_weeks_before_it_alone(self):
        self._move_ruby_up()
        with SessionLocal() as db:
            self.assertEqual(gs.group_of(db, self.ids["ruby"], MOVE - timedelta(days=1)).name, "Development")
            self.assertEqual(gs.group_of(db, self.ids["ruby"], MOVE).name, "Senior")
            history = gs.history_out(db, self.ids["ruby"])
        self.assertEqual([(h["group_name"], h["date_to"]) for h in history],
                         [("Development", (MOVE - timedelta(days=1)).isoformat()), ("Senior", None)])

    def test_a_later_decision_replaces_a_planned_move(self):
        self._move_ruby_up()
        with SessionLocal() as db:
            gs.move(db, self.ids["ruby"], self.ids["dev"], MOVE - timedelta(days=7))
            db.commit()
            self.assertEqual(gs.group_of(db, self.ids["ruby"], MOVE + timedelta(days=7)).name, "Development")
            self.assertEqual(len(gs.history(db, self.ids["ruby"])), 1, "Staying put is one unbroken membership.")

    def test_group_names_are_unique_in_a_squad(self):
        with SessionLocal() as db:
            with self.assertRaises(gs.GroupError):
                gs.create_group(db, "senior", squad="Silver")

    # --- one answer everywhere ----------------------------------------------
    def test_the_plan_reads_squad_groups_and_keeps_its_own_aims(self):
        self._move_ruby_up()
        with SessionLocal() as db:
            macro = db.get(models.TrainingMacro, self.ids["macro"])
            early = gs.macro_groups(db, macro, START)
            late = gs.macro_groups(db, macro, MOVE)
        self.assertEqual(early["Senior"]["swimmer_ids"], [self.ids["leo"]])
        self.assertEqual(sorted(late["Senior"]["swimmer_ids"]), sorted([self.ids["leo"], self.ids["ruby"]]))
        self.assertEqual(early["Senior"]["description"], "Aerobic base, five a week", "The plan's aim wins.")
        self.assertEqual(early["Development"]["description"], "Younger, three a week")

    def test_a_squad_without_groups_still_reads_the_plan(self):
        reset_database()
        with SessionLocal() as db:
            s = models.Swimmer(name="Solo", active=True)
            db.add(s)
            db.flush()
            macro = models.TrainingMacro(name="Old", date_from=START, date_to=START + timedelta(weeks=4),
                                         group_definitions={"G1": {"description": "x", "swimmer_ids": [s.id]}})
            db.add(macro)
            db.commit()
            self.assertEqual(gs.macro_groups(db, macro)["G1"]["swimmer_ids"], [s.id])
            self.assertEqual(gs.seed_from_macros(db), 1)
            self.assertEqual(gs.group_of(db, s.id, START).name, "G1")
            self.assertEqual(gs.seed_from_macros(db), 0, "Seeding only happens once.")

    def test_the_grid_shows_the_move_in_its_week(self):
        self._move_ruby_up()
        with SessionLocal() as db:
            grid = build_grid(db, self.ids["macro"], today=MOVE + timedelta(days=2))
        groups = {g["name"]: g for g in grid["groups"]}
        ruby = next(s for s in groups["Senior"]["swimmers"] if s["id"] == self.ids["ruby"])
        self.assertEqual(ruby["cells"]["3"]["moves"], ["Moves to Senior"])
        self.assertEqual(groups["Senior"]["intents"][0]["text"], "Aerobic volume")

    def test_renaming_a_group_carries_the_plan_with_it(self):
        with SessionLocal() as db:
            gs.update_group(db, db.get(models.TrainingGroup, self.ids["senior"]), name="Performance")
            db.commit()
            macro = db.get(models.TrainingMacro, self.ids["macro"])
            self.assertIn("Performance", macro.group_definitions)
            self.assertEqual(macro.mesos[0].group_intents, {"Performance": "Aerobic volume"})

    # --- the Swimmer Manager suggests, the coach decides ------------------------
    def test_the_manager_proposes_a_move_and_it_happens_on_approval(self):
        raw = {"type": "move_group", "swimmer_id": self.ids["ruby"], "group_id": self.ids["senior"],
               "date_from": MOVE.isoformat(), "reason": "Coping with the extra volume"}
        with SessionLocal() as db:
            self.assertIsNone(prepare("physiologist", raw, db), "Only the manager moves swimmers.")
            prepared = prepare("manager", raw, db)
            self.assertNotIn("invalid", prepared)
            self.assertIn("Development → Senior", prepared["summary"][0])
            self.assertEqual(gs.group_of(db, self.ids["ruby"], MOVE).name, "Development", "Nothing moves yet.")
            result, handoff = execute(prepared, "manager", db)
            self.assertEqual(gs.group_of(db, self.ids["ruby"], MOVE).name, "Senior")
        self.assertEqual(handoff[0], "planner")
        with SessionLocal() as db:
            again = prepare("manager", raw, db)
        self.assertIn("already in Senior", again["invalid"])

    # --- the page -------------------------------------------------------------
    def test_groups_are_managed_over_http(self):
        with TestClient(app) as http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            made = http.post("/groups", headers=h, json={"name": "Sprint", "squad": "Silver"})
            self.assertEqual(made.status_code, 201)
            self.assertEqual(http.post("/groups", headers=h, json={"name": "Sprint", "squad": "Silver"}).status_code, 422)
            moved = http.post("/groups/move", headers=h, json={"swimmer_ids": [self.ids["amy"]],
                                                                "group_id": made.json()["id"]})
            self.assertEqual(moved.status_code, 200)
            data = http.get("/groups?squad=Silver", headers=h).json()
            sprint = next(g for g in data["groups"] if g["name"] == "Sprint")
            self.assertEqual([s["name"] for s in sprint["swimmers"]], ["Amy Stone"])
            self.assertEqual(data["ungrouped"], [])
            self.assertEqual(http.delete(f"/groups/{made.json()['id']}", headers=h).status_code, 200)
            data = http.get("/groups?squad=Silver", headers=h).json()
            self.assertEqual([s["name"] for s in data["ungrouped"]], ["Amy Stone"])
            self.assertEqual(len(http.get(f"/groups/history/{self.ids['ruby']}", headers=h).json()), 1)


if __name__ == "__main__":
    unittest.main()
