"""The specialists' own lanes: the figures worked out for them in code, the
coach's call when they disagree, and the session writer's meeting.

Figures are checked against a small, hand-built register so every number can
be worked out on paper. The model is faked, as in test_staff_room.
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

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import staff_room, training_load  # noqa: E402
from backend.services.staff_room import Subject, briefing, convene, decide, role_context  # noqa: E402
from backend.tests import reset_database  # noqa: E402

TODAY = date(2026, 9, 24)   # a Thursday
MONDAY = date(2026, 9, 21)


class _ScriptedClient:
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


def _session(db, day, focus, volume, squad="Silver 1"):
    session = models.Session(date=day, squad=squad, title=f"{focus} {day}", energy_system_focus=focus,
                             status="completed")
    db.add(session)
    db.flush()
    db.add(models.SessionGroup(session_id=session.id, group_number=1, volume_breakdown=volume))
    db.flush()
    return session


def _attend(db, session, swimmer, attended=True, note=None):
    db.add(models.SessionEntry(session_id=session.id, swimmer_id=swimmer.id, attended=attended,
                               group_done=1 if attended else None, group_planned=1, coach_observation=note))
    if attended:
        db.add(models.SwimmerSessionLoad(swimmer_id=swimmer.id, session_id=session.id,
                                         session_date=session.date, group_number=1,
                                         volume_breakdown=session.groups[0].volume_breakdown))


def _http_get_or_post(method, path, body=None):
    with TestClient(app) as http:
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        if method == "GET":
            return http.get(path, headers=headers)
        return http.post(path, json=body or {}, headers=headers)


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def tearDown(self):
        reset_database()


class TrainingFiguresTests(_Base):
    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", status="active", active=True)
            leo = models.Swimmer(name="Leo Park", squad="Silver 1", status="active", active=True)
            db.add_all([ruby, leo])
            db.flush()
            aerobic = {"aerobic": 3000, "threshold": 1000}
            speed = {"aerobic": 1500, "sprint": 400, "short_race_pace": 200}
            # Four aerobic sessions over the fortnight before; Ruby makes one.
            for offset in (17, 15, 10, 8):
                s = _session(db, TODAY - timedelta(days=offset), "aerobic", aerobic)
                _attend(db, s, ruby, attended=(offset == 17))
                _attend(db, s, leo)
            # One speed session four weeks back that both swim, then nothing fast.
            s = _session(db, TODAY - timedelta(days=26), "speed", speed)
            _attend(db, s, ruby)
            _attend(db, s, leo)
            # This week Leo stacks three hard days in a row.
            hard = {"aerobic": 1000, "vo2": 600, "lact_tol": 300}
            for offset in (3, 2, 1):
                s = _session(db, TODAY - timedelta(days=offset), "threshold", hard)
                _attend(db, s, leo, note="Leo faded badly on the last reps" if offset == 1 else None)
                _attend(db, s, ruby, attended=False)
            # Ruby was excused one of those with exams: not a missed session.
            db.add(models.SwimmerException(swimmer_id=ruby.id, reason="exams",
                                           date_from=TODAY - timedelta(days=1), date_to=TODAY - timedelta(days=1)))
            db.commit()
            self.ruby_id, self.leo_id = ruby.id, leo.id

    def _profile(self, swimmer_id):
        with SessionLocal() as db:
            swimmer = db.get(models.Swimmer, swimmer_id)
            return training_load.load_profiles(db, [swimmer], today=TODAY)[0]

    def test_attendance_counts_expected_sessions_and_leaves_out_excused_ones(self):
        ruby = self._profile(self.ruby_id)
        self.assertEqual((ruby.attended, ruby.opportunities, ruby.excused), (2, 7, 1),
                         "8 registers, 1 excused for exams; she swam 2 of the other 7.")

    def test_work_got_is_measured_against_what_their_group_swam(self):
        ruby = self._profile(self.ruby_id)
        # Aerobic sessions: 4 x (3000 + 1000); she got one. Speed session: 1500 aerobic, got it.
        # Missed hard days: 2 x 1000 aerobic.
        self.assertEqual(ruby.zone_available["aerobic"], 4 * 3000 + 1500 + 2 * 1000)
        self.assertEqual(ruby.zone_got["aerobic"], 3000 + 1500)
        self.assertEqual(ruby.share(training_load.AEROBIC), round((4000 + 1500) / (16000 + 1500 + 2000) * 100))
        self.assertTrue(any("aerobic work" in f for f in ruby.flags), ruby.flags)
        self.assertTrue(any("missed 3 of 4 aerobic-focus" in f for f in ruby.flags), ruby.flags)

    def test_stacked_hard_days_and_a_high_intensity_spike_are_flagged(self):
        leo = self._profile(self.leo_id)
        self.assertEqual(leo.hard_days_in_row, 3)
        self.assertEqual(leo.hi_this_week, 3 * 900)
        self.assertTrue(any("3 hard days in a row" in f for f in leo.flags), leo.flags)
        self.assertIn("Leo faded badly on the last reps", training_load.describe(leo),
                      "The coach's own session notes are the fatigue evidence.")

    def test_a_long_gap_since_speed_work_is_flagged(self):
        leo = self._profile(self.leo_id)
        self.assertEqual(leo.last_speed, TODAY - timedelta(days=26))
        self.assertTrue(any("no speed work for 26 days" in f for f in leo.flags), leo.flags)

    def test_the_physiologist_reads_the_figures_not_raw_history(self):
        with SessionLocal() as db:
            text = role_context("physiologist", db, Subject(swimmer_ids=[self.ruby_id]))
        self.assertIn("TRAINING FIGURES for Ruby Wheeler", text)
        self.assertIn("FLAGS:", text)

    def test_a_swimmer_with_no_register_says_so(self):
        with SessionLocal() as db:
            new = models.Swimmer(name="New Starter", squad="Silver 1", status="active", active=True)
            db.add(new)
            db.commit()
            profile = training_load.load_profiles(db, [new], today=TODAY)[0]
        self.assertEqual(profile.flags, [])
        self.assertIn("nothing to work from", training_load.describe(profile))


class ProgressionTests(_Base):
    def test_a_building_phase_without_a_lighter_week_is_flagged(self):
        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", status="active", active=True)
            macro = models.TrainingMacro(name="Autumn", squad="Silver 1",
                                         date_from=MONDAY - timedelta(weeks=8), date_to=MONDAY + timedelta(weeks=10))
            db.add_all([swimmer, macro])
            db.flush()
            db.add(models.SeasonBlock(macro_id=macro.id, name="Base", phase_type="base",
                                      date_from=MONDAY - timedelta(weeks=8), date_to=MONDAY + timedelta(weeks=4)))
            # Five weeks, each a little bigger than the last; then a 30% jump.
            weekly = [10000, 10500, 11000, 11500, 12000, 15600]
            for i, metres in enumerate(weekly):
                day = MONDAY - timedelta(weeks=len(weekly) - i) + timedelta(days=1)
                s = _session(db, day, "aerobic", {"aerobic": metres})
                _attend(db, s, swimmer)
            # The plan keeps climbing for five weeks from this week.
            for i, value in enumerate([60, 65, 70, 75, 80, 85]):
                db.add(models.SeasonLoadPoint(macro_id=macro.id, week_start=MONDAY + timedelta(weeks=i), overall=value))
            db.commit()
            text = training_load.progression_summary(db, macro_id=macro.id, today=TODAY)
        self.assertIn("(+30%)", text)
        self.assertIn("jumped 30% in a base phase", text)
        self.assertIn("delivered weeks without a lighter week", text)
        self.assertIn("planned load keeps rising or holding", text)

    def test_a_lighter_week_resets_the_count(self):
        self.assertEqual(training_load._lighter_run([10, 11, 12, 8, 12, 13]), (2, 3))
        self.assertEqual(training_load._lighter_run([10, 11, 12, 13]), (4, None))


class DisagreementTests(_Base):
    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", status="active", active=True, gender="F")
            macro = models.TrainingMacro(name="Autumn", squad="Silver 1",
                                         date_from=date(2026, 9, 1), date_to=date(2026, 11, 30))
            db.add_all([ruby, macro])
            db.commit()
            self.ruby_id, self.macro_id = ruby.id, macro.id

    def _meeting(self, extra=None):
        script = {
            "staff_chair": {"speakers": [{"role": "physiologist"}, {"role": "planner"}]},
            "staff_physiologist": {"speak": True, "kind": "concern", "message": "Rest Ruby this week."},
            "staff_planner": {"speak": True, "message": "Keep Ruby's load going up to 85."},
        }
        script.update(extra or {})
        client = _ScriptedClient(script)
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                notes = convene(db, topic="Ruby week 4", subject=Subject(macro_id=self.macro_id,
                                                                         swimmer_ids=[self.ruby_id]))
                ids = {n.role: n.id for n in notes}
                decision = next((n for n in notes if n.kind == "decision"), None)
                decision_id = decision.id if decision else None
        return client, ids, decision_id

    def test_opposed_advice_becomes_a_call_for_the_coach(self):
        client, ids, _ = self._meeting()
        script = {
            "staff_disagreement": {"disagree": True, "question": "Rest Ruby or keep building?", "options": [
                {"note_id": ids["physiologist"], "role": "physiologist", "position": "Rest this week",
                 "because": "three hard days stacked"},
                {"note_id": ids["planner"], "role": "planner", "position": "Build to 85", "because": "on plan"},
                {"note_id": 99999, "role": "analyst", "position": "Invented", "because": "not in the meeting"},
            ]},
        }
        client, ids, decision_id = self._meeting(script)
        self.assertIn("staff_disagreement", client.calls)
        with SessionLocal() as db:
            decision = db.get(models.StaffNote, decision_id)
            self.assertEqual(decision.role, "chair")
            self.assertEqual([o["role"] for o in decision.options], ["physiologist", "planner"],
                             "Only positions somebody actually took are offered.")
            self.assertEqual(decision.swimmer_ids, [self.ruby_id])

    def test_agreement_raises_nothing(self):
        _, _, decision_id = self._meeting({"staff_disagreement": {"disagree": False}})
        self.assertIsNone(decision_id)

    def test_a_single_voice_never_triggers_the_check(self):
        client = _ScriptedClient({
            "staff_chair": {"speakers": [{"role": "physiologist"}]},
            "staff_physiologist": {"speak": True, "message": "Rest Ruby this week."},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                convene(db, topic="Ruby", subject=Subject(macro_id=self.macro_id))
        self.assertNotIn("staff_disagreement", client.calls)

    def test_the_coachs_call_closes_both_sides_and_is_remembered(self):
        _, ids, _ = self._meeting()
        with SessionLocal() as db:
            decision = models.StaffNote(role="chair", kind="decision", message="Rest Ruby or keep building?",
                                        macro_id=self.macro_id, swimmer_ids=[self.ruby_id], status="open",
                                        options=[
                                            {"note_id": ids["physiologist"], "role": "physiologist",
                                             "title": "Physiologist", "position": "Rest this week"},
                                            {"note_id": ids["planner"], "role": "planner",
                                             "title": "Periodisation Planner", "position": "Build to 85"},
                                        ])
            db.add(decision)
            db.commit()
            decision_id = decision.id

        client = _ScriptedClient({"staff_planner": {"speak": True, "message": "I'll hold week 4 at 70."}})
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                note, follow_ups = decide(db, decision_id, choice="physiologist", text="Easy swim Saturday.")
                self.assertEqual(note.decision, "Go with the Physiologist: Rest this week Easy swim Saturday.")
                self.assertEqual([f.role for f in follow_ups], ["planner"])
                self.assertEqual(follow_ups[0].parent_id, decision_id)
                for side in ("physiologist", "planner"):
                    self.assertEqual(db.get(models.StaffNote, ids[side]).status, "resolved")
                brief = briefing(db, Subject(macro_id=self.macro_id))
        self.assertNotIn("staff_disagreement", client.calls, "Working to a decision does not reopen it.")
        self.assertIn("COACH'S DECISIONS", brief)
        self.assertIn("Rest this week", brief)

    def test_a_call_needs_a_choice_or_the_coachs_own_words(self):
        with SessionLocal() as db:
            decision = models.StaffNote(role="chair", kind="decision", message="?", status="open", options=[])
            db.add(decision)
            db.commit()
            decision_id = decision.id
        response = _http_get_or_post("POST", f"/staff/notes/{decision_id}/decide", {})
        self.assertEqual(response.status_code, 422)


class SessionWriterTests(_Base):
    def setUp(self):
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", status="active", active=True,
                                  target_events=[{"event": "100 Freestyle", "course": "SCM"}])
            db.add(ruby)
            db.flush()
            db.add(models.SwimTime(swimmer_id=ruby.id, event="100 Freestyle SCM", course="SCM",
                                   time_seconds=64.21, date=date(2026, 6, 1)))
            db.add(models.SwimmerException(swimmer_id=ruby.id, reason="exams", date_from=TODAY, date_to=TODAY))
            db.commit()
            self.ruby_id = ruby.id

    def test_the_session_writer_does_not_review_its_own_draft(self):
        client = _ScriptedClient({"staff_chair": {"speakers": [{"role": "sessions"}, {"role": "manager"}]}})
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                convene(db, topic="Session draft: Threshold", trigger="session_draft",
                        subject=Subject(session_date=TODAY, squad="Silver 1", attendee_ids=[self.ruby_id]))
        self.assertNotIn("staff_sessions", client.calls)
        self.assertIn("staff_manager", client.calls)

    def test_a_session_meeting_knows_who_is_expected(self):
        subject = Subject(session_date=TODAY, squad="Silver 1", attendee_ids=[self.ruby_id])
        with SessionLocal() as db:
            brief = briefing(db, subject)
            manager = role_context("manager", db, subject)
            analyst = role_context("analyst", db, subject)
        self.assertIn("SESSION BEING WRITTEN: Thursday 24 Sep 2026, Silver 1, 1 expected: Ruby Wheeler", brief)
        self.assertIn("EXCUSED: Exams", manager)
        self.assertIn("100 Freestyle PB 64.21s", analyst)

    def test_session_notes_are_pinned_to_their_week(self):
        client = _ScriptedClient({
            "staff_chair": {"speakers": [{"role": "physiologist"}]},
            "staff_physiologist": {"speak": True, "message": "Ruby has had no speed for a month."},
        })
        with patch.object(staff_room, "get_client", return_value=client):
            with SessionLocal() as db:
                notes = convene(db, topic="Session draft", trigger="session_draft",
                                subject=Subject(session_date=TODAY, attendee_ids=[self.ruby_id]))
                self.assertEqual(notes[0].week_start, MONDAY)

    def test_a_page_can_follow_just_its_own_notes_and_their_replies(self):
        with SessionLocal() as db:
            mine = models.StaffNote(role="physiologist", message="mine", status="open")
            other = models.StaffNote(role="analyst", message="someone else's", status="open")
            db.add_all([mine, other])
            db.flush()
            reply = models.StaffNote(role="physiologist", message="reply", parent_id=mine.id, status="open")
            db.add(reply)
            db.commit()
            mine_id = mine.id
        response = _http_get_or_post("GET", f"/staff/notes?ids={mine_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(sorted(n["message"] for n in response.json()), ["mine", "reply"])


if __name__ == "__main__":
    unittest.main()
