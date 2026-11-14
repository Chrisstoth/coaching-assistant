"""Target sets: 100 PB ÷ 4 for each 25, then +0.5 and +1.0.

Mia has a 100 back on her profile and a short-course 100 back PB of 1:07.20,
which swimrankings stored with the split length (50) in the distance column.
Her 25 back targets are 16.8, 17.3 and 17.8. Her 100 free has no time yet, so
it is listed as missing rather than guessed. A long-course time is ignored by
a short-course set.
"""
import os
import unittest
from datetime import date

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import target_times as tt  # noqa: E402
from backend.tests import reset_database  # noqa: E402


def _time(swimmer_id, event, stroke, course, distance, seconds, day=1):
    return models.SwimTime(swimmer_id=swimmer_id, event=event, stroke=stroke, course=course,
                           distance=distance, time_seconds=seconds, date=date(2026, 5, day), meet="County")


class TargetSetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            mia = models.Swimmer(name="Mia Cole", active=True, squad="Silver 1", target_events=[
                {"event": "100 Backstroke", "course": "SCM"},
                {"event": "200 Backstroke", "course": "SCM"},
                {"event": "100 Free", "course": "Both"},
            ])
            sam = models.Swimmer(name="Sam Ode", active=True, squad="Silver 1", target_events=[])
            other = models.Swimmer(name="Ana Lee", active=True, squad="Performance",
                                   target_events=[{"event": "100 Breaststroke"}])
            db.add_all([mia, sam, other])
            db.flush()
            db.add_all([
                _time(mia.id, "100 Backstroke SCM", "Backstroke", "SCM", 100, 68.40, 1),
                # A 100 that swimrankings stored with the 50 split length.
                _time(mia.id, "50 100 Backstroke S", "100 Backstroke", "S", 50, 67.20, 2),
                _time(mia.id, "50 50 Backstroke S", "50 Backstroke", "S", 50, 31.00, 3),
                _time(mia.id, "100 Backstroke LCM", "Backstroke", "LCM", 100, 65.00, 4),
                _time(mia.id, "100 200 Backstroke S", "200 Backstroke", "S", 100, 150.00, 5),
                _time(other.id, "100 Breaststroke SCM", "Breaststroke", "SCM", 100, 80.00, 1),
            ])
            db.commit()
            self.ids = {"mia": mia.id, "sam": sam.id, "other": other.id}

    def tearDown(self):
        reset_database()

    def _http(self):
        http = TestClient(app)
        http.__enter__()
        self.addCleanup(http.__exit__, None, None, None)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def test_the_coaches_recipe_for_the_squad(self):
        http, h = self._http()
        r = http.post("/target-sets", headers=h, json={
            "squad": "Silver 1", "base_distance": 100, "rep_distance": 25, "offsets": [0, 0.5, 1.0],
        })
        self.assertEqual(r.status_code, 201, r.text)
        made = r.json()
        self.assertEqual(made["name"], "100 PB pace for 25s")
        self.assertEqual(made["summary"], "100 PB ÷ 4 for each 25, then +0.5 and +1.0 (short course PBs)")
        self.assertEqual([c["label"] for c in made["columns"]], ["PB pace", "+0.5", "+1.0"])

        table = http.get(f"/target-sets/{made['id']}/table", headers=h).json()
        self.assertEqual([s["name"] for s in table["swimmers"]], ["Mia Cole", "Sam Ode"])
        mia = table["swimmers"][0]
        self.assertEqual([row["event"] for row in mia["rows"]], ["100 Backstroke", "100 Freestyle"])
        back = mia["rows"][0]
        self.assertEqual(back["pb"]["display"], "1:07.20")
        self.assertEqual([t["display"] for t in back["times"]], ["16.8", "17.3", "17.8"])
        self.assertEqual(mia["rows"][1]["missing"], "No 100 Freestyle SCM time yet")
        self.assertEqual(table["swimmers"][1]["note"], "No target events on their profile yet")

        # Every squad, on the fly.
        everyone = http.get(f"/target-sets/{made['id']}/table", headers=h, params={"squad": ""}).json()
        self.assertIn("Ana Lee", [s["name"] for s in everyone["swimmers"]])

        # On Mia's own page.
        mine = http.get(f"/target-sets/swimmer/{self.ids['mia']}", headers=h).json()
        self.assertEqual(len(mine), 1)
        self.assertEqual([t["seconds"] for t in mine[0]["rows"][0]["times"]], [16.8, 17.3, 17.8])
        self.assertEqual(http.get(f"/target-sets/swimmer/{self.ids['other']}", headers=h).json(), [])

    def test_fixed_strokes_long_course_and_own_event_distance(self):
        http, h = self._http()
        r = http.post("/target-sets/preview", headers=h, json={
            "squad": "Silver 1", "base_distance": 100, "rep_distance": 50, "offsets": [1],
            "course": "LCM", "strokes": ["Backstroke"], "decimals": 2,
        }).json()
        mia = r["swimmers"][0]
        self.assertEqual([t["display"] for t in mia["rows"][0]["times"]], ["33.50"])
        self.assertEqual(r["set"]["summary"], "100 PB ÷ 2 for each 50: +1.0 (long course PBs)")

        own = http.post("/target-sets/preview", headers=h, json={
            "squad": "Silver 1", "base_distance": None, "rep_distance": 50, "offsets": [0],
            "strokes": ["Backstroke"],
        }).json()
        rows = own["swimmers"][0]["rows"]
        self.assertEqual([row["event"] for row in rows], ["100 Backstroke", "200 Backstroke"])
        self.assertEqual(rows[1]["times"][0]["display"], "37.5")

    def test_a_session_carries_its_target_sets_into_the_analysis(self):
        http, h = self._http()
        made = http.post("/target-sets", headers=h, json={"squad": "Silver 1", "name": "Back 25s",
                                                          "strokes": ["Backstroke"]}).json()
        # The session was on 2 May: the 1:07.20 swum that day counts, but not
        # the 1:05.00 LCM swim or anything later. On 1 May only the 1:08.40 existed.
        with SessionLocal() as db:
            on_day = models.Session(date=date(2026, 5, 2), squad="Silver 1", title="Speed")
            before = models.Session(date=date(2026, 5, 1), squad="Silver 1", title="Earlier")
            db.add_all([on_day, before])
            db.flush()
            db.add(models.SessionEntry(session_id=on_day.id, swimmer_id=self.ids["mia"], attended=True))
            db.commit()
            day_id, before_id = on_day.id, before.id

        r = http.put(f"/target-sets/session/{day_id}", headers=h, json={"targets": [
            {"target_set_id": made["id"], "note": "Main set 16 x 25"}]})
        self.assertEqual(r.status_code, 200, r.text)
        view = r.json()
        self.assertEqual(view["swimmers_from"], "register")
        self.assertEqual([s["name"] for s in view["targets"][0]["swimmers"]], ["Mia Cole"])
        self.assertEqual([t["display"] for t in view["targets"][0]["swimmers"][0]["rows"][0]["times"]],
                         ["16.8", "17.3", "17.8"])

        self.assertEqual(http.post(f"/target-sets/{made['id']}/sessions/{before_id}", headers=h,
                                   json={"note": "Warm-up 4 x 25"}).status_code, 201)
        earlier = http.get(f"/target-sets/session/{before_id}", headers=h).json()
        self.assertEqual(earlier["swimmers_from"], "squad")
        mia = next(s for s in earlier["targets"][0]["swimmers"] if s["name"] == "Mia Cole")
        self.assertEqual(mia["rows"][0]["pb"]["display"], "1:08.40")

        used = http.get(f"/target-sets/{made['id']}/sessions", headers=h).json()["used"]
        self.assertEqual([(u["title"], u["note"]) for u in used], [("Speed", "Main set 16 x 25"), ("Earlier", "Warm-up 4 x 25")])

        with SessionLocal() as db:
            session = db.get(models.Session, day_id)
            text = tt.session_context_text(session, db)
            from backend.services import claude_service
            debrief = models.SessionDebrief(session_id=day_id, date=session.date)
            debrief_text = claude_service.build_session_debrief_context(debrief, db)
            lines = tt.swimmer_target_lines(session, db, [self.ids["mia"]])
        self.assertIn('"Back 25s"', text)
        self.assertIn("Used for: Main set 16 x 25", text)
        self.assertIn("Mia Cole: 100 Back (PB 1:07.20) 16.8 / 17.3 / 17.8", text)
        self.assertIn("targets, not results", text)
        self.assertIn("TARGET TIMES SET FOR THIS SESSION", debrief_text)
        self.assertEqual(lines[self.ids["mia"]], ["Back 25s (Main set 16 x 25): 100 Back (PB 1:07.20) 16.8 / 17.3 / 17.8"])

        # Removing it from a session, and deleting the set, leave nothing behind.
        http.delete(f"/target-sets/{made['id']}/sessions/{before_id}", headers=h)
        self.assertEqual(http.get(f"/target-sets/session/{before_id}", headers=h).json()["targets"], [])
        self.assertEqual(http.delete(f"/target-sets/{made['id']}", headers=h).status_code, 204)
        with SessionLocal() as db:
            self.assertIsNone(db.get(models.Session, day_id).targets)
        self.assertEqual(http.put(f"/target-sets/session/{day_id}", headers=h, json={"targets": [
            {"target_set_id": 999}]}).status_code, 422)

    def test_bad_input_is_refused(self):
        http, h = self._http()
        self.assertEqual(http.post("/target-sets", headers=h, json={"offsets": []}).status_code, 422)
        self.assertEqual(http.post("/target-sets", headers=h, json={"course": "yards"}).status_code, 422)
        self.assertEqual(http.post("/target-sets", headers=h, json={"strokes": ["Doggy"]}).status_code, 422)

    def test_rounding_and_formatting(self):
        self.assertEqual(tt.round_time(64.33 / 4, 1), 16.1)
        self.assertEqual(tt.round_time(64.33 / 4, 2), 16.08)
        self.assertEqual(tt.round_time(16.25, 1), 16.3)
        self.assertEqual(tt.format_time(75.0, 1), "1:15.0")
        self.assertEqual(tt.format_time(59.96, 1), "1:00.0")
        self.assertEqual(tt.format_time(9.5, 1), "9.5")
        self.assertEqual(tt.parse_event("200 IM"), (200, "Individual Medley"))
        self.assertEqual(tt.parse_event("4x50 Free Relay"), (None, None))


if __name__ == "__main__":
    unittest.main()
