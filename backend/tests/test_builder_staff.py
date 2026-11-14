"""The staff in the Session Builder: comments pinned to lines, the coach's answers, Jess drafting."""
import os
import unittest
from datetime import date
from unittest import mock

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import builder_staff as BS  # noqa: E402
from backend.services import session_builder, workbooks as W  # noqa: E402
from backend.tests import reset_database  # noqa: E402

DAY = date(2026, 11, 9)
SESSION = {"date": DAY.isoformat(), "slot": "AM", "effSys": "effort20",
           "groups": [{"id": "g1", "name": "Girls", "swimmer_ids": []}, {"id": "g2", "name": "Boys", "swimmer_ids": []}],
           "blocks": [{"id": "b1", "name": "Warm up", "groups": [], "items": [
                          {"id": "L1", "t": "line", "reps": None, "dist": 400, "desc": "Easy", "int": None, "int2": None, "rest": None, "est": None, "eff": "10"}]},
                      {"id": "b2", "name": "Main", "groups": ["g1"], "items": [
                          {"id": "R1", "t": "round", "times": 3, "note": "", "items": [
                              {"id": "L2", "t": "line", "reps": 4, "dist": 100, "desc": "Race pace", "int": 100, "int2": None, "rest": None, "est": None, "eff": "19"}]}]}]}


class BuilderStaffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            s = models.Session(date=DAY, squad="Silver 1", status="active")
            db.add(s)
            db.flush()
            session_builder.apply_builder(db, s, SESSION)
            self.sid = s.id

    def fake(self, system, user, operation, max_tokens=700):
        self.seen.append(user)
        self.prompts = getattr(self, "prompts", {})
        self.prompts[system.split(",")[0].replace("You are ", "")] = system
        if "Physiologist" in system:
            return {"comments": [{"line_id": "L2", "flag": "safety", "message": "Third race-pace day in a row for the girls."},
                                 {"line_id": "nope", "flag": "preference", "message": "General point."}]}
        if "Swimmer Manager" in system:
            return {"comments": [{"line_id": "L1", "flag": "preference", "message": "Make the warm up mixed strokes."}]}
        return {"comments": []}

    def test_the_session_as_the_staff_read_it(self):
        lines = BS.line_index(SESSION)
        self.assertEqual([(l["id"], l["block"], l["groups"]) for l in lines],
                         [("L1", "Warm up", ["everyone"]), ("R1", "Main", ["Girls"]), ("L2", "Main", ["Girls"])])
        self.assertEqual(lines[2]["text"], "  4x100 Race pace @1:40 [19]")

    def test_comments_are_pinned_and_a_new_read_replaces_undecided_ones(self):
        self.seen = []
        with SessionLocal() as db:
            s = db.get(models.Session, self.sid)
            out = BS.review(db, s, s.builder, ask=self.fake)
            self.assertEqual(len(self.seen), 4, "physiologist, analyst, planner, swimmer manager")
            self.assertIn("[L2] (Main, Girls)   4x100 Race pace @1:40 [19]", self.seen[0])
            by = {(c["name"], c["line_id"]): c for c in out}
            self.assertEqual(by[("Fiona", "L2")]["flag"], "safety")
            self.assertIn(("Fiona", None), by, "a comment on an unknown line stays, unpinned")
            self.assertEqual(by[("Erin", "L1")]["flag"], "preference")
            BS.decide(db, by[("Fiona", "L2")]["id"], "accept", useful=True)
            again = BS.review(db, s, s.builder, ask=self.fake)
            self.assertEqual(sum(1 for c in again if c["name"] == "Fiona" and c["line_id"] == "L2"), 1,
                             "the decided one stays, and the same flag again is not raised a second time")
            self.assertEqual(len(again), 1 + 2, "one decided, plus the two new ones from the new read")
            self.assertIn("WHAT YOU HAVE ALREADY SAID ON THIS SESSION", self.prompts["Fiona"])
            self.assertIn("Third race-pace day in a row", self.prompts["Fiona"])

    def test_a_dismissed_point_does_not_come_back_in_other_words(self):
        replies = {"Swimmer Manager": [{"line_id": "L1", "flag": "preference", "message": "Make the warm up mixed strokes."}]}

        def ask(system, user, operation, max_tokens=700):
            return {"comments": next((v for k, v in replies.items() if k in system), [])}
        with SessionLocal() as db:
            s = db.get(models.Session, self.sid)
            first = [c for c in BS.review(db, s, s.builder, ask=ask) if c["name"] == "Erin"]
            BS.decide(db, first[0]["id"], "dismiss")       # no reason given: still remembered on this session
            replies["Swimmer Manager"] = [
                {"line_id": "L1", "flag": "preference", "message": "Could the warm up have some backstroke in it?"},
                {"line_id": "L2", "flag": "preference", "message": "Amira is back from a cold; she could swim lane 2 on the race pace."}]
            again = [c for c in BS.review(db, s, s.builder, ask=ask) if c["status"] == "open"]
            self.assertEqual([c["line_id"] for c in again], ["L2"], "the same line is held back; a new point elsewhere comes through")
            replies["Swimmer Manager"] = [{"line_id": None, "flag": "preference", "message": "Warm up strokes should be mixed, not all free."}]
            self.assertEqual([c for c in BS.review(db, s, s.builder, ask=ask) if c["status"] == "open"], [],
                             "the same point in other words, not pinned to a line, is held back too")

    def test_repeats(self):
        said = [{"role": "manager", "flag": "preference", "message": "Make the warm up mixed strokes.", "line_id": "L1", "block": "Warm up"}]
        new = lambda **k: {"role": "manager", "flag": "preference", "message": "x", "line_id": "L9", "block": "Main", **k}
        self.assertTrue(BS._repeats(new(line_id="L1", message="Something else entirely"), said))
        self.assertTrue(BS._repeats(new(block="Warm up", message="Mixed strokes in the warm up please"), said))
        self.assertFalse(BS._repeats(new(message="The kick set is long for Ben"), said))
        self.assertFalse(BS._repeats(new(role="analyst", line_id="L1"), said), "another worker may say their own thing")
        safety = [{**said[0], "flag": "safety", "message": "Third race-pace day in a row for the girls."}]
        self.assertTrue(BS._repeats(new(flag="safety", line_id="L1", message="Third race-pace day in a row for the girls"), safety))
        self.assertFalse(BS._repeats(new(flag="safety", line_id="L1", message="Josh's shoulder: no paddles"), safety),
                         "a different safety flag always comes through")

    def test_a_dismissed_preference_teaches_the_worker_but_safety_stays(self):
        self.seen = []
        with SessionLocal() as db:
            s = db.get(models.Session, self.sid)
            out = {c["name"]: c for c in BS.review(db, s, s.builder, ask=self.fake) if c["line_id"]}
            BS.decide(db, out["Erin"]["id"], "dismiss", reason="I keep warm ups freestyle in the mornings")
            prefs = W.read_page(db, "manager", BS.PREFS_PAGE)
            self.assertIn("I keep warm ups freestyle in the mornings", prefs)
            self.assertIn("I keep warm ups freestyle", BS._not_to_flag(db, "manager"))
            BS.decide(db, out["Fiona"]["id"], "dismiss", reason="They're fine")
            self.assertIsNone(W.get_page(db, "physiologist", BS.PREFS_PAGE), "a safety flag is never switched off")
            self.assertEqual(BS.decide(db, out["Fiona"]["id"], "useful", useful=False)["useful"], False)

    def test_jess_drafts_into_the_builder(self):
        def ask(system, user, operation, max_tokens=700):
            self.assertIn("THE SESSION'S GROUPS: Girls, Boys", system)
            self.assertIn("Kick focus", user)
            return {"title": "Kick", "aims": ["Underwater kick"], "note_for_coach": "Fits the aerobic week.",
                    "blocks": [{"name": "Warm up", "groups": [], "text": "400 Easy [10]"},
                               {"name": "Main", "groups": ["Girls"], "text": "3x\n  4x50 Kick @1:00 [16]\nlots of 25s fast"}]}
        with SessionLocal() as db:
            s = db.get(models.Session, self.sid)
            d = BS.draft(db, s, s.builder, "Kick focus", ask=ask)
            self.assertEqual([b["name"] for b in d["blocks"]], ["Warm up", "Main"])
            self.assertEqual(d["blocks"][1]["groups"], ["g1"])
            self.assertEqual(d["blocks"][1]["items"][0]["t"], "round")
            self.assertEqual(d["flagged"], ["lots of 25s fast"], "a line with a number that reads as words is flagged for a look")
            self.assertEqual((d["title"], d["note"]), ("Kick", "Fits the aerobic week."))

    def test_over_the_api(self):
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            self.seen = []
            with mock.patch.object(BS, "_ask", self.fake):
                r = http.post(f"/session-builder/sessions/{self.sid}/review", headers=h, json={"session": SESSION})
            self.assertEqual(r.status_code, 200, r.text)
            cid = r.json()["comments"][0]["id"]
            self.assertEqual(http.post(f"/session-builder/comments/{cid}", headers=h, json={"action": "accept"}).json()["status"], "resolved")
            self.assertEqual(len(http.get(f"/session-builder/sessions/{self.sid}/comments", headers=h).json()["comments"]), 3)
            self.assertEqual(http.post(f"/session-builder/sessions/{self.sid}/draft", headers=h, json={"session": SESSION, "brief": " "}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
