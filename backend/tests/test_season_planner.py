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


def with_short_group():
    """The sample plan with a short-term group (weeks 7-9) and two swimmers who join it."""
    extra = json.loads((DIR / "short-group.json").read_text(encoding="utf8"))
    plan, roster = json.loads(json.dumps(PLAN)), json.loads(json.dumps(ROSTER))
    plan["branches"].append(extra["branch"])
    roster["swimmers"].extend(extra["swimmers"])
    return plan, roster


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

    def test_a_short_term_group_matches_the_planner(self):
        plan, roster = with_short_group()
        P = SP.Plan(plan, roster)
        cases = json.loads((DIR / "cases-short-group.json").read_text(encoding="utf8"))
        for bid, weeks in cases.items():
            for mine, ref in zip(P.timeline(bid), weeks):
                with self.subTest(bid=bid, week=ref["i"]):
                    self.assertEqual((mine["p"], mine["code"]), (ref["p"], ref["code"]))
                    self.assertTrue(math.isclose(mine["load"], ref["load"], abs_tol=1e-9), (mine["load"], ref["load"]))
                    if bid.startswith("sw:"):
                        self.assertEqual(mine["group"], ref["group"])
        fay, gus = P.swimmers["s5"], P.swimmers["s6"]
        self.assertEqual([P.group_at(fay, i) for i in range(12)], ["girls"] * 7 + ["late"] * 3 + ["girls"] * 2,
                         "joins on its first week, back to her group when it finishes")
        self.assertEqual([P.group_at(gus, i) for i in range(12)], ["core"] * 8 + ["late"] * 2 + ["core"] * 2,
                         "back to the group he came from, not the one it follows")
        self.assertEqual((P.span("late"), P.runs_in("late", 6), P.runs_in("late", 9), P.ended("late", 10)), ((7, 9), False, True, True))

    def test_micros_of_any_length_match_the_planner(self):
        plan = json.loads(json.dumps(PLAN))
        plan["settings"]["micros"] = ["2026-09-01", "2026-09-09", "2026-09-15", "2026-09-19", "2026-10-05"]
        P = SP.Plan(plan, ROSTER)
        cases = json.loads((DIR / "cases-micros.json").read_text(encoding="utf8"))
        for bid, cols in cases.items():
            mine = P.timeline(bid)
            self.assertEqual(len(mine), len(cols))
            for m, ref in zip(mine, cols):
                with self.subTest(bid=bid, col=ref["i"]):
                    self.assertEqual((m["p"], m["code"], m["camp"], bool(m["away"])), (ref["p"], ref["code"], ref["camp"], ref["away"]))
                    self.assertTrue(math.isclose(m["load"], ref["load"], abs_tol=1e-9), (m["load"], ref["load"]))
        self.assertEqual([P.timeline("core")[i]["days"] for i in range(5)], [8, 8, 6, 4, 16], "micros of uneven lengths")
        self.assertEqual([o["key"] for o in P.occurrences(0)], ["monam", "tuepm", "monam~2"], "Monday comes round twice in 8 days")
        self.assertEqual(P.week_of(date(2026, 9, 17)), 3)
        self.assertEqual(P.occurrence_on(date(2026, 8, 31), None)["key"], "monam~2", "found by its date and slot")

    def test_a_cancelled_session_comes_off_the_load_and_an_extra_one_adds_to_it(self):
        plan = json.loads(json.dumps(PLAN))
        plan["sessions"][0]["slot"], plan["sessions"][1]["slot"] = 5, 6
        plain = SP.Plan(plan, ROSTER).timeline("core")[2]["load"]
        P = SP.Plan(plan, ROSTER, actual={"cancelled": {("2026-09-07", 5): "Pool closed"},
                                          "extra": [{"date": "2026-09-10", "hours": 1.0, "picked": ["s2"]}]})
        w = P.timeline("core")[2]
        self.assertTrue(math.isclose(w["load"], SP.r2(plain * (1 - 1.5 / 2.5))), "Monday's 1.5 of 2.5 hours went")
        self.assertEqual(w["cut"]["items"][0]["why"], "Pool closed")
        bo = P.timeline("sw:s2")[2]
        self.assertGreater(bo["load"], w["load"], "the extra session counts for the swimmer it was for")

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

    def test_the_app_follows_the_planner_squad_tab(self):
        import copy
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            http.put("/season-planner/Test Squad/docs/plan", headers=h, json={"data": PLAN})
            http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": ROSTER})
            with SessionLocal() as db:
                cam = db.query(models.Swimmer).filter_by(name="Cam Test").one()
                dee = db.query(models.Swimmer).filter_by(name="Dee Test").one()
                self.assertEqual((cam.squad, cam.status, cam.swimrankings_id, cam.gender), ("Test Squad", "active", None, "F"),
                                 "added in the planner, added to the app")
                self.assertEqual((dee.status, dee.active), ("occasional", True), "not planned (uni): on the register, not planned for")
                self.assertEqual(db.query(models.GroupMembership).filter_by(swimmer_id=cam.id).count(), 1)

            r2 = copy.deepcopy(ROSTER)
            r2["swimmers"] = [s for s in r2["swimmers"] if s["name"] != "Cam Test"]
            next(s for s in r2["swimmers"] if s["name"] == "Dee Test")["branch"] = "core"
            next(s for s in r2["swimmers"] if s["name"] == "Alex Test")["branch"] = ""
            with SessionLocal() as db:
                db.query(models.Swimmer).filter_by(id=self.bo).update({"status": "injury"})
                db.commit()
            http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": r2})
            with SessionLocal() as db:
                s = {x.name: x for x in db.query(models.Swimmer)}
                self.assertEqual((s["Cam Test"].active, s["Dee Test"].status, s["Alex Test"].status, s["Bo Test"].status),
                                 (False, "active", "occasional", "injury"),
                                 "removed is kept but inactive; groups follow; the coach's injury status stays")
                self.assertIsNotNone(db.query(models.GroupMembership).filter_by(swimmer_id=s["Cam Test"].id).one().date_to)

            http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": ROSTER})
            with SessionLocal() as db:
                self.assertTrue(db.query(models.Swimmer).filter_by(name="Cam Test").one().active, "put back, active again")
                self.assertEqual(db.query(models.Swimmer).filter_by(name="Cam Test").count(), 1, "never duplicated")

    def test_a_short_term_group_runs_for_its_weeks_and_then_is_put_away(self):
        plan, roster = with_short_group()
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            http.put("/season-planner/Test Squad/docs/plan", headers=h, json={"data": plan})
            http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": roster})
            self.assertNotIn("Girls late meet", [g["name"] for g in http.get("/season-planner/Test Squad/groups", headers=h).json()],
                             "once finished it can't be picked")
        with SessionLocal() as db:
            ids = lambda d: [g["id"] for g in SP.week(db, "Test Squad", d)["groups"]]   # noqa: E731
            self.assertNotIn("late", ids(date(2026, 10, 5)), "not on Home before it starts")
            self.assertIn("late", ids(date(2026, 10, 19)))
            self.assertNotIn("late", ids(date(2026, 11, 2)), "nor after it ends")
            fay = db.query(models.Swimmer).filter_by(name="Fay Test").one()
            self.assertEqual(SP.swimmer_week(db, fay, date(2026, 10, 19))["group"]["name"], "Girls late meet")
            self.assertEqual(SP.swimmer_week(db, fay, date(2026, 11, 2))["group"]["name"], "Girls group", "back in her group")
            groups = {g.name: g for g in db.query(models.TrainingGroup).filter_by(squad="Test Squad")}
            self.assertFalse(groups["Girls late meet"].active, "put away in the app once its weeks are over")
            self.assertTrue(groups["Girls group"].active)
            runs = [(m.group_id, m.date_from, m.date_to) for m in db.query(models.GroupMembership).filter_by(swimmer_id=fay.id)
                    .order_by(models.GroupMembership.date_from)]
            self.assertEqual(runs, [(groups["Girls group"].id, date(2026, 8, 24), date(2026, 10, 11)),
                                    (groups["Girls late meet"].id, date(2026, 10, 12), date(2026, 11, 1)),
                                    (groups["Girls group"].id, date(2026, 11, 2), None)], "her group history in the app")
            with self.assertRaises(ValueError):
                SP.place_swimmer(db, "Test Squad", fay, "late")

    def test_a_swimmer_added_in_the_app_gets_a_group_and_the_plan(self):
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            http.put("/season-planner/Test Squad/docs/plan", headers=h, json={"data": PLAN})
            http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": ROSTER})
            self.assertEqual([g["name"] for g in http.get("/season-planner/Test Squad/groups", headers=h).json()],
                             ["Regionals", "Nationals", "Girls group"])
            new = http.post("/swimmers", headers=h, json={"name": "Eve New", "gender": "F",
                                                           "target_events": [{"event": "100 Freestyle", "course": "Both"}]}).json()
            self.assertEqual(http.post("/season-planner/Test Squad/swimmers", headers=h,
                                       json={"swimmer_id": new["id"], "group": "nope"}).status_code, 422)
            self.assertEqual(http.post("/season-planner/Nowhere/swimmers", headers=h,
                                       json={"swimmer_id": new["id"], "group": "core"}).status_code, 422)
        with SessionLocal() as db:
            eve = db.get(models.Swimmer, new["id"])
            wk = SP.place_swimmer(db, "Test Squad", eve, "girls", on=date(2026, 9, 23))
            self.assertEqual((wk["group"]["name"], wk["code"]), ("Girls group", "1.2.2"), "a base plan straight away")
            roster = db.query(models.PlanDoc).filter_by(squad="Test Squad", key="roster").one().data
            mine = next(s for s in roster["swimmers"] if s["name"] == "Eve New")
            self.assertEqual((mine["id"], mine["branch"], [e["e"] for e in mine["events"]]), (f"app{eve.id}", "girls", ["100 Free"]))
            self.assertEqual(db.query(models.Swimmer).filter_by(name="Eve New").count(), 1, "the planner's copy is the same swimmer")
            self.assertEqual((eve.squad, eve.status), ("Test Squad", "active"))

            # a group change from the app moves them from that week, keeping the weeks before
            wk = SP.place_swimmer(db, "Test Squad", eve, "nats", on=date(2026, 9, 23))
            self.assertEqual(wk["group"]["name"], "Nationals")
            self.assertEqual(SP.swimmer_week(db, eve, date(2026, 9, 1))["group"]["name"], "Girls group")
            SP.place_swimmer(db, "Test Squad", eve, "", on=date(2026, 9, 23))
            db.refresh(eve)
            self.assertEqual(eve.status, "occasional", "Not planned: uni / visiting")

    def test_the_plan_opens_in_line_with_the_timetable_the_meets_and_the_scales(self):
        with SessionLocal() as db:
            mon = models.PoolSlot(day_of_week=0, time="05:30", end_time="07:00", squad=None, course="LCM", label="Monday AM", active=True)
            other = models.PoolSlot(day_of_week=2, time="05:30", end_time="07:00", squad="Other Squad", active=True)
            thu = models.PoolSlot(day_of_week=3, time="06:00", end_time="07:30", squad="Test Squad", course="SCM", active=True)
            county = models.Meet(name="County Champs 2026", date=date(2026, 11, 7), date_to=date(2026, 11, 8), course="SCM", location="Test pool")
            autumn = models.Meet(name="Autumn Open", date=date(2026, 9, 19), course="LCM")
            later = models.Meet(name="Summer Open", date=date(2027, 8, 1))
            db.add_all([mon, other, thu, county, autumn, later])
            db.commit()
            ids = {k: v.id for k, v in (("mon", mon), ("other", other), ("thu", thu), ("county", county), ("autumn", autumn), ("later", later))}
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            http.put("/season-planner/Test Squad/docs/roster", headers=h, json={"data": ROSTER})
            http.put("/season-planner/Test Squad/docs/plan", headers=h, json={"data": PLAN})
            got = http.get("/season-planner/Test Squad/docs", headers=h).json()["plan"]
            p, rev = got["data"], got["revision"]

            # intensity: the old RPE line carried over by colour, onto the common line
            self.assertEqual(p["line"], "common")
            self.assertEqual(p["templates"][0]["f"]["monam"], {"a": 13.5, "b": 15.5}, "Yellow and Pink")
            self.assertEqual(p["templates"][0]["f"]["tuepm"], {"a": 21}, "Gold stays at 21")

            # timetable: Mon AM is the club's slot (and its 50m pool), Tue PM goes onto the timetable,
            # the squad's Thursday slot joins the plan, another squad's slot doesn't
            ses = {x["id"]: x for x in p["sessions"]}
            self.assertEqual((ses["monam"]["slot"], ses["monam"]["pool"], ses["monam"]["mph"]), (ids["mon"], "50m", 2500))
            thu_s = next(x for x in p["sessions"] if x.get("slot") == ids["thu"])
            self.assertEqual((thu_s["label"], thu_s["day"], thu_s["hours"], thu_s["time"]), ("Thu AM", 3, 1.5, "06:00–07:30"))
            self.assertNotIn(ids["other"], [x["slot"] for x in p["sessions"]])
            self.assertEqual([x["id"] for x in p["sessions"]], ["monam", "tuepm", f"slot{ids['thu']}"], "in timetable order")
            with SessionLocal() as db:
                tue = db.get(models.PoolSlot, ses["tuepm"]["slot"])
                self.assertEqual((tue.day_of_week, tue.time, tue.end_time, tue.squad, tue.course), (1, "20:00", "21:00", "Test Squad", "SCM"))

            # meets: County Champs is the Meets tab's meet, Autumn Open joins the plan, next summer's doesn't
            cal = {c["name"]: c for c in p["calendar"]}
            self.assertEqual((cal["County Champs 2026"]["meet"], cal["County Champs 2026"]["prio"]["core"], cal["County Champs 2026"]["short"]),
                             (ids["county"], "A", "County"), "the plan's own A/B/C and short name stay")
            self.assertEqual((cal["Autumn Open"]["meet"], cal["Autumn Open"]["course"], cal["Autumn Open"]["prio"]), (ids["autumn"], "50m", {}))
            self.assertNotIn("Summer Open", cal)

            # opening it again changes nothing
            self.assertEqual(http.get("/season-planner/Test Squad/docs", headers=h).json()["plan"]["revision"], rev)

            # a slot turned off puts its session aside, with what's planned on it; turned on, it comes back
            with SessionLocal() as db:
                db.get(models.PoolSlot, ids["mon"]).active = False
                db.delete(db.get(models.Meet, ids["autumn"]))
                db.commit()
            p = http.get("/season-planner/Test Squad/docs", headers=h).json()["plan"]["data"]
            self.assertEqual([x["id"] for x in p["sessions"]], ["tuepm", f"slot{ids['thu']}"])
            self.assertEqual([x["id"] for x in p["sessionsRetired"]], ["monam"])
            self.assertNotIn("Autumn Open", {c["name"] for c in p["calendar"]}, "deleted in the Meets tab")
            with SessionLocal() as db:
                db.get(models.PoolSlot, ids["mon"]).active = True
                db.commit()
            p = http.get("/season-planner/Test Squad/docs", headers=h).json()["plan"]["data"]
            self.assertEqual([x["id"] for x in p["sessions"]], ["monam", "tuepm", f"slot{ids['thu']}"])
            self.assertNotIn("sessionsRetired", p)
            self.assertEqual(p["templates"][0]["f"]["monam"], {"a": 13.5, "b": 15.5})

    def test_the_staff_read_the_plan_for_the_session_they_are_writing(self):
        plan = json.loads(json.dumps(PLAN))
        SP.to_common_line(plan)
        plan["scale"] = "bpsc"
        plan["sessions"][0]["slot"] = 5                                   # Mon AM is slot 5
        plan["branches"][1]["sess"] = {"3": {"monam": {"a": 21, "n": "Race pace 50s"}}}   # Nationals, week 3 only
        plan["personal"] = {"s1": {"ownSess": {"core": {"3": {"monam": {"a": 10}}}}}}    # Alex has an easy one
        with SessionLocal() as db:
            db.add_all([models.PlanDoc(club="default", squad="Test Squad", key="plan", data=plan, revision=1),
                        models.PlanDoc(club="default", squad="Test Squad", key="roster", data=ROSTER, revision=1)])
            db.commit()
            text = SP.staff_lines(db, "Test Squad", date(2026, 9, 14), 5)
            self.assertIn("THE PLAN FOR THIS SESSION (Mon AM", text)
            self.assertIn("- Regionals: Red", text, "General prep's standard week")
            self.assertIn("- Nationals: Gold (Race pace 50s)", text, "the group's own change for the week")
            self.assertIn("- Girls group: Red", text, "a group on the same block follows its parent")
            self.assertIn("- Alex Test (own week): White", text)
            self.assertNotIn("THE PLAN FOR THIS SESSION", SP.staff_lines(db, "Test Squad", date(2026, 9, 14), 99), "not a plan session")
            self.assertIn("- Regionals: Red", SP.staff_lines(db, None, date(2026, 9, 14), 5), "a club-wide slot reads the club's one plan")

    def test_meets_on_the_same_day_match_on_a_distinctive_word(self):
        self.assertTrue(SP._same_meet("Northampton Winter Festival", "Northampton Winter Meet 2026"))
        self.assertTrue(SP._same_meet("Essex Age Groups - Wkd 1", "Essex County Age Group Championships Weekend 1"))
        self.assertFalse(SP._same_meet("County Championships", "Regional Championships"), "only generic words shared")
        self.assertFalse(SP._same_meet("Winter Open 2026", "Summer Open 2026"))

    def test_a_plan_on_the_common_line_reads_its_colours(self):
        plan = json.loads(json.dumps(PLAN))
        SP.to_common_line(plan)
        self.assertFalse(SP.to_common_line(plan), "only once")
        t = SP.Plan(plan, ROSTER).targets(plan["templates"][0]["name"])
        self.assertEqual([(x["levels"], x["common"]) for x in t], [(["Yellow", "Pink"], [13.5, 15.5]), (["Gold"], [21.0])])


if __name__ == "__main__":
    unittest.main()
