"""Training groups: who trains together, and since when.

Groups belong to the squad, not to a block of the season. A membership is
dated, so moving a swimmer up from 3 November leaves them in their old group
for the weeks before - attendance, load and the grid stay true to what
actually happened.

The season plan still says what each group works on (a macro's group
descriptions, a block's group intents). `macro_groups` joins the two and
returns the shape the rest of the app has always read from
`macro.group_definitions`: {label: {"description", "swimmer_ids", ...}}.

A squad that has not set up groups yet falls back to the lists saved on the
macro, which is how groups used to be kept.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models


class GroupError(ValueError):
    """A group change that cannot be made as asked."""


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def squad_groups(db: DBSession, squad: Optional[str] = None, include_inactive: bool = False) -> list:
    """The squad's groups in their running order. No squad means every group."""
    q = db.query(models.TrainingGroup)
    if not include_inactive:
        q = q.filter(models.TrainingGroup.active.is_(True))
    if squad:
        q = q.filter((models.TrainingGroup.squad == squad) | (models.TrainingGroup.squad.is_(None)))
    return q.order_by(models.TrainingGroup.sort_order, models.TrainingGroup.id).all()


def _covering(q, on: date):
    return q.filter(models.GroupMembership.date_from <= on,
                    (models.GroupMembership.date_to.is_(None)) | (models.GroupMembership.date_to >= on))


def memberships_on(db: DBSession, on: date, swimmer_ids=None) -> dict:
    """swimmer_id -> the membership that covers that date."""
    q = _covering(db.query(models.GroupMembership), on)
    if swimmer_ids is not None:
        q = q.filter(models.GroupMembership.swimmer_id.in_(list(swimmer_ids)))
    return {m.swimmer_id: m for m in q.all()}


def group_of(db: DBSession, swimmer_id: int, on: Optional[date] = None) -> Optional[models.TrainingGroup]:
    m = memberships_on(db, on or date.today(), [swimmer_id]).get(swimmer_id)
    return m.group if m else None


def history(db: DBSession, swimmer_id: int) -> list:
    return db.query(models.GroupMembership).filter(
        models.GroupMembership.swimmer_id == swimmer_id,
    ).order_by(models.GroupMembership.date_from).all()


def upcoming_moves(db: DBSession, after: date, swimmer_ids=None) -> dict:
    """swimmer_id -> the next membership that starts after a date."""
    q = db.query(models.GroupMembership).filter(models.GroupMembership.date_from > after)
    if swimmer_ids is not None:
        q = q.filter(models.GroupMembership.swimmer_id.in_(list(swimmer_ids)))
    out = {}
    for m in q.order_by(models.GroupMembership.date_from).all():
        out.setdefault(m.swimmer_id, m)
    return out


def _has_groups(db: DBSession, squad: Optional[str]) -> bool:
    return bool(squad_groups(db, squad))


def groups_on(db: DBSession, on: date, squad: Optional[str] = None) -> dict:
    """{label: {"group_id", "description", "swimmer_ids", "swimmer_names"}} on a date."""
    groups = squad_groups(db, squad)
    if not groups:
        return {}
    covering = memberships_on(db, on)
    names = {s.id: s.name for s in db.query(models.Swimmer).filter(
        models.Swimmer.id.in_(list(covering))).all()} if covering else {}
    out = {}
    for g in groups:
        ids = sorted((sid for sid, m in covering.items() if m.group_id == g.id), key=lambda i: names.get(i, ""))
        out[g.name] = {"group_id": g.id, "description": g.description or "",
                       "swimmer_ids": ids, "swimmer_names": [names[i] for i in ids if i in names]}
    return out


def _macro_date(macro: models.TrainingMacro, on: Optional[date]) -> date:
    on = on or date.today()
    return min(max(on, macro.date_from), macro.date_to)


def macro_groups(db: DBSession, macro: Optional[models.TrainingMacro], on: Optional[date] = None) -> dict:
    """The macro's groups with their members on a date (default: today, kept inside the macro).

    Membership comes from the squad's groups. What the macro says about a group
    - its description, its session approach - is kept, so the plan's view of a
    group and the squad's list of who is in it read as one.
    """
    if not macro:
        return {}
    planned = {k: v for k, v in (macro.group_definitions or {}).items() if isinstance(v, dict)}
    if not _has_groups(db, macro.squad):
        return {k: {**v, "swimmer_ids": [int(i) for i in v.get("swimmer_ids") or [] if str(i).isdigit()]}
                for k, v in planned.items()}
    live = groups_on(db, _macro_date(macro, on), macro.squad)
    out = {}
    for label, group in live.items():
        plan = planned.get(label, {})
        out[label] = {**{k: v for k, v in plan.items() if k not in ("swimmer_ids", "swimmer_names")},
                      **group, "description": plan.get("description") or group["description"]}
    return out


def label_for(db: DBSession, swimmer_id: int, macro: Optional[models.TrainingMacro], on: Optional[date] = None) -> Optional[str]:
    for label, defn in macro_groups(db, macro, on).items():
        if swimmer_id in defn.get("swimmer_ids", []):
            return label
    return None


# ---------------------------------------------------------------------------
# Changing
# ---------------------------------------------------------------------------

def create_group(db: DBSession, name: str, description: Optional[str] = None,
                 squad: Optional[str] = None) -> models.TrainingGroup:
    name = (name or "").strip()
    if not name:
        raise GroupError("A group needs a name")
    if any(g.name.lower() == name.lower() for g in squad_groups(db, squad)):
        raise GroupError(f"There is already a group called {name}")
    last = max((g.sort_order or 0 for g in squad_groups(db, squad, include_inactive=True)), default=0)
    group = models.TrainingGroup(name=name[:60], description=(description or "").strip() or None,
                                 squad=squad or None, sort_order=last + 1)
    db.add(group)
    db.flush()
    return group


def rename_plan_labels(db: DBSession, old: str, new: str) -> None:
    """Carry a renamed group through the plan: macro descriptions and block intents."""
    for macro in db.query(models.TrainingMacro).all():
        defs = dict(macro.group_definitions or {})
        if old in defs and new not in defs:
            defs[new] = defs.pop(old)
            macro.group_definitions = defs
    for block in db.query(models.SeasonBlock).all():
        intents = dict(block.group_intents or {})
        if old in intents and new not in intents:
            intents[new] = intents.pop(old)
            block.group_intents = intents


def update_group(db: DBSession, group: models.TrainingGroup, *, name=None, description=None,
                 sort_order=None) -> models.TrainingGroup:
    if name is not None:
        name = name.strip()
        if not name:
            raise GroupError("A group needs a name")
        if name != group.name:
            if any(g.id != group.id and g.name.lower() == name.lower() for g in squad_groups(db, group.squad)):
                raise GroupError(f"There is already a group called {name}")
            rename_plan_labels(db, group.name, name)
            group.name = name[:60]
    if description is not None:
        group.description = description.strip() or None
    if sort_order is not None:
        group.sort_order = int(sort_order)
    db.flush()
    return group


def close_group(db: DBSession, group: models.TrainingGroup, on: Optional[date] = None) -> int:
    """Stop using a group. Its swimmers leave it the day before `on`; history stays."""
    on = on or date.today()
    moved = 0
    for m in list(group.memberships):
        if m.date_from >= on:
            db.delete(m)
            moved += 1
        elif m.date_to is None or m.date_to >= on:
            m.date_to = on - timedelta(days=1)
            moved += 1
    group.active = False
    db.flush()
    return moved


def move(db: DBSession, swimmer_id: int, group_id: Optional[int], date_from: date,
         note: Optional[str] = None) -> Optional[models.GroupMembership]:
    """Put a swimmer in a group from a date (None takes them out of groups).

    The membership running on that date ends the day before. Anything already
    planned from that date on is replaced - the latest decision wins.
    """
    if not db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first():
        raise GroupError(f"There is no swimmer with id {swimmer_id}")
    group = None
    if group_id is not None:
        group = db.query(models.TrainingGroup).filter(models.TrainingGroup.id == group_id).first()
        if not group or not group.active:
            raise GroupError("That group does not exist")
    rows = db.query(models.GroupMembership).filter(
        models.GroupMembership.swimmer_id == swimmer_id,
        (models.GroupMembership.date_to.is_(None)) | (models.GroupMembership.date_to >= date_from),
    ).all()
    keep = None
    for m in rows:
        if m.date_from >= date_from:
            db.delete(m)
        elif group and m.group_id == group.id:
            m.date_to = None          # already in this group then: carry on
            keep = m
        else:
            m.date_to = date_from - timedelta(days=1)
    db.flush()
    if keep or not group:
        return keep
    membership = models.GroupMembership(swimmer_id=swimmer_id, group_id=group.id,
                                        date_from=date_from, note=(note or "").strip() or None)
    db.add(membership)
    db.flush()
    return membership


def copy_plan_groups(db: DBSession, macro: models.TrainingMacro) -> list:
    """Make squad groups from a macro's saved lists (how groups used to be kept)."""
    made = []
    # One squad split into groups: a macro's squad label does not split the groups.
    existing = {g.name.lower(): g for g in squad_groups(db, None, include_inactive=True)}
    for label, defn in (macro.group_definitions or {}).items():
        if not isinstance(defn, dict):
            continue
        group = existing.get(str(label).lower())
        if not group:
            group = models.TrainingGroup(name=str(label)[:60], description=defn.get("description") or None,
                                         sort_order=len(existing) + 1)
            db.add(group)
            db.flush()
            existing[group.name.lower()] = group
            made.append(group)
        for sid in defn.get("swimmer_ids") or []:
            if not str(sid).isdigit():
                continue
            current = memberships_on(db, macro.date_from, [int(sid)]).get(int(sid))
            if current and current.group_id == group.id:
                continue
            try:
                move(db, int(sid), group.id, macro.date_from, note=f"From {macro.name}")
            except GroupError:
                continue
    return made


def seed_from_macros(db: DBSession) -> int:
    """First run only: turn the groups saved on macros into squad groups, dated."""
    if db.query(models.TrainingGroup).first():
        return 0
    made = 0
    for macro in db.query(models.TrainingMacro).order_by(models.TrainingMacro.date_from).all():
        made += len(copy_plan_groups(db, macro))
    db.commit()
    return made


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def overview(db: DBSession, squad: Optional[str] = None, on: Optional[date] = None) -> dict:
    """The Groups page: each group and its swimmers today, moves still to come, and who is in none."""
    on = on or date.today()
    swimmers_q = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True))
    if squad:
        swimmers_q = swimmers_q.filter(models.Swimmer.squad == squad)
    swimmers = swimmers_q.order_by(models.Swimmer.name).all()
    ids = [s.id for s in swimmers]
    covering = memberships_on(db, on, ids)
    upcoming = upcoming_moves(db, on, ids)
    groups = squad_groups(db, squad)
    group_names = {g.id: g.name for g in squad_groups(db, squad, include_inactive=True)}
    # What each swimmer is aiming at this macrocycle - it can differ within a group.
    from backend.services import pathways as pathway_svc
    macro = pathway_svc.macro_on(db, on)
    aims = pathway_svc.pathways_on(db, macro.id, on, ids) if macro else {}
    later = pathway_svc.upcoming(db, macro.id, on, ids) if macro else {}

    def pathway_out(sid):
        m, nxt = aims.get(sid), later.get(sid)
        if not m and not nxt:
            return None
        return {"name": m.pathway.name if m else None, "colour": m.pathway.colour if m else None,
                "target": (m.pathway.primary_meet.name if m and m.pathway.primary_meet else None),
                "next": ({"name": nxt.pathway.name, "date_from": nxt.date_from.isoformat()} if nxt else None)}

    def swimmer_out(s):
        m = covering.get(s.id)
        nxt = upcoming.get(s.id)
        return {
            "id": s.id, "name": s.name, "status": s.status, "squad": s.squad,
            "since": m.date_from.isoformat() if m else None,
            "until": m.date_to.isoformat() if m and m.date_to else None,
            "next": ({"group_id": nxt.group_id, "group_name": group_names.get(nxt.group_id),
                      "date_from": nxt.date_from.isoformat()} if nxt else None),
            "pathway": pathway_out(s.id),
        }

    return {
        "on": on.isoformat(),
        # Once a macro has pathways, everyone should be on one.
        "pathways_in_use": bool(macro and any(p.active for p in macro.pathways)),
        "groups": [{
            "id": g.id, "name": g.name, "description": g.description or "", "squad": g.squad,
            "swimmers": [swimmer_out(s) for s in swimmers if covering.get(s.id) and covering[s.id].group_id == g.id],
        } for g in groups],
        "ungrouped": [swimmer_out(s) for s in swimmers if s.id not in covering
                      or covering[s.id].group_id not in {g.id for g in groups}],
    }


def history_out(db: DBSession, swimmer_id: int) -> list:
    return [{"id": m.id, "group_id": m.group_id, "group_name": m.group.name if m.group else None,
             "date_from": m.date_from.isoformat(), "date_to": m.date_to.isoformat() if m.date_to else None,
             "note": m.note} for m in history(db, swimmer_id)]


def roster_lines(db: DBSession, squad: Optional[str] = None, on: Optional[date] = None) -> list:
    """The groups as the staff read them: ids, members, moves to come."""
    data = overview(db, squad, on)
    if not data["groups"]:
        return ["TRAINING GROUPS: none set up yet."]
    lines = ["TRAINING GROUPS (today; move a swimmer with move_group):"]
    for g in data["groups"]:
        members = ", ".join(f"{s['name']} (id {s['id']})" for s in g["swimmers"]) or "nobody"
        lines.append(f"  group_id {g['id']} {g['name']}"
                     + (f" - {g['description'][:160]}" if g["description"] else "") + f": {members}")
    if data["ungrouped"]:
        lines.append("  Not in a group: " + ", ".join(f"{s['name']} (id {s['id']})" for s in data["ungrouped"]))
    moves = [f"{s['name']} to {s['next']['group_name']} from {s['next']['date_from']}"
             for g in data["groups"] for s in g["swimmers"] if s["next"]]
    moves += [f"{s['name']} to {s['next']['group_name']} from {s['next']['date_from']}"
              for s in data["ungrouped"] if s["next"]]
    if moves:
        lines.append("  Moves already agreed: " + "; ".join(moves))
    return lines


def plan_context(db: DBSession, swimmer_ids, on: date) -> tuple:
    """What each swimmer is working towards on a day, for whoever writes the session.

    Returns (per_swimmer, aim_lines): per_swimmer maps swimmer_id to a short
    "group Senior; pathway Winter Nationals -> Winter Nationals" note, and
    aim_lines are the groups' aims for the block that day falls in.
    """
    from backend.services import pathways as pathway_svc
    macro = pathway_svc.macro_on(db, on)
    live = macro_groups(db, macro, on) if macro else groups_on(db, on)
    label_of = {sid: label for label, defn in live.items() for sid in defn.get("swimmer_ids") or []}
    aims = pathway_svc.pathways_on(db, macro.id, on, swimmer_ids) if macro else {}
    block = None
    if macro:
        block = next((b for b in macro.mesos if b.date_from <= on <= b.date_to), None)
    intents = (block.group_intents or {}) if block else {}

    per_swimmer = {}
    for sid in swimmer_ids:
        bits = []
        if sid in label_of:
            bits.append(f"group {label_of[sid]}")
        m = aims.get(sid)
        if m:
            target = m.pathway.primary_meet.name if m.pathway.primary_meet else "no target meet"
            bits.append(f"pathway {m.pathway.name} -> {target}")
        if bits:
            per_swimmer[sid] = "; ".join(bits)

    aim_lines = []
    wanted = {label_of[sid] for sid in swimmer_ids if sid in label_of}
    for label in live:
        if label in wanted and intents.get(label):
            aim_lines.append(f"  {label}: {intents[label]}")
    if aim_lines and block:
        aim_lines.insert(0, f"GROUP AIMS THIS BLOCK ({block.name}):")
    return per_swimmer, aim_lines
