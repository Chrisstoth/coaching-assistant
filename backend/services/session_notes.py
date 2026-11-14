"""Notes the coach takes during a session, and how the debrief reads them.

A note can be about the whole session, one set, one or more swimmers, or a mix.
They are the coach's own words written at the time, so the debrief treats them as
evidence alongside what the coach says afterwards, and proposes records from them
for the coach to confirm. Nothing here writes to a swimmer's record directly.
"""
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

MAX_TEXT = 2000
MAX_LABEL = 300


def _club_zone():
    """The club's clock, for showing when a note was made. The server runs on UTC."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(os.getenv("APP_TIMEZONE", "Europe/London"))
    except Exception:  # noqa: BLE001 - no zone data: fall back to the server's clock
        return None


def clean_swimmer_ids(db: DBSession, ids) -> list[int]:
    """Only swimmers that exist, each once, in the order given."""
    wanted = []
    for value in ids or []:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number not in wanted:
            wanted.append(number)
    if not wanted:
        return []
    known = {row.id for row in db.query(models.Swimmer.id).filter(models.Swimmer.id.in_(wanted)).all()}
    return [number for number in wanted if number in known]


def clean_set_ref(ref) -> Optional[dict]:
    if not isinstance(ref, dict):
        return None
    label = str(ref.get("label") or "").strip()[:MAX_LABEL]
    block_id = str(ref.get("block_id") or "").strip() or None
    line_id = str(ref.get("line_id") or "").strip() or None
    if not (label or block_id or line_id):
        return None
    return {"block_id": block_id, "line_id": line_id, "label": label or None}


def parse_noted_at(value) -> datetime:
    """When the note was made, in UTC (stored that way so SQLite and Postgres agree)."""
    if isinstance(value, datetime):
        moment = value
    else:
        try:
            moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return datetime.now(timezone.utc)
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def notes_for(db: DBSession, session_id: int) -> list[models.SessionNote]:
    return db.query(models.SessionNote).filter(
        models.SessionNote.session_id == session_id,
    ).order_by(models.SessionNote.noted_at, models.SessionNote.id).all()


def _names(db: DBSession, notes) -> dict[int, str]:
    ids = {number for note in notes for number in (note.swimmer_ids or [])}
    if not ids:
        return {}
    return {row.id: row.name for row in db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).all()}


def note_out(note: models.SessionNote, names: dict[int, str]) -> dict:
    return {
        "id": note.id,
        "session_id": note.session_id,
        "client_id": note.client_id,
        "text": note.text,
        "swimmer_ids": list(note.swimmer_ids or []),
        "swimmer_names": [names[i] for i in (note.swimmer_ids or []) if i in names],
        "set_ref": note.set_ref,
        "noted_at": note.noted_at,
        "created_at": note.created_at,
    }


def notes_out(db: DBSession, notes) -> list[dict]:
    names = _names(db, notes)
    return [note_out(note, names) for note in notes]


def _clock(moment) -> str:
    """The time on the pool clock when the note was made, e.g. "20:42"."""
    if not moment:
        return ""
    if not moment.tzinfo:            # SQLite hands it back without its zone; it was stored as UTC
        moment = moment.replace(tzinfo=timezone.utc)
    zone = _club_zone()
    return (moment.astimezone(zone) if zone else moment.astimezone()).strftime("%H:%M")


def notes_text(db: DBSession, session_id: Optional[int]) -> str:
    """The session's notes as plain lines for the staff to read, or "" if none."""
    if not session_id:
        return ""
    notes = notes_for(db, session_id)
    if not notes:
        return ""
    names = _names(db, notes)
    lines = []
    for note in notes:
        about = []
        who = [names[i] for i in (note.swimmer_ids or []) if i in names]
        if who:
            about.append(", ".join(who))
        if note.set_ref and note.set_ref.get("label"):
            about.append(f"set: {note.set_ref['label']}")
        prefix = " ".join(filter(None, [_clock(note.noted_at), f"[{' · '.join(about)}]" if about else ""]))
        lines.append(f"  - {prefix}: {note.text}" if prefix else f"  - {note.text}")
    return "\n".join(lines)
