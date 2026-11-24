"""A swimmer's goals: one list, wherever it is seen or edited.

The goals are rows in swimmer_targets. They are edited on the swimmer's page
(Squad), in the Season Planner, and set from chat; they print on the planner's
plan sheet and on the athlete plan.

The Season Planner keeps its own copy on each swimmer in its roster document
(sw.goals = [{id, text, event, target, course, meet, done}]) so it can draw the
stars and print the sheet. This module keeps the copy and the rows in step:

- the planner saves its roster: what changed there is written to the rows
  (sync_from_roster);
- a goal is changed anywhere else: the planner's copy is rewritten
  (write_to_rosters), which also tells an open planner to reload;
- the planner opens: its copy is refreshed from the rows, and any goal only the
  planner had (from before the two were joined) becomes a row (fill_roster).
"""

from __future__ import annotations

import copy
from datetime import date
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session as DBSession

from backend import models

CLUB = "default"
SHORT = {"Freestyle": "Free", "Backstroke": "Back", "Breaststroke": "Breast", "Butterfly": "Fly", "Individual Medley": "IM"}
LONG = {v: k for k, v in SHORT.items()}
EVENTS = [f"{d} {s}" for s, ds in (("Free", (50, 100, 200, 400, 800, 1500)), ("Back", (50, 100, 200)),
                                    ("Breast", (50, 100, 200)), ("Fly", (50, 100, 200)), ("IM", (100, 200, 400)))
          for d in ds]


def fmt_time(seconds: Optional[float]) -> str:
    if seconds is None:
        return ""
    m, s = divmod(float(seconds), 60)
    return f"{int(m)}:{s:05.2f}" if m else f"{s:.2f}"


def short_event(event: Optional[str]) -> str:
    """"100 Freestyle SCM" or "100 Free" -> "100 Free"."""
    d, _, rest = str(event or "").strip().partition(" ")
    stroke = rest.replace(" SCM", "").replace(" LCM", "").strip()
    return f"{d} {SHORT.get(stroke, stroke)}".strip() if d else ""


def course_of(row: models.SwimmerTarget) -> str:
    """The meet's course when the goal is for a meet that has one, else the goal's own."""
    if row.meet and row.meet.course in ("SCM", "LCM"):
        return "LC" if row.meet.course == "LCM" else "SC"
    return row.course or "SC"


def best_time(db: DBSession, swimmer_id: int, event: str, course: str) -> Optional[models.SwimTime]:
    d, _, stroke = short_event(event).partition(" ")
    if not d or not stroke:
        return None
    code = "LCM" if course == "LC" else "SCM"
    return db.query(models.SwimTime).filter(
        models.SwimTime.swimmer_id == swimmer_id,
        models.SwimTime.event.ilike(f"{d} {LONG.get(stroke, stroke)}%"),
        or_(models.SwimTime.course == code, models.SwimTime.event.ilike(f"% {code}")),
    ).order_by(models.SwimTime.time_seconds).first()


def label_of(row: models.SwimmerTarget) -> str:
    """The goal in words: what the coach wrote, else the race goal, as the planner shows it."""
    words = (row.label or "").strip()
    if words:
        return words
    if row.event:
        return f"{row.event}{' in ' + fmt_time(row.target_time_seconds) if row.target_time_seconds else ''} {course_of(row)}"
    return "Goal"


def when(row: models.SwimmerTarget) -> Optional[date]:
    """The goal's date: its meet's last day when it is for a meet, else its own deadline."""
    if row.meet and (row.meet.date_to or row.meet.date):
        return row.meet.date_to or row.meet.date
    return row.deadline


def goal_out(db: DBSession, row: models.SwimmerTarget) -> dict:
    course = course_of(row)
    best = best_time(db, row.swimmer_id, row.event, course) if row.event else None
    if row.achieved:
        status = "Achieved"
    elif not row.event or not row.target_time_seconds:
        status = ""
    elif not best:
        status = f"No {course} PB yet"
    elif best.time_seconds <= row.target_time_seconds:
        status = f"PB {fmt_time(best.time_seconds)} is already under this"
    else:
        gap = best.time_seconds - row.target_time_seconds
        status = f"PB {fmt_time(best.time_seconds)} · {gap:.2f}s ({gap / row.target_time_seconds * 100:.1f}%) to find"
    race = ""
    if row.event:
        race = f"{row.event}{' in ' + fmt_time(row.target_time_seconds) if row.target_time_seconds else ''} {course}"
    return {
        "id": row.id,
        "swimmer_id": row.swimmer_id,
        "text": row.label or "",
        "label": label_of(row),
        "race": race,
        "description": row.description,
        "event": row.event or "",
        "target_time_seconds": row.target_time_seconds,
        "target": fmt_time(row.target_time_seconds),
        "course": course,
        "course_from_meet": bool(row.meet and row.meet.course in ("SCM", "LCM")),
        "meet_id": row.meet_id,
        "meet_name": row.meet.name if row.meet else None,
        "meet_date": row.meet.date.isoformat() if row.meet and row.meet.date else None,
        "deadline": when(row).isoformat() if when(row) else None,
        "achieved": bool(row.achieved),
        "achieved_date": row.achieved_date.isoformat() if row.achieved_date else None,
        "best": fmt_time(best.time_seconds) if best else None,
        "status": status,
        # training benchmark targets, set from chat
        "distance": row.distance, "stroke": row.stroke, "effort": row.effort,
    }


def goals_of(db: DBSession, swimmer_id: int) -> list:
    return db.query(models.SwimmerTarget).filter(models.SwimmerTarget.swimmer_id == swimmer_id).order_by(
        models.SwimmerTarget.id).all()


def in_period(row: models.SwimmerTarget, start: Optional[date], end: Optional[date]) -> bool:
    """A goal for this period: one with no date that is still open, or one dated inside it."""
    on = when(row)
    if not on:
        return not row.achieved
    return (not start or on >= start) and (not end or on <= end)


FIELDS = ("label", "description", "event", "target_time_seconds", "course", "meet_id", "deadline", "achieved")


def apply(db: DBSession, row: models.SwimmerTarget, changes: dict) -> None:
    """Set a goal's fields. A meet sets the date; ticking achieved stamps the day."""
    was, old_meet = bool(row.achieved), row.meet_id
    for k, v in changes.items():
        if k in FIELDS or k in ("distance", "stroke", "effort", "achieved_date"):
            setattr(row, k, v)
    if row.label is None:
        row.label = ""
    if row.event:
        row.event = short_event(row.event)
    if row.course not in (None, "SC", "LC"):
        row.course = "LC" if str(row.course).upper().startswith("L") else "SC"
    if "meet_id" in changes:
        meet = db.get(models.Meet, row.meet_id) if row.meet_id else None
        row.meet = meet
        if meet:
            row.deadline = meet.date_to or meet.date
        elif old_meet and "deadline" not in changes:     # the meet was taken off: so is its date
            row.deadline = None
    if row.achieved and not was and not row.achieved_date:
        row.achieved_date = date.today()
    if not row.achieved:
        row.achieved_date = None


# ---------------------------------------------------------------------------
# The Season Planner's copy
# ---------------------------------------------------------------------------

def _app_ref(sid) -> Optional[int]:
    s = str(sid or "")
    return int(s[3:]) if s.startswith("app") and s[3:].isdigit() else None


def _matcher(db: DBSession):
    """Planner swimmer -> app swimmer, the way the planner's Squad tab is followed."""
    rows = db.query(models.Swimmer).all()
    by_id = {s.id: s for s in rows}
    by_sr = {s.swimrankings_id: s for s in rows if s.swimrankings_id}
    by_name = {s.name.strip().lower(): s for s in rows}

    def find(sw: dict) -> Optional[models.Swimmer]:
        return (by_id.get(_app_ref(sw.get("id"))) or by_sr.get(str(sw.get("id")))
                or by_name.get((sw.get("name") or "").strip().lower()))
    return find


def _calendar(db: DBSession, squad: str) -> dict:
    """Planner meet id -> app meet id, for this squad's plan. None for a meet added in
    the planner and not yet tied to the Meets tab (that happens when the planner next opens)."""
    doc = db.query(models.PlanDoc).filter_by(club=CLUB, squad=squad, key="plan").first()
    cal = ((doc.data or {}).get("calendar") or []) if doc else []
    return {c["id"]: c.get("meet") for c in cal if c.get("id")}


def _ref(db: DBSession, row: models.SwimmerTarget) -> str:
    if not row.plan_ref:
        if row.id is None:
            db.flush()
        row.plan_ref = f"t{row.id}"
    return row.plan_ref


def planner_goal(db: DBSession, row: models.SwimmerTarget, meet_to_cal: dict) -> dict:
    return {"id": _ref(db, row), "text": row.label or "", "event": row.event or "",
            "target": row.target_time_seconds, "course": row.course or "SC",
            "meet": meet_to_cal.get(row.meet_id, "") if row.meet_id else "", "done": bool(row.achieved)}


def _from_planner(g: dict, prev: Optional[dict], row: models.SwimmerTarget, cal: dict) -> dict:
    """The row's fields from a planner goal. A meet the planner can't show is kept."""
    target = g.get("target")
    changes = {"label": str(g.get("text") or ""), "event": str(g.get("event") or "") or None,
               "target_time_seconds": float(target) if isinstance(target, (int, float)) and target > 0 else None,
               "course": g.get("course") if g.get("course") in ("SC", "LC") else "SC",
               "achieved": bool(g.get("done"))}
    meet = g.get("meet") or ""
    if meet or (prev or {}).get("meet") or not row.meet_id:
        changes["meet_id"] = cal.get(meet) if meet else None
    return changes


def sync_from_roster(db: DBSession, squad: str, before: Optional[dict], after: Optional[dict]) -> int:
    """The planner saved its roster: write the goals it changed to the swimmers' rows."""
    if not after:
        return 0
    find = _matcher(db)
    cal = _calendar(db, squad)
    old = {}
    for sw in (before or {}).get("swimmers") or []:
        for g in sw.get("goals") or []:
            if g.get("id"):
                old[(str(sw.get("id")), g["id"])] = g
    still_here = {str(sw.get("id")) for sw in after.get("swimmers") or []}
    touched = set()
    changed = 0
    for sw in after.get("swimmers") or []:
        a = find(sw)
        if not a:
            continue
        sid = str(sw.get("id"))
        for g in sw.get("goals") or []:
            if not g.get("id"):
                continue
            prev = old.pop((sid, g["id"]), None)
            if prev == g:
                continue
            row = db.query(models.SwimmerTarget).filter_by(swimmer_id=a.id, plan_ref=g["id"]).first()
            if not row:
                row = models.SwimmerTarget(swimmer_id=a.id, plan_ref=g["id"], label="")
                db.add(row)
            apply(db, row, _from_planner(g, prev, row, cal))
            touched.add(a.id)
            changed += 1
    for (sid, ref), _g in old.items():          # removed in the planner (not the swimmer leaving)
        if sid not in still_here:
            continue
        sw = next(s for s in after["swimmers"] if str(s.get("id")) == sid)
        a = find(sw)
        if a:
            n = db.query(models.SwimmerTarget).filter_by(swimmer_id=a.id, plan_ref=ref).delete()
            if n:
                touched.add(a.id)
                changed += n
    db.commit()
    for swimmer_id in touched:                  # the same swimmer on another squad's plan
        write_to_rosters(db, db.get(models.Swimmer, swimmer_id), skip=squad)
    return changed


def _refresh(db: DBSession, data: dict, squad: str, find, only: Optional[int] = None) -> bool:
    """Rewrite the goals on the roster's swimmers from the rows. True if anything changed."""
    cal = _calendar(db, squad)
    meet_to_cal = {m: c for c, m in cal.items() if m}
    changed = False
    for sw in data.get("swimmers") or []:
        a = find(sw)
        if not a or (only is not None and a.id != only):
            continue
        had = {g.get("id"): g for g in sw.get("goals") or []}
        goals = []
        for r in goals_of(db, a.id):
            pg = planner_goal(db, r, meet_to_cal)
            mine = (had.get(pg["id"]) or {}).get("meet")
            if not r.meet_id and mine in cal and cal[mine] is None:
                pg["meet"] = mine        # a meet not tied to the Meets tab yet: keep the planner's choice
            goals.append(pg)
        if goals != (sw.get("goals") or []):
            sw["goals"] = goals
            changed = True
    return changed


def write_to_rosters(db: DBSession, swimmer: Optional[models.Swimmer], skip: Optional[str] = None) -> None:
    """A goal changed outside the planner: rewrite the planner's copy wherever this swimmer is."""
    if not swimmer:
        return
    find = _matcher(db)
    for doc in db.query(models.PlanDoc).filter_by(club=CLUB, key="roster").all():
        if doc.squad == skip or not doc.data:
            continue
        data = copy.deepcopy(doc.data)
        if _refresh(db, data, doc.squad, find, only=swimmer.id):
            doc.data, doc.revision = data, (doc.revision or 0) + 1
    db.commit()


def fill_roster(db: DBSession, squad: str) -> bool:
    """The planner is opening: bring its copy up to date, keeping any goal only it had."""
    doc = db.query(models.PlanDoc).filter_by(club=CLUB, squad=squad, key="roster").first()
    if not doc or not doc.data:
        return False
    find = _matcher(db)
    cal = _calendar(db, squad)
    data = copy.deepcopy(doc.data)
    for sw in data.get("swimmers") or []:
        a = find(sw)
        if not a:
            continue
        known = {r.plan_ref: r for r in goals_of(db, a.id) if r.plan_ref}
        for g in sw.get("goals") or []:
            if not g.get("id"):
                continue
            row = known.get(g["id"])
            if row is None:                     # a goal only the planner had: it becomes the swimmer's
                row = models.SwimmerTarget(swimmer_id=a.id, plan_ref=g["id"], label="")
                db.add(row)
                apply(db, row, _from_planner(g, None, row, cal))
            elif not row.meet_id and cal.get(g.get("meet")):
                apply(db, row, {"meet_id": cal[g["meet"]]})   # its meet is in the Meets tab now
    db.flush()
    changed = _refresh(db, data, squad, find)
    if changed:
        doc.data, doc.revision = data, (doc.revision or 0) + 1
    db.commit()
    return changed
