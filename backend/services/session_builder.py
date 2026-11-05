"""The Session Builder inside the app: sessions written in the shared notation.

A session written in the builder is stored as it was written (Session.builder:
blocks, groups, sets). Everything the rest of the app reads is worked out from
it in code on every save, so nothing has to be typed twice:

- one SessionGroup per builder group, holding the group's swimmers, its sets
  as text and its metres in each training zone (what the register and the
  load counter read)
- planned_content, the plain-text session the staff and older screens read
- the register's group count

New sessions start from the season plan: the training groups on that date,
already holding their swimmers. The coach can rename or re-split them per
session (IM / No.1 stroke); a swimmer who swims another group's set on the day
is moved in the register.
"""

from __future__ import annotations

import copy
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import groups as group_service
from backend.services import session_notation as N

DEFAULT_BLOCKS = ("Warm up", "Main set", "Swim down")


# ---------------------------------------------------------------- settings

def presentation(db: DBSession) -> Optional[models.SessionPresentationSettings]:
    try:
        return db.query(models.SessionPresentationSettings).first()
    except Exception:  # noqa: BLE001 - a missing table must not stop the builder
        return None


def usual_scale(db: DBSession) -> str:
    s = presentation(db)
    key = (s.effort_scale if s else None) or N.DEFAULT_SYS
    return key if key in N.EFF_SYSTEMS else N.DEFAULT_SYS


def set_usual_scale(db: DBSession, key: str) -> str:
    if key not in N.EFF_SYSTEMS:
        raise ValueError("Unknown intensity scale")
    s = presentation(db)
    if not s:
        s = models.SessionPresentationSettings(id=1)
        db.add(s)
    s.effort_scale = key
    db.commit()
    return key


# ---------------------------------------------------------------- building blocks

def slot_of(start_time: Optional[str]) -> str:
    mins = N.clock_mins(start_time)
    return "PM" if mins is not None and mins >= 12 * 60 else "AM"


def week_key(session: models.Session) -> str:
    """The plan's week code (macro.meso.micro) from the session's cycle code."""
    code = session.cycle_code or ""
    parts = code.split(".")
    return ".".join(parts[:3]) if len(parts) >= 3 else code


def plan_groups(db: DBSession, on: date, squad: Optional[str]) -> list:
    """The season plan's training groups on a date, ready to be session groups."""
    out = []
    for name, g in group_service.groups_on(db, on, squad).items():
        out.append({"id": f"tg{g['group_id']}", "name": name, "training_group_id": g["group_id"],
                    "swimmer_ids": list(g["swimmer_ids"])})
    return out


def blank_builder(db: DBSession, session: models.Session) -> dict:
    groups = plan_groups(db, session.date, session.squad)
    return {
        "title": "",
        "date": session.date.isoformat(),
        "slot": slot_of(session.start_time),
        "effSys": usual_scale(db),
        "start": session.start_time or "",
        "end": session.end_time or "",
        "venue": "",
        "coach": "",
        "weekKey": week_key(session),
        "aims": ["", ""],
        "groups": groups,
        "blocks": [N.new_block(name) for name in DEFAULT_BLOCKS],
    }


def _legacy_sets_text(sets) -> str:
    if isinstance(sets, dict):
        sets = sets.get("raw", sets.get("text", ""))
    if isinstance(sets, list):
        return "\n".join(str(x) for x in sets if str(x or "").strip())
    return str(sets or "")


def legacy_to_builder(db: DBSession, session: models.Session) -> dict:
    """An older app session (free-text sets per numbered group) in builder form."""
    b = blank_builder(db, session)
    b["title"] = session.title or ""
    b["groups"] = []
    b["blocks"] = []
    rows = sorted(session.groups or [], key=lambda g: g.group_number)
    many = len(rows) > 1
    for g in rows:
        gid = f"g{g.group_number}"
        if many:
            b["groups"].append({"id": gid, "name": (g.description or "").strip() or f"Group {g.group_number}",
                                "swimmer_ids": list(g.target_swimmer_ids or [])})
        block = N.new_block("Main set" if not many else f"Group {g.group_number}", [gid] if many else [])
        block["items"] = N.parse_text(_legacy_sets_text(g.sets))
        b["blocks"].append(block)
    if not b["blocks"]:
        b["blocks"] = [N.new_block(name) for name in DEFAULT_BLOCKS]
    if session.coach_intent:
        b["aims"] = [session.coach_intent, ""]
    return b


def builder_for(db: DBSession, session: models.Session) -> dict:
    b = copy.deepcopy(session.builder) if session.builder else (
        legacy_to_builder(db, session) if session.groups else blank_builder(db, session))
    N.normalize_session(b)
    b.setdefault("aims", ["", ""])
    b.setdefault("effSys", usual_scale(db))
    if not b.get("weekKey"):
        b["weekKey"] = week_key(session)
    return b


# ---------------------------------------------------------------- saving

def zone_volume(zones: dict) -> dict:
    """Metres per training zone, in the keys the load counter reads."""
    return {k: N.js_round(v["dist"]) for k, v in zones.items() if v["dist"]}


def apply_builder(db: DBSession, session: models.Session, builder: dict) -> dict:
    """Store a builder session and work out everything the app reads from it."""
    b = N.normalize_session(copy.deepcopy(builder))
    session.builder = b
    if b.get("date"):
        try:
            session.date = date.fromisoformat(b["date"])
        except ValueError:
            pass
    session.title = (b.get("title") or "").strip() or None
    session.start_time = b.get("start") or session.start_time
    session.end_time = b.get("end") or session.end_time
    aims = [a.strip() for a in (b.get("aims") or []) if a and a.strip()]
    session.coach_intent = "; ".join(aims) or session.coach_intent
    sys = b.get("effSys") or N.DEFAULT_SYS

    for g in list(session.groups or []):
        db.delete(g)
    db.flush()

    zones = {z["gid"]: z["zones"] for z in N.session_zones(b)}
    totals = {t["gid"]: t for t in N.totals_for(b, sys)}
    planned = {}
    summary = []
    for i, g in enumerate(N.session_groups(b), start=1):
        gid = g.get("id")
        text = N.session_text(N.session_for_group(b, gid), sys) if gid is not None else N.session_text(b, sys)
        volume = zone_volume(zones[gid])
        db.add(models.SessionGroup(
            session_id=session.id, group_number=i, description=g.get("name") or "",
            sets={"builder": True, "text": text}, target_swimmer_ids=list(g.get("swimmer_ids") or []),
            volume_breakdown=volume or None,
        ))
        planned[str(i)] = {"description": g.get("name") or "", "sets": text}
        t = totals[gid]
        summary.append({"group": g.get("name") or "", "number": i, "dist": t["dist"], "time": t["time"], "time2": t["time2"],
                        "zones": volume})
    session.planned_content = planned
    session.register_group_count = len(summary)
    db.commit()
    db.refresh(session)
    return {"groups": summary}


def payload(db: DBSession, session: models.Session) -> dict:
    s = presentation(db)
    slot = session.pool_slot
    micro = session.microcycle
    return {
        "id": session.id,
        "session": builder_for(db, session),
        "squad": session.squad,
        "status": session.status,
        "cycle_code": session.cycle_code,
        "week_label": micro.label if micro else None,
        "pool_slot": {"id": slot.id, "label": slot.label, "time": slot.time} if slot else None,
        "audience": session.audience,
        "register_taken": any(e.attended is not None for e in session.entries or []),
        "club": {"name": s.club_name if s else None, "logo": s.logo_data_url if s else None},
        "effort_scale": usual_scale(db),
        "scales": [{"key": k, "name": N.EFF_SYSTEMS[k]["name"]} for k in N.EFF_ORDER],
        "staff_notes": _staff_notes(db),
    }


def _staff_notes(db: DBSession) -> list:
    """What the staff wrote down lately, shown at the top of the builder."""
    try:
        from backend.services import workbook_writer
        return workbook_writer.recent_notes(db)
    except Exception:  # noqa: BLE001 - notes are a bonus; the builder must open regardless
        return []


def copy_to_next_week(db: DBSession, session: models.Session) -> models.Session:
    """The same session a week later: new ids, the plan's groups for that date."""
    b = builder_for(db, session)
    nxt = session.date + timedelta(days=7)
    new = models.Session(date=nxt, start_time=session.start_time, end_time=session.end_time, squad=session.squad,
                         pool_slot_id=session.pool_slot_id, course=session.course, status="active", source="builder",
                         audience=copy.deepcopy(session.audience))
    db.add(new)
    db.flush()
    from backend.services.cycle_codes import link_session
    link_session(new, db)
    b["blocks"] = [N.clone_with_new_ids(x) for x in b["blocks"]]
    b["date"] = nxt.isoformat()
    b["weekKey"] = week_key(new)
    if b.get("title"):
        b["title"] = b["title"] + " (copy)"
    # keep the session's groups, but take this week's swimmers from the plan
    plan = {g["training_group_id"]: g["swimmer_ids"] for g in plan_groups(db, nxt, new.squad)}
    for g in b.get("groups") or []:
        if g.get("training_group_id") in plan:
            g["swimmer_ids"] = plan[g["training_group_id"]]
    apply_builder(db, new, b)
    return new
