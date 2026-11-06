"""The coach's Season Planner, read by the rest of the app.

The planner's own screen code runs in the app and saves its plan and roster
as documents (models.PlanDoc). This module works out, in Python, what the
planner shows for any week - a line-for-line port of the planner's week logic
(groupAt, rw, TL, effC, campFor, awayIn) - so the staff, the Session Builder
and the load counter read the same plan the coach sees:

- each group's week: phase, macro.meso.micro code, load and the aerobic /
  anaerobic-endurance / speed components, and the session targets;
- each swimmer's week: the group they are in that week (dated moves), their
  own changes, camps they're on, and time away;
- after every save, the app's training groups and memberships follow the
  plan, so a new session in the builder starts with the plan's groups.

Intensity: the planner keeps its own numbers. Anything handed to the rest of
the app is carried over by level (a planner "Red" becomes the common scale's
Red), never by number (decision of 5 Nov 2026).
"""

from __future__ import annotations

import copy
import math
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

CLUB = "default"
COMPS = ("aer", "ana", "spd")
DEFW = {"Pre-season": {"aer": .9, "ana": .3, "spd": .6}, "General prep": {"aer": 1, "ana": .8, "spd": .8},
        "Specific prep": {"aer": .85, "ana": 1.1, "spd": 1}, "Taper": {"aer": .8, "ana": 1.2, "spd": 1.9},
        "Aerobic rebuild": {"aer": 1.1, "ana": .5, "spd": .6}, "LC base": {"aer": 1, "ana": .9, "spd": .8},
        "Competition window": {"aer": .9, "ana": 1, "spd": 1.1}, "Race-specific build": {"aer": .9, "ana": 1.15, "spd": 1},
        "Taper & hold": {"aer": .8, "ana": 1.2, "spd": 1.8}, "Exam maintenance": {"aer": .9, "ana": .5, "spd": 1},
        "Post-exam build": {"aer": 1, "ana": .9, "spd": .9}, "Off-season": {"aer": 0, "ana": 0, "spd": 0}}
INJ = {"load": .5, "aer": .6, "ana": .2, "spd": 0}

# The planner's BPSC colours on its own RPE /20 line, and the same colours on the common scale.
PLANNER_LEVELS = [("White", 1, 10), ("Yellow", 11, 12), ("Pink", 13, 14), ("Red", 15, 16), ("Purple", 17, 18), ("Blue", 19, 20), ("Gold", 21, 21)]
COMMON_BY_COLOUR = {"White": 10, "Yellow": 13.5, "Pink": 15.5, "Red": 17, "Purple": 18, "Blue": 19.5, "Gold": 21}


def r2(x: float) -> float:
    """Two decimals, halves rounded up, as the planner's Math.round does (Python's round() wouldn't)."""
    return math.floor(x * 100 + 0.5) / 100


def planner_level(r) -> Optional[str]:
    if r is None or r == "":
        return None
    r = float(r)
    best, gap = None, 1e9
    for name, lo, hi in PLANNER_LEVELS:
        d = lo - r if r < lo else (r - hi if r > hi else 0)
        if d < gap:
            best, gap = name, d
    return best


def to_common(r) -> Optional[float]:
    """A planner intensity on the common scale, carried over by its colour."""
    lvl = planner_level(r)
    return COMMON_BY_COLOUR[lvl] if lvl else None


def _iso(s) -> date:
    return date.fromisoformat(str(s)[:10])


class Plan:
    def __init__(self, plan: dict, roster: Optional[dict] = None):
        self.p = plan
        self.roster = roster or {"swimmers": []}
        self.start = _iso(plan["settings"]["start"])
        self.weeks = int(plan["settings"]["weeks"])
        self.branches = {b["id"]: b for b in plan.get("branches") or []}
        self.swimmers = {str(s["id"]): s for s in self.roster.get("swimmers") or []}
        self._tl = {}

    # ---- weeks
    def week_of(self, d: date) -> int:
        return (d - self.start).days // 7

    def wk_start(self, i: int) -> date:
        return self.start + timedelta(weeks=i)

    # ---- groups through the season
    def group_at(self, sw: dict, i: int) -> Optional[str]:
        g = sw.get("branch")
        for m in sw.get("moves") or []:
            if i >= m["w"] and m["to"] in self.branches:
                g = m["to"]
        return g

    def _pers(self, sid: str) -> dict:
        return (self.p.get("personal") or {}).get(str(sid)) or {}

    def own_get(self, sw: dict, i: int, g: str):
        return ((self._pers(sw["id"]).get("own") or {}).get(g) or {}).get(str(i))

    def camp_for(self, sid: str, i: int):
        a, e = self.wk_start(i), self.wk_start(i) + timedelta(days=6)
        for ev in self.p.get("events") or []:
            c = ev.get("camp")
            if ev.get("type") == "Camp" and c and str(sid) in [str(x) for x in c.get("attendees") or []] \
                    and _iso(ev["start"]) <= e and _iso(ev["end"]) >= a:
                return ev
        return None

    def rw(self, bid: str, i: int):
        """The raw week a branch (or "sw:<id>") follows: its own, its parent's, a camp's."""
        while bid:
            if bid.startswith("sw:"):
                sw = self.swimmers.get(bid[3:])
                if not sw or sw.get("branch") not in self.branches:     # not on the plan (the planner's planned())
                    return None
                gi = self.group_at(sw, i)
                w = self.own_get(sw, i, gi)
                if w:
                    return w
                ev = self.camp_for(sw["id"], i)
                if ev:
                    base = self.rw(gi, i) or {}
                    c = ev["camp"]
                    o = {"p": base.get("p"), "load": c["load"] if c.get("load") is not None else base.get("load"), "camp": ev["id"]}
                    for k in COMPS:
                        if c.get(k) is not None:
                            o[k] = c[k]
                    return o
                bid = gi
                continue
            b = self.branches.get(bid)
            if not b:
                return None
            w = (b.get("weeks") or {}).get(str(i))
            if w:
                return w
            bid = b.get("parent")
        return None

    def weights(self, template: Optional[str]) -> dict:
        t = next((x for x in self.p.get("templates") or [] if x.get("name") == template), None)
        return {"aer": 1, "ana": 1, "spd": 1, **DEFW.get(template or "", {}), **((t or {}).get("w") or {})}

    def comps(self, w: Optional[dict]) -> dict:
        if not w:
            return {k: 0 for k in COMPS}
        W = self.weights((self.p.get("phases", {}).get(w.get("p")) or {}).get("template"))
        return {k: float(w[k]) if w.get(k) is not None else r2(max(0, (w.get("load") or 0) * W[k])) for k in COMPS}

    def away_in(self, sw: dict, i: int):
        items = self._pers(sw["id"]).get("away") or []
        if not items:
            return None
        sessions = self.p.get("sessions") or []
        tot = sum(float(x.get("hours") or 0) for x in sessions) or 1
        F = {"load": 1, "aer": 1, "ana": 1, "spd": 1}
        found = []
        ws, we = self.wk_start(i), self.wk_start(i) + timedelta(days=6)
        for a in items:
            if not a.get("from"):
                continue
            A, Z = _iso(a["from"]), _iso(a.get("to") or a["from"])
            if Z < ws or A > we:
                continue
            miss = sum(float(x.get("hours") or 0) for x in sessions if A <= ws + timedelta(days=int(x.get("day") or 0)) <= Z)
            frac = miss / tot
            if frac <= 0:
                continue
            m = {**INJ, **(a.get("mods") or {})} if a.get("type") == "Injury" else {"load": 0, "aer": 0, "ana": 0, "spd": 0}
            for k in F:
                F[k] *= 1 - frac * (1 - m[k])
            found.append({"type": a.get("type"), "frac": frac, "note": a.get("note") or ""})
        return {"F": F, "items": found} if found else None

    def timeline(self, bid: str) -> list:
        """Every week for a branch or swimmer, as the planner's TL() shows it."""
        if bid in self._tl:
            return self._tl[bid]
        out, pp, pm, meso, micro = [], None, None, 0, 0
        sw = self.swimmers.get(bid[3:]) if bid.startswith("sw:") else None
        for i in range(self.weeks):
            w = self.rw(bid, i) or {"p": None, "load": 0}
            ph = self.p.get("phases", {}).get(w.get("p")) or {"macro": "–", "name": "—", "template": "", "course": ""}
            m = str(ph.get("macro"))
            if w.get("p") != pp:
                micro = 1
                meso = 1 if m != pm else meso + 1
            else:
                micro += 1
            pp, pm = w.get("p"), m
            load = w.get("load") or 0
            c = self.comps(w)
            away = self.away_in(sw, i) if sw else None
            if away:
                load = r2(load * away["F"]["load"])
                c = {k: r2(c[k] * away["F"][k]) for k in COMPS}
            out.append({"i": i, "week_start": self.wk_start(i).isoformat(), "p": w.get("p"), "phase": ph.get("name"),
                        "objective": ph.get("objective"), "template": ph.get("template"), "course": ph.get("course"),
                        "macro": m, "code": "Off" if m == "–" else f"{m}.{meso}.{micro}", "load": load, "plan_load": w.get("load") or 0,
                        "comps": c, "camp": w.get("camp"), "group": self.group_at(sw, i) if sw else bid,
                        "away": away})
        self._tl[bid] = out
        return out

    def targets(self, template: Optional[str]) -> list:
        """The template's session targets, each focus on the common scale too."""
        t = next((x for x in self.p.get("templates") or [] if x.get("name") == template), None)
        if not t:
            return []
        out = []
        for s in self.p.get("sessions") or []:
            f = (t.get("f") or {}).get(s["id"]) or {}
            focus = [v for v in (f.get("a"), f.get("b")) if v is not None]
            out.append({"session": s.get("label") or s["id"], "text": (t.get("s") or {}).get(s["id"], ""),
                        "levels": [planner_level(v) for v in focus], "common": [to_common(v) for v in focus]})
        return out


# ---------------------------------------------------------------- reading it from the app

def load(db: DBSession, squad: str) -> Optional[Plan]:
    rows = {d.key: d.data for d in db.query(models.PlanDoc).filter_by(club=CLUB, squad=squad)}
    if not rows.get("plan"):
        return None
    try:
        return Plan(rows["plan"], rows.get("roster"))
    except (KeyError, ValueError):
        return None


def _app_ref(sid) -> Optional[int]:
    """A swimmer added to the plan from the app, with no Swim England number, is "app<id>"."""
    s = str(sid or "")
    return int(s[3:]) if s.startswith("app") and s[3:].isdigit() else None


def app_ids(db: DBSession, plan: Plan) -> dict:
    """Planner swimmer id (swimrankings id) -> app swimmer id."""
    ids = {}
    rows = db.query(models.Swimmer).all()
    by_sr = {s.swimrankings_id: s.id for s in rows if s.swimrankings_id}
    by_name = {s.name.lower(): s.id for s in rows}
    by_id = {s.id for s in rows}
    for sid, sw in plan.swimmers.items():
        ref = _app_ref(sid)
        aid = (ref if ref in by_id else None) or by_sr.get(sid) or by_name.get((sw.get("name") or "").lower())
        if aid:
            ids[sid] = aid
    return ids


def week(db: DBSession, squad: str, on: date) -> Optional[dict]:
    """The plan for the week containing a date: each group, and each swimmer's own week."""
    plan = load(db, squad)
    if not plan:
        return None
    i = plan.week_of(on)
    if not 0 <= i < plan.weeks:
        return None
    groups = []
    for bid, b in plan.branches.items():
        w = plan.timeline(bid)[i]
        groups.append({"id": bid, "name": b.get("name"), "parent": b.get("parent"), **w, "targets": plan.targets(w["template"])})
    ids = app_ids(db, plan)
    swimmers = {}
    for sid, sw in plan.swimmers.items():
        w = plan.timeline(f"sw:{sid}")[i]
        swimmers[str(ids.get(sid, f"planner:{sid}"))] = {"name": sw.get("name"), "group": w["group"], "code": w["code"], "load": w["load"],
                                                         "comps": w["comps"], "camp": w["camp"], "away": w["away"]}
    return {"squad": squad, "week": i, "week_start": plan.wk_start(i).isoformat(), "groups": groups, "swimmers": swimmers}


def week_code(db: DBSession, squad: Optional[str], on: date) -> Optional[str]:
    if not squad:
        return None
    plan = load(db, squad)
    if not plan:
        return None
    i = plan.week_of(on)
    if not 0 <= i < plan.weeks:
        return None
    root = next((bid for bid, b in plan.branches.items() if not b.get("parent")), None)
    return plan.timeline(root)[i]["code"] if root else None


def staff_lines(db: DBSession, squad: Optional[str], on: date) -> str:
    """The week's plan as the staff read it."""
    w = week(db, squad, on) if squad else None
    if not w:
        return ""
    lines = [f"THE SEASON PLAN, week of {w['week_start']} ({squad}):"]
    for g in w["groups"]:
        c = g["comps"]
        lines.append(f"- {g['name']}: {g['code']} {g['phase']} (load {g['load']:.2f}; aerobic {c['aer']:.2f}, "
                     f"anaerobic {c['ana']:.2f}, speed {c['spd']:.2f})" + (f" - {g['objective']}" if g.get("objective") else ""))
    odd = [f"{s['name']}: {s['group']}" + (" (camp)" if s["camp"] else "") + (" (away)" if s["away"] else "")
           for s in w["swimmers"].values() if s["camp"] or s["away"]]
    if odd:
        lines.append("Swimmers off the usual plan: " + "; ".join(odd))
    return "\n".join(lines)


# ---------------------------------------------------------------- after a save

def after_save(db: DBSession, squad: str) -> dict:
    """Make the app's training groups and memberships follow the plan."""
    plan = load(db, squad)
    if not plan:
        return {}
    groups = {}
    for bid, b in plan.branches.items():
        g = db.query(models.TrainingGroup).filter_by(squad=squad, name=b.get("name")).first()
        if not g:
            g = models.TrainingGroup(squad=squad, name=b.get("name") or bid, description=b.get("note") or None, active=True)
            db.add(g)
            db.flush()
        groups[bid] = g
    ids = app_ids(db, plan)
    moved = 0
    for sid, sw in plan.swimmers.items():
        aid = ids.get(sid)
        if not aid:
            continue
        runs, cur = [], None
        for i in range(plan.weeks):
            g = plan.group_at(sw, i)
            if g != cur:
                runs.append([g, i, i])
                cur = g
            else:
                runs[-1][2] = i
        db.query(models.GroupMembership).filter(models.GroupMembership.swimmer_id == aid,
                                                models.GroupMembership.group_id.in_([g.id for g in groups.values()])).delete(synchronize_session=False)
        for g, a, z in runs:
            if g in groups:
                end = None if z == plan.weeks - 1 else plan.wk_start(z) + timedelta(days=6)
                db.add(models.GroupMembership(swimmer_id=aid, group_id=groups[g].id, date_from=plan.wk_start(a), date_to=end,
                                              note="from the season plan"))
                moved += 1
    db.commit()
    return {"groups": len(groups), "memberships": moved}


OCCASIONAL = "occasional"   # uni / visiting: on the register when they come, not planned for


def _dob(v):
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def sync_swimmers(db: DBSession, squad: str, before: Optional[dict], after: Optional[dict]) -> dict:
    """Make the app's swimmer list follow the planner's Squad tab.

    - A swimmer added in the planner is added to the app.
    - "Not planned" (uni / visiting) swimmers are marked occasional: they stay on
      the register but the staff don't plan for them. Put back on a group, they
      are active again. Sabbatical and injury are the coach's call and are kept.
    - A swimmer removed from the planner is set inactive in the app, never
      deleted, so their history stays.
    """
    if not after:
        return {}
    rows = db.query(models.Swimmer).all()
    by_sr = {s.swimrankings_id: s for s in rows if s.swimrankings_id}
    by_name = {s.name.strip().lower(): s for s in rows}
    by_id = {s.id: s for s in rows}
    plan = load(db, squad)
    branches = set(plan.branches) if plan else set()

    def find(sw):
        return (by_id.get(_app_ref(sw.get("id"))) or by_sr.get(str(sw.get("id")))
                or by_name.get((sw.get("name") or "").strip().lower()))

    was = {str(s.get("id")) for s in (before or {}).get("swimmers", [])}
    added = changed = left = 0
    now = {str(s.get("id")) for s in after.get("swimmers", [])}
    for sw in after.get("swimmers", []):
        planned = bool(sw.get("branch")) and (not branches or sw.get("branch") in branches)
        a = find(sw)
        if not a:
            sid = str(sw.get("id") or "")
            a = models.Swimmer(name=(sw.get("name") or "").strip(), squad=squad, active=True,
                               status="active" if planned else OCCASIONAL,
                               swimrankings_id=sid if sid.isdigit() else None,
                               dob=_dob(sw.get("dob")), gender=(sw.get("g") or None) if sw.get("g") in ("M", "F") else None)
            if a.name:
                db.add(a)
                added += 1
            continue
        before_state = (a.squad, a.status, a.active)
        if not a.squad:
            a.squad = squad
        if planned and a.status == OCCASIONAL:
            a.status = "active"
        elif not planned and (a.status or "active") == "active":
            a.status = OCCASIONAL
        if str(sw.get("id")) not in was and before is not None and not a.active:
            a.active = True                      # put back on the planner's list
        if (a.squad, a.status, a.active) != before_state:
            changed += 1
    for sid in was - now:
        old = next((s for s in before.get("swimmers", []) if str(s.get("id")) == sid), None)
        a = find(old) if old else None
        if a and a.active:
            a.active = False
            left += 1
            for m in db.query(models.GroupMembership).filter(models.GroupMembership.swimmer_id == a.id,
                                                             models.GroupMembership.date_to.is_(None)):
                m.date_to = date.today()
    db.commit()
    return {"added": added, "changed": changed, "left": left}


# ---------------------------------------------------------------- from the app

STROKES = {"Freestyle": "Free", "Backstroke": "Back", "Breaststroke": "Breast", "Butterfly": "Fly", "Individual Medley": "IM"}
NOT_PLANNED = ""     # the planner's "Not planned (uni / visiting)"


def _blank_event(e: str) -> dict:
    return {"e": e, "sc": None, "lc": None, "sb": None, "wn": None, "wm": None, "wd": None, "wc": None, "er": None, "em": None}


def _planner_event(event: str) -> Optional[str]:
    d, _, stroke = str(event or "").partition(" ")
    return f"{d} {STROKES[stroke]}" if d.isdigit() and stroke in STROKES else None


def groups_of(db: DBSession, squad: str) -> list:
    plan = load(db, squad)
    return [{"id": bid, "name": b.get("name") or bid} for bid, b in plan.branches.items()] if plan else []


def place_swimmer(db: DBSession, squad: str, swimmer: models.Swimmer, group: str, on: Optional[date] = None) -> Optional[dict]:
    """Put an app swimmer into a squad's season plan, in a group (or Not planned).

    A new swimmer joins the group from the start, so they get the group's plan
    straight away. Someone already on the plan moves from this week, as the
    planner's own "Group from this week" does, keeping where they were before."""
    plan = load(db, squad)
    doc = db.query(models.PlanDoc).filter_by(club=CLUB, squad=squad, key="roster").first()
    if not plan or not doc:
        raise ValueError(f"{squad} has no season plan yet")
    if group and group not in plan.branches:
        raise ValueError("That group isn't in the season plan")
    before = doc.data or {}
    data = copy.deepcopy(before)
    roster = data.setdefault("swimmers", [])
    sr = "".join(ch for ch in (swimmer.swimrankings_id or "") if ch.isdigit())
    rid = sr or f"app{swimmer.id}"
    name = swimmer.name.strip().lower()
    sw = next((s for s in roster if str(s.get("id")) == rid or _app_ref(s.get("id")) == swimmer.id
               or (s.get("name") or "").strip().lower() == name), None)
    if sw is None:
        events = [e for e in (_planner_event(t.get("event")) for t in (swimmer.target_events or []) if isinstance(t, dict)) if e]
        roster.append({"id": rid, "name": swimmer.name.strip(), "g": swimmer.gender or "",
                       "dob": swimmer.dob.isoformat() if swimmer.dob else "", "tag": squad.replace(" ", "_"), "camp": "",
                       "branch": group, "moves": [], "note": "", "events": [_blank_event(e) for e in dict.fromkeys(events)]})
        roster.sort(key=lambda s: (s.get("name") or "").lower())
    else:
        now = max(0, min(plan.weeks - 1, plan.week_of(on or date.today())))
        on_plan = sw.get("branch") in plan.branches
        if not group or not on_plan or now <= 0:
            sw["branch"], sw["moves"] = group, []
        else:
            sw["moves"] = [m for m in (sw.get("moves") or []) if m.get("w", 0) < now]
            if plan.group_at(sw, now) != group:
                sw["moves"].append({"w": now, "to": group})
    swimmer.squad = squad
    doc.data, doc.revision = data, (doc.revision or 0) + 1
    db.commit()
    sync_swimmers(db, squad, before, data)
    after_save(db, squad)
    return swimmer_week(db, swimmer, on)


def swimmer_week(db: DBSession, swimmer: models.Swimmer, on: Optional[date] = None) -> Optional[dict]:
    """This week of the season plan for one swimmer: their group and what it's doing."""
    if not swimmer.squad:
        return None
    w = week(db, swimmer.squad, on or date.today())
    if not w:
        return None
    me = w["swimmers"].get(str(swimmer.id))
    if not me:
        return {"squad": swimmer.squad, "on_plan": False, "groups": [{"id": g["id"], "name": g["name"]} for g in w["groups"]]}
    g = next((g for g in w["groups"] if g["id"] == me["group"]), None)
    return {"squad": swimmer.squad, "on_plan": bool(g), "week_start": w["week_start"],
            "group": {"id": me["group"], "name": g["name"]} if g else None,
            "code": me["code"], "phase": g.get("phase") if g else None, "objective": g.get("objective") if g else None,
            "load": me["load"], "comps": me["comps"], "camp": bool(me["camp"]), "away": bool(me["away"]),
            "groups": [{"id": x["id"], "name": x["name"]} for x in w["groups"]]}
