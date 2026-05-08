from datetime import date
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models

router = APIRouter()


class CoachingNoteCreate(BaseModel):
    title: str
    body: str
    swimmer_ids: List[int] = []
    swimmer_names: List[str] = []
    date_from: date
    date_to: date


class CoachingNoteUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    active: Optional[bool] = None
    date_to: Optional[date] = None


def _out(note: models.CoachingNote) -> dict:
    return {
        "id": note.id,
        "title": note.title,
        "body": note.body,
        "swimmer_ids": note.swimmer_ids or [],
        "swimmer_names": note.swimmer_names or [],
        "date_from": note.date_from.isoformat() if note.date_from else None,
        "date_to": note.date_to.isoformat() if note.date_to else None,
        "active": note.active,
        "created_at": note.created_at.isoformat() if note.created_at else None,
    }


@router.get("")
def get_coaching_notes(include_expired: bool = False, db: DBSession = Depends(get_db)):
    today = date.today()
    q = db.query(models.CoachingNote).filter(models.CoachingNote.active == True)
    if not include_expired:
        q = q.filter(models.CoachingNote.date_to >= today)
    return [_out(n) for n in q.order_by(models.CoachingNote.date_from).all()]


@router.post("")
def create_coaching_note(data: CoachingNoteCreate, db: DBSession = Depends(get_db)):
    note = models.CoachingNote(
        title=data.title,
        body=data.body,
        swimmer_ids=data.swimmer_ids,
        swimmer_names=data.swimmer_names,
        date_from=data.date_from,
        date_to=data.date_to,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _out(note)


@router.patch("/{note_id}")
def update_coaching_note(note_id: int, data: CoachingNoteUpdate, db: DBSession = Depends(get_db)):
    note = db.query(models.CoachingNote).filter(models.CoachingNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    if data.title is not None:
        note.title = data.title
    if data.body is not None:
        note.body = data.body
    if data.active is not None:
        note.active = data.active
    if data.date_to is not None:
        note.date_to = data.date_to
    db.commit()
    db.refresh(note)
    return _out(note)


@router.delete("/{note_id}")
def delete_coaching_note(note_id: int, db: DBSession = Depends(get_db)):
    note = db.query(models.CoachingNote).filter(models.CoachingNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    db.delete(note)
    db.commit()
    return {"deleted": note_id}
