"""Durable, restart-safe background AI operation queue."""
import asyncio
import json
from datetime import datetime, timedelta, timezone

from backend import models
from backend.database import SessionLocal
from backend.services import claude_service


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def enqueue_operation(
    db,
    *,
    operation_type: str,
    title: str,
    entity_type: str | None = None,
    entity_id: int | None = None,
    payload: dict | None = None,
    idempotency_key: str | None = None,
) -> models.AIOperation:
    """Add work in the caller's transaction, reusing an identical request."""
    if idempotency_key:
        existing = db.query(models.AIOperation).filter(
            models.AIOperation.idempotency_key == idempotency_key,
        ).first()
        if existing:
            return existing
    row = models.AIOperation(
        operation_type=operation_type,
        title=title,
        entity_type=entity_type,
        entity_id=entity_id,
        payload={**(payload or {}), "execution": "background"},
        idempotency_key=idempotency_key,
        status="queued",
        available_at=utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def operation_out(row: models.AIOperation) -> dict:
    return {
        "id": row.id,
        "operation_type": row.operation_type,
        "title": row.title,
        "status": row.status,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "execution_mode": (row.payload or {}).get("execution", "background"),
        "result_summary": row.result_summary,
        "error": row.error,
        "attempts": row.attempts or 0,
        "max_attempts": row.max_attempts or 3,
        "available_at": row.available_at,
        "started_at": row.started_at,
        "completed_at": row.completed_at,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _session_operation(row: models.AIOperation, db) -> str:
    session = db.query(models.Session).filter(models.Session.id == row.entity_id).first()
    if not session:
        raise ValueError("The related session no longer exists")

    expected_revision = (row.payload or {}).get("register_revision")
    if expected_revision and session.register_revision != expected_revision:
        return "Superseded by a newer register save; no AI work was needed."

    entries = db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id == session.id,
    ).all()
    attended_ids = [entry.swimmer_id for entry in entries if entry.attended]
    predictions = claude_service.generate_session_predictions(
        session, db, swimmer_ids=attended_ids,
    )

    if row.operation_type == "session_predictions":
        return f"Prepared or confirmed {len(predictions)} swimmer prediction{'' if len(predictions) == 1 else 's'}."

    if row.operation_type != "session_assessment":
        raise ValueError(f"Unsupported AI operation type: {row.operation_type}")

    assessments = claude_service.characterise_session_entries_batch(session, entries, db)
    for swimmer_id, assessment in assessments.items():
        entry = next((item for item in entries if item.swimmer_id == swimmer_id), None)
        if not entry:
            continue
        encoded = json.dumps(assessment, ensure_ascii=False)
        entry.ai_characterisation = encoded
        db.query(models.AIAnalysis).filter(
            models.AIAnalysis.swimmer_id == swimmer_id,
            models.AIAnalysis.session_id == session.id,
            models.AIAnalysis.analysis_type == "session_response",
        ).delete()
        db.add(models.AIAnalysis(
            swimmer_id=swimmer_id,
            session_id=session.id,
            analysis_type="session_response",
            content=encoded,
            model_used=claude_service.FAST_MODEL,
        ))
        observation = db.query(models.SwimmerObservation).filter(
            models.SwimmerObservation.swimmer_id == swimmer_id,
            models.SwimmerObservation.session_id == session.id,
        ).first()
        if observation:
            observation.ai_summary = assessment.get("observed_response") or assessment.get("next_session_action")

    # The assessment already judges whether each observation is new evidence.
    # That verdict used to be written and never read; it is the natural trigger
    # for refreshing the swimmer's profile, so a coach never has to remember to.
    db.flush()
    queued = 0
    for swimmer_id, assessment in assessments.items():
        evidence = str(assessment.get("profile_evidence") or "").lower()
        if "new evidence" not in evidence:
            continue
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
        if not swimmer:
            continue
        before = db.query(models.AIOperation).filter(
            models.AIOperation.operation_type == "profile_refresh",
            models.AIOperation.entity_id == swimmer_id,
        ).count()
        queue_profile_refresh(
            db, swimmer_id, swimmer.name, reason=f"new evidence in session {session.id}",
        )
        after = db.query(models.AIOperation).filter(
            models.AIOperation.operation_type == "profile_refresh",
            models.AIOperation.entity_id == swimmer_id,
        ).count()
        queued += after > before

    summary = f"Assessed {len(assessments)} coach-observed swimmer response{'' if len(assessments) == 1 else 's'}."
    if queued:
        summary += f" Queued {queued} profile update{'' if queued == 1 else 's'}."
    return summary


def _profile_refresh_operation(row: models.AIOperation, db) -> str:
    """Fold newly recorded observations into a swimmer's unified profile."""
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == row.entity_id).first()
    if not swimmer:
        raise ValueError("The related swimmer no longer exists")

    # A coach may have refreshed by hand between queueing and running, or an
    # earlier queued refresh may already have folded in the same observations.
    freshness = claude_service.unified_profile_freshness(swimmer.id, db)
    forced = (row.payload or {}).get("force")
    if not forced and freshness["has_profile"] and not freshness["stale"]:
        return f"{swimmer.name}'s profile is already up to date; no synthesis was needed."

    result = claude_service.synthesise_swimmer_profile(
        swimmer, db, mode=(row.payload or {}).get("mode", "auto"),
    )
    mode = (result.get("data") or {}).get("_synthesis", {}).get("mode", "auto")
    folded = freshness["observations_since"]
    return (
        f"Updated {swimmer.name}'s profile ({mode}), folding in {folded} "
        f"observation{'' if folded == 1 else 's'}."
    )


def queue_profile_refresh(db, swimmer_id: int, swimmer_name: str, *, reason: str) -> None:
    """Queue a profile refresh if the swimmer has accumulated enough new evidence.

    Called after a session is assessed. The idempotency key is scoped to the
    observation watermark, so repeated triggers across a week collapse into one
    synthesis rather than one per session.
    """
    freshness = claude_service.unified_profile_freshness(swimmer_id, db)
    if not freshness["stale"]:
        return
    already = db.query(models.AIOperation).filter(
        models.AIOperation.operation_type == "profile_refresh",
        models.AIOperation.entity_id == swimmer_id,
        models.AIOperation.status.in_(["queued", "running"]),
    ).first()
    if already:
        return
    enqueue_operation(
        db,
        operation_type="profile_refresh",
        title=f"Update swimmer profile · {swimmer_name}",
        entity_type="swimmer",
        entity_id=swimmer_id,
        payload={"reason": reason, "observations_since": freshness["observations_since"]},
        idempotency_key=f"profile:{swimmer_id}:{freshness['observations_total']}",
    )


def _debrief_operation(row: models.AIOperation, db) -> str:
    """Write up a debrief: propose records for review, and summarise the session."""
    debrief = db.query(models.SessionDebrief).filter(
        models.SessionDebrief.id == row.entity_id,
    ).first()
    if not debrief:
        raise ValueError("The related debrief no longer exists")

    # The coach may have carried on talking after pressing finish; a newer run
    # supersedes this one rather than overwriting fresher proposals.
    expected = (row.payload or {}).get("message_count")
    if expected is not None and len(debrief.messages or []) != expected:
        return "Superseded by a longer conversation; no write-up was needed."

    proposals = claude_service.extract_session_debrief(debrief, db)
    summary = claude_service.summarise_session_debrief(debrief, db)
    debrief.proposals = proposals
    debrief.summary = summary
    debrief.status = "ready"
    db.commit()
    count = len(proposals)
    return f"Summarised the session and proposed {count} record{'' if count == 1 else 's'} for review."


def process_operation(operation_id: int) -> bool:
    """Claim and run one queued operation. Returns whether it was claimed."""
    with SessionLocal() as db:
        claimed = db.query(models.AIOperation).filter(
            models.AIOperation.id == operation_id,
            models.AIOperation.status == "queued",
            models.AIOperation.available_at <= utcnow(),
        ).update({
            "status": "running",
            "started_at": utcnow(),
            "error": None,
            "attempts": models.AIOperation.attempts + 1,
        }, synchronize_session=False)
        db.commit()
        if not claimed:
            return False

        row = db.query(models.AIOperation).filter(models.AIOperation.id == operation_id).one()
        try:
            with claude_service.ai_operation_scope(row.id):
                if row.operation_type in {"session_predictions", "session_assessment"}:
                    summary = _session_operation(row, db)
                elif row.operation_type == "session_debrief":
                    summary = _debrief_operation(row, db)
                elif row.operation_type == "profile_refresh":
                    summary = _profile_refresh_operation(row, db)
                else:
                    raise ValueError(f"Unsupported AI operation type: {row.operation_type}")
            row.status = "completed"
            row.result_summary = summary
            row.error = None
            row.completed_at = utcnow()
            db.commit()
        except Exception as exc:
            db.rollback()
            row = db.query(models.AIOperation).filter(models.AIOperation.id == operation_id).one()
            row.error = str(exc)[:2000]
            row.result_summary = None
            if (row.attempts or 0) < (row.max_attempts or 3):
                row.status = "queued"
                row.available_at = utcnow() + timedelta(seconds=30 * max(row.attempts or 1, 1))
            else:
                row.status = "failed"
                row.completed_at = utcnow()
            db.commit()
        return True


def process_next_operation() -> bool:
    with SessionLocal() as db:
        row = db.query(models.AIOperation.id).filter(
            models.AIOperation.status == "queued",
            models.AIOperation.available_at <= utcnow(),
        ).order_by(models.AIOperation.created_at, models.AIOperation.id).first()
        operation_id = row[0] if row else None
    return process_operation(operation_id) if operation_id else False


def recover_interrupted_operations() -> int:
    """Return abandoned running work to the queue after a process restart."""
    with SessionLocal() as db:
        stale = db.query(models.AIOperation).filter(
            models.AIOperation.status == "running",
            models.AIOperation.started_at < utcnow() - timedelta(minutes=15),
        ).all()
        recovered = 0
        for row in stale:
            if (row.payload or {}).get("execution") == "foreground":
                row.status = "failed"
                row.completed_at = utcnow()
                row.error = "The server stopped while this foreground AI response was running. Return to the original screen and try again."
            else:
                row.status = "queued"
                row.available_at = utcnow()
                row.error = "The server restarted while this operation was running; it has been queued again."
                recovered += 1
        db.commit()
        return recovered


async def run_operation_worker():
    """Poll without blocking FastAPI's event loop while an AI provider responds."""
    polls = 0
    while True:
        if polls % 20 == 0:
            await asyncio.to_thread(recover_interrupted_operations)
        worked = await asyncio.to_thread(process_next_operation)
        polls += 1
        await asyncio.sleep(0.5 if worked else 3.0)
