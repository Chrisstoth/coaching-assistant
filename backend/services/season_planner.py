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

import bisect
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


def common_level(v) -> Optional[str]:
    """A value on the common line as its BPSC colour (White below 12.5 ... Gold from 20.5)."""
    if v is None or v == "":
        return None
    v = float(v)
    for name, top in (("White", 12.5), ("Yellow", 14.5), ("Pink", 16.5), ("Red", 17.5), ("Purple", 18.5), ("Blue", 20.5)):
        if v < top:
            return name
    return "Gold"


def _norm_t(o: dict) -> dict:
    """A session's focus (main / 2nd / 3rd), notes, and its versions (the planner's normT)."""
    def v(x):
        return None if x is None or x == "" else float(x)
    t = {"a": v(o.get("a")), "b": v(o.get("b")), "c": v(o.get("c")), "n": o.get("n") or ""}
    if isinstance(o.get("v"), list) and o["v"]:
        t["v"] = [{"k": x.get("k") if x.get("k") in ("did", "missed", "names") else "missed",
                   "s": [str(y) for y in x.get("s") or []], "ids": [str(y) for y in x.get("ids") or []],
                   "a": v(x.get("a")), "b": v(x.get("b")), "c": v(x.get("c")), "n": x.get("n") or ""}
                  for x in o["v"] if isinstance(x, dict)]
    return t


def _iso(s) -> date:
    return date.fromisoformat(str(s)[:10])


class Plan:
    """The plan for reading. actual is what happened, from the app: {"cancelled": {(iso date, slot id): reason},
    "extra": [{"date", "hours", "picked": [planner swimmer ids]}]} - the planner's cutIn()."""

    def __init__(self, plan: dict, roster: Optional[dict] = None, actual: Optional[dict] = None):
        self.p = plan
        self.roster = roster or {"swimmers": []}
        self.start = _iso(plan["settings"]["start"])
        self.end = self.start + timedelta(weeks=int(plan["settings"]["weeks"]))   # the day after the season
        micros = plan["settings"].get("micros") or []
        if micros:
            starts = sorted({_iso(m) for m in micros if self.start < _iso(m) < self.end})
            self.starts = [self.start] + starts
        else:
            self.starts = [self.start + timedelta(weeks=i) for i in range(int(plan["settings"]["weeks"]))]
        self.micro = bool(micros)
        self.weeks = len(self.starts)          # columns: weeks, or micros of any length
        self.branches = {b["id"]: b for b in plan.get("branches") or []}
        self.swimmers = {str(s["id"]): s for s in self.roster.get("swimmers") or []}
        self.actual = actual or {}
        self._tl = {}
        self._occ = {}

    # ---- columns: weeks, or micros of any length (the planner's grid())
    def week_of(self, d: date) -> int:
        if not self.micro or d < self.start:
            return (d - self.start).days // 7
        if d >= self.end:
            return self.weeks + (d - self.end).days // 7
        return bisect.bisect_right(self.starts, d) - 1

    def wk_start(self, i: int) -> date:
        if 0 <= i < self.weeks:
            return self.starts[i]
        return self.start + timedelta(weeks=i) if i < 0 else self.end + timedelta(weeks=i - self.weeks)

    def wk_end(self, i: int) -> date:
        return self.wk_start(i + 1) - timedelta(days=1)

    def occurrences(self, i: int) -> list:
        """The timetable's sessions in column i, in date order (the planner's occs()): key, session, date, and the
        standard-week session it takes its focus from."""
        if i in self._occ:
            return self._occ[i]
        ts = sorted(self.p.get("sessions") or [], key=lambda x: (int(x.get("day") or 0), str(x.get("time") or "")))
        out, seen = [], {}
        d, e = self.wk_start(i), self.wk_end(i)
        while d <= e:
            for x in ts:
                if int(x.get("day") or 0) != d.weekday():
                    continue
                seen[x["id"]] = seen.get(x["id"], 0) + 1
                out.append({"key": x["id"] if seen[x["id"]] == 1 else f"{x['id']}~{seen[x['id']]}", "x": x, "d": d})
            d += timedelta(days=1)
        for k, o in enumerate(out):
            o["k"] = k
            o["tpl"] = (ts[k] if k < len(ts) else None) if self.micro else o["x"]
        self._occ[i] = out
        return out

    def occurrence_on(self, d: date, slot_id) -> Optional[dict]:
        """The plan's session on a date in a timetable slot."""
        i = self.week_of(d)
        if not 0 <= i < self.weeks:
            return None
        return next((o for o in self.occurrences(i) if o["d"] == d and o["x"].get("slot") == slot_id), None)

    # ---- groups through the season
    def span(self, bid: Optional[str]) -> Optional[tuple]:
        """A short-term group's first and last week (both included); None for a group that runs all season."""
        b = self.branches.get(bid) if bid else None
        s = (b or {}).get("span") or {}
        if not b or not b.get("parent") or s.get("a") is None or s.get("b") is None:
            return None
        return int(s["a"]), int(s["b"])

    def runs_in(self, bid: Optional[str], i: int) -> bool:
        s = self.span(bid)
        return not s or s[0] <= i <= s[1]

    def ended(self, bid: str, i: int) -> bool:
        s = self.span(bid)
        return bool(s) and i > s[1]

    def group_at(self, sw: dict, i: int) -> Optional[str]:
        """The planner's groupAt(): outside a short-term group's weeks a swimmer is back in
        the group they were in before it, or failing that the group it follows."""
        hist = [sw.get("branch")]
        for m in sw.get("moves") or []:
            if i >= m["w"] and m["to"] in self.branches:
                hist.append(m["to"])
        for g in reversed(hist):
            if g not in self.branches or self.runs_in(g, i):
                return g
        g = hist[-1]
        for _ in range(50):
            if not g or self.runs_in(g, i):
                break
            g = self.branches[g].get("parent")
        return g if g in self.branches else hist[-1]

    def _pers(self, sid: str) -> dict:
        return (self.p.get("personal") or {}).get(str(sid)) or {}

    def own_get(self, sw: dict, i: int, g: str):
        return ((self._pers(sw["id"]).get("own") or {}).get(g) or {}).get(str(i))

    def camp_for(self, sid: str, i: int):
        a, e = self.wk_start(i), self.wk_end(i)
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
        occ = self.occurrences(i)
        tot = sum(float(o["x"].get("hours") or 0) for o in occ) or 1
        F = {"load": 1, "aer": 1, "ana": 1, "spd": 1}
        found = []
        ws, we = self.wk_start(i), self.wk_end(i)
        for a in items:
            if not a.get("from"):
                continue
            A, Z = _iso(a["from"]), _iso(a.get("to") or a["from"])
            if Z < ws or A > we:
                continue
            miss = sum(float(o["x"].get("hours") or 0) for o in occ if A <= o["d"] <= Z)
            frac = miss / tot
            if frac <= 0:
                continue
            m = {**INJ, **(a.get("mods") or {})} if a.get("type") == "Injury" else {"load": 0, "aer": 0, "ana": 0, "spd": 0}
            for k in F:
                F[k] *= 1 - frac * (1 - m[k])
            found.append({"type": a.get("type"), "frac": frac, "note": a.get("note") or ""})
        return {"F": F, "items": found} if found else None

    def cut_in(self, sw: Optional[dict], i: int):
        """What happened that changes the column's load (the planner's cutIn): cancelled sessions, extra sessions."""
        cancelled, extra = self.actual.get("cancelled") or {}, self.actual.get("extra") or []
        if not cancelled and not extra:
            return None
        occ = self.occurrences(i)
        tot = sum(float(o["x"].get("hours") or 0) for o in occ) or 1
        off = add = 0.0
        items = []
        for o in occ:
            key = (o["d"].isoformat(), o["x"].get("slot"))
            if o["x"].get("slot") and key in cancelled:
                off += float(o["x"].get("hours") or 0)
                items.append({"type": "Cancelled", "label": o["x"].get("label"), "date": key[0], "why": cancelled[key]})
        if sw:
            for x in extra:
                d = _iso(x["date"])
                if self.wk_start(i) <= d <= self.wk_end(i) and str(sw["id"]) in [str(p) for p in x.get("picked") or []]:
                    add += float(x.get("hours") or 0)
                    items.append({"type": "Extra", "date": x["date"]})
        return {"F": max(0.0, 1 - off / tot + add / tot), "items": items} if items else None

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
            cut = self.cut_in(sw, i)
            if cut:
                load = r2(load * cut["F"])
                c = {k: r2(c[k] * cut["F"]) for k in COMPS}
            out.append({"i": i, "week_start": self.wk_start(i).isoformat(), "p": w.get("p"), "phase": ph.get("name"),
                        "objective": ph.get("objective"), "template": ph.get("template"), "course": ph.get("course"),
                        "macro": m, "code": "Off" if m == "–" else f"{m}.{meso}.{micro}", "load": load, "plan_load": w.get("load") or 0,
                        "comps": c, "camp": w.get("camp"), "group": self.group_at(sw, i) if sw else bid,
                        "away": away, "cut": cut, "week_end": self.wk_end(i).isoformat(),
                        "days": (self.wk_end(i) - self.wk_start(i)).days + 1})
        self._tl[bid] = out
        return out

    # ---- one session's focus in a week (the planner's sessT): the block's standard week, the parent group's
    # week while it is on the same block, and any change made for this group or swimmer that week
    def _tpl_target(self, p, sid: str) -> dict:
        ph = (self.p.get("phases") or {}).get(p) or {}
        t = next((x for x in self.p.get("templates") or [] if x.get("name") == ph.get("template")), None) or {}
        f = dict((t.get("f") or {}).get(sid) or {})
        return _norm_t({**f, "n": (t.get("s") or {}).get(sid, "")})

    def _tpl_at(self, p, i: int, key: str) -> dict:
        o = next((o for o in self.occurrences(i) if o["key"] == key), None)
        return self._tpl_target(p, o["tpl"]["id"]) if o and o["tpl"] else _norm_t({})

    def session_target(self, bid: str, i: int, sid: str) -> dict:
        if bid.startswith("sw:"):
            sw = self.swimmers.get(bid[3:])
            g = self.group_at(sw, i)
            own = ((((self._pers(bid[3:]).get("ownSess") or {}).get(g) or {}).get(str(i))) or {}).get(sid)
            if own:
                return {**_norm_t(own), "own": True}
            w = self.timeline(bid)[i]
            if w["camp"]:
                return {"camp": w["camp"], "a": None, "b": None, "c": None, "n": "Camp"}
            return self.session_target(g, i, sid) if self.timeline(g)[i]["p"] == w["p"] else self._tpl_at(w["p"], i, sid)
        b = self.branches.get(bid) or {}
        own = (((b.get("sess") or {}).get(str(i))) or {}).get(sid)
        if own:
            return {**_norm_t(own), "own": True}
        w = self.timeline(bid)[i]
        par = b.get("parent")
        if par and par in self.branches and self.timeline(par)[i]["p"] == w["p"]:
            return self.session_target(par, i, sid)
        return self._tpl_at(w["p"], i, sid)

    def targets(self, template: Optional[str]) -> list:
        """The template's session targets, each focus on the common scale too."""
        t = next((x for x in self.p.get("templates") or [] if x.get("name") == template), None)
        if not t:
            return []
        out = []
        common = self.p.get("line") == "common"
        for s in self.p.get("sessions") or []:
            f = (t.get("f") or {}).get(s["id"]) or {}
            focus = [v for v in (f.get("a"), f.get("b")) if v is not None]
            out.append({"session": s.get("label") or s["id"], "text": (t.get("s") or {}).get(s["id"], ""),
                        "levels": [common_level(v) if common else planner_level(v) for v in focus],
                        "common": [float(v) if common else to_common(v) for v in focus]})
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
    try:                                      # cancelled and extra sessions change the loads (4.5)
        plan = Plan(plan.p, plan.roster, plan_actual(actuals(db, squad, plan.wk_start(i), plan.wk_end(i))))
    except Exception:  # noqa: BLE001 - the plan as planned will do
        pass
    groups = []
    for bid, b in plan.branches.items():
        if not plan.runs_in(bid, i):          # a short-term group outside its weeks
            continue
        w = plan.timeline(bid)[i]
        groups.append({"id": bid, "name": b.get("name"), "parent": b.get("parent"), **w, "targets": plan.targets(w["template"])})
    ids = app_ids(db, plan)
    swimmers = {}
    for sid, sw in plan.swimmers.items():
        w = plan.timeline(f"sw:{sid}")[i]
        swimmers[str(ids.get(sid, f"planner:{sid}"))] = {"name": sw.get("name"), "group": w["group"], "code": w["code"], "load": w["load"],
                                                         "comps": w["comps"], "camp": w["camp"], "away": w["away"]}
    return {"squad": squad, "week": i, "week_start": plan.wk_start(i).isoformat(), "week_end": plan.wk_end(i).isoformat(),
            "micro": plan.micro, "groups": groups, "swimmers": swimmers}


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


def _labeller(db: DBSession, plan: Plan):
    """A focus value as the plan shows it: in its scale, else the club's usual one."""
    try:
        from backend.services import session_builder as B
        from backend.services import session_notation as N
        B.load_scales(db)
        key = plan.p.get("scale") or B.usual_scale(db)

        def label(v):
            z = N.zone_for(v, key)
            return z["label"] if z else (str(int(v)) if v == int(v) else str(v))
        return label
    except Exception:  # noqa: BLE001 - BPSC colours will do
        return common_level


def session_lines(db: DBSession, squad: str, on: date, slot_id: int) -> list:
    """What the plan says for one timetable session: each group's focus, and swimmers with their own."""
    plan = load(db, squad)
    if not plan or not slot_id:
        return []
    i = plan.week_of(on)
    occ = plan.occurrence_on(on, slot_id)
    if not occ:
        return []
    s, key = occ["x"], occ["key"]
    label = _labeller(db, plan)
    names = {pid: (sw.get("name") or "").split(" ")[0] for pid, sw in plan.swimmers.items()}
    try:
        att = Attendance(plan, actuals(db, squad, on - timedelta(days=21), on))
    except Exception:  # noqa: BLE001 - versions are then shown without who is on them
        att = None

    def say(t):
        if t.get("camp"):
            return "camp"
        f = " / ".join(label(v) for v in (t["a"], t["b"], t["c"]) if v is not None) or "no focus set"
        return f + (f" ({t['n']})" if t.get("n") else "")

    out = [f"THE PLAN FOR THIS SESSION ({s.get('label') or 'session'}, focus main / 2nd / 3rd):"]
    for bid in plan.branches:
        if plan.runs_in(bid, i):
            t = plan.session_target(bid, i, key)
            out.append(f"- {plan.branches[bid].get('name')}: {say(t)}")
            for n, v in enumerate(t.get("v") or []):       # versions are part of the plan (4.3)
                who = ""
                if att:
                    on_it = [names[pid] for pid, sw in plan.swimmers.items() if sw.get("branch") in plan.branches
                             and plan.group_at(sw, i) == bid and version_for(plan, att, t, pid, i, occ) == n]
                    who = f" ({', '.join(on_it)})" if on_it else " (nobody this time)"
                lead = version_label(plan, v, names) if v["k"] == "names" else "those who " + version_label(plan, v, names)
                out.append(f"  - version for {lead}: {say(v)}{who}")
    for sid, sw in plan.swimmers.items():
        if not sw.get("branch") or sw.get("branch") not in plan.branches:
            continue
        t = plan.session_target(f"sw:{sid}", i, key)
        if t.get("own"):
            out.append(f"- {sw.get('name')} (own week): {say(t)}")
    return out


def staff_lines(db: DBSession, squad: Optional[str], on: date, slot_id: Optional[int] = None) -> str:
    """The week's plan as the staff read it, and the plan for the session being written."""
    if not squad:                             # a club-wide slot: the club's one plan, if it has one
        squads = {d.squad for d in db.query(models.PlanDoc).filter_by(club=CLUB, key="plan")}
        squad = squads.pop() if len(squads) == 1 else None
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
    if slot_id:
        try:
            lines += session_lines(db, squad, on, slot_id)
        except Exception:  # noqa: BLE001 - the week's lines still go
            pass
    return "\n".join(lines)



# ---------------------------------------------------------------- what actually happened
# (docs/design/season-planner-weeks.md 4.3-4.5): registers, cancelled and extra sessions, usual sessions,
# time away and the Right now notes, for the planner's week view and for working out versions.

def _clock(t) -> Optional[int]:
    try:
        h, m = str(t or "")[:5].split(":")
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def _session_hours(s: models.Session) -> float:
    a, z = _clock(s.start_time), _clock(s.end_time)
    return round((z - a) / 60, 2) if a is not None and z is not None and z > a else 1.5


def _picked(audience) -> list:
    a = audience or {}
    return [int(i) for i in (a.get("swimmer_ids") or []) if str(i).isdigit()] if a.get("kind") == "swimmer" else []


def _metres(s: models.Session) -> Optional[int]:
    if not s.builder:
        return None
    try:
        from backend.services import session_notation as N
        b = copy.deepcopy(s.builder)
        N.normalize_session(b)
        return int(max((t["dist"] for t in N.totals_for(b)), default=0)) or None
    except Exception:  # noqa: BLE001 - the metres are a nicety
        return None


def actuals(db: DBSession, squad: str, date_from: date, date_to: date) -> Optional[dict]:
    """What happened (and is known ahead) between two dates, in the planner's swimmer ids."""
    from sqlalchemy import or_
    from backend.services import usual_sessions
    plan = load(db, squad)
    if not plan:
        return None
    to_pid = {aid: pid for pid, aid in app_ids(db, plan).items()}
    slots = [x.get("slot") for x in plan.p.get("sessions") or [] if x.get("slot")]
    rows = db.query(models.Session).filter(
        models.Session.date >= date_from, models.Session.date <= date_to,
        or_(models.Session.squad == squad, models.Session.pool_slot_id.in_(slots or [-1])),
    ).order_by(models.Session.date).all()
    entries = {}
    if rows:
        for e in db.query(models.SessionEntry).filter(models.SessionEntry.session_id.in_([s.id for s in rows])).all():
            entries.setdefault(e.session_id, []).append(e)
    sessions = []
    for s in rows:
        es = entries.get(s.id, [])
        taken = bool(s.register_saved_at) or any(e.attended is not None for e in es)
        sessions.append({
            "id": s.id, "date": s.date.isoformat(), "slot": s.pool_slot_id, "status": s.status or "completed",
            "reason": s.cancel_reason or "", "extra": bool(s.extra_session),
            "picked": [to_pid[i] for i in _picked(s.audience) if i in to_pid],
            "attended": sorted(to_pid[e.swimmer_id] for e in es if e.attended and e.swimmer_id in to_pid) if taken else None,
            "title": s.title or "", "metres": _metres(s), "notes": (s.coach_notes or "")[:400],
            "hours": _session_hours(s), "start": s.start_time or "",
        })
    ids = list(to_pid)
    usual = {to_pid[sid]: sorted(v) for sid, v in usual_sessions.usual(db, ids).items() if sid in to_pid}
    away = {to_pid[sid]: [[a.isoformat(), b.isoformat()] for a, b in v]
            for sid, v in usual_sessions._away(db, ids, date_from, date_to).items() if sid in to_pid} if ids else {}
    notes = db.query(models.SwimmerCurrentNote).filter(
        models.SwimmerCurrentNote.swimmer_id.in_(ids or [-1]), models.SwimmerCurrentNote.cleared_at.is_(None),
        models.SwimmerCurrentNote.date_from <= date_to).all()
    right_now = [{"swimmer": to_pid[n.swimmer_id], "id": n.id, "kind": n.kind, "title": n.title, "impact": n.impact or "",
                  "from": n.date_from.isoformat(), "until": n.until.isoformat() if n.until else None}
                 for n in notes if not n.until or n.until >= date_from]
    return {"sessions": sessions, "usual": usual, "excused": away, "right_now": right_now}


def plan_actual(data: Optional[dict]) -> dict:
    """actuals() in the form the Plan reads: cancelled sessions and extra ones."""
    data = data or {}
    out = {"cancelled": {}, "extra": []}
    for s in data.get("sessions") or []:
        if s["status"] == "cancelled" and s["slot"]:
            out["cancelled"][(s["date"], s["slot"])] = s["reason"] or "cancelled"
        elif s["extra"] and s["picked"]:
            out["extra"].append({"date": s["date"], "hours": s["hours"], "picked": s["picked"]})
    return out


class Attendance:
    """Did a swimmer come to a session (the register once it's taken), or will they (their usual sessions,
    unless they're away)? The planner's came()."""

    def __init__(self, plan: Plan, data: Optional[dict]):
        data = data or {}
        self.plan = plan
        self.reg, self.cancelled = {}, set()
        for s in data.get("sessions") or []:
            key = (s["date"], s["slot"])
            if s["status"] == "cancelled":
                self.cancelled.add(key)
            elif s["attended"] is not None and not s["extra"]:
                self.reg[key] = set(s["attended"])
        self.usual = {str(k): set(v) for k, v in (data.get("usual") or {}).items()}
        self.excused = {str(k): [(_iso(a), _iso(b)) for a, b in v] for k, v in (data.get("excused") or {}).items()}

    def came(self, pid: str, occ: dict) -> bool:
        key = (occ["d"].isoformat(), occ["x"].get("slot"))
        if key in self.cancelled:
            return False
        if key in self.reg:
            return pid in self.reg[key]
        d = occ["d"]
        if any(a <= d <= b for a, b in self.excused.get(pid, [])):
            return False
        for a in self.plan._pers(pid).get("away") or []:
            if a.get("from") and _iso(a["from"]) <= d <= _iso(a.get("to") or a["from"]):
                return False
        u = self.usual.get(pid)
        return not u or not occ["x"].get("slot") or occ["x"]["slot"] in u


def last_before(plan: Plan, i: int, occ: dict, sid: str) -> Optional[dict]:
    """The last time session sid ran before this one: earlier in the column, or up to 14 days back."""
    for j in range(i, max(-1, i - 4), -1):
        found = [o for o in plan.occurrences(j) if o["x"]["id"] == sid and o["d"] < occ["d"] or
                 (j == i and o["x"]["id"] == sid and o["k"] < occ["k"])]
        found = [o for o in found if (occ["d"] - o["d"]).days <= 14]
        if found:
            return found[-1]
    return None


def version_for(plan: Plan, att: Attendance, target: dict, pid: str, i: int, occ: dict) -> Optional[int]:
    """Which version of a session a swimmer is on (None = the session itself): the first they fit."""
    for n, v in enumerate(target.get("v") or []):
        if v["k"] == "names":
            if pid in v["ids"]:
                return n
            continue
        prev = [last_before(plan, i, occ, s) for s in v["s"]]
        came = [p is not None and att.came(pid, p) for p in prev]
        if not came:
            continue
        if (v["k"] == "did" and all(came)) or (v["k"] == "missed" and not all(came)):
            return n
    return None


def version_label(plan: Plan, v: dict, names: Optional[dict] = None) -> str:
    """Who a version is for, in words: "missed Tue PM", "did Mon PM and Tue PM", "Sam, Ali"."""
    if v["k"] == "names":
        return ", ".join((names or {}).get(x, x) for x in v["ids"]) or "named swimmers"
    labels = {x["id"]: x.get("label") or x["id"] for x in plan.p.get("sessions") or []}
    which = " and ".join(labels.get(s, s) for s in v["s"]) or "an earlier session"
    return ("did " if v["k"] == "did" else "missed ") + which


def session_versions(db: DBSession, squad: Optional[str], on: date, slot_id: Optional[int]) -> list:
    """For the Session Builder: each group's versions of the plan's session on a date and slot, with the
    app swimmers on each. Only groups whose session has versions."""
    if not squad or not slot_id:
        return []
    plan = load(db, squad)
    if not plan:
        return []
    occ = plan.occurrence_on(on, slot_id)
    if not occ:
        return []
    i = plan.week_of(on)
    data = actuals(db, squad, on - timedelta(days=21), on)
    att = Attendance(plan, data)
    ids = app_ids(db, plan)
    names = {pid: (sw.get("name") or "").split(" ")[0] for pid, sw in plan.swimmers.items()}
    label = _labeller(db, plan)
    out = []
    for bid, b in plan.branches.items():
        if not plan.runs_in(bid, i):
            continue
        t = plan.session_target(bid, i, occ["key"])
        if not t.get("v"):
            continue
        members = [pid for pid, sw in plan.swimmers.items()
                   if sw.get("branch") in plan.branches and plan.group_at(sw, i) == bid]
        groups = [{"label": None, "focus": t, "pids": []}] + [{"label": version_label(plan, v, names), "focus": v, "pids": []}
                                                                for v in t["v"]]
        for pid in members:
            n = version_for(plan, att, t, pid, i, occ)
            groups[0 if n is None else n + 1]["pids"].append(pid)

        def say(f):
            return " / ".join(label(x) for x in (f.get("a"), f.get("b"), f.get("c")) if x is not None)
        out.append({"group": b.get("name"), "branch": bid, "versions": [
            {"label": g["label"], "focus": say(g["focus"]), "notes": g["focus"].get("n") or "",
             "swimmer_ids": [ids[p] for p in g["pids"] if p in ids]} for g in groups]})
    return out


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
        if plan.span(bid):                    # a short-term group is put away once its weeks are over
            g.active = not plan.ended(bid, plan.week_of(date.today()))
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
                end = None if z == plan.weeks - 1 else plan.wk_end(z)
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
    if not plan:
        return []
    now = plan.week_of(date.today())
    return [{"id": bid, "name": b.get("name") or bid} for bid, b in plan.branches.items() if not plan.ended(bid, now)]


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
    if group and plan.ended(group, plan.week_of(on or date.today())):
        raise ValueError("That short-term group has finished")
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


# ---------------------------------------------------------------- lining the plan up with the app
# docs/design/season-planner-weeks.md. The app keeps one list of each thing: the
# intensity line, the pool timetable and the meets. When the plan opens, its copy
# is brought into line; the planner keeps only what is about planning.

# The planner's old RPE 1-21 line, carried across to the common line by BPSC colour.
OLD_LINE = [(10, 10), (12, 13.5), (14, 15.5), (16, 17), (18, 18), (20, 19.5), (99, 21)]
DAYS3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _from_old(v):
    if v is None or v == "":
        return v
    v = float(v)
    return next(c for hi, c in OLD_LINE if v <= hi)


def to_common_line(p: dict) -> bool:
    """Move every focus in a plan from the planner's old RPE line onto the common line."""
    if p.get("line") == "common":
        return False

    def cv(o):
        if isinstance(o, dict):
            for k in ("a", "b", "c"):
                if o.get(k) not in (None, ""):
                    o[k] = _from_old(o[k])

    for t in p.get("templates") or []:
        for o in (t.get("f") or {}).values():
            cv(o)
    for b in p.get("branches") or []:
        for wk in (b.get("sess") or {}).values():
            for o in wk.values():
                cv(o)
    for x in (p.get("personal") or {}).values():
        for g in (x.get("ownSess") or {}).values():
            for wk in g.values():
                for o in wk.values():
                    cv(o)
    p.pop("notation", None)
    p["line"] = "common"
    return True


def _mins(hhmm) -> Optional[int]:
    s = str(hhmm or "").strip()
    if len(s) < 4 or ":" not in s[:5]:
        return None
    try:
        h, m = s[:5].split(":")
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def _times(text) -> tuple:
    """A planner time such as 05:30-07:00 (any dash) as its start and end."""
    t = str(text or "")
    for dash in ("—", "–"):
        t = t.replace(dash, "-")
    parts = [x.strip() for x in t.split("-")]
    a = parts[0] if parts and _mins(parts[0]) is not None else None
    b = parts[1] if len(parts) > 1 and _mins(parts[1]) is not None else None
    return a, b


def _half(hhmm) -> Optional[str]:
    m = _mins(hhmm)
    return None if m is None else ("PM" if m >= 12 * 60 else "AM")


def squad_slots(db: DBSession, squad: str) -> list:
    """The squad's timetable: its own slots and every slot with no squad (as the register reads it)."""
    q = db.query(models.PoolSlot).filter(models.PoolSlot.active == True)  # noqa: E712
    return [s for s in q.all() if not s.squad or s.squad == squad]


def _slot_fields(s: models.PoolSlot) -> dict:
    out = {"day": int(s.day_of_week), "time": f"{s.time}–{s.end_time}" if s.end_time else (s.time or "")}
    a, b = _mins(s.time), _mins(s.end_time)
    if a is not None and b is not None and b > a:
        out["hours"] = round((b - a) / 60 * 4) / 4
    if s.course in ("SCM", "LCM"):
        out["pool"] = "50m" if s.course == "LCM" else "25m"
    return out


def align_timetable(db: DBSession, squad: str, p: dict) -> bool:
    """Tie every planner session to a pool slot, and take its day, times and pool from it."""
    slots = {s.id: s for s in squad_slots(db, squad)}
    ses = p.setdefault("sessions", [])
    retired = p.get("sessionsRetired") or []
    changed = False
    for x in list(ses):                       # its slot was deleted or turned off: put it aside
        if x.get("slot") and x["slot"] not in slots:
            ses.remove(x)
            retired.append(x)
            changed = True
    linked = {x.get("slot") for x in ses if x.get("slot")}
    for x in list(retired):                   # and back again if the slot is
        if x.get("slot") in slots and x["slot"] not in linked:
            retired.remove(x)
            ses.append(x)
            linked.add(x["slot"])
            changed = True
    for x in ses:
        if x.get("slot"):
            continue
        a, b = _times(x.get("time"))
        free = [s for s in slots.values() if s.id not in linked and s.day_of_week == int(x.get("day") or 0)
                and (a is None or _half(s.time) == _half(a))]
        free.sort(key=lambda s: abs((_mins(s.time) or 0) - (_mins(a) or 0)))
        if free:
            s = free[0]
        else:                                 # not on the timetable yet: add it there
            s = models.PoolSlot(day_of_week=int(x.get("day") or 0), time=a or "06:00", end_time=b, squad=squad,
                                label=x.get("label") or None, active=True,
                                course={"50m": "LCM", "25m": "SCM"}.get(x.get("pool")))
            db.add(s)
            db.flush()
            slots[s.id] = s
        x["slot"] = s.id
        linked.add(s.id)
        changed = True
    for x in ses:
        f = _slot_fields(slots[x["slot"]])
        if any(x.get(k) != v for k, v in f.items()):
            x.update(f)
            changed = True
    for s in sorted(slots.values(), key=lambda s: (s.day_of_week, _mins(s.time) or 0)):
        if s.id in linked:
            continue
        x = {"id": f"slot{s.id}", "slot": s.id, "label": f"{DAYS3[s.day_of_week % 7]} {_half(s.time) or ''}".strip(),
             "hours": 1.5, "pool": "25m", "mph": 2500, "role": ""}
        x.update(_slot_fields(s))
        ses.append(x)
        changed = True
    order = sorted(ses, key=lambda x: (int(x.get("day") or 0), _mins(_times(x.get("time"))[0]) or 0))
    if order != ses:
        ses[:] = order
        changed = True
    if retired:
        p["sessionsRetired"] = retired
    elif "sessionsRetired" in p:
        p.pop("sessionsRetired")
        changed = True
    return changed


def _norm(n) -> str:
    return " ".join("".join(c if c.isalnum() else " " for c in str(n or "").lower()).split())


GENERIC = {"championships", "championship", "champs", "open", "meet", "gala", "swimming", "swim", "club", "the", "and",
            "round", "league", "level", "long", "short", "course", "weekend", "wkd", "festival", "event", "series",
            "winter", "summer", "spring", "autumn", "county", "regional", "regionals", "national", "nationals"}


def _meet_score(a, b) -> float:
    """How alike two meet names are, 0 to 1. Meets on the same start date match on one distinctive
    shared word (Northampton, Essex, Arena), so "Northampton Winter Festival" is "Northampton Winter Meet"."""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0
    if a == b or a in b or b in a:
        return 1
    ta = {w for w in a.split() if len(w) > 2 and not w.isdigit()}
    tb = {w for w in b.split() if len(w) > 2 and not w.isdigit()}
    if not ta or not tb:
        return 0
    j = len(ta & tb) / len(ta | tb)
    if ta & tb - GENERIC:
        j = max(j, 0.5)
    return j


def _same_meet(a, b) -> bool:
    return _meet_score(a, b) >= 0.5


COURSE_IN = {"SCM": "25m", "LCM": "50m"}
COURSE_OUT = {"25m": "SCM", "50m": "LCM"}


def _meet_fields(m: models.Meet) -> dict:
    out = {"name": m.name, "start": m.date.isoformat(), "end": (m.date_to or m.date).isoformat()}
    if m.course in COURSE_IN:
        out["course"] = COURSE_IN[m.course]
    if m.location:
        out["venue"] = m.location
    return out


def align_meets(db: DBSession, p: dict) -> bool:
    """Tie every planner meet to a meet in the Meets tab, and show every club meet in the season."""
    s = p.get("settings") or {}
    first = _iso(s["start"])
    last = first + timedelta(weeks=int(s.get("weeks") or 50)) - timedelta(days=1)
    meets = {m.id: m for m in db.query(models.Meet).all()}
    cal = p.setdefault("calendar", [])
    changed = False
    for c in list(cal):                       # deleted in the Meets tab
        if c.get("meet") and c["meet"] not in meets:
            cal.remove(c)
            changed = True
    linked = {c["meet"] for c in cal if c.get("meet")}
    for c in cal:
        if c.get("meet"):
            continue
        try:
            d = _iso(c.get("start"))
        except ValueError:
            continue
        same_day = sorted((m for m in meets.values() if m.id not in linked and m.date == d and _same_meet(m.name, c.get("name"))),
                          key=lambda m: -_meet_score(m.name, c.get("name")))
        m = same_day[0] if same_day else None
        if not m:                             # not in the Meets tab yet: add it there
            try:
                end = _iso(c["end"]) if c.get("end") else None
            except ValueError:
                end = None
            m = models.Meet(name=c.get("name") or "Meet", date=d, date_to=end if end and end != d else None,
                            location=c.get("venue") or None, course=COURSE_OUT.get(c.get("course")))
            db.add(m)
            db.flush()
            meets[m.id] = m
        c["meet"] = m.id
        linked.add(m.id)
        changed = True
    for c in cal:
        m = meets.get(c.get("meet"))
        if not m or not m.date:
            continue
        f = _meet_fields(m)
        if any(c.get(k) != v for k, v in f.items()):
            c.update(f)
            changed = True
    used = {c.get("id") for c in cal}
    for m in sorted(meets.values(), key=lambda m: (m.date or first, m.id)):
        if m.id in linked or not m.date or not first <= m.date <= last:
            continue
        cid = f"m{m.id}"
        while cid in used:
            cid += "x"
        c = {"id": cid, "meet": m.id, "short": "", "level": "", "note": "", "prio": {}, "course": ""}
        c.update(_meet_fields(m))
        cal.append(c)
        used.add(cid)
        changed = True
    return changed


def align(db: DBSession, squad: str) -> bool:
    """Bring the saved plan into line with the app before it is opened. True if it changed."""
    d = db.query(models.PlanDoc).filter_by(club=CLUB, squad=squad, key="plan").first()
    if not d or not d.data:
        return False
    p = copy.deepcopy(d.data)
    changed = to_common_line(p)
    changed = align_timetable(db, squad, p) or changed
    changed = align_meets(db, p) or changed
    if changed:
        d.data = p
        d.revision = (d.revision or 0) + 1
    db.commit()
    return changed
