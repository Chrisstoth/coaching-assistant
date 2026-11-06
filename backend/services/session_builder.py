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
import re
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


def _settings_row(db: DBSession) -> models.SessionPresentationSettings:
    s = presentation(db)
    if not s:
        s = models.SessionPresentationSettings(id=1)
        db.add(s)
    return s


def load_scales(db: DBSession) -> dict:
    """The club's own intensity scales and the standard ones it has hidden.

    Loaded into the notation before anything is shown, so a session written in
    a club scale reads the same in the builder, the PDF and the staff's notes."""
    s = presentation(db)
    custom = list((s.custom_scales if s else None) or [])
    hidden = list((s.hidden_scales if s else None) or [])
    N.use_scales(custom)
    return {"custom": custom, "hidden": hidden}


def scale_choices(db: DBSession, include: Optional[str] = None) -> list:
    """The scales the coach can pick: the standard ones they haven't hidden, then their own."""
    sc = load_scales(db)
    out = [{"key": k, "name": N.EFF_SYSTEMS[k]["name"], "kind": "standard"} for k in N.STANDARD if k not in sc["hidden"]]
    out += [{"key": c["key"], "name": c["name"], "kind": "custom"} for c in sc["custom"]]
    if include and include not in {o["key"] for o in out} and N.system(include):
        out.append({"key": include, "name": N.system(include)["name"], "kind": "custom" if include in N.CUSTOM else "standard"})
    return out


def usual_scale(db: DBSession) -> str:
    s = presentation(db)
    key = (s.effort_scale if s else None) or N.DEFAULT_SYS
    return key if key in {c["key"] for c in scale_choices(db)} else N.DEFAULT_SYS


def set_usual_scale(db: DBSession, key: str) -> str:
    if key not in {c["key"] for c in scale_choices(db)}:
        raise ValueError("Unknown intensity scale")
    _settings_row(db).effort_scale = key
    db.commit()
    return key


_LABEL = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,13}$")
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
_KEY = re.compile(r"^[a-z0-9_-]{2,40}$")


def _num(v, what: str) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} needs a number on the Effort /20 line")
    return int(x) if x == int(x) else round(x, 2)


def clean_scale(raw: dict) -> dict:
    """Check a club scale and put it in the notation's shape.

    Each level has a name (one word, so it can be typed in a set), where it
    starts and where it sits on the common Effort /20 line. A level runs up to
    where the next one starts; the first starts at 0, the last runs to the top."""
    key = str(raw.get("key") or "").strip()
    if not _KEY.match(key):
        raise ValueError("The scale needs a short id (letters, numbers, - or _)")
    if key in N.STANDARD:
        raise ValueError("A standard scale can't be changed. Save your copy as a new scale.")
    name = str(raw.get("name") or "").strip()[:40]
    if not name:
        raise ValueError("Give the scale a name")
    levels = list(raw.get("zones") or [])
    if not 2 <= len(levels) <= 12:
        raise ValueError("A scale needs between 2 and 12 levels")
    zones, seen = [], set()
    for i, z in enumerate(levels):
        label = str(z.get("label") or "").strip()
        n = i + 1
        if not _LABEL.match(label):
            raise ValueError(f"Level {n}: the name must be one word of letters and numbers, starting with a letter (e.g. Red, A3)")
        if label.lower() in seen:
            raise ValueError(f"Two levels are called {label}")
        seen.add(label.lower())
        lo = 0 if i == 0 else _num(z.get("lo"), f"Level {n} ({label}) start")
        c = _num(z.get("c"), f"Level {n} ({label})")
        out = {"label": label, "lo": lo, "hi": 99, "c": c}
        color = str(z.get("color") or "").strip()
        if color:
            if not _HEX.match(color):
                raise ValueError(f"Level {n} ({label}): the colour should look like #D62839")
            out["color"] = color.upper()
        note = str(z.get("note") or "").strip()[:60]
        if note:
            out["note"] = note
        alias = [a.strip().lower() for a in (z.get("alias") or []) if _LABEL.match(str(a).strip())]
        if alias:
            out["alias"] = alias
        zones.append(out)
    for i in range(len(zones) - 1):
        zones[i]["hi"] = zones[i + 1]["lo"]
    for i, z in enumerate(zones):
        if z["hi"] <= z["lo"]:
            raise ValueError(f"{z['label']} must start above {zones[i - 1]['label']}")
        if not z["lo"] <= z["c"] < z["hi"] or z["c"] > 25:
            raise ValueError(f"{z['label']} sits at {z['c']}, outside its own range ({z['lo']} to {z['hi'] if z['hi'] < 99 else 'top'})")
    coloured = [z for z in zones if z.get("color")]
    if coloured and len(coloured) != len(zones):
        raise ValueError("Give every level a colour, or none")
    mid = zones[len(zones) // 2]["label"]
    out = {"key": key, "name": name, "short": (str(raw.get("short") or "").strip() or name)[:14],
           "hint": f"{mid}…", "zones": zones}
    if coloured:
        out["colored"] = True
    if raw.get("based_on") and N.system(raw["based_on"]):
        out["based_on"] = raw["based_on"]
    return out


def save_scales(db: DBSession, custom: Optional[list] = None, hidden: Optional[list] = None) -> dict:
    s = _settings_row(db)
    if custom is not None:
        cleaned = [clean_scale(c) for c in custom]
        keys = [c["key"] for c in cleaned]
        if len(set(keys)) != len(keys):
            raise ValueError("Two scales share an id")
        s.custom_scales = cleaned
    if hidden is not None:
        s.hidden_scales = [k for k in hidden if k in N.STANDARD and k != N.DEFAULT_SYS]
    db.commit()
    if s.effort_scale and s.effort_scale not in {c["key"] for c in scale_choices(db)}:
        s.effort_scale = N.DEFAULT_SYS      # their usual scale was deleted or hidden
        db.commit()
    return load_scales(db)


# ---------------------------------------------------------------- building blocks

def slot_of(start_time: Optional[str]) -> str:
    mins = N.clock_mins(start_time)
    return "PM" if mins is not None and mins >= 12 * 60 else "AM"


def week_key(session: models.Session, db: Optional[DBSession] = None) -> str:
    """The plan's week code (macro.meso.micro): from the session's cycle code, or the coach's Season Planner."""
    code = session.cycle_code or ""
    parts = code.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:3])
    if db is not None and session.date:
        try:
            from backend.services import season_planner
            planned = season_planner.week_code(db, session.squad, session.date)
            if planned and planned != "Off":
                return planned
        except Exception:  # noqa: BLE001 - a week code is a convenience
            pass
    return code


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
        "weekKey": week_key(session, db),
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
        b["weekKey"] = week_key(session, db)
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
    built = builder_for(db, session)
    scales = load_scales(db)
    return {
        "id": session.id,
        "session": built,
        "squad": session.squad,
        "status": session.status,
        "cycle_code": session.cycle_code,
        "week_label": micro.label if micro else None,
        "pool_slot": {"id": slot.id, "label": slot.label, "time": slot.time} if slot else None,
        "audience": session.audience,
        "register_taken": any(e.attended is not None for e in session.entries or []),
        "club": {"name": s.club_name if s else None, "logo": s.logo_data_url if s else None},
        "effort_scale": usual_scale(db),
        "scales": scale_choices(db, include=built.get("effSys")),
        "custom_scales": scales["custom"],
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
    b["weekKey"] = week_key(new, db)
    if b.get("title"):
        b["title"] = b["title"] + " (copy)"
    # keep the session's groups, but take this week's swimmers from the plan
    plan = {g["training_group_id"]: g["swimmer_ids"] for g in plan_groups(db, nxt, new.squad)}
    for g in b.get("groups") or []:
        if g.get("training_group_id") in plan:
            g["swimmer_ids"] = plan[g["training_group_id"]]
    apply_builder(db, new, b)
    return new
