"""The weekly review (step 8): each worker looks for gaps and links, and the coach
gets one short list on their phone.

Each week the planner, physiologist, analyst and Session Writer read the
coverage figures (worked out in code), the gaps code found, their own watch
list and findings, their open predictions and their track record. They may
update their watch list and findings, add a journal line, and write new
predictions that can be checked. Links between training and racing are
hypotheses for the coach to judge - with about 25 swimmers, never proof.

The coach's list: what changed in the workbooks this week (tick or correct),
the gaps, and predictions with each worker's track record.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services import coverage, predictions as P, workbook_writer as WW, workbooks as W

REVIEWERS = ("planner", "physiologist", "analyst", "sessions")

_SYSTEM = """You are {name}, the {title} on a swimming club's coaching staff. It is your weekly review.
Your remit: {remit}

Read the coverage figures (worked out in code), the gaps found in code, and your own pages. Then:
- GAPS: what hasn't been done but should have been, judged against the plan and the meets coming up.
- LINKS: connections between what was trained, who attended, and how they raced or responded.
  With about 25 swimmers these are hypotheses for the coach, never proof; say how many sightings.
- Keep your watch list (what you are tracking) and findings (what you have found, with confidence and
  the sessions or results behind it) up to date. Change one section at a time.
- PREDICTIONS: write what you expect, so it can be checked. A race time needs the swimmer's id, distance,
  stroke, course (SCM/LCM), target time and the meet id if there is one. Anything else needs a due date.
- Write only in: {writes}. Never a medical diagnosis.

{direction}

Return JSON only:
{{"edits": [{{"kind": "section", "path": "watch-list.md", "title": "Watch list", "heading": "Gaps", "text": "...", "confidence": "hypothesis", "summary": "..."}},
            {{"kind": "journal", "text": "..."}}],
  "predictions": [{{"kind": "race_time", "statement": "Ruby 200 free under 2:10 at County", "swimmer_id": 14, "distance": 200,
                    "stroke": "free", "course": "SCM", "target": "2:10.00", "meet_id": 3}},
                  {{"kind": "other", "statement": "...", "due": "YYYY-MM-DD"}}]}}
At most 3 edits and 2 predictions. Empty lists are fine."""


def active_squads(db: DBSession, today: date) -> list:
    rows = db.query(models.Session.squad).filter(models.Session.builder.isnot(None),
                                                 models.Session.date >= today - timedelta(weeks=4), models.Session.date <= today).all()
    counts = {}
    for (sq,) in rows:
        counts[sq] = counts.get(sq, 0) + 1
    return [sq for sq, n in sorted(counts.items(), key=lambda x: -x[1]) if n >= 3] or [None]


def _results_lines(db: DBSession, today: date) -> str:
    rows = db.query(models.SwimTime, models.Swimmer).join(models.Swimmer, models.SwimTime.swimmer_id == models.Swimmer.id) \
        .filter(models.SwimTime.date >= today - timedelta(weeks=8), models.SwimTime.date <= today).order_by(models.SwimTime.date).all()
    return "\n".join(f"- {t.date:%d %b} {s.name} (id {s.id}) {t.event} {P.fmt(t.time_seconds)}" for t, s in rows[-60:]) or "(no races in the last 8 weeks)"


def _meets_lines(db: DBSession, today: date) -> str:
    rows = db.query(models.Meet).filter(models.Meet.date >= today, models.Meet.date <= today + timedelta(weeks=10)).order_by(models.Meet.date).all()
    return "\n".join(f"- {m.name} (id {m.id}) {m.date:%d %b} {m.course or ''}" for m in rows) or "(none in the next 10 weeks)"


def context(db: DBSession, role: str, today: date) -> str:
    parts = []
    for squad in active_squads(db, today):
        parts.append(f"=== {squad or 'squad'} ===\n" + coverage.brief(db, squad, today))
    parts.append("MEETS COMING UP:\n" + _meets_lines(db, today))
    if role in ("analyst", "planner"):
        parts.append("RACE RESULTS, LAST 8 WEEKS:\n" + _results_lines(db, today))
    for path in ("watch-list.md", "findings.md"):
        text = W.read_page(db, role, path)
        parts.append(f"YOUR {path}:\n" + (W.parse(text)[1].strip()[:2500] if text else "(not started)"))
    rec = P.track_record(db).get(role)
    parts.append("YOUR OPEN PREDICTIONS:\n" + P.open_lines(db, role))
    if rec:
        parts.append(f"YOUR TRACK RECORD: {rec.get('right', 0)} right, {rec.get('wrong', 0)} wrong" +
                     (f" ({rec['rate']}%)" if rec.get("rate") is not None else ""))
    return "\n\n".join(parts)


def run(db: DBSession, today: Optional[date] = None, ask=None) -> dict:
    """Every reviewer's weekly look. `ask(system, user)` can be swapped in tests."""
    today = today or date.today()
    W.ensure_workbooks(db)
    P.check(db, today)
    if ask is None:
        from backend.services.builder_staff import _ask as ask_fn
        ask = lambda system, user: ask_fn(system, user, "weekly_review", max_tokens=1800)  # noqa: E731
    trigger = f"weekly:{today.isoformat()}"
    out = {}
    from backend.services.staff_room import ROSTER
    for role in REVIEWERS:
        w, r = W.worker(role), ROSTER[role]
        system = _SYSTEM.format(name=w.name, title=w.title, remit=r.remit, writes=w.writes,
                                direction=W.job_direction_block(db, role))
        reply = ask(system, context(db, role, today))
        done = WW.apply_edits(db, role, reply.get("edits") or [], trigger=trigger, reason="the weekly review", on=today)
        made = [P.add(db, role, p, trigger=trigger) for p in (reply.get("predictions") or [])[:2] if isinstance(p, dict)]
        done["predictions"] = sum(1 for p in made if p)
        out[role] = done
    return out


def this_week(db: DBSession, today: Optional[date] = None) -> dict:
    """The coach's one short list."""
    today = today or date.today()
    since = datetime.now(timezone.utc) - timedelta(days=7)
    names = {k: v.name for k, v in W.workers().items()}
    revs = db.query(models.PageRevision, models.WorkbookPage).join(models.WorkbookPage, models.PageRevision.page_id == models.WorkbookPage.id) \
        .filter(models.WorkbookPage.club == W.CLUB, models.WorkbookPage.archived.is_(False),
                models.PageRevision.author.notin_([W.COACH, "app"]), models.PageRevision.created_at >= since.replace(tzinfo=None)) \
        .order_by(models.PageRevision.created_at.desc()).all()
    changes, seen = [], set()
    for rev, page in revs:
        if (page.role, page.path) in seen:
            continue
        seen.add((page.role, page.path))
        reviewed = bool(page.last_reviewed and rev.created_at and page.last_reviewed >= rev.created_at.date())
        changes.append({"role": page.role, "name": names.get(page.role, page.role), "path": page.path, "title": page.title,
                        "summary": page.summary, "confidence": page.confidence, "reason": rev.reason, "version": page.version,
                        "reviewed": reviewed})
    squads = active_squads(db, today)
    gap_list = [dict(g, squad=sq) for sq in squads for g in coverage.gaps(db, sq, today)]
    preds = db.query(models.Prediction).order_by(models.Prediction.created_at.desc()).limit(40).all()
    return {"changes": changes, "gaps": gap_list,
            "predictions": [P.out(p, names) for p in preds if p.outcome is None or (p.checked_at and p.checked_at.replace(tzinfo=None) >= since.replace(tzinfo=None))],
            "track_record": {names.get(k, k): v for k, v in P.track_record(db).items()}}


def tick(db: DBSession, role: str, path: str, today: Optional[date] = None) -> None:
    """The coach has read a changed page and it's right: it's marked reviewed today."""
    p = W.get_page(db, role, path)
    if not p:
        raise W.WorkbookError("No such page")
    meta, body = W.parse(p.content)
    meta["last_reviewed"] = (today or date.today()).isoformat()
    meta.setdefault("title", p.title)
    W._revise(db, p, W.render(meta, body), W.COACH, "reviewed", None)
    db.commit()
