"""What the staff can do: each action checked against the real schema.

Proposals are validated before they are offered and again when the coach
approves them, go through the app's existing code, and stay inside the role
that owns them.
"""
import json
import os
import unittest
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.services import staff_room  # noqa: E402
from backend.services.staff_actions import ActionError, execute, prepare  # noqa: E402
from backend.services.staff_room import Subject, apply_action, convene, decline_action  # noqa: E402
from backend.tests import reset_database  # noqa: E402


class _ScriptedClient:
    def __init__(self, script):
        self.script = script
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        op = kwargs.get("operation")
        self.calls.append(op)
        reply = self.script.get(op, {"speak": False})
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(reply))],
                               usage=SimpleNamespace(input_tokens=1, output_tokens=1))


class ActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", status="active", active=True)
            leo = models.Swimmer(name="Leo Park", squad="Silver 1", status="active", active=True)
            meet = models.Meet(name="County Champs", date=date(2026, 11, 14), course="SCM")
            macro = models.TrainingMacro(name="Autumn", squad="Silver 1",
                                         date_from=date(2026, 9, 7), date_to=date(2026, 11, 29))
            db.add_all([ruby, leo, meet, macro])
            db.commit()
            regional = models.PlanningPathway(macro_id=macro.id, name="Regional", active=True)
            county = models.PlanningPathway(macro_id=macro.id, name="County", active=True)
            db.add_all([regional, county])
            db.commit()
            db.add(models.PathwayMembership(pathway_id=regional.id, swimmer_id=ruby.id,
                                            qualification_status="close", active=True))
            db.commit()
            self.ids = dict(ruby=ruby.id, leo=leo.id, meet=meet.id, macro=macro.id,
                            regional=regional.id, county=county.id)

    def tearDown(self):
        reset_database()

    def _do(self, role, raw):
        with SessionLocal() as db:
            prepared = prepare(role, raw, db)
            self.assertIsNotNone(prepared, "The proposal was rejected outright.")
            self.assertNotIn("invalid", prepared, prepared.get("invalid"))
            result, handoff = execute(prepared, role, db)
        return prepared, result, handoff

    # --- ownership ----------------------------------------------------------
    def test_a_specialist_cannot_act_outside_their_role(self):
        with SessionLocal() as db:
            self.assertIsNone(prepare("physiologist", {"type": "create_meet", "name": "X",
                                                        "start_date": "2026-12-01"}, db))
            self.assertIsNone(prepare("meets", {"type": "set_status", "swimmer_id": self.ids["ruby"],
                                                "status": "injury", "reason": "x"}, db))
            self.assertIsNone(prepare("meets", {"type": "not_an_action"}, db))

    def test_an_unworkable_proposal_says_why(self):
        with SessionLocal() as db:
            prepared = prepare("meets", {"type": "record_results", "meet_id": self.ids["meet"],
                                         "results": [{"swimmer_id": self.ids["ruby"], "event": "100 Free", "time": "quick"}]}, db)
        self.assertIn("not a readable time", prepared["invalid"])

    # --- meet manager -------------------------------------------------------
    def test_adding_a_meet_uses_the_meet_list_and_refuses_duplicates(self):
        prepared, result, handoff = self._do("meets", {
            "type": "create_meet", "name": "Essex Open", "start_date": "2027-02-14",
            "end_date": "2027-02-15", "course": "lcm", "level": "County"})
        self.assertIn("Essex Open", prepared["summary"][0])
        self.assertEqual(handoff[0], "planner", "A new meet goes to the planner to check the peaks.")
        with SessionLocal() as db:
            meet = db.query(models.Meet).filter(models.Meet.name == "Essex Open").one()
            self.assertEqual((meet.course, meet.level), ("LCM", "county"))
            again = prepare("meets", {"type": "create_meet", "name": "essex open", "start_date": "2027-02-14"}, db)
        self.assertIn("already in the meet list", again["invalid"])

    def test_entries_add_to_what_a_swimmer_is_already_doing(self):
        self._do("meets", {"type": "add_entries", "meet_id": self.ids["meet"],
                           "entries": [{"swimmer_id": self.ids["ruby"], "event": "100 Freestyle"}]})
        _, _, handoff = self._do("meets", {"type": "add_entries", "meet_id": self.ids["meet"],
                                           "entries": [{"swimmer_id": self.ids["ruby"], "event": "200 Freestyle"}]})
        with SessionLocal() as db:
            target = db.query(models.MeetTarget).filter(models.MeetTarget.swimmer_id == self.ids["ruby"]).one()
            entries = db.query(models.MeetEntry).filter(models.MeetEntry.swimmer_id == self.ids["ruby"]).count()
        self.assertEqual(target.events, ["100 Freestyle", "200 Freestyle"], "An entry is never dropped.")
        self.assertEqual(entries, 2)
        self.assertEqual(handoff[0], "analyst")

    def test_results_land_in_the_swimmers_history(self):
        _, result, handoff = self._do("meets", {
            "type": "record_results", "meet_id": self.ids["meet"],
            "results": [{"swimmer_id": self.ids["ruby"], "event": "100 Freestyle", "time": "1:02.45", "round": "Heat"}]})
        with SessionLocal() as db:
            swim = db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == self.ids["ruby"]).one()
        self.assertAlmostEqual(swim.time_seconds, 62.45)
        self.assertEqual(swim.meet_id, self.ids["meet"])
        self.assertEqual(handoff[0], "analyst", "Results go to the analyst to review.")

    # --- physiologist / swimmer manager -------------------------------------
    def test_an_illness_is_logged_and_passed_to_the_physiologist(self):
        prepared, _, handoff = self._do("manager", {
            "type": "log_load_event", "swimmer_id": self.ids["ruby"], "event_type": "flu",
            "date_from": "2026-10-01", "severity": 9, "description": "Off school with flu"})
        self.assertEqual(prepared["payload"]["event_type"], "other", "Unknown types fall back to the app's list.")
        self.assertEqual(prepared["payload"]["severity"], 3, "Severity is clamped to 1-3.")
        self.assertEqual(handoff[0], "physiologist")
        with SessionLocal() as db:
            self.assertEqual(db.query(models.SwimmerLoadEvent).count(), 1)

    def test_status_change_is_refused_when_nothing_would_change(self):
        with SessionLocal() as db:
            same = prepare("manager", {"type": "set_status", "swimmer_id": self.ids["ruby"],
                                       "status": "active", "reason": "x"}, db)
        self.assertIn("already marked active", same["invalid"])
        self._do("manager", {"type": "set_status", "swimmer_id": self.ids["ruby"],
                             "status": "injury", "reason": "Shoulder"})
        with SessionLocal() as db:
            self.assertEqual(db.query(models.Swimmer).get(self.ids["ruby"]).status, "injury")

    def test_availability_goes_through_the_schedule(self):
        self._do("manager", {"type": "add_availability", "swimmer_id": self.ids["leo"], "reason": "exams",
                             "date_from": "2027-05-10", "date_to": "2027-06-20"})
        with SessionLocal() as db:
            self.assertEqual(db.query(models.SwimmerException).count(), 1)

    # --- planner ------------------------------------------------------------
    def test_load_changes_stay_inside_the_macrocycle(self):
        with SessionLocal() as db:
            outside = prepare("planner", {"type": "adjust_week_load", "macro_id": self.ids["macro"],
                                          "weeks": [{"week_start": "2027-03-01", "overall": 70}]}, db)
        self.assertIn("outside Autumn", outside["invalid"])
        _, _, handoff = self._do("planner", {"type": "adjust_week_load", "macro_id": self.ids["macro"],
                                             "weeks": [{"week_start": "2026-09-16", "overall": 140}]})
        with SessionLocal() as db:
            point = db.query(models.SeasonLoadPoint).one()
        self.assertEqual(point.week_start, date(2026, 9, 14), "Weeks snap to Monday.")
        self.assertEqual(point.overall, 100, "Load is capped at 100.")
        self.assertEqual(handoff[0], "physiologist", "The planner's load change goes to the physiologist.")

    def test_a_new_block_must_not_overlap_another(self):
        self._do("planner", {"type": "add_block", "macro_id": self.ids["macro"], "name": "Base",
                             "phase_type": "base", "date_from": "2026-09-07", "date_to": "2026-10-11"})
        with SessionLocal() as db:
            clash = prepare("planner", {"type": "add_block", "macro_id": self.ids["macro"], "name": "Build",
                                        "phase_type": "build", "date_from": "2026-10-05", "date_to": "2026-11-01"}, db)
        self.assertIn("overlaps Base", clash["invalid"])

    def test_branching_a_swimmer_closes_their_old_route(self):
        _, _, handoff = self._do("planner", {"type": "move_pathway", "swimmer_id": self.ids["ruby"],
                                             "to_pathway_id": self.ids["county"], "reason": "Time not there yet"})
        with SessionLocal() as db:
            active = db.query(models.PathwayMembership).filter(
                models.PathwayMembership.swimmer_id == self.ids["ruby"],
                models.PathwayMembership.active.is_(True)).all()
        self.assertEqual([m.pathway_id for m in active], [self.ids["county"]],
                         "A swimmer is on one route per macrocycle.")
        self.assertEqual(handoff[0], "meets", "The meet manager checks the entries still fit.")

    # --- analyst ------------------------------------------------------------
    def test_qualification_change_to_not_qualified_asks_the_planner(self):
        _, _, handoff = self._do("analyst", {"type": "set_qualification", "swimmer_id": self.ids["ruby"],
                                             "pathway_id": self.ids["regional"], "status": "not_qualified",
                                             "reason": "Window closed"})
        self.assertEqual(handoff[0], "planner")
        _, _, quiet = self._do("analyst", {"type": "set_qualification", "swimmer_id": self.ids["ruby"],
                                           "pathway_id": self.ids["regional"], "status": "qualified",
                                           "reason": "Got the time"})
        self.assertIsNone(quiet, "Good news needs no hand-off.")

    def test_meet_target_times_merge_with_existing_ones(self):
        self._do("analyst", {"type": "set_meet_target_times", "meet_id": self.ids["meet"],
                             "swimmer_id": self.ids["ruby"], "target_times": {"100 Freestyle": "1:01.50"}})
        self._do("analyst", {"type": "set_meet_target_times", "meet_id": self.ids["meet"],
                             "swimmer_id": self.ids["ruby"], "target_times": {"200 Freestyle": "2:15.00"}})
        with SessionLocal() as db:
            target = db.query(models.MeetTarget).one()
        self.assertEqual(set(target.target_times), {"100 Freestyle", "200 Freestyle"})

    # --- approval flow ------------------------------------------------------
    def test_proposal_waits_for_approval_then_hands_off(self):
        client = _ScriptedClient({
            "staff_meets": {"speak": True, "message": "Here are Ruby's heats.",
                            "proposed_action": {"type": "record_results", "meet_id": self.ids["meet"],
                                                "results": [{"swimmer_id": self.ids["ruby"],
                                                             "event": "100 Freestyle", "time": "62.10"}]}},
            "staff_analyst": {"speak": True, "message": "0.4s off her regional time - close."},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                note = convene(db, topic="Meet manager, Ruby swam 62.10 in the 100 free at County",
                               subject=Subject(meet_id=self.ids["meet"]))[0]
                self.assertEqual(note.action_status, "proposed")
                self.assertEqual(db.query(models.SwimTime).count(), 0, "Nothing is recorded before approval.")
                note, follow_ups = apply_action(db, note.id)
                self.assertEqual(note.action_status, "applied")
                self.assertEqual(db.query(models.SwimTime).count(), 1)
                self.assertEqual([f.role for f in follow_ups], ["analyst"])
                self.assertEqual(follow_ups[0].parent_id, note.id)
                again, more = apply_action(db, note.id)
                self.assertEqual(more, [], "Approving twice does nothing the second time.")
                self.assertEqual(db.query(models.SwimTime).count(), 1)

    def test_asked_directly_but_proposed_nothing_gets_one_second_look(self):
        action = {"type": "record_results", "meet_id": self.ids["meet"],
                  "results": [{"swimmer_id": self.ids["ruby"], "event": "100 Freestyle", "time": "62.10"}]}
        client = _ScriptedClient({
            "staff_meets": {"speak": True, "message": "She was only entered in the 100.", "proposed_action": None},
            "staff_meets_act": {"speak": True, "message": "She was only entered in the 100.", "proposed_action": action},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                notes = convene(db, topic="Ruby 62.10 100 free", subject=Subject(meet_id=self.ids["meet"]),
                                roles=["meets"], trigger="coach_question")
                self.assertEqual(notes[0].action_status, "proposed")
        self.assertEqual(client.calls, ["staff_meets", "staff_meets_act"])

    def test_a_plain_question_keeps_its_plain_answer(self):
        client = _ScriptedClient({
            "staff_meets": {"speak": True, "message": "Nobody is entered yet.", "proposed_action": None},
            "staff_meets_act": {"speak": True, "message": "Nobody is entered yet.", "proposed_action": None},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                notes = convene(db, topic="Who is entered?", subject=Subject(meet_id=self.ids["meet"]),
                                roles=["meets"], trigger="coach_question")
                self.assertIsNone(notes[0].proposed_action)
                self.assertEqual(notes[0].message, "Nobody is entered yet.")

    def test_no_second_look_for_someone_the_chair_chose(self):
        client = _ScriptedClient({
            "staff_chair": {"speakers": [{"role": "meets"}]},
            "staff_meets": {"speak": True, "message": "County timetable is still missing.", "proposed_action": None},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                convene(db, topic="Plan looks good", subject=Subject(meet_id=self.ids["meet"]))
        self.assertNotIn("staff_meets_act", client.calls, "Volunteered remarks are not pushed into actions.")

    def test_a_proposal_overtaken_by_events_fails_cleanly(self):
        with SessionLocal() as db:
            note = models.StaffNote(role="meets", message="Add it", status="open", action_status="proposed",
                                    proposed_action=prepare("meets", {"type": "create_meet", "name": "Late Meet",
                                                                      "start_date": "2027-01-10"}, db))
            db.add(note)
            db.add(models.Meet(name="Late Meet", date=date(2027, 1, 10)))
            db.commit()
            note, _ = apply_action(db, note.id)
            self.assertEqual(note.action_status, "failed")
            self.assertIn("already in the meet list", note.action_result)

    def test_declining_leaves_everything_untouched(self):
        with SessionLocal() as db:
            note = models.StaffNote(role="manager", message="Mark injured", status="open", action_status="proposed",
                                    proposed_action=prepare("manager", {"type": "set_status", "swimmer_id": self.ids["ruby"],
                                                                        "status": "injury", "reason": "x"}, db))
            db.add(note)
            db.commit()
            decline_action(db, note.id)
            note, _ = apply_action(db, note.id)
            self.assertEqual(note.action_status, "declined")
            self.assertEqual(db.query(models.Swimmer).get(self.ids["ruby"]).status, "active")


if __name__ == "__main__":
    unittest.main()
