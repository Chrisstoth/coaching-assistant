"""A group is who trains together; a pathway is what each swimmer aims at.

Three swimmers train in one group. One is national level and, from a date,
branches onto the Winter Nationals pathway while the other two stay on the
regional one. Lanes are picked per session at the register, so nothing is
pre-selected from the group.
"""
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
from backend.services.pathways import pathways_on  # noqa: E402
from backend.services.season_grid import build_grid  # noqa: E402
from backend.tests import reset_database  # noqa: E402

START = date(2026, 9, 7)          # a Monday
BRANCH = START + timedelta(weeks=4)


class GroupsAndPathwaysTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            girls = [models.Swimmer(name=n, active=True) for n in ("Nia Hart", "Ella Moss", "Isla Reed")]
            db.add_all(girls)
            db.flush()
            regionals = models.Meet(name="Regionals", date=START + timedelta(weeks=9))
            nationals = models.Meet(name="Winter Nationals", date=START + timedelta(weeks=10))
            db.add_all([regionals, nationals])
            db.flush()
            macro = models.TrainingMacro(name="Winter", squad="Performance", date_from=START,
                                         date_to=START + timedelta(weeks=11, days=-1))
            db.add(macro)
            db.flush()
            db.add(models.SeasonBlock(macro_id=macro.id, name="Build", phase_type="build", date_from=START,
                                      date_to=START + timedelta(weeks=6, days=-1),
                                      group_intents={"Girls": "Threshold and race pace"}))
            regional = models.PlanningPathway(macro_id=macro.id, name="Regional", primary_meet_id=regionals.id)
            winter = models.PlanningPathway(macro_id=macro.id, name="Winter Nationals", primary_meet_id=nationals.id)
            db.add_all([regional, winter])
            db.flush()
            for g in girls:
                db.add(models.PathwayMembership(pathway_id=regional.id, swimmer_id=g.id, date_from=START))
            group = gs.create_group(db, "Girls")
            for g in girls:
                gs.move(db, g.id, group.id, START)
            session = models.Session(date=START + timedelta(days=2), status="completed")
            db.add(session)
            db.commit()
            self.ids = {"nia": girls[0].id, "ella": girls[1].id, "macro": macro.id,
                        "regional": regional.id, "winter": winter.id, "session": session.id}

    def tearDown(self):
        reset_database()

    def _http(self):
        http = TestClient(app)
        http.__enter__()
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def _branch_nia(self, http, h):
        r = http.put(f"/planning-agent/pathways/{self.ids['winter']}/members", headers=h,
                     json=[{"swimmer_id": self.ids["nia"], "date_from": BRANCH.isoformat()}])
        self.assertEqual(r.status_code, 200, r.text)

    def test_one_swimmer_branches_onto_another_pathway_from_a_date(self):
        http, h = self._http()
        try:
            self._branch_nia(http, h)
        finally:
            http.__exit__(None, None, None)
        with SessionLocal() as db:
            before = pathways_on(db, self.ids["macro"], BRANCH - timedelta(days=1))
            after = pathways_on(db, self.ids["macro"], BRANCH)
        self.assertEqual(before[self.ids["nia"]].pathway_id, self.ids["regional"])
        self.assertEqual(after[self.ids["nia"]].pathway_id, self.ids["winter"])
        self.assertEqual(after[self.ids["ella"]].pathway_id, self.ids["regional"], "The others stay on theirs.")
        with SessionLocal() as db:
            self.assertEqual(gs.group_of(db, self.ids["nia"], BRANCH).name, "Girls", "Still the same group.")

    def test_re_saving_the_old_pathway_keeps_the_branch(self):
        http, h = self._http()
        try:
            self._branch_nia(http, h)
            regional = next(p for p in http.get(f"/planning-agent/pathways?macro_id={self.ids['macro']}", headers=h).json()
                            if p["id"] == self.ids["regional"])
            members = [{k: m[k] for k in ("swimmer_id", "date_from", "date_to", "qualification_status", "notes", "active")}
                       for m in regional["members"]]
            self.assertEqual(http.put(f"/planning-agent/pathways/{self.ids['regional']}/members", headers=h,
                                      json=members).status_code, 200)
        finally:
            http.__exit__(None, None, None)
        with SessionLocal() as db:
            after = pathways_on(db, self.ids["macro"], BRANCH)
        self.assertEqual(after[self.ids["nia"]].pathway_id, self.ids["winter"])

    def test_the_grid_shows_the_branch_and_the_right_target_meets(self):
        http, h = self._http()
        try:
            self._branch_nia(http, h)
        finally:
            http.__exit__(None, None, None)
        with SessionLocal() as db:
            grid = build_grid(db, self.ids["macro"], today=START + timedelta(days=3))
        rows = {s["id"]: s for s in grid["groups"][0]["swimmers"]}
        nia, ella = rows[self.ids["nia"]], rows[self.ids["ella"]]
        self.assertEqual(nia["cells"]["4"]["moves"], ["Onto the Winter Nationals pathway"])
        self.assertEqual(nia["cells"]["10"]["meets"][0]["name"], "Winter Nationals")
        self.assertNotIn("9", nia["cells"], "Regionals is no longer her target.")
        self.assertEqual(ella["cells"]["9"]["meets"][0]["name"], "Regionals")

    def test_the_groups_page_shows_each_swimmers_pathway(self):
        http, h = self._http()
        try:
            self._branch_nia(http, h)
            data = http.get("/groups", params={"on": (START + timedelta(days=3)).isoformat()}, headers=h).json()
        finally:
            http.__exit__(None, None, None)
        nia = next(s for s in data["groups"][0]["swimmers"] if s["id"] == self.ids["nia"])
        self.assertEqual(nia["pathway"]["name"], "Regional")
        self.assertEqual(nia["pathway"]["next"], {"name": "Winter Nationals", "date_from": BRANCH.isoformat()})

    def test_the_planner_sees_who_has_no_pathway(self):
        from backend.services.staff_room import _pathway_lines
        with SessionLocal() as db:
            db.add(models.Swimmer(name="New Starter", active=True, status="active"))
            db.commit()
            text = " | ".join(_pathway_lines(db, self.ids["macro"]))
        self.assertIn("NOT ON A PATHWAY", text)
        self.assertIn("New Starter", text)
        self.assertNotIn("Nia Hart (id", text.split("NOT ON A PATHWAY")[1])

    def test_the_session_writer_knows_group_aim_and_pathway(self):
        with SessionLocal() as db:
            per, aims = gs.plan_context(db, [self.ids["nia"]], START + timedelta(days=2))
        self.assertEqual(per[self.ids["nia"]], "group Girls; pathway Regional -> Regionals")
        self.assertEqual(aims, ["GROUP AIMS THIS BLOCK (Build):", "  Girls: Threshold and race pace"])

    def test_the_register_starts_with_no_lane_picked(self):
        http, h = self._http()
        try:
            rows = http.get(f"/sessions/{self.ids['session']}/register", headers=h).json()
        finally:
            http.__exit__(None, None, None)
        rows = rows if isinstance(rows, list) else rows.get("swimmers") or rows.get("entries") or []
        self.assertTrue(rows)
        self.assertTrue(all(r["group_planned"] is None for r in rows))


if __name__ == "__main__":
    unittest.main()
