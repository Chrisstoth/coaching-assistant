"""Writing a session with the staff, live: the Session Writer drafts from the
brief and the plan, the specialists suggest line changes, and nothing changes
until the coach accepts one."""
import json
import os
import unittest
from datetime import date, timedelta
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import claude_service  # noqa: E402
from backend.services import groups as gs  # noqa: E402
from backend.services import session_workshop as ws  # noqa: E402
from backend.tests import reset_database  # noqa: E402

DAY = date(2026, 9, 29)   # a Tuesday
MONDAY = DAY - timedelta(days=DAY.weekday())

DRAFT = {"parsed": {"title": "Threshold Tuesday", "coach_intent": "Aerobic threshold",
                    "energy_focus": "threshold", "warm_up": "400 easy", "cool_down": "200 easy",
                    "groups": {"1": {"label": "Main", "sets": ["8x100 on 1:30 threshold", "4x50 kick"]}}},
         "plan_alignment": "Fits the build week.", "per_swimmer": [], "expected_effects": "Threshold."}


class _Client:
    """Answers as the Session Writer, then as each specialist."""

    def __init__(self):
        self.messages = self
        self.drafts = []
        self.line_ids = {}

    def create(self, **kwargs):
        system = str(kwargs.get("system") or "")
        if "helping write a training session live" in system:
            text = kwargs["messages"][0]["content"]
            main = next(l.split(":")[0].strip() for l in text.splitlines() if "8x100" in l)
            if "Physiologist" in system:
                reply = {"comment": "Leo is carrying load.", "suggestions": [
                    {"line_id": main, "change": "replace", "text": "6x100 on 1:30 threshold",
                     "reason": "Leo has had three hard days."}]}
            elif "Performance Analyst" in system:
                reply = {"comment": "Add pace targets.", "suggestions": [
                    {"line_id": main, "change": "replace", "text": "8x100 on 1:30 at 1:12",
                     "reason": "Holds his 200 pace."},
                    {"line_id": "not-a-line", "change": "replace", "text": "x", "reason": "made up"}]}
            else:
                reply = {"comment": "Fine for the week.", "suggestions": []}
        else:
            self.drafts.append(kwargs["messages"][0]["content"])
            reply = DRAFT
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(reply))],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1))


class SessionWorkshopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            leo = models.Swimmer(name="Leo Park", active=True, status="active")
            db.add(leo)
            db.flush()
            macro = models.TrainingMacro(name="Autumn", date_from=MONDAY - timedelta(weeks=2),
                                         date_to=MONDAY + timedelta(weeks=6))
            db.add(macro)
            db.flush()
            db.add(models.SeasonBlock(macro_id=macro.id, name="Build 1", phase_type="build",
                                      date_from=MONDAY - timedelta(weeks=2), date_to=MONDAY + timedelta(weeks=2),
                                      group_intents={"Seniors": "Threshold volume"}))
            db.add(models.SeasonLoadPoint(macro_id=macro.id, week_start=MONDAY, overall=70))
            group = gs.create_group(db, "Seniors")
            gs.move(db, leo.id, group.id, MONDAY - timedelta(weeks=2))
            db.commit()
            self.leo = leo.id
        self.client = _Client()
        self.patch = mock.patch.object(claude_service, "get_client", return_value=self.client)
        self.patch.start()
        self.energy = mock.patch.object(claude_service, "analyse_session_energy", return_value={})
        self.energy.start()

    def tearDown(self):
        self.patch.stop()
        self.energy.stop()
        reset_database()

    def _workshop(self):
        with SessionLocal() as db:
            row = ws.start(db, brief="Threshold, keep it under 75 minutes", day=DAY, squad=None,
                           pool_slot_id=None, expected=[{"id": self.leo, "name": "Leo Park"}],
                           pool_slot=None, background=False)
            return row.id

    def test_the_draft_is_written_inside_the_plan(self):
        with SessionLocal() as db:
            brief = ws.plan_brief(db, DAY, None, [self.leo])
        self.assertIn("BLOCK: Build 1 (build)", brief)
        self.assertIn("PLANNED LOAD THIS WEEK: 70/100", brief)
        self.assertIn("Leo Park: group Seniors", brief)
        self.assertIn("Seniors: Threshold volume", brief)
        self._workshop()
        self.assertIn("THE PLAN THIS SESSION SITS IN", self.client.drafts[0])

    def test_specialists_suggest_line_changes_and_nothing_changes_yet(self):
        wid = self._workshop()
        with SessionLocal() as db:
            row = db.get(models.SessionWorkshop, wid)
            self.assertEqual(row.status, "ready")
            texts = [l["text"] for s in row.draft["sections"] for l in s["lines"]]
            self.assertIn("8x100 on 1:30 threshold", texts, "The draft is untouched until the coach decides.")
            roles = sorted(s["role"] for s in row.suggestions)
            self.assertEqual(roles, ["analyst", "physiologist"], "A made-up line id is dropped.")
            voices = {v["role"]: v["status"] for v in row.voices}
            self.assertEqual(voices["planner"], "quiet")

    def test_accepting_one_suggestion_supersedes_the_other_on_that_line(self):
        wid = self._workshop()
        with SessionLocal() as db:
            row = db.get(models.SessionWorkshop, wid)
            physio = next(s for s in row.suggestions if s["role"] == "physiologist")
            ws.decide(db, row, physio["id"], accept=True)
            texts = [l["text"] for s in row.draft["sections"] for l in s["lines"]]
            self.assertIn("6x100 on 1:30 threshold", texts)
            analyst = next(s for s in row.suggestions if s["role"] == "analyst")
            self.assertEqual(analyst["status"], "superseded", "Two changes to one line: the coach's call.")
            with self.assertRaises(ws.WorkshopError):
                ws.decide(db, row, physio["id"], accept=True)

    def test_the_finished_session_goes_to_the_planner_as_it_now_stands(self):
        wid = self._workshop()
        with SessionLocal() as db:
            row = db.get(models.SessionWorkshop, wid)
            physio = next(s for s in row.suggestions if s["role"] == "physiologist")
            ws.decide(db, row, physio["id"], accept=True)
            kick = next(l for s in row.draft["sections"] for l in s["lines"] if l["text"] == "4x50 kick")
            ws.edit_line(db, row, kick["id"], "6x50 kick with fins")
            result = ws.finish(db, row)
        self.assertEqual(result["parsed"]["groups"]["1"]["sets"], ["6x100 on 1:30 threshold", "6x50 kick with fins"])
        self.assertEqual(result["parsed"]["warm_up"], "400 easy")
        self.assertIn("accepted these changes", result["messages"][-2]["content"])
        self.assertEqual(result["expected_swimmers"], [{"id": self.leo, "name": "Leo Park"}])

    def test_the_page_starts_polls_and_decides_over_http(self):
        with TestClient(app) as http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            with mock.patch.object(ws.threading, "Thread") as thread:
                started = http.post("/session-workshops", headers=h,
                                    json={"text": "Threshold", "date": DAY.isoformat()})
            self.assertEqual(started.status_code, 201, started.text)
            self.assertEqual(started.json()["status"], "drafting")
            thread.return_value.start.assert_called_once()
            wid = self._workshop()
            state = http.get(f"/session-workshops/{wid}", headers=h).json()
            sid = state["suggestions"][0]["id"]
            decided = http.post(f"/session-workshops/{wid}/suggestions/{sid}", headers=h, json={"accept": False})
            self.assertEqual(decided.json()["suggestions"][0]["status"], "rejected")
            self.assertEqual(http.post(f"/session-workshops/{wid}/suggestions/{sid}", headers=h,
                                       json={"accept": True}).status_code, 409)
            done = http.post(f"/session-workshops/{wid}/finish", headers=h)
            self.assertEqual(done.status_code, 200, done.text)
            self.assertEqual(done.json()["parsed"]["title"], "Threshold Tuesday")


if __name__ == "__main__":
    unittest.main()
