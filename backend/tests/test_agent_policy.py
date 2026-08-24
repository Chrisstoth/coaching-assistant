import ast
import json
import unittest
from pathlib import Path

from backend.services.agent_policy import choose_agent_route


CASES_PATH = Path(__file__).parents[1] / "evals" / "coaching_agent_cases.json"


class AgentPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))

    def test_deterministic_routes_match_evaluation_contract(self):
        for case in self.cases:
            if case["expected_route"] == "specialist":
                continue
            with self.subTest(case=case["id"]):
                route = choose_agent_route(
                    case["prompt"],
                    set(case.get("topics", [])),
                    case.get("thread_type"),
                )
                self.assertEqual(route.tier, case["expected_route"])

    def test_conversational_tools_are_read_only(self):
        service_path = Path(__file__).parents[1] / "services" / "claude_service.py"
        module = ast.parse(service_path.read_text(encoding="utf-8"))
        function = next(
            node for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == "get_tools"
        )
        return_node = next(node for node in function.body if isinstance(node, ast.Return))
        names = {tool["name"] for tool in ast.literal_eval(return_node.value)}
        expected_reads = {
            tool_name
            for case in self.cases
            for tool_name in case.get("expected_tools", [])
        }
        self.assertTrue(expected_reads.issubset(names))
        forbidden_prefixes = ("add_", "create_", "delete_", "save_", "update_")
        self.assertFalse([name for name in names if name.startswith(forbidden_prefixes)])


if __name__ == "__main__":
    unittest.main()
