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
from datetime import date, timedelta
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
        # A name results files use for this gala, learnt from the coach.
        if meet.results_names:
            first, last = _window(meet)
            query = db.query(models.SwimTime).filter(
                models.SwimTime.meet_id.is_(None),
                models.SwimTime.meet.in_(list(meet.results_names)),
                models.SwimTime.date.between(first, last),
            )
            if swimmer_ids is not None:
                query = query.filter(models.SwimTime.swimmer_id.in_(list(swimmer_ids)))
            for swim in query.all():
                swim.meet_id = meet.id
                linked += 1
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


# ---------------------------------------------------------------------------
# The coach adds swims to a gala by hand
# ---------------------------------------------------------------------------
#
# For a gala the rules above can't place - nobody entered in the app, dates
# a little out - the Results card lists the untied swims from around the
# gala's dates, grouped by what the results file called the gala, and the
# coach picks the right group.

SLACK_DAYS = 3


def _window(meet: models.Meet) -> tuple[date, date]:
    return meet.date - timedelta(days=SLACK_DAYS), (meet.date_to or meet.date) + timedelta(days=SLACK_DAYS)


def untied_swims_near(db: DBSession, meet: models.Meet) -> list[dict]:
    """Swims tied to no gala from around this gala's dates, grouped by the
    gala name the results file used."""
    if not meet.date:
        return []
    first, last = _window(meet)
    swims = db.query(models.SwimTime).filter(
        models.SwimTime.meet_id.is_(None),
        models.SwimTime.date.between(first, last),
    ).all()
    names = {swimmer.id: swimmer.name for swimmer in db.query(models.Swimmer).filter(
        models.Swimmer.id.in_({swim.swimmer_id for swim in swims})).all()} if swims else {}
    groups: dict[str, dict] = {}
    for swim in swims:
        key = swim.meet or ""
        group = groups.setdefault(key, {
            "results_name": swim.meet, "swims": 0, "swimmers": set(), "courses": set(), "dates": set(),
        })
        group["swims"] += 1
        group["swimmers"].add(names.get(swim.swimmer_id, "?"))
        if _course_of(swim):
            group["courses"].add(_course_of(swim))
        group["dates"].add(swim.date)
    out = [{
        "results_name": group["results_name"],
        "swims": group["swims"],
        "swimmers": sorted(group["swimmers"]),
        "courses": sorted(group["courses"]),
        "first_date": min(group["dates"]).isoformat(),
        "last_date": max(group["dates"]).isoformat(),
        "course_matches": not meet.course or not group["courses"] or group["courses"] == {meet.course},
    } for group in groups.values()]
    out.sort(key=lambda group: (not group["course_matches"], -group["swims"]))
    return out


def tie_named_swims(db: DBSession, meet: models.Meet, results_names: list) -> int:
    """Tie the untied swims the results file filed under these names (around
    this gala's dates) to this gala, and remember the names for next time."""
    if not meet.date:
        raise ValueError("Set the gala's date first.")
    wanted = [name for name in results_names if name]
    want_unnamed = any(not name for name in results_names)
    first, last = _window(meet)
    swims = db.query(models.SwimTime).filter(
        models.SwimTime.meet_id.is_(None),
        models.SwimTime.date.between(first, last),
    ).all()
    tied = 0
    for swim in swims:
        if (swim.meet in wanted) or (want_unnamed and not swim.meet):
            swim.meet_id = meet.id
            tied += 1
    if wanted:
        meet.results_names = sorted(set(meet.results_names or []) | set(wanted))
    db.commit()
    return tied


def link_swims_to_meets_on_startup() -> None:
    """Tie swims imported before this existed. Never stops the app starting."""
    from backend.database import SessionLocal
    try:
        with SessionLocal() as db:
            link_swims_to_meets(db)
    except Exception:  # noqa: BLE001
        pass

