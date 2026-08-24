"""Canonical competition-event storage and matching helpers."""
import re
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models


STROKE_ALIASES = {
    "free": "freestyle", "freestyle": "freestyle", "fc": "freestyle",
    "back": "backstroke", "backstroke": "backstroke", "bk": "backstroke",
    "breast": "breaststroke", "breaststroke": "breaststroke", "br": "breaststroke",
    "fly": "butterfly", "butterfly": "butterfly", "bf": "butterfly",
    "im": "individual medley", "individual medley": "individual medley",
    "medley": "medley",
}


def canonicalize_event(value: str) -> str:
    text = (value or "").lower().replace("×", "x")
    text = re.sub(r"\bevent\s*\d+[a-z]?\b", " ", text)
    text = re.sub(r"\b(scm|lcm|short course|long course|heats?|finals?|semi[- ]?finals?)\b", " ", text)
    text = re.sub(r"\b(male|female|boys?|girls?|men|women|mixed)\b", " ", text)
    text = re.sub(r"\b(25|50|100|200|400|800|1500)\s*m\b", r"\1", text)
    text = re.sub(r"[^a-z0-9x ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    distance_match = re.search(r"\b(25|50|100|200|400|800|1500)\b", text)
    relay_match = re.search(r"\b(4\s*x\s*(?:25|50|100|200))\b", text)
    distance = relay_match.group(1).replace(" ", "") if relay_match else (distance_match.group(1) if distance_match else "")

    stroke = ""
    for alias in sorted(STROKE_ALIASES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(alias)}\b", text):
            stroke = STROKE_ALIASES[alias]
            break
    relay = " relay" if "relay" in text or relay_match else ""
    canonical = " ".join(part for part in (distance, stroke) if part).strip()
    return (canonical + relay).strip() or text


def event_parts(value: str) -> tuple[Optional[int], Optional[str]]:
    canonical = canonicalize_event(value)
    distance_match = re.match(r"^(\d+)", canonical)
    distance = int(distance_match.group(1)) if distance_match else None
    stroke = next((stroke for stroke in set(STROKE_ALIASES.values()) if stroke in canonical), None)
    return distance, stroke


def sync_meet_session_events(session: models.MeetSession, db: DBSession) -> list[models.MeetEvent]:
    existing = db.query(models.MeetEvent).filter(models.MeetEvent.meet_session_id == session.id).all()
    existing_ids = [event.id for event in existing]
    if existing_ids:
        db.query(models.MeetEntry).filter(models.MeetEntry.meet_event_id.in_(existing_ids)).update(
            {"meet_event_id": None}, synchronize_session=False,
        )
        for event in existing:
            db.delete(event)
        db.flush()

    created = []
    for index, raw in enumerate(session.events or []):
        item = raw if isinstance(raw, dict) else {"name": str(raw)}
        name = item.get("name") or str(raw)
        distance, stroke = event_parts(name)
        event = models.MeetEvent(
            meet_id=session.meet_id,
            meet_session_id=session.id,
            event_number=str(item.get("number")) if item.get("number") is not None else None,
            name=name,
            canonical_event=canonicalize_event(name),
            distance=distance,
            stroke=stroke,
            gender=item.get("gender"),
            round=item.get("round"),
            scheduled_time=item.get("start_time"),
            order_index=index,
            raw_data=item,
        )
        db.add(event)
        created.append(event)
    db.flush()
    relink_meet_entries(session.meet_id, db)
    return created


def find_meet_event(meet_id: int, event_name: str, db: DBSession) -> Optional[models.MeetEvent]:
    canonical = canonicalize_event(event_name)
    exact = db.query(models.MeetEvent).filter(
        models.MeetEvent.meet_id == meet_id,
        models.MeetEvent.canonical_event == canonical,
    ).order_by(models.MeetEvent.order_index).first()
    return exact


def relink_meet_entries(meet_id: int, db: DBSession) -> None:
    entries = db.query(models.MeetEntry).filter(models.MeetEntry.meet_id == meet_id).all()
    for entry in entries:
        matched = find_meet_event(meet_id, entry.event_name, db)
        entry.canonical_event = canonicalize_event(entry.event_name)
        entry.meet_event_id = matched.id if matched else None


def upsert_meet_entry(
    meet_id: int,
    swimmer_id: int,
    event_name: str,
    db: DBSession,
    *,
    priority: Optional[str] = None,
    target_time: Optional[str] = None,
    entry_time: Optional[str] = None,
    source: str = "manual",
) -> models.MeetEntry:
    canonical = canonicalize_event(event_name)
    entry = db.query(models.MeetEntry).filter(
        models.MeetEntry.meet_id == meet_id,
        models.MeetEntry.swimmer_id == swimmer_id,
        models.MeetEntry.canonical_event == canonical,
    ).first()
    event = find_meet_event(meet_id, event_name, db)
    if not entry:
        entry = models.MeetEntry(
            meet_id=meet_id,
            swimmer_id=swimmer_id,
            event_name=event_name,
            canonical_event=canonical,
        )
        db.add(entry)
    entry.meet_event_id = event.id if event else None
    entry.priority = priority or entry.priority
    entry.target_time = target_time or entry.target_time
    entry.entry_time = entry_time or entry.entry_time
    entry.source = source
    entry.status = "confirmed"
    return entry
