"""Spoken post-session debriefs: interview the coach, then propose records for review."""
from datetime import date as date_type, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import claude_service
from backend.services.ai_operations import enqueue_operation, operation_out

router = APIRouter()


class DebriefStart(BaseModel):
    session_id: Optional[int] = None
    date: Optional[str] = None
    title: Optional[str] = None


class ProposalDecision(BaseModel):
    id: str
    status: str                      # accepted / rejected
    content: Optional[str] = None    # coach may correct the wording before committing


class CommitProposals(BaseModel):
    decisions: list[ProposalDecision]


def _get_or_404(debrief_id: int, db: DBSession) -> models.SessionDebrief:
    row = db.query(models.SessionDebrief).filter(
        models.SessionDebrief.id == debrief_id,
    ).first()
    if not row:
        raise HTTPException(404, "Debrief not found")
    return row


def _out(row: models.SessionDebrief, db: DBSession) -> dict:
    session = db.query(models.Session).filter(
        models.Session.id == row.session_id,
    ).first() if row.session_id else None
    return {
        "id": row.id,
        "session_id": row.session_id,
        "session_title": (session.title or str(session.date)) if session else None,
        "date": row.date,
        "title": row.title,
        "status": row.status,
        "messages": row.messages or [],
        "summary": row.summary,
        "proposals": row.proposals or [],
        "committed_at": row.committed_at,
        "created_at": row.created_at,
    }


@router.get("")
def list_debriefs(session_id: Optional[int] = None, limit: int = 20, db: DBSession = Depends(get_db)):
    query = db.query(models.SessionDebrief)
    if session_id is not None:
        query = query.filter(models.SessionDebrief.session_id == session_id)
    rows = query.order_by(models.SessionDebrief.created_at.desc()).limit(max(1, min(limit, 100))).all()
    return [_out(row, db) for row in rows]


@router.post("", status_code=201)
def start_debrief(body: DebriefStart, db: DBSession = Depends(get_db)):
    """Open a debrief and let the assistant speak first, so the coach can just talk."""
    session = None
    if body.session_id is not None:
        session = db.query(models.Session).filter(models.Session.id == body.session_id).first()
        if not session:
            raise HTTPException(404, "Session not found")

    # An unfinished debrief for the same session is resumed rather than duplicated.
    if session:
        existing = db.query(models.SessionDebrief).filter(
            models.SessionDebrief.session_id == session.id,
            models.SessionDebrief.status.in_(["in_progress", "processing", "ready"]),
        ).first()
        if existing:
            return _out(existing, db)

    row = models.SessionDebrief(
        session_id=body.session_id,
        date=(
            date_type.fromisoformat(body.date) if body.date
            else (session.date if session else date_type.today())
        ),
        title=body.title or (f"Debrief · {session.title or session.date}" if session else "Session debrief"),
        status="in_progress",
        messages=[],
        proposals=[],
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    opener = (
        f"How did {session.title or 'the session'} go?"
        if session else "What was the session, and how did it go?"
    )
    row.messages = [{"role": "ai", "message": opener}]
    db.commit()
    db.refresh(row)
    return _out(row, db)


@router.get("/{debrief_id}")
def get_debrief(debrief_id: int, db: DBSession = Depends(get_db)):
    return _out(_get_or_404(debrief_id, db), db)


@router.post("/{debrief_id}/chat")
def debrief_chat(debrief_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    """One interview turn. Stays in the foreground — the coach is waiting on it."""
    row = _get_or_404(debrief_id, db)
    if row.status != "in_progress":
        raise HTTPException(409, "This debrief is already being written up")
    message = str(body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "Message required")

    row.messages = list(row.messages or []) + [{"role": "coach", "message": message}]
    db.commit()
    try:
        reply = claude_service.session_debrief_reply(row, db)
    except Exception as exc:
        raise HTTPException(502, f"The assistant could not respond: {exc}")
    row.messages = list(row.messages or []) + [{"role": "ai", "message": reply}]
    db.commit()
    db.refresh(row)
    return {"reply": reply, "messages": row.messages}


@router.post("/{debrief_id}/complete")
def complete_debrief(debrief_id: int, db: DBSession = Depends(get_db)):
    """Hand the write-up to the background queue so the coach can walk away."""
    row = _get_or_404(debrief_id, db)
    if not any(item.get("role") == "coach" for item in (row.messages or [])):
        raise HTTPException(400, "Say something about the session before finishing")
    if row.status not in {"in_progress", "ready"}:
        raise HTTPException(409, "This debrief is already being written up")

    row.status = "processing"
    operation = enqueue_operation(
        db,
        operation_type="session_debrief",
        title=f"Write up {row.title or 'session debrief'}",
        entity_type="session_debrief",
        entity_id=row.id,
        payload={"message_count": len(row.messages or [])},
        idempotency_key=f"debrief:{row.id}:{len(row.messages or [])}",
    )
    db.commit()
    db.refresh(row)
    db.refresh(operation)
    return {**_out(row, db), "ai_operation": operation_out(operation)}


@router.post("/{debrief_id}/commit")
def commit_debrief(debrief_id: int, body: CommitProposals, db: DBSession = Depends(get_db)):
    """Apply the coach's accept/reject decisions to the swimmers' records."""
    row = _get_or_404(debrief_id, db)
    if row.status != "ready":
        raise HTTPException(409, "This debrief has nothing ready to review")

    decisions = {item.id: item for item in body.decisions}
    proposals = []
    for item in (row.proposals or []):
        decision = decisions.get(item.get("id"))
        if decision:
            item = {
                **item,
                "status": "accepted" if decision.status == "accepted" else "rejected",
                "content": (decision.content or item.get("content") or "").strip() or item.get("content"),
            }
        proposals.append(item)
    row.proposals = proposals
    db.commit()

    counts = claude_service.commit_debrief_proposals(row, db)
    row.status = "committed"
    row.committed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return {**_out(row, db), "committed": counts}


@router.delete("/{debrief_id}", status_code=204)
def delete_debrief(debrief_id: int, db: DBSession = Depends(get_db)):
    db.delete(_get_or_404(debrief_id, db))
    db.commit()
