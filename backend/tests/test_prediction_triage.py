"""Who gets a full brief before a session, and why."""
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
from backend.services import claude_service  # noqa: E402
from backend.tests import reset_database  # noqa: E402


class PredictionTriageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        self.today = date.today()
        with SessionLocal() as db:
            self.swimmers = []
            for i in range(12):
                swimmer = models.Swimmer(
                    name=f"Swimmer {i:02d}", squad="Silver", status="active",
                )
                db.add(swimmer)
                db.flush()
                self.swimmers.append(swimmer.id)
            session = models.Session(
                date=self.today, squad="Silver", title="Today",
                energy_system_focus="threshold", status="active",
            )
            db.add(session)
            db.commit()
            self.session_id = session.id

    def tearDown(self):
        reset_database()

    def _give_history(self, swimmer_ids, count=5, briefed=True, characterisation=None):
        """Attended sessions before today, so these swimmers are not 'thin'."""
        with SessionLocal() as db:
            for offset in range(1, count + 1):
                prior = db.query(models.Session).filter(
                    models.Session.date == self.today - timedelta(days=offset * 2),
                ).first()
                if not prior:
                    prior = models.Session(
                        date=self.today - timedelta(days=offset * 2), squad="Silver",
                        energy_system_focus="aerobic", status="completed",
                    )
                    db.add(prior)
                    db.flush()
                for swimmer_id in swimmer_ids:
                    db.add(models.SessionEntry(
                        session_id=prior.id, swimmer_id=swimmer_id, attended=True,
                        ai_expected_response=json.dumps({"predicted_response": "x"}) if briefed else None,
                        ai_characterisation=characterisation,
                    ))
            db.commit()

    def _triage(self):
        with SessionLocal() as db:
            session = db.query(models.Session).get(self.session_id)
            swimmers = db.query(models.Swimmer).filter(
                models.Swimmer.id.in_(self.swimmers),
            ).order_by(models.Swimmer.name).all()
            selected, reasons = claude_service._triage_prediction_swimmers(swimmers, session, db)
        return [row.id for row in selected], reasons

    # -- the floor -----------------------------------------------------------

    def test_a_settled_squad_still_gets_four_briefed(self):
        """The case that made a flags-only rule useless: nobody flagged.

        With no load events, full history and confirmed predictions, a strict
        rule selects nobody and the coach gets silence in a good week.
        """
        self._give_history(self.swimmers)
        selected, reasons = self._triage()
        self.assertEqual(len(selected), 4)
        self.assertEqual(set(reasons.values()), {"routine check"})

    def test_the_floor_rotates_to_whoever_went_longest_without_a_brief(self):
        self._give_history(self.swimmers)
        # Three swimmers have never been briefed at all.
        never_briefed = self.swimmers[:3]
        with SessionLocal() as db:
            db.query(models.SessionEntry).filter(
                models.SessionEntry.swimmer_id.in_(never_briefed),
            ).update({"ai_expected_response": None}, synchronize_session=False)
            db.commit()
        selected, _ = self._triage()
        for swimmer_id in never_briefed:
            self.assertIn(swimmer_id, selected)

    def test_the_floor_does_not_add_people_when_enough_are_already_flagged(self):
        self._give_history(self.swimmers)
        with SessionLocal() as db:
            for swimmer_id in self.swimmers[:6]:
                db.add(models.SwimmerLoadEvent(
                    swimmer_id=swimmer_id, event_type="illness", severity=2,
                    date_from=self.today - timedelta(days=3), resolved=False,
                ))
            db.commit()
        selected, reasons = self._triage()
        self.assertEqual(len(selected), 6)
        self.assertNotIn("routine check", reasons.values())

    # -- the flags -----------------------------------------------------------

    def test_an_unresolved_load_event_always_selects(self):
        self._give_history(self.swimmers)
        with SessionLocal() as db:
            db.add(models.SwimmerLoadEvent(
                swimmer_id=self.swimmers[7], event_type="illness", severity=3,
                date_from=self.today - timedelta(days=2), resolved=False,
            ))
            db.commit()
        selected, reasons = self._triage()
        self.assertIn(self.swimmers[7], selected)
        self.assertEqual(reasons[self.swimmers[7]], "unresolved load event")

    def test_a_resolved_load_event_does_not_select(self):
        self._give_history(self.swimmers)
        with SessionLocal() as db:
            db.add(models.SwimmerLoadEvent(
                swimmer_id=self.swimmers[7], event_type="illness", severity=1,
                date_from=self.today - timedelta(days=40), resolved=True,
            ))
            db.commit()
        _, reasons = self._triage()
        self.assertNotEqual(reasons.get(self.swimmers[7]), "unresolved load event")

    def test_thin_history_selects_a_swimmer_back_after_a_gap(self):
        self._give_history(self.swimmers[1:])
        # Swimmer 0 has no attended history at all.
        selected, reasons = self._triage()
        self.assertIn(self.swimmers[0], selected)
        self.assertEqual(reasons[self.swimmers[0]], "thin recent history")

    def test_a_prediction_that_did_not_hold_selects_again(self):
        self._give_history(self.swimmers)
        with SessionLocal() as db:
            latest = db.query(models.Session).filter(
                models.Session.date < self.today,
            ).order_by(models.Session.date.desc()).first()
            entry = db.query(models.SessionEntry).filter(
                models.SessionEntry.session_id == latest.id,
                models.SessionEntry.swimmer_id == self.swimmers[5],
            ).one()
            entry.ai_characterisation = json.dumps({
                "prediction_comparison": "not_confirmed, recovered faster than expected",
            })
            db.commit()
        selected, reasons = self._triage()
        self.assertIn(self.swimmers[5], selected)
        self.assertEqual(reasons[self.swimmers[5]], "last prediction not confirmed")

    def test_an_approaching_target_selects(self):
        self._give_history(self.swimmers)
        with SessionLocal() as db:
            db.add(models.SwimmerTarget(
                swimmer_id=self.swimmers[9], label="Sub 60 for 100 free",
                deadline=self.today + timedelta(days=21), achieved=False,
            ))
            db.commit()
        selected, reasons = self._triage()
        self.assertIn(self.swimmers[9], selected)
        self.assertEqual(reasons[self.swimmers[9]], "target deadline approaching")

    def test_a_distant_or_achieved_target_does_not_select(self):
        self._give_history(self.swimmers)
        with SessionLocal() as db:
            db.add(models.SwimmerTarget(
                swimmer_id=self.swimmers[9], label="Distant",
                deadline=self.today + timedelta(days=200), achieved=False,
            ))
            db.add(models.SwimmerTarget(
                swimmer_id=self.swimmers[10], label="Already done",
                deadline=self.today + timedelta(days=10), achieved=True,
            ))
            db.commit()
        _, reasons = self._triage()
        self.assertNotEqual(reasons.get(self.swimmers[9]), "target deadline approaching")
        self.assertNotEqual(reasons.get(self.swimmers[10]), "target deadline approaching")

    # -- end to end ----------------------------------------------------------

    def test_only_triaged_swimmers_are_sent_and_the_reason_travels_with_them(self):
        self._give_history(self.swimmers)
        captured = {}

        def fake_create(**kwargs):
            captured.update(kwargs)
            prompt = kwargs["messages"][0]["content"]
            ids = [
                swimmer_id for swimmer_id in self.swimmers
                if f'"swimmer_id": {swimmer_id}' in prompt
            ]
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text=json.dumps([
                    {"swimmer_id": swimmer_id, "predicted_response": "steady",
                     "priority": 0, "watch_question": None}
                    for swimmer_id in ids
                ]))],
                usage=SimpleNamespace(input_tokens=1, output_tokens=1),
            )

        with SessionLocal() as db, patch.object(
            claude_service, "create_message", side_effect=fake_create,
        ):
            session = db.query(models.Session).get(self.session_id)
            saved = claude_service.generate_session_predictions(
                session, db, swimmer_ids=self.swimmers,
            )
            db.commit()

        self.assertEqual(len(saved), 4)
        self.assertIn("selected_because", captured["messages"][0]["content"])
        self.assertTrue(all(row.get("selected_because") for row in saved))

        with SessionLocal() as db:
            briefed = db.query(models.SessionEntry).filter(
                models.SessionEntry.session_id == self.session_id,
                models.SessionEntry.ai_expected_response != None,  # noqa: E711
            ).count()
        self.assertEqual(briefed, 4)

    def test_triage_can_be_turned_off_for_a_full_brief(self):
        self._give_history(self.swimmers)

        def fake_create(**kwargs):
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text=json.dumps([
                    {"swimmer_id": swimmer_id, "predicted_response": "steady", "priority": 0}
                    for swimmer_id in self.swimmers
                ]))],
                usage=SimpleNamespace(input_tokens=1, output_tokens=1),
            )

        with SessionLocal() as db, patch.object(
            claude_service, "create_message", side_effect=fake_create,
        ):
            session = db.query(models.Session).get(self.session_id)
            saved = claude_service.generate_session_predictions(
                session, db, swimmer_ids=self.swimmers, triage=False,
            )
            db.commit()
        self.assertEqual(len(saved), len(self.swimmers))


if __name__ == "__main__":
    unittest.main()
