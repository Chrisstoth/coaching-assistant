"""The staff meeting: who speaks, when they stay quiet, and what gets kept.

The model is faked with a script keyed on the operation name, so each test says
exactly what the chair and each specialist "reply" and checks the code around it.
"""
import json
import os
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.services import staff_room  # noqa: E402
from backend.services.staff_room import (  # noqa: E402
    Subject, addressed_roles, clean_contribution, convene, reply_to_note, staff_context_lines,
)
from backend.tests import reset_database  # noqa: E402


class _ScriptedClient:
    """Replies by operation name; records every call."""

    def __init__(self, script):
        self.script = script
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        op = kwargs.get("operation")
        self.calls.append(op)
        reply = self.script.get(op, {"speak": False})
        text = reply if isinstance(reply, str) else json.dumps(reply)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1))


class PureHelperTests(unittest.TestCase):
    def test_the_coach_can_name_a_specialist_directly(self):
        self.assertEqual(addressed_roles("what does the physio think about Ruby?"), ["physiologist"])
        self.assertEqual(addressed_roles("ask the analyst and the planner"), ["analyst", "planner"])
        self.assertEqual(addressed_roles("plan the next block"), [],
                         "'plan' alone must not summon the planner.")

    def test_silence_is_respected(self):
        self.assertIsNone(clean_contribution("physiologist", {"speak": False}, set()))
        self.assertIsNone(clean_contribution("physiologist", None, set()))
        self.assertIsNone(clean_contribution("physiologist", {"speak": True, "message": "  "}, set()))

    def test_a_contribution_is_made_safe_before_it_is_kept(self):
        c = clean_contribution("physiologist", {
            "speak": True, "kind": "rant", "message": "Load jumps 30% in week 3.",
            "question_for_coach": "null", "swimmer_ids": [1, 999, "x", 1],
            "week_start": "2026-09-16", "ask_colleague": {"role": "physiologist", "question": "me?"},
        }, known_swimmer_ids={1, 2})
        self.assertEqual(c.kind, "observation", "An unknown kind falls back rather than failing.")
        self.assertIsNone(c.question, "A literal 'null' is not a question.")
        self.assertEqual(c.swimmer_ids, [1], "Swimmers outside the meeting are dropped, never invented.")
        self.assertEqual(c.week_start, date(2026, 9, 14), "Weeks are pinned to their Monday.")
        self.assertIsNone(c.ask_colleague, "A specialist cannot consult themselves.")

    def test_someone_asked_directly_speaks_even_if_they_said_not_to(self):
        self.assertIsNotNone(clean_contribution(
            "analyst", {"speak": False, "message": "Nothing new since last week."}, set(), force=True))


class MeetingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", status="active", active=True,
                                  dob=date(2011, 3, 4), gender="F")
            macro = models.TrainingMacro(name="Autumn", squad="Silver 1",
                                         date_from=date(2026, 9, 1), date_to=date(2026, 11, 30))
            db.add_all([ruby, macro])
            db.commit()
            self.ruby_id, self.macro_id = ruby.id, macro.id

    def tearDown(self):
        reset_database()

    def _run(self, script, **kwargs):
        client = _ScriptedClient(script)
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                notes = convene(db, **kwargs)
                out = [(n.role, n.message, n.swimmer_ids, n.parent_id, n.addressed_to) for n in notes]
        return client, out

    def test_a_shared_first_name_does_not_pull_in_the_wrong_swimmer(self):
        with SessionLocal() as db:
            db.add_all([
                models.Swimmer(name="Jamie Comitti", status="active", active=True),
                models.Swimmer(name="Jamie Larthe", status="active", active=True),
            ])
            db.commit()
            names = lambda text: sorted(s.name for s in staff_room.find_mentioned_swimmers(text, db))
            self.assertEqual(names("Jamie Comitti needs a softer week"), ["Jamie Comitti"])
            self.assertEqual(names("Jamie needs a softer week"), [],
                             "Two Jamies: a bare first name is ambiguous, so nobody is assumed.")
            self.assertEqual(names("Ruby needs a softer week"), ["Ruby Wheeler"],
                             "A first name only one swimmer has still counts.")

    def test_a_cut_off_chair_reply_still_names_its_speakers(self):
        truncated = '```json\n{"speakers": [{"role": "physiologist", "focus": "whether Ruby can tol'
        client, notes = self._run({
            "staff_chair": truncated,
            "staff_physiologist": {"speak": True, "message": "That jump is too steep."},
        }, topic="Ruby goes 60, 80, 95.", subject=Subject(macro_id=self.macro_id))
        self.assertIn("staff_physiologist", client.calls,
                      "A truncated reply must not silently become 'nobody speaks'.")
        self.assertEqual([n[0] for n in notes], ["physiologist"])

    def test_nobody_chosen_means_one_cheap_call_and_nothing_kept(self):
        client, notes = self._run({"staff_chair": {"speakers": []}},
                                  topic="Thanks, that's helpful.", subject=Subject(macro_id=self.macro_id))
        self.assertEqual(client.calls, ["staff_chair"])
        self.assertEqual(notes, [])

    def test_the_chair_picks_a_specialist_who_raises_a_point(self):
        client, notes = self._run({
            "staff_chair": {"speakers": [{"role": "physiologist", "focus": "Ruby's load"},
                                         {"role": "not_a_role"}]},
            "staff_physiologist": {"speak": True, "kind": "concern",
                                   "message": "Ruby's load jumps 30% in week 3.",
                                   "swimmer_ids": [self.ruby_id]},
        }, topic="Put Ruby on the regional branch with the full load.",
            subject=Subject(macro_id=self.macro_id))
        self.assertEqual(client.calls.count("staff_physiologist"), 1)
        self.assertEqual(len(notes), 1)
        role, message, swimmer_ids, _, addressed = notes[0]
        self.assertEqual(role, "physiologist")
        self.assertEqual(swimmer_ids, [self.ruby_id], "Ruby was named, so she is the subject.")
        self.assertEqual(addressed, "coach")

    def test_a_specialist_who_has_nothing_to_say_stays_quiet(self):
        _, notes = self._run({
            "staff_chair": {"speakers": [{"role": "planner"}]},
            "staff_planner": {"speak": False},
        }, topic="Plan the next block.", subject=Subject(macro_id=self.macro_id))
        self.assertEqual(notes, [])

    def test_naming_a_specialist_skips_the_chair(self):
        client, notes = self._run({
            "staff_manager": {"speak": False, "message": "Ruby is Year 10, attendance 82%."},
        }, topic="What does the swimmer manager think about Ruby?", subject=Subject())
        self.assertNotIn("staff_chair", client.calls)
        self.assertEqual([n[0] for n in notes], ["manager"],
                         "Asked directly, they answer even if they would otherwise stay quiet.")

    def test_one_colleague_consultation_and_no_more(self):
        client, notes = self._run({
            "staff_chair": {"speakers": [{"role": "physiologist"}]},
            "staff_physiologist": {"speak": True, "message": "Taper looks short for her age.",
                                   "ask_colleague": {"role": "manager", "question": "Is she in a growth spurt?"}},
            "staff_manager": {"speak": True, "message": "Grew 6cm since June.",
                              "ask_colleague": {"role": "analyst", "question": "Times?"}},
        }, topic="Ruby tapers for one week into Regionals.", subject=Subject(macro_id=self.macro_id))
        self.assertEqual([n[0] for n in notes], ["physiologist", "manager"])
        self.assertEqual(notes[1][4], "physiologist", "The answer is addressed to the colleague who asked.")
        self.assertNotIn("staff_analyst", client.calls, "A consultation cannot chain into another.")

    def test_no_consultation_with_someone_who_already_spoke(self):
        client, notes = self._run({
            "staff_chair": {"speakers": [{"role": "physiologist"}, {"role": "manager"}]},
            "staff_physiologist": {"speak": True, "message": "Load is steep.",
                                   "ask_colleague": {"role": "manager", "question": "Attendance?"}},
            "staff_manager": {"speak": True, "message": "One session in eight weeks."},
        }, topic="Ruby goes 60, 80, 95.", subject=Subject(macro_id=self.macro_id))
        self.assertEqual([n[0] for n in notes], ["physiologist", "manager"])
        self.assertEqual(client.calls.count("staff_manager"), 1, "The manager is not asked twice.")

    def test_only_the_coachs_words_can_summon_someone(self):
        client, notes = self._run({
            "staff_chair": {"speakers": []},
        }, topic="Coach: thanks. Lead assistant replied: the physiologist would want a lighter week.",
            subject=Subject(), trigger="coach_message", coach_text="thanks")
        self.assertNotIn("staff_physiologist", client.calls,
                         "The lead assistant naming a role is not the coach asking for them.")

    def test_the_staff_room_can_be_switched_off(self):
        with patch.dict(os.environ, {"STAFF_ROOM": "off"}):
            client, notes = self._run({}, topic="anything", subject=Subject())
        self.assertEqual(client.calls, [])
        self.assertEqual(notes, [])

    def test_a_provider_failure_ends_the_meeting_quietly(self):
        with patch.object(staff_room, "get_client", side_effect=RuntimeError("down")):
            with SessionLocal() as db:
                self.assertEqual(convene(db, topic="Ruby's taper", subject=Subject()), [])

    def test_replying_gets_an_answer_from_the_same_specialist(self):
        client = _ScriptedClient({
            "staff_chair": {"speakers": [{"role": "physiologist"}]},
            "staff_physiologist": {"speak": True, "message": "Week 3 jumps 30%.", "question_for_coach": "Intended?"},
            "staff_physiologist_reply": {"speak": True, "message": "Fine, but watch her Thursday sets."},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                first = convene(db, topic="Full load for Ruby", subject=Subject(macro_id=self.macro_id))[0]
                answer = reply_to_note(db, first.id, "Yes - she handled it last year.")
                db.refresh(first)
                self.assertEqual(first.coach_reply, "Yes - she handled it last year.")
                self.assertEqual(answer.role, "physiologist")
                self.assertEqual(answer.parent_id, first.id)

    def test_open_points_reach_the_lead_assistant(self):
        with SessionLocal() as db:
            db.add(models.StaffNote(role="analyst", message="Ruby is 1.2s off the regional time.",
                                    macro_id=self.macro_id, status="open"))
            db.add(models.StaffNote(role="planner", message="Dealt with.",
                                    macro_id=self.macro_id, status="resolved"))
            db.commit()
            lines = staff_context_lines(db, macro_id=self.macro_id)
        joined = "\n".join(lines)
        self.assertIn("Performance Analyst: Ruby is 1.2s off", joined)
        self.assertNotIn("Dealt with", joined, "Resolved points drop out of the assistant's view.")

    def test_each_specialist_can_build_its_view_of_real_data(self):
        with SessionLocal() as db:
            subject = Subject(swimmer_ids=[self.ruby_id], macro_id=self.macro_id)
            for role in staff_room.ROLE_ORDER:
                self.assertTrue(staff_room.role_context(role, db, subject), role)
            brief = staff_room.briefing(db, subject)
        self.assertIn("Ruby Wheeler", brief)
        self.assertIn("at 31 Dec", brief, "Age is shown at 31 December, as the coach reads it.")


if __name__ == "__main__":
    unittest.main()
