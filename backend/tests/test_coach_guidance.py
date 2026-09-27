"""Talking back to the staff: the coach answers a suggestion, the specialist
revises or withdraws it, and a general point about how the coach works can be
remembered - after which the Session Writer and every specialist follow it."""
import json
import os
import unittest
from datetime import date
from types import SimpleNamespace
from unittest import mock

os.environ["APP_PASSWORD"] = "test-password"
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import claude_service  # noqa: E402
from backend.services import session_workshop as ws  # noqa: E402
from backend.tests import reset_database  # noqa: E402

DAY = date(2026, 9, 29)
DRAFT = {"parsed": {"title": "Aerobic Tuesday", "coach_intent": "Aerobic", "warm_up": "400 easy", "cool_down": None,
                    "groups": {"1": {"label": "Main", "sets": ["8x300 on 4:15 aerobic"]}}},
         "plan_alignment": "", "per_swimmer": [], "expected_effects": ""}
RULE = "Write main sets as varied, mixed structures that keep swimmers engaged - not plain straight repeats."


class _Client:
    def __init__(self, withdraw=False):
        self.messages = self
        self.systems = []
        self.withdraw = withdraw

    def create(self, **kwargs):
        system = str(kwargs.get("system") or "")
        self.systems.append(system + "\n" + kwargs["messages"][0]["content"])
        if "has answered you" in system:
            reply = ({"response": "Fair - dropping it.", "revised": None, "lesson": None} if self.withdraw else
                     {"response": "Same load, your way.",
                      "revised": {"change": "replace", "text": "3 rounds: 300 build / 4x75 fast @1:10 / 100 easy",
                                  "reason": "Keeps Leo's load down in a mixed set."},
                      "lesson": RULE})
        elif "helping write a training session live" in system:
            text = kwargs["messages"][0]["content"]
            line = next(l.split(":")[0].strip() for l in text.splitlines() if "8x300" in l)
            reply = {"comment": "Leo is carrying load.", "suggestions": [
                {"line_id": line, "change": "replace", "text": "6x300 on 4:15", "reason": "Leo: three hard days."}]} \
                if "Physiologist" in system else {"comment": "Fine.", "suggestions": []}
        else:
            reply = DRAFT
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(reply))],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1))


class CoachGuidanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        self.client = _Client()
        self.patches = [mock.patch.object(claude_service, "get_client", side_effect=lambda: self.client),
                        mock.patch.object(claude_service, "analyse_session_energy", return_value={})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        reset_database()

    def _workshop(self):
        with SessionLocal() as db:
            return ws.start(db, brief="Aerobic, engaging", day=DAY, squad=None, pool_slot_id=None,
                            expected=[], pool_slot=None, background=False).id

    def _physio(self, db, wid):
        row = db.get(models.SessionWorkshop, wid)
        return row, next(s for s in row.suggestions if s["role"] == "physiologist")

    def test_a_reply_gets_the_point_back_in_the_coaches_style(self):
        wid = self._workshop()
        with SessionLocal() as db:
            row, s = self._physio(db, wid)
            revised = ws.reply(db, row, s["id"], "That's not how I write sets - I use mixed sets to keep them engaged.")
        self.assertEqual(revised["status"], "pending", "The coach still decides.")
        self.assertEqual(revised["text"], "3 rounds: 300 build / 4x75 fast @1:10 / 100 easy")
        self.assertEqual([t["who"] for t in revised["thread"]], ["coach", "physiologist"])
        self.assertEqual(revised["lesson"], RULE)
        self.assertFalse(revised["lesson_saved"], "Nothing is remembered until the coach says so.")
        with SessionLocal() as db:
            self.assertEqual(db.query(models.CoachGuidance).count(), 0)

    def test_a_reply_can_withdraw_the_suggestion(self):
        self.client.withdraw = True
        wid = self._workshop()
        with SessionLocal() as db:
            row, s = self._physio(db, wid)
            self.assertEqual(ws.reply(db, row, s["id"], "Leo is fine, he rested yesterday.")["status"], "withdrawn")

    def test_a_remembered_rule_reaches_the_writer_and_every_specialist(self):
        wid = self._workshop()
        with SessionLocal() as db:
            row, s = self._physio(db, wid)
            ws.reply(db, row, s["id"], "I use mixed sets to keep them engaged.")
            ws.remember(db, row, s["id"])
            self.assertTrue(next(x for x in row.suggestions if x["id"] == s["id"])["lesson_saved"])
        self.client.systems.clear()
        self._workshop()
        draft_prompt = self.client.systems[0]
        self.assertIn("HOW THIS COACH WORKS", draft_prompt)
        self.assertIn(RULE, draft_prompt)
        reviews = [p for p in self.client.systems if "helping write a training session live" in p]
        self.assertEqual(len(reviews), len(ws.REVIEWERS))
        self.assertTrue(all(RULE in p for p in reviews), "Every specialist reads the coach's rules.")

    def test_rules_are_managed_over_http(self):
        with TestClient(app) as http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            made = http.post("/coach-guidance", headers=h, json={"text": "Always include a skills set."})
            self.assertEqual(made.status_code, 201)
            rid = made.json()["id"]
            self.assertEqual(http.patch(f"/coach-guidance/{rid}", headers=h, json={"active": False}).json()["active"], False)
            with SessionLocal() as db:
                from backend.services.coach_guidance import prompt_block
                self.assertNotIn("skills set", prompt_block(db), "A rule switched off is not followed.")
            self.assertEqual(len(http.get("/coach-guidance", headers=h).json()), 1)
            self.assertEqual(http.delete(f"/coach-guidance/{rid}", headers=h).status_code, 204)
            wid = self._workshop()
            with SessionLocal() as db:
                sid = self._physio(db, wid)[1]["id"]
            r = http.post(f"/session-workshops/{wid}/suggestions/{sid}/reply", headers=h, json={"text": "Mixed sets please"})
            self.assertEqual(r.status_code, 200, r.text)
            r = http.post(f"/session-workshops/{wid}/suggestions/{sid}/remember", headers=h,
                          json={"text": "Mixed, varied main sets - never plain repeats."})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(http.get("/coach-guidance", headers=h).json()[0]["text"],
                             "Mixed, varied main sets - never plain repeats.", "The coach can edit the rule first.")


if __name__ == "__main__":
    unittest.main()
