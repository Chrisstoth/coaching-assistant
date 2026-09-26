"""The squad on one screen: weeks across, squad then groups then swimmers down.

A swimmer follows their group's plan, so their row only shows what is
different for them - time away, illness, galas they are entered in or aiming
at, how much of the week they actually trained - and is quiet otherwise.
Groups carry a count of members with something going on, so a problem is
visible before the group is opened.

Scoped to one macrocycle. A swimmer sits in the group they are in this week
(or at the macro's nearest edge); a move part-way through shows in the week
it happens.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import groups as group_svc
from backend.services import pathways as pathway_svc
from backend.services.training_load import HIGH_INTENSITY, VOLUME_KEYS

UNGROUPED = "Not in a group"


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def build_grid(db: DBSession, macro_id: int, today: Optional[date] = None) -> Optional[dict]:
    today = today or date.today()
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        return None

    first = _monday(macro.date_from)
    weeks = []
    cursor = first
    while cursor <= macro.date_to:
        weeks.append(cursor)
        cursor += timedelta(days=7)
    end = weeks[-1] + timedelta(days=6)
    index = {w: i for i, w in enumerate(weeks)}

    def week_of(d: Optional[date]) -> Optional[int]:
        return index.get(_monday(d)) if d else None

    def weeks_between(start: date, stop: Optional[date]) -> list:
        stop = stop or start
        return [i for i, w in enumerate(weeks) if w <= stop and w + timedelta(days=6) >= start]

    blocks = sorted(macro.mesos, key=lambda b: b.date_from)
    loads = {p.week_start: p for p in macro.load_points if p.pathway_id is None}
    meets = db.query(models.Meet).filter(models.Meet.date >= first, models.Meet.date <= end).order_by(models.Meet.date).all()

    week_rows = []
    for i, w in enumerate(weeks):
        block = next((b for b in blocks if b.date_from <= w + timedelta(days=6) and b.date_to >= w), None)
        point = loads.get(w)
        week_rows.append({
            "week_start": w.isoformat(),
            "block_id": block.id if block else None,
            "block_name": block.name if block else None,
            "phase": block.phase_type if block else None,
            "load": point.overall if point else None,
            "load_note": point.note if point else None,
            "meets": [{"id": m.id, "name": m.name, "date": m.date.isoformat(), "level": m.level}
                      for m in meets if week_of(m.date) == i],
            "is_current": w <= today <= w + timedelta(days=6),
            "is_past": w + timedelta(days=6) < today,
        })

    # Who is in the grid: the macro's groups, its pathways, and its squad.
    groups = []
    member_group = {}
    focus = min(max(today, macro.date_from), macro.date_to)
    for name, defn in group_svc.macro_groups(db, macro, focus).items():
        ids = list(defn.get("swimmer_ids") or [])
        groups.append({"name": name, "description": defn.get("description") or "",
                       "intents": [{"block_id": b.id, "text": (b.group_intents or {}).get(name)}
                                   for b in blocks if (b.group_intents or {}).get(name)],
                       "swimmer_ids": ids})
        for sid in ids:
            member_group.setdefault(sid, name)
    pathways = [p for p in macro.pathways if p.active]
    # The pathway a swimmer is on this week (swimmers in one group can differ,
    # and a swimmer can branch onto another pathway part-way through).
    pathway_of = {sid: {"id": m.pathway.id, "name": m.pathway.name, "colour": m.pathway.colour,
                        "status": m.qualification_status}
                  for sid, m in pathway_svc.pathways_on(db, macro.id, focus).items()}
    pathway_members = [m for p in pathways for m in p.memberships if m.active]
    # One squad, split into groups: everyone active is in the grid.
    squad_q = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True))
    ids = set(member_group) | {m.swimmer_id for m in pathway_members} | {s.id for s in squad_q.all()}
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).order_by(models.Swimmer.name).all() if ids else []
    ids = [s.id for s in swimmers]

    cells = defaultdict(lambda: defaultdict(lambda: {"away": [], "events": [], "meets": [], "flags": [], "moves": []}))

    # A branch onto a pathway part-way through the macro, in its week.
    for m in pathway_members:
        if m.swimmer_id in ids and m.date_from and macro.date_from < m.date_from <= end:
            cells[m.swimmer_id][week_of(m.date_from)]["moves"].append(f"Onto the {m.pathway.name} pathway")

    # Group moves inside the macro, in the week they take effect.
    names = {g.id: g.name for g in group_svc.squad_groups(db, macro.squad, include_inactive=True)}
    rows = db.query(models.GroupMembership).filter(
        models.GroupMembership.swimmer_id.in_(ids)).order_by(models.GroupMembership.date_from).all() if ids else []
    starts = {(m.swimmer_id, m.date_from) for m in rows}
    for m in rows:
        if macro.date_from < m.date_from <= end:
            cells[m.swimmer_id][week_of(m.date_from)]["moves"].append(f"Moves to {names.get(m.group_id, 'a new group')}")
        left = m.date_to + timedelta(days=1) if m.date_to else None
        if left and macro.date_from < left <= end and (m.swimmer_id, left) not in starts:
            cells[m.swimmer_id][week_of(left)]["moves"].append(f"Leaves {names.get(m.group_id, 'their group')}")

    for e in db.query(models.SwimmerException).filter(
            models.SwimmerException.swimmer_id.in_(ids), models.SwimmerException.date_to >= first,
            models.SwimmerException.date_from <= end).all():
        for i in weeks_between(e.date_from, e.date_to):
            cells[e.swimmer_id][i]["away"].append(e.reason)
    for e in db.query(models.SwimmerLoadEvent).filter(
            models.SwimmerLoadEvent.swimmer_id.in_(ids), models.SwimmerLoadEvent.date_from <= end).all():
        stop = e.date_to or (today if not e.resolved else e.date_from)
        if stop < first:
            continue
        for i in weeks_between(e.date_from, min(stop, end)):
            if e.event_type in ("illness", "injury"):
                cells[e.swimmer_id][i]["events"].append(e.event_type)

    meet_week = {m.id: week_of(m.date) for m in meets}
    entered = defaultdict(set)
    for e in db.query(models.MeetEntry).filter(models.MeetEntry.swimmer_id.in_(ids),
                                               models.MeetEntry.meet_id.in_(list(meet_week))).all():
        entered[(e.swimmer_id, e.meet_id)].add(e.event_name)
    planned = {}
    for t in db.query(models.MeetTarget).filter(models.MeetTarget.swimmer_id.in_(ids),
                                                models.MeetTarget.meet_id.in_(list(meet_week))).all():
        planned[(t.swimmer_id, t.meet_id)] = t
    aims_on = {meet.id: pathway_svc.pathways_on(db, macro.id, meet.date) for meet in meets}
    for sid in ids:
        for meet in meets:
            i = meet_week[meet.id]
            key = (sid, meet.id)
            member = aims_on[meet.id].get(sid)
            aim = member.pathway if member else None
            if entered.get(key):
                cells[sid][i]["meets"].append({"id": meet.id, "name": meet.name, "state": "entered",
                                               "events": sorted(entered[key])})
            elif key in planned:
                cells[sid][i]["meets"].append({"id": meet.id, "name": meet.name, "state": "planned",
                                               "events": planned[key].events or []})
            elif aim and meet.id in (aim.primary_meet_id, aim.fallback_meet_id):
                cells[sid][i]["meets"].append({"id": meet.id, "name": meet.name, "state": "pathway", "events": []})

    # Qualified for a meet they are not entered in: worth knowing in time.
    achieved = db.query(models.QualificationAssessment, models.QualificationStandardSet).join(
        models.QualificationStandardSet,
        models.QualificationAssessment.standard_set_id == models.QualificationStandardSet.id,
    ).filter(models.QualificationAssessment.swimmer_id.in_(ids),
             models.QualificationAssessment.status == "achieved",
             models.QualificationStandardSet.meet_id.in_(list(meet_week))).all()
    for assessment, standard_set in achieved:
        sid, mid = assessment.swimmer_id, standard_set.meet_id
        if not entered.get((sid, mid)):
            flag = f"Qualified for {next(m.name for m in meets if m.id == mid)} but not entered"
            cell = cells[sid][meet_week[mid]]
            if flag not in cell["flags"]:
                cell["flags"].append(flag)

    # What actually happened in weeks gone by.
    for entry, session in db.query(models.SessionEntry, models.Session).join(
            models.Session, models.SessionEntry.session_id == models.Session.id).filter(
            models.SessionEntry.swimmer_id.in_(ids), models.SessionEntry.attended.is_not(None),
            models.Session.date >= first, models.Session.date <= min(end, today),
            models.Session.status != "cancelled").all():
        cell = cells[entry.swimmer_id][week_of(session.date)]
        att = cell.setdefault("attendance", [0, 0])
        att[1] += 1
        if entry.attended:
            att[0] += 1
    for load in db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.swimmer_id.in_(ids), models.SwimmerSessionLoad.session_date >= first,
            models.SwimmerSessionLoad.session_date <= min(end, today)).all():
        cell = cells[load.swimmer_id][week_of(load.session_date)]
        volume = load.volume_breakdown or {}
        cell["metres"] = cell.get("metres", 0) + sum(float(volume.get(k, 0) or 0) for k in VOLUME_KEYS)
        cell["hi_metres"] = cell.get("hi_metres", 0) + sum(float(volume.get(k, 0) or 0) for k in HIGH_INTENSITY)

    def swimmer_out(s):
        row_cells = {}
        for i, cell in cells.get(s.id, {}).items():
            if i is None:
                continue
            att = cell.get("attendance")
            if att and att[1] >= 2 and att[0] / att[1] < 0.5 and not cell["away"]:
                cell["flags"].append(f"Trained {att[0]} of {att[1]} sessions")
            if any(v for k, v in cell.items() if k != "attendance") or att:
                row_cells[str(i)] = {k: v for k, v in cell.items() if v not in ([], None)}
        return {
            "id": s.id, "name": s.name, "para_class": s.para_class, "status": s.status,
            "pathway": pathway_of.get(s.id), "cells": row_cells,
            "flag_weeks": sorted(int(i) for i, c in row_cells.items()
                                 if c.get("flags") or c.get("events") or c.get("away") or c.get("moves")),
        }

    out_swimmers = {s.id: swimmer_out(s) for s in swimmers}
    group_rows = []
    for group in groups + [{"name": UNGROUPED, "description": "", "intents": [],
                            "swimmer_ids": [s.id for s in swimmers if s.id not in member_group]}]:
        members = [out_swimmers[i] for i in group["swimmer_ids"] if i in out_swimmers]
        if not members:
            continue
        rollup = defaultdict(int)
        for member in members:
            for i in member["flag_weeks"]:
                rollup[str(i)] += 1
        group_rows.append({"name": group["name"], "description": group["description"],
                           "intents": group["intents"], "swimmers": members, "rollup": dict(rollup)})

    return {
        "macro": {"id": macro.id, "name": macro.name, "squad": macro.squad,
                  "date_from": macro.date_from.isoformat(), "date_to": macro.date_to.isoformat()},
        "weeks": week_rows,
        "blocks": [{"id": b.id, "name": b.name, "phase": b.phase_type} for b in blocks],
        "groups": group_rows,
        "pathways": [{"id": p.id, "name": p.name, "colour": p.colour} for p in pathways],
    }
