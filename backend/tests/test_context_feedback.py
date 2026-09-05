"""Tests for the loops that feed work back into what the assistant sees:
specialist skill runs, coach check-ins, and the AI spend meter."""
import json
import os
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from backend.database import SessionLocal, engine  # noqa: E402
from backend import models  # noqa: E402
from backend.routers import coach_checkins  # noqa: E402
from backend.services import claude_service  # noqa: E402
from backend.tests import reset_database  # noqa: E402


def _reply(text: str):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=5, output_tokens=5),
    )


class SkillOutputContextTests(unittest.TestCase):
    """Specialist analyses must reach the assistant, not just a history screen."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            swimmer = models.Swimmer(name="Skill Context Swimmer", squad="Test", status="active")
            db.add(swimmer)
            db.commit()
            self.swimmer_id = swimmer.id

    def tearDown(self):
        reset_database()

    def test_recent_skill_runs_appear_in_the_swimmer_context(self):
        with SessionLocal() as db:
            db.add(models.SkillOutput(
                skill_type="taper_plan", swimmer_id=self.swimmer_id,
                entity_type="swimmer", entity_name="Skill Context Swimmer",
                full_output="A long taper analysis that should not be carried whole.",
                brief_output="**Recommendation** Drop volume 40% from ten days out.",
            ))
            db.commit()
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            context = claude_service.build_swimmer_context(swimmer, db)
        self.assertIn("Specialist analyses already run", context)
        self.assertIn("Taper plan", context)
        self.assertIn("Drop volume 40% from ten days out.", context)
        # The brief is carried, not the full analysis.
        self.assertNotIn("should not be carried whole", context)

    def test_only_the_most_recent_runs_are_carried(self):
        with SessionLocal() as db:
            for i in range(7):
                db.add(models.SkillOutput(
                    skill_type="block_review", swimmer_id=self.swimmer_id,
                    brief_output=f"Review number {i}.",
                    full_output=f"Review number {i}.",
                    created_at=datetime.now(timezone.utc) - timedelta(days=7 - i),
                ))
            db.commit()
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            context = claude_service.build_swimmer_context(swimmer, db)
        self.assertIn("Review number 6.", context)
        self.assertNotIn("Review number 0.", context)

    def test_a_swimmer_with_no_skill_runs_gets_no_section(self):
        with SessionLocal() as db:
            swimmer = db.query(models.Swimmer).get(self.swimmer_id)
            context = claude_service.build_swimmer_context(swimmer, db)
        self.assertNotIn("Specialist analyses already run", context)


class CheckInProposalTests(unittest.TestCase):
    """A reflection should be able to change the profile — but only on request."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        with SessionLocal() as db:
            db.query(models.CoachingProfile).update({"is_current": False})
            profile = models.CoachingProfile(
                title="Test profile", summary="A squad in build phase.",
                ethos="Technique before volume.", squad_state="Mid-season, tired.",
                targets="County qualification for six swimmers.",
                current_focus="Aerobic base.", is_current=True,
            )
            checkin = models.CoachCheckIn(
                title="Mid-meso check-in", checkin_type="meso_midpoint",
                status="in_progress",
                messages=[{"role": "coach", "message": "I've shifted — volume first, then technique."}],
            )
            db.add_all([profile, checkin])
            db.commit()
            self.profile_id = profile.id
            self.checkin_id = checkin.id

    def tearDown(self):
        reset_database()

    def test_proposals_are_drafted_but_nothing_is_applied_automatically(self):
        proposal_json = json.dumps([{
            "field": "ethos",
            "proposed": "Volume first, technique layered on top.",
            "rationale": "The coach said they have shifted their order of priorities.",
            "confidence": "high",
        }])
        with SessionLocal() as db:
            row = db.query(models.CoachCheckIn).get(self.checkin_id)
            with patch.object(
                coach_checkins, "get_client",
                return_value=SimpleNamespace(messages=SimpleNamespace(
                    create=lambda **kw: _reply(proposal_json),
                )),
            ):
                proposals = coach_checkins._propose_profile_updates(row, db)
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["field"], "ethos")
        self.assertEqual(proposals[0]["status"], "pending")
        self.assertEqual(proposals[0]["current"], "Technique before volume.")

        # The stored profile is untouched until the coach accepts.
        with SessionLocal() as db:
            current = db.query(models.CoachingProfile).filter(
                models.CoachingProfile.is_current == True,  # noqa: E712
            ).one()
        self.assertEqual(current.ethos, "Technique before volume.")

    def test_a_proposal_matching_what_is_stored_is_discarded(self):
        unchanged = json.dumps([{
            "field": "ethos", "proposed": "Technique before volume.",
            "rationale": "Restates the existing ethos.", "confidence": "low",
        }])
        with SessionLocal() as db:
            row = db.query(models.CoachCheckIn).get(self.checkin_id)
            with patch.object(
                coach_checkins, "get_client",
                return_value=SimpleNamespace(messages=SimpleNamespace(
                    create=lambda **kw: _reply(unchanged),
                )),
            ):
                proposals = coach_checkins._propose_profile_updates(row, db)
        self.assertEqual(proposals, [])

    def test_a_failed_proposal_call_does_not_lose_the_reflection(self):
        with SessionLocal() as db:
            row = db.query(models.CoachCheckIn).get(self.checkin_id)
            with patch.object(
                coach_checkins, "get_client",
                return_value=SimpleNamespace(messages=SimpleNamespace(
                    create=lambda **kw: _reply("not json"),
                )),
            ):
                proposals = coach_checkins._propose_profile_updates(row, db)
        self.assertEqual(proposals, [])

    def test_accepting_a_proposal_creates_a_new_current_profile_version(self):
        with SessionLocal() as db:
            row = db.query(models.CoachCheckIn).get(self.checkin_id)
            row.status = "completed"
            row.proposals = [
                {"id": 0, "field": "ethos", "field_label": "philosophy",
                 "current": "Technique before volume.",
                 "proposed": "Volume first, technique layered on top.",
                 "rationale": "Coach said so.", "confidence": "high", "status": "pending"},
                {"id": 1, "field": "targets", "field_label": "targets",
                 "current": "County qualification for six swimmers.",
                 "proposed": "County qualification for ten swimmers.",
                 "rationale": "Speculative.", "confidence": "low", "status": "pending"},
            ]
            db.commit()

        with SessionLocal() as db:
            result = coach_checkins.apply_checkin_proposals(
                self.checkin_id, {"accepted_ids": [0]}, db,
            )
        self.assertEqual(result["applied_fields"], ["ethos"])

        with SessionLocal() as db:
            current = db.query(models.CoachingProfile).filter(
                models.CoachingProfile.is_current == True,  # noqa: E712
            ).one()
            row = db.query(models.CoachCheckIn).get(self.checkin_id)
            versions = db.query(models.CoachingProfile).filter(
                models.CoachingProfile.title.like("%Test profile%")
                | models.CoachingProfile.title.like("After check-in%"),
            ).count()
        # Accepted change applied; declined one left alone; history preserved.
        self.assertEqual(current.ethos, "Volume first, technique layered on top.")
        self.assertEqual(current.targets, "County qualification for six swimmers.")
        self.assertEqual(current.summary, "A squad in build phase.")
        self.assertEqual(versions, 2)
        self.assertIsNotNone(row.applied_at)
        self.assertEqual([item["status"] for item in row.proposals], ["accepted", "declined"])

    def test_applying_nothing_is_rejected(self):
        with SessionLocal() as db:
            row = db.query(models.CoachCheckIn).get(self.checkin_id)
            row.proposals = [{"id": 0, "field": "ethos", "proposed": "x", "status": "pending"}]
            db.commit()
        from fastapi import HTTPException
        with SessionLocal() as db:
            with self.assertRaises(HTTPException) as caught:
                coach_checkins.apply_checkin_proposals(self.checkin_id, {"accepted_ids": []}, db)
        self.assertEqual(caught.exception.status_code, 400)


class SystemPromptCacheTests(unittest.TestCase):
    """The cache breakpoint must sit between the stable and volatile halves."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def test_blocks_split_stable_prefix_from_volatile_tail(self):
        with SessionLocal() as db:
            blocks = claude_service.get_system_prompt_blocks(db, extra="PER-TURN EXTRA")
        self.assertEqual(blocks[0]["cache_control"], {"type": "ephemeral"})
        self.assertIn("knowledgeable coaching partner", blocks[0]["text"])
        self.assertNotIn("PER-TURN EXTRA", blocks[0]["text"])
        self.assertIn("PER-TURN EXTRA", blocks[-1]["text"])
        self.assertNotIn("cache_control", blocks[-1])

    def test_string_form_still_contains_everything(self):
        with SessionLocal() as db:
            text = claude_service.get_system_prompt(db, extra="PER-TURN EXTRA")
            blocks = claude_service.get_system_prompt_blocks(db, extra="PER-TURN EXTRA")
        self.assertEqual(text, "\n\n".join(block["text"] for block in blocks))

    def test_a_prompt_with_no_volatile_tail_is_a_single_cached_block(self):
        with SessionLocal() as db:
            blocks = claude_service.get_system_prompt_blocks(db, include_pending_ai_work=False)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["cache_control"], {"type": "ephemeral"})


if __name__ == "__main__":
    unittest.main()
