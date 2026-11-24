"""Each swimmer's usual sessions, and the swimmer manager's check of them
against the register (docs/design/season-planner-weeks.md, 4.4).

The usual sessions are one list: the Schedule page's "who comes to this slot"
(SwimmerSlot), also edited on the swimmer's own page. The register reads it
for "expected"; the season plan reads it to work out which version of a session
each swimmer is on.

The check: after a register is saved, the swimmer manager looks at the last
RUNS times that slot ran. A swimmer who missed it every time, though it is one
of their usual sessions, or who came every time, though it isn't, gets a staff
note asking the coach whether to change their list. Time away, injury, illness
and cancelled or extra sessions don't count. The list never changes by itself:
the note proposes it, the coach decides.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

RUNS = 4
TRIGGER = "usual_sessions"
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def slot_name(slot: models.PoolSlot) -> str:
    half = "AM" if (slot.time or "00:00") < "12:00" else "PM"
    return f"{DAYS[slot.day_of_week]} {half}" + (f" ({slot.label})" if slot.label else "")


def usual(db: DBSession, swimmer_ids=None) -> dict:
    """App swimmer id -> set of the pool slot ids they usually come to."""
    q = db.query(models.SwimmerSlot)
    if swimmer_ids is not None:
        q = q.filter(models.SwimmerSlot.swimmer_id.in_(list(swimmer_ids)))
    out: dict = {}
    for row in q.all():
        out.setdefault(row.swimmer_id, set()).add(row.pool_slot_id)
    return out


def _away(db: DBSession, swimmer_ids: list, first: date, last: date) -> dict:
    """Swimmer id -> [(from, to)] they were excused: availability, meets, injury and illness notes."""
    from backend.services.availability import availability_ranges
    out: dict = {}
    for sid, events in availability_ranges(db, swimmer_ids, first, last).items():
        out.setdefault(sid, []).extend((e["date_from"], e["date_to"]) for e in events)
    notes = db.query(models.SwimmerCurrentNote).filter(
        models.SwimmerCurrentNote.swimmer_id.in_(swimmer_ids),
        models.SwimmerCurrentNote.kind.in_(("injury", "illness")),
        models.SwimmerCurrentNote.date_from <= last,
    ).all()
    for n in notes:
        end = n.until or (n.cleared_at.date() if n.cleared_at else last)
        if end >= first:
            out.setdefault(n.swimmer_id, []).append((n.date_from, end))
    for s in db.query(models.Swimmer).filter(models.Swimmer.id.in_(swimmer_ids), models.Swimmer.status == "injury").all():
        out.setdefault(s.id, []).append((first, last))
    return out


def _asked_since(db: DBSession, swimmer_id: int, slot_id: int, attend: bool, since: date) -> bool:
    """Already asked about this since the oldest of the runs looked at (answered or not)."""
    for note in db.query(models.StaffNote).filter(models.StaffNote.trigger == TRIGGER).all():
        p = ((note.proposed_action or {}).get("payload") or {})
        if (p.get("swimmer_id"), p.get("slot_id"), bool(p.get("attend"))) != (swimmer_id, slot_id, attend):
            continue
        if note.status == "open" or (note.created_at and note.created_at.date() >= since):
            return True
    return False


def check(db: DBSession, session: models.Session) -> list:
    """After a register is saved: ask about anyone whose usual sessions don't match what they do."""
    if not session.pool_slot_id or session.extra_session or session.taken_by_other or session.status == "cancelled":
        return []
    slot = db.get(models.PoolSlot, session.pool_slot_id)
    if not slot:
        return []
    runs = db.query(models.Session).filter(
        models.Session.pool_slot_id == slot.id,
        models.Session.status != "cancelled",
        models.Session.extra_session.isnot(True),
        models.Session.taken_by_other.isnot(True),
        models.Session.register_saved_at.isnot(None),
        models.Session.date <= session.date,
    ).order_by(models.Session.date.desc()).limit(RUNS).all()
    if len(runs) < RUNS:
        return []
    dates = [r.date for r in runs]
    came: dict = {}
    for e in db.query(models.SessionEntry).filter(models.SessionEntry.session_id.in_([r.id for r in runs])).all():
        if e.attended:
            came.setdefault(e.swimmer_id, set()).add(e.session_id)
    regulars = {row.swimmer_id for row in db.query(models.SwimmerSlot).filter_by(pool_slot_id=slot.id)}
    active = {s.id: s for s in db.query(models.Swimmer).filter(models.Swimmer.active.is_(True)).all()}
    everyone = [sid for sid in regulars | set(came) if sid in active]
    away = _away(db, everyone, min(dates), max(dates))
    excused = lambda sid, d: any(a <= d <= b for a, b in away.get(sid, []))  # noqa: E731

    notes = []
    for sid in everyone:
        if any(excused(sid, d) for d in dates):
            continue                              # a run they were excused from: not a pattern
        n_came = len(came.get(sid, set()))
        if sid in regulars and n_came == 0:
            attend = False
        elif sid not in regulars and n_came == RUNS:
            attend = True
        else:
            continue
        if _asked_since(db, sid, slot.id, attend, min(dates)):
            continue
        notes.append(_note(db, active[sid], slot, attend))
    if notes:
        db.commit()
    return notes


def _note(db: DBSession, swimmer: models.Swimmer, slot: models.PoolSlot, attend: bool) -> models.StaffNote:
    from backend.services.staff_actions import prepare
    first = swimmer.name.split()[0]
    where = slot_name(slot)
    if attend:
        message = f"{first} has come to {where} the last {RUNS} times, but it isn't one of their usual sessions."
        question = f"Add {where} to {first}'s usual sessions?"
    else:
        message = f"{first} hasn't been to {where} the last {RUNS} times it ran, though it's one of their usual sessions."
        question = f"Take {where} off {first}'s usual sessions?"
    action = prepare("manager", {"type": "set_usual_session", "swimmer_id": swimmer.id, "slot_id": slot.id,
                                 "attend": attend, "reason": message}, db)
    note = models.StaffNote(role="manager", kind="question", message=message, question=question,
                            swimmer_ids=[swimmer.id], trigger=TRIGGER, topic="Usual sessions",
                            status="open", proposed_action=action,
                            action_status="proposed" if action and not action.get("invalid") else None)
    db.add(note)
    return note


def set_usual(db: DBSession, swimmer_id: int, slot_id: int, attend: bool) -> bool:
    """Add a slot to a swimmer's usual sessions, or take it off. True if it changed."""
    row = db.query(models.SwimmerSlot).filter_by(swimmer_id=swimmer_id, pool_slot_id=slot_id).first()
    if attend and not row:
        db.add(models.SwimmerSlot(swimmer_id=swimmer_id, pool_slot_id=slot_id))
        return True
    if not attend and row:
        db.delete(row)
        return True
    return False


def find_slot(db: DBSession, slot_id) -> Optional[models.PoolSlot]:
    try:
        return db.get(models.PoolSlot, int(slot_id))
    except (TypeError, ValueError):
        return None
