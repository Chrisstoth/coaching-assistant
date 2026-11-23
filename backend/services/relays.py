"""Relay swims: kept apart from individual swims, and never counted as one.

A relay leg is not an individual swim (legs 2-4 are flying starts), so it
must not count towards PBs, qualifying times, targets or predictions. Relay
legs live in their own table (RelaySwim), which nothing that works those out
reads. The coach enters them on the gala.

Round "R" in a results file is NOT a relay swim: it is a relay-approved
lead-off time (only given at nationals), an official individual time, and
stays one. Only a swim whose event is itself a relay ("4x50 Medley Relay")
is moved out of the individual swims, by move_relays_out() after imports.
"""
import re
import uuid
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.event_normalizer import canonicalize_event
from backend.services.importer import parse_time_to_seconds

RELAY_EVENTS = {
    "4x50 Medley": (50, ["Backstroke", "Breaststroke", "Butterfly", "Freestyle"]),
    "4x100 Medley": (100, ["Backstroke", "Breaststroke", "Butterfly", "Freestyle"]),
    "4x50 Freestyle": (50, ["Freestyle"] * 4),
    "4x100 Freestyle": (100, ["Freestyle"] * 4),
    "4x200 Freestyle": (200, ["Freestyle"] * 4),
}
_RELAY_TEXT = re.compile(r"relay|\b\d\s*x\s*\d", re.IGNORECASE)


def is_relay_swim(swim: models.SwimTime) -> bool:
    """A relay event. Round "R" (a relay-approved lead-off) is an individual swim."""
    return bool(_RELAY_TEXT.search(swim.event or ""))


def _same(relay: models.RelaySwim, swim: models.SwimTime) -> bool:
    return (relay.date == swim.date and canonicalize_event(relay.event) == canonicalize_event(swim.event or "")
            and round(relay.time_seconds, 2) == round(swim.time_seconds or 0, 2))


def move_relays_out(db: DBSession) -> int:
    """Move relay swims out of the individual swims. Returns how many moved
    (a relay already moved before is just removed from the individual swims)."""
    candidates = db.query(models.SwimTime).filter(
        models.SwimTime.event.ilike("%relay%")
        | models.SwimTime.event.ilike("%4x%")
        | models.SwimTime.event.ilike("%4 x%")
    ).all()
    moved = 0
    for swim in candidates:
        if not is_relay_swim(swim):
            continue
        known = db.query(models.RelaySwim).filter(
            models.RelaySwim.swimmer_id == swim.swimmer_id, models.RelaySwim.date == swim.date).all()
        if not any(_same(relay, swim) for relay in known):
            db.add(models.RelaySwim(
                swimmer_id=swim.swimmer_id, meet_id=swim.meet_id, leg=None,
                event=re.sub(r"\s+(SCM|LCM)$", "", swim.event or "").strip() or (swim.event or ""),
                course=swim.course, time_seconds=swim.time_seconds, splits=swim.splits, flying_start=False,
                date=swim.date, meet=swim.meet, venue=swim.venue, source=swim.source,
                lanewatch_log_id=swim.lanewatch_log_id, lanewatch_paired_by=swim.lanewatch_paired_by,
            ))
            moved += 1
        db.delete(swim)
    if candidates:
        db.commit()
    return moved


def move_relays_out_on_startup() -> None:
    from backend.database import SessionLocal
    try:
        with SessionLocal() as db:
            move_relays_out(db)
    except Exception:  # noqa: BLE001 - never stops the app starting
        pass


# ---------------------------------------------------------------------------
# A gala's relay teams, entered by the coach
# ---------------------------------------------------------------------------

def _leg_out(relay: models.RelaySwim, names: dict) -> dict:
    return {
        "id": relay.id, "leg": relay.leg, "swimmer_id": relay.swimmer_id,
        "swimmer_name": names.get(relay.swimmer_id), "event": relay.event, "time_seconds": relay.time_seconds,
        "splits": relay.splits, "flying_start": bool(relay.flying_start),
    }


def meet_relays(db: DBSession, meet: models.Meet) -> dict:
    rows = db.query(models.RelaySwim).filter(models.RelaySwim.meet_id == meet.id).all()
    names = {s.id: s.name for s in db.query(models.Swimmer).filter(
        models.Swimmer.id.in_({row.swimmer_id for row in rows})).all()} if rows else {}
    teams: dict[str, dict] = {}
    loose = []
    for row in rows:
        if not row.relay_group:
            loose.append(_leg_out(row, names))
            continue
        team = teams.setdefault(row.relay_group, {
            "relay_group": row.relay_group, "relay_event": row.relay_event, "team": row.team,
            "team_time_seconds": row.team_time_seconds, "legs": [],
        })
        team["legs"].append(_leg_out(row, names))
    for team in teams.values():
        team["legs"].sort(key=lambda leg: leg["leg"] or 0)
    return {
        "relay_events": list(RELAY_EVENTS),
        "teams": sorted(teams.values(), key=lambda t: (t["relay_event"] or "", t["team"] or "")),
        "lead_off_legs": sorted(loose, key=lambda leg: (leg["swimmer_name"] or "", leg["event"] or "")),
    }


def _splits(text) -> Optional[list]:
    if isinstance(text, list):
        values = [parse_time_to_seconds(v) for v in text]
    else:
        values = [parse_time_to_seconds(part) for part in re.split(r"[,\s]+", str(text or "").strip()) if part]
    values = [v for v in values if v]
    return values or None


def save_relay_team(db: DBSession, meet: models.Meet, body: dict) -> str:
    """Save (or replace) one relay team at this gala. Raises ValueError."""
    relay_event = body.get("relay_event")
    if relay_event not in RELAY_EVENTS:
        raise ValueError("Choose the relay (for example 4x50 Medley).")
    distance, strokes = RELAY_EVENTS[relay_event]
    legs = body.get("legs") or []
    if not legs:
        raise ValueError("Add at least one leg.")
    team_time = parse_time_to_seconds(body.get("team_time")) if body.get("team_time") else None
    group = body.get("relay_group") or uuid.uuid4().hex
    swimmer_ids = {s.id for s in db.query(models.Swimmer.id).all()}

    prepared = []
    for leg in legs:
        number = int(leg.get("leg") or 0)
        if number not in (1, 2, 3, 4):
            raise ValueError("Each leg needs its position, 1 to 4.")
        if leg.get("swimmer_id") not in swimmer_ids:
            raise ValueError(f"Leg {number}: choose a swimmer.")
        seconds = parse_time_to_seconds(leg.get("time"))
        if not seconds or seconds <= 0:
            raise ValueError(f"Leg {number}: couldn't read the time '{leg.get('time') or ''}'.")
        prepared.append(models.RelaySwim(
            swimmer_id=leg["swimmer_id"], meet_id=meet.id, relay_group=group, relay_event=relay_event,
            team=(body.get("team") or "").strip() or None, team_time_seconds=team_time, leg=number,
            event=f"{distance} {strokes[number - 1]}", course=meet.course, time_seconds=seconds,
            splits=_splits(leg.get("splits")), flying_start=number > 1, date=meet.date, meet=meet.name,
            venue=meet.location, source="relay_entry",
        ))
    if len({leg.leg for leg in prepared}) != len(prepared):
        raise ValueError("Two legs have the same position.")

    db.query(models.RelaySwim).filter(
        models.RelaySwim.meet_id == meet.id, models.RelaySwim.relay_group == group).delete()
    db.add_all(prepared)
    db.commit()
    return group


def delete_relay_team(db: DBSession, meet: models.Meet, group: str) -> bool:
    count = db.query(models.RelaySwim).filter(
        models.RelaySwim.meet_id == meet.id, models.RelaySwim.relay_group == group).delete()
    db.commit()
    return bool(count)


def swimmer_relays(db: DBSession, swimmer_id: int) -> list:
    rows = db.query(models.RelaySwim).filter(models.RelaySwim.swimmer_id == swimmer_id).order_by(
        models.RelaySwim.date.desc()).all()
    return [{
        "id": row.id, "relay_event": row.relay_event, "team": row.team, "leg": row.leg, "event": row.event,
        "course": row.course, "time_seconds": row.time_seconds, "splits": row.splits,
        "flying_start": bool(row.flying_start), "date": row.date.isoformat() if row.date else None,
        "meet": row.meet, "meet_id": row.meet_id,
    } for row in rows]
