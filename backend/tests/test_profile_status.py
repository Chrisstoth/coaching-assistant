import unittest
from types import SimpleNamespace

from backend.services.profile_status import build_profile_status


class ProfileStatusTests(unittest.TestCase):
    def swimmer(self, physical=None, psychological=None):
        return SimpleNamespace(
            physical_profile=physical,
            psychological_profile=psychological,
        )

    def test_empty_profile_has_clear_foundation_status(self):
        status = build_profile_status(self.swimmer())

        self.assertEqual(status["state"], "not_started")
        self.assertEqual(status["completed_areas"], 0)
        self.assertEqual(status["total_areas"], 9)
        self.assertFalse(status["has_profile"])

    def test_existing_living_profile_is_not_reported_as_no_profile(self):
        status = build_profile_status(self.swimmer(), {"race", "training"})

        self.assertEqual(status["state"], "in_progress")
        self.assertTrue(status["has_profile"])
        self.assertEqual(status["living_built"], 2)

    def test_foundation_completeness_uses_the_nine_coaching_areas(self):
        status = build_profile_status(
            self.swimmer(
                physical={
                    "aerobic_base": "Strong",
                    "sprint_tendency": "Developing",
                    "race_pattern": "Even splitter",
                    "fatigue_profile": "Recovers quickly",
                    "training_response": "Responds to aerobic work",
                },
                psychological={
                    "motivation_style": "Intrinsic",
                    "competition_response": "Calm",
                    "response_to_hard_training": "Persistent",
                    "coachability": "Acts on feedback",
                },
            ),
            {"race", "technical"},
        )

        self.assertEqual(status["state"], "complete")
        self.assertEqual(status["completion_percent"], 100)
        self.assertEqual(status["missing_areas"], [])
        self.assertEqual(status["living_built"], 2)

    def test_legacy_field_names_still_count_as_existing_foundation_evidence(self):
        status = build_profile_status(
            self.swimmer(
                physical={
                    "aerobic_base": "Strong",
                    "sprint_tendency": "Developing",
                    "recovery_rate": "Quick",
                    "training_load_response": "Adapts well",
                },
                psychological={
                    "motivation_style": "Intrinsic",
                    "competition_response": "Calm",
                    "response_to_hard_training": "Persistent",
                    "coachability": "Acts on feedback",
                },
            ),
            {"race"},
        )

        self.assertEqual(status["state"], "complete")
        self.assertEqual(status["completed_areas"], 9)


if __name__ == "__main__":
    unittest.main()
