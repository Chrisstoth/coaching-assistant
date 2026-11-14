"""Training target times worked out from race PBs.

A target set is the coach's recipe: start from a PB (say the 100), cut it down
to the rep distance (÷ 4 for each 25), then add the steps the coach wants
(+0.5, +1.0). Nothing is stored per swimmer; the times are worked out from the
current PBs every time, so they follow the swimmer as they get faster.
"""
from __future__ import annotations

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.event_normalizer import canonicalize_event

STROKES = ["Freestyle", "Backstroke", "Breaststroke", "Butterfly", "Individual Medley"]
SHORT_STROKE = {
    "Freestyle": "Free", "Backstroke": "Back", "Breaststroke": "Breast",
    "Butterfly": "Fly", "Individual Medley": "IM",
}
COURSES = ("SCM", "LCM")


# ---------------------------------------------------------------------------
# Reading race times
# ---------------------------------------------------------------------------

def parse_event(text: str) -> tuple[Optional[int], Optional[str]]:
    """'100 Back', '200 IM', '100 Freestyle SCM' → (100, 'Backstroke') etc."""
    canonical = canonicalize_event(text or "")
    if "relay" in canonical:
        return None, None
    match = re.match(r"^(\d+)\b", canonical)
    distance = int(match.group(1)) if match else None
    stroke = next((s for s in STROKES if s.lower() in canonical), None)
    return distance, stroke


def race_event(t: models.SwimTime) -> tuple[Optional[int], Optional[str]]:
    """The race a time was swum in.

    Swimrankings rows keep the race in the stroke column ("100 Freestyle") and
    can carry the split length in the distance column, so a 100 can arrive
    saying 50. The stroke column wins when it names a distance.
    """
    distance, stroke = parse_event(t.stroke or "")
    if distance and stroke:
        return distance, stroke
    event_distance, event_stroke = parse_event(t.event or "")
    return (t.distance or event_distance), (stroke or event_stroke)


def course_of(t: models.SwimTime) -> Optional[str]:
    raw = (t.course or "").strip().upper()
    if raw in ("S", "SC", "SCM", "25"):
        return "SCM"
    if raw in ("L", "LC", "LCM", "50"):
        return "LCM"
    tail = (t.event or "").strip().upper()
    if tail.endswith(("SCM", " S")):
        return "SCM"
    if tail.endswith(("LCM", " L")):
        return "LCM"
    return None


def personal_bests(times: Iterable[models.SwimTime], course: str,
                   as_of: Optional[date] = None) -> dict[tuple[int, str], models.SwimTime]:
    """Fastest time per (distance, stroke) in one pool length, optionally as it stood on a date."""
    best: dict[tuple[int, str], models.SwimTime] = {}
    for t in times:
        if not t.time_seconds or t.time_seconds <= 0 or course_of(t) != course:
            continue
        if as_of and t.date and t.date > as_of:
            continue
        distance, stroke = race_event(t)
        if not distance or not stroke:
            continue
        key = (distance, stroke)
        if key not in best or t.time_seconds < best[key].time_seconds:
            best[key] = t
    return best


# ---------------------------------------------------------------------------
# Numbers and words
# ---------------------------------------------------------------------------

def round_time(seconds: float, decimals: int) -> float:
    step = Decimal(1).scaleb(-decimals)
    return float(Decimal(str(seconds)).quantize(step, rounding=ROUND_HALF_UP))


def format_time(seconds: float, decimals: int = 2) -> str:
    value = Decimal(str(seconds)).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
    minutes = int(value // 60)
    rest = value - minutes * 60
    width = 3 + decimals
    if minutes:
        return f"{minutes}:{rest:0{width}.{decimals}f}"
    return f"{rest:.{decimals}f}"


def _plain_number(value: float) -> str:
    return f"{value:.1f}" if round(value, 1) == value else f"{value:g}"


def offset_label(offset: float) -> str:
    if offset == 0:
        return "PB pace"
    return ("+" if offset > 0 else "−") + _plain_number(abs(offset))


def _join(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def describe(ts) -> str:
    """'100 PB ÷ 4 for each 25, then +0.5 and +1.0 (short course)'."""
    rep = ts.rep_distance
    if ts.base_distance:
        ratio = ts.base_distance / rep
        if ratio == int(ratio) and ratio >= 1:
            text = f"{ts.base_distance} PB ÷ {int(ratio)} for each {rep}" if ratio > 1 else f"{rep} PB"
        else:
            text = f"{ts.base_distance} PB scaled to each {rep}"
    else:
        text = f"Each target event's PB, split into {rep}s"
    extras = [offset_label(o) for o in (ts.offsets or []) if o != 0]
    if extras:
        text += (", then " if 0 in (ts.offsets or []) else ": ") + _join(extras)
    return f"{text} ({'short' if ts.course == 'SCM' else 'long'} course PBs)"


def columns(ts) -> list[dict]:
    return [{"offset": o, "label": offset_label(o)} for o in (ts.offsets or [0])]


# ---------------------------------------------------------------------------
# Working out a swimmer's targets
# ---------------------------------------------------------------------------

def target_events(swimmer: models.Swimmer) -> list[tuple[int, str]]:
    found = []
    for item in swimmer.target_events or []:
        text = item.get("event", "") if isinstance(item, dict) else str(item)
        distance, stroke = parse_event(text)
        if distance and stroke and (distance, stroke) not in found:
            found.append((distance, stroke))
    return found


def events_for(swimmer: models.Swimmer, ts) -> list[tuple[int, str]]:
    """Which PBs this set uses for this swimmer, in a sensible order."""
    chosen = [s for s in STROKES if s in (ts.strokes or [])]
    own = target_events(swimmer)
    if ts.base_distance:
        strokes = chosen or [s for _, s in own]
        ordered = []
        for s in strokes:
            if s not in ordered:
                ordered.append(s)
        return [(ts.base_distance, s) for s in ordered]
    if chosen:
        own = [(d, s) for d, s in own if s in chosen]
    return own


def swimmer_targets(swimmer: models.Swimmer, ts, pbs: dict) -> dict:
    events = events_for(swimmer, ts)
    note = None
    if not events:
        note = "No target events on their profile yet" if not ts.strokes else "No matching target events"
    rows = []
    course = ts.course
    for distance, stroke in events:
        event = f"{distance} {stroke}"
        pb = pbs.get((distance, stroke))
        if not pb:
            rows.append({
                "event": event, "short_event": f"{distance} {SHORT_STROKE[stroke]}",
                "distance": distance, "stroke": stroke, "pb": None, "times": [],
                "missing": f"No {event} {course} time yet",
            })
            continue
        pace = round_time(pb.time_seconds * ts.rep_distance / distance, ts.decimals)
        times = []
        for offset in ts.offsets or [0]:
            seconds = round_time(pace + offset, ts.decimals)
            times.append({"offset": offset, "seconds": seconds, "display": format_time(seconds, ts.decimals)})
        rows.append({
            "event": event, "short_event": f"{distance} {SHORT_STROKE[stroke]}",
            "distance": distance, "stroke": stroke,
            "pb": {
                "seconds": pb.time_seconds, "display": format_time(pb.time_seconds, 2),
                "date": pb.date.isoformat() if pb.date else None, "meet": pb.meet,
            },
            "times": times, "missing": None,
        })
    return {"id": swimmer.id, "name": swimmer.name, "squad": swimmer.squad, "note": note, "rows": rows}


def _times_by_swimmer(swimmer_ids: list[int], db: DBSession) -> dict[int, list[models.SwimTime]]:
    grouped: dict[int, list[models.SwimTime]] = {sid: [] for sid in swimmer_ids}
    if swimmer_ids:
        for t in db.query(models.SwimTime).filter(models.SwimTime.swimmer_id.in_(swimmer_ids)).all():
            grouped[t.swimmer_id].append(t)
    return grouped


def build_table(ts, db: DBSession, squad: Optional[str] = None) -> dict:
    """The whole squad's targets for one set."""
    squad = squad if squad is not None else ts.squad
    q = db.query(models.Swimmer).filter(models.Swimmer.active == True)  # noqa: E712
    if squad:
        q = q.filter(models.Swimmer.squad == squad)
    swimmers = q.order_by(models.Swimmer.name).all()
    times = _times_by_swimmer([s.id for s in swimmers], db)
    return {
        "summary": describe(ts),
        "squad": squad or None,
        "columns": columns(ts),
        "swimmers": [swimmer_targets(s, ts, personal_bests(times[s.id], ts.course)) for s in swimmers],
    }


def swimmer_sets(swimmer: models.Swimmer, sets: list, db: DBSession) -> list[dict]:
    """Every saved set that covers this swimmer, with their times."""
    times = _times_by_swimmer([swimmer.id], db)[swimmer.id]
    pbs_by_course = {c: personal_bests(times, c) for c in COURSES}
    out = []
    for ts in sets:
        if ts.squad and ts.squad != swimmer.squad:
            continue
        mine = swimmer_targets(swimmer, ts, pbs_by_course.get(ts.course, {}))
        out.append({
            "set_id": ts.id, "name": ts.name, "summary": describe(ts),
            "columns": columns(ts), "rows": mine["rows"], "note": mine["note"],
        })
    return out


# ---------------------------------------------------------------------------
# Target sets used in a session
# ---------------------------------------------------------------------------

def session_links(session: models.Session) -> list[dict]:
    links = []
    for item in session.targets or []:
        if isinstance(item, dict) and isinstance(item.get("target_set_id"), int):
            links.append({"target_set_id": item["target_set_id"], "note": (item.get("note") or "").strip() or None})
    return links


def session_swimmer_ids(session: models.Session, db: DBSession) -> tuple[list[int], str]:
    """Who the session's targets are for: the register if taken, else who it was written for."""
    attended = [row.swimmer_id for row in db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id == session.id, models.SessionEntry.attended == True,  # noqa: E712
    ).all()]
    if attended:
        return attended, "register"
    planned = [i for i in ((session.audience or {}).get("swimmer_ids") or []) if isinstance(i, int)]
    if planned:
        return planned, "audience"
    if session.squad:
        ids = [row.id for row in db.query(models.Swimmer.id).filter(
            models.Swimmer.active == True, models.Swimmer.squad == session.squad,  # noqa: E712
        ).all()]
        return ids, "squad"
    return [], "none"


def session_tables(session: models.Session, db: DBSession, swimmer_ids: Optional[list[int]] = None) -> list[dict]:
    """Each target set on the session, with the times its swimmers had on the day."""
    links = session_links(session)
    if not links:
        return []
    sets = {ts.id: ts for ts in db.query(models.TargetSet).filter(
        models.TargetSet.id.in_([link["target_set_id"] for link in links]),
    ).all()}
    if swimmer_ids is None:
        swimmer_ids, _ = session_swimmer_ids(session, db)
    swimmers = (db.query(models.Swimmer).filter(models.Swimmer.id.in_(swimmer_ids or [-1]))
                .order_by(models.Swimmer.name).all())
    times = _times_by_swimmer([s.id for s in swimmers], db)
    pbs = {(s.id, c): personal_bests(times[s.id], c, as_of=session.date) for s in swimmers for c in COURSES}
    out = []
    for link in links:
        ts = sets.get(link["target_set_id"])
        if not ts:
            continue
        out.append({
            "target_set_id": ts.id, "name": ts.name, "summary": describe(ts), "note": link["note"],
            "columns": columns(ts),
            "swimmers": [swimmer_targets(s, ts, pbs[(s.id, ts.course)]) for s in swimmers],
        })
    return out


def _swimmer_line(entry: dict) -> str:
    parts = []
    for row in entry["rows"]:
        if row["times"]:
            parts.append(f"{row['short_event']} (PB {row['pb']['display']}) " + " / ".join(t["display"] for t in row["times"]))
        else:
            parts.append(f"{row['short_event']} no PB yet")
    return "; ".join(parts) or (entry["note"] or "no target events")


def session_context_text(session: models.Session, db: DBSession,
                         swimmer_ids: Optional[list[int]] = None, max_chars: int = 3500) -> str:
    """The session's target times, for the staff and the AI. Empty when none are set."""
    tables = session_tables(session, db, swimmer_ids)
    if not tables:
        return ""
    lines = [
        "TARGET TIMES SET FOR THIS SESSION (the coach's targets for the reps, worked out from each "
        f"swimmer's PBs as of {session.date.isoformat()}. These are targets, not results; only the coach's "
        "register and observations say what was swum):"
    ]
    for table in tables:
        lines.append(f'- "{table["name"]}": {table["summary"]}'
                     + (f". Used for: {table['note']}" if table["note"] else "")
                     + f". Times shown: {', '.join(c['label'] for c in table['columns'])}")
        for entry in table["swimmers"]:
            lines.append(f"    {entry['name']}: {_swimmer_line(entry)}")
    text = "\n".join(lines)
    return text if len(text) <= max_chars else text[:max_chars - 1] + "…"


def swimmer_target_lines(session: models.Session, db: DBSession, swimmer_ids: list[int]) -> dict[int, list[str]]:
    """Each swimmer's targets for a session, as short lines for a per-swimmer brief."""
    lines: dict[int, list[str]] = {}
    for table in session_tables(session, db, swimmer_ids):
        label = table["name"] + (f" ({table['note']})" if table["note"] else "")
        for entry in table["swimmers"]:
            lines.setdefault(entry["id"], []).append(f"{label}: {_swimmer_line(entry)}")
    return lines
