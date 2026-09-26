"""What each member of the coaching staff can do, not just say.

Every action is a proposal. A specialist puts one forward with a note; nothing
changes until the coach presses "Do it". Each action goes through the same
code the rest of the app already uses - creating a meet, saving results,
logging an illness - so a staff action has exactly the side effects a coach
doing it by hand would have.

Actions are owned by roles. The physiologist cannot enter a swimmer into a
race; the meet manager cannot change their training load. When the coach
approves an action, one colleague is asked to look at the consequence - results
go to the analyst, an injury goes to the physiologist - so the staff work as a
team rather than a row of separate assistants.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Callable, Optional

from sqlalchemy.orm import Session as DBSession

from backend import models


class ActionError(ValueError):
    """A proposed action that cannot be carried out as written."""


@dataclass(frozen=True)
class ActionSpec:
    type: str
    roles: tuple
    label: str                        # the button: "Add this meet"
    schema: str                       # what the specialist is told to send
    validate: Callable                # (payload, db) -> clean payload; raises ActionError
    describe: Callable                # (clean, db) -> list of plain-language lines
    apply: Callable                   # (clean, db) -> short result sentence
    handoff: Callable                 # (clean, proposer, db) -> (role, topic) or None


# ---------------------------------------------------------------------------
# Small validators
# ---------------------------------------------------------------------------

def _int(value, what: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ActionError(f"{what} is missing or not a number")


def _date(value, what: str, required: bool = True) -> Optional[date]:
    if value in (None, "", "null"):
        if required:
            raise ActionError(f"{what} is missing")
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ActionError(f"{what} is not a date (YYYY-MM-DD)")


def _text(value, what: str, required: bool = True, limit: int = 500) -> Optional[str]:
    text = str(value).strip() if value not in (None, "null") else ""
    if not text:
        if required:
            raise ActionError(f"{what} is missing")
        return None
    return text[:limit]


def _swimmer(db: DBSession, swimmer_id) -> models.Swimmer:
    sid = _int(swimmer_id, "Swimmer")
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == sid).first()
    if not swimmer:
        raise ActionError(f"There is no swimmer with id {sid}")
    return swimmer


def _meet(db: DBSession, meet_id) -> models.Meet:
    mid = _int(meet_id, "Meet")
    meet = db.query(models.Meet).filter(models.Meet.id == mid).first()
    if not meet:
        raise ActionError(f"There is no meet with id {mid}")
    return meet


def _macro(db: DBSession, macro_id) -> models.TrainingMacro:
    mid = _int(macro_id, "Macrocycle")
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == mid).first()
    if not macro:
        raise ActionError(f"There is no macrocycle with id {mid}")
    return macro


def _pathway(db: DBSession, pathway_id) -> models.PlanningPathway:
    pid = _int(pathway_id, "Pathway")
    pathway = db.query(models.PlanningPathway).filter(models.PlanningPathway.id == pid).first()
    if not pathway:
        raise ActionError(f"There is no pathway with id {pid}")
    return pathway


def _name(db: DBSession, swimmer_id: int) -> str:
    row = db.query(models.Swimmer.name).filter(models.Swimmer.id == swimmer_id).first()
    return row[0] if row else f"swimmer {swimmer_id}"


def _seconds(value) -> Optional[float]:
    from backend.services.importer import parse_time_to_seconds
    try:
        seconds = parse_time_to_seconds(str(value))
    except Exception:
        return None
    return seconds if seconds and seconds > 0 else None


def _fmt(d: Optional[date]) -> str:
    return d.strftime("%d %b %Y") if d else ""


# ---------------------------------------------------------------------------
# Meet Manager
# ---------------------------------------------------------------------------

def _v_create_meet(p, db):
    name = _text(p.get("name"), "Meet name", limit=200)
    start = _date(p.get("start_date"), "Start date")
    end = _date(p.get("end_date"), "End date", required=False)
    if end and end < start:
        raise ActionError("The meet ends before it starts")
    course = (str(p.get("course") or "").upper() or None)
    if course not in (None, "SCM", "LCM"):
        course = None
    level = (str(p.get("level") or "").lower() or None)
    if level not in (None, "club", "county", "regional", "national", "international"):
        level = None
    existing = db.query(models.Meet).filter(models.Meet.date == start).all()
    if any(m.name.strip().lower() == name.lower() for m in existing):
        raise ActionError(f"{name} on {_fmt(start)} is already in the meet list")
    return {"name": name, "start_date": start.isoformat(),
            "end_date": end.isoformat() if end else None,
            "location": _text(p.get("location"), "Location", required=False, limit=200),
            "course": course, "level": level}


def _d_create_meet(c, db):
    when = _fmt(date.fromisoformat(c["start_date"]))
    if c["end_date"] and c["end_date"] != c["start_date"]:
        when += f" to {_fmt(date.fromisoformat(c['end_date']))}"
    extra = " · ".join(x for x in (c["course"], c["level"], c["location"]) if x)
    return [f"{c['name']} - {when}" + (f" · {extra}" if extra else "")]


def _a_create_meet(c, db):
    from backend.routers.meets import MeetCreate, create_meet
    meet = create_meet(MeetCreate(
        name=c["name"], start_date=c["start_date"], end_date=c["end_date"],
        location=c["location"], course=c["course"], level=c["level"],
    ), db)
    c["meet_id"] = meet["id"] if isinstance(meet, dict) else getattr(meet, "id", None)
    return f"Added {c['name']} to the meet list."


def _h_create_meet(c, proposer, db):
    return ("planner", f"A new meet was added: {c['name']} starting {c['start_date']}. "
                       "Does it change where the peaks should land or clash with a taper?")


def _v_add_entries(p, db):
    meet = _meet(db, p.get("meet_id"))
    entries = []
    for row in (p.get("entries") or [])[:80]:
        swimmer = _swimmer(db, row.get("swimmer_id"))
        event = _text(row.get("event"), "Event", limit=80)
        priority = str(row.get("priority") or "").upper()[:1] or None
        entries.append({"swimmer_id": swimmer.id, "event": event,
                        "priority": priority if priority in ("A", "B", "C") else None})
    if not entries:
        raise ActionError("No swims to enter")
    return {"meet_id": meet.id, "entries": entries}


def _d_add_entries(c, db):
    meet = _meet(db, c["meet_id"])
    by_swimmer = {}
    for e in c["entries"]:
        by_swimmer.setdefault(e["swimmer_id"], []).append(e["event"])
    return [f"{meet.name}:"] + [f"{_name(db, sid)} - {', '.join(events)}" for sid, events in by_swimmer.items()]


def _a_add_entries(c, db):
    from backend.routers.meets import MeetTargetCreate, add_target
    by_swimmer = {}
    for e in c["entries"]:
        by_swimmer.setdefault(e["swimmer_id"], {"events": [], "priority": None})
        by_swimmer[e["swimmer_id"]]["events"].append(e["event"])
        by_swimmer[e["swimmer_id"]]["priority"] = by_swimmer[e["swimmer_id"]]["priority"] or e["priority"]
    for sid, data in by_swimmer.items():
        existing = db.query(models.MeetTarget).filter(
            models.MeetTarget.meet_id == c["meet_id"], models.MeetTarget.swimmer_id == sid,
        ).first()
        # Add to what the swimmer is already entered in; never drop an entry.
        merged = list(dict.fromkeys([*(existing.events if existing else []), *data["events"]]))
        add_target(c["meet_id"], MeetTargetCreate(swimmer_id=sid, events=merged,
                                                  priority=data["priority"]), db)
    return f"Entered {len(c['entries'])} swim{'s' if len(c['entries']) != 1 else ''}."


def _h_add_entries(c, proposer, db):
    meet = _meet(db, c["meet_id"])
    swims = "; ".join(f"{_name(db, e['swimmer_id'])} {e['event']}" for e in c["entries"][:20])
    return ("analyst", f"Entries were made for {meet.name}: {swims}. "
                       "Are these realistic given each swimmer's times and qualification?")


def _v_record_results(p, db):
    meet = _meet(db, p.get("meet_id"))
    results = []
    for row in (p.get("results") or [])[:120]:
        swimmer = _swimmer(db, row.get("swimmer_id"))
        event = _text(row.get("event"), "Event", limit=80)
        time_text = _text(row.get("time"), "Time", limit=20)
        if _seconds(time_text) is None:
            raise ActionError(f"'{time_text}' for {swimmer.name} is not a readable time")
        round_ = _text(row.get("round"), "Round", required=False, limit=20)
        results.append({"swimmer_id": swimmer.id, "event": event, "time": time_text, "round": round_})
    if not results:
        raise ActionError("No results to record")
    return {"meet_id": meet.id, "results": results}


def _d_record_results(c, db):
    meet = _meet(db, c["meet_id"])
    return [f"{meet.name}:"] + [
        f"{_name(db, r['swimmer_id'])} - {r['event']} {r['time']}" + (f" ({r['round']})" if r["round"] else "")
        for r in c["results"]
    ]


def _a_record_results(c, db):
    from backend.routers.meets import MeetResultRow, MeetResultsSubmit, save_meet_results
    outcome = save_meet_results(c["meet_id"], MeetResultsSubmit(results=[
        MeetResultRow(swimmer_id=r["swimmer_id"], event=r["event"], time=r["time"], round=r["round"])
        for r in c["results"]
    ]), db)
    errors = outcome.get("errors") if isinstance(outcome, dict) else None
    if errors:
        return f"Recorded results, with problems: {'; '.join(errors[:3])}"
    return f"Recorded {len(c['results'])} result{'s' if len(c['results']) != 1 else ''} into each swimmer's history."


def _h_record_results(c, proposer, db):
    meet = _meet(db, c["meet_id"])
    swims = "; ".join(f"{_name(db, r['swimmer_id'])} {r['event']} {r['time']}" for r in c["results"][:20])
    return ("analyst", f"Results were recorded for {meet.name}: {swims}. "
                       "How do they compare with targets, personal bests and qualification?")


# ---------------------------------------------------------------------------
# Physiologist and Swimmer Manager: what is happening to the swimmer
# ---------------------------------------------------------------------------

def _load_event_types():
    from backend.routers.swimmers import LOAD_EVENT_TYPES
    return LOAD_EVENT_TYPES


def _v_log_load_event(p, db):
    swimmer = _swimmer(db, p.get("swimmer_id"))
    event_type = str(p.get("event_type") or "other").lower()
    if event_type not in _load_event_types():
        event_type = "other"
    start = _date(p.get("date_from"), "Start date")
    end = _date(p.get("date_to"), "End date", required=False)
    if end and end < start:
        raise ActionError("It ends before it starts")
    try:
        severity = max(1, min(3, int(p.get("severity") or 2)))
    except (TypeError, ValueError):
        severity = 2
    return {"swimmer_id": swimmer.id, "event_type": event_type,
            "date_from": start.isoformat(), "date_to": end.isoformat() if end else None,
            "severity": severity,
            "description": _text(p.get("description"), "Description", limit=400),
            "resolved": bool(p.get("resolved", False))}


def _d_log_load_event(c, db):
    sev = {1: "mild", 2: "moderate", 3: "significant"}[c["severity"]]
    when = _fmt(date.fromisoformat(c["date_from"])) + (
        f" to {_fmt(date.fromisoformat(c['date_to']))}" if c["date_to"] else "")
    return [f"{_name(db, c['swimmer_id'])}: {c['event_type'].replace('_', ' ')} ({sev}) from {when}",
            c["description"]]


def _a_log_load_event(c, db):
    from backend.routers.swimmers import LoadEventCreate, add_load_event
    add_load_event(c["swimmer_id"], LoadEventCreate(
        event_type=c["event_type"], date_from=date.fromisoformat(c["date_from"]),
        date_to=date.fromisoformat(c["date_to"]) if c["date_to"] else None,
        severity=c["severity"], description=c["description"], resolved=c["resolved"],
    ), db)
    return f"Logged on {_name(db, c['swimmer_id'])}'s record."


def _h_log_load_event(c, proposer, db):
    target = "planner" if proposer == "physiologist" else "physiologist"
    return (target, f"{_name(db, c['swimmer_id'])} now has a {c['event_type']} logged from "
                    f"{c['date_from']}: {c['description']}. What should change in their training?")


def _v_set_status(p, db):
    swimmer = _swimmer(db, p.get("swimmer_id"))
    status = str(p.get("status") or "").lower()
    if status not in ("active", "injury", "sabbatical"):
        raise ActionError("Status must be active, injury or sabbatical")
    if swimmer.status == status:
        raise ActionError(f"{swimmer.name} is already marked {status}")
    return {"swimmer_id": swimmer.id, "status": status, "was": swimmer.status or "active",
            "reason": _text(p.get("reason"), "Reason", limit=300)}


def _d_set_status(c, db):
    return [f"{_name(db, c['swimmer_id'])}: {c['was']} → {c['status']}", c["reason"]]


def _a_set_status(c, db):
    swimmer = _swimmer(db, c["swimmer_id"])
    swimmer.status = c["status"]
    db.commit()
    return f"{swimmer.name} is now marked {c['status']}."


def _h_set_status(c, proposer, db):
    return ("physiologist", f"{_name(db, c['swimmer_id'])} has gone from {c['was']} to {c['status']}: "
                            f"{c['reason']}. What does that mean for their load and return?")


def _v_add_availability(p, db):
    swimmer = _swimmer(db, p.get("swimmer_id"))
    reason = str(p.get("reason") or "other").lower()
    start = _date(p.get("date_from"), "Start date")
    end = _date(p.get("date_to"), "End date")
    if end < start:
        raise ActionError("It ends before it starts")
    return {"swimmer_id": swimmer.id, "reason": reason, "date_from": start.isoformat(),
            "date_to": end.isoformat(), "notes": _text(p.get("notes"), "Notes", required=False, limit=300)}


def _d_add_availability(c, db):
    return [f"{_name(db, c['swimmer_id'])} unavailable ({c['reason']}) "
            f"{_fmt(date.fromisoformat(c['date_from']))} to {_fmt(date.fromisoformat(c['date_to']))}"
            + (f" - {c['notes']}" if c["notes"] else "")]


def _a_add_availability(c, db):
    from backend.routers.schedule import ExceptionCreate, add_exception
    add_exception(c["swimmer_id"], ExceptionCreate(
        reason=c["reason"], date_from=date.fromisoformat(c["date_from"]),
        date_to=date.fromisoformat(c["date_to"]), notes=c["notes"],
    ), db)
    return f"Added to {_name(db, c['swimmer_id'])}'s availability."


def _h_add_availability(c, proposer, db):
    return ("planner", f"{_name(db, c['swimmer_id'])} is unavailable ({c['reason']}) from "
                       f"{c['date_from']} to {c['date_to']}. Does that hit a key block or meet?")


def _v_coaching_note(p, db):
    ids = [_swimmer(db, sid).id for sid in (p.get("swimmer_ids") or [])[:40]]
    start = _date(p.get("date_from") or date.today().isoformat(), "Start date")
    end = _date(p.get("date_to") or (start + timedelta(weeks=4)).isoformat(), "End date")
    if end < start:
        raise ActionError("It ends before it starts")
    return {"title": _text(p.get("title"), "Title", limit=120), "body": _text(p.get("body"), "Note", limit=1500),
            "swimmer_ids": ids, "date_from": start.isoformat(), "date_to": end.isoformat()}


def _d_coaching_note(c, db):
    who = ", ".join(_name(db, sid) for sid in c["swimmer_ids"]) or "the squad"
    return [f"{c['title']} - {who}, until {_fmt(date.fromisoformat(c['date_to']))}", c["body"]]


def _a_coaching_note(c, db):
    from backend.routers.coaching_notes import CoachingNoteCreate, create_coaching_note
    create_coaching_note(CoachingNoteCreate(
        title=c["title"], body=c["body"], swimmer_ids=c["swimmer_ids"],
        swimmer_names=[_name(db, sid) for sid in c["swimmer_ids"]],
        date_from=date.fromisoformat(c["date_from"]), date_to=date.fromisoformat(c["date_to"]),
    ), db)
    return "Coaching note added."


# ---------------------------------------------------------------------------
# Planner and Physiologist: the shape of the load
# ---------------------------------------------------------------------------

def _v_adjust_week_load(p, db):
    macro = _macro(db, p.get("macro_id"))
    pathway_id = p.get("pathway_id")
    if pathway_id not in (None, "", "null"):
        pathway = _pathway(db, pathway_id)
        if pathway.macro_id != macro.id:
            raise ActionError("That pathway belongs to a different macrocycle")
        pathway_id = pathway.id
    else:
        pathway_id = None
    weeks = []
    for row in (p.get("weeks") or [])[:30]:
        start = _date(row.get("week_start"), "Week")
        start = start - timedelta(days=start.weekday())
        if start + timedelta(days=6) < macro.date_from or start > macro.date_to:
            raise ActionError(f"The week of {_fmt(start)} is outside {macro.name}")
        value = _int(row.get("overall"), "Load")
        weeks.append({"week_start": start.isoformat(), "overall": max(0, min(100, value)),
                      "note": _text(row.get("note"), "Note", required=False, limit=200)})
    if not weeks:
        raise ActionError("No weeks to change")
    return {"macro_id": macro.id, "pathway_id": pathway_id, "weeks": weeks}


def _d_adjust_week_load(c, db):
    lines = []
    current = {
        p.week_start.isoformat(): p.overall for p in db.query(models.SeasonLoadPoint).filter(
            models.SeasonLoadPoint.macro_id == c["macro_id"],
            models.SeasonLoadPoint.pathway_id == c["pathway_id"],
        ).all()
    }
    if c["pathway_id"]:
        lines.append(f"Pathway: {_pathway(db, c['pathway_id']).name}")
    for w in c["weeks"]:
        was = current.get(w["week_start"])
        change = f"{was} → {w['overall']}" if was is not None else f"set to {w['overall']}"
        lines.append(f"Week of {_fmt(date.fromisoformat(w['week_start']))}: {change}"
                     + (f" ({w['note']})" if w["note"] else ""))
    return lines


def _a_adjust_week_load(c, db):
    from backend.routers.season import LoadProfileIn, LoadWeekIn, put_load_profile
    put_load_profile(LoadProfileIn(
        macro_id=c["macro_id"], pathway_id=c["pathway_id"], source="ai",
        weeks=[LoadWeekIn(week_start=date.fromisoformat(w["week_start"]), overall=w["overall"], note=w["note"])
               for w in c["weeks"]],
    ), db)
    return f"Updated {len(c['weeks'])} week{'s' if len(c['weeks']) != 1 else ''} of planned load."


def _h_adjust_week_load(c, proposer, db):
    target = "physiologist" if proposer == "planner" else "planner"
    weeks = ", ".join(f"{w['week_start']} {w['overall']}" for w in c["weeks"])
    return (target, f"Planned weekly load was changed: {weeks}. Does the new shape hold together?")


PHASES = ("base", "build", "peak", "taper", "competition", "recovery", "transition")


def _v_add_block(p, db):
    macro = _macro(db, p.get("macro_id"))
    start = _date(p.get("date_from"), "Start date")
    end = _date(p.get("date_to"), "End date")
    if end < start:
        raise ActionError("The block ends before it starts")
    if start < macro.date_from or end > macro.date_to:
        raise ActionError(f"The block must sit inside {macro.name} ({_fmt(macro.date_from)} to {_fmt(macro.date_to)})")
    phase = str(p.get("phase_type") or "").lower()
    if phase not in PHASES:
        raise ActionError(f"Phase must be one of {', '.join(PHASES)}")
    clash = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.macro_id == macro.id,
        models.SeasonBlock.date_from <= end, models.SeasonBlock.date_to >= start,
    ).first()
    if clash:
        raise ActionError(f"It overlaps {clash.name} ({_fmt(clash.date_from)} to {_fmt(clash.date_to)})")
    return {"macro_id": macro.id, "name": _text(p.get("name"), "Block name", limit=120), "phase_type": phase,
            "date_from": start.isoformat(), "date_to": end.isoformat(),
            "notes": _text(p.get("notes"), "Notes", required=False, limit=500)}


def _d_add_block(c, db):
    macro = _macro(db, c["macro_id"])
    return [f"{c['name']} ({c['phase_type']}) in {macro.name}: "
            f"{_fmt(date.fromisoformat(c['date_from']))} to {_fmt(date.fromisoformat(c['date_to']))}",
            c["notes"] or ""]


def _a_add_block(c, db):
    from backend.routers.season import BlockIn, create_block
    create_block(BlockIn(macro_id=c["macro_id"], name=c["name"], phase_type=c["phase_type"],
                         date_from=date.fromisoformat(c["date_from"]),
                         date_to=date.fromisoformat(c["date_to"]), notes=c["notes"]), db)
    return f"Added {c['name']} to the plan."


def _h_add_block(c, proposer, db):
    return ("physiologist", f"A {c['phase_type']} block '{c['name']}' was added from {c['date_from']} "
                            f"to {c['date_to']}. Is that loading sensible for this squad?")


# ---------------------------------------------------------------------------
# Pathways: who is aiming at what
# ---------------------------------------------------------------------------

QUAL = ("qualified", "close", "not_qualified", "unknown")


def _v_move_pathway(p, db):
    swimmer = _swimmer(db, p.get("swimmer_id"))
    pathway = _pathway(db, p.get("to_pathway_id"))
    if not pathway.active:
        raise ActionError(f"The {pathway.name} pathway is not active")
    already = db.query(models.PathwayMembership).filter(
        models.PathwayMembership.pathway_id == pathway.id,
        models.PathwayMembership.swimmer_id == swimmer.id,
        models.PathwayMembership.active.is_(True),
    ).first()
    if already:
        raise ActionError(f"{swimmer.name} is already on {pathway.name}")
    status = str(p.get("qualification_status") or "unknown").lower()
    return {"swimmer_id": swimmer.id, "to_pathway_id": pathway.id,
            "qualification_status": status if status in QUAL else "unknown",
            "reason": _text(p.get("reason"), "Reason", limit=300)}


def _d_move_pathway(c, db):
    pathway = _pathway(db, c["to_pathway_id"])
    current = db.query(models.PathwayMembership).join(models.PlanningPathway).filter(
        models.PathwayMembership.swimmer_id == c["swimmer_id"],
        models.PathwayMembership.active.is_(True),
        models.PlanningPathway.macro_id == pathway.macro_id,
    ).first()
    frm = f" from {current.pathway.name}" if current else ""
    target = f" (aiming at {pathway.primary_meet.name})" if pathway.primary_meet else ""
    return [f"Move {_name(db, c['swimmer_id'])}{frm} to {pathway.name}{target}", c["reason"]]


def _a_move_pathway(c, db):
    from backend.services.planning_engine import refresh_macro
    pathway = _pathway(db, c["to_pathway_id"])
    # One route per swimmer per macrocycle: moving them closes the old one.
    for member in db.query(models.PathwayMembership).join(models.PlanningPathway).filter(
        models.PathwayMembership.swimmer_id == c["swimmer_id"],
        models.PathwayMembership.active.is_(True),
        models.PlanningPathway.macro_id == pathway.macro_id,
    ).all():
        member.active = False
        member.date_to = date.today()
    db.add(models.PathwayMembership(
        pathway_id=pathway.id, swimmer_id=c["swimmer_id"], date_from=date.today(),
        qualification_status=c["qualification_status"], notes=c["reason"], active=True,
    ))
    db.commit()
    try:
        refresh_macro(pathway.macro_id, db)
    except Exception:
        pass
    return f"{_name(db, c['swimmer_id'])} is now on {pathway.name}."


def _h_move_pathway(c, proposer, db):
    pathway = _pathway(db, c["to_pathway_id"])
    target = pathway.primary_meet.name if pathway.primary_meet else "no set target"
    return ("meets", f"{_name(db, c['swimmer_id'])} moved to the {pathway.name} pathway, aiming at {target}. "
                     "Do their meet entries still fit?")


def _v_qualification(p, db):
    swimmer = _swimmer(db, p.get("swimmer_id"))
    pathway = _pathway(db, p.get("pathway_id"))
    member = db.query(models.PathwayMembership).filter(
        models.PathwayMembership.pathway_id == pathway.id,
        models.PathwayMembership.swimmer_id == swimmer.id,
        models.PathwayMembership.active.is_(True),
    ).first()
    if not member:
        raise ActionError(f"{swimmer.name} is not on {pathway.name}")
    status = str(p.get("status") or "").lower()
    if status not in QUAL:
        raise ActionError(f"Status must be one of {', '.join(QUAL)}")
    if (member.qualification_status or "unknown") == status:
        raise ActionError(f"{swimmer.name} is already {status}")
    return {"swimmer_id": swimmer.id, "pathway_id": pathway.id, "status": status,
            "was": member.qualification_status or "unknown",
            "reason": _text(p.get("reason"), "Reason", limit=300)}


def _d_qualification(c, db):
    return [f"{_name(db, c['swimmer_id'])} on {_pathway(db, c['pathway_id']).name}: "
            f"{c['was'].replace('_', ' ')} → {c['status'].replace('_', ' ')}", c["reason"]]


def _a_qualification(c, db):
    member = db.query(models.PathwayMembership).filter(
        models.PathwayMembership.pathway_id == c["pathway_id"],
        models.PathwayMembership.swimmer_id == c["swimmer_id"],
        models.PathwayMembership.active.is_(True),
    ).first()
    if not member:
        raise ActionError("That swimmer is no longer on the pathway")
    member.qualification_status = c["status"]
    db.commit()
    return f"{_name(db, c['swimmer_id'])} marked {c['status'].replace('_', ' ')}."


def _h_qualification(c, proposer, db):
    if c["status"] != "not_qualified":
        return None
    return ("planner", f"{_name(db, c['swimmer_id'])} is now not qualified for their pathway target. "
                       "Should they branch to the fallback route?")


# ---------------------------------------------------------------------------
# Performance Analyst: targets
# ---------------------------------------------------------------------------

def _v_time_target(p, db):
    swimmer = _swimmer(db, p.get("swimmer_id"))
    seconds = _seconds(p.get("target_time"))
    if seconds is None:
        raise ActionError("The target time is not readable")
    distance = p.get("distance")
    return {"swimmer_id": swimmer.id, "label": _text(p.get("label"), "Label", limit=120),
            "distance": _int(distance, "Distance") if distance not in (None, "") else None,
            "stroke": _text(p.get("stroke"), "Stroke", required=False, limit=30),
            "effort": _text(p.get("effort"), "Effort", required=False, limit=30),
            "target_time": str(p.get("target_time")), "target_time_seconds": seconds,
            "deadline": (_date(p.get("deadline"), "Deadline", required=False) or None) and str(p.get("deadline"))[:10],
            "description": _text(p.get("reason"), "Reason", required=False, limit=400)}


def _d_time_target(c, db):
    by = f" by {_fmt(date.fromisoformat(c['deadline']))}" if c["deadline"] else ""
    return [f"{_name(db, c['swimmer_id'])}: {c['label']} - {c['target_time']}{by}", c["description"] or ""]


def _a_time_target(c, db):
    from backend.routers.benchmarks import TargetIn, create_target
    create_target(TargetIn(
        swimmer_id=c["swimmer_id"], label=c["label"], description=c["description"],
        distance=c["distance"], stroke=c["stroke"], effort=c["effort"],
        target_time_seconds=c["target_time_seconds"],
        deadline=date.fromisoformat(c["deadline"]) if c["deadline"] else None,
    ), db)
    return f"Target set for {_name(db, c['swimmer_id'])}."


def _v_meet_target_times(p, db):
    meet = _meet(db, p.get("meet_id"))
    swimmer = _swimmer(db, p.get("swimmer_id"))
    times = {}
    for event, value in (p.get("target_times") or {}).items():
        if _seconds(value) is None:
            raise ActionError(f"'{value}' for {event} is not a readable time")
        times[str(event)[:80]] = str(value)[:20]
    if not times:
        raise ActionError("No target times given")
    return {"meet_id": meet.id, "swimmer_id": swimmer.id, "target_times": times}


def _d_meet_target_times(c, db):
    return [f"{_name(db, c['swimmer_id'])} at {_meet(db, c['meet_id']).name}:"] + [
        f"{event} - {value}" for event, value in c["target_times"].items()]


def _a_meet_target_times(c, db):
    from backend.routers.meets import MeetTargetCreate, add_target
    existing = db.query(models.MeetTarget).filter(
        models.MeetTarget.meet_id == c["meet_id"], models.MeetTarget.swimmer_id == c["swimmer_id"],
    ).first()
    times = {**((existing.target_times or {}) if existing else {}), **c["target_times"]}
    events = list(dict.fromkeys([*((existing.events or []) if existing else []), *c["target_times"].keys()]))
    add_target(c["meet_id"], MeetTargetCreate(swimmer_id=c["swimmer_id"], events=events, target_times=times), db)
    return f"Target times set for {_name(db, c['swimmer_id'])}."


def _no_handoff(c, proposer, db):
    return None


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------

ACTIONS = {spec.type: spec for spec in [
    ActionSpec("create_meet", ("meets",), "Add this meet",
               '{"type": "create_meet", "name": "...", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD or null", '
               '"location": "...", "course": "SCM|LCM", "level": "club|county|regional|national|international"}',
               _v_create_meet, _d_create_meet, _a_create_meet, _h_create_meet),
    ActionSpec("add_entries", ("meets",), "Enter these swims",
               '{"type": "add_entries", "meet_id": 3, "entries": [{"swimmer_id": 12, "event": "100 Freestyle", "priority": "A|B|C"}]}',
               _v_add_entries, _d_add_entries, _a_add_entries, _h_add_entries),
    ActionSpec("record_results", ("meets",), "Record these results",
               '{"type": "record_results", "meet_id": 3, "results": [{"swimmer_id": 12, "event": "100 Freestyle", "time": "1:02.45", "round": "Heat|Final|null"}]}',
               _v_record_results, _d_record_results, _a_record_results, _h_record_results),
    ActionSpec("log_load_event", ("physiologist", "manager"), "Log this",
               '{"type": "log_load_event", "swimmer_id": 12, "event_type": "illness|injury|travel|camp|extra_load|other", '
               '"date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD or null", "severity": 1-3, "description": "...", "resolved": false}',
               _v_log_load_event, _d_log_load_event, _a_log_load_event, _h_log_load_event),
    ActionSpec("adjust_week_load", ("physiologist", "planner"), "Change the load",
               '{"type": "adjust_week_load", "macro_id": 5, "pathway_id": null, "weeks": [{"week_start": "YYYY-MM-DD", "overall": 0-100, "note": "..."}]}',
               _v_adjust_week_load, _d_adjust_week_load, _a_adjust_week_load, _h_adjust_week_load),
    ActionSpec("add_block", ("planner",), "Add this block",
               '{"type": "add_block", "macro_id": 5, "name": "...", "phase_type": "base|build|peak|taper|competition|recovery|transition", '
               '"date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD", "notes": "..."}',
               _v_add_block, _d_add_block, _a_add_block, _h_add_block),
    ActionSpec("move_pathway", ("planner", "manager"), "Move them",
               '{"type": "move_pathway", "swimmer_id": 12, "to_pathway_id": 4, "qualification_status": "qualified|close|not_qualified|unknown", "reason": "..."}',
               _v_move_pathway, _d_move_pathway, _a_move_pathway, _h_move_pathway),
    ActionSpec("set_qualification", ("analyst",), "Update qualification",
               '{"type": "set_qualification", "swimmer_id": 12, "pathway_id": 4, "status": "qualified|close|not_qualified|unknown", "reason": "..."}',
               _v_qualification, _d_qualification, _a_qualification, _h_qualification),
    ActionSpec("set_time_target", ("analyst",), "Set this target",
               '{"type": "set_time_target", "swimmer_id": 12, "label": "...", "distance": 100, "stroke": "free", '
               '"target_time": "1:01.50", "deadline": "YYYY-MM-DD or null", "reason": "..."}',
               _v_time_target, _d_time_target, _a_time_target, _no_handoff),
    ActionSpec("set_meet_target_times", ("analyst",), "Set these target times",
               '{"type": "set_meet_target_times", "meet_id": 3, "swimmer_id": 12, "target_times": {"100 Freestyle": "1:01.50"}}',
               _v_meet_target_times, _d_meet_target_times, _a_meet_target_times, _no_handoff),
    ActionSpec("set_status", ("manager",), "Change status",
               '{"type": "set_status", "swimmer_id": 12, "status": "active|injury|sabbatical", "reason": "..."}',
               _v_set_status, _d_set_status, _a_set_status, _h_set_status),
    ActionSpec("add_availability", ("manager",), "Add to availability",
               '{"type": "add_availability", "swimmer_id": 12, "reason": "holiday|exams|work|injury|other", '
               '"date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD", "notes": "..."}',
               _v_add_availability, _d_add_availability, _a_add_availability, _h_add_availability),
    ActionSpec("add_coaching_note", ("manager",), "Add this note",
               '{"type": "add_coaching_note", "title": "...", "body": "...", "swimmer_ids": [12], '
               '"date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD"}',
               _v_coaching_note, _d_coaching_note, _a_coaching_note, _no_handoff),
]}


def actions_for(role: str) -> list:
    return [spec for spec in ACTIONS.values() if role in spec.roles]


def prompt_block(role: str) -> str:
    """The actions a specialist may propose, as they are told about them."""
    specs = actions_for(role)
    if not specs:
        return ""
    lines = [
        "ACTIONS YOU CAN PROPOSE (the coach approves before anything changes):",
        *[f"- {spec.type}: {spec.schema}" for spec in specs],
        "Propose one only when the coach asked for it, or when it clearly follows from what you",
        "are saying. Use only ids that appear in your data. Otherwise set proposed_action to null.",
        "If you say you will do something, put it in proposed_action - the coach can only",
        "approve what you actually propose. Do the thing that was asked; do not substitute a",
        "different preparatory step for it.",
        "When the coach tells you something to record - a result, a date, an illness - propose",
        "recording it straight away. Never ask them to repeat what they already said; ask only",
        "about what is genuinely missing, and still propose what you can.",
    ]
    example = EXAMPLES.get(role)
    if example:
        lines += ["", "EXAMPLE", example]
    return "\n".join(lines)


# One worked example per role. The fast model follows an example far more
# reliably than a rule about when to act.
EXAMPLES = {
    "meets": (
        'Coach: "Ruby 1:02.45 in the 100 free heat and 31.20 in the 50 fly" (meet in focus id 8, Ruby is id 12)\n'
        '-> {"speak": true, "kind": "observation", "message": "Two results for Ruby at this meet.", '
        '"question_for_coach": null, "swimmer_ids": [12], "week_start": null, "ask_colleague": null, '
        '"proposed_action": {"type": "record_results", "meet_id": 8, "results": ['
        '{"swimmer_id": 12, "event": "100 Freestyle", "time": "1:02.45", "round": "Heat"}, '
        '{"swimmer_id": 12, "event": "50 Butterfly", "time": "31.20", "round": null}]}}'
    ),
    "manager": (
        'Coach: "Leo is off with glandular fever from Monday 5 Oct" (Leo is id 7)\n'
        '-> {"speak": true, "kind": "concern", "message": "Logging Leo\'s glandular fever - that is usually weeks, not days.", '
        '"question_for_coach": "Has a doctor given a return date?", "swimmer_ids": [7], "week_start": null, '
        '"ask_colleague": {"role": "physiologist", "question": "How should Leo\'s return be graded?"}, '
        '"proposed_action": {"type": "log_load_event", "swimmer_id": 7, "event_type": "illness", '
        '"date_from": "2026-10-05", "date_to": null, "severity": 3, "description": "Glandular fever", "resolved": false}}'
    ),
    "planner": (
        'Coach: "Drop week 3 of the build to 60, they are cooked"\n'
        '-> propose adjust_week_load for that week with overall 60 and a note, and say what it does to the shape.'
    ),
    "physiologist": (
        'Coach: "Maya has a stress reaction in her foot, 4 weeks no kicking"\n'
        '-> propose log_load_event (injury, severity 2, not resolved) and say what load she can still take.'
    ),
    "analyst": (
        'Coach: "Aim Sam at 58.9 for the 100 free by Regionals"\n'
        '-> propose set_time_target with that time and the Regionals date as deadline, and say whether '
        'the evidence supports it.'
    ),
}


def prepare(role: str, raw, db: DBSession) -> Optional[dict]:
    """Validate a proposed action for storage. Returns None if it cannot stand.

    The stored form keeps the cleaned payload plus the button label and a plain
    summary, so the page can show exactly what will happen before it happens.
    """
    if not isinstance(raw, dict):
        return None
    spec = ACTIONS.get(str(raw.get("type") or ""))
    if not spec or role not in spec.roles:
        return None
    try:
        clean = spec.validate(raw, db)
        lines = [line for line in spec.describe(clean, db) if line]
    except ActionError as exc:
        return {"type": spec.type, "invalid": str(exc)}
    except Exception:
        return None
    return {"type": spec.type, "label": spec.label, "summary": lines, "payload": clean}


def execute(action: dict, proposer: str, db: DBSession) -> tuple:
    """Carry out an approved action. Returns (result sentence, handoff or None).

    The payload is validated again first: the world may have moved on between
    the proposal and the approval - the meet added by hand, the swimmer moved.
    """
    spec = ACTIONS.get(action.get("type"))
    if not spec:
        raise ActionError("Unknown action")
    clean = spec.validate(action.get("payload") or {}, db)
    result = spec.apply(clean, db)
    handoff = None
    try:
        handoff = spec.handoff(clean, proposer, db)
    except Exception:
        handoff = None
    return result, handoff
