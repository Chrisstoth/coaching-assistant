"""The LaneWatch link: the key kept safe, swimmers paired only on confirmation,
race detail read live and turned into figures the analyst can trust.

LaneWatch itself is never called: _request is replaced with a fake that
answers like the LaneWatch API does.
"""
import os
import unittest
from datetime import date
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.services import lanewatch  # noqa: E402
from backend.services.lanewatch import LaneWatchError  # noqa: E402
from backend.tests import reset_database  # noqa: E402

RUBY_LW = "0b9f4a4e-2d1c-4c1e-9a53-3f1f0e6a7b21"
LEO_LW = "1c8e3b5f-3e2d-4d2f-8b64-4a2a1f7b8c32"
STRANGER_LW = "2d7f2c6a-4f3e-4e3a-9c75-5b3b2a8c9d43"
KEY = "lwk_" + "k" * 43


class FakeLaneWatch:
    def __init__(self):
        self.calls = []
        self.revoked = False

    def __call__(self, method, path, token, body=None):
        self.calls.append((method, path, token))
        if method == "POST" and path == "/connected-apps":
            if token != "firebase-id-token":
                raise LaneWatchError("Invalid Firebase token", status=401)
            return {"id": "app-1", "key": KEY, "name": body["name"]}
        if token != KEY or self.revoked:
            raise LaneWatchError("This connection is not valid or has been disconnected.", status=401)
        if method == "GET" and path == "/connected-apps/current":
            return {"display_name": "Coach Chris", "role": "coach"}
        if method == "DELETE" and path == "/connected-apps/current":
            self.revoked = True
            return {"disconnected": True}
        if path == "/coach_swimmers/as_coach/me":
            return {"rows": [
                {"id": RUBY_LW, "name": "Ruby Wheeler", "date_of_birth": "2011-03-04", "cloud_visibility": "coach"},
                {"id": LEO_LW, "name": "leo  park", "date_of_birth": None, "cloud_visibility": "private"},
                {"id": STRANGER_LW, "name": "Someone Else", "date_of_birth": "2010-01-01", "cloud_visibility": "coach"},
            ]}
        if path == f"/swim-logs/for/{LEO_LW}":
            raise LaneWatchError("This swimmer has not shared their logs with coaches", status=403)
        if path == f"/swim-logs/for/{RUBY_LW}":
            return [RACE_1, RACE_2, {"id": "x", "event": "50 Free", "date": "2026-01-01", "time": 30.1}]
        raise AssertionError(f"unexpected call {method} {path}")


# Absolute splits, the same map copied into every length (the video maker's way).
_ABS = {"25": 13.1, "50": 27.9, "75": 43.0, "100": 58.2}
RACE_1 = {
    "id": "r1", "event": "100 Freestyle", "distance": 100, "course": "SCM", "date": "2026-06-01",
    "meet": "County Champs", "round": "Final", "time": 58.2,
    "metrics_json": {"v": 1, "time_15m": 6.6, "uw_speed_turns": 1.7, "swim_speed": 1.85,
                     "stroke_rate": 44.2, "rate_drop": -9.5, "half_drop": 8.6},
    "details_json": {"lengths": [
        {"lengthIndex": i, "distanceTimes": _ABS, "strokeRates": [1.3, 1.35] if i < 2 else [1.5, 48]}
        for i in range(4)]},
}
# Length-relative splits (the old import format): the same key repeats per length.
RACE_2 = {
    "id": "r2", "event": "100 Freestyle", "distance": 100, "course": "SCM", "date": "2026-05-01", "time": 59.0,
    "metrics_json": {"v": 1, "uw_speed_turns": 1.6, "swim_speed": 1.8, "rate_drop": -10.5, "half_drop": 9.0},
    "details_json": {"lengths": [
        {"lengthIndex": 0, "distanceTimes": {"25": 13.3}},
        {"lengthIndex": 1, "distanceTimes": {"25": 28.4}},
        {"lengthIndex": 2, "distanceTimes": {"25": 43.8}},
        {"lengthIndex": 3, "distanceTimes": {"25": 59.0}},
    ]},
}


class FiguresTests(unittest.TestCase):
    def test_both_split_conventions_read_the_same_way(self):
        self.assertEqual(lanewatch.lap_splits(RACE_1["details_json"], 25), [27.9, 30.3])
        self.assertEqual(lanewatch.absolute_splits(RACE_2["details_json"], 25),
                         {25.0: 13.3, 50.0: 28.4, 75.0: 43.8, 100.0: 59.0})
        self.assertEqual(lanewatch.lap_splits(RACE_2["details_json"], 25), [28.4, 30.6])

    def test_stroke_rates_are_read_as_spm_or_cycle_time(self):
        # 1.3s and 1.35s cycles; then a 1.5s cycle (40 spm) beside a typed 48 spm.
        self.assertEqual(lanewatch.length_rates(RACE_1["details_json"]), [45.3, 45.3, 44.0, 44.0])

    def test_a_race_reads_as_one_line(self):
        line = lanewatch.race_line(RACE_1)
        self.assertIn("2026-06-01 100 Freestyle SCM (Final, County Champs) 58.20s", line)
        self.assertIn("15m 6.60s", line)
        self.assertIn("back half slower than front half by +8.6%", line)
        self.assertIn("splits 27.90, 30.30", line)

    def test_patterns_need_two_races_and_a_clear_margin(self):
        findings = lanewatch.race_findings([RACE_1, RACE_2])
        self.assertTrue(any(f.startswith("fades") for f in findings), findings)
        self.assertTrue(any("stroke rate falls away late" in f for f in findings), findings)
        self.assertTrue(any("underwater off the walls is slower" in f for f in findings), findings)
        self.assertEqual(lanewatch.race_findings([RACE_1]), [], "One race is not a pattern.")

    def test_the_key_is_stored_encrypted(self):
        sealed = lanewatch.encrypt_key(KEY)
        self.assertNotIn(KEY, sealed)
        self.assertEqual(lanewatch.decrypt_key(sealed), KEY)
        with patch.dict(os.environ, {"LANEWATCH_KEY_SECRET": "a different secret"}):
            with self.assertRaises(LaneWatchError):
                lanewatch.decrypt_key(sealed)


class ConnectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        lanewatch.clear_cache()
        self.fake = FakeLaneWatch()
        self.patch = patch.object(lanewatch, "_request", self.fake)
        self.patch.start()
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", dob=date(2011, 3, 4), squad="Silver 1", active=True)
            leo = models.Swimmer(name="Leo Park", squad="Silver 1", active=True)
            db.add_all([ruby, leo])
            db.commit()
            self.ruby_id, self.leo_id = ruby.id, leo.id

    def tearDown(self):
        self.patch.stop()
        lanewatch.clear_cache()
        reset_database()

    def _connect(self, db):
        return lanewatch.connect(db, "firebase-id-token")

    def test_connecting_keeps_only_the_encrypted_key(self):
        with SessionLocal() as db:
            conn = self._connect(db)
            self.assertNotEqual(conn.key_encrypted, KEY)
            self.assertEqual((conn.connected_as, conn.key_hint), ("Coach Chris", KEY[-4:]))
            self.assertTrue(lanewatch.status(db)["connected"])
        self.assertNotIn("firebase-id-token", [c[2] for c in self.fake.calls[1:]],
                         "The sign-in token is used once, to get the key, and never again.")

    def test_disconnecting_revokes_the_key_at_lanewatch(self):
        with SessionLocal() as db:
            self._connect(db)
            result = lanewatch.disconnect(db)
            self.assertEqual(result, {"disconnected": True, "revoked_at_lanewatch": True})
            self.assertFalse(lanewatch.status(db)["connected"])

    def test_pairings_are_suggested_never_assumed(self):
        with SessionLocal() as db:
            self._connect(db)
            out = lanewatch.suggest_links(db)
        by_name = {s["swimmer_name"]: s for s in out["suggestions"]}
        self.assertEqual(by_name["Ruby Wheeler"]["confidence"], "name and date of birth")
        self.assertEqual(by_name["Leo Park"]["confidence"], "name only")
        self.assertFalse(by_name["Leo Park"]["shares"])
        self.assertEqual([u["lanewatch_name"] for u in out["unmatched"]], ["Someone Else"])
        self.assertEqual(out["links"], [])

    def test_only_swimmers_on_the_coachs_lanewatch_roster_can_be_paired(self):
        with SessionLocal() as db:
            self._connect(db)
            with self.assertRaises(LaneWatchError):
                lanewatch.save_links(db, [{"swimmer_id": self.ruby_id,
                                           "lanewatch_swimmer_id": "99999999-9999-4999-8999-999999999999"}])
            self.assertEqual(lanewatch.save_links(db, [{"swimmer_id": self.ruby_id,
                                                        "lanewatch_swimmer_id": RUBY_LW}]), 1)

    def test_the_analyst_reads_live_races_and_says_when_it_cannot(self):
        with SessionLocal() as db:
            self._connect(db)
            lanewatch.save_links(db, [{"swimmer_id": self.ruby_id, "lanewatch_swimmer_id": RUBY_LW},
                                      {"swimmer_id": self.leo_id, "lanewatch_swimmer_id": LEO_LW}])
            ruby = db.get(models.Swimmer, self.ruby_id)
            leo = db.get(models.Swimmer, self.leo_id)
            text = lanewatch.analyst_lines(db, ruby)
            leo_text = lanewatch.analyst_lines(db, leo)
            self.assertEqual(db.query(models.SwimTime).count(), 0, "Race data is never copied in.")
        self.assertIn("2 analysed races", text, "A swim with no analysis captured is left out.")
        self.assertIn("PATTERNS: fades", text)
        self.assertIn("not shared", leo_text)

    def test_a_revoked_key_is_reported_not_hidden(self):
        with SessionLocal() as db:
            self._connect(db)
            self.fake.revoked = True
            with self.assertRaises(LaneWatchError):
                lanewatch.roster(db)
            self.assertIn("Connect again", lanewatch.status(db)["last_error"])


if __name__ == "__main__":
    unittest.main()
