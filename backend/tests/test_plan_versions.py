"""Versions of a session are part of the plan (docs/design/season-planner-weeks.md 4.3): who is on which
comes from their usual sessions ahead of time and from the register once it's taken, and the Session
Builder opens the session already split into them."""
import os
import unittest
from datetime import date, datetime, timedelta, timezone

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import season_planner as SP  # noqa: E402
from backend.tests import reset_database  # noqa: E402

MON = date(2026, 11, 23)
WED = MON + timedelta(days=2)


def plan_doc(slots):
    mon, tue, wed = slots
    return {
        "schema": 1, "line": "common",
        "settings": {"start": MON.isoformat(), "weeks": 4, "near": .015, "squad": "Silver 1"},
        "sessions": [
            {"id": "monpm", "label": "Mon PM", "day": 0, "time": "18:00", "hours": 1.5, "mph": 3000, "pool": "25m", "slot": mon},
            {"id": "tuepm", "label": "Tue PM", "day": 1, "time": "18:00", "hours": 1.5, "mph": 3000, "pool": "25m", "slot": tue},
            {"id": "wedam", "label": "Wed AM", "day": 2, "time": "06:00", "hours": 1.0, "mph": 3000, "pool": "25m", "slot": wed},
        ],
        # Wednesday AM: speed and pace, but recovery for those who did Monday PM and Tuesday PM
        "templates": [{"name": "Build", "s": {"wedam": "Speed and pace"}, "f": {
            "wedam": {"a": 21, "v": [{"k": "did", "s": ["monpm", "tuepm"], "a": 10, "n": "Recovery"}]}}}],
        "phases": {"p1": {"macro": "1", "name": "Build", "template": "Build", "course": "SC"}},
        "calendar": [], "events": [],
        "branches": [{"id": "core", "name": "Regionals", "parent": None, "color": "#E8731A",
                      "weeks": {str(i): {"p": "p1", "load": .8} for i in range(4)}}],
    }


class PlanVersionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            slots = [models.PoolSlot(day_of_week=d, time=t, end_time=e, squad="Silver 1", active=True)
                     for d, t, e in ((0, "18:00", "19:30"), (1, "18:00", "19:30"), (2, "06:00", "07:00"))]
            sam = models.Swimmer(name="Sam Both", squad="Silver 1", active=True)
            ali = models.Swimmer(name="Ali NoTuesday", squad="Silver 1", active=True)
            db.add_all(slots + [sam, ali])
            db.flush()
            self.slots = [s.id for s in slots]
            db.add_all([models.SwimmerSlot(swimmer_id=sam.id, pool_slot_id=x) for x in self.slots])
            db.add_all([models.SwimmerSlot(swimmer_id=ali.id, pool_slot_id=x) for x in (self.slots[0], self.slots[2])])
            roster = {"swimmers": [{"id": f"app{sam.id}", "name": sam.name, "branch": "core", "moves": []},
                                   {"id": f"app{ali.id}", "name": ali.name, "branch": "core", "moves": []}]}
            db.add(models.PlanDoc(club="default", squad="Silver 1", key="plan", data=plan_doc(self.slots), revision=1))
            db.add(models.PlanDoc(club="default", squad="Silver 1", key="roster", data=roster, revision=1))
            db.commit()
            SP.after_save(db, "Silver 1")
            self.sam, self.ali = sam.id, ali.id

    def tearDown(self):
        reset_database()

    def versions(self):
        with SessionLocal() as db:
            found = SP.session_versions(db, "Silver 1", WED, self.slots[2])
        self.assertEqual(len(found), 1)
        return {(v["label"] or "main"): sorted(v["swimmer_ids"]) for v in found[0]["versions"]}

    def test_who_is_on_which_version(self):
        self.assertEqual(self.versions(), {"main": [self.ali], "did Mon PM and Tue PM": [self.sam]},
                         "ahead of time, from their usual sessions: Ali doesn't do Tuesdays")
        with SessionLocal() as db:
            tue = models.Session(date=MON + timedelta(days=1), squad="Silver 1", pool_slot_id=self.slots[1],
                                 status="completed", register_saved_at=datetime.now(timezone.utc))
            db.add(tue)
            db.flush()
            db.add(models.SessionEntry(session_id=tue.id, swimmer_id=self.sam, attended=False))
            db.commit()
        self.assertEqual(self.versions(), {"main": sorted([self.ali, self.sam]), "did Mon PM and Tue PM": []},
                         "Sam missed Tuesday on the register, so Wednesday is the tougher session for him too")

        with SessionLocal() as db:
            lines = "\n".join(SP.session_lines(db, "Silver 1", WED, self.slots[2]))
        self.assertIn("version for those who did Mon PM and Tue PM", lines)
        self.assertIn("(nobody this time)", lines)

    def test_the_builder_opens_the_session_already_split(self):
        http = TestClient(app)
        with http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            out = http.post("/session-builder/sessions", json={"date": WED.isoformat(), "pool_slot_id": self.slots[2]}, headers=h)
            self.assertEqual(out.status_code, 201, out.text)
            body = out.json()
            groups = (body.get("session") or body.get("builder") or body)["groups"]
            self.assertEqual([(g["name"], g["swimmer_ids"]) for g in groups],
                             [("Regionals", [self.ali]), ("Regionals · did Mon PM and Tue PM", [self.sam])])
            actual = http.get(f"/season-planner/Silver 1/actuals?date_from={MON}&date_to={WED}", headers=h).json()
            self.assertEqual(actual["usual"][f"app{self.ali}"], sorted([self.slots[0], self.slots[2]]))
            self.assertEqual([s["slot"] for s in actual["sessions"]], [self.slots[2]], "the session just written")


    def test_versions_set_once_on_the_timetable_and_groups_that_copy_another(self):
        with SessionLocal() as db:
            doc = db.query(models.PlanDoc).filter_by(squad="Silver 1", key="plan").one()
            d = dict(doc.data)
            d["templates"] = [{"name": "Build", "s": {"wedam": "Speed and pace"}, "f": {"wedam": {"a": 21}}}]
            d["sessions"] = [dict(x) for x in d["sessions"]]
            d["sessions"][2]["v"] = [{"k": "did", "s": ["monpm", "tuepm"], "a": 10, "n": "Recovery"}]   # the Calendar tab
            doc.data = d
            db.commit()
        self.assertEqual(self.versions(), {"main": [self.ali], "did Mon PM and Tue PM": [self.sam]},
                         "versions set on the timetable apply every week")
        with SessionLocal() as db:
            doc = db.query(models.PlanDoc).filter_by(squad="Silver 1", key="plan").one()
            d = dict(doc.data)
            d["branches"] = d["branches"] + [
                {"id": "dev", "name": "Development", "parent": None, "color": "#888", "weeks": {str(i): {"p": "p1", "load": .5} for i in range(4)},
                 "sess": {"0": {"wedam": {"a": 5, "n": "Kick"}}}},
                {"id": "ral", "name": "Arena League", "parent": "core", "color": "#555", "weeks": {str(i): {"p": "p1", "load": .8} for i in range(4)}}]
            doc.data = d
            db.commit()
        with SessionLocal() as db:
            plan = SP.load(db, "Silver 1")
            self.assertEqual(plan.session_target("ral", 0, "wedam")["a"], 21, "a sub group copies its parent by default")
            plan.branches["ral"]["follow"] = "dev"
            plan._tl.clear()
            self.assertEqual(plan.session_target("ral", 0, "wedam")["n"], "Kick", '"Same as Development"')
            plan.branches["ral"]["follow"] = ""
            self.assertEqual(plan.session_target("ral", 0, "wedam")["n"], "Speed and pace", "its own: the block's usual week")
            plan.branches["ral"]["follow"], plan.branches["dev"]["follow"] = "dev", "ral"
            self.assertIsNone(plan.copy_of("ral", 0), "two groups copying each other copy nobody")
            g = SP.guide(db, "Silver 1", WED)
        self.assertEqual(g["block"]["name"], "Build")
        self.assertEqual((g["block"]["n"], g["block"]["of"]), (1, 4))
        reg = next(x for x in g["groups"] if x["name"] == "Regionals")
        wed = next(x for x in reg["sessions"] if x["label"] == "Wed AM")
        self.assertEqual([(v["who"], v["names"]) for v in wed["versions"]],
                         [("those who did Mon PM and Tue PM", ["Sam"]), ("everyone else", ["Ali"])])
        self.assertEqual(next(x for x in g["groups"] if x["name"] == "Arena League")["same_as"], "Regionals")


if __name__ == "__main__":
    unittest.main()
