"""Injuries, illness and other notes that hold right now (see backend/services/current_notes.py)."""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services import current_notes as C

router = APIRouter()


class NoteIn(BaseModel):
    swimmer_id: int
    kind: str = "other"
    title: str
    detail: Optional[str] = None
    impact: Optional[str] = None
    date_from: Optional[date] = None
    until: Optional[date] = None


class NoteChange(BaseModel):
    kind: Optional[str] = None
    title: Optional[str] = None
    detail: Optional[str] = None
    impact: Optional[str] = None
    date_from: Optional[date] = None
    until: Optional[date] = None


class ClearIn(BaseModel):
    why: Optional[str] = None


def _get(db: DBSession, note_id: int) -> models.SwimmerCurrentNote:
    note = db.query(models.SwimmerCurrentNote).filter(models.SwimmerCurrentNote.id == note_id).first()
    if not note:
        raise HTTPException(404, "Note not found")
    return note


@router.get("")
def list_notes(swimmer_id: Optional[int] = None, include_cleared: bool = False, db: DBSession = Depends(get_db)):
    """Active notes (all swimmers, or one). With include_cleared, one swimmer's whole history."""
    if include_cleared and swimmer_id is not None:
        rows = db.query(models.SwimmerCurrentNote).filter(
            models.SwimmerCurrentNote.swimmer_id == swimmer_id,
        ).order_by(models.SwimmerCurrentNote.date_from.desc(), models.SwimmerCurrentNote.id.desc()).all()
    else:
        rows = C.active_notes(db, [swimmer_id] if swimmer_id is not None else None)
    return [C.note_out(n) for n in rows]


@router.get("/session/{session_id}")
def for_session(session_id: int, db: DBSession = Depends(get_db)):
    """What's on now for the swimmers a session is for: shown at the top of the Session Builder."""
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    return C.for_session(db, session)


@router.post("", status_code=201)
def add_note(body: NoteIn, db: DBSession = Depends(get_db)):
    try:
        note = C.create(db, body.swimmer_id, body.kind, body.title, body.detail, body.impact,
                        body.date_from, body.until, source="coach")
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.commit()
    db.refresh(note)
    return C.note_out(note)


@router.patch("/{note_id}")
def change_note(note_id: int, body: NoteChange, db: DBSession = Depends(get_db)):
    note = _get(db, note_id)
    try:
        C.update(db, note, body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(422, str(e))
    db.commit()
    db.refresh(note)
    return C.note_out(note)


@router.post("/{note_id}/clear")
def clear_note(note_id: int, body: ClearIn = ClearIn(), db: DBSession = Depends(get_db)):
    """Cleared: back to full training, or it no longer applies."""
    note = C.clear(db, _get(db, note_id), body.why)
    db.commit()
    db.refresh(note)
    return C.note_out(note)


@router.post("/{note_id}/reopen")
def reopen_note(note_id: int, db: DBSession = Depends(get_db)):
    note = C.reopen(db, _get(db, note_id))
    db.commit()
    db.refresh(note)
    return C.note_out(note)
