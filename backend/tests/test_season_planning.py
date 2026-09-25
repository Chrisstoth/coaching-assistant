"""The top-down season flow: divide the year into macrocycles, then plan one.

The model calls are faked; what is checked is the code around them - how the
scope reaches the prompt, how a proposal is made safe to save, and what the
timeline shows for a macrocycle nobody has planned yet.
"""
import json
import os
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.routers import skills  # noqa: E402
from backend.routers.season import get_timeline  # noqa: E402
from backend.tests import reset_database  # noqa: E402


def _reply(text: str):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=5, output_tokens=5),
    )


class _FakeClient:
    """Stands in for get_client(); records what the skill sent."""

    def __init__(self, text):
        self.text = text
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _reply(self.text)


class PhaseWindowTests(unittest.TestCase):
    def test_phases_outside_the_macro_are_dropped_and_straddlers_clamped(self):
        phases = [
            {"name": "before", "date_from": "2026-07-01", "date_to": "2026-08-15"},
            {"name": "straddle-start", "date_from": "2026-08-20", "date_to": "2026-09-14"},
            {"name": "inside", "date_from": "2026-09-15", "date_to": "2026-10-12"},
            {"name": "straddle-end", "date_from": "2026-10-13", "date_to": "2026-12-20"},
            {"name": "after", "date_from": "2027-01-01", "date_to": "2027-02-01"},
        ]
        kept = skills._clamp_phases_to_window(phases, date(2026, 9, 1), date(2026, 11, 30))
        self.assertEqual([p["name"] for p in kept], ["straddle-start", "inside", "straddle-end"])
        self.assertEqual(kept[0]["date_from"], "2026-09-01")
        self.assertEqual(kept[-1]["date_to"], "2026-11-30")

    def test_unreadable_or_reversed_phases_are_discarded(self):
        kept = skills._clamp_phases_to_window(
            [{"date_from": "soon", "date_to": "2026-10-01"},
             {"date_from": "2026-10-10", "date_to": "2026-10-01"},
             {"date_from": None, "date_to": None}],
            date(2026, 9, 1), date(2026, 11, 30),
        )
        self.assertEqual(kept, [])


class NormaliseSeasonMacrosTests(unittest.TestCase):
    def test_macros_are_ordered_trimmed_and_stripped_of_unknown_meets(self):
        macros, warnings = skills.normalise_season_macros(
            [{"name": "B", "date_from": "2026-11-25", "date_to": "2027-03-01", "primary_meet_id": 99},
             {"name": "A", "date_from": "2026-09-01", "date_to": "2026-11-30", "primary_meet_id": 3},
             {"name": "bad", "date_from": "nope", "date_to": "2027-01-01"}],
            {3}, [],
        )
        self.assertEqual([m["name"] for m in macros], ["A", "B"])
        self.assertEqual(macros[1]["date_from"], "2026-12-01",
                         "Two macrocycles must not claim the same week.")
        self.assertEqual(macros[0]["primary_meet_id"], 3)
        self.assertIsNone(macros[1]["primary_meet_id"], "A meet the model invented must not survive.")
        self.assertEqual(warnings, [])

    def test_a_macro_landing_on_an_existing_one_is_flagged_not_hidden(self):
        macros, warnings = skills.normalise_season_macros(
            [{"name": "A", "date_from": "2026-09-01", "date_to": "2026-11-30"}],
            set(), [("Old", date(2026, 8, 1), date(2026, 9, 15))],
        )
        self.assertEqual(len(macros), 1)
        self.assertEqual(len(warnings), 1)
        self.assertIn("Old", warnings[0])

    def test_a_macro_swallowed_by_its_predecessor_is_dropped(self):
        macros, _ = skills.normalise_season_macros(
            [{"name": "A", "date_from": "2026-09-01", "date_to": "2026-12-31"},
             {"name": "inside", "date_from": "2026-10-01", "date_to": "2026-11-01"}],
            set(), [],
        )
        self.assertEqual([m["name"] for m in macros], ["A"])


class PlanningSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def tearDown(self):
        reset_database()

    def _macro(self, db, name="Autumn", start=date(2026, 9, 1), end=date(2026, 11, 30)):
        macro = models.TrainingMacro(name=name, squad="Silver 1", date_from=start, date_to=end)
        db.add(macro)
        db.commit()
        return macro

    def test_planning_one_macro_tells_the_model_its_scope_and_pins_the_result(self):
        proposal = {
            "name": "Something the model made up",
            "date_from": "2026-01-01", "date_to": "2027-12-31",
            "phases": [
                {"name": "Base", "phase_type": "base", "date_from": "2026-08-01", "date_to": "2026-10-11"},
                {"name": "Taper", "phase_type": "taper", "date_from": "2026-11-16", "date_to": "2026-12-20"},
            ],
        }
        client = _FakeClient(json.dumps(proposal))
        with SessionLocal() as db:
            macro = self._macro(db)
            with patch.object(skills, "get_client", return_value=client):
                result = skills.run_plan_macro("Plan this macro.", db, macro_id=macro.id)
            macro_id = macro.id

        prompt = client.calls[0]["messages"][0]["content"]
        self.assertIn("PLAN ONE MACROCYCLE ONLY", prompt)
        self.assertIn(f"id {macro_id}", prompt)
        self.assertIn("2026-09-01", prompt)

        draft = result["draft"]
        self.assertEqual(draft["macro_id"], macro_id,
                         "Approving must add blocks to this macro, not create another.")
        self.assertEqual(draft["name"], "Autumn", "The model may not rename or re-date the macro.")
        self.assertEqual((draft["date_from"], draft["date_to"]), ("2026-09-01", "2026-11-30"))
        self.assertEqual(draft["phases"][0]["date_from"], "2026-09-01")
        self.assertEqual(draft["phases"][-1]["date_to"], "2026-11-30")

    def test_without_a_macro_the_skill_still_plans_a_whole_season(self):
        client = _FakeClient(json.dumps({
            "name": "Season", "date_from": "2026-09-01", "date_to": "2027-07-31", "phases": [],
        }))
        with SessionLocal() as db:
            with patch.object(skills, "get_client", return_value=client):
                result = skills.run_plan_macro("Plan the season.", db)
        self.assertNotIn("macro_id", result["draft"])
        self.assertNotIn("PLAN ONE MACROCYCLE ONLY", client.calls[0]["messages"][0]["content"])

    def test_dividing_the_year_resolves_meets_and_never_saves(self):
        with SessionLocal() as db:
            meet = models.Meet(name="Regionals", date=date(2026, 11, 20))
            db.add(meet)
            db.commit()
            meet_id = meet.id
            client = _FakeClient(json.dumps({
                "name": "2026/27", "date_from": "2026-09-01", "date_to": "2027-07-31",
                "macros": [
                    {"name": "Autumn", "date_from": "2026-09-01", "date_to": "2026-11-30",
                     "primary_meet_id": meet_id, "focus": "Get to Regionals."},
                    {"name": "Winter", "date_from": "2026-12-01", "date_to": "2027-03-01",
                     "primary_meet_id": 9999},
                ],
            }))
            with patch.object(skills, "get_client", return_value=client):
                result = skills.run_plan_season_macros("Divide the year.", db)
            saved = db.query(models.TrainingMacro).count()

        macros = result["draft"]["macros"]
        self.assertEqual(macros[0]["primary_meet"], "Regionals")
        self.assertIsNone(macros[1]["primary_meet_id"])
        self.assertEqual(saved, 0, "A proposal must not write anything until the coach approves.")

    def test_a_question_from_the_model_opens_no_review_card(self):
        client = _FakeClient("Before I split the year - which meets matter most, and roughly when?")
        with SessionLocal() as db:
            with patch.object(skills, "get_client", return_value=client):
                result = skills.run_plan_season_macros("Divide the year.", db)
        self.assertIsNone(result["draft"])
        self.assertTrue(result["needs_input"])
        self.assertIn("which meets matter most", result["reply"])


class PlanningContextsBuildTests(unittest.TestCase):
    """Every planning skill assembles its context before it ever calls the model.

    The macro and weekly skills each queried a Swimmer column that does not
    exist, so both failed on every use and the chat only ever said it had
    trouble. Building the contexts against a real schema catches that.
    """

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def tearDown(self):
        reset_database()

    def test_each_planning_context_builds_against_the_real_schema(self):
        with SessionLocal() as db:
            db.add(models.Swimmer(name="Context Swimmer", squad="Silver 1", status="active"))
            macro = models.TrainingMacro(name="Autumn", date_from=date(2026, 9, 1), date_to=date(2026, 11, 30))
            db.add(macro)
            db.commit()
            for builder in (
                lambda: skills._build_macro_plan_context(db),
                lambda: skills._build_meso_plan_context(db, macro_id=macro.id),
                lambda: skills._build_micro_plan_context(db),
                lambda: skills._build_season_macros_context(db),
                lambda: skills._build_pathway_context(db, macro_id=macro.id),
            ):
                self.assertTrue(builder())


class TimelineShowsUnplannedMacrosTests(unittest.TestCase):
    """The visual has to show a macro before anything is planned inside it."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def tearDown(self):
        reset_database()

    def test_a_macro_with_no_blocks_still_gets_its_weeks(self):
        with SessionLocal() as db:
            planned = models.TrainingMacro(name="Autumn", date_from=date(2026, 9, 7), date_to=date(2026, 10, 4))
            empty = models.TrainingMacro(name="Winter", date_from=date(2026, 10, 5), date_to=date(2026, 11, 1))
            db.add_all([planned, empty])
            db.commit()
            db.add(models.SeasonBlock(
                macro_id=planned.id, name="Base", phase_type="base",
                date_from=date(2026, 9, 7), date_to=date(2026, 10, 4),
            ))
            db.commit()
            timeline = get_timeline(db=db)

        weeks = timeline["weeks"]
        autumn = [w for w in weeks if w["macro_name"] == "Autumn"]
        winter = [w for w in weeks if w["macro_name"] == "Winter"]
        self.assertEqual(len(autumn), 4)
        self.assertEqual(len(winter), 4, "An unplanned macro must still occupy its weeks on the axis.")
        self.assertTrue(all(w["block_id"] for w in autumn))
        self.assertTrue(all(w["block_id"] is None for w in winter))
        self.assertTrue(all(w["cycle_code"] is None for w in winter),
                        "There is no meso or micro number to show until it is planned.")
        self.assertEqual([m["name"] for m in timeline["macros"]], ["Autumn", "Winter"])


class ChatWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chat = (Path(__file__).parents[1] / "routers" / "ai_chat.py").read_text(encoding="utf-8")

    def test_the_selected_macro_reaches_every_skill_that_needs_it(self):
        for call in ("run_plan_macro(", "run_plan_meso(", "run_plan_pathways("):
            line = next(ln for ln in self.chat.splitlines() if call in ln and "result = " in ln)
            self.assertIn("macro_id=selected_macro_id", line, f"{call} must be told which macro is in focus.")

    def test_the_year_skill_is_routed_ahead_of_the_macro_skill(self):
        self.assertLess(
            self.chat.index("Season macros skill"),
            self.chat.index("also route plan_macro requests"),
        )

    def test_pathway_and_year_drafts_never_ride_an_object_valued_action(self):
        # The AI page renders suggested_action as a label, so an object there
        # broke it. Drafts travel in skill_result instead.
        branch = self.chat.split("# --- Competition Pathway Skill ---")[1].split("# --- Taper")[0]
        self.assertNotIn("pathway_draft", branch)
        self.assertIn('"suggested_action": None', branch)


if __name__ == "__main__":
    unittest.main()
