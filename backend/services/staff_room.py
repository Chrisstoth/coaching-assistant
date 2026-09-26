"""The coaching staff: specialists who speak up when they have something to say.

The head coach runs the squad. Behind them sits a small staff, each with one
lens on the same swimmers:

    Physiologist           adaptation, load tolerance, recovery, maturation
    Performance Analyst    times, trends, qualification gaps, realistic targets
    Periodisation Planner  block sequencing, where peaks land, plan coherence
    Swimmer Manager        attendance, availability, age and school stage, welfare
    Meet Manager           the competition calendar, entries, timetables, results
    Session Writer         turning the week's plan into the actual session

Each of them can also propose a change in their own area - log an illness, add
a meet, record results - which waits for the coach to approve it (see
staff_actions). Approving one hands the consequence to the colleague it
matters to: results go to the analyst, an injury to the physiologist.

A meeting works like a start-up standup rather than a committee. A cheap chair
call reads what just happened and picks who, if anyone, has something worth
raising - usually one or two people, often nobody. Those specialists look at
their own slice of the real data and either say something specific or stay
quiet. One of them may pull a colleague in ("physiologist, what do you think?").

Everything here runs on the fast model by default, and the number of calls per
meeting is bounded, so asking the staff costs a few pennies rather than pounds.

The same meeting is callable from anywhere - the planning workspace, a swimmer
page, a session review - by describing the topic and what it concerns.
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.claude_service import FAST_MODEL, get_client, response_text

STAFF_MODEL = os.getenv("STAFF_MODEL", FAST_MODEL)
CONTEXT_LIMIT = 6000          # characters of role-specific data per specialist
MAX_SPEAKERS = 2              # chosen by the chair per meeting
MAX_SWIMMERS_IN_DEPTH = 3     # swimmers whose full history a specialist reads


@dataclass(frozen=True)
class StaffRole:
    key: str
    title: str
    remit: str
    watch_for: str
    aliases: tuple


ROSTER = {
    "physiologist": StaffRole(
        key="physiologist",
        title="Physiologist",
        remit="What each swimmer's body is actually getting from training and how it is coping: "
              "the balance of aerobic, threshold, high-intensity and speed work from the sessions "
              "they attended (not the ones planned), high-intensity and neural load over time, "
              "fatigue and recovery, growth and maturation, illness and injury. Fatigue evidence "
              "comes from the coach's session notes and the training figures.",
        watch_for="a swimmer getting much less aerobic or speed work than their group, too long "
                  "since their last speed work, high-intensity work well above their usual week, "
                  "hard days stacked without recovery, fatigue in the coach's notes, week-on-week "
                  "load jumps beyond roughly 10-15%, a growth spurt or returning injury that changes "
                  "what a swimmer can absorb. When the analyst reports a racing pattern, explain "
                  "the likely physical cause from the training figures.",
        aliases=("physiologist", "physio", "physiology", "sports scientist"),
    ),
    "analyst": StaffRole(
        key="analyst",
        title="Performance Analyst",
        remit="Where races are won and lost: times, splits and pacing, and where LaneWatch race "
              "analysis exists, reaction time, 15m time, underwater speed and breakout, stroke "
              "rate against speed through the race - compared with the swimmer's own history. "
              "Also personal bests, qualification gaps and which targets are realistic.",
        watch_for="a swimmer who fades at the back end whatever their first split, or starts slow "
                  "and finishes strong, a 15m time slow for their overall time, underwater slower "
                  "than their swimming speed, stroke rate dropping away late in a race, a target "
                  "the evidence does not support, events where the evidence is thin. Say what "
                  "happens in the race; ask the physiologist why when the cause may be physical.",
        aliases=("analyst", "performance analyst", "analysis", "stats"),
    ),
    "planner": StaffRole(
        key="planner",
        title="Periodisation Planner",
        remit="Turning swimmers' needs into the plan: macro, meso and weekly structure, "
              "progressive overload week on week and session on session, where lighter "
              "adaptation weeks go, and where the peaks land relative to the meets that matter. "
              "Takes the physiologist's and analyst's findings and says how the plan should change.",
        watch_for="load that does not build week on week in a building phase, too many hard weeks "
                  "without a lighter adaptation week, a peak that misses the priority meet, a "
                  "development need (an aerobic base, speed) the plan leaves no room for, planned "
                  "load that attendance means will not happen, no recovery after a competition.",
        aliases=("planner", "periodisation", "periodization", "season planner"),
    ),
    "manager": StaffRole(
        key="manager",
        title="Swimmer Manager",
        remit="The swimmer as a person on a pathway: attendance and availability, age and "
              "school stage, physical development, status (injured, sabbatical), whether "
              "their pathway still fits them.",
        watch_for="attendance that makes the planned load unrealistic, exam years (Year 11 and "
                  "Year 13) and other life load, a swimmer much younger or less developed than "
                  "the group being planned for, a status the plan has not accounted for.",
        aliases=("swimmer manager", "welfare", "attendance"),
    ),
    "meets": StaffRole(
        key="meets",
        title="Meet Manager",
        remit="The competition calendar and each meet's logistics: which meets are on, their "
              "timetables, who is entered in what, and getting results recorded afterwards. "
              "A result can be recorded whether or not the swimmer was entered - never hold a "
              "result back for a missing entry.",
        watch_for="a meet coming up with nobody entered, a meet with no timetable, a meet that has "
                  "finished with no results recorded, a swimmer entered in two races too close "
                  "together, entries that do not match a swimmer's pathway or target events.",
        aliases=("meet manager", "meets manager", "competition manager", "entries manager"),
    ),
    "sessions": StaffRole(
        key="sessions",
        title="Session Writer",
        remit="Turning the week's plan into the actual session: sets, groups and target times "
              "that fit this week's focus, who is likely to be there, what the physiologist says "
              "each swimmer needs and the analyst's race targets.",
        watch_for="a session that does not match the week's plan or focus, work that does not suit "
                  "the swimmers likely to be there, the same group given hard sessions back to back, "
                  "race-pace work with no target times, a session too long for the pool time.",
        aliases=("session writer", "session planner", "sessions writer"),
    ),
}

# Who each specialist usually turns to. Suggested, not enforced.
USUAL_COLLEAGUES = {
    "physiologist": ("manager", "planner"),
    "analyst": ("meets", "planner"),
    "planner": ("physiologist", "meets"),
    "manager": ("physiologist", "meets"),
    "meets": ("analyst", "manager"),
    "sessions": ("planner", "physiologist"),
}

ROLE_ORDER = ["physiologist", "analyst", "planner", "manager", "meets", "sessions"]

# Meetings about a draft the Session Writer produced: it does not review itself.
SELF_AUTHORED = {"session_draft": "sessions"}


def _budget(role: str) -> int:
    """Room to answer. A pasted results sheet or a squad's entries runs long; a
    reply cut off mid-list would be lost, so the meet manager gets more."""
    return 2400 if role == "meets" else 800


# Meetings whose topic is the coach's own words.
COACH_TRIGGERS = ("coach_message", "coach_question", "swimmer_review")


def staff_room_enabled() -> bool:
    return os.getenv("STAFF_ROOM", "on").strip().lower() not in ("off", "0", "false")


# ---------------------------------------------------------------------------
# What a meeting is about
# ---------------------------------------------------------------------------

@dataclass
class Subject:
    swimmer_ids: list = field(default_factory=list)
    macro_id: Optional[int] = None
    block_id: Optional[int] = None
    week_start: Optional[date] = None
    session_id: Optional[int] = None
    meet_id: Optional[int] = None
    # A session being written: its date and squad, and who is expected there.
    session_date: Optional[date] = None
    squad: Optional[str] = None
    attendee_ids: list = field(default_factory=list)


def find_mentioned_swimmers(text: str, db: DBSession) -> list:
    """Swimmers named in free text.

    A full name always counts. A first name on its own only counts when exactly
    one active swimmer has it - two Jamies in the squad means "Jamie" is
    ambiguous, and guessing would put the wrong swimmer in front of the staff.
    """
    lowered = (text or "").lower()
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True)).all()
    by_first = {}
    for swimmer in swimmers:
        parts = swimmer.name.lower().split()
        if parts:
            by_first.setdefault(parts[0], []).append(swimmer)

    found = [s for s in swimmers if re.search(rf"\b{re.escape(s.name.lower())}\b", lowered)]
    for first, owners in by_first.items():
        if len(owners) != 1 or len(first) < 4 or owners[0] in found:
            continue
        # Skip a first name that is only present as part of someone else's full name.
        if any(first in f.name.lower().split() for f in found):
            continue
        if re.search(rf"\b{re.escape(first)}\b", lowered):
            found.append(owners[0])
    return found


def addressed_roles(text: str) -> list:
    """Staff the coach named directly - "what does the physio think?"."""
    lowered = (text or "").lower()
    named = []
    for key in ROLE_ORDER:
        if any(re.search(rf"\b{re.escape(alias)}\b", lowered) for alias in ROSTER[key].aliases):
            named.append(key)
    return named


# ---------------------------------------------------------------------------
# Context: a shared briefing, then each specialist's own slice
# ---------------------------------------------------------------------------

def _clip(text: str, limit: int = CONTEXT_LIMIT) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "\n[... trimmed]"


def _school_label(swimmer) -> Optional[str]:
    if not swimmer.dob:
        return None
    year = models.get_school_year(swimmer.dob)
    if year is None:
        return "primary school"
    return "post school" if year > 13 else f"Year {year}"


def _swimmer_line(swimmer) -> str:
    bits = [f"id {swimmer.id}: {swimmer.name}"]
    if swimmer.dob:
        bits.append(f"age {models.get_age_at_dec31(swimmer.dob)} at 31 Dec")
        school = _school_label(swimmer)
        if school:
            bits.append(school)
    if swimmer.gender:
        bits.append(swimmer.gender)
    if swimmer.squad:
        bits.append(swimmer.squad)
    if swimmer.status and swimmer.status != "active":
        bits.append(f"STATUS {swimmer.status.upper()}")
    return " | ".join(bits)


def _macro_lines(db: DBSession, macro_id: Optional[int]) -> list:
    if not macro_id:
        return []
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        return []
    lines = [f"MACROCYCLE: {macro.name} (id {macro.id}), {macro.date_from} to {macro.date_to}"
             + (f", squad {macro.squad}" if macro.squad else "")]
    if macro.narrative:
        lines.append(f"  Intent: {macro.narrative[:300]}")
    blocks = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.macro_id == macro.id,
    ).order_by(models.SeasonBlock.date_from).all()
    if blocks:
        lines.append("  Blocks:")
        lines += [f"    {b.name} | {b.phase_type or '-'} | {b.date_from} to {b.date_to}" for b in blocks]
    else:
        lines.append("  No blocks planned inside it yet.")
    lines += _pathway_lines(db, macro.id)
    meets = db.query(models.Meet).filter(
        models.Meet.date >= macro.date_from, models.Meet.date <= macro.date_to,
    ).order_by(models.Meet.date).all()
    if meets:
        lines.append("  Meets inside it:")
        lines += [f"    {m.date}: {m.name}" + (f" ({m.level})" if m.level else "") for m in meets]
    loads = db.query(models.SeasonLoadPoint).filter(
        models.SeasonLoadPoint.macro_id == macro.id,
        models.SeasonLoadPoint.pathway_id.is_(None),
    ).order_by(models.SeasonLoadPoint.week_start).all()
    if loads:
        lines.append("  Planned weekly load (0-100): " + ", ".join(
            f"{p.week_start.strftime('%d %b')} {p.overall}" for p in loads if p.overall is not None))
    return lines


def _pathway_lines(db: DBSession, macro_id: int) -> list:
    pathways = db.query(models.PlanningPathway).filter(
        models.PlanningPathway.macro_id == macro_id, models.PlanningPathway.active.is_(True),
    ).all()
    if not pathways:
        return []
    lines = ["  Pathways:"]
    for p in pathways:
        members = [m for m in p.memberships if m.active]
        target = p.primary_meet.name if p.primary_meet else "no target meet"
        fallback = f", else {p.fallback_meet.name}" if p.fallback_meet else ""
        who = ", ".join(f"{m.swimmer.name} ({m.qualification_status or 'unknown'})" for m in members[:15])
        lines.append(f"    id {p.id}: {p.name} -> {target}{fallback} | {who or 'nobody yet'}")
    return lines


def _subject_squad(db: DBSession, subject: Subject) -> Optional[str]:
    """The squad a meeting is about, when the subject pins one down."""
    if subject.squad:
        return subject.squad
    if subject.macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == subject.macro_id).first()
        if macro and macro.squad:
            return macro.squad
    if subject.session_id:
        session = db.query(models.Session).filter(models.Session.id == subject.session_id).first()
        if session and session.squad:
            return session.squad
    return None


def _squad_roster(db: DBSession, subject: Subject, limit: int = 60) -> str:
    """Names and ids, so a specialist can act on a swimmer the coach named in passing."""
    q = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True))
    squad = _subject_squad(db, subject)
    if squad:
        q = q.filter(models.Swimmer.squad == squad)
    rows = q.order_by(models.Swimmer.name).limit(limit).all()
    return "SQUAD (id: name): " + "; ".join(f"{s.id}: {s.name}" for s in rows) if rows else ""


def _meets_overview(db: DBSession, subject: Subject) -> str:
    today = date.today()
    q = db.query(models.Meet).filter(
        models.Meet.date >= today - timedelta(weeks=6), models.Meet.date <= today + timedelta(weeks=20),
    )
    meets = q.order_by(models.Meet.date).limit(25).all()
    if subject.meet_id and not any(m.id == subject.meet_id for m in meets):
        focus = db.query(models.Meet).filter(models.Meet.id == subject.meet_id).first()
        if focus:
            meets.append(focus)
    if not meets:
        return "MEETS: none in the six weeks behind or twenty weeks ahead."
    lines = ["MEETS (six weeks back, twenty ahead):"]
    for m in meets:
        sessions = db.query(models.MeetSession).filter(models.MeetSession.meet_id == m.id).count()
        entries = db.query(models.MeetEntry).filter(models.MeetEntry.meet_id == m.id).count()
        results = db.query(models.SwimTime).filter(models.SwimTime.meet_id == m.id).count()
        finished = (m.date_to or m.date) and (m.date_to or m.date) < today
        state = f"timetable {'yes' if sessions else 'NO'}, {entries} entries"
        if finished:
            state += f", {results} results recorded" + (" - RESULTS MISSING" if entries and not results else "")
        lines.append(f"  id {m.id}: {m.date} {m.name}" + (f" ({m.level}, {m.course})" if m.level or m.course else "")
                     + f" | {state}")
    return "\n".join(lines)


def _meet_detail(db: DBSession, meet_id: int) -> str:
    meet = db.query(models.Meet).filter(models.Meet.id == meet_id).first()
    if not meet:
        return ""
    lines = [f"MEET IN FOCUS: id {meet.id} {meet.name}, {meet.date}" + (f" to {meet.date_to}" if meet.date_to else "")]
    for session in db.query(models.MeetSession).filter(models.MeetSession.meet_id == meet.id).order_by(
            models.MeetSession.order_index).all():
        events = db.query(models.MeetEvent).filter(models.MeetEvent.meet_session_id == session.id).order_by(
            models.MeetEvent.order_index).all()
        lines.append(f"  {session.name} {session.date or ''} {session.start_time or ''}: "
                     + ", ".join(f"#{e.event_number or '?'} {e.name}" for e in events[:30]))
    entries = db.query(models.MeetEntry).filter(models.MeetEntry.meet_id == meet.id).all()
    if entries:
        by_swimmer = {}
        for e in entries:
            by_swimmer.setdefault(e.swimmer.name if e.swimmer else e.swimmer_id, []).append(
                e.event_name + (f" (entry {e.entry_time})" if e.entry_time else ""))
        lines.append("  Entries: " + "; ".join(f"{k}: {', '.join(v)}" for k, v in by_swimmer.items()))
    else:
        lines.append("  Entries: none yet")
    results = db.query(models.SwimTime).filter(models.SwimTime.meet_id == meet.id).all()
    if results:
        lines.append("  Results: " + "; ".join(
            f"{r.swimmer.name if r.swimmer else r.swimmer_id} {r.event} {r.time_seconds:.2f}s" for r in results[:40]))
    return "\n".join(lines)


def briefing(db: DBSession, subject: Subject, thread_id: Optional[int] = None) -> str:
    """Facts every member of staff shares before they look at their own data."""
    lines = [f"TODAY: {date.today()}"]
    lines += _macro_lines(db, subject.macro_id)
    if subject.week_start:
        lines.append(f"WEEK IN QUESTION: beginning {subject.week_start}")
    if subject.session_date:
        attendees = _attendees(db, subject)
        lines.append(f"SESSION BEING WRITTEN: {subject.session_date.strftime('%A %d %b %Y')}"
                     + (f", {subject.squad}" if subject.squad else "")
                     + (f", {len(attendees)} expected: " + ", ".join(a.name for a in attendees[:30])
                        if attendees else ", nobody on the timetable for it"))
    if subject.meet_id:
        meet = db.query(models.Meet).filter(models.Meet.id == subject.meet_id).first()
        if meet:
            lines.append(f"MEET: {meet.name} on {meet.date}" + (f" ({meet.level})" if meet.level else ""))
    swimmers = _subject_swimmers(db, subject)
    if swimmers:
        lines.append("SWIMMERS IN QUESTION:")
        lines += [f"  {_swimmer_line(s)}" for s in swimmers]
    try:
        lines += decision_lines(db, subject, thread_id)
    except Exception:
        pass
    return "\n".join(lines)


def _attendees(db: DBSession, subject: Subject) -> list:
    ids = [int(i) for i in (subject.attendee_ids or []) if str(i).isdigit()]
    if not ids:
        return []
    return db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).order_by(models.Swimmer.name).all()


def _week_plan_lines(db: DBSession, subject: Subject) -> list:
    """The micro plan for the week a session falls in."""
    day = subject.session_date or subject.week_start
    if not day:
        return []
    monday = day - timedelta(days=day.weekday())
    q = db.query(models.Microcycle).filter(models.Microcycle.week_start == monday)
    squad = subject.squad
    rows = q.all()
    if squad:
        rows = [m for m in rows if not m.squad or m.squad == squad] or rows
    lines = []
    for micro in rows[:2]:
        lines.append(f"WEEK PLAN {micro.label} ({micro.week_start} to {micro.week_end}, {micro.status})")
        for label, value in (("Where it sits", micro.meso_position_note), ("Progression", micro.progression_note),
                             ("Recovery", micro.recovery_placement), ("Next week", micro.next_week_direction)):
            if value:
                lines.append(f"  {label}: {value[:240]}")
        for planned in (micro.sessions or [])[:14]:
            if isinstance(planned, dict):
                bits = [str(planned.get(k)) for k in ("day", "date", "slot", "title", "focus", "energy_system_focus", "intent")
                        if planned.get(k)]
                lines.append("  - " + " | ".join(bits)[:220])
    block = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= day, models.SeasonBlock.date_to >= day,
    ).order_by(models.SeasonBlock.date_from).first()
    if block:
        lines.append(f"BLOCK: {block.name} ({block.phase_type or 'no phase'}), {block.date_from} to {block.date_to}"
                     + (f" | intents: {json.dumps(block.group_intents)[:300]}" if block.group_intents else ""))
    return lines


def _race_target_lines(db: DBSession, swimmers: list) -> list:
    """Each swimmer's target events with their best time, for setting race-pace targets."""
    lines = []
    for swimmer in swimmers[:20]:
        events = []
        for item in swimmer.target_events or []:
            name = item.get("event") if isinstance(item, dict) else str(item)
            if name:
                events.append(name)
        if not events:
            continue
        bests = []
        for name in events[:4]:
            best = db.query(models.SwimTime).filter(
                models.SwimTime.swimmer_id == swimmer.id, models.SwimTime.event.ilike(f"{name}%"),
            ).order_by(models.SwimTime.time_seconds).first()
            bests.append(f"{name} PB {best.time_seconds:.2f}s ({best.course or '?'}, {best.date})" if best
                         else f"{name} no time on file")
        lines.append(f"  {swimmer.name}: " + "; ".join(bests))
    return (["TARGET EVENTS AND BEST TIMES:"] + lines) if lines else []


def _subject_swimmers(db: DBSession, subject: Subject) -> list:
    ids = [int(i) for i in (subject.swimmer_ids or []) if str(i).isdigit()]
    if not ids:
        return []
    rows = db.query(models.Swimmer).filter(models.Swimmer.id.in_(ids)).all()
    order = {sid: i for i, sid in enumerate(ids)}
    return sorted(rows, key=lambda s: order.get(s.id, 0))


def _safe(builder, *args) -> str:
    """A context builder that fails must cost one section, not the meeting."""
    try:
        value = builder(*args)
    except Exception:
        return ""
    if isinstance(value, dict):
        return json.dumps(value, default=str)
    return value or ""


def _attendance_lines(db: DBSession, subject: Subject, attendees: list) -> str:
    """Who is expected, who is excused that day, and how reliably each turns up."""
    from backend.services import claude_service as cs
    from backend.services.availability import availability_ranges
    day = subject.session_date
    lines = [f"EXPECTED AT THE SESSION ON {day}:"]
    excused = availability_ranges(db, [a.id for a in attendees], day, day) if day else {}
    for swimmer in attendees[:30]:
        stats = {}
        try:
            stats = cs.build_attendance_stats(swimmer.id, db) or {}
        except Exception:
            stats = {}
        pct = stats.get("four_week_pct")
        note = f"  {swimmer.name}: last 4 weeks {pct}%" if pct is not None else f"  {swimmer.name}: no recent register"
        if excused.get(swimmer.id):
            note += " | EXCUSED: " + ", ".join(e["label"] for e in excused[swimmer.id])
        if swimmer.status and swimmer.status != "active":
            note += f" | status {swimmer.status}"
        lines.append(note)
    return "\n".join(lines)


def role_context(role: str, db: DBSession, subject: Subject) -> str:
    """The slice of real data this specialist looks at."""
    from backend.services import claude_service as cs

    swimmers = _subject_swimmers(db, subject)[:MAX_SWIMMERS_IN_DEPTH]
    attendees = _attendees(db, subject) if subject.session_date else []
    sections = []

    if role == "physiologist":
        from backend.services import training_load
        profiles = []
        try:
            profiles = training_load.load_profiles(db, swimmers)
        except Exception:
            profiles = []
        for profile in profiles:
            sections.append(_clip(training_load.describe(profile), 2200))
        for swimmer in swimmers:
            sections.append(_clip(_safe(cs.build_block_status_context, swimmer, db), 600))
        if attendees:
            sections.append(_clip(_safe(training_load.swimmers_summary, db, attendees,
                                        "THE SWIMMERS EXPECTED AT THIS SESSION"), 2500))
            sections.append("WHAT THE SQUAD SWAM RECENTLY:\n" + _clip(_safe(cs.build_recent_sessions_summary, db, 1), 1500))
        elif not swimmers:
            squad = _subject_squad(db, subject)
            sections.append(_clip(_safe(training_load.squad_summary, db, squad), 2500))
            sections.append("RECENT SQUAD TRAINING:\n" + _clip(_safe(cs.build_recent_sessions_summary, db, 2), 1500))

    elif role == "analyst":
        from backend.services import lanewatch
        for swimmer in swimmers:
            sections.append(f"--- {swimmer.name}: profile and times ---\n"
                            + _clip(_safe(cs.build_swimmer_context, swimmer, db), 2500))
            races = _safe(lanewatch.analyst_lines, db, swimmer)
            sections.append(_clip(races, 2400) if races else
                            f"No LaneWatch race analysis linked for {swimmer.name}; judge from times and splits only.")
            assessments = db.query(models.QualificationAssessment).filter(
                models.QualificationAssessment.swimmer_id == swimmer.id,
            ).limit(12).all()
            if assessments:
                sections.append("Qualification checks: " + "; ".join(
                    f"{getattr(a.standard, 'event_name', '?') if a.standard else '?'} {a.status}"
                    + (f" ({a.gap_seconds:+.2f}s)" if a.gap_seconds is not None else "")
                    for a in assessments))
        if attendees:
            sections.append(_clip("\n".join(_race_target_lines(db, attendees)), 2000))
        sections.append("MEETS AHEAD:\n" + _clip(_safe(cs.build_meets_context, db, 4), 1500))

    elif role == "planner":
        week = _week_plan_lines(db, subject)
        if week:
            sections.append(_clip("\n".join(week), 1800))
        sections.append("SEASON STRUCTURE:\n" + _clip(_safe(cs.build_periodization_context, db), 2500))
        if subject.macro_id:
            from backend.routers.skills import _planning_state_lines
            state = _safe(lambda: "\n".join(_planning_state_lines(db, subject.macro_id)))
            if state:
                sections.append(_clip(state, 1500))
        from backend.services import training_load
        sections.append(_clip(_safe(training_load.progression_summary, db, _subject_squad(db, subject),
                                    subject.macro_id), 1800))
        if swimmers:
            try:
                profiles = training_load.load_profiles(db, swimmers)
            except Exception:
                profiles = []
            needs = [f"  {p.name}: " + ("; ".join(p.flags) if p.flags else "nothing flagged") for p in profiles]
            if needs:
                sections.append("WHAT THE TRAINING FIGURES SAY ABOUT THESE SWIMMERS:\n" + "\n".join(needs))

    elif role == "meets":
        sections.append(_meets_overview(db, subject))
        if subject.meet_id:
            sections.append(_clip(_meet_detail(db, subject.meet_id), 2500))
        for swimmer in swimmers:
            targets = db.query(models.MeetTarget).filter(models.MeetTarget.swimmer_id == swimmer.id).all()
            upcoming = [t for t in targets if t.meet and t.meet.date and t.meet.date >= date.today()]
            if upcoming:
                sections.append(f"{swimmer.name} is entered: " + "; ".join(
                    f"{t.meet.name} (id {t.meet.id}): {', '.join(t.events or [])}" for t in upcoming))
            else:
                sections.append(f"{swimmer.name} has no upcoming entries.")
        sections.append(_squad_roster(db, subject))

    elif role == "manager":
        for swimmer in swimmers:
            stats = _safe(cs.build_attendance_stats, swimmer.id, db)
            memberships = [
                f"{m.pathway.name} ({m.qualification_status or 'unknown'})"
                for m in swimmer.pathway_memberships if m.active and m.pathway
            ]
            sections.append(
                f"--- {swimmer.name} ---\n{_swimmer_line(swimmer)}\n"
                f"Attendance: {_clip(stats, 900)}\n"
                + (f"Pathways: {', '.join(memberships)}\n" if memberships else "Pathways: none\n")
                + (f"Coach notes: {swimmer.profile_notes[:400]}" if swimmer.profile_notes else "")
            )
        if attendees:
            sections.append(_clip(_attendance_lines(db, subject, attendees), 2000))
        elif not swimmers:
            sections.append("SQUAD SNAPSHOT:\n" + _clip(_safe(cs.build_squad_snapshot, db), 2500))

    elif role == "sessions":
        week = _week_plan_lines(db, subject)
        if week:
            sections.append(_clip("\n".join(week), 1800))
        hint = {"date": subject.session_date.isoformat(), "squad": subject.squad} if subject.session_date else None
        sections.append(_clip(_safe(cs.build_session_writing_context, db, hint), 3000))

    # Anyone who can act on swimmers needs to be able to name them.
    if attendees and role in ("physiologist", "analyst", "planner", "manager"):
        sections.append("EXPECTED (id: name): " + "; ".join(f"{a.id}: {a.name}" for a in attendees[:40]))
    if role in ("physiologist", "analyst", "planner", "manager") and not swimmers:
        roster = _squad_roster(db, subject)
        if roster:
            sections.append(roster)

    text = "\n\n".join(part for part in sections if part and part.strip())
    # The analyst reads race-by-race detail, so gets more room than the rest.
    limit = CONTEXT_LIMIT + 2500 if role == "analyst" else CONTEXT_LIMIT
    return _clip(text, limit) if text else "(no data on file for this yet)"


# ---------------------------------------------------------------------------
# Model calls
# ---------------------------------------------------------------------------

def _parse_json(raw: str) -> Optional[dict]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start:end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _ask_text(system: str, user: str, max_tokens: int, operation: str) -> str:
    try:
        response = get_client().messages.create(
            model=STAFF_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            operation=operation,
        )
    except Exception:
        return ""
    return response_text(response) or ""


def _ask(system: str, user: str, max_tokens: int, operation: str) -> Optional[dict]:
    return _parse_json(_ask_text(system, user, max_tokens, operation))


_CHAIR_SYSTEM = """You chair a swimming coaching staff meeting. The head coach makes the decisions;
the staff raise what the coach might be missing.

Staff:
{roster}

Given what just happened, decide who has something genuinely worth raising.
Most of the time that is one person or nobody. Choose at most {max_speakers}.
Choose nobody for small talk, simple lookups, or anything routine.
Prefer the person whose remit the topic most directly touches.

Return JSON only, with each focus in fifteen words or fewer:
{{"speakers": [{{"role": "physiologist", "focus": "what specifically they should look at"}}]}}"""


def choose_speakers(topic: str, trigger: str, brief: str, recent: list) -> list:
    """The chair picks who speaks. Returns [(role, focus)]."""
    author = SELF_AUTHORED.get(trigger)
    roster = "\n".join(f"- {key}: {ROSTER[key].remit}" for key in ROLE_ORDER if key != author)
    system = _CHAIR_SYSTEM.format(roster=roster, max_speakers=MAX_SPEAKERS)
    already = "\n".join(f"- {n.role}: {n.message[:160]}" for n in recent) or "(nothing yet)"
    user = (f"WHAT HAPPENED ({trigger}):\n{topic}\n\nBRIEFING:\n{brief}\n\n"
            f"ALREADY RAISED RECENTLY (do not repeat):\n{already}")
    raw = _ask_text(system, user, 600, "staff_chair")
    result = _parse_json(raw) or {}
    items = result.get("speakers")
    if items is None:
        # A reply cut off mid-JSON still names who the chair wanted; recover
        # them rather than silently deciding nobody should speak.
        items = [{"role": role} for role in re.findall(r'"role"\s*:\s*"([a-z_]+)"', raw or "")]
    chosen = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        if role in ROSTER and role != author and role not in [r for r, _ in chosen]:
            chosen.append((role, str(item.get("focus") or "")[:300]))
    return chosen[:MAX_SPEAKERS]


_SPECIALIST_SYSTEM = """You are the {title} on a swimming coaching staff.

Your remit: {remit}
You watch for: {watch_for}

The meeting runs like a start-up standup with the head coach. Speak only when you
have something that could change a decision: a risk, a correction, or one sharp
question. Staying quiet is normal and fine.

When you speak:
- Be specific. Use the names, dates and numbers in your data.
- Refer to swimmers by name only - never by their id number.
- Use he or she only where the data gives the swimmer's gender (M/F); otherwise use their name or "they".
- Never invent data. If something that matters is missing, say what is missing.
- Two or three sentences at most. Plain coaching language, no preamble.
- Stay inside your remit. If a colleague's expertise is needed, ask them.

Colleagues you can ask: {colleagues}. You usually work most closely with {usual}.

{actions}

Return JSON only:
{{
  "speak": true,
  "kind": "concern" | "question" | "observation",
  "message": "what you want to say",
  "question_for_coach": "one question for the coach, or null",
  "swimmer_ids": [ids of swimmers this is about, from the data, or []],
  "week_start": "YYYY-MM-DD of the week this is about, or null",
  "ask_colleague": {{"role": "colleague key", "question": "what you want them to look at"}} or null,
  "proposed_action": one action object from your list, or null
}}
If you have nothing worth saying, return {{"speak": false}}."""


def _specialist_system(role: str) -> str:
    r = ROSTER[role]
    from backend.services.staff_actions import prompt_block
    colleagues = ", ".join(f"{k} ({ROSTER[k].title})" for k in ROLE_ORDER if k != role)
    usual = " and ".join(ROSTER[k].title for k in USUAL_COLLEAGUES.get(role, ()))
    actions = prompt_block(role) or "You advise only; you have no actions to propose."
    return _SPECIALIST_SYSTEM.format(title=r.title, remit=r.remit, watch_for=r.watch_for,
                                     colleagues=colleagues, usual=usual or "the whole staff",
                                     actions=actions)


def _can_act(role: str) -> bool:
    from backend.services.staff_actions import actions_for
    return bool(actions_for(role))


_ACT_NUDGE = (
    "\n\nYOUR FIRST ANSWER PROPOSED NOTHING. If the coach's message asked you to record, add, "
    "enter or change something, return the same JSON with proposed_action filled in - you may "
    "keep your remark in the message. If it was only a question, return your answer unchanged.\n"
    "Your first answer: "
)


def _specialist_user(topic, trigger, brief, own_data, focus, discussion) -> str:
    parts = [f"WHAT HAPPENED ({trigger}):\n{topic}", f"BRIEFING:\n{brief}", f"YOUR DATA:\n{own_data}"]
    if focus:
        parts.append(f"THE CHAIR ASKS YOU TO LOOK AT:\n{focus}")
    if discussion:
        parts.append(f"SAID SO FAR IN THIS MEETING:\n{discussion}")
    return "\n\n".join(parts)


@dataclass
class Contribution:
    role: str
    kind: str
    message: str
    question: Optional[str]
    swimmer_ids: list
    week_start: Optional[date]
    ask_colleague: Optional[tuple]    # (role, question)
    proposed_action: Optional[dict] = None


def clean_contribution(role: str, raw: Optional[dict], known_swimmer_ids: set,
                       force: bool = False) -> Optional[Contribution]:
    """Turn a specialist's reply into something safe to store, or None for silence."""
    if not raw:
        return None
    if not raw.get("speak") and not force:
        return None
    message = str(raw.get("message") or "").strip()
    if not message:
        return None
    kind = str(raw.get("kind") or "observation").lower()
    if kind not in ("concern", "question", "observation"):
        kind = "observation"
    question = raw.get("question_for_coach")
    question = str(question).strip()[:500] if question and str(question).strip().lower() != "null" else None
    swimmer_ids = []
    for value in raw.get("swimmer_ids") or []:
        try:
            sid = int(value)
        except (TypeError, ValueError):
            continue
        if sid in known_swimmer_ids and sid not in swimmer_ids:
            swimmer_ids.append(sid)
    week = None
    try:
        week = date.fromisoformat(str(raw.get("week_start")))
        week = week - timedelta(days=week.weekday())
    except (TypeError, ValueError):
        week = None
    ask = raw.get("ask_colleague")
    ask_tuple = None
    if isinstance(ask, dict):
        target = str(ask.get("role") or "").lower()
        if target in ROSTER and target != role and ask.get("question"):
            ask_tuple = (target, str(ask["question"])[:400])
    action = raw.get("proposed_action")
    return Contribution(role, kind, message[:900], question, swimmer_ids, week, ask_tuple,
                        action if isinstance(action, dict) else None)


# ---------------------------------------------------------------------------
# Meetings
# ---------------------------------------------------------------------------

def _store(db: DBSession, c: Contribution, subject: Subject, *, topic: str, trigger: str,
           thread_id: Optional[int], parent_id: Optional[int] = None,
           addressed_to: Optional[str] = None) -> models.StaffNote:
    note = models.StaffNote(
        role=c.role, kind=c.kind, message=c.message, question=c.question,
        swimmer_ids=c.swimmer_ids or list(subject.swimmer_ids or []),
        macro_id=subject.macro_id, block_id=subject.block_id,
        week_start=c.week_start or subject.week_start,
        session_id=subject.session_id, meet_id=subject.meet_id,
        thread_id=thread_id, parent_id=parent_id, addressed_to=addressed_to,
        trigger=trigger, topic=(topic or "")[:500], status="open",
    )
    if c.proposed_action:
        from backend.services.staff_actions import prepare
        prepared = prepare(c.role, c.proposed_action, db)
        if prepared and not prepared.get("invalid"):
            note.proposed_action = prepared
            note.action_status = "proposed"
        elif prepared and prepared.get("invalid"):
            # Say why it could not be offered rather than dropping it silently.
            note.message = f"{note.message}\n(I wanted to {prepared['type'].replace('_', ' ')}, " \
                           f"but {prepared['invalid'][0].lower() + prepared['invalid'][1:]}.)"
    db.add(note)
    db.flush()
    return note


def _note_subject(note: models.StaffNote) -> Subject:
    """What a stored note was about, to reopen the conversation around it."""
    return Subject(
        swimmer_ids=list(note.swimmer_ids or []), macro_id=note.macro_id, block_id=note.block_id,
        week_start=note.week_start, session_id=note.session_id, meet_id=note.meet_id,
    )


def _recent_notes(db: DBSession, subject: Subject, thread_id: Optional[int], limit: int = 8) -> list:
    q = db.query(models.StaffNote).filter(models.StaffNote.status == "open")
    if thread_id:
        q = q.filter(models.StaffNote.thread_id == thread_id)
    elif subject.macro_id:
        q = q.filter(models.StaffNote.macro_id == subject.macro_id)
    elif subject.meet_id:
        q = q.filter(models.StaffNote.meet_id == subject.meet_id)
    elif subject.week_start:
        q = q.filter(models.StaffNote.week_start == subject.week_start)
    elif subject.swimmer_ids:
        rows = q.order_by(models.StaffNote.id.desc()).limit(limit * 4).all()
        wanted = set(subject.swimmer_ids)
        return [n for n in rows if wanted & set(n.swimmer_ids or [])][:limit]
    else:
        return []
    return q.order_by(models.StaffNote.id.desc()).limit(limit).all()


def convene(
    db: DBSession,
    *,
    topic: str,
    subject: Subject,
    trigger: str = "coach_message",
    thread_id: Optional[int] = None,
    roles: Optional[list] = None,
    insist: bool = True,
    coach_text: Optional[str] = None,
) -> list:
    """Hold a short staff meeting about ``topic``. Returns the notes it produced.

    ``roles`` names who must speak (the coach asked them directly); otherwise the
    chair decides, and anyone the coach named in the topic is added. At most one
    colleague consultation follows, so a meeting is bounded at a handful of calls.
    """
    if not staff_room_enabled() or not (topic or "").strip():
        return []

    if subject.session_date and not subject.week_start:
        subject.week_start = subject.session_date - timedelta(days=subject.session_date.weekday())
    mentioned = [s.id for s in find_mentioned_swimmers(topic, db)]
    subject.swimmer_ids = list(dict.fromkeys([*(subject.swimmer_ids or []), *mentioned]))
    brief = briefing(db, subject, thread_id)

    # Only the coach's own words can summon someone by name. A hand-off topic
    # ("Meet Manager did this...") or the lead assistant's reply mentioning a
    # role must not pull that role into the meeting.
    if coach_text is None:
        coach_text = topic if trigger in COACH_TRIGGERS else ""
    forced = [r for r in (roles or []) if r in ROSTER] + addressed_roles(coach_text)
    forced = list(dict.fromkeys(forced))
    if forced:
        speakers = [(role, "The coach asked you directly.") for role in forced[:MAX_SPEAKERS + 1]]
    else:
        speakers = choose_speakers(topic, trigger, brief, _recent_notes(db, subject, thread_id))
    if not speakers:
        return []

    known = set(subject.swimmer_ids)
    data = {role: role_context(role, db, subject) for role, _ in speakers}
    forced_set = set(forced) if insist else set()

    def run(entry):
        role, focus = entry
        system = _specialist_system(role)
        user = _specialist_user(topic, trigger, brief, data[role], focus, None)
        raw = _ask(system, user, _budget(role), f"staff_{role}")
        # Asked directly and able to act, but proposed nothing: the fast model
        # sometimes stops to remark on an oddity instead of doing what it was
        # told. One short second look, only on a miss, and only for someone the
        # coach addressed - a plain question still gets its plain answer.
        if (raw and role in forced_set and _can_act(role)
                and not isinstance(raw.get("proposed_action"), dict)):
            retry = _ask(system, user + _ACT_NUDGE + json.dumps(raw), _budget(role), f"staff_{role}_act")
            if retry and isinstance(retry.get("proposed_action"), dict):
                raw = retry
        return role, raw

    with ThreadPoolExecutor(max_workers=len(speakers)) as pool:
        results = list(pool.map(run, speakers))

    notes = []
    consult = None
    for role, raw in results:
        contribution = clean_contribution(role, raw, known, force=role in forced_set)
        if not contribution:
            continue
        note = _store(db, contribution, subject, topic=topic, trigger=trigger,
                      thread_id=thread_id, addressed_to="coach")
        notes.append(note)
        if consult is None and contribution.ask_colleague:
            consult = (note, contribution.ask_colleague)

    # A colleague who has already spoken has put their view on the table;
    # asking them again repeats it and doubles the wait.
    if consult and consult[1][0] in {n.role for n in notes}:
        consult = None

    # One colleague consultation per meeting: the physiologist asking the
    # manager about a swimmer's growth, say. Bounded so a meeting never sprawls.
    if consult:
        asker_note, (target, question) = consult
        discussion = "\n".join(f"{ROSTER[n.role].title}: {n.message}" for n in notes)
        raw = _ask(
            _specialist_system(target),
            _specialist_user(topic, trigger, brief, role_context(target, db, subject),
                             f"{ROSTER[asker_note.role].title} asks you: {question}", discussion),
            _budget(target), f"staff_{target}",
        )
        answer = clean_contribution(target, raw, known, force=True)
        if answer:
            notes.append(_store(db, answer, subject, topic=topic, trigger="consult",
                                thread_id=thread_id, parent_id=asker_note.id,
                                addressed_to=asker_note.role))

    # Staff who pull in different directions do not settle it between
    # themselves: the coach gets a "your call" with each side laid out.
    if notes and trigger != "decision":
        decision = raise_disagreement(db, notes, subject, topic=topic, thread_id=thread_id)
        if decision:
            notes.append(decision)

    db.commit()
    return notes


# ---------------------------------------------------------------------------
# Disagreements: the coach decides
# ---------------------------------------------------------------------------

CHAIR = "chair"
DECISION_MEMORY_WEEKS = 12

_DISAGREEMENT_SYSTEM = """You sit in on a swimming coaching staff meeting. The head coach makes every decision.

Read what the staff have said. Do two of them recommend courses of action the coach
cannot follow at the same time - one says rest a swimmer this week while another says
push the load, one says enter a meet while another says skip it?

Differences of emphasis, one adding detail to another, or a question are NOT
disagreements. When in doubt, say there is no disagreement.

Return JSON only:
{"disagree": false}
or
{"disagree": true,
 "question": "the decision the coach has to make, one short sentence",
 "options": [{"note_id": 12, "role": "role key", "position": "what they recommend, 20 words or fewer",
              "because": "their reason, 25 words or fewer"}]}
One option per side, two or three options, each from a different member of staff."""


def _open_decision_note_ids(db: DBSession, thread_id: Optional[int], subject: Subject) -> set:
    q = db.query(models.StaffNote).filter(
        models.StaffNote.kind == "decision", models.StaffNote.status == "open")
    if thread_id:
        q = q.filter(models.StaffNote.thread_id == thread_id)
    elif subject.macro_id:
        q = q.filter(models.StaffNote.macro_id == subject.macro_id)
    covered = set()
    for row in q.limit(20).all():
        covered.update(o.get("note_id") for o in (row.options or []) if isinstance(o, dict))
    return covered


def raise_disagreement(db: DBSession, notes: list, subject: Subject, *, topic: str,
                       thread_id: Optional[int]) -> Optional[models.StaffNote]:
    """If this meeting's points - or this meeting's and the open ones before it -
    pull in different directions, put the choice to the coach."""
    earlier = [n for n in _recent_notes(db, subject, thread_id, limit=6)
               if n.role in ROSTER and n.id not in {x.id for x in notes}]
    candidates = [n for n in notes if n.role in ROSTER] + earlier
    covered = _open_decision_note_ids(db, thread_id, subject)
    candidates = [n for n in candidates if n.id not in covered]
    if len({n.role for n in candidates}) < 2 or not any(n in candidates for n in notes):
        return None

    said = "\n".join(
        f"- note {n.id}, {n.role} ({ROSTER[n.role].title}): {n.message}"
        + (f" | asks the coach: {n.question}" if n.question else "")
        for n in candidates)
    raw = _ask(_DISAGREEMENT_SYSTEM, f"TOPIC:\n{topic}\n\nWHAT THE STAFF SAID:\n{said}", 500, "staff_disagreement")
    if not raw or not raw.get("disagree"):
        return None

    by_id = {n.id: n for n in candidates}
    options, roles = [], set()
    for item in raw.get("options") or []:
        if not isinstance(item, dict):
            continue
        try:
            note = by_id.get(int(item.get("note_id")))
        except (TypeError, ValueError):
            note = None
        if not note or note.role in roles:
            continue
        position = str(item.get("position") or "").strip()
        if not position:
            continue
        roles.add(note.role)
        options.append({
            "note_id": note.id, "role": note.role, "title": ROSTER[note.role].title,
            "position": position[:200], "because": str(item.get("because") or "").strip()[:240],
        })
    question = str(raw.get("question") or "").strip()
    if len(options) < 2 or not question:
        return None

    swimmer_ids = list(dict.fromkeys(
        sid for n in candidates if n.id in {o["note_id"] for o in options} for sid in (n.swimmer_ids or [])))
    decision = models.StaffNote(
        role=CHAIR, kind="decision", message=question[:400], options=options[:3],
        swimmer_ids=swimmer_ids or list(subject.swimmer_ids or []),
        macro_id=subject.macro_id, block_id=subject.block_id, week_start=subject.week_start,
        session_id=subject.session_id, meet_id=subject.meet_id,
        thread_id=thread_id, addressed_to="coach", trigger="disagreement",
        topic=(topic or "")[:500], status="open",
    )
    db.add(decision)
    db.flush()
    return decision


def decide(db: DBSession, note_id: int, choice: Optional[str] = None,
           text: Optional[str] = None) -> tuple:
    """The coach makes the call. Their decision closes the points on each side
    and becomes the plan of action; the staff involved then say how they will
    work to it, or propose the change it needs. Returns (note, follow-ups)."""
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note or note.kind != "decision":
        return None, []
    if note.status != "open":
        return note, []
    options = [o for o in (note.options or []) if isinstance(o, dict)]
    chosen = next((o for o in options if o.get("role") == choice), None) if choice else None
    own = (text or "").strip()
    if not chosen and not own:
        raise ValueError("Pick one of the options or say what you want to do.")
    if chosen:
        decision = f"Go with the {chosen.get('title') or ROSTER[chosen['role']].title}: {chosen['position']}"
        if own:
            decision += f" {own}"
    else:
        decision = own

    from datetime import datetime, timezone
    note.decision = decision[:2000]
    note.coach_reply = note.decision
    note.decided_at = datetime.now(timezone.utc)
    note.status = "resolved"
    for option in options:
        side = db.query(models.StaffNote).filter(models.StaffNote.id == option.get("note_id")).first()
        if side and side.status == "open":
            side.status = "resolved"
            side.coach_reply = side.coach_reply or f"Your call: {note.decision}"
    db.commit()

    roles = [o["role"] for o in options if o.get("role") in ROSTER]
    subject = _note_subject(note)
    follow_ups = convene(
        db,
        topic=(f"The head coach has made the call. The question was: {note.message}\n"
               f"Decision: {note.decision}\n"
               "Work to this decision from now on. If it needs a change you can make, propose it "
               "now. Otherwise say in one sentence what you will do differently, or stay quiet."),
        subject=subject, trigger="decision", thread_id=note.thread_id, roles=roles, insist=False,
    )
    for follow in follow_ups:
        follow.parent_id = note.id
        follow.addressed_to = "coach"
    db.commit()
    return note, follow_ups


def decision_lines(db: DBSession, subject: Subject, thread_id: Optional[int] = None,
                   limit: int = 5) -> list:
    """Calls the coach has made that bear on this subject. The staff work to them."""
    from datetime import datetime, timezone
    since = datetime.now(timezone.utc) - timedelta(weeks=DECISION_MEMORY_WEEKS)
    rows = db.query(models.StaffNote).filter(
        models.StaffNote.kind == "decision", models.StaffNote.decision.is_not(None),
    ).order_by(models.StaffNote.id.desc()).limit(60).all()
    swimmers = set(subject.swimmer_ids or [])
    relevant = []
    for n in rows:
        when = n.decided_at
        if when is not None and when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        if when is not None and when < since:
            continue
        if ((thread_id and n.thread_id == thread_id)
                or (subject.macro_id and n.macro_id == subject.macro_id)
                or (subject.meet_id and n.meet_id == subject.meet_id)
                or (subject.session_id and n.session_id == subject.session_id)
                or (swimmers and swimmers & set(n.swimmer_ids or []))):
            relevant.append(n)
        if len(relevant) >= limit:
            break
    if not relevant:
        return []
    lines = ["COACH'S DECISIONS (work to these; do not reopen them without new evidence):"]
    for n in reversed(relevant):
        stamp = n.decided_at.strftime("%d %b") if n.decided_at else ""
        lines.append(f"  {stamp}: {n.message} -> {n.decision}")
    return lines


_REPLY_SUFFIX = """

The head coach has replied to something you raised. Respond briefly: accept it,
push back with evidence from your data, or ask one follow-up. You were addressed
directly, so do speak - but keep it to two sentences."""


def reply_to_note(db: DBSession, note_id: int, text: str) -> Optional[models.StaffNote]:
    """The coach answers one specialist; that specialist responds once."""
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note or note.role not in ROSTER:
        return None
    note.coach_reply = (text or "").strip()[:2000]
    subject = _note_subject(note)
    brief = briefing(db, subject, note.thread_id)
    discussion = f"You said: {note.message}"
    if note.question:
        discussion += f"\nYou asked the coach: {note.question}"
    discussion += f"\nThe coach replied: {note.coach_reply}"
    raw = _ask(
        _specialist_system(note.role) + _REPLY_SUFFIX,
        _specialist_user(note.topic or "", "reply", brief, role_context(note.role, db, subject), None, discussion),
        _budget(note.role), f"staff_{note.role}_reply",
    )
    answer = clean_contribution(note.role, raw, set(subject.swimmer_ids), force=True)
    response = None
    if answer:
        response = _store(db, answer, subject, topic=note.topic or "", trigger="reply",
                          thread_id=note.thread_id, parent_id=note.id, addressed_to="coach")
    db.commit()
    return response


def note_out(note: models.StaffNote) -> dict:
    role = ROSTER.get(note.role)
    return {
        "id": note.id,
        "role": note.role,
        "title": role.title if role else ("Your call" if note.role == CHAIR else note.role),
        "kind": note.kind,
        "message": note.message,
        "question": note.question,
        "swimmer_ids": note.swimmer_ids or [],
        "macro_id": note.macro_id,
        "block_id": note.block_id,
        "week_start": note.week_start.isoformat() if note.week_start else None,
        "session_id": note.session_id,
        "meet_id": note.meet_id,
        "thread_id": note.thread_id,
        "parent_id": note.parent_id,
        "addressed_to": note.addressed_to,
        "trigger": note.trigger,
        "status": note.status,
        "coach_reply": note.coach_reply,
        "proposed_action": {k: v for k, v in (note.proposed_action or {}).items() if k != "payload"} or None,
        "action_status": note.action_status,
        "action_result": note.action_result,
        "options": note.options or None,
        "decision": note.decision,
        "decided_at": note.decided_at.isoformat() if note.decided_at else None,
        "created_at": note.created_at.isoformat() if note.created_at else None,
    }


def staff_context_lines(db: DBSession, thread_id: Optional[int] = None,
                        macro_id: Optional[int] = None, limit: int = 6) -> list:
    """Open points the staff have raised, for the lead assistant to keep in mind."""
    q = db.query(models.StaffNote).filter(models.StaffNote.status == "open")
    if thread_id:
        q = q.filter(models.StaffNote.thread_id == thread_id)
    elif macro_id:
        q = q.filter(models.StaffNote.macro_id == macro_id)
    else:
        return []
    rows = q.order_by(models.StaffNote.id.desc()).limit(limit).all()
    lines = []
    if rows:
        lines.append("OPEN POINTS FROM THE STAFF (raised with the coach; do not contradict them silently):")
        for n in reversed(rows):
            if n.role == CHAIR:
                sides = " / ".join(f"{o.get('title')}: {o.get('position')}" for o in (n.options or [])
                                   if isinstance(o, dict))
                lines.append(f"  WAITING FOR THE COACH'S CALL: {n.message[:200]} ({sides[:300]})")
                continue
            title = ROSTER[n.role].title if n.role in ROSTER else n.role
            line = f"  {title}: {n.message[:240]}"
            if n.coach_reply:
                line += f" | Coach replied: {n.coach_reply[:160]}"
            lines.append(line)
    lines += decision_lines(db, Subject(macro_id=macro_id), thread_id)
    return lines


def apply_action(db: DBSession, note_id: int) -> tuple:
    """The coach approved a proposal: do it, then hand the consequence on.

    Returns (note, follow-up notes). A proposal that no longer holds - the meet
    was added by hand in the meantime - fails cleanly and says why.
    """
    from backend.services.staff_actions import ActionError, execute
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if not note or not note.proposed_action:
        return note, []
    if note.action_status != "proposed":
        return note, []
    try:
        result, handoff = execute(note.proposed_action, note.role, db)
    except ActionError as exc:
        note.action_status = "failed"
        note.action_result = str(exc)
        db.commit()
        return note, []
    except Exception as exc:
        db.rollback()
        note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
        note.action_status = "failed"
        note.action_result = f"Could not complete it: {exc}"
        db.commit()
        return note, []

    note.action_status = "applied"
    note.action_result = result
    note.status = "resolved"
    db.commit()

    follow_ups = []
    if handoff:
        role, topic = handoff
        subject = _note_subject(note)
        payload = (note.proposed_action or {}).get("payload") or {}
        subject.meet_id = subject.meet_id or payload.get("meet_id")
        for key in ("swimmer_id",):
            if payload.get(key) and payload[key] not in subject.swimmer_ids:
                subject.swimmer_ids.append(payload[key])
        for row in payload.get("results", []) + payload.get("entries", []):
            if row.get("swimmer_id") and row["swimmer_id"] not in subject.swimmer_ids:
                subject.swimmer_ids.append(row["swimmer_id"])
        follow_ups = convene(db, topic=f"{ROSTER[note.role].title} did this with the coach's approval. {topic}",
                             subject=subject, trigger="handoff", thread_id=note.thread_id,
                             roles=[role], insist=False)
        for follow in follow_ups:
            follow.parent_id = note.id
            follow.addressed_to = note.role
        db.commit()
    return note, follow_ups


def decline_action(db: DBSession, note_id: int) -> Optional[models.StaffNote]:
    note = db.query(models.StaffNote).filter(models.StaffNote.id == note_id).first()
    if note and note.action_status == "proposed":
        note.action_status = "declined"
        db.commit()
    return note
