"""The athlete plan: staff draft from real facts, the coach edits and finalises,
and a final plan cannot change underneath what was shared."""
import os
import threading
import unittest
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import swimmer_plan  # noqa: E402
from backend.tests import reset_database  # noqa: E402

TODAY = date.today()


class FakeWriter:
    """Answers every section, recording what each drafter was told."""

    def __init__(self, fail=()):
        self.prompts = {}
        self.fail = set(fail)
        self.lock = threading.Lock()
        self.messages = self

    def create(self, **kwargs):
        op = kwargs["operation"]
        with self.lock:
            self.prompts[op] = (kwargs["system"], kwargs["messages"][0]["content"])
        if op in self.fail:
            raise RuntimeError("model down")
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=f"Draft for {op}.")],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1))


class SwimmerPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", active=True, status="active", gender="F",
                                  dob=date(2009, 3, 4), para_class="S9 / SB8 / SM9", para_class_status="confirmed",
                                  considerations="Fatigues quickly in warm pools.",
                                  target_events=[{"event": "100 Freestyle", "course": "LCM"}])
            db.add(ruby)
            db.flush()
            county = models.Meet(name="County Champs", date=TODAY + timedelta(days=40), level="county")
            nationals = models.Meet(name="Para Nationals", date=TODAY + timedelta(days=120), level="national")
            gala = models.Meet(name="Club Open", date=TODAY + timedelta(days=20))
            db.add_all([county, nationals, gala])
            db.flush()
            db.add(models.MeetEntry(meet_id=county.id, swimmer_id=ruby.id, event_name="100 Freestyle",
                                    canonical_event="100 freestyle"))
            db.add(models.MeetTarget(meet_id=nationals.id, swimmer_id=ruby.id, events=["100 Freestyle"],
                                     priority="A", target_times={"100 Freestyle": "1:02.50"}))
            db.add(models.SwimTime(swimmer_id=ruby.id, event="100 Freestyle LCM", time_seconds=64.21,
                                   date=TODAY - timedelta(days=30), meet="Summer Open"))
            db.add(models.SwimmerTarget(swimmer_id=ruby.id, label="100 Free under 1:03",
                                        target_time_seconds=62.9, deadline=TODAY + timedelta(days=120)))
            macro = models.TrainingMacro(name="Road to Nationals", date_from=TODAY - timedelta(days=7),
                                         date_to=TODAY + timedelta(days=130), primary_meet_id=nationals.id,
                                         group_definitions={"G1": {"description": "Para group", "swimmer_ids": [ruby.id]}})
            db.add(macro)
            db.flush()
            db.add(models.SeasonBlock(macro_id=macro.id, name="Aerobic base", phase_type="base",
                                      date_from=TODAY - timedelta(days=7), date_to=TODAY + timedelta(days=42),
                                      group_intents={"G1": "Build aerobic capacity with longer rest"}))
            db.commit()
            self.ruby_id, self.club_open = ruby.id, gala.id

    def tearDown(self):
        reset_database()

    def _facts(self, fn):
        with SessionLocal() as db:
            ruby = db.get(models.Swimmer, self.ruby_id)
            start, end = swimmer_plan.default_period(db)
            return fn(db, ruby, start, end)

    def test_the_facts_come_from_the_swimmers_own_records(self):
        athlete = self._facts(swimmer_plan.facts_athlete)
        self.assertIn("Para sport classes: S9 / SB8 / SM9 (confirmed)", athlete)
        self.assertIn("Fatigues quickly in warm pools.", athlete)
        self.assertIn("Training group: G1 (Para group)", athlete)
        towards = self._facts(swimmer_plan.facts_towards)
        self.assertIn("100 Free under 1:03: 1:02.90", towards)
        self.assertIn("Para Nationals (priority A): 100 Freestyle | target times 100 Freestyle 1:02.50", towards)
        self.assertIn("100 Freestyle LCM: PB 1:04.21", towards)
        comps = self._facts(swimmer_plan.facts_competitions)
        self.assertIn("County Champs (county): entered: 100 Freestyle", comps)
        self.assertNotIn("Club Open", comps, "A gala nobody assigned them to is not part of their plan.")
        how = self._facts(swimmer_plan.facts_how)
        self.assertIn("building to Para Nationals", how)
        self.assertIn("for G1: Build aerobic capacity with longer rest", how)

    def test_each_section_is_drafted_by_its_owner_and_the_coach_section_is_left_blank(self):
        writer = FakeWriter()
        with patch.object(swimmer_plan, "get_client", return_value=writer):
            with SessionLocal() as db:
                plan = swimmer_plan.create_plan(db, db.get(models.Swimmer, self.ruby_id))
                out = swimmer_plan.plan_out(plan)
        by_key = {s["key"]: s for s in out["sections"]}
        self.assertEqual(by_key["towards"]["content"], "Draft for swimmer_plan_towards.")
        self.assertEqual(by_key["towards"]["drafted_by"], "Performance Analyst")
        self.assertEqual(by_key["training_focus"]["drafted_by"], "Physiologist")
        self.assertEqual(by_key["coach_note"]["content"], "")
        self.assertEqual(by_key["coach_note"]["drafted_by"], "You")
        system, user = writer.prompts["swimmer_plan_towards"]
        self.assertIn("British Swimming", system, "The default reader is performance staff.")
        self.assertIn("[to add:", system, "Gaps are marked, never invented.")
        self.assertIn("Para Nationals", user)

    def test_a_failed_draft_leaves_a_gap_for_the_coach(self):
        with patch.object(swimmer_plan, "get_client", return_value=FakeWriter(fail={"swimmer_plan_how"})):
            with SessionLocal() as db:
                plan = swimmer_plan.create_plan(db, db.get(models.Swimmer, self.ruby_id))
                how = next(s for s in plan.sections if s["key"] == "how")
        self.assertTrue(how["content"].startswith("[to add:"))

    def test_the_coachs_edits_survive_a_redraft_of_everything_else(self):
        with patch.object(swimmer_plan, "get_client", return_value=FakeWriter()):
            with SessionLocal() as db:
                plan = swimmer_plan.create_plan(db, db.get(models.Swimmer, self.ruby_id))
                swimmer_plan.update_sections(plan, [{"key": "towards", "content": "My own words."},
                                                    {"key": "review", "included": False}])
                swimmer_plan.draft_all(db, plan)
                by_key = {s["key"]: s for s in plan.sections}
        self.assertEqual(by_key["towards"]["content"], "My own words.")
        self.assertTrue(by_key["towards"]["edited"])
        self.assertFalse(by_key["review"]["included"])

    def test_a_final_plan_cannot_change_and_a_new_version_starts_from_it(self):
        with TestClient(app) as http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            with patch.object(swimmer_plan, "get_client", return_value=FakeWriter()):
                plan = http.post("/swimmer-plans", json={"swimmer_id": self.ruby_id, "audience": "swimmer"},
                                 headers=h).json()
            self.assertEqual(plan["audience"], "swimmer")
            self.assertEqual(plan["status"], "draft")
            edited = http.patch(f"/swimmer-plans/{plan['id']}", json={"sections": [
                {"key": "coach_note", "content": "Proud of the work this block."}]}, headers=h).json()
            self.assertEqual(next(s for s in edited["sections"] if s["key"] == "coach_note")["content"],
                             "Proud of the work this block.")
            final = http.post(f"/swimmer-plans/{plan['id']}/finalise", headers=h).json()
            self.assertEqual(final["status"], "final")
            self.assertEqual(http.patch(f"/swimmer-plans/{plan['id']}", json={"title": "x"}, headers=h).status_code, 409)
            self.assertEqual(http.delete(f"/swimmer-plans/{plan['id']}", headers=h).status_code, 409)
            copy = http.post(f"/swimmer-plans/{plan['id']}/copy", headers=h).json()
            self.assertEqual(copy["status"], "draft")
            self.assertEqual(next(s for s in copy["sections"] if s["key"] == "coach_note")["content"],
                             "Proud of the work this block.")
            listed = http.get(f"/swimmer-plans?swimmer_id={self.ruby_id}", headers=h).json()
            self.assertEqual([p["status"] for p in listed], ["draft", "final"])
            self.assertNotIn("sections", listed[0])

    def test_the_coach_writes_their_own_section(self):
        with SessionLocal() as db:
            plan = swimmer_plan.create_plan(db, db.get(models.Swimmer, self.ruby_id), draft=False)
            with self.assertRaises(ValueError):
                swimmer_plan.redraft_section(db, plan, "coach_note")

    def test_removing_a_swimmer_removes_their_plans(self):
        with SessionLocal() as db:
            swimmer_plan.create_plan(db, db.get(models.Swimmer, self.ruby_id), draft=False)
        with TestClient(app) as http:
            token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
            response = http.delete(f"/swimmers/{self.ruby_id}", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 204)
        with SessionLocal() as db:
            self.assertEqual(db.query(models.SwimmerPlan).count(), 0)


if __name__ == "__main__":
    unittest.main()
