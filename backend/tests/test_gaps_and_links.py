"""Gaps and links: coverage in code, predictions with a track record, and the weekly review."""
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
from backend.services import coverage as C, predictions as P, session_builder, weekly_review as WR  # noqa: E402
from backend.services import session_notation as N, workbooks as W  # noqa: E402
from backend.tests import reset_database  # noqa: E402

TODAY = date(2026, 11, 9)   # a Monday


def add_session(db, day, text, squad="Silver 1", audience=None, groups=None):
    s = models.Session(date=day, squad=squad, status="completed", audience=audience)
    db.add(s)
    db.flush()
    b = {"date": day.isoformat(), "slot": "AM", "groups": groups or [],
         "blocks": [{"id": f"b{day}", "name": "Main", "groups": [], "items": N.parse_text(text)}]}
    session_builder.apply_builder(db, s, b)
    return s


class CoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()

    def test_what_a_session_covers(self):
        cov = C.session_coverage({"date": "2026-11-09", "blocks": [{"id": "b", "name": "Main", "groups": [], "items": N.parse_text(
            "400 Free easy\n2x\n  4x50 Back kick @1:00\n8x25 Starts off the blocks [20]\n4x100 PB + 15 IM @1:40")}]})[""]
        self.assertEqual(cov["free"], 400)
        self.assertEqual((cov["back"], cov["kick"]), (400, 400), "rounds multiply")
        self.assertEqual((cov["starts"], cov["race pace"]), (200, 600))
        self.assertEqual(cov["IM"], 400)
        self.assertEqual(cov["high intensity"], 200)

    def test_gaps_found_in_code(self):
        with SessionLocal() as db:
            for w in range(4, 12):     # starts every week, two months ago
                add_session(db, TODAY - timedelta(weeks=w), "8x25 Starts [20]\n400 Free")
            for w in range(0, 4):      # then no starts and no race pace
                add_session(db, TODAY - timedelta(weeks=w) + timedelta(days=1), "1000 Free [14]")
            add_session(db, TODAY - timedelta(days=2), "8x25 Starts [20]", audience={"kind": "camp", "label": "Lanzarote"})
            db.add(models.Meet(name="County", date=TODAY + timedelta(days=12)))
            db.commit()
            gaps = {g["what"]: g for g in C.gaps(db, "Silver 1", TODAY)}
            self.assertIn("starts", gaps, "a camp session is not what the squad did")
            self.assertEqual(gaps["starts"]["text"], "No starts in the last 4 weeks; it was in 8 of the 8 weeks before.")
            self.assertIn("County is on", next(g for g in C.gaps(db, "Silver 1", TODAY) if g["kind"] == "before a meet")["text"])
            self.assertEqual(C.last_done(db, "Silver 1", TODAY)["starts"], TODAY - timedelta(weeks=4))

    def test_a_swimmer_is_measured_by_the_set_they_swam(self):
        with SessionLocal() as db:
            sw = models.Swimmer(name="Ruby", squad="Silver 1", active=True)
            db.add(sw)
            db.flush()
            s = models.Session(date=TODAY - timedelta(days=3), squad="Silver 1", status="completed")
            db.add(s)
            db.flush()
            session_builder.apply_builder(db, s, {"date": s.date.isoformat(), "slot": "AM",
                "groups": [{"id": "g1", "name": "Sprint"}, {"id": "g2", "name": "Distance"}],
                "blocks": [{"id": "a", "name": "A", "groups": ["g1"], "items": N.parse_text("8x25 Starts [20]")},
                           {"id": "b", "name": "B", "groups": ["g2"], "items": N.parse_text("1500 Free [13]")}]})
            db.add(models.SessionEntry(session_id=s.id, swimmer_id=sw.id, attended=True, group_done=2))
            db.commit()
            last = C.swimmer_last_done(db, sw.id, TODAY)
            self.assertIn("free", last)
            self.assertNotIn("starts", last, "she swam the distance set, not the starts")


class PredictionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            sw = models.Swimmer(name="Ruby", squad="Silver 1", active=True)
            meet = models.Meet(name="County", date=TODAY, course="SCM")
            db.add_all([sw, meet])
            db.commit()
            self.sid, self.meet = sw.id, meet.id

    def test_race_predictions_are_checked_against_results(self):
        with SessionLocal() as db:
            p = P.add(db, "analyst", {"kind": "race_time", "statement": "Ruby 200 free under 2:10 at County", "swimmer_id": self.sid,
                                      "distance": 200, "stroke": "free", "course": "SCM", "target": "2:10.00", "meet_id": self.meet})
            self.assertEqual((p.target_seconds, p.stroke, p.due), (130.0, "Freestyle", TODAY))
            self.assertIsNone(P.add(db, "analyst", {"kind": "race_time", "statement": "vague", "swimmer_id": self.sid}),
                              "a race prediction that can't be checked isn't kept")
            miss = P.add(db, "analyst", {"kind": "race_time", "statement": "Ruby 100 fly under 1:05", "swimmer_id": self.sid,
                                         "distance": 100, "stroke": "fly", "target": "1:05", "meet_id": self.meet})
            other = P.add(db, "physiologist", {"statement": "Ruby flat after race pace again", "due": "2026-11-20"})
            # Made the week before the meet: a swim from before a prediction was made never settles it.
            for made in (p, miss):
                made.created_at = datetime(2026, 11, 2, tzinfo=timezone.utc)
            db.add(models.SwimTime(swimmer_id=self.sid, event="200 Freestyle SCM", stroke="Freestyle", distance=200, course="SCM",
                                   time_seconds=129.4, date=TODAY, meet_id=self.meet))
            db.commit()
            self.assertEqual(P.check(db, TODAY), 1)
            self.assertEqual((p.outcome, p.actual), ("right", "swam 2:09.40 (target 2:10.00)"))
            self.assertEqual(P.check(db, TODAY + timedelta(days=8)), 1)
            self.assertEqual(miss.outcome, "no result")
            P.mark(db, other.id, "wrong")
            rec = P.track_record(db)
            self.assertEqual((rec["analyst"]["right"], rec["analyst"]["rate"]), (1, 100))
            self.assertEqual(rec["physiologist"]["rate"], 0)


class WeeklyReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            for d in range(1, 8, 2):
                add_session(db, TODAY - timedelta(days=d), "8x50 Free [14]")
            sw = models.Swimmer(name="Ruby", squad="Silver 1", active=True)
            db.add(sw)
            db.commit()
            self.sid = sw.id

    def test_the_staff_review_the_week_and_the_coach_gets_one_list(self):
        seen = []

        def ask(system, user):
            seen.append((system, user))
            if "Periodisation Planner" in system:
                return {"edits": [{"kind": "section", "path": "watch-list.md", "title": "Watch list", "heading": "Gaps",
                                   "text": "- No starts lately (code)", "confidence": "seen-once", "summary": "Starts"},
                                  {"kind": "section", "path": "../physiologist/x.md", "heading": "x", "text": "no"}],
                        "predictions": [{"statement": "Girls back on starts within two weeks", "due": "2026-11-23"}]}
            return {"edits": [], "predictions": []}

        with SessionLocal() as db:
            out = WR.run(db, TODAY, ask=ask)
            self.assertEqual(out["planner"]["saved"], ["watch-list.md"])
            self.assertEqual(len(out["planner"]["refused"]), 1)
            self.assertEqual(out["planner"]["predictions"], 1)
            self.assertIn("COVERAGE BY WEEK", seen[0][1])
            self.assertIn("4 sessions; free 1600", seen[0][1])
            week = WR.this_week(db, TODAY)
            self.assertEqual([(c["name"], c["path"], c["reviewed"]) for c in week["changes"]], [("Graham", "watch-list.md", False)])
            self.assertEqual(week["predictions"][0]["statement"], "Girls back on starts within two weeks")
            WR.tick(db, "planner", "watch-list.md", today=date.today())
            self.assertTrue(WR.this_week(db, TODAY)["changes"][0]["reviewed"])
            self.assertEqual(W.history(db, "planner", "watch-list.md")[0]["reason"], "reviewed")

    def test_over_the_api(self):
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            self.assertEqual(http.get("/workbooks/review/week", headers=h).status_code, 200)
            self.assertEqual(http.post("/workbooks/review/run", headers=h).status_code, 202)
            with SessionLocal() as db:
                pid = P.add(db, "planner", {"statement": "x", "due": "2026-12-01"}).id
            self.assertEqual(http.post(f"/workbooks/predictions/{pid}", headers=h, json={"outcome": "right"}).json()["outcome"], "right")
            self.assertEqual(http.post(f"/workbooks/predictions/{pid}", headers=h, json={"outcome": "maybe"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
