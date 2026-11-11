"""Sessions written in the Session Builder feed the register and the load counter.

A new session starts from the season plan's groups on that date; saving it
works out each group's swimmers, sets and metres per training zone in code.
"""
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
from backend.services import session_builder as B  # noqa: E402
from backend.services import session_notation as N  # noqa: E402
from backend.tests import reset_database  # noqa: E402

SAMPLES = Path(__file__).resolve().parents[2] / "shared" / "notation" / "sessions"
MONDAY = date(2026, 10, 5)


def sample(name):
    return json.loads((SAMPLES / f"{name}.json").read_text(encoding="utf8"))["session"]


class SessionBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            girls = models.TrainingGroup(name="Girls", squad="Silver 1")
            boys = models.TrainingGroup(name="Boys", squad="Silver 1")
            db.add_all([girls, boys])
            db.flush()
            self.swimmers = {}
            for name, g in (("Ruby", girls), ("Ava", girls), ("Leo", boys)):
                s = models.Swimmer(name=name, squad="Silver 1", active=True)
                db.add(s)
                db.flush()
                db.add(models.GroupMembership(swimmer_id=s.id, group_id=g.id, date_from=date(2026, 9, 1)))
                self.swimmers[name] = s.id
            slot = models.PoolSlot(day_of_week=0, time="05:30", end_time="07:00", squad="Silver 1", label="Mon AM")
            db.add(slot)
            db.commit()
            self.slot_id = slot.id
            self.girls_id, self.boys_id = girls.id, boys.id

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def test_a_new_session_starts_with_the_plans_groups_and_their_swimmers(self):
        http, h = self.client()
        with http:
            r = http.post("/session-builder/sessions", headers=h,
                          json={"date": MONDAY.isoformat(), "pool_slot_id": self.slot_id})
            self.assertEqual(r.status_code, 201, r.text)
            s = r.json()["session"]
            self.assertEqual([g["name"] for g in s["groups"]], ["Girls", "Boys"], "in the plan's order")
            girls = next(g for g in s["groups"] if g["name"] == "Girls")
            self.assertEqual(sorted(girls["swimmer_ids"]), sorted([self.swimmers["Ruby"], self.swimmers["Ava"]]))
            self.assertEqual([b["name"] for b in s["blocks"]], ["Warm up", "Main set", "Swim down"])
            self.assertEqual((s["start"], s["end"], s["slot"]), ("05:30", "07:00", "AM"))
            again = http.post("/session-builder/sessions", headers=h,
                              json={"date": MONDAY.isoformat(), "pool_slot_id": self.slot_id})
            self.assertEqual(again.json()["id"], r.json()["id"], "the slot's session is reopened, not duplicated")

    def test_saving_works_out_each_groups_sets_and_zone_metres(self):
        http, h = self.client()
        with http:
            sid = http.post("/session-builder/sessions", headers=h,
                            json={"date": MONDAY.isoformat(), "pool_slot_id": self.slot_id}).json()["id"]
            b = sample("s-261005-am")   # Group 1 Girls / Group 2 Boys, as written in the builder
            r = http.put(f"/session-builder/sessions/{sid}", headers=h, json={"session": b})
            self.assertEqual(r.status_code, 200, r.text)
            groups = r.json()["groups"]
            self.assertEqual([g["group"] for g in groups], ["Group 1 Girls", "Group 2 Boys"])
            self.assertEqual([g["dist"] for g in groups], [3400, 3400])
        with SessionLocal() as db:
            s = db.get(models.Session, sid)
            self.assertEqual(s.register_group_count, 2)
            rows = sorted(s.groups, key=lambda g: g.group_number)
            expected = N.session_zones(N.normalize_session(sample("s-261005-am")))
            for row, z in zip(rows, expected):
                self.assertEqual(row.volume_breakdown, B.zone_volume(z["zones"]))
                self.assertTrue(row.sets["builder"])
                self.assertIn("Totals:", row.sets["text"])
            self.assertEqual(s.planned_content["1"]["description"], "Group 1 Girls")
            self.assertEqual(s.builder["blocks"][1]["name"], "Group 1")

    def test_the_builder_session_reopens_as_it_was_saved(self):
        http, h = self.client()
        with http:
            sid = http.post("/session-builder/sessions", headers=h, json={"date": MONDAY.isoformat()}).json()["id"]
            b = sample("s-260927-am")
            http.put(f"/session-builder/sessions/{sid}", headers=h, json={"session": b})
            got = http.get(f"/session-builder/sessions/{sid}", headers=h).json()["session"]
            self.assertEqual([x["name"] for x in got["blocks"]], [x["name"] for x in b["blocks"]])
            self.assertEqual(N.totals_for(got)[0]["dist"], N.totals_for(N.normalize_session(b))[0]["dist"])

    def test_an_older_session_opens_in_the_builder(self):
        with SessionLocal() as db:
            s = models.Session(date=MONDAY, squad="Silver 1", start_time="18:00")
            db.add(s)
            db.flush()
            db.add(models.SessionGroup(session_id=s.id, group_number=1, description="Sprint",
                                       sets={"raw": "400 easy\n8x50 @1:00 [18]"}))
            db.add(models.SessionGroup(session_id=s.id, group_number=2, description="Distance",
                                       sets={"raw": "400 easy\n4x200 @3:00 [16]"}))
            db.commit()
            b = B.builder_for(db, s)
        self.assertEqual([g["name"] for g in b["groups"]], ["Sprint", "Distance"])
        self.assertEqual(b["slot"], "PM")
        self.assertEqual([t["dist"] for t in N.totals_for(b)], [800, 1200])

    def test_copy_to_next_week_takes_next_weeks_swimmers_from_the_plan(self):
        http, h = self.client()
        with http:
            first = http.post("/session-builder/sessions", headers=h,
                              json={"date": MONDAY.isoformat(), "pool_slot_id": self.slot_id}).json()
            with SessionLocal() as db:   # Leo moves to the girls' group from the following Monday
                m = db.query(models.GroupMembership).filter_by(swimmer_id=self.swimmers["Leo"]).one()
                m.date_to = date(2026, 10, 11)
                db.add(models.GroupMembership(swimmer_id=self.swimmers["Leo"], group_id=self.girls_id,
                                              date_from=date(2026, 10, 12)))
                db.commit()
            nxt = http.post(f"/session-builder/sessions/{first['id']}/copy-next-week", headers=h).json()
            self.assertEqual(nxt["session"]["date"], "2026-10-12")
            girls = next(g for g in nxt["session"]["groups"] if g["name"] == "Girls")
            self.assertIn(self.swimmers["Leo"], girls["swimmer_ids"])

    def test_the_usual_intensity_scale_is_the_coaches_choice(self):
        http, h = self.client()
        with http:
            self.assertEqual(http.get("/session-builder/settings", headers=h).json()["effort_scale"], "effort20")
            self.assertEqual(http.put("/session-builder/settings", headers=h, json={"effort_scale": "sweetenham"}).status_code, 200)
            self.assertEqual(http.put("/session-builder/settings", headers=h, json={"effort_scale": "nope"}).status_code, 422)
            self.assertEqual(http.put("/session-builder/settings", headers=h, json={"effort_scale": "bpsc"}).status_code, 422,
                             "BPSC's colours are BPSC's own scale, not a standard one")
            s = http.post("/session-builder/sessions", headers=h, json={"date": MONDAY.isoformat()}).json()["session"]
            self.assertEqual(s["effSys"], "sweetenham")

    def test_a_club_keeps_its_own_intensity_scales(self):
        import copy
        http, h = self.client()
        try:
            with http:
                st = http.get("/session-builder/settings", headers=h).json()
                self.assertEqual([s["key"] for s in st["standard"]], ["effort20", "rpe", "urbanchek", "sweetenham", "maglischo"])
                self.assertEqual(st["custom"], [])
                bpsc = {"key": "bpsc", "name": "BPSC HR colours", "short": "HR colour",
                        "zones": copy.deepcopy(N.EFF_SYSTEMS["bpsc"]["zones"])}
                r = http.put("/session-builder/settings", headers=h, json={"custom_scales": [bpsc], "effort_scale": "bpsc"})
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json()["effort_scale"], "bpsc")
                self.assertEqual([z["hi"] for z in r.json()["custom"][0]["zones"]], [z["hi"] for z in N.EFF_SYSTEMS["bpsc"]["zones"]],
                                 "a copy keeps the same levels")

                # a version of their own, changed without touching the standard scale
                mine = copy.deepcopy(bpsc)
                mine.update(key="c-test", name="Silver 1 colours")
                mine["zones"][3].update(label="Crimson", note="HR 29-31")
                r = http.put("/session-builder/settings", headers=h, json={"custom_scales": [bpsc, mine], "hidden_scales": ["rpe", "maglischo"]})
                self.assertEqual([s["key"] for s in r.json()["scales"]], ["effort20", "urbanchek", "sweetenham", "bpsc", "c-test"])
                self.assertEqual(N.EFF_SYSTEMS["bpsc"]["zones"][3]["label"], "Red", "the standard definition is untouched")
                self.assertEqual(N.eff_from_canon("17", "c-test"), "Crimson")
                self.assertEqual(N.eff_to_canon("crimson", "c-test"), "17", "typed in the club's own words")
                self.assertIn("4x100 Free [Crimson]",
                              N.session_text({"blocks": [{"name": "Main", "groups": [], "items": N.parse_text("4x100 Free [17]")}]}, "c-test"))

                bad = copy.deepcopy(mine)
                bad["zones"][2]["label"] = "Pink fast"
                self.assertIn("one word", http.put("/session-builder/settings", headers=h, json={"custom_scales": [bad]}).json()["detail"])
                bad = copy.deepcopy(mine)
                bad["zones"][1]["color"] = ""
                self.assertIn("every level a colour", http.put("/session-builder/settings", headers=h, json={"custom_scales": [bad]}).json()["detail"])
                self.assertEqual(http.put("/session-builder/settings", headers=h, json={"custom_scales": [dict(bpsc, key="sweetenham")]}).status_code, 422,
                                 "a standard scale can't be overwritten")

                # deleting the usual scale goes back to Effort /20; sessions keep their numbers
                r = http.put("/session-builder/settings", headers=h, json={"custom_scales": [mine]}).json()
                self.assertEqual(r["effort_scale"], "effort20")
                self.assertEqual(N.eff_from_canon("17.5", "gone"), "18", "an unknown scale shows the numbers")
        finally:
            N.use_scales([])

    def test_typed_or_spoken_sets_are_read_like_the_builder(self):
        http, h = self.client()
        with http:
            r = http.post("/session-builder/parse", headers=h, json={"text": "four by fifty on one ten", "speech": True}).json()
            self.assertEqual(r["text"], "4x50 on 1:10")
            self.assertEqual((r["stats"]["dist"], r["stats"]["time"]), (200, 280))

    def test_the_register_offers_each_swimmers_expected_group_and_records_how_it_went(self):
        http, h = self.client()
        with http:
            sid = http.post("/session-builder/sessions", headers=h,
                            json={"date": MONDAY.isoformat(), "pool_slot_id": self.slot_id}).json()["id"]
            reg = {r["swimmer_id"]: r for r in http.get(f"/sessions/{sid}/register", headers=h).json()}
            self.assertEqual(reg[self.swimmers["Ruby"]]["group_planned"], 1, "Girls are the session's first group")
            self.assertEqual(reg[self.swimmers["Leo"]]["group_planned"], 2)
            self.assertIsNone(reg[self.swimmers["Ruby"]]["attended"], "attendance still starts blank")

            entries = [
                {"swimmer_id": self.swimmers["Ruby"], "attended": True, "group_planned": 1, "group_done": 1, "response": "flat"},
                {"swimmer_id": self.swimmers["Leo"], "attended": True, "group_planned": 2, "group_done": 1, "response": "good"},
                {"swimmer_id": self.swimmers["Ava"], "attended": False, "group_planned": 1, "response": "good"},
            ]
            r = http.put(f"/sessions/{sid}/register", headers=h, json={
                "entries": entries, "run_ai": False, "session_complete": False, "register_group_count": 2,
                "as_swum": {"status": "changed", "note": "Main set cut to 3 rounds"}})
            self.assertEqual(r.status_code, 200, r.text)
            reg = {r["swimmer_id"]: r for r in http.get(f"/sessions/{sid}/register", headers=h).json()}
            self.assertEqual(reg[self.swimmers["Ruby"]]["response"], "flat")
            self.assertEqual(reg[self.swimmers["Leo"]]["group_done"], 1, "Leo swam the girls' set on the day")
            self.assertIsNone(reg[self.swimmers["Ava"]]["response"], "no response for someone who wasn't there")
            detail = http.get(f"/sessions/{sid}", headers=h).json()
            self.assertEqual(detail["as_swum"], {"status": "changed", "note": "Main set cut to 3 rounds"})
            self.assertTrue(detail["builder"])

    def test_who_swims_each_group_after_the_register_was_taken_first(self):
        """The register taken before the session was written, then the session split in
        two groups by hand: the coach says who swam which, and the register follows."""
        http, h = self.client()
        ruby, ava, leo = self.swimmers["Ruby"], self.swimmers["Ava"], self.swimmers["Leo"]
        with http:
            sid = http.post("/session-builder/sessions", headers=h, json={"date": MONDAY.isoformat()}).json()["id"]
            http.put(f"/sessions/{sid}/register", headers=h, json={
                "entries": [{"swimmer_id": ruby, "attended": True, "group_done": 1},
                            {"swimmer_id": leo, "attended": True, "group_done": 1},
                            {"swimmer_id": ava, "attended": False}],
                "run_ai": False, "session_complete": False, "register_group_count": 1})
            session = http.get(f"/session-builder/sessions/{sid}", headers=h).json()["session"]
            session["groups"] = [{"id": "ga", "name": "Sprint"}, {"id": "gb", "name": "Distance"}]
            http.put(f"/session-builder/sessions/{sid}", headers=h, json={"session": session})

            got = http.get(f"/session-builder/sessions/{sid}/swimmers", headers=h).json()
            self.assertTrue(got["register_taken"])
            by_id = {s["id"]: s for s in got["swimmers"]}
            self.assertTrue(by_id[ruby]["attended"])
            self.assertEqual(by_id[leo]["training_group"], "Boys")
            self.assertEqual({p["name"] for p in got["plan_groups"]}, {"Girls", "Boys"})

            session["groups"][0]["swimmer_ids"] = [leo]
            session["groups"][1]["swimmer_ids"] = [ruby, ava, leo]   # Leo twice: the first group wins
            r = http.put(f"/session-builder/sessions/{sid}/group-swimmers", headers=h, json={"session": session})
            self.assertEqual(r.status_code, 200, r.text)
            out = r.json()
            self.assertEqual([g["swimmer_ids"] for g in out["builder_groups"]], [[leo], [ruby, ava]])
            self.assertEqual(out["register_moved"], 1, "Ruby moves to Distance; Leo was already in group 1")

            reg = {e["swimmer_id"]: e for e in http.get(f"/sessions/{sid}/register", headers=h).json()}
            self.assertEqual(reg[ruby]["group_done"], 2)
            self.assertEqual(reg[leo]["group_done"], 1)
            self.assertFalse(reg[ava]["attended"], "attendance is never changed from the builder")
            self.assertIsNone(reg[ava]["group_done"])
            with SessionLocal() as db:
                s = db.get(models.Session, sid)
                self.assertEqual(s.register_group_count, 2)
                groups = sorted(s.groups, key=lambda g: g.group_number)
                self.assertEqual([g.target_swimmer_ids for g in groups], [[leo], [ruby, ava]])

            # a group holding exactly a training group's swimmers stays linked to it
            session["groups"][0]["swimmer_ids"] = [leo]
            session["groups"][1]["swimmer_ids"] = [ava, ruby]
            out = http.put(f"/session-builder/sessions/{sid}/group-swimmers", headers=h, json={"session": session}).json()
            self.assertEqual(out["builder_groups"][0].get("training_group_id"), self.boys_id)
            self.assertEqual(out["builder_groups"][1].get("training_group_id"), self.girls_id)

    def test_who_swims_each_group_needs_groups(self):
        http, h = self.client()
        with http:
            sid = http.post("/session-builder/sessions", headers=h, json={"date": MONDAY.isoformat()}).json()["id"]
            session = http.get(f"/session-builder/sessions/{sid}", headers=h).json()["session"]
            session["groups"] = []
            r = http.put(f"/session-builder/sessions/{sid}/group-swimmers", headers=h, json={"session": session})
            self.assertEqual(r.status_code, 422)


    def test_a_session_can_be_for_one_swimmer_or_a_camp(self):
        http, h = self.client()
        with http:
            sid = http.post("/session-builder/sessions", headers=h, json={"date": MONDAY.isoformat()}).json()["id"]
            r = http.put(f"/session-builder/sessions/{sid}/audience", headers=h, json={
                "kind": "swimmer", "label": "Manchester para camp", "swimmer_ids": [self.swimmers["Leo"]]})
            self.assertEqual(r.status_code, 200, r.text)
            got = http.get(f"/session-builder/sessions/{sid}", headers=h).json()["audience"]
            self.assertEqual((got["kind"], got["label"], got["swimmer_ids"]), ("swimmer", "Manchester para camp", [self.swimmers["Leo"]]))
            self.assertEqual(http.put(f"/session-builder/sessions/{sid}/audience", headers=h, json={"kind": "squad"}).json()["audience"], None)
            self.assertEqual(http.put(f"/session-builder/sessions/{sid}/audience", headers=h, json={"kind": "team"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
