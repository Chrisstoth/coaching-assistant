"""What holds for a swimmer right now: injuries, illness, and other things that affect how they train.

A current note is ongoing, unlike a debrief observation, which is about one day. It
stays active until the coach clears it, or until its end date passes. The debrief
proposes new ones (and proposes clearing or updating old ones) for the coach to
confirm; the coach can also add, edit and clear them directly.

Shown at the top of the Session Builder (writing and poolside) for the swimmers the
session is for, and given to the staff so they plan around it.
"""
from datetime import date, datetime, timezone
from typing import Iterable, Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

KINDS = ("injury", "illness", "other")
KIND_WORDS = {"injury": "injury", "illness": "illness", "other": "note"}
MAX_TITLE = 80
MAX_TEXT = 1000


def clean_kind(kind) -> str:
    kind = str(kind or "").strip().lower()
    return kind if kind in KINDS else "other"


def _date(value) -> Optional[date]:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _text(value, limit=MAX_TEXT) -> Optional[str]:
    text = str(value or "").strip()
    return text[:limit] or None


def is_active(note: models.SwimmerCurrentNote, on: Optional[date] = None) -> bool:
    on = on or date.today()
    if note.cleared_at is not None:
        return False
    if note.date_from and note.date_from > on:
        return False
    return note.until is None or note.until >= on


def active_notes(db: DBSession, swimmer_ids: Optional[Iterable[int]] = None,
                 on: Optional[date] = None) -> list:
    """Active notes, injuries and illness first, then the newest."""
    on = on or date.today()
    q = db.query(models.SwimmerCurrentNote).filter(
        models.SwimmerCurrentNote.cleared_at.is_(None),
        models.SwimmerCurrentNote.date_from <= on,
    )
    if swimmer_ids is not None:
        ids = [int(i) for i in swimmer_ids]
        if not ids:
            return []
        q = q.filter(models.SwimmerCurrentNote.swimmer_id.in_(ids))
    rows = [n for n in q.all() if n.until is None or n.until >= on]
    order = {"injury": 0, "illness": 1, "other": 2}
    return sorted(rows, key=lambda n: (order.get(n.kind, 3), -(n.date_from.toordinal() if n.date_from else 0), n.id))


def note_out(note: models.SwimmerCurrentNote, on: Optional[date] = None) -> dict:
    swimmer = note.swimmer
    return {
        "id": note.id,
        "swimmer_id": note.swimmer_id,
        "swimmer_name": swimmer.name if swimmer else None,
        "kind": note.kind,
        "title": note.title,
        "detail": note.detail,
        "impact": note.impact,
        "date_from": note.date_from.isoformat() if note.date_from else None,
        "until": note.until.isoformat() if note.until else None,
        "active": is_active(note, on),
        "cleared_at": note.cleared_at.isoformat() if note.cleared_at else None,
        "cleared_note": note.cleared_note,
        "source": note.source,
        "debrief_id": note.debrief_id,
        "session_id": note.session_id,
    }


def create(db: DBSession, swimmer_id: int, kind, title, detail=None, impact=None, date_from=None,
           until=None, source="coach", debrief_id=None, session_id=None) -> models.SwimmerCurrentNote:
    title = _text(title, MAX_TITLE) or _text(detail, MAX_TITLE)
    if not title:
        raise ValueError("Say what it is, e.g. 'Left shoulder'.")
    if not db.query(models.Swimmer.id).filter(models.Swimmer.id == swimmer_id).first():
        raise ValueError("That swimmer isn't on the squad list.")
    start = _date(date_from) or date.today()
    end = _date(until)
    if end and end < start:
        raise ValueError("The end date is before it started.")
    note = models.SwimmerCurrentNote(
        swimmer_id=swimmer_id, kind=clean_kind(kind), title=title, detail=_text(detail), impact=_text(impact),
        date_from=start, until=end, source=source, debrief_id=debrief_id, session_id=session_id,
    )
    db.add(note)
    db.flush()
    return note


def update(db: DBSession, note: models.SwimmerCurrentNote, changes: dict) -> models.SwimmerCurrentNote:
    """Change what was given. `until: None` given explicitly means 'until cleared'."""
    if "kind" in changes and changes["kind"] is not None:
        note.kind = clean_kind(changes["kind"])
    if "title" in changes and _text(changes["title"], MAX_TITLE):
        note.title = _text(changes["title"], MAX_TITLE)
    for field in ("detail", "impact"):
        if field in changes:
            setattr(note, field, _text(changes[field]))
    if "date_from" in changes and _date(changes["date_from"]):
        note.date_from = _date(changes["date_from"])
    if "until" in changes:
        note.until = _date(changes["until"])
    if note.until and note.date_from and note.until < note.date_from:
        raise ValueError("The end date is before it started.")
    db.flush()
    return note


def clear(db: DBSession, note: models.SwimmerCurrentNote, why: Optional[str] = None) -> models.SwimmerCurrentNote:
    note.cleared_at = datetime.now(timezone.utc)
    note.cleared_note = _text(why)
    db.flush()
    return note


def reopen(db: DBSession, note: models.SwimmerCurrentNote) -> models.SwimmerCurrentNote:
    note.cleared_at = None
    note.cleared_note = None
    if note.until and note.until < date.today():
        note.until = None
    db.flush()
    return note


# ---------------------------------------------------------------- who a session is for

def session_swimmer_ids(db: DBSession, session: models.Session) -> Optional[list]:
    """The swimmers a session is for, or None for 'the whole squad'.

    Once the register is taken, it's who came. Before that, it's who the session
    was written for: one swimmer or group, or who swims its groups."""
    entries = list(session.entries or [])
    if any(e.attended is not None for e in entries):
        return [e.swimmer_id for e in entries if e.attended]
    audience = session.audience or {}
    if audience.get("swimmer_ids"):
        return [int(i) for i in audience["swimmer_ids"] if str(i).isdigit()]
    ids = []
    for g in (session.builder or {}).get("groups") or []:
        for sid in g.get("swimmer_ids") or []:
            if isinstance(sid, int) and sid not in ids:
                ids.append(sid)
    return ids or None


def for_session(db: DBSession, session: models.Session) -> dict:
    """What's on now for the swimmers this session is for."""
    ids = session_swimmer_ids(db, session)
    on = max(session.date, date.today()) if session.date else date.today()
    scope = "session"
    if ids is None:
        scope = "squad"
        if session.squad:
            squad_ids = [sid for (sid,) in db.query(models.Swimmer.id).filter(
                models.Swimmer.squad == session.squad).all()]
            ids = squad_ids or None
    notes = active_notes(db, ids, on)
    out = [note_out(n, on) for n in notes]
    return {
        "scope": scope,
        "injuries": [n for n in out if n["kind"] in ("injury", "illness")],
        "other": [n for n in out if n["kind"] not in ("injury", "illness")],
    }


# ---------------------------------------------------------------- for the AI

def _line(note: models.SwimmerCurrentNote, with_id=False) -> str:
    who = note.swimmer.name if note.swimmer else f"swimmer {note.swimmer_id}"
    head = f"[note {note.id}] " if with_id else ""
    text = f"{head}{who} (id={note.swimmer_id}) · {KIND_WORDS.get(note.kind, 'note')}: {note.title}"
    if note.detail:
        text += f" — {note.detail[:200]}"
    if note.impact:
        text += f" · in training: {note.impact[:200]}"
    text += f" · since {note.date_from.isoformat()}"
    if note.until:
        text += f", until {note.until.isoformat()}"
    return text


def staff_lines(db: DBSession, swimmer_ids: Optional[Iterable[int]] = None, on: Optional[date] = None) -> str:
    """For the staff: what holds right now, which they must plan around."""
    notes = active_notes(db, swimmer_ids, on)
    if not notes:
        return ""
    return ("RIGHT NOW (confirmed by the coach; ongoing until cleared — plan around these):\n"
            + "\n".join(f"  - {_line(n)}" for n in notes))


def debrief_lines(db: DBSession, swimmer_ids: Iterable[int]) -> list:
    """For the debrief write-up: active notes with their ids, so it can propose clearing one."""
    return [_line(n, with_id=True) for n in active_notes(db, swimmer_ids)]


def by_swimmer(db: DBSession, swimmer_ids: Iterable[int]) -> dict:
    out: dict = {}
    for n in active_notes(db, swimmer_ids):
        out.setdefault(n.swimmer_id, []).append(n)
    return out
