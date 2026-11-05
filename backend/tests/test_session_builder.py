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
            self.assertEqual(http.put("/session-builder/settings", headers=h, json={"effort_scale": "bpsc"}).status_code, 200)
            self.assertEqual(http.put("/session-builder/settings", headers=h, json={"effort_scale": "nope"}).status_code, 422)
            s = http.post("/session-builder/sessions", headers=h, json={"date": MONDAY.isoformat()}).json()["session"]
            self.assertEqual(s["effSys"], "bpsc")

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
