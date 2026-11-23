"""Tie imported swims to the galas in the app they were swum at.

A results file names galas its own way ("BUCS SC Champs 2026-27 - NE262738"
against "BUCS" in the app), so swims that arrive by import aren't tied to the
gala, and the gala keeps asking for its results. A swim belongs to a gala
when the swimmer was entered at it (an entry or a target), the swim is on one
of the gala's days, the course matches when the gala says which, and, when
the swimmer's events at the gala are known, it is one of them. The gala name
in the file doesn't matter.

Only swims not yet tied to a gala are touched; a link made any other way is
never moved.
"""
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.event_normalizer import canonicalize_event

_NOT_SWUM = ("withdrawn", "refunded", "rejected", "scratched")


def _course_of(swim: models.SwimTime) -> Optional[str]:
    course = (swim.course or "").upper()
    if course in ("SCM", "LCM"):
        return course
    event = (swim.event or "").upper()
    return "LCM" if "LCM" in event else "SCM" if "SCM" in event else None


def link_swims_to_meets(db: DBSession, swimmer_ids: Optional[set] = None, today: Optional[date] = None) -> int:
    """Tie untied swims to the galas they were swum at. Returns how many."""
    today = today or date.today()
    meets = db.query(models.Meet).filter(models.Meet.date.isnot(None), models.Meet.date <= today).all()
    linked = 0
    for meet in meets:
        last_day = meet.date_to or meet.date
        # Who swam at this gala, and which events, as far as the app knows.
        events: dict[int, set] = {}
        for entry in db.query(models.MeetEntry).filter(models.MeetEntry.meet_id == meet.id).all():
            chosen = events.setdefault(entry.swimmer_id, set())
            if (entry.status or "").lower() not in _NOT_SWUM:
                chosen.add(entry.canonical_event or canonicalize_event(entry.event_name))
        for target in db.query(models.MeetTarget).filter(models.MeetTarget.meet_id == meet.id).all():
            chosen = events.setdefault(target.swimmer_id, set())
            chosen.update(canonicalize_event(event) for event in (target.events or []))
        if swimmer_ids is not None:
            events = {sid: chosen for sid, chosen in events.items() if sid in swimmer_ids}
        if not events:
            continue
        swims = db.query(models.SwimTime).filter(
            models.SwimTime.swimmer_id.in_(list(events)),
            models.SwimTime.meet_id.is_(None),
            models.SwimTime.date.between(meet.date, last_day),
        ).all()
        for swim in swims:
            if meet.course and _course_of(swim) not in (None, meet.course):
                continue
            chosen = events.get(swim.swimmer_id) or set()
            if chosen and canonicalize_event(swim.event or "") not in chosen:
                continue
            swim.meet_id = meet.id
            linked += 1
    if linked:
        db.commit()
    return linked


def link_swims_to_meets_on_startup() -> None:
    """Tie swims imported before this existed. Never stops the app starting."""
    from backend.database import SessionLocal
    try:
        with SessionLocal() as db:
            link_swims_to_meets(db)
    except Exception:  # noqa: BLE001
        pass

