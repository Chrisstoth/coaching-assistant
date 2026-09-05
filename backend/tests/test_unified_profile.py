import json
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_db_file = tempfile.NamedTemporaryFile(prefix="lanewatch-profile-test-", suffix=".db", delete=False)
_db_file.close()
Path(_db_file.name).unlink(missing_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_db_file.name).as_posix()}"
os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.services import ai_operations, claude_service  # noqa: E402
from backend.services.profile_status import build_profile_status  # noqa: E402
from backend.tests import reset_database  # noqa: E402


def _fake_response(payload: dict):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(payload))],
        usage=SimpleNamespace(input_tokens=10, output_tokens=10),
    )


PROFILE_PAYLOAD = {
    "race": {"pacing_tendency": "Goes out fast over 100s."},
    "training": {"aerobic": "Holds pace to two-thirds of long sets."},
    "biological": {"summary": "Mid-puberty; growing."},
    "technical": {"technical_limiters": "Underwaters off walls two and three."},
    "cross_domain": "Growth phase shows up as stroke-length drift under fatigue.",
    "confidence": "moderate",
    "change_summary": "Initial profile.",
}


class UnifiedProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    @classmethod
    def tearDownClass(cls):
        engine.dispose()
        Path(_db_file.name).unlink(missing_ok=True)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Test Swimmer", squad="Silver", status="active")
            db.add(swimmer)
            db.commit()
            self.swimmer_id = swimmer.id

    def _add_observations(self, count, obs_type="aerobic", days_ago_start=60):
        with SessionLocal() as db:
            for i in range(count):
                db.add(models.SwimmerObservation(
                    swimmer_id=self.swimmer_id,
                    obs_type=obs_type,
                    date=date.today() - timedelta(days=days_ago_start - i),
                    content=f"Observation {i} about how this swimmer trained.",
                ))
            db.commit()

    # -- freshness -----------------------------------------------------------

    def test_freshness_reports_every_observation_as_new_before_any_profile(self):
        self._add_observations(12)
        with SessionLocal() as db:
            freshness = claude_service.unified_profile_freshness(self.swimmer_id, db)
        self.assertFalse(freshness["has_profile"])
        self.assertEqual(freshness["observations_total"], 12)
        self.assertEqual(freshness["observations_since"], 12)
        self.assertTrue(freshness["stale"])

    def test_profile_goes_stale_only_once_enough_new_evidence_arrives(self):
        self._add_observations(10)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        with SessionLocal() as db:
            fresh = claude_service.unified_profile_freshness(self.swimmer_id, db)
        self.assertTrue(fresh["has_profile"])
        self.assertEqual(fresh["observations_since"], 0)
        self.assertFalse(fresh["stale"])

        # A couple of new sessions is not yet worth a synthesis call.
        self._add_observations(3, days_ago_start=5)
        with SessionLocal() as db:
            fresh = claude_service.unified_profile_freshness(self.swimmer_id, db)
        self.assertEqual(fresh["observations_since"], 3)
        self.assertFalse(fresh["stale"])

        self._add_observations(6, obs_type="speed", days_ago_start=4)
        with SessionLocal() as db:
            fresh = claude_service.unified_profile_freshness(self.swimmer_id, db)
        self.assertEqual(fresh["observations_since"], 9)
        self.assertTrue(fresh["stale"])

    def test_bulk_freshness_matches_the_single_swimmer_reading(self):
        self._add_observations(10)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        self._add_observations(9, obs_type="threshold", days_ago_start=3)
        with SessionLocal() as db:
            single = claude_service.unified_profile_freshness(self.swimmer_id, db)
            bulk = claude_service.unified_profile_freshness_bulk([self.swimmer_id], db)
        self.assertEqual(bulk[self.swimmer_id]["observations_since"], single["observations_since"])
        self.assertEqual(bulk[self.swimmer_id]["stale"], single["stale"])

    # -- incremental synthesis ----------------------------------------------

    def test_incremental_pass_sends_only_new_observations_and_the_prior_profile(self):
        self._add_observations(20, days_ago_start=90)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        self._add_observations(9, obs_type="speed", days_ago_start=5)

        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ) as call:
            result = claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="incremental",
            )
            prompt = call.call_args.kwargs["messages"][0]["content"]

        self.assertIn("NEW OBSERVATIONS since the previous profile", prompt)
        self.assertIn("9 of 29 total on record", prompt)
        self.assertIn("PREVIOUS PROFILE", prompt)
        # The prior profile carries the old evidence forward, so the raw text of
        # the earlier observations does not need resending.
        self.assertIn("Goes out fast over 100s.", prompt)
        self.assertEqual(result["data"]["_synthesis"]["mode"], "incremental")
        self.assertEqual(result["data"]["_synthesis"]["new_observations"], 9)
        # The watermark records everything folded in, not just this slice.
        self.assertEqual(result["obs_count"], 29)

    def test_full_rebuild_resends_the_whole_record(self):
        self._add_observations(15)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ) as call:
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
            prompt = call.call_args.kwargs["messages"][0]["content"]
        self.assertIn("ALL OBSERVATIONS on record (15)", prompt)

    def test_malformed_refresh_leaves_the_existing_profile_intact(self):
        self._add_observations(10)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        broken = SimpleNamespace(
            content=[SimpleNamespace(type="text", text="not json at all")],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )
        with SessionLocal() as db, patch.object(claude_service, "create_message", return_value=broken):
            with self.assertRaises(ValueError):
                claude_service.synthesise_swimmer_profile(
                    db.query(models.Swimmer).get(self.swimmer_id), db, mode="incremental",
                )
        with SessionLocal() as db:
            versions = db.query(models.SwimmerProfileVersion).filter(
                models.SwimmerProfileVersion.swimmer_id == self.swimmer_id,
            ).all()
        self.assertEqual(len(versions), 1)
        self.assertEqual(versions[0].data["race"]["pacing_tendency"], "Goes out fast over 100s.")

    # -- the auto-trigger ----------------------------------------------------

    def test_new_evidence_queues_a_refresh_and_repeat_evidence_does_not(self):
        self._add_observations(12)
        with SessionLocal() as db:
            ai_operations.queue_profile_refresh(
                db, self.swimmer_id, "Test Swimmer", reason="new evidence",
            )
            db.commit()
            queued = db.query(models.AIOperation).filter(
                models.AIOperation.operation_type == "profile_refresh",
            ).all()
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].entity_id, self.swimmer_id)

        # A second trigger while one is already pending must not stack up.
        with SessionLocal() as db:
            ai_operations.queue_profile_refresh(
                db, self.swimmer_id, "Test Swimmer", reason="new evidence again",
            )
            db.commit()
            self.assertEqual(db.query(models.AIOperation).filter(
                models.AIOperation.operation_type == "profile_refresh",
            ).count(), 1)

    def test_session_assessment_queues_a_refresh_only_for_new_evidence(self):
        """The assessment's own profile_evidence verdict drives the refresh.

        This is the link that makes the profile self-maintaining: without it a
        coach has to remember to re-synthesise, and in practice never does.
        """
        self._add_observations(12)
        with SessionLocal() as db:
            other = models.Swimmer(name="Repeat Evidence", squad="Silver", status="active")
            db.add(other)
            db.commit()
            other_id = other.id
            for i in range(12):
                db.add(models.SwimmerObservation(
                    swimmer_id=other_id, obs_type="aerobic",
                    date=date.today() - timedelta(days=i),
                    content=f"Observation {i}.",
                ))
            session = models.Session(date=date.today(), squad="Silver", status="completed")
            db.add(session)
            db.commit()
            session_id = session.id
            for swimmer_id in (self.swimmer_id, other_id):
                db.add(models.SessionEntry(
                    session_id=session_id, swimmer_id=swimmer_id, attended=True,
                    coach_observation="Held pace through the main set.",
                ))
            row = models.AIOperation(
                operation_type="session_assessment", title="Assess",
                entity_type="session", entity_id=session_id, status="queued",
                payload={"execution": "background"},
                available_at=ai_operations.utcnow(),
            )
            db.add(row)
            db.commit()
            operation_id = row.id

        assessments = {
            self.swimmer_id: {
                "observed_response": "Stroke length held.",
                "profile_evidence": "new evidence",
            },
            other_id: {
                "observed_response": "As expected.",
                "profile_evidence": "repeated evidence",
            },
        }
        with patch.object(
            claude_service, "generate_session_predictions", return_value=[],
        ), patch.object(
            claude_service, "characterise_session_entries_batch", return_value=assessments,
        ):
            self.assertTrue(ai_operations.process_operation(operation_id))

        with SessionLocal() as db:
            queued = db.query(models.AIOperation).filter(
                models.AIOperation.operation_type == "profile_refresh",
            ).all()
            result = db.query(models.AIOperation).get(operation_id).result_summary
        self.assertEqual([row.entity_id for row in queued], [self.swimmer_id])
        self.assertIn("Queued 1 profile update", result)

    def test_refresh_operation_is_skipped_when_the_profile_is_already_current(self):
        self._add_observations(10)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        with SessionLocal() as db:
            row = ai_operations.enqueue_operation(
                db, operation_type="profile_refresh", title="Update profile",
                entity_type="swimmer", entity_id=self.swimmer_id,
            )
            db.commit()
            operation_id = row.id
        with patch.object(claude_service, "create_message") as call:
            self.assertTrue(ai_operations.process_operation(operation_id))
        call.assert_not_called()
        with SessionLocal() as db:
            row = db.query(models.AIOperation).get(operation_id)
        self.assertEqual(row.status, "completed")
        self.assertIn("already up to date", row.result_summary)

    def test_queued_refresh_runs_and_writes_a_new_version(self):
        self._add_observations(14)
        with SessionLocal() as db:
            ai_operations.queue_profile_refresh(
                db, self.swimmer_id, "Test Swimmer", reason="new evidence",
            )
            db.commit()
            operation_id = db.query(models.AIOperation).filter(
                models.AIOperation.operation_type == "profile_refresh",
            ).one().id
        with patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            self.assertTrue(ai_operations.process_operation(operation_id))
        with SessionLocal() as db:
            row = db.query(models.AIOperation).get(operation_id)
            versions = db.query(models.SwimmerProfileVersion).filter(
                models.SwimmerProfileVersion.swimmer_id == self.swimmer_id,
                models.SwimmerProfileVersion.profile_type == "unified",
            ).count()
        self.assertEqual(row.status, "completed")
        self.assertEqual(versions, 1)
        self.assertIn("folding in 14 observations", row.result_summary)

    # -- context assembly ----------------------------------------------------

    def test_every_observation_type_survives_a_periodised_season(self):
        """A block-structured season must not push whole domains out of context.

        Sixty aerobic observations from the base block followed by forty speed
        observations in the taper: a global recency limit would show only speed.
        """
        self._add_observations(60, obs_type="aerobic", days_ago_start=200)
        self._add_observations(40, obs_type="speed", days_ago_start=30)
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            context = claude_service.build_swimmer_context(swimmer, db)
        self.assertIn("Aerobic training responses", context)
        self.assertIn("Speed/Sprint responses", context)

    def test_unified_profile_replaces_the_single_domain_blocks_in_context(self):
        self._add_observations(10)
        with SessionLocal() as db:
            db.add(models.SwimmerProfileVersion(
                swimmer_id=self.swimmer_id, profile_type="training",
                data={"aerobic": "LEGACY TRAINING PROFILE MARKER"},
            ))
            db.commit()
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            self.assertIn("LEGACY TRAINING PROFILE MARKER",
                          claude_service.build_swimmer_context(swimmer, db))
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            context = claude_service.build_swimmer_context(swimmer, db)
        self.assertNotIn("LEGACY TRAINING PROFILE MARKER", context)
        self.assertIn("Swimmer profile (synthesised", context)
        self.assertIn("Goes out fast over 100s.", context)

    def test_stale_profile_is_flagged_to_the_model_and_to_the_coach(self):
        self._add_observations(10)
        with SessionLocal() as db, patch.object(
            claude_service, "create_message", return_value=_fake_response(PROFILE_PAYLOAD),
        ):
            claude_service.synthesise_swimmer_profile(
                db.query(models.Swimmer).get(self.swimmer_id), db, mode="full",
            )
        self._add_observations(15, obs_type="threshold", days_ago_start=10)
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            context = claude_service.build_swimmer_context(swimmer, db)
            status = build_profile_status(
                swimmer, {"unified"},
                claude_service.unified_profile_freshness(self.swimmer_id, db),
            )
        self.assertIn("15 observations recorded since this was built", context)
        self.assertTrue(status["stale"])
        self.assertEqual(status["observations_since_profile"], 15)
        self.assertEqual(status["next_action"], "Update profile")

    def test_prior_assessment_is_compacted_to_the_two_useful_fields(self):
        raw = json.dumps({
            "observed_response": "Held pace to rep six.",
            "prediction_comparison": "partly_confirmed",
            "fatigue_and_recovery": "Moderate cost.",
            "next_session_action": "Shorten the rest.",
            "future_watchpoint": "Does length hold past six?",
            "profile_evidence": "new evidence",
            "confidence": "moderate",
        })
        compact = claude_service._compact_prior_assessment(raw)
        self.assertEqual(set(compact), {"observed_response", "prediction_comparison"})
        self.assertIsNone(claude_service._compact_prior_assessment(None))
        self.assertEqual(claude_service._compact_prior_assessment("plain text"), "plain text")


if __name__ == "__main__":
    unittest.main()
