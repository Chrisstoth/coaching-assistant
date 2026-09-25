import os
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.services.planning_intent import (
    SKILL_CATALOGUE,
    VALID_LABELS,
    classify_planning_intent,
    route_allows,
    route_matches,
    routing_enabled,
)


class RouteDecisionTests(unittest.TestCase):
    """Model routing must narrow the keyword matchers, never widen them."""

    def test_without_a_route_the_keyword_matcher_still_decides(self):
        # The classifier being unavailable must leave old behaviour untouched.
        self.assertTrue(route_matches(None, "meso_plan", True))
        self.assertFalse(route_matches(None, "meso_plan", False))

    def test_a_route_overrides_an_overlapping_keyword_match(self):
        # "plan the season" matches both the macro and navigation signal lists;
        # the model's choice is what settles it.
        self.assertTrue(route_matches("macro_plan", "macro_plan", False))
        self.assertFalse(route_matches("macro_plan", "meso_plan", True))

    def test_entity_skills_can_be_vetoed_but_not_forced(self):
        # A taper needs a swimmer named in the message; the model cannot supply one.
        self.assertFalse(route_allows("taper_plan", "taper_plan", None))
        self.assertTrue(route_allows("taper_plan", "taper_plan", "Ruby Wheeler"))
        self.assertTrue(route_allows(None, "taper_plan", "Ruby Wheeler"))
        self.assertFalse(route_allows("meso_plan", "taper_plan", "Ruby Wheeler"))

    def test_pathway_plan_is_a_routable_skill(self):
        self.assertIn("pathway_plan", VALID_LABELS)

    def test_every_catalogue_label_is_unique(self):
        labels = [name for name, _ in SKILL_CATALOGUE]
        self.assertEqual(len(labels), len(set(labels)))


class ClassifierGuardTests(unittest.TestCase):
    def test_routing_can_be_switched_off(self):
        with patch.dict(os.environ, {"PLANNING_INTENT_ROUTING": "off"}):
            self.assertFalse(routing_enabled())
            self.assertIsNone(classify_planning_intent("plan the season for silver 1"))

    def test_short_messages_skip_the_model_call(self):
        with patch("backend.services.planning_intent.get_client") as client:
            self.assertIsNone(classify_planning_intent("hi"))
            client.assert_not_called()

    def test_a_provider_failure_falls_back_rather_than_raising(self):
        with patch("backend.services.planning_intent.get_client", side_effect=RuntimeError("boom")):
            from backend.services.planning_intent import _classify_cached
            _classify_cached.cache_clear()
            self.assertIsNone(classify_planning_intent("branch the non qualifiers to the county meet"))

    def test_an_unrecognised_label_is_treated_as_no_opinion(self):
        class _Response:
            content = [{"type": "text", "text": "something_made_up"}]

        with patch("backend.services.planning_intent.get_client") as client:
            client.return_value.messages.create.return_value = _Response()
            from backend.services.planning_intent import _classify_cached
            _classify_cached.cache_clear()
            self.assertIsNone(classify_planning_intent("branch the group for the county meet"))


class PathwaySkillWiringTests(unittest.TestCase):
    """The skill has to be reachable from the chat and write nothing on its own."""

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).parents[1]
        cls.skills_src = (root / "routers" / "skills.py").read_text(encoding="utf-8")
        cls.chat_src = (root / "routers" / "ai_chat.py").read_text(encoding="utf-8")

    def test_the_skill_exists_and_is_routed(self):
        self.assertIn("def run_plan_pathways(", self.skills_src)
        self.assertIn('@router.post("/plan-pathways")', self.skills_src)
        self.assertIn("run_plan_pathways", self.chat_src)
        self.assertIn("'pathway_plan'", self.chat_src)

    def test_the_draft_is_offered_for_approval_not_saved(self):
        # The branch hands back a draft and a review action; it must not create
        # pathways itself — the coach approves first.
        branch = self.chat_src.split("# --- Competition Pathway Skill ---")[1].split("# --- Taper")[0]
        self.assertIn('"plan_type": "pathway"', branch)
        self.assertNotIn("PlanningPathway(", branch)

    def test_the_skill_refuses_swimmers_outside_the_squad(self):
        self.assertIn("never invent a swimmer the squad does not have", self.skills_src)


if __name__ == "__main__":
    unittest.main()
