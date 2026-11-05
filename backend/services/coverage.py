"""What has been covered, and what hasn't: worked out in code from the sessions (step 8).

Every session written in (or imported into) the builder is measured: metres in
each training zone, each stroke, and the skills (starts, turns, underwater,
drill, kick, race pace). From that:

- weekly coverage for a squad, and how long since each thing was last done;
- for a swimmer, from the sets they actually swam (the register's group);
- gaps: something that was in most weeks and has stopped, or race-pace work
  missing in the run-in to a meet.

The staff judge these against the plan; the figures themselves are never
estimated by the AI.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import session_notation as N

STROKES = {
    "free": r"\bfree(?:style)?\b|\bf/?c\b|front ?crawl",
    "back": r"\bback(?:stroke)?\b|\bbk\b",
    "breast": r"\bbreast(?:stroke)?\b|\bbr(?:st)?\b|\bbrs?t\b",
    "fly": r"\bfly\b|\bbutterfly\b",
    "IM": r"\bim\b|individual medley|reverse im",
    "main stroke": r"\bno\.? ?1\b|main stroke|choice",
}
SKILLS = {
    "starts": r"\bstarts?\b|\bdive\b|off the blocks|\bblocks\b",
    "turns": r"\bturns?\b",
    "underwater": r"\bu/?w\b|underwater|dolphin kick|streamline|breakout",
    "drill": r"\bdrills?\b|\btech(?:nique)?\b",
    "race pace": r"\bpb ?\+|race pace|\bhvo\b|\brp\b|max(?:imal)? effort|\bsprint",
}
HARD_ZONES = ("race_pace", "lact_tol", "sprint")
CATEGORIES = list(STROKES) + list(SKILLS) + ["kick", "high intensity"]


def _walk(items, k=1, note=""):
    for n in items or []:
        if n.get("t") == "round":
            yield from _walk(n.get("items"), k * (n.get("times") or 0), (n.get("note") or "") + " " + note)
        else:
            yield n, k, note


def line_categories(n: dict, note: str = "") -> set:
    text = f"{n.get('desc') or ''} {note}".lower()
    cats = {c for c, rx in {**STROKES, **SKILLS}.items() if re.search(rx, text)}
    if re.search(r"\bkick", text):
        cats.add("kick")
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", str(n.get("eff") or ""))]
    if nums and max(nums) >= 18.5:          # MVO2 and above on the common scale (Sweetenham LT / LP / Speed)
        cats.add("high intensity")
    if nums and max(nums) >= 19.25:
        cats.add("race pace")
    return cats


def session_coverage(b: dict) -> dict:
    """{group name: Counter(category -> metres)} for one builder session."""
    s = N.normalize_session(json.loads(json.dumps(b)))
    out = {}
    for g in N.session_groups(s):
        c = Counter()
        for blk in s.get("blocks") or []:
            if blk.get("kind") == "notes" or not N.applies_to(blk, g.get("id")):
                continue
            for n, k, note in _walk(blk.get("items")):
                metres = N.node_stats(n)["dist"] * k
                if metres:
                    for cat in line_categories(n, note):
                        c[cat] += metres
        out[g.get("name") or ""] = c
    return out


def _sessions(db: DBSession, squad: Optional[str], since: date, until: date):
    q = db.query(models.Session).filter(models.Session.builder.isnot(None), models.Session.date >= since,
                                        models.Session.date <= until, models.Session.status != "cancelled")
    if squad:
        q = q.filter(models.Session.squad == squad)
    return q.order_by(models.Session.date).all()


def _home(s: models.Session) -> bool:
    return (s.audience or {}).get("kind") not in ("camp", "swimmer")


def weekly(db: DBSession, squad: Optional[str], today: date, weeks: int = 12) -> list:
    """[{week, sessions, metres: {category: metres}}], oldest first. A thing counts for the
    squad when any group swam it (home sessions only: a camp is not what the squad did)."""
    monday = today - timedelta(days=today.weekday())
    start = monday - timedelta(weeks=weeks - 1)
    rows = {start + timedelta(weeks=i): {"sessions": 0, "metres": Counter()} for i in range(weeks)}
    for s in _sessions(db, squad, start, today):
        if not _home(s):
            continue
        wk = s.date - timedelta(days=s.date.weekday())
        cov = session_coverage(s.builder)
        best = Counter()
        for c in cov.values():
            for cat, m in c.items():
                best[cat] = max(best[cat], m)
        rows[wk]["sessions"] += 1
        rows[wk]["metres"].update(best)
    return [{"week": wk.isoformat(), "sessions": r["sessions"], "metres": dict(r["metres"])} for wk, r in sorted(rows.items())]


def last_done(db: DBSession, squad: Optional[str], today: date, lookback_weeks: int = 26) -> dict:
    """{category: date it was last swum by any group}."""
    last = {}
    for s in _sessions(db, squad, today - timedelta(weeks=lookback_weeks), today):
        if not _home(s):
            continue
        for c in session_coverage(s.builder).values():
            for cat, m in c.items():
                if m:
                    last[cat] = s.date
    return last


def swimmer_last_done(db: DBSession, swimmer_id: int, today: date, lookback_weeks: int = 12) -> dict:
    """{category: date} from the sessions a swimmer attended and the group they swam."""
    last = {}
    rows = db.query(models.SessionEntry, models.Session).join(models.Session, models.SessionEntry.session_id == models.Session.id) \
        .filter(models.SessionEntry.swimmer_id == swimmer_id, models.SessionEntry.attended.is_(True),
                models.Session.builder.isnot(None), models.Session.date >= today - timedelta(weeks=lookback_weeks),
                models.Session.date <= today).order_by(models.Session.date).all()
    for entry, s in rows:
        cov = session_coverage(s.builder)
        number = entry.group_done or entry.group_planned
        name = next((g.description for g in s.groups or [] if g.group_number == number), None)
        c = cov.get(name or "") or (next(iter(cov.values())) if len(cov) == 1 else Counter())
        for cat, m in c.items():
            if m:
                last[cat] = s.date
    return last


def gaps(db: DBSession, squad: Optional[str], today: date) -> list:
    """Things that were regular and have stopped, and race-pace missing before a meet."""
    weeks = weekly(db, squad, today, 12)
    recent, before = weeks[-4:], weeks[:-4]
    out = []
    for cat in CATEGORIES:
        had = [w for w in before if w["sessions"] and w["metres"].get(cat)]
        trained = [w for w in before if w["sessions"]]
        now = [w for w in recent if w["metres"].get(cat)]
        if trained and len(had) >= max(2, 0.4 * len(trained)) and not now and any(w["sessions"] for w in recent):
            out.append({"what": cat, "kind": "stopped",
                        "text": f"No {cat} in the last 4 weeks; it was in {len(had)} of the {len(trained)} weeks before."})
    soon = db.query(models.Meet).filter(models.Meet.date >= today, models.Meet.date <= today + timedelta(weeks=4)).order_by(models.Meet.date).all()
    if soon:
        last = last_done(db, squad, today).get("race pace")
        if not last or (today - last).days > 14:
            when = f"since {last:%d %b}" if last else "in the last six months"
            out.append({"what": "race pace", "kind": "before a meet",
                        "text": f"{soon[0].name} is on {soon[0].date:%d %b} and there has been no race-pace work {when}."})
    return out


def brief(db: DBSession, squad: Optional[str], today: date) -> str:
    """The figures as the staff read them."""
    weeks = weekly(db, squad, today, 8)
    lines = ["COVERAGE BY WEEK (metres, any group; home sessions):"]
    for w in weeks:
        if w["sessions"]:
            top = ", ".join(f"{k} {int(v)}" for k, v in sorted(w["metres"].items(), key=lambda x: -x[1])[:8])
            lines.append(f"  week of {w['week']}: {w['sessions']} sessions; {top}")
    last = last_done(db, squad, today)
    if last:
        lines.append("LAST DONE: " + "; ".join(f"{k} {d:%d %b}" for k, d in sorted(last.items(), key=lambda x: x[1])))
    g = gaps(db, squad, today)
    if g:
        lines.append("GAPS FOUND IN CODE:\n" + "\n".join(f"  - {x['text']}" for x in g))
    return "\n".join(lines)
