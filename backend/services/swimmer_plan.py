"""An individual athlete plan: what we are working towards, what we are working
on, and how we plan to do it.

The coach owns the document. Each section belongs to one member of staff, who
drafts it from facts gathered here in code - the swimmer's targets, galas,
race analysis, training figures, the season's structure. The drafter may only
use those facts; anything missing is marked [to add: ...] for the coach rather
than invented. The coach then edits, switches sections off, asks for a redraft,
and marks the plan final. A final plan is kept exactly as it was.

Two readers are catered for: performance staff (for example British Swimming,
tracking a para athlete's programme) and the swimmer themselves.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.claude_service import MODEL, get_client, response_text

AUDIENCES = {
    "performance": (
        "performance staff at the national governing body (for example British Swimming), who "
        "track this athlete's programme. They are expert readers: be clear, specific and "
        "professional, use correct training terms, give dates and figures, and avoid hype"
    ),
    "swimmer": (
        "the swimmer themselves (and their parents if they are young). Use plain, encouraging "
        "language a teenager would follow, explain any training term in a few words, keep it "
        "positive but honest"
    ),
}


@dataclass(frozen=True)
class SectionSpec:
    key: str
    title: str
    role: str          # which member of staff drafts it; "coach" means left for the coach
    brief: str         # what the section should say
    words: int
    facts: Optional[Callable] = None


# ---------------------------------------------------------------------------
# Facts, worked out in code
# ---------------------------------------------------------------------------

def _fmt_time(seconds: Optional[float]) -> str:
    if seconds is None:
        return "?"
    minutes, secs = divmod(float(seconds), 60)
    return f"{int(minutes)}:{secs:05.2f}" if minutes else f"{secs:.2f}"


def _season_macros(db: DBSession, start: date, end: date, squad: Optional[str] = None) -> list:
    """Macrocycles in the period - the swimmer's squad's own, plus any not tied to a squad."""
    rows = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_to >= start, models.TrainingMacro.date_from <= end,
    ).order_by(models.TrainingMacro.date_from).all()
    if squad:
        rows = [m for m in rows if not m.squad or m.squad == squad]
    return rows


def default_period(db: DBSession, today: Optional[date] = None) -> tuple:
    """The current season if there is one, else the macrocycles around today,
    else the next twelve months."""
    today = today or date.today()
    season = db.query(models.Season).filter(models.Season.is_current.is_(True)).order_by(
        models.Season.date_from.desc()).first()
    if season and season.date_to >= today:
        return max(season.date_from, today - timedelta(days=today.weekday())), season.date_to
    macros = db.query(models.TrainingMacro).filter(models.TrainingMacro.date_to >= today).order_by(
        models.TrainingMacro.date_from).all()
    if macros:
        return today - timedelta(days=today.weekday()), max(m.date_to for m in macros)
    return today - timedelta(days=today.weekday()), today + timedelta(days=365)


def _group_of(swimmer, macros: list) -> Optional[tuple]:
    for macro in macros:
        for name, defn in (macro.group_definitions or {}).items():
            if isinstance(defn, dict) and swimmer.id in (defn.get("swimmer_ids") or []):
                return macro, name, defn.get("description") or ""
    return None


def _athlete_lines(db: DBSession, swimmer) -> list:
    lines = [f"Name: {swimmer.name}"]
    if swimmer.dob:
        year = models.get_school_year(swimmer.dob)
        lines.append(f"Age at 31 Dec: {models.get_age_at_dec31(swimmer.dob)}"
                     + (f", school {'post school' if year and year > 13 else f'Year {year}'}" if year else ""))
    if swimmer.gender:
        lines.append(f"Gender: {swimmer.gender}")
    if swimmer.squad:
        lines.append(f"Squad: {swimmer.squad}")
    if swimmer.para_class:
        lines.append(f"Para sport classes: {swimmer.para_class}"
                     + (f" ({swimmer.para_class_status})" if swimmer.para_class_status else ""))
    if swimmer.considerations:
        lines.append(f"Coach's considerations: {swimmer.considerations}")
    events = [e.get("event") if isinstance(e, dict) else str(e) for e in swimmer.target_events or []]
    if events:
        lines.append("Main events: " + ", ".join(e for e in events if e))
    for label, value in (("Strengths", swimmer.strengths), ("Areas to develop", swimmer.weaknesses),
                         ("Coach's profile notes", swimmer.profile_notes)):
        if value:
            lines.append(f"{label}: {value[:600]}")
    if swimmer.status and swimmer.status != "active":
        lines.append(f"Current status: {swimmer.status}")
    return lines


def facts_athlete(db, swimmer, start, end) -> str:
    from backend.services import claude_service as cs
    lines = _athlete_lines(db, swimmer)
    group = _group_of(swimmer, _season_macros(db, start, end, swimmer.squad))
    if group:
        lines.append(f"Training group: {group[1]}" + (f" ({group[2]})" if group[2] else ""))
    slots = db.query(models.PoolSlot).join(models.SwimmerSlot).filter(
        models.SwimmerSlot.swimmer_id == swimmer.id).all()
    if slots:
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        lines.append(f"Timetabled sessions: {len(slots)} a week (" + ", ".join(
            f"{days[s.day_of_week]} {s.time}" for s in sorted(slots, key=lambda s: (s.day_of_week, s.time))) + ")")
    try:
        stats = cs.build_attendance_stats(swimmer.id, db) or {}
    except Exception:
        stats = {}
    if stats.get("overall_pct") is not None:
        lines.append(f"Attendance: {stats['overall_pct']}% overall"
                     + (f", {stats['four_week_pct']}% in the last four weeks" if stats.get("four_week_pct") is not None else ""))
    away = db.query(models.SwimmerException).filter(
        models.SwimmerException.swimmer_id == swimmer.id,
        models.SwimmerException.date_to >= start, models.SwimmerException.date_from <= end).all()
    if away:
        lines.append("Known time away: " + "; ".join(
            f"{e.reason} {e.date_from} to {e.date_to}" + (f" ({e.notes})" if e.notes else "") for e in away))
    return "\n".join(lines)


def facts_towards(db, swimmer, start, end) -> str:
    lines = []
    targets = db.query(models.SwimmerTarget).filter(
        models.SwimmerTarget.swimmer_id == swimmer.id, models.SwimmerTarget.achieved.is_(False)).all()
    if targets:
        lines.append("Targets set:")
        for t in targets:
            lines.append(f"  {t.label}" + (f": {_fmt_time(t.target_time_seconds)}" if t.target_time_seconds else "")
                         + (f" by {t.deadline}" if t.deadline else "") + (f" - {t.description[:160]}" if t.description else ""))
    meet_targets = db.query(models.MeetTarget).join(models.Meet).filter(
        models.MeetTarget.swimmer_id == swimmer.id, models.Meet.date >= start, models.Meet.date <= end,
    ).order_by(models.Meet.date).all()
    if meet_targets:
        lines.append("Target competitions:")
        for t in meet_targets:
            times = ", ".join(f"{k} {v}" for k, v in (t.target_times or {}).items())
            lines.append(f"  {t.meet.date} {t.meet.name}" + (f" (priority {t.priority})" if t.priority else "")
                         + (f": {', '.join(t.events or [])}" if t.events else "") + (f" | target times {times}" if times else ""))
    for m in swimmer.pathway_memberships:
        if m.active and m.pathway:
            p = m.pathway
            lines.append(f"Pathway: {p.name}" + (f", aiming at {p.primary_meet.name}" if p.primary_meet else "")
                         + (f", else {p.fallback_meet.name}" if p.fallback_meet else ""))
    events = [e.get("event") if isinstance(e, dict) else str(e) for e in swimmer.target_events or []]
    bests = []
    for name in [e for e in events if e][:6]:
        best = db.query(models.SwimTime).filter(
            models.SwimTime.swimmer_id == swimmer.id, models.SwimTime.event.ilike(f"{name}%"),
        ).order_by(models.SwimTime.time_seconds).first()
        if best:
            bests.append(f"  {best.event}: PB {_fmt_time(best.time_seconds)} ({best.date}, {best.meet or 'meet unknown'})")
    if bests:
        lines.append("Personal bests in main events:")
        lines += bests
    return "\n".join(lines) or "No targets, target competitions or best times on file."


def facts_race(db, swimmer, start, end) -> str:
    from backend.services import lanewatch
    lines = []
    races = db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == swimmer.id).order_by(
        models.SwimTime.date.desc()).limit(10).all()
    if races:
        lines.append("Recent races (newest first):")
        for r in races:
            splits = ", ".join(f"{s:.2f}" for s in (r.splits or []) if isinstance(s, (int, float)))
            lines.append(f"  {r.date} {r.event} {_fmt_time(r.time_seconds)}" + (f" ({r.round})" if r.round else "")
                         + (f" | splits {splits}" if splits else ""))
    try:
        analysis = lanewatch.analyst_lines(db, swimmer)
    except Exception:
        analysis = ""
    if analysis:
        lines.append(analysis)
    obs = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.swimmer_id == swimmer.id, models.SwimmerObservation.obs_type == "race",
    ).order_by(models.SwimmerObservation.date.desc()).limit(5).all()
    if obs:
        lines.append("Coach's race observations:")
        lines += [f"  {o.date} {o.event or ''}: {o.content[:240]}" for o in obs]
    if swimmer.strengths or swimmer.weaknesses:
        lines.append(f"Strengths: {swimmer.strengths or '-'} | Areas to develop: {swimmer.weaknesses or '-'}")
    return "\n".join(lines) or "No races or race analysis on file."


def facts_training(db, swimmer, start, end) -> str:
    from backend.services import training_load
    lines = []
    if swimmer.considerations:
        lines.append(f"Coach's considerations: {swimmer.considerations}")
    if swimmer.para_class:
        lines.append(f"Para sport classes: {swimmer.para_class}")
    try:
        profile = training_load.load_profiles(db, [swimmer], weeks=8)[0]
        lines.append(training_load.describe(profile, notes=8))
    except Exception:
        pass
    events = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.swimmer_id == swimmer.id,
        models.SwimmerLoadEvent.date_from >= start - timedelta(days=120)).all()
    if events:
        lines.append("Illness, injury and other load events: " + "; ".join(
            f"{e.event_type} from {e.date_from}" + (" (ongoing)" if not e.resolved else "")
            + (f": {e.description[:100]}" if e.description else "") for e in events))
    for label, value in (("Physical profile", swimmer.physical_profile),
                         ("Psychological profile", swimmer.psychological_profile)):
        if value:
            lines.append(f"{label}: {json.dumps(value, default=str)[:700]}")
    return "\n".join(lines) or "No training records on file."


def facts_how(db, swimmer, start, end) -> str:
    lines = []
    macros = _season_macros(db, start, end, swimmer.squad)
    group = _group_of(swimmer, macros)
    group_name = group[1] if group else None
    if group_name:
        lines.append(f"The swimmer trains in {group_name}.")
    for macro in macros:
        lines.append(f"Macrocycle {macro.name}: {macro.date_from} to {macro.date_to}"
                     + (f", building to {macro.primary_meet.name}" if macro.primary_meet else "")
                     + (f". Intent: {macro.narrative[:300]}" if macro.narrative else ""))
        for block in sorted(macro.mesos, key=lambda b: b.date_from):
            intent = (block.group_intents or {}).get(group_name) if group_name else None
            lines.append(f"  Block {block.name} ({block.phase_type or 'no phase'}): {block.date_from} to {block.date_to}"
                         + (f" | emphasis {json.dumps(block.emphasis)[:160]}" if block.emphasis else "")
                         + (f" | for {group_name}: {intent}" if intent else ""))
        points = [p for p in macro.load_points if p.pathway_id is None and p.overall is not None]
        if points:
            points.sort(key=lambda p: p.week_start)
            peak = max(points, key=lambda p: p.overall)
            lines.append(f"  Planned weekly load (0-100) runs from {points[0].overall} to {points[-1].overall}, "
                         f"peaking at {peak.overall} in the week of {peak.week_start}"
                         + ("; lighter weeks: " + ", ".join(str(p.week_start) for p in points if p.note and "rest" in p.note.lower())
                            if any(p.note and "rest" in p.note.lower() for p in points) else ""))
    macro_ids = [m.id for m in macros]
    micro = db.query(models.Microcycle).filter(
        models.Microcycle.macro_id.in_(macro_ids),
        models.Microcycle.week_start <= date.today() + timedelta(days=7),
    ).order_by(models.Microcycle.week_start.desc()).first() if macro_ids else None
    if micro and micro.sessions:
        lines.append(f"A typical week ({micro.label}): " + "; ".join(
            f"{s.get('day', '')} {s.get('session_type', '')} - {s.get('key_emphasis', '')}"
            for s in micro.sessions if isinstance(s, dict))[:900])
    return "\n".join(lines) or "No season structure planned yet."


def facts_competitions(db, swimmer, start, end) -> str:
    meets = db.query(models.Meet).filter(models.Meet.date >= start, models.Meet.date <= end).order_by(models.Meet.date).all()
    if not meets:
        return "No competitions in the calendar for this period."
    entries = {}
    for e in db.query(models.MeetEntry).filter(models.MeetEntry.swimmer_id == swimmer.id).all():
        entries.setdefault(e.meet_id, []).append(e.event_name)
    targets = {t.meet_id: t for t in db.query(models.MeetTarget).filter(models.MeetTarget.swimmer_id == swimmer.id).all()}
    pathway_meets = {}
    for m in swimmer.pathway_memberships:
        if m.active and m.pathway:
            if m.pathway.primary_meet_id:
                pathway_meets[m.pathway.primary_meet_id] = f"target of the {m.pathway.name} pathway"
            if m.pathway.fallback_meet_id:
                pathway_meets.setdefault(m.pathway.fallback_meet_id, f"fallback in the {m.pathway.name} pathway")
    lines = []
    for meet in meets:
        target = targets.get(meet.id)
        state = []
        if entries.get(meet.id):
            state.append("entered: " + ", ".join(entries[meet.id]))
        elif target and target.events:
            state.append("planned events: " + ", ".join(target.events))
        if target and target.priority:
            state.append(f"priority {target.priority}")
        if meet.id in pathway_meets:
            state.append(pathway_meets[meet.id])
        if not state:
            continue
        lines.append(f"{meet.date} {meet.name}" + (f" ({meet.level})" if meet.level else "")
                     + (f" [{meet.course}]" if meet.course else "") + ": " + "; ".join(state))
    return "\n".join(lines) or "No competitions assigned to this swimmer in this period."


def facts_review(db, swimmer, start, end) -> str:
    lines = []
    for macro in _season_macros(db, start, end, swimmer.squad):
        for block in sorted(macro.mesos, key=lambda b: b.date_from):
            lines.append(f"End of block {block.name}: {block.date_to}")
    for t in db.query(models.MeetTarget).join(models.Meet).filter(
            models.MeetTarget.swimmer_id == swimmer.id, models.Meet.date >= start, models.Meet.date <= end).all():
        lines.append(f"After {t.meet.name}: {t.meet.date_to or t.meet.date}")
    return "\n".join(sorted(lines, key=lambda l: l.rsplit(": ", 1)[-1])) or "No block ends or competitions to review against yet."


SECTIONS = [
    SectionSpec("athlete", "About the athlete", "manager",
                "A short introduction: who the swimmer is, their events, classification if a para swimmer, "
                "their training group and commitment, and anything the reader should keep in mind.",
                130, facts_athlete),
    SectionSpec("towards", "What we're working towards", "analyst",
                "The goals for this period: the target competitions, the target times or placings, and how "
                "they compare with current bests.",
                170, facts_towards),
    SectionSpec("race_focus", "What we're working on: racing and skills", "analyst",
                "The two or three race areas being worked on (for example starts, underwater, turns, pacing, "
                "the back end of races), each with the evidence behind it.",
                170, facts_race),
    SectionSpec("training_focus", "What we're working on: training and physical", "physiologist",
                "The physical priorities (aerobic base, speed, strength, recovery) and why, from what training "
                "has actually given them, including any considerations to manage.",
                170, facts_training),
    SectionSpec("how", "How we plan to do it", "planner",
                "How the period is structured: the macrocycles and blocks with their dates and purpose, how "
                "load builds and where lighter weeks sit, and what a typical training week looks like.",
                220, facts_how),
    SectionSpec("competitions", "Competition plan", "meets",
                "The competitions in this period in date order, each with its purpose (target, stepping stone, "
                "experience) and events. One line per competition.",
                170, facts_competitions),
    SectionSpec("review", "Reviewing progress", "planner",
                "When and how progress will be reviewed: the check points (block ends, key competitions) and "
                "what will be looked at.",
                110, facts_review),
    SectionSpec("coach_note", "Coach's note", "coach",
                "The coach's own words.", 0, None),
]
SPECS = {s.key: s for s in SECTIONS}


# ---------------------------------------------------------------------------
# Drafting
# ---------------------------------------------------------------------------

_SYSTEM = """You are the {title} on a swimming coaching staff. The head coach is writing an
individual athlete plan and has asked you to draft one section of it.

Section: {section}
What it should cover: {brief}
Reader: {audience}.

Rules:
- Write in the coach's voice ("we", "our programme"), about the swimmer by first name.
- Use ONLY the facts given. Never invent times, dates, competitions, figures or medical detail.
- If something the section needs is missing, write [to add: what is missing] so the coach can fill it in.
- When the facts are thin, keep it short: one sentence and the [to add: ...] items. Do not pad,
  apologise, or explain what will happen once the information arrives.
- Mention para classification only if the facts give sport classes.
- Write dates as "12 October 2026", never 2026-10-12.
- Start straight with the content: do not repeat the section title. No headings, no bold.
- Plain paragraphs or short bullet points ("- ").
- At most {words} words. British English."""


def _draft(spec: SectionSpec, facts: str, audience: str, swimmer_name: str,
           instruction: Optional[str] = None, previous: Optional[str] = None) -> str:
    from backend.services.staff_room import ROSTER
    title = ROSTER[spec.role].title if spec.role in ROSTER else "assistant coach"
    system = _SYSTEM.format(title=title, section=spec.title, brief=spec.brief,
                            audience=AUDIENCES.get(audience, AUDIENCES["performance"]), words=spec.words)
    user = f"SWIMMER: {swimmer_name}\n\nFACTS:\n{facts}"
    if previous:
        user += f"\n\nTHE CURRENT DRAFT OF THIS SECTION:\n{previous}"
    if instruction:
        user += f"\n\nTHE COACH ASKS: {instruction}"
    user += "\n\nWrite the section now."
    try:
        response = get_client().messages.create(
            model=MODEL, max_tokens=900, system=system,
            messages=[{"role": "user", "content": user}], operation=f"swimmer_plan_{spec.key}",
        )
    except Exception as exc:
        return f"[to add: this section could not be drafted just now ({exc.__class__.__name__}). Write it or redraft.]"
    return _tidy(response_text(response) or "", spec.title)


def _tidy(text: str, title: str) -> str:
    """Drop a repeated section title and markdown emphasis the reader would see raw."""
    lines = text.strip().splitlines()
    while lines and lines[0].strip().strip("#*: ").lower() == title.lower():
        lines = lines[1:]
    return "\n".join(lines).replace("**", "").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _section(spec: SectionSpec, content: str = "") -> dict:
    return {"key": spec.key, "title": spec.title, "role": spec.role, "content": content,
            "included": True, "edited": False, "drafted_at": _now() if content else None}


def create_plan(db: DBSession, swimmer, audience: str = "performance", period_from: Optional[date] = None,
                period_to: Optional[date] = None, title: Optional[str] = None, draft: bool = True):
    audience = audience if audience in AUDIENCES else "performance"
    start, end = default_period(db)
    start, end = period_from or start, period_to or end
    plan = models.SwimmerPlan(
        swimmer_id=swimmer.id, audience=audience, period_from=start, period_to=end,
        title=title or f"{swimmer.name}: athlete plan {start:%b %Y} to {end:%b %Y}",
        sections=[_section(spec) for spec in SECTIONS], status="draft",
    )
    db.add(plan)
    db.flush()
    if draft:
        draft_all(db, plan)
    db.commit()
    return plan


def draft_all(db: DBSession, plan) -> None:
    """Every staff section at once. Facts are gathered here (one DB session);
    only the model calls run in parallel."""
    swimmer = plan.swimmer
    jobs = []
    for spec in SECTIONS:
        if spec.facts is None:
            continue
        try:
            facts = spec.facts(db, swimmer, plan.period_from, plan.period_to)
        except Exception as exc:
            facts = f"(facts could not be gathered: {exc.__class__.__name__})"
        jobs.append((spec, facts))
    with ThreadPoolExecutor(max_workers=len(jobs) or 1) as pool:
        drafted = list(pool.map(lambda job: _draft(job[0], job[1], plan.audience, swimmer.name), jobs))
    by_key = {spec.key: text for (spec, _), text in zip(jobs, drafted)}
    sections = []
    for section in plan.sections or []:
        section = dict(section)
        if section["key"] in by_key and not section.get("edited"):
            section["content"] = by_key[section["key"]]
            section["drafted_at"] = _now()
        sections.append(section)
    plan.sections = sections


def redraft_section(db: DBSession, plan, key: str, instruction: Optional[str] = None) -> dict:
    spec = SPECS.get(key)
    if not spec or spec.facts is None:
        raise ValueError("That section is yours to write.")
    current = next((s for s in plan.sections or [] if s.get("key") == key), None)
    facts = spec.facts(db, plan.swimmer, plan.period_from, plan.period_to)
    text = _draft(spec, facts, plan.audience, plan.swimmer.name, instruction=(instruction or "").strip() or None,
                  previous=current.get("content") if current and instruction else None)
    sections = []
    for section in plan.sections or []:
        section = dict(section)
        if section.get("key") == key:
            section.update(content=text, edited=False, drafted_at=_now())
        sections.append(section)
    plan.sections = sections
    db.commit()
    return next(s for s in sections if s["key"] == key)


def update_sections(plan, changes: list) -> None:
    """The coach's edits: wording, titles, and which sections are included."""
    by_key = {c.get("key"): c for c in changes if isinstance(c, dict)}
    sections = []
    for section in plan.sections or []:
        section = dict(section)
        change = by_key.get(section.get("key"))
        if change:
            if "content" in change and change["content"] != section.get("content"):
                section["content"] = str(change["content"] or "")[:8000]
                section["edited"] = True
            if "title" in change and change["title"]:
                section["title"] = str(change["title"])[:120]
            if "included" in change:
                section["included"] = bool(change["included"])
        sections.append(section)
    plan.sections = sections


def plan_out(plan) -> dict:
    from backend.services.staff_room import ROSTER
    return {
        "id": plan.id,
        "swimmer_id": plan.swimmer_id,
        "swimmer_name": plan.swimmer.name if plan.swimmer else None,
        "title": plan.title,
        "audience": plan.audience,
        "period_from": plan.period_from.isoformat() if plan.period_from else None,
        "period_to": plan.period_to.isoformat() if plan.period_to else None,
        "status": plan.status,
        "finalised_at": plan.finalised_at.isoformat() if plan.finalised_at else None,
        "created_at": plan.created_at.isoformat() if plan.created_at else None,
        "updated_at": plan.updated_at.isoformat() if plan.updated_at else None,
        "sections": [
            {**s, "drafted_by": ROSTER[s["role"]].title if s.get("role") in ROSTER else "You"}
            for s in plan.sections or []
        ],
    }
