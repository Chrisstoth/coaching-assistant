import os
import io
import json
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
import pandas as pd


_db_file = tempfile.NamedTemporaryFile(prefix="deckxtra-test-", suffix=".db", delete=False)
_db_file.close()
Path(_db_file.name).unlink(missing_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_db_file.name).as_posix()}"
os.environ["APP_PASSWORD"] = "test-password"
os.environ["SECRET_KEY"] = "test-secret-key"

from fastapi.testclient import TestClient
from backend.main import app
from backend.database import engine
from backend.database import SessionLocal
from backend.database import _portable_column_type
from backend import models
from backend.routers.ai_chat import (
    ATHLETE_HISTORY, GENERAL_HISTORY, MAX_HISTORY,
    _conversation_action, _history_limit_for_thread, _thread_memory,
)
from backend.services.claude_service import (
    COACHING_CONTEXT_CHAR_LIMIT, FAST_MODEL,
    _coaching_context_for_prompt, execute_tool, record_ai_usage,
)


class CoreFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()
        login = cls.client.post("/auth/login", json={"password": "test-password"})
        assert login.status_code == 200, login.text
        cls.headers = {"Authorization": f"Bearer {login.json()['token']}"}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        engine.dispose()
        Path(_db_file.name).unlink(missing_ok=True)

    def test_agent_read_tools_return_compact_stored_evidence(self):
        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Agent Tool Swimmer", squad="Agent Test")
            db.add(swimmer)
            db.flush()
            db.add(models.SwimTime(
                swimmer_id=swimmer.id,
                event="100 Freestyle SCM",
                course="SCM",
                distance=100,
                stroke="Freestyle",
                time_seconds=64.25,
                date=__import__('datetime').date(2026, 8, 10),
            ))
            db.add_all([
                models.SwimTime(
                    swimmer_id=swimmer.id, event="50 Butterfly SCM", course="SCM",
                    distance=50, stroke="Butterfly", time_seconds=30.53,
                    date=__import__('datetime').date(2026, 7, 11),
                ),
                models.SwimTime(
                    swimmer_id=swimmer.id, event="100 Butterfly SCM", course="SCM",
                    distance=100, stroke="Butterfly", time_seconds=69.36,
                    date=__import__('datetime').date(2026, 7, 11),
                ),
            ])
            db.commit()

            found = json.loads(execute_tool("find_swimmer", {"name": "Agent Tool"}, db))
            self.assertEqual(found["matches"][0]["id"], swimmer.id)
            times = json.loads(execute_tool(
                "get_swim_times",
                {"swimmer_id": swimmer.id, "event": "100 Free"},
                db,
            ))
            self.assertEqual(times["times"][0]["time_seconds"], 64.25)
            fly_times = json.loads(execute_tool(
                "get_swim_times",
                {"swimmer_id": swimmer.id, "event": "50/100 fly"},
                db,
            ))
            self.assertEqual(
                {item["event"] for item in fly_times["times"]},
                {"50 Butterfly SCM", "100 Butterfly SCM"},
            )
            self.assertTrue(all(item["is_personal_best"] for item in fly_times["times"]))
            db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == swimmer.id).delete()
            db.delete(swimmer)
            db.commit()

    def test_availability_excuses_holidays_competitions_and_taper_rest(self):
        today = date.today()
        competition_day = today + timedelta(days=1)
        cancel_day = today + timedelta(days=2)
        taper_day = today + timedelta(days=3)
        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Availability Test Swimmer", squad="Silver 1")
            slot = models.PoolSlot(
                day_of_week=today.weekday(), time="05:55", end_time="07:00",
                squad="Availability Test", label="Availability slot", active=True,
            )
            db.add_all([swimmer, slot])
            db.flush()
            swimmer_id, slot_id = swimmer.id, slot.id
            db.add(models.SwimmerSlot(swimmer_id=swimmer_id, pool_slot_id=slot_id))
            session = models.Session(
                date=today, squad="Availability Test", start_time="05:55",
                status="completed", pool_slot_id=slot_id,
            )
            db.add(session)
            db.flush()
            db.add(models.SessionEntry(
                session_id=session.id, swimmer_id=swimmer_id, attended=False,
            ))
            cancel_session = models.Session(
                date=cancel_day, squad="Availability Test", start_time="05:55",
                status="planned",
            )
            db.add(cancel_session)
            db.commit()
            session_id = session.id
            cancel_session_id = cancel_session.id

        holiday = self.client.post(
            f"/schedule/swimmers/{swimmer_id}/exceptions", headers=self.headers,
            json={
                "reason": "holiday", "date_from": today.isoformat(),
                "date_to": today.isoformat(), "notes": "Start-of-season holiday",
            },
        )
        self.assertEqual(holiday.status_code, 201, holiday.text)
        holiday_id = holiday.json()["id"]

        expected = self.client.get(
            f"/schedule/expected/{today.isoformat()}?squad=Availability%20Test",
            headers=self.headers,
        )
        self.assertEqual(expected.status_code, 200, expected.text)
        expected_row = next(row for row in expected.json() if row["id"] == swimmer_id)
        self.assertFalse(expected_row["expected"])
        self.assertEqual(expected_row["availability"]["label"], "Holiday")

        stats = self.client.get(
            f"/swimmers/{swimmer_id}/attendance-stats", headers=self.headers,
        )
        self.assertEqual(stats.status_code, 200, stats.text)
        self.assertEqual(stats.json()["overall_total"], 0)
        self.assertEqual(stats.json()["overall_excused"], 1)

        meet = self.client.post(
            "/meets", headers=self.headers,
            json={"name": "Availability Test Meet", "date": competition_day.isoformat()},
        )
        self.assertEqual(meet.status_code, 201, meet.text)
        meet_id = meet.json()["id"]
        target = self.client.post(
            f"/meets/{meet_id}/targets", headers=self.headers,
            json={"swimmer_id": swimmer_id, "events": ["100 Freestyle"], "priority": "B"},
        )
        self.assertEqual(target.status_code, 201, target.text)

        report = self.client.get("/dashboard/availability?days=7", headers=self.headers)
        self.assertEqual(report.status_code, 200, report.text)
        swimmer_items = [item for item in report.json()["items"] if item["swimmer_id"] == swimmer_id]
        self.assertTrue(any(item["reason"] == "holiday" and item["is_current"] for item in swimmer_items))
        competition = next(item for item in swimmer_items if item["reason"] == "competition")
        self.assertEqual(competition["detail"], "Availability Test Meet")
        self.assertEqual(competition["source"], "meet_entry")

        with SessionLocal() as tool_db:
            cancelled = execute_tool(
                "cancel_session",
                {"session_id": cancel_session_id, "reason": "Public holiday"},
                tool_db,
            )
        self.assertIn("Cancelled session", cancelled)
        with SessionLocal() as db:
            row = db.get(models.Session, cancel_session_id)
            self.assertEqual(row.status, "cancelled")
            self.assertEqual(row.cancel_reason, "Public holiday")

        with SessionLocal() as tool_db:
            saved = execute_tool(
                "add_swimmer_availability",
                {
                    "swimmer_id": swimmer_id, "reason": "taper_rest",
                    "date_from": taper_day.isoformat(), "date_to": taper_day.isoformat(),
                    "notes": "Planned pre-meet rest",
                },
                tool_db,
            )
        self.assertIn("taper rest", saved)

        with SessionLocal() as db:
            db.query(models.SessionEntry).filter(models.SessionEntry.session_id == session_id).delete()
            db.query(models.Session).filter(models.Session.id.in_([session_id, cancel_session_id])).delete(
                synchronize_session=False,
            )
            db.query(models.SwimmerSlot).filter(models.SwimmerSlot.swimmer_id == swimmer_id).delete()
            db.query(models.SwimmerException).filter(models.SwimmerException.swimmer_id == swimmer_id).delete()
            db.query(models.SwimmerLoadEvent).filter(models.SwimmerLoadEvent.swimmer_id == swimmer_id).delete()
            db.query(models.MeetEntry).filter(models.MeetEntry.swimmer_id == swimmer_id).delete()
            db.query(models.MeetTarget).filter(models.MeetTarget.swimmer_id == swimmer_id).delete()
            db.query(models.Meet).filter(models.Meet.id == meet_id).delete()
            db.query(models.PoolSlot).filter(models.PoolSlot.id == slot_id).delete()
            db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).delete()
            db.commit()

    def test_raw_migration_types_are_portable_to_postgres(self):
        self.assertEqual(
            _portable_column_type("DATETIME", "postgresql"),
            "TIMESTAMP WITH TIME ZONE",
        )
        self.assertEqual(
            _portable_column_type("BOOLEAN DEFAULT 0", "postgresql"),
            "BOOLEAN DEFAULT FALSE",
        )
        self.assertEqual(_portable_column_type("DATETIME", "sqlite"), "DATETIME")

    def test_conversation_action_suggests_confirmed_profile_update_locally(self):
        swimmer = SimpleNamespace(id=42, name="Test Swimmer")
        action = _conversation_action(
            "She responds well to aerobic work but needs encouragement late in the week.",
            {"biological"},
            [
                {"role": "user", "content": "Let's discuss Test Swimmer."},
                {"role": "assistant", "content": "What have you noticed?"},
                {"role": "user", "content": "She responds well to aerobic work."},
            ],
            [swimmer],
        )
        self.assertEqual(action["intent"], "athlete_profile_update")
        self.assertEqual(action["swimmer_id"], 42)

    def test_confirmed_chat_profile_update_uses_one_incremental_synthesis(self):
        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Profile Chat Swimmer", squad="Agent Test")
            db.add(swimmer)
            db.commit()
            swimmer_id = swimmer.id

        with patch(
            "backend.routers.ai_chat.save_wizard_profile",
            return_value={"id": 99, "profile_type": "wizard"},
        ) as save_profile:
            response = self.client.post(
                "/ai-chat/actions/update-athlete-profile",
                headers=self.headers,
                json={
                    "swimmer_id": swimmer_id,
                    "messages": [
                        {"role": "user", "content": "She responds well to aerobic work."},
                        {"role": "assistant", "content": "I'll remember that once you confirm."},
                    ],
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(save_profile.call_args.kwargs["preserve_existing"])

        with SessionLocal() as db:
            db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).delete()
            db.commit()

    def test_agent_routes_short_factual_retrieval_to_fast_model(self):
        captured = {}

        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Resolver Alice", squad="Agent Test")
            db.add(swimmer)
            db.commit()
            swimmer_id = swimmer.id

        def fake_create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="No upcoming meet is stored.")],
                stop_reason="end_turn",
            )

        fake_client = SimpleNamespace(messages=SimpleNamespace(create=fake_create))
        with patch("backend.routers.ai_chat.get_client", return_value=fake_client):
            response = self.client.post(
                "/ai-chat/messages",
                headers=self.headers,
                json={"message": "What was Resolver Alice's latest time?"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["model_route"]["tier"], "fast")
        self.assertEqual(captured["model"], FAST_MODEL)
        self.assertEqual(captured["operation"], "general_agent_initial")
        self.assertIn(f"Resolver Alice: swimmer_id={swimmer_id}", captured["system"])
        self.assertIn("do not call find_swimmer", captured["system"])

        with SessionLocal() as db:
            db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).delete()
            db.commit()

    def test_adaptive_history_and_compact_context_preserve_planning_depth(self):
        self.assertEqual(_history_limit_for_thread(None), GENERAL_HISTORY)
        self.assertEqual(
            _history_limit_for_thread(SimpleNamespace(thread_type="athlete_planning")),
            ATHLETE_HISTORY,
        )
        self.assertEqual(
            _history_limit_for_thread(SimpleNamespace(thread_type="season_plan")),
            MAX_HISTORY,
        )

        long_text = "Detailed coaching context. " * 500
        profile = SimpleNamespace(
            summary=(
                long_text
                + "\n**Session Style & Preferences**\nThree practical training groups."
                + "\n**Intensity & Terminology**\nThreshold means controlled repeatability."
                + "\n**Key Coaching Priorities**\nLong-term athlete development."
            ),
            ethos="Develop the athlete before chasing short-term results. " * 20,
            squad_state="The squad is rebuilding aerobic consistency. " * 20,
            targets="Regional and national qualification pathways. " * 20,
            current_focus="Aerobic base with technical quality under fatigue. " * 20,
        )
        compact = _coaching_context_for_prompt(profile)
        self.assertLessEqual(len(compact), COACHING_CONTEXT_CHAR_LIMIT)
        self.assertIn("Coaching philosophy", compact)
        self.assertIn("Current focus", compact)
        self.assertEqual(_coaching_context_for_prompt(profile, full=True), profile.summary)

    def test_season_session_and_register_flows(self):
        swimmer = self.client.post(
            "/swimmers",
            headers=self.headers,
            json={"name": "Test Swimmer", "squad": "Performance"},
        )
        self.assertEqual(swimmer.status_code, 201, swimmer.text)
        swimmer_id = swimmer.json()["id"]

        macro = self.client.post(
            "/season/macros",
            headers=self.headers,
            json={
                "name": "2026/27 season",
                "squad": "Performance",
                "date_from": "2026-09-01",
                "date_to": "2027-07-31",
                "mesos": [{
                    "name": "Foundation",
                    "phase_type": "base",
                    "date_from": "2026-09-01",
                    "date_to": "2026-10-18",
                    "emphasis": {"aerobic": 60},
                }],
            },
        )
        self.assertEqual(macro.status_code, 201, macro.text)
        self.assertEqual(len(macro.json()["mesos"]), 1)
        self.assertEqual(macro.json()["mesos"][0]["date_from"], "2026-09-01")
        macro_id = macro.json()["id"]
        block_id = macro.json()["mesos"][0]["id"]

        micro = self.client.post(
            "/season/microcycles",
            headers=self.headers,
            json={
                "macro_id": macro_id,
                "block_id": block_id,
                "squad": "Performance",
                "week_start": "2026-09-07",
                "label": "Week 2 - Base loading",
                "sessions": [{"date": "2026-09-07", "day": "Monday", "session_type": "aerobic"}],
            },
        )
        self.assertEqual(micro.status_code, 201, micro.text)
        self.assertEqual(micro.json()["week_end"], "2026-09-13")
        micros = self.client.get(
            f"/season/microcycles?block_id={block_id}", headers=self.headers,
        )
        self.assertEqual(len(micros.json()), 1)

        meet = self.client.post(
            "/meets",
            headers=self.headers,
            json={"name": "Autumn Open", "date": "2026-09-19", "date_to": "2026-09-20"},
        )
        self.assertEqual(meet.status_code, 201, meet.text)
        meet_id = meet.json()["id"]
        timetable = self.client.post(
            f"/meets/{meet_id}/timetable",
            headers=self.headers,
            json={
                "name": "Saturday AM", "date": "2026-09-19",
                "warm_up_time": "08:00", "start_time": "09:00",
                "events": [{"number": "1", "name": "400 Freestyle"}],
            },
        )
        self.assertEqual(timetable.status_code, 201, timetable.text)
        meet_detail = self.client.get(f"/meets/{meet_id}", headers=self.headers)
        self.assertEqual(meet_detail.json()["timetable"][0]["events"][0]["name"], "400 Freestyle")

        session = self.client.post(
            "/sessions",
            headers=self.headers,
            json={
                "date": "2026-09-07",
                "title": "Aerobic development",
                "squad": "Performance",
                "groups": {
                    "1": {
                        "description": "Main group",
                        "sets": "3 x 800 aerobic",
                        "volume_breakdown": {"aerobic": 2400},
                    }
                },
            },
        )
        self.assertEqual(session.status_code, 201, session.text)
        session_id = session.json()["id"]

        register = self.client.put(
            f"/sessions/{session_id}/register",
            headers=self.headers,
            json={
                "run_ai": False,
                "entries": [{
                    "swimmer_id": swimmer_id,
                    "attended": True,
                    "group_done": 1,
                    "coach_observation": "Held form throughout.",
                }],
            },
        )
        self.assertEqual(register.status_code, 200, register.text)
        saved = self.client.get(f"/sessions/{session_id}/register", headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        entry = next(row for row in saved.json() if row["swimmer_id"] == swimmer_id)
        self.assertTrue(entry["attended"])
        self.assertEqual(entry["coach_observation"], "Held form throughout.")

        record_ai_usage(
            "anthropic", "claude-haiku-4-5-20251001", "test_call",
            input_tokens=1000, output_tokens=100,
        )
        usage = self.client.get("/ai-chat/usage?days=30", headers=self.headers)
        self.assertEqual(usage.status_code, 200, usage.text)
        self.assertIn("estimated_cost_usd", usage.json()["totals"])
        self.assertGreaterEqual(usage.json()["totals"]["calls"], 1)
        self.assertGreater(usage.json()["totals"]["estimated_cost_usd"], 0)
        self.assertTrue(any(
            row["operation"] == "test_call" for row in usage.json()["by_operation"]
        ))
        self.assertEqual(
            sum(row["calls"] for row in usage.json()["by_model"]),
            usage.json()["totals"]["calls"],
        )
        self.assertEqual(
            sum(row["calls"] for row in usage.json()["by_operation"]),
            usage.json()["totals"]["calls"],
        )
        self.assertEqual(usage.json()["configuration"]["planning_effort"], "high")
        self.assertEqual(
            usage.json()["configuration"]["history_limits"]["general"],
            GENERAL_HISTORY,
        )

    def test_season_rollover_builds_attendance_baseline_without_erasing_history(self):
        start = date.today() - timedelta(days=3)
        end = start.replace(year=start.year + 1)
        with SessionLocal() as db:
            original_macro_seasons = {
                macro.id: macro.season_id for macro in db.query(models.TrainingMacro).all()
            }
            original_current_season_ids = {
                season.id for season in db.query(models.Season).filter(models.Season.is_current.is_(True)).all()
            }
            swimmer = models.Swimmer(name="Rollover Baseline Swimmer", squad="Silver 1")
            db.add(swimmer)
            db.flush()
            swimmer_id = swimmer.id
            historical_time = models.SwimTime(
                swimmer_id=swimmer_id, event="100 Freestyle SCM", course="SCM",
                distance=100, stroke="Freestyle", time_seconds=70.0,
                date=start - timedelta(days=30),
            )
            old_macro = models.TrainingMacro(
                name="Old season macro", date_from=start - timedelta(days=100),
                date_to=start - timedelta(days=1),
            )
            current_macro = models.TrainingMacro(
                name="New season macro", date_from=start, date_to=end,
            )
            db.add_all([historical_time, old_macro, current_macro])
            db.flush()
            old_recommendation = models.PlanningRecommendation(
                macro_id=old_macro.id, kind="old_test", severity="warning",
                title="Old concern", detail="Belongs to the old season",
                fingerprint=f"rollover-test-{swimmer_id}", status="open",
            )
            historical_session = models.Session(
                date=start - timedelta(days=1), squad="Silver 1", status="completed",
            )
            db.add_all([old_recommendation, historical_session])
            db.flush()
            db.add(models.SessionEntry(
                session_id=historical_session.id, swimmer_id=swimmer_id, attended=False,
            ))
            db.commit()
            old_macro_id = old_macro.id
            current_macro_id = current_macro.id
            old_recommendation_id = old_recommendation.id
            historical_time_id = historical_time.id

        before = self.client.get("/dashboard/squad-pulse", headers=self.headers)
        self.assertEqual(before.status_code, 200, before.text)
        row = next(item for item in before.json() if item["id"] == swimmer_id)
        self.assertEqual(row["attendance_state"], "season_not_started")
        self.assertEqual(row["sessions_expected"], 0)

        started = self.client.post(
            "/planning-agent/seasons/start", headers=self.headers,
            json={
                "name": "Rollover Test Season", "squad": "Silver 1",
                "date_from": start.isoformat(), "date_to": end.isoformat(),
                "narrative": "Build a clean opening baseline.", "is_current": True,
            },
        )
        self.assertEqual(started.status_code, 201, started.text)
        self.assertGreaterEqual(started.json()["linked_macros"], 1)
        self.assertGreaterEqual(started.json()["resolved_old_recommendations"], 1)
        season_id = started.json()["id"]

        with SessionLocal() as db:
            self.assertIsNotNone(db.get(models.SwimTime, historical_time_id))
            self.assertEqual(db.get(models.TrainingMacro, current_macro_id).season_id, season_id)
            recommendation = db.get(models.PlanningRecommendation, old_recommendation_id)
            self.assertEqual(recommendation.status, "resolved")
            self.assertTrue(any(event.event_type == "season_rollover_resolved" for event in recommendation.events))
            db.add(models.SwimmerException(
                swimmer_id=swimmer_id, reason="holiday",
                date_from=start, date_to=start, notes="Excused opening-day absence",
            ))
            excused_session = models.Session(
                date=start, squad="Silver 1", status="completed",
            )
            db.add(excused_session)
            db.flush()
            db.add(models.SessionEntry(
                session_id=excused_session.id, swimmer_id=swimmer_id, attended=False,
            ))
            for index in range(3):
                session = models.Session(
                    date=start + timedelta(days=index), squad="Silver 1", status="completed",
                )
                db.add(session)
                db.flush()
                db.add(models.SessionEntry(
                    session_id=session.id, swimmer_id=swimmer_id, attended=index == 0,
                ))
            db.commit()

        building = self.client.get("/dashboard/squad-pulse", headers=self.headers).json()
        row = next(item for item in building if item["id"] == swimmer_id)
        self.assertEqual(row["attendance_state"], "building_baseline")
        self.assertEqual(row["sessions_expected"], 3)
        self.assertEqual(row["sessions_attended"], 1)
        self.assertEqual(row["sessions_excused"], 1)

        with SessionLocal() as db:
            session = models.Session(date=date.today(), squad="Silver 1", status="completed")
            db.add(session)
            db.flush()
            db.add(models.SessionEntry(session_id=session.id, swimmer_id=swimmer_id, attended=False))
            db.commit()

        established = self.client.get("/dashboard/squad-pulse", headers=self.headers).json()
        row = next(item for item in established if item["id"] == swimmer_id)
        self.assertEqual(row["attendance_state"], "established")
        self.assertEqual(row["sessions_expected"], 4)
        self.assertEqual(row["sessions_attended"], 1)

        with SessionLocal() as db:
            session_ids = [item[0] for item in db.query(models.Session.id).join(
                models.SessionEntry, models.SessionEntry.session_id == models.Session.id,
            ).filter(models.SessionEntry.swimmer_id == swimmer_id).all()]
            db.query(models.SessionEntry).filter(models.SessionEntry.swimmer_id == swimmer_id).delete()
            db.query(models.SwimmerException).filter(models.SwimmerException.swimmer_id == swimmer_id).delete()
            db.query(models.Session).filter(models.Session.id.in_(session_ids)).delete(synchronize_session=False)
            db.query(models.PlanningRecommendationEvent).filter(
                models.PlanningRecommendationEvent.recommendation_id == old_recommendation_id,
            ).delete()
            db.query(models.PlanningRecommendation).filter(
                models.PlanningRecommendation.id == old_recommendation_id,
            ).delete()
            db.query(models.SwimTime).filter(models.SwimTime.id == historical_time_id).delete()
            db.query(models.TrainingMacro).filter(
                models.TrainingMacro.id.in_([old_macro_id, current_macro_id]),
            ).delete(synchronize_session=False)
            for macro_id, prior_season_id in original_macro_seasons.items():
                macro = db.get(models.TrainingMacro, macro_id)
                if macro:
                    macro.season_id = prior_season_id
            db.flush()
            db.query(models.Season).filter(models.Season.id == season_id).delete()
            if original_current_season_ids:
                db.query(models.Season).filter(
                    models.Season.id.in_(original_current_season_ids),
                ).update({"is_current": True}, synchronize_session=False)
            db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).delete()
            db.commit()

    def test_combined_workbook_imports_roster_and_replaces_times(self):
        legacy = self.client.post(
            "/swimmers",
            headers=self.headers,
            json={"name": "Legacy Missing", "gender": "F"},
        )
        self.assertEqual(legacy.status_code, 201, legacy.text)
        legacy_id = legacy.json()["id"]

        workbook = io.BytesIO()
        pd.DataFrame([
            {
                "Time": "55.25", "WA Pts": 400, "Round": "H", "Date": "2026-06-01",
                "Meet": "Test Meet", "Venue": "Test Pool", "Club": "Test Club", "Level": 3,
                "Name": "Combined One", "ID": 900001, "Stroke": "50 Freestyle", "Course": "S",
                "Split 1": None, "Gender": "F", "Age": 15.2, "WA Points/Age": 26.3,
                "DoB": "2011-03-02",
            },
            {
                "Time": "1:02.50", "WA Pts": 380, "Round": "F", "Date": "2026-06-02",
                "Meet": "Test Meet", "Venue": "Test Pool", "Club": "Test Club", "Level": 3,
                "Name": "Combined Two", "ID": 900002, "Stroke": "100 Backstroke", "Course": "L",
                "Split 1": "30.00", "Gender": "M", "Age": 14.5, "WA Points/Age": 25.1,
                "DoB": "2011-11-12",
            },
            {
                "Time": "1:02.50", "WA Pts": 380, "Round": "F", "Date": "2026-06-02",
                "Meet": "Test Meet", "Venue": "Test Pool", "Club": "Test Club", "Level": 3,
                "Name": "Combined Two", "ID": 900002, "Stroke": "100 Backstroke", "Course": "L",
                "Split 1": "30.00", "Gender": "M", "Age": 14.5, "WA Points/Age": 25.1,
                "DoB": "2011-11-12",
            },
        ]).to_excel(workbook, index=False)
        payload = workbook.getvalue()

        tracker_payload = (
            "ID,Swimmer Name,Homeclub,CS Start Date\n"
            "900001,Combined One,Y,2024-09-01\n"
            "900002,Combined Two,,2025-01-15\n"
        ).encode()

        def upload(include_tracker=False):
            files = {
                "file": ("combined.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            }
            if include_tracker:
                files["tracker_file"] = ("tracker.csv", tracker_payload, "text/csv")
            return self.client.post(
                "/times/import/combined",
                headers=self.headers,
                data={"squad": "Silver 1", "replace_existing": "true"},
                files=files,
            )

        first = upload(include_tracker=True)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["members_in_file"], 2)
        self.assertEqual(first.json()["times_imported"], 2)
        self.assertEqual(first.json()["duplicate_rows_skipped"], 1)
        self.assertEqual(first.json()["swimmers_marked_inactive"], 1)
        self.assertEqual(first.json()["tracker_members_matched"], 2)
        legacy_after = self.client.get(f"/swimmers/{legacy_id}", headers=self.headers)
        self.assertEqual(legacy_after.status_code, 200, legacy_after.text)
        self.assertFalse(legacy_after.json()["active"])

        second = upload()
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["times_replaced"], 2)
        self.assertEqual(second.json()["times_imported"], 2)

        swimmers = self.client.get("/swimmers", headers=self.headers).json()
        combined_one = next(swimmer for swimmer in swimmers if swimmer["name"] == "Combined One")
        self.assertEqual(combined_one["squad"], "Silver 1")
        combined_one_detail = self.client.get(f"/swimmers/{combined_one['id']}", headers=self.headers).json()
        self.assertIn("Home club swimmer: Yes", combined_one_detail["profile_notes"])
        self.assertIn("Squad start: 2024-09-01", combined_one_detail["profile_notes"])
        times = self.client.get(f"/swimmers/{combined_one['id']}/times", headers=self.headers).json()
        self.assertEqual(times[0]["event"], "50 Freestyle SCM")
        self.assertEqual(times[0]["time_seconds"], 55.25)

    def test_planning_agent_persists_event_links_and_pathway_state(self):
        swimmer = self.client.post(
            "/swimmers", headers=self.headers,
            json={"name": "Pathway Swimmer", "squad": "Silver 1"},
        )
        self.assertEqual(swimmer.status_code, 201, swimmer.text)
        swimmer_id = swimmer.json()["id"]

        qualifier = self.client.post(
            "/meets", headers=self.headers,
            json={"name": "Regional Qualifier", "date": "2026-09-12"},
        )
        regional = self.client.post(
            "/meets", headers=self.headers,
            json={"name": "Winter Regionals", "date": "2026-11-07"},
        )
        self.assertEqual(qualifier.status_code, 201, qualifier.text)
        qualifier_id, regional_id = qualifier.json()["id"], regional.json()["id"]

        timetable = self.client.post(
            f"/meets/{qualifier_id}/timetable", headers=self.headers,
            json={"name": "Saturday AM", "date": "2026-09-12",
                  "events": [{"number": "3", "name": "100m Freestyle Girls"}]},
        )
        self.assertEqual(timetable.status_code, 201, timetable.text)
        target = self.client.post(
            f"/meets/{qualifier_id}/targets", headers=self.headers,
            json={"swimmer_id": swimmer_id, "events": ["100 Freestyle"], "priority": "A"},
        )
        self.assertEqual(target.status_code, 201, target.text)
        self.assertTrue(target.json()["scheduled_entries"][0]["timetable_linked"])
        self.assertEqual(target.json()["scheduled_entries"][0]["session"], "Saturday AM")

        macro = self.client.post(
            "/season/macros", headers=self.headers,
            json={"name": "Regional macro", "squad": "Silver 1",
                  "date_from": "2026-08-17", "date_to": "2026-11-15"},
        )
        self.assertEqual(macro.status_code, 201, macro.text)
        pathway = self.client.post(
            "/planning-agent/pathways", headers=self.headers,
            json={"macro_id": macro.json()["id"], "name": "Qualification chase",
                  "primary_meet_id": regional_id, "qualifier_meet_ids": [qualifier_id]},
        )
        self.assertEqual(pathway.status_code, 201, pathway.text)
        membership = self.client.put(
            f"/planning-agent/pathways/{pathway.json()['id']}/members", headers=self.headers,
            json=[{"swimmer_id": swimmer_id, "qualification_status": "chasing"}],
        )
        self.assertEqual(membership.status_code, 200, membership.text)

        refreshed = self.client.post(
            "/planning-agent/refresh", headers=self.headers,
            json={"macro_id": macro.json()["id"], "as_of_date": "2026-08-23"},
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        row = refreshed.json()["context"]["rows"][0]
        self.assertEqual(row["target_meet"], "Regional Qualifier")
        self.assertEqual(row["phase"], "race_specific")
        self.assertIn("100 freestyle", row["events"])

    def test_planning_assistant_inbox_persists_decisions_discussion_and_auto_resolution(self):
        swimmer = self.client.post(
            "/swimmers", headers=self.headers,
            json={"name": "Inbox Swimmer", "squad": "Silver 1"},
        )
        macro = self.client.post(
            "/season/macros", headers=self.headers,
            json={"name": "Inbox macro", "squad": "Silver 1",
                  "date_from": "2026-08-01", "date_to": "2026-12-31"},
        )
        pathway = self.client.post(
            "/planning-agent/pathways", headers=self.headers,
            json={"macro_id": macro.json()["id"], "name": "Inbox pathway"},
        )
        membership = self.client.put(
            f"/planning-agent/pathways/{pathway.json()['id']}/members", headers=self.headers,
            json=[{"swimmer_id": swimmer.json()["id"], "qualification_status": "unknown"}],
        )
        self.assertEqual(membership.status_code, 200, membership.text)

        inbox = self.client.get(
            "/planning-agent/inbox?include_snoozed=true&include_closed=true",
            headers=self.headers,
        )
        self.assertEqual(inbox.status_code, 200, inbox.text)
        item = next(
            row for row in inbox.json()["items"]
            if row["swimmer_id"] == swimmer.json()["id"] and row["kind"] == "missing_target"
        )
        self.assertEqual(item["status"], "open")
        self.assertEqual(item["swimmer_name"], "Inbox Swimmer")

        follow_up = datetime.now(timezone.utc) + timedelta(days=7)
        snoozed = self.client.patch(
            f"/planning-agent/recommendations/{item['id']}", headers=self.headers,
            json={"status": "snoozed", "follow_up_at": follow_up.isoformat(),
                  "coach_note": "Check after the qualifying meet."},
        )
        self.assertEqual(snoozed.status_code, 200, snoozed.text)
        self.assertEqual(snoozed.json()["status"], "snoozed")
        self.assertTrue(any(event["event_type"] == "status_changed" for event in snoozed.json()["history"]))

        discussed = self.client.post(
            f"/planning-agent/recommendations/{item['id']}/discuss", headers=self.headers,
        )
        self.assertEqual(discussed.status_code, 200, discussed.text)
        self.assertIsNotNone(discussed.json()["thread_id"])
        self.assertEqual(discussed.json()["recommendation"]["status"], "in_progress")
        messages = self.client.get(
            f"/ai-chat/messages?thread_id={discussed.json()['thread_id']}", headers=self.headers,
        )
        self.assertEqual(messages.status_code, 200, messages.text)
        self.assertEqual(len(messages.json()), 2)

        meet = self.client.post(
            "/meets", headers=self.headers,
            json={"name": "Inbox target meet", "date": "2026-11-21"},
        )
        updated = self.client.patch(
            f"/planning-agent/pathways/{pathway.json()['id']}", headers=self.headers,
            json={"primary_meet_id": meet.json()["id"]},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        history = self.client.get(
            "/planning-agent/inbox?include_snoozed=true&include_closed=true&refresh=false",
            headers=self.headers,
        ).json()["items"]
        resolved = next(row for row in history if row["id"] == item["id"])
        self.assertEqual(resolved["status"], "resolved")

    def test_qualification_pdf_is_reviewed_stored_and_compared_locally(self):
        swimmer = self.client.post(
            "/swimmers", headers=self.headers,
            json={"name": "Qualification Swimmer", "squad": "Silver 1", "gender": "F", "dob": "2012-03-01"},
        )
        self.assertEqual(swimmer.status_code, 201, swimmer.text)
        swimmer_id = swimmer.json()["id"]
        with SessionLocal() as db:
            db.add(models.SwimTime(
                swimmer_id=swimmer_id, event="100 Freestyle SCM", distance=100,
                stroke="Freestyle", course="SCM", time_seconds=65.0,
                date=__import__('datetime').date(2026, 8, 1), level="3",
            ))
            db.commit()

        meet = self.client.post(
            "/meets", headers=self.headers,
            json={"name": "Standards Meet", "date": "2026-10-17"},
        )
        extracted = {
            "metadata": {"name": "2026 Standards", "organiser": "Test County", "season_label": "2026"},
            "rules": {
                "age_as_of_date": "2026-12-31", "minimum_age": 12,
                "qualification_window_start": "2025-10-21", "qualification_window_end": "2026-09-30",
                "accepted_license_levels": [1, 2, 3, 4], "long_course_conversions_accepted": True,
                "conversion_method": "Sportsystems", "entry_is_guaranteed": False,
            },
            "standards": [
                {"event_name": "100 Freestyle", "gender": "female", "age_label": "open", "course": "SCM", "standard_type": "automatic", "time": "1:04.00"},
                {"event_name": "100 Freestyle", "gender": "female", "age_label": "open", "course": "SCM", "standard_type": "consideration", "time": "1:06.00"},
            ],
            "warnings": [],
        }
        with patch("backend.routers.qualification_standards.openai_service.parse_qualification_document", return_value=extracted):
            uploaded = self.client.post(
                "/qualification-standards/extract", headers=self.headers,
                data={"meet_id": str(meet.json()["id"])},
                files={"document": ("standards.pdf", b"%PDF-test", "application/pdf")},
            )
        self.assertEqual(uploaded.status_code, 201, uploaded.text)
        self.assertEqual(uploaded.json()["status"], "draft")
        self.assertEqual(uploaded.json()["standard_count"], 2)
        confirmed = self.client.post(
            f"/qualification-standards/{uploaded.json()['id']}/confirm", headers=self.headers,
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        compared = self.client.get(
            f"/qualification-standards/{uploaded.json()['id']}/assessments", headers=self.headers,
        )
        result = next(row for row in compared.json()["swimmers"] if row["swimmer_id"] == swimmer_id)
        self.assertEqual(result["qualification_status"], "consideration")
        achieved = next(event for event in result["events"] if event["standard_type"] == "consideration")
        self.assertEqual(achieved["status"], "achieved")
        self.assertEqual(achieved["gap_seconds"], -1.0)

        macro = self.client.post(
            "/season/macros", headers=self.headers,
            json={"name": "Standards-linked macro", "date_from": "2026-08-01", "date_to": "2026-10-31"},
        )
        pathway = self.client.post(
            "/planning-agent/pathways", headers=self.headers,
            json={"macro_id": macro.json()["id"], "name": "Winter pathway",
                  "primary_meet_id": meet.json()["id"],
                  "qualification_standard_set_id": uploaded.json()["id"]},
        )
        self.client.put(
            f"/planning-agent/pathways/{pathway.json()['id']}/members", headers=self.headers,
            json=[{"swimmer_id": swimmer_id, "qualification_status": "unknown"}],
        )
        planning = self.client.post(
            "/planning-agent/refresh", headers=self.headers,
            json={"macro_id": macro.json()["id"], "as_of_date": "2026-08-24"},
        )
        plan_row = next(row for row in planning.json()["context"]["rows"] if row["swimmer_id"] == swimmer_id)
        self.assertEqual(plan_row["qualification"], "consideration")
        self.assertIn("consideration_not_guaranteed", plan_row["flags"])

    def test_invalid_season_date_order_is_rejected(self):
        response = self.client.post(
            "/season/blocks",
            headers=self.headers,
            json={
                "name": "Invalid",
                "date_from": "2027-01-10",
                "date_to": "2027-01-01",
            },
        )
        self.assertEqual(response.status_code, 422, response.text)

    def test_old_chat_history_rolls_into_bounded_memory(self):
        with SessionLocal() as db:
            thread = models.AIThread(name="Long season", thread_type="season_plan")
            db.add(thread)
            db.flush()
            for index in range(MAX_HISTORY + 3):
                db.add(models.CoachAIMessage(
                    thread_id=thread.id,
                    role="user" if index % 2 == 0 else "assistant",
                    message=f"Planning decision {index}",
                ))
            db.commit()
            recent = db.query(models.CoachAIMessage).filter(
                models.CoachAIMessage.thread_id == thread.id,
            ).order_by(models.CoachAIMessage.id.desc()).limit(MAX_HISTORY).all()
            recent.reverse()

            fake_response = SimpleNamespace(
                content=[SimpleNamespace(text="- Decision: retain the agreed autumn base phase")],
            )
            fake_client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: fake_response))
            with patch("backend.routers.ai_chat.get_client", return_value=fake_client):
                memory = _thread_memory(thread, recent, db)

            self.assertIn("ROLLING THREAD MEMORY", memory)
            self.assertIn("autumn base phase", memory)
            self.assertIsNotNone(thread.summarized_through_message_id)


if __name__ == "__main__":
    unittest.main()
