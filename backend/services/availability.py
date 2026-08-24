"""Deterministic swimmer availability used by registers, attendance and planning UI."""
from collections import defaultdict
from datetime import date
from typing import Iterable

from sqlalchemy import or_
from sqlalchemy.orm import Session as DBSession

from backend import models


EXCUSED_REASONS = {
    "holiday", "exams", "work", "injury", "competition",
    "planned_rest", "taper_rest", "other",
}

REASON_LABELS = {
    "holiday": "Holiday",
    "exams": "Exams",
    "work": "Work",
    "injury": "Injury",
    "competition": "Competing",
    "planned_rest": "Planned rest",
    "taper_rest": "Taper rest",
    "other": "Excused",
}


def normalise_reason(reason: str | None) -> str:
    value = (reason or "other").strip().lower().replace(" ", "_").replace("-", "_")
    if value == "taper":
        return "taper_rest"
    return value if value in EXCUSED_REASONS else "other"


def _event(*, swimmer_id: int, reason: str, date_from: date, date_to: date,
           source: str, detail: str | None = None, source_id: int | None = None,
           meet_id: int | None = None) -> dict:
    reason = normalise_reason(reason)
    return {
        "swimmer_id": swimmer_id,
        "reason": reason,
        "label": REASON_LABELS.get(reason, "Excused"),
        "date_from": date_from,
        "date_to": date_to,
        "source": source,
        "source_id": source_id,
        "meet_id": meet_id,
        "detail": detail,
    }


def availability_ranges(
    db: DBSession,
    swimmer_ids: Iterable[int],
    date_from: date,
    date_to: date,
) -> dict[int, list[dict]]:
    """Bulk-fetch excused non-training periods, including linked competitions."""
    swimmer_ids = list(set(swimmer_ids))
    result: dict[int, list[dict]] = defaultdict(list)
    if not swimmer_ids:
        return result

    exceptions = db.query(models.SwimmerException).filter(
        models.SwimmerException.swimmer_id.in_(swimmer_ids),
        models.SwimmerException.date_from <= date_to,
        models.SwimmerException.date_to >= date_from,
    ).all()
    for row in exceptions:
        result[row.swimmer_id].append(_event(
            swimmer_id=row.swimmer_id,
            reason=row.reason,
            date_from=row.date_from,
            date_to=row.date_to,
            source="exception",
            source_id=row.id,
            detail=row.notes,
        ))

    # A confirmed meet entry is authoritative evidence that the swimmer is
    # competing instead of attending normal training on the meet date(s).
    meet_rows = db.query(models.MeetEntry, models.Meet).join(
        models.Meet, models.MeetEntry.meet_id == models.Meet.id,
    ).filter(
        models.MeetEntry.swimmer_id.in_(swimmer_ids),
        models.MeetEntry.status != "withdrawn",
        models.Meet.date.is_not(None),
        models.Meet.date <= date_to,
        or_(models.Meet.date_to >= date_from, models.Meet.date >= date_from),
    ).all()
    seen_meets = set()
    for entry, meet in meet_rows:
        key = (entry.swimmer_id, meet.id)
        if key in seen_meets:
            continue
        seen_meets.add(key)
        result[entry.swimmer_id].append(_event(
            swimmer_id=entry.swimmer_id,
            reason="competition",
            date_from=meet.date,
            date_to=meet.date_to or meet.date,
            source="meet_entry",
            source_id=entry.id,
            meet_id=meet.id,
            detail=meet.name,
        ))

    # Manually logged competition load events cover competitions that have not
    # been entered through the meet timetable workflow.
    load_rows = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.swimmer_id.in_(swimmer_ids),
        models.SwimmerLoadEvent.event_type == "competition",
        models.SwimmerLoadEvent.date_from <= date_to,
        or_(
            models.SwimmerLoadEvent.date_to >= date_from,
            models.SwimmerLoadEvent.date_from >= date_from,
        ),
    ).all()
    for row in load_rows:
        result[row.swimmer_id].append(_event(
            swimmer_id=row.swimmer_id,
            reason="competition",
            date_from=row.date_from,
            date_to=row.date_to or row.date_from,
            source="load_event",
            source_id=row.id,
            detail=row.description,
        ))

    for events in result.values():
        events.sort(key=lambda item: (item["date_from"], item["reason"], item["source"]))
    return result


def availability_on_date(
    db: DBSession,
    swimmer_ids: Iterable[int],
    target_date: date,
) -> dict[int, dict]:
    ranges = availability_ranges(db, swimmer_ids, target_date, target_date)
    available = {}
    priority = {"competition": 0, "taper_rest": 1, "planned_rest": 2, "injury": 3}
    for swimmer_id, events in ranges.items():
        covering = [
            event for event in events
            if event["date_from"] <= target_date <= event["date_to"]
        ]
        if covering:
            available[swimmer_id] = sorted(
                covering, key=lambda item: priority.get(item["reason"], 10),
            )[0]
    return available


def is_excused(ranges: dict[int, list[dict]], swimmer_id: int, target_date: date) -> bool:
    return any(
        event["date_from"] <= target_date <= event["date_to"]
        for event in ranges.get(swimmer_id, [])
    )

