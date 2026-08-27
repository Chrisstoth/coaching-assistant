import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.routers.skills import run_plan_session
from backend.services.claude_service import plan_and_analyse_session, response_text


def _thinking_response(payload: dict):
    return SimpleNamespace(content=[
        SimpleNamespace(type="thinking", thinking="private reasoning"),
        SimpleNamespace(type="text", text=json.dumps(payload)),
    ])


class ClaudeResponseTextTests(unittest.TestCase):
    def test_response_text_skips_thinking_blocks(self):
        response = SimpleNamespace(content=[
            SimpleNamespace(type="thinking", thinking="private reasoning"),
            SimpleNamespace(type="text", text="final answer"),
        ])

        self.assertEqual(response_text(response), "final answer")

    def test_session_planner_accepts_thinking_before_json(self):
        payload = {
            "parsed": {
                "title": "Threshold set",
                "energy_focus": "threshold",
                "warm_up": "400 easy",
                "cool_down": "200 easy",
                "total_volume_m": "~3000m",
                "groups": {},
            },
            "plan_alignment": "Fits the current block.",
            "per_swimmer": [],
            "expected_effects": "Watch stroke quality.",
        }
        client = SimpleNamespace(messages=SimpleNamespace(
            create=lambda **kwargs: _thinking_response(payload)
        ))

        with patch("backend.services.claude_service.get_client", return_value=client), patch(
            "backend.services.claude_service.get_system_prompt", return_value="system"
        ):
            result = plan_and_analyse_session(
                session_text="6x400 threshold",
                date_str="2026-08-27",
                squad=None,
                expected_swimmers=[],
                coaching_context="",
                db=SimpleNamespace(),
            )

        self.assertEqual(result["parsed"]["title"], "Threshold set")

    def test_chat_session_skill_accepts_thinking_before_json(self):
        payload = {
            "title": "Speed session",
            "energy_system_focus": "speed",
            "coach_intent": "Preserve quality.",
            "groups": {},
            "reasoning": "Long recovery supports speed.",
        }
        client = SimpleNamespace(messages=SimpleNamespace(
            create=lambda **kwargs: _thinking_response(payload)
        ))

        with patch("backend.routers.skills.get_client", return_value=client), patch(
            "backend.routers.skills._build_session_skill_context", return_value="context"
        ), patch("backend.routers.skills._save_skill_output"):
            result = run_plan_session("Build a speed session", SimpleNamespace())

        self.assertEqual(result["draft"]["title"], "Speed session")
        self.assertIn("Long recovery", result["reply"])


if __name__ == "__main__":
    unittest.main()
