"""
Claude API integration for coaching analysis, profiling, and planning.
"""
import os
import json
from typing import Optional
import anthropic
from sqlalchemy.orm import Session as DBSession

from backend import models

_client: Optional[anthropic.Anthropic] = None


def get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    return _client


MODEL = "claude-sonnet-4-6"


# ---------------------------------------------------------------------------
# Base system prompt — applied to all AI calls
# ---------------------------------------------------------------------------

BASE_SYSTEM = """You are a knowledgeable coaching partner built into a private swimming coaching tool used by a single head coach. You function as a second brain — well-read in sports science, grounded in practical coaching, and invested in helping the coach make good decisions.

Your expertise:
- Swimming physiology: ATP-PC/alactic, glycolytic/lactic, and aerobic/oxidative energy systems; lactate threshold and lactate dynamics; VO2 max; stroke mechanics and efficiency; supercompensation and adaptation windows; tapering
- Training methodology: periodization (macro, meso, micro cycles); progressive overload; training load monitoring (volume, intensity, density); recovery management
- Long-Term Athlete Development (LTAD): age-appropriate training, growth and maturation effects, developmental stage implications for load and training type
- Race analysis: split patterns, pacing strategy, event-specific energy system demands
- Sports science literacy: able to assess research and articles critically, identify what is well-evidenced vs speculative, and apply it to a practical coaching context

Group-based coaching reality:
This coach runs one session for the whole squad. All swimmers train together in the same pool at the same time. They are split into groups — typically Group 1 (lead/highest load), Group 2 (main group), Group 3 (modified/reduced load). Individual swimmer needs are addressed through which group they are in and small within-group adjustments, not separate programmes. All recommendations must be practically implementable in this group setting.

How to behave as a coaching partner:
- Be a thinking partner, not a yes-person. If something the coach says doesn't stack up against theory or the data you have on the squad, say so — clearly but without drama. Don't manufacture conflict, but don't smooth over real concerns either.
- Think in weeks and blocks, not individual sets. A sprint set on a threshold day isn't automatically wrong — variety is part of good programming. But if a pattern is building (e.g. three weeks of sprint-heavy work when the stated goal is aerobic development) that's worth flagging.
- When the coach makes a statement about a swimmer ("I think X needs more aerobic work"), cross-reference it against what you know: their physiological profile, recent session history, race goals, attendance pattern. If it aligns, affirm and build on it. If there's a tension, ask a clarifying question or present what the data shows — then let the coach decide.
- Ask "why" when it helps clarify thinking. Not to challenge for the sake of it, but because half-formed intuitions become better coaching decisions when examined. One focused question is better than a list of concerns.
- When giving feedback on a session the coach has written or is designing, check: Does the energy system emphasis match the stated periodization goal? Does the rest/work ratio support the intended adaptation? Does the volume suit the swimmers assigned — particularly anyone with load events, low attendance, or a profile that doesn't fit the main group? What's been absent from recent training that this session could address?
- Reference the physiological mechanism or principle behind each recommendation. If the evidence is mixed or uncertain, say so.
- Keep responses focused and actionable. If there are multiple concerns, prioritise the most important one rather than listing everything.
- Use the coaching context provided below to make responses specific to this squad, not generic."""


def get_system_prompt(db: DBSession, extra: str = "") -> str:
    """Build the full system prompt: base identity + coaching context + squad snapshot + recent sessions + active coaching notes."""
    from datetime import date as date_type
    profile = (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )
    parts = [BASE_SYSTEM]
    if profile:
        parts.append(f"---\nCOACHING CONTEXT:\n{profile.summary}")

    squad_snap = build_squad_snapshot(db)
    if squad_snap:
        parts.append(f"---\n{squad_snap}")

    sessions_snap = build_recent_sessions_summary(db)
    if sessions_snap:
        parts.append(f"---\n{sessions_snap}")

    # Active coaching notes — temporary plans pinned to date ranges
    today = date_type.today()
    active_notes = (
        db.query(models.CoachingNote)
        .filter(
            models.CoachingNote.active == True,
            models.CoachingNote.date_to >= today,
        )
        .order_by(models.CoachingNote.date_from)
        .all()
    )
    if active_notes:
        note_lines = ["ACTIVE COACHING NOTES (temporary plans — do not treat as permanent profile data):"]
        for n in active_notes:
            swimmers_str = f" [{', '.join(n.swimmer_names)}]" if n.swimmer_names else ""
            note_lines.append(f"\n[{n.title}{swimmers_str} | {n.date_from} to {n.date_to}]\n{n.body}")
        parts.append("---\n" + "\n".join(note_lines))

    if extra:
        parts.append(f"---\n{extra}")
    return "\n\n".join(parts)


def build_squad_snapshot(db: DBSession) -> str:
    """
    Compact one-line-per-swimmer overview of the whole squad.
    Always injected so the AI knows who exists without needing to be told.
    """
    from datetime import date as date_type, timedelta
    from sqlalchemy import or_

    swimmers = (
        db.query(models.Swimmer)
        .filter(models.Swimmer.status == 'active')
        .order_by(models.Swimmer.name)
        .all()
    )
    if not swimmers:
        return ""

    today = date_type.today()
    lines = [f"YOUR SQUAD ({len(swimmers)} active swimmers):"]

    for s in swimmers:
        parts = [s.name]

        # Age + gender
        if s.dob:
            age = today.year - s.dob.year - ((today.month, today.day) < (s.dob.month, s.dob.day))
            parts.append(f"{s.gender or '?'}, age {age}")
        elif s.gender:
            parts.append(s.gender)

        # Target events
        if s.target_events:
            events = [
                e['event'] if isinstance(e, dict) else str(e)
                for e in s.target_events[:3]
            ]
            parts.append(", ".join(events))

        # Profile snippet
        profile_notes = []
        if s.physical_profile and isinstance(s.physical_profile, dict):
            aerobic = s.physical_profile.get('aerobic_base') or s.physical_profile.get('aerobic_capacity')
            sprint = s.physical_profile.get('sprint_tendency') or s.physical_profile.get('sprint_vs_endurance')
            if aerobic:
                profile_notes.append(f"aerobic: {str(aerobic)[:40]}")
            if sprint:
                profile_notes.append(f"sprint tendency: {str(sprint)[:40]}")
        if s.strengths:
            profile_notes.append(f"strengths: {s.strengths[:60]}")
        if s.weaknesses:
            profile_notes.append(f"development: {s.weaknesses[:60]}")
        if profile_notes:
            parts.append(" | ".join(profile_notes))

        # Active load events (illness, injury etc.)
        active_load = (
            db.query(models.SwimmerLoadEvent)
            .filter(
                models.SwimmerLoadEvent.swimmer_id == s.id,
                models.SwimmerLoadEvent.date_from <= today,
                or_(
                    models.SwimmerLoadEvent.date_to == None,
                    models.SwimmerLoadEvent.date_to >= today,
                ),
            )
            .all()
        )
        for ev in active_load:
            parts.append(f"⚠ {ev.event_type}" + (f": {ev.description[:40]}" if ev.description else ""))

        # Attendance stats
        att = build_attendance_stats(s.id, db)
        if att["overall_total"]:
            att_str = f"{att['overall_pct']}% overall"
            if att["four_week_total"]:
                att_str += f", {att['four_week_pct']}% last 4wk ({att['four_week_attended']}/{att['four_week_total']} sessions)"
            parts.append(att_str)

        lines.append("  " + " | ".join(parts))

    return "\n".join(lines)


def build_recent_sessions_summary(db: DBSession, weeks: int = 3) -> str:
    """
    Summary of the last N weeks of sessions — what was trained and roughly who attended.
    Gives the AI awareness of recent training without full session detail.
    """
    from datetime import date as date_type, timedelta

    cutoff = date_type.today() - timedelta(weeks=weeks)
    sessions = (
        db.query(models.Session)
        .filter(
            models.Session.date >= cutoff,
            models.Session.status != 'cancelled',
        )
        .order_by(models.Session.date.desc())
        .limit(20)
        .all()
    )
    if not sessions:
        return ""

    lines = [f"RECENT SESSIONS (last {weeks} weeks):"]
    for s in sessions:
        entry_count = (
            db.query(models.SessionEntry)
            .filter(models.SessionEntry.session_id == s.id)
            .count()
        )
        attendance = (
            db.query(models.SessionEntry)
            .filter(
                models.SessionEntry.session_id == s.id,
                models.SessionEntry.attended == True,
            )
            .count()
        )
        title = s.title or s.energy_system_focus or "Session"
        focus = f" [{s.energy_system_focus}]" if s.energy_system_focus and s.energy_system_focus not in title else ""
        intent = f" — {s.coach_intent[:80]}" if s.coach_intent else ""
        reg_status = f" [register taken — {attendance} attended]" if entry_count > 0 else " [no register yet]"
        lines.append(f"  {s.date} | {title}{focus}{reg_status}{intent}")

    return "\n".join(lines)


def get_swimmer_full_context(swimmer: models.Swimmer, db: DBSession) -> str:
    """Full swimmer context block for injection when a swimmer is mentioned by name."""
    profile = build_swimmer_context(swimmer, db)
    group = build_peer_context(swimmer, db)
    return f"DETAILED PROFILE — {swimmer.name.upper()}:\n{profile}\n\n{group}" if group else f"DETAILED PROFILE — {swimmer.name.upper()}:\n{profile}"


def build_peer_context(swimmer: models.Swimmer, db: DBSession) -> str:
    """
    How this swimmer sits within the group — recent group assignment, comparable squad peers.
    Helps the AI understand individual needs in the context of the group coaching reality.
    """
    from datetime import date as date_type, timedelta

    lines = []

    # Most recent group assignment
    recent_entry = (
        db.query(models.SessionEntry)
        .join(models.Session)
        .filter(
            models.SessionEntry.swimmer_id == swimmer.id,
            models.SessionEntry.attended == True,
            models.SessionEntry.group_done.isnot(None),
        )
        .order_by(models.Session.date.desc())
        .first()
    )
    if recent_entry:
        lines.append(f"Most recent group: Group {recent_entry.group_done}")

    # Squad peers — swimmers in same squad with overlapping target events
    if swimmer.squad or swimmer.target_events:
        peers = (
            db.query(models.Swimmer)
            .filter(
                models.Swimmer.id != swimmer.id,
                models.Swimmer.status == 'active',
                models.Swimmer.squad == swimmer.squad,
            )
            .limit(20)
            .all()
        )
        target_events = set()
        for e in (swimmer.target_events or []):
            ev = e['event'] if isinstance(e, dict) else str(e)
            target_events.add(ev.lower())

        similar = []
        for p in peers:
            peer_events = set()
            for e in (p.target_events or []):
                ev = e['event'] if isinstance(e, dict) else str(e)
                peer_events.add(ev.lower())
            if target_events & peer_events:
                similar.append(p.name)

        if similar:
            lines.append(f"Squad peers (overlapping events): {', '.join(similar[:5])}")

    # Recent session load vs squad average
    four_weeks = date_type.today() - timedelta(weeks=4)
    swimmer_count = (
        db.query(models.SessionEntry)
        .join(models.Session)
        .filter(
            models.SessionEntry.swimmer_id == swimmer.id,
            models.SessionEntry.attended == True,
            models.Session.date >= four_weeks,
        )
        .count()
    )
    # Squad average for same period
    squad_swimmers = (
        db.query(models.Swimmer)
        .filter(models.Swimmer.status == 'active', models.Swimmer.squad == swimmer.squad)
        .all()
    )
    if squad_swimmers:
        total = 0
        for s in squad_swimmers:
            total += (
                db.query(models.SessionEntry)
                .join(models.Session)
                .filter(
                    models.SessionEntry.swimmer_id == s.id,
                    models.SessionEntry.attended == True,
                    models.Session.date >= four_weeks,
                )
                .count()
            )
        avg = total / len(squad_swimmers)
        diff = swimmer_count - avg
        diff_str = f"+{diff:.0f}" if diff > 0 else f"{diff:.0f}"
        lines.append(f"Last 4-week sessions: {swimmer_count} (squad avg {avg:.0f}, {diff_str} vs avg)")

    return "GROUP CONTEXT:\n" + "\n".join(f"  {l}" for l in lines) if lines else ""


def build_meets_context(db: DBSession, months_ahead: int = 3) -> str:
    """
    Upcoming meets and per-meet targets. Injected when competition/race topics are detected.
    """
    from datetime import date as date_type, timedelta

    today = date_type.today()
    cutoff = today + timedelta(days=months_ahead * 30)

    meets = (
        db.query(models.Meet)
        .filter(models.Meet.date >= today, models.Meet.date <= cutoff)
        .order_by(models.Meet.date)
        .all()
    )
    if not meets:
        return ""

    lines = [f"UPCOMING MEETS (next {months_ahead} months):"]
    for m in meets:
        date_str = m.date.isoformat() if m.date else "date TBC"
        end_str = f"–{m.date_to.isoformat()}" if m.date_to else ""
        course = f" {m.course}" if m.course else ""
        level = f" [{m.level}]" if m.level else ""
        lines.append(f"  {m.name} | {date_str}{end_str}{course}{level} | {m.location or ''}")

        targets = (
            db.query(models.MeetTarget)
            .filter(models.MeetTarget.meet_id == m.id)
            .all()
        )
        for t in targets:
            swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == t.swimmer_id).first()
            if not swimmer:
                continue
            events_str = ", ".join(t.events or [])
            priority = f" (Priority {t.priority})" if t.priority else ""
            target_times = ""
            if t.target_times:
                tt = [f"{ev}: {tm}" for ev, tm in (t.target_times or {}).items()]
                target_times = " | targets: " + ", ".join(tt[:3])
            lines.append(f"    → {swimmer.name}{priority}: {events_str}{target_times}")

    return "\n".join(lines)


def build_periodization_context(db: DBSession) -> str:
    """
    Active and recent periodization plans across the squad. Injected when planning topics detected.
    """
    from datetime import date as date_type, timedelta

    today = date_type.today()
    recent = today - timedelta(days=14)

    plans = (
        db.query(models.PeriodizationPlan)
        .join(models.Swimmer)
        .filter(
            models.Swimmer.status == 'active',
            models.PeriodizationPlan.date_to >= recent,
        )
        .order_by(models.PeriodizationPlan.plan_type, models.PeriodizationPlan.date_from)
        .all()
    )
    if not plans:
        return ""

    lines = ["PERIODIZATION PLANS (active/recent):"]
    for p in plans:
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == p.swimmer_id).first()
        if not swimmer:
            continue
        date_range = f"{p.date_from} – {p.date_to}" if p.date_from and p.date_to else ""
        focus = f" | focus: {p.focus[:80]}" if p.focus else ""
        approved = " ✓" if p.coach_approved else " (pending approval)"
        lines.append(f"  {swimmer.name} | {p.plan_type}{approved} | {date_range}{focus}")

    return "\n".join(lines)


def extract_slot_hint(message: str) -> dict:
    """
    Extract day-of-week and AM/PM hints from natural language.
    e.g. "Monday PM" → { dow: 0, time_period: "PM" }
    """
    msg = message.lower()
    days = {'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
            'friday': 4, 'saturday': 5, 'sunday': 6,
            'mon': 0, 'tue': 1, 'tues': 1, 'wed': 2, 'thu': 3,
            'thur': 3, 'thurs': 3, 'fri': 4, 'sat': 5, 'sun': 6}
    dow = None
    for name, d in days.items():
        if name in msg:
            dow = d
            break
    time_period = None
    if ' am' in msg or 'morning' in msg or 'am session' in msg:
        time_period = 'AM'
    elif ' pm' in msg or 'evening' in msg or 'afternoon' in msg or 'pm session' in msg:
        time_period = 'PM'
    return {'dow': dow, 'time_period': time_period}


def build_session_writing_context(db: DBSession, slot_hint: dict = None) -> str:
    """
    Context injected when session writing intent is detected.
    Includes: matching slot info, expected attendees with compact profiles,
    recent session history, and current periodization focus.
    """
    from datetime import date as date_type, timedelta

    today = date_type.today()
    lines = []

    # Find relevant pool slots
    slot_q = db.query(models.PoolSlot).filter(models.PoolSlot.active == True)
    if slot_hint and slot_hint.get('dow') is not None:
        slot_q = slot_q.filter(models.PoolSlot.day_of_week == slot_hint['dow'])
    slots = slot_q.order_by(models.PoolSlot.day_of_week, models.PoolSlot.time).all()

    # Filter by AM/PM if hinted
    if slot_hint and slot_hint.get('time_period'):
        period = slot_hint['time_period']
        filtered = []
        for s in slots:
            if s.time:
                h = int(s.time.split(':')[0])
                is_am = h < 12
                if (period == 'AM' and is_am) or (period == 'PM' and not is_am):
                    filtered.append(s)
        if filtered:
            slots = filtered

    DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    for slot in slots[:3]:  # cap at 3 slots to avoid prompt bloat
        day = DAY_NAMES[slot.day_of_week] if 0 <= slot.day_of_week <= 6 else '?'
        course = f" {slot.course}" if slot.course else ""
        label = slot.label or slot.squad or ""
        lines.append(f"\nSESSION SLOT: {day} {slot.time}{course} — {label}")

        # Expected attendees for this slot
        swimmer_links = (
            db.query(models.SwimmerSlot)
            .filter(models.SwimmerSlot.pool_slot_id == slot.id)
            .all()
        )
        swimmer_ids = [l.swimmer_id for l in swimmer_links]
        if not swimmer_ids:
            lines.append("  No swimmers assigned to this slot yet.")
            continue

        swimmers = (
            db.query(models.Swimmer)
            .filter(models.Swimmer.id.in_(swimmer_ids), models.Swimmer.status == 'active')
            .order_by(models.Swimmer.name)
            .all()
        )
        lines.append(f"  Expected attendees ({len(swimmers)}):")

        for s in swimmers:
            parts = [f"    {s.name}"]

            # Target events
            if s.target_events:
                evs = [e['event'] if isinstance(e, dict) else str(e) for e in s.target_events[:2]]
                parts.append(", ".join(evs))

            # Physical profile snippet
            if s.physical_profile and isinstance(s.physical_profile, dict):
                aerobic = s.physical_profile.get('aerobic_base') or s.physical_profile.get('aerobic_capacity')
                if aerobic:
                    parts.append(f"aerobic: {str(aerobic)[:50]}")

            # Most recent group
            last_entry = (
                db.query(models.SessionEntry)
                .join(models.Session)
                .filter(
                    models.SessionEntry.swimmer_id == s.id,
                    models.SessionEntry.attended == True,
                    models.SessionEntry.group_done.isnot(None),
                )
                .order_by(models.Session.date.desc())
                .first()
            )
            if last_entry:
                parts.append(f"last group: {last_entry.group_done}")

            # Active load events (injury/illness)
            active_load = (
                db.query(models.SwimmerLoadEvent)
                .filter(
                    models.SwimmerLoadEvent.swimmer_id == s.id,
                    models.SwimmerLoadEvent.date_from <= today,
                    models.SwimmerLoadEvent.date_to >= today,
                )
                .first()
            )
            if active_load:
                parts.append(f"⚠ {active_load.event_type}")

            lines.append(" | ".join(parts))

    # Recent sessions (last 2 weeks — closer look than usual snapshot)
    cutoff = today - timedelta(weeks=2)
    recent = (
        db.query(models.Session)
        .filter(models.Session.date >= cutoff, models.Session.status != 'cancelled')
        .order_by(models.Session.date.desc())
        .limit(8)
        .all()
    )
    if recent:
        lines.append("\nRECENT SESSIONS (last 2 weeks):")
        for s in recent:
            focus = f" [{s.energy_system_focus}]" if s.energy_system_focus else ""
            intent = f" — {s.coach_intent[:80]}" if s.coach_intent else ""
            lines.append(f"  {s.date} | {s.title or 'Session'}{focus}{intent}")

        # Energy system distribution across those sessions
        focus_counts: dict = {}
        for s in recent:
            f = s.energy_system_focus
            if f:
                focus_counts[f] = focus_counts.get(f, 0) + 1
        if focus_counts:
            dist = ", ".join(f"{v}x {k}" for k, v in sorted(focus_counts.items(), key=lambda x: -x[1]))
            lines.append(f"  Distribution: {dist} (of {len(recent)} sessions with focus logged)")

    # Per-swimmer energy system exposure over last 2 weeks
    # For each expected attendee, count sessions attended by focus type
    swimmer_ids_in_slots = []
    for slot in slots[:3]:
        links = db.query(models.SwimmerSlot).filter(models.SwimmerSlot.pool_slot_id == slot.id).all()
        for l in links:
            if l.swimmer_id not in swimmer_ids_in_slots:
                swimmer_ids_in_slots.append(l.swimmer_id)

    if swimmer_ids_in_slots and recent:
        session_ids = [s.id for s in recent]
        lines.append("\nENERGY SYSTEM EXPOSURE (last 2 weeks, per swimmer):")
        for sid in swimmer_ids_in_slots[:12]:  # cap to avoid prompt bloat
            swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == sid, models.Swimmer.status == 'active').first()
            if not swimmer:
                continue
            entries = (
                db.query(models.SessionEntry, models.Session)
                .join(models.Session, models.SessionEntry.session_id == models.Session.id)
                .filter(
                    models.SessionEntry.swimmer_id == sid,
                    models.SessionEntry.attended == True,
                    models.SessionEntry.session_id.in_(session_ids),
                )
                .all()
            )
            if not entries:
                continue
            focus_dist: dict = {}
            for entry, sess in entries:
                f = sess.energy_system_focus or 'unlogged'
                focus_dist[f] = focus_dist.get(f, 0) + 1

            dist_str = ", ".join(f"{v}x {k}" for k, v in sorted(focus_dist.items(), key=lambda x: -x[1]))

            # Pull coaching intent notes for this swimmer
            intent_obs = (
                db.query(models.SwimmerObservation)
                .filter(
                    models.SwimmerObservation.swimmer_id == sid,
                    models.SwimmerObservation.obs_type == 'coaching_intent',
                )
                .order_by(models.SwimmerObservation.date.desc())
                .limit(2)
                .all()
            )
            intent_str = ""
            if intent_obs:
                intent_str = " | STATED INTENT: " + " / ".join(o.content[:80] for o in intent_obs)

            lines.append(f"  {swimmer.name}: {dist_str}{intent_str}")

    # Coaching intent notes (squad-wide or unlinked)
    squad_intent_obs = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.obs_type == 'coaching_intent')
        .order_by(models.SwimmerObservation.date.desc())
        .limit(5)
        .all()
    )
    if squad_intent_obs:
        lines.append("\nRECENT COACHING INTENT NOTES:")
        for o in squad_intent_obs:
            swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == o.swimmer_id).first()
            name = swimmer.name if swimmer else "Squad"
            lines.append(f"  [{o.date}] {name}: {o.content[:120]}")

    # Current periodization focus
    period_ctx = build_periodization_context(db)
    if period_ctx:
        lines.append(f"\n{period_ctx}")

    return "\n".join(lines) if lines else ""


def detect_topics(message: str, history: list) -> set:
    """
    Keyword-based topic detection across current message + recent conversation.
    Returns a set of topic tags used to decide which extra context to inject.
    """
    full = message.lower()
    for msg in history[-6:]:
        full += " " + msg.get("content", "").lower()

    topics = set()

    if any(k in full for k in [
        'meet', 'competition', 'race', 'taper', 'peak', 'entry', 'competing',
        'championship', 'qualifier', 'gala', 'competing', 'coventry', 'nationals',
        'regionals', 'open water', 'time trial', 'warm up', 'heat', 'final',
    ]):
        topics.add('competition')

    if any(k in full for k in [
        'season', 'macro', 'meso', 'micro', 'periodization', 'periodisation',
        'plan', 'block', 'cycle', 'phase', 'training plan', 'annual plan',
        'long term', 'next season', 'pre-season',
    ]):
        topics.add('planning')

    if any(k in full for k in [
        'biological', 'physiology', 'physiological', 'vo2', 'lactate', 'aerobic',
        'anaerobic', 'maturation', 'growth', 'puberty', 'development', 'ltad',
        'heart rate', 'threshold', 'alactic', 'glycolytic', 'oxidative',
        'body composition', 'muscle', 'hormones', 'testosterone', 'adaptation',
    ]):
        topics.add('biological')

    if any(k in full for k in [
        'performance', 'pb', 'personal best', 'times', 'splits', 'wa points',
        'ranking', 'progression', 'trend', 'best time', 'improvement',
    ]):
        topics.add('performance')

    if any(k in message.lower() for k in [
        'add a meet', 'create a meet', 'new meet', 'add meet', 'log a meet',
        'add a competition', 'create a competition', 'add a gala', 'new gala',
        'entering a meet', 'we have a meet', 'there is a meet', "there's a meet",
    ]):
        topics.add('meet_creation')

    # Session writing — trigger on current message for opening intent (generate or review mode)
    if any(k in message.lower() for k in [
        'make a session', 'write a session', 'plan a session', 'design a session',
        'build a session', 'create a session', "let's do a session", "let's plan",
        'session for monday', 'session for tuesday', 'session for wednesday',
        'session for thursday', 'session for friday', 'session for saturday', 'session for sunday',
        'session for tomorrow', 'session for today', 'monday session', 'tuesday session',
        'wednesday session', 'thursday session', 'friday session', 'saturday session',
        # review mode — coach describes their session for feedback
        "i'm thinking", "i was thinking", 'what do you think of this', 'have a look at this',
        'does this work', 'does this make sense', 'is this okay', 'check this session',
        'review this', 'thoughts on this session', 'i want to do',
        'thinking of doing', 'thinking about doing',
    ]):
        topics.add('session_writing')

    if any(k in message.lower() for k in [
        'take a register', 'taking register', 'do the register', 'take register',
        'mark attendance', 'register for', "let's do register", "let's take attendance",
        'who attended', 'attendance for',
    ]):
        topics.add('register')

    if any(k in full for k in [
        'benchmark', 'aerobic 100', 'aerobic 50', 'aerobic 200', 'max 50', 'max 25',
        'threshold 100', 'threshold 200', 'holding', 'was hitting', 'was doing',
        'came in on', 'going on', 'hit a', 'log a time', 'log that', 'note that time',
        'training time', 'set target', 'new target', 'target for', 'wants to hit',
        'goal time', 'aim for',
    ]):
        topics.add('benchmark')

    if any(k in full for k in [
        'needs to do more', 'needs more', 'should focus on', 'i think she needs',
        'i think he needs', 'i think they need', 'we should work on', 'not doing enough',
        'lacking', 'weak point', 'holding them back', 'i want to focus', 'priority for',
        'going forward', 'this block', 'next block', 'for the next',
    ]):
        topics.add('coaching_intent')

    return topics


def classify_intent(messages: list, mentioned_swimmers: list, db: DBSession) -> dict:
    """
    Lightweight AI call to classify what the conversation is building towards.
    Returns suggested_action dict or None.
    Only called when there are ≥3 messages to avoid premature suggestions.
    """
    if len(messages) < 3:
        return {"intent": "general", "suggested_action": None}

    swimmer_names = [s.name for s in mentioned_swimmers]
    conversation_snippet = "\n".join(
        f"{'Coach' if m['role'] == 'user' else 'AI'}: {m['content'][:200]}"
        for m in messages[-8:]
    )

    prompt = f"""Classify this coaching conversation. Swimmers mentioned: {', '.join(swimmer_names) or 'none'}.

CONVERSATION:
{conversation_snippet}

Return JSON only:
{{
  "intent": one of ["biological_profile","race_profile","training_profile","performance_analysis","session_writing","meet_creation","session_plan","meet_prep","season_plan","coaching_intent","general"],
  "swimmer_name": "first name only, or null if squad-wide discussion",
  "confidence": "high" or "low",
  "suggested_action": "short label e.g. 'Save to Tom\\'s biological profile' or 'Create this session' — or null if general chat or low confidence"
}}

Rules:
- biological_profile: discussing physiology, adaptation, development, aerobic/anaerobic profile of a specific swimmer
- race_profile: analysing race tactics, split patterns, competition performance of a specific swimmer
- training_profile: discussing training response, session tolerance, load management of a specific swimmer
- performance_analysis: reviewing times data, PBs, progression trends, WA points of a specific swimmer
- session_writing: actively designing/writing a specific training session (groups, sets, structure) — suggested_action should be "Create this session"
- meet_creation: adding a new competition meet with swimmer entries and events — suggested_action should be "Create this meet"
- session_plan: planning a specific upcoming session or short period (days)
- meet_prep: preparing a swimmer for a specific upcoming competition
- season_plan: discussing macro/meso structure, annual planning
- coaching_intent: coach has stated a training direction or priority for a swimmer (e.g. "needs more aerobic work", "should focus on X this block") and the conversation has examined and refined it — suggested_action should be "Save intent to [swimmer name]'s profile"
- general: general coaching science, no specific save action warranted
- Only return high confidence if the conversation has clearly been building something concrete
- For session_writing, return high confidence once the session structure/groups/sets have been discussed
- For meet_creation, return high confidence once meet name/date and at least one swimmer's events have been confirmed
- For coaching_intent, return high confidence only after the intent has been discussed (not just first stated) — there should be some back-and-forth
- Return null for suggested_action if intent is general or confidence is low"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}],
    )

    try:
        data = json.loads(_strip_json(response.content[0].text))
        # Resolve swimmer name to id
        swimmer_id = None
        swimmer_full_name = None
        if data.get("swimmer_name") and mentioned_swimmers:
            name_lower = data["swimmer_name"].lower()
            for s in mentioned_swimmers:
                if name_lower in s.name.lower():
                    swimmer_id = s.id
                    swimmer_full_name = s.name
                    break
        return {
            "intent": data.get("intent", "general"),
            "swimmer_id": swimmer_id,
            "swimmer_name": swimmer_full_name,
            "confidence": data.get("confidence", "low"),
            "suggested_action": data.get("suggested_action") if data.get("confidence") == "high" else None,
        }
    except Exception:
        return {"intent": "general", "suggested_action": None}


# ---------------------------------------------------------------------------
# Swimmer context builder
# ---------------------------------------------------------------------------

def build_attendance_stats(swimmer_id: int, db: DBSession) -> dict:
    """
    Returns attendance stats for a swimmer:
      - overall_pct: % of all registered sessions attended (all time)
      - four_week_pct: % attended in last 4 weeks
      - four_week_attended / four_week_total: raw counts
      - per_slot: {slot_label: {"attended": N, "total": N, "pct": N}} — per scheduled slot
      - weekly: [{week: "YYYY-WNN", attended: N, available: N}] last 8 weeks
    """
    from datetime import date as date_type, timedelta

    today = date_type.today()
    four_weeks_ago = today - timedelta(weeks=4)

    # All-time
    all_entries = (
        db.query(models.SessionEntry)
        .filter(models.SessionEntry.swimmer_id == swimmer_id)
        .all()
    )
    all_total = len(all_entries)
    all_attended = sum(1 for e in all_entries if e.attended)
    overall_pct = round(all_attended / all_total * 100) if all_total else None

    # Last 4 weeks
    recent_entries = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer_id,
            models.Session.date >= four_weeks_ago,
            models.Session.status != 'cancelled',
        )
        .all()
    )
    four_week_total = len(recent_entries)
    four_week_attended = sum(1 for e, _ in recent_entries if e.attended)
    four_week_pct = round(four_week_attended / four_week_total * 100) if four_week_total else None

    # Per slot — join session to slot via time+squad matching
    # Use pool slot assignments for this swimmer
    swimmer_slots = (
        db.query(models.SwimmerSlot)
        .filter(models.SwimmerSlot.swimmer_id == swimmer_id)
        .all()
    )
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    per_slot = {}
    for ss in swimmer_slots:
        slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == ss.pool_slot_id).first()
        if not slot:
            continue
        label = f"{days[slot.day_of_week]} {slot.time}"
        if slot.label:
            label += f" ({slot.label})"
        # Match sessions by day of week + approximate time
        slot_sessions = (
            db.query(models.Session)
            .filter(
                models.Session.status != 'cancelled',
                models.Session.squad == slot.squad if slot.squad else True,
            )
            .all()
        )
        # Filter by day of week match
        matching = [s for s in slot_sessions if s.date.weekday() == slot.day_of_week]
        if not matching:
            continue
        session_ids = [s.id for s in matching]
        slot_entries = (
            db.query(models.SessionEntry)
            .filter(
                models.SessionEntry.swimmer_id == swimmer_id,
                models.SessionEntry.session_id.in_(session_ids),
            )
            .all()
        )
        if not slot_entries:
            continue
        slot_attended = sum(1 for e in slot_entries if e.attended)
        per_slot[label] = {
            "attended": slot_attended,
            "total": len(slot_entries),
            "pct": round(slot_attended / len(slot_entries) * 100),
        }

    # Weekly breakdown — last 8 weeks
    eight_weeks_ago = today - timedelta(weeks=8)
    weekly_rows = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer_id,
            models.Session.date >= eight_weeks_ago,
            models.Session.status != 'cancelled',
        )
        .all()
    )
    week_map: dict = {}
    for entry, session in weekly_rows:
        iso = session.date.isocalendar()
        key = f"{iso[0]}-W{iso[1]:02d}"
        if key not in week_map:
            week_map[key] = {"week": key, "attended": 0, "total": 0}
        week_map[key]["total"] += 1
        if entry.attended:
            week_map[key]["attended"] += 1
    weekly = sorted(week_map.values(), key=lambda x: x["week"])

    return {
        "overall_pct": overall_pct,
        "overall_attended": all_attended,
        "overall_total": all_total,
        "four_week_pct": four_week_pct,
        "four_week_attended": four_week_attended,
        "four_week_total": four_week_total,
        "per_slot": per_slot,
        "weekly": weekly,
    }


def _build_training_load_context(swimmer_id: int, db: DBSession) -> str:
    """
    Build a training load and distribution context block.
    Calculates weekly volume, session spread, gaps, and clustering
    from actual attended sessions over the last 10 weeks.
    """
    from datetime import date, timedelta, datetime as dt

    ten_weeks_ago = date.today() - timedelta(weeks=10)

    rows = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer_id,
            models.SessionEntry.attended == True,
            models.Session.date >= ten_weeks_ago,
        )
        .order_by(models.Session.date.asc())
        .all()
    )

    if not rows:
        return "Training load: No attended session data in the last 10 weeks."

    day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    def session_hours(s):
        if s.start_time and s.end_time:
            try:
                start = dt.strptime(s.start_time, "%H:%M")
                end = dt.strptime(s.end_time, "%H:%M")
                diff = (end - start).seconds / 3600
                return round(diff, 2) if diff > 0 else None
            except ValueError:
                pass
        return None

    # Group attended sessions by ISO week (Monday-based)
    weeks: dict = {}
    all_dates = []
    for entry, session in rows:
        if not session.date:
            continue
        week_start = session.date - timedelta(days=session.date.weekday())
        key = week_start.isoformat()
        weeks.setdefault(key, []).append(session)
        all_dates.append(session.date)

    # Per-week stats
    week_lines = []
    all_hours = []
    all_counts = []
    for week_key in sorted(weeks.keys(), reverse=True)[:8]:  # last 8 weeks
        sessions = weeks[week_key]
        dates = sorted(set(s.date for s in sessions))
        day_labels = [day_names[d.weekday()] for d in dates]

        # Duration
        hours_list = [h for h in (session_hours(s) for s in sessions) if h]
        total_hours = round(sum(hours_list), 1) if hours_list else None
        hours_str = f"{total_hours}h" if total_hours else f"{len(sessions)} sessions (no times set)"

        # Detect back-to-back (consecutive calendar days)
        back_to_back = sum(
            1 for i in range(1, len(dates))
            if (dates[i] - dates[i - 1]).days <= 1
        )

        # Detect same-day doubles
        doubles = len(sessions) - len(dates)

        notes = []
        if doubles > 0:
            notes.append(f"{doubles} double{'s' if doubles > 1 else ''}")
        if back_to_back > 0:
            notes.append(f"{back_to_back} back-to-back")

        # Gap before next session (to next week)
        note_str = f" [{', '.join(notes)}]" if notes else ""
        week_lines.append(
            f"  {week_key}: {len(sessions)} sessions, {hours_str}"
            f" — {'/'.join(day_labels)}{note_str}"
        )
        all_hours.extend(hours_list)
        all_counts.append(len(sessions))

    # Gaps between consecutive sessions
    sorted_dates = sorted(all_dates)
    gaps = [(sorted_dates[i] - sorted_dates[i - 1]).days for i in range(1, len(sorted_dates))]
    avg_gap = round(sum(gaps) / len(gaps), 1) if gaps else None
    max_gap = max(gaps) if gaps else None
    long_gaps = [(sorted_dates[i], sorted_dates[i - 1], (sorted_dates[i] - sorted_dates[i - 1]).days)
                 for i in range(1, len(sorted_dates))
                 if (sorted_dates[i] - sorted_dates[i - 1]).days >= 5]

    # Summary stats
    avg_sessions = round(sum(all_counts) / len(all_counts), 1) if all_counts else 0
    avg_hours = round(sum(all_hours) / len(weeks), 1) if all_hours and weeks else None

    lines = ["Training load & distribution (last 10 weeks):"]
    summary_parts = [f"avg {avg_sessions} sessions/week"]
    if avg_hours:
        summary_parts.append(f"~{avg_hours}h/week")
    if avg_gap:
        summary_parts.append(f"avg {avg_gap} days between sessions")
    if max_gap:
        summary_parts.append(f"longest gap {max_gap} days")
    lines.append("  Summary: " + ", ".join(summary_parts))

    if long_gaps:
        gap_notes = [f"{g[1]} to {g[0]} ({g[2]} days)" for g in long_gaps[-3:]]
        lines.append("  Notable gaps: " + " | ".join(gap_notes))

    lines.append("  Weekly breakdown (most recent first):")
    lines.extend(week_lines)

    return "\n".join(lines)


def _swimmer_age_context(swimmer: models.Swimmer) -> Optional[str]:
    """
    Returns current age, LTAD developmental stage, and key training implications.
    Used to ensure all AI recommendations are age-appropriate.
    """
    from datetime import date as date_type
    if not swimmer.dob:
        return None

    today = date_type.today()
    age = today.year - swimmer.dob.year - (
        (today.month, today.day) < (swimmer.dob.month, swimmer.dob.day)
    )
    gender = (swimmer.gender or '').upper()

    # LTAD stage and training implications
    # Female maturation is typically ~2 years ahead of male
    if age < 12:
        stage = "FUNdamentals"
        implications = (
            "Pre-specialisation phase. Technique and movement skills are the priority. "
            "No event specialisation, no lactic/anaerobic capacity work. "
            "High-intensity work should be play-based, not structured interval training."
        )
    elif age < 14:
        stage = "Learning to Train"
        implications = (
            "Critical window for aerobic base development. High aerobic volume is the right stimulus. "
            "Heavy lactic work is not developmentally appropriate and may compromise long-term adaptation. "
            "Threshold exposure can begin carefully. Multi-event range important. "
            "Strength of aerobic base built here will define the ceiling for later performance."
        )
    elif age < 16:
        if gender == 'F':
            stage = "Training to Train (peak aerobic window)"
            implications = (
                "Females are typically in the peak aerobic development window at this age. "
                "This is the most important phase for building aerobic infrastructure. "
                "High aerobic and threshold volume appropriate. "
                "Anaerobic/lactic capacity work should be minimal and carefully introduced. "
                "Females who over-specialise in sprint/lactic work at this stage often plateau early."
            )
        else:
            stage = "Learning to Train / early Training to Train"
            implications = (
                "Males typically hit peak aerobic window slightly later (16-18). "
                "Aerobic base and threshold development remain the priority. "
                "Some VO2max work beginning to be appropriate. "
                "Lactic/anaerobic capacity training should still be limited."
            )
    elif age < 18:
        if gender == 'F':
            stage = "Training to Compete"
            implications = (
                "Full aerobic infrastructure should now be in place. "
                "Training specificity and competition preparation increasing. "
                "Lactic and anaerobic capacity work now appropriate and important. "
                "Event focus narrowing. Periodization and peaking becoming relevant."
            )
        else:
            stage = "Training to Train (peak aerobic window for males)"
            implications = (
                "Males are typically now in their peak aerobic development window. "
                "Aerobic and VO2max work should still dominate. "
                "Threshold and some lactic work appropriate. "
                "Full anaerobic capacity training not yet the priority."
            )
    elif age < 21:
        stage = "Training to Compete"
        implications = (
            "Full training spectrum now appropriate. "
            "Lactic/anaerobic capacity development is a legitimate training priority. "
            "Periodization and competition-specific preparation are central. "
            "Recovery management becomes increasingly important as load increases."
        )
    else:
        stage = "Training to Win / Senior"
        implications = (
            "Mature athlete — all energy systems and training methods appropriate. "
            "Load management, recovery, and individualised periodization are key levers. "
            "Long-term training age and accumulated fatigue are important considerations."
        )

    return (
        f"Current age: {age} | DOB: {swimmer.dob} | Gender: {gender or '?'}\n"
        f"LTAD stage: {stage}\n"
        f"Age/development implications: {implications}"
    )


def build_swimmer_context(swimmer: models.Swimmer, db: DBSession) -> str:
    """Build a rich text context block about a swimmer for use in AI prompts."""
    parts = [f"Swimmer: {swimmer.name}"]

    # Age and developmental stage — surfaced prominently so all AI features are age-aware
    age_ctx = _swimmer_age_context(swimmer)
    if age_ctx:
        parts.append(age_ctx)
    elif swimmer.dob:
        parts.append(f"DOB: {swimmer.dob}")

    if swimmer.gender and not swimmer.dob:  # avoid repeating if already in age_ctx
        parts.append(f"Gender: {swimmer.gender}")
    if swimmer.squad:
        parts.append(f"Squad: {swimmer.squad}")
    if swimmer.target_events:
        events_str = ", ".join(
            f"{e['event']} ({e.get('course','?')})" if isinstance(e, dict) else str(e)
            for e in swimmer.target_events
        )
        parts.append(f"Target events: {events_str}")
    if swimmer.course_bias:
        parts.append(f"Course bias: {swimmer.course_bias.replace('_', ' ')}")
    if swimmer.strengths:
        parts.append(f"Strengths: {swimmer.strengths}")
    if swimmer.weaknesses:
        parts.append(f"Weaknesses: {swimmer.weaknesses}")
    if swimmer.profile_notes:
        parts.append(f"Coach notes: {swimmer.profile_notes}")
    if swimmer.physical_profile:
        parts.append(f"Physical profile: {json.dumps(swimmer.physical_profile, indent=2)}")
    if swimmer.psychological_profile:
        parts.append(f"Psychological profile: {json.dumps(swimmer.psychological_profile, indent=2)}")

    # Latest versioned race and training profiles
    latest_race = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "race",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    if latest_race:
        parts.append(f"Race profile (as of {latest_race.created_at.date() if latest_race.created_at else 'unknown'}):\n{json.dumps(latest_race.data, indent=2)}")

    latest_training = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    if latest_training:
        parts.append(f"Training response profile (as of {latest_training.created_at.date() if latest_training.created_at else 'unknown'}):\n{json.dumps(latest_training.data, indent=2)}")

    latest_biological = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "biological",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    if latest_biological:
        parts.append(f"Biological profile (as of {latest_biological.created_at.date() if latest_biological.created_at else 'unknown'}):\n{json.dumps(latest_biological.data, indent=2)}")

    latest_perf = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "performance_analysis",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    if latest_perf:
        parts.append(f"Performance analysis (as of {latest_perf.created_at.date() if latest_perf.created_at else 'unknown'}):\n{json.dumps(latest_perf.data, indent=2)}")

    latest_technical = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "technical",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    if latest_technical:
        parts.append(f"Technical profile (as of {latest_technical.created_at.date() if latest_technical.created_at else 'unknown'}):\n{json.dumps(latest_technical.data, indent=2)}")

    # Training benchmarks — current best per distance/stroke/effort
    all_benchmarks = (
        db.query(models.BenchmarkLog)
        .filter(models.BenchmarkLog.swimmer_id == swimmer.id)
        .order_by(models.BenchmarkLog.date.desc())
        .all()
    )
    if all_benchmarks:
        seen = {}
        for b in all_benchmarks:
            key = (b.distance, b.stroke, b.effort)
            if key not in seen:
                seen[key] = b
        bench_lines = [
            f"  {b.distance}m {b.stroke} ({b.effort}): {_format_time(b.time_seconds)} [{b.date}]"
            for b in seen.values()
        ]
        parts.append("Training benchmarks (current):\n" + "\n".join(bench_lines))

    # Swimmer targets
    targets = (
        db.query(models.SwimmerTarget)
        .filter(models.SwimmerTarget.swimmer_id == swimmer.id, models.SwimmerTarget.achieved == False)
        .order_by(models.SwimmerTarget.deadline)
        .all()
    )
    if targets:
        target_lines = []
        for t in targets:
            line = f"  {t.label}"
            if t.target_time_seconds:
                line += f": {_format_time(t.target_time_seconds)}"
            if t.deadline:
                line += f" by {t.deadline}"
            if t.description:
                line += f" — {t.description}"
            target_lines.append(line)
        parts.append("Active targets:\n" + "\n".join(target_lines))

    # Training history narrative (background — previous clubs, gaps, context)
    training_history = (
        db.query(models.TrainingHistoryNarrative)
        .filter(
            models.TrainingHistoryNarrative.swimmer_id == swimmer.id,
            models.TrainingHistoryNarrative.source != "racing",
        )
        .order_by(models.TrainingHistoryNarrative.created_at.desc())
        .first()
    )
    if training_history:
        parts.append(f"Training history:\n{training_history.narrative}")

    # Racing narrative (coach's observations on this swimmer's racing — distinct from training background)
    racing_narrative = (
        db.query(models.TrainingHistoryNarrative)
        .filter(
            models.TrainingHistoryNarrative.swimmer_id == swimmer.id,
            models.TrainingHistoryNarrative.source == "racing",
        )
        .order_by(models.TrainingHistoryNarrative.created_at.desc())
        .first()
    )
    if racing_narrative:
        parts.append(f"Racing observations (coach's view of this swimmer's racing patterns and history):\n{racing_narrative.narrative}")

    # Observations — grouped by type so the AI gets a structured picture
    observations = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.swimmer_id == swimmer.id)
        .order_by(models.SwimmerObservation.date.desc())
        .limit(40)
        .all()
    )
    if observations:
        by_type = {}
        for o in observations:
            by_type.setdefault(o.obs_type, []).append(o)
        obs_parts = []
        type_labels = {
            "race": "Race observations",
            "aerobic": "Aerobic training responses",
            "threshold": "Threshold training responses",
            "coaching_intent": "Coaching intent / training direction",
            "vo2": "VO2/Hard training responses",
            "speed": "Speed/Sprint responses",
            "recovery": "Recovery observations",
            "physical": "Physical markers",
            "general": "General observations",
        }
        for obs_type, items in by_type.items():
            label = type_labels.get(obs_type, obs_type.capitalize())
            obs_parts.append(f"\n{label}:")
            for o in items[:6]:  # cap per type to avoid token bloat
                date_str = f" ({o.date})" if o.date else ""
                event_str = f" [{o.event}]" if o.event else ""
                obs_parts.append(f"  -{date_str}{event_str} {o.content}")
                if o.structured:
                    for k, v in o.structured.items():
                        if v:
                            obs_parts.append(f"    {k}: {v}")
        parts.append("Observations:\n" + "\n".join(obs_parts))

    # Recent load events (last 6 months)
    from datetime import date, timedelta
    six_months_ago = date.today() - timedelta(days=180)
    load_events = (
        db.query(models.SwimmerLoadEvent)
        .filter(
            models.SwimmerLoadEvent.swimmer_id == swimmer.id,
            models.SwimmerLoadEvent.date_from >= six_months_ago,
        )
        .order_by(models.SwimmerLoadEvent.date_from.desc())
        .all()
    )
    if load_events:
        severity_label = {1: "mild", 2: "moderate", 3: "significant"}
        event_lines = [
            f"  - {e.event_type} ({severity_label.get(e.severity,'?')} severity): {e.date_from}"
            + (f" to {e.date_to}" if e.date_to else "")
            + (f" — {e.description}" if e.description else "")
            + ("" if e.resolved else " [ONGOING]")
            for e in load_events
        ]
        parts.append("Recent load events (last 6 months):\n" + "\n".join(event_lines))

    # Attendance stats
    att = build_attendance_stats(swimmer.id, db)
    if att["overall_total"]:
        att_lines = [
            f"Attendance: {att['overall_pct']}% overall ({att['overall_attended']}/{att['overall_total']} sessions)"
        ]
        if att["four_week_total"]:
            att_lines.append(f"  Last 4 weeks: {att['four_week_pct']}% ({att['four_week_attended']}/{att['four_week_total']} sessions)")
        if att["per_slot"]:
            att_lines.append("  Per slot:")
            for slot_label, v in att["per_slot"].items():
                att_lines.append(f"    {slot_label}: {v['pct']}% ({v['attended']}/{v['total']})")
        if att["weekly"]:
            week_strs = [f"{w['week']}: {w['attended']}/{w['total']}" for w in att["weekly"][-8:]]
            att_lines.append(f"  Weekly (last 8wk): {', '.join(week_strs)}")
        parts.append("\n".join(att_lines))

    # Training load & distribution (last 10 weeks)
    parts.append(_build_training_load_context(swimmer.id, db))

    # Recent times (last 20)
    recent_times = (
        db.query(models.SwimTime)
        .filter(models.SwimTime.swimmer_id == swimmer.id)
        .order_by(models.SwimTime.date.desc())
        .limit(20)
        .all()
    )
    if recent_times:
        time_lines = [
            f"  {t.event}: {_format_time(t.time_seconds)} ({t.date}) at {t.meet or 'training'}"
            for t in recent_times
        ]
        parts.append("Recent times (most recent first):\n" + "\n".join(time_lines))

    # Most recent readiness / fatigue assessment
    latest_readiness = (
        db.query(models.AIAnalysis)
        .filter(
            models.AIAnalysis.swimmer_id == swimmer.id,
            models.AIAnalysis.analysis_type == "readiness",
        )
        .order_by(models.AIAnalysis.created_at.desc())
        .first()
    )
    if latest_readiness:
        try:
            r = json.loads(latest_readiness.content)
            generated = r.get("generated_at", "unknown date")
            readiness_lines = [f"Readiness & fatigue assessment (generated {generated}):"]
            if r.get("current_state"):
                readiness_lines.append(f"  Current state: {r['current_state']}")
            if r.get("fatigue_level"):
                readiness_lines.append(f"  Fatigue level: {r['fatigue_level']}")
            if r.get("readiness_score") is not None:
                readiness_lines.append(f"  Readiness score: {r['readiness_score']}/10")
            if r.get("short_term_forecast"):
                readiness_lines.append(f"  Short-term forecast: {r['short_term_forecast']}")
            if r.get("recommended_load"):
                readiness_lines.append(f"  Recommended load: {r['recommended_load']}")
            if r.get("flags"):
                readiness_lines.append(f"  Flags: {r['flags']}")
            if r.get("notes"):
                readiness_lines.append(f"  Notes: {r['notes']}")
            parts.append("\n".join(readiness_lines))
        except Exception:
            pass

    return "\n".join(parts)


def _format_time(seconds: float) -> str:
    if seconds is None:
        return "?"
    mins = int(seconds // 60)
    secs = seconds % 60
    if mins > 0:
        return f"{mins}:{secs:05.2f}"
    return f"{secs:.2f}"


# ---------------------------------------------------------------------------
# Benchmark extraction from conversation
# ---------------------------------------------------------------------------

def extract_benchmarks_from_conversation(conversation: str, swimmers: list, db: DBSession) -> list:
    """
    Parse a coaching conversation for training benchmark times and targets,
    then save them to the database. Returns list of saved items for confirmation.
    """
    swimmer_list = "\n".join(f"  - {s.name} (id={s.id})" for s in swimmers)
    today = date.today().isoformat()

    prompt = f"""A coach has been discussing training times. Extract any training benchmark times or targets mentioned.

TODAY: {today}

SWIMMERS IN CONTEXT:
{swimmer_list}

CONVERSATION:
{conversation}

Return a JSON array of objects. Each object is either a benchmark log or a target:

For a benchmark (an actual time observed in training):
{{
  "type": "benchmark",
  "swimmer_id": <int>,
  "distance": <25|50|100|200>,
  "stroke": <"free"|"back"|"breast"|"fly">,
  "effort": <"max"|"aerobic"|"threshold">,
  "time_seconds": <float>,
  "date": "<YYYY-MM-DD>",
  "notes": "<optional context>"
}}

For a target (a goal time set by the coach):
{{
  "type": "target",
  "swimmer_id": <int>,
  "label": "<short label>",
  "distance": <int or null>,
  "stroke": <str or null>,
  "effort": <str or null>,
  "target_time_seconds": <float or null>,
  "deadline": "<YYYY-MM-DD or null>",
  "description": "<optional context>"
}}

Only include items clearly stated in the conversation. If nothing to extract, return [].
Return only the JSON array."""

    try:
        response = get_client().messages.create(
            model=MODEL,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = _strip_json(response.content[0].text.strip())
        items = json.loads(raw)
    except Exception:
        return []

    saved = []
    for item in items:
        try:
            if item.get("type") == "benchmark":
                bdate = item.get("date", today)
                # Skip if identical benchmark already saved for same date
                existing = db.query(models.BenchmarkLog).filter(
                    models.BenchmarkLog.swimmer_id == item["swimmer_id"],
                    models.BenchmarkLog.distance == item["distance"],
                    models.BenchmarkLog.stroke == item["stroke"],
                    models.BenchmarkLog.effort == item["effort"],
                    models.BenchmarkLog.date == bdate,
                ).first()
                if existing:
                    continue
                entry = models.BenchmarkLog(
                    swimmer_id=item["swimmer_id"],
                    distance=item["distance"],
                    stroke=item["stroke"],
                    effort=item["effort"],
                    time_seconds=item["time_seconds"],
                    date=bdate,
                    notes=item.get("notes"),
                    logged_by="ai",
                )
                db.add(entry)
                saved.append({"type": "benchmark", "swimmer_id": item["swimmer_id"],
                               "label": f"{item['distance']}m {item['stroke']} {item['effort']}: {_format_time(item['time_seconds'])}"})
            elif item.get("type") == "target":
                target = models.SwimmerTarget(
                    swimmer_id=item["swimmer_id"],
                    label=item["label"],
                    description=item.get("description"),
                    distance=item.get("distance"),
                    stroke=item.get("stroke"),
                    effort=item.get("effort"),
                    target_time_seconds=item.get("target_time_seconds"),
                    deadline=item.get("deadline"),
                )
                db.add(target)
                saved.append({"type": "target", "swimmer_id": item["swimmer_id"],
                               "label": item["label"]})
        except Exception:
            continue

    if saved:
        db.commit()
    return saved


def extract_coaching_intent(conversation: str, swimmers: list, db: DBSession) -> list:
    """
    Extract a coaching intent or training direction discussed and refined in conversation,
    then save as obs_type='coaching_intent' observations. Returns saved items.
    """
    swimmer_list = "\n".join(f"  - {s.name} (id={s.id})" for s in swimmers)
    today = date.today().isoformat()

    prompt = f"""A coach has been discussing training priorities or directions for specific swimmers.
Extract any concluded coaching intents — things the coach has decided or is leaning toward as a training priority for a swimmer.
Only extract if the conversation shows the intent was examined or refined, not just first mentioned.

TODAY: {today}

SWIMMERS IN CONTEXT:
{swimmer_list}

CONVERSATION:
{conversation}

Return a JSON array. Each item:
{{
  "swimmer_id": <int>,
  "swimmer_name": "<name>",
  "intent": "<concise statement of the training direction, e.g. 'Increase aerobic volume over next 4 weeks — more long aerobic sets, fewer sprint-dominant sessions'>",
  "rationale": "<brief why, from the conversation>"
}}

Only include intents that were genuinely discussed (not just mentioned once and dropped).
If nothing clear to extract, return [].
Return only the JSON array."""

    try:
        response = get_client().messages.create(
            model=MODEL,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = _strip_json(response.content[0].text.strip())
        items = json.loads(raw)
    except Exception:
        return []

    from datetime import timedelta
    dedup_cutoff = date.today() - timedelta(days=1)

    saved = []
    for item in items:
        try:
            swimmer_id = item.get("swimmer_id")
            intent_text = item.get("intent", "").strip()
            rationale = item.get("rationale", "").strip()
            if not swimmer_id or not intent_text:
                continue
            content = intent_text
            if rationale:
                content += f" — {rationale}"
            # Skip if identical content saved today (prevents re-saves on same conversation)
            existing = db.query(models.SwimmerObservation).filter(
                models.SwimmerObservation.swimmer_id == swimmer_id,
                models.SwimmerObservation.obs_type == "coaching_intent",
                models.SwimmerObservation.date >= dedup_cutoff,
                models.SwimmerObservation.content == content,
            ).first()
            if existing:
                continue
            obs = models.SwimmerObservation(
                swimmer_id=swimmer_id,
                obs_type="coaching_intent",
                date=today,
                content=content,
            )
            db.add(obs)
            saved.append({
                "swimmer_id": swimmer_id,
                "swimmer_name": item.get("swimmer_name", ""),
                "label": intent_text[:80],
            })
        except Exception:
            continue

    if saved:
        db.commit()
    return saved


# ---------------------------------------------------------------------------
# Profile conversation
# ---------------------------------------------------------------------------

PROFILE_SYSTEM_PROMPT = """You are an expert swimming coach's assistant helping to build a detailed profile of a swimmer.

Your goal is to understand both the physical and psychological dimensions of the swimmer:
- Physical: aerobic capacity, sprint vs endurance tendency, technical strengths/weaknesses, injury history, response to training load, recovery rate, response to different training stimuli
- Psychological: motivation style, how they respond to pressure and competition, coachability, mental resilience, goal orientation, how they respond to hard training

CRITICAL: The swimmer's age and developmental stage (LTAD framework) shapes all physical and psychological attributes.
When discussing training response, capacity, or psychology, always consider whether patterns are developmentally normal or indicative of something unique.
For younger swimmers (< 16), aerobic development windows, recovery capacity, and psychological development differ significantly from older athletes.

You have access to the swimmer's background and times. Ask targeted follow-up questions to fill gaps in understanding.
Be concise and specific — ask one or two questions at a time, not a list of ten.
When you have enough information, synthesise what you know into a clear coaching picture.

Always write as a professional coaching partner, not a chatbot. Speak directly and practically."""


def profile_chat(
    swimmer: models.Swimmer,
    coach_message: str,
    db: DBSession,
) -> str:
    """
    Send a message in the swimmer's profile conversation.
    Returns Claude's response.
    """
    # Build conversation history
    history = (
        db.query(models.ProfileConversation)
        .filter(models.ProfileConversation.swimmer_id == swimmer.id)
        .order_by(models.ProfileConversation.created_at.asc())
        .all()
    )

    messages = []
    for entry in history:
        messages.append({
            "role": "user" if entry.role == "coach" else "assistant",
            "content": entry.message,
        })
    messages.append({"role": "user", "content": coach_message})

    swimmer_context = build_swimmer_context(swimmer, db)
    system = get_system_prompt(db, extra=f"{PROFILE_SYSTEM_PROMPT}\n\n---\nCURRENT SWIMMER DATA:\n{swimmer_context}")

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
        messages=messages,
    )
    ai_reply = response.content[0].text

    # Persist both sides
    db.add(models.ProfileConversation(swimmer_id=swimmer.id, role="coach", message=coach_message))
    db.add(models.ProfileConversation(swimmer_id=swimmer.id, role="ai", message=ai_reply))
    db.commit()

    return ai_reply


def synthesise_profile(swimmer: models.Swimmer, db: DBSession) -> dict:
    """
    Ask Claude to synthesise the current conversation + data into structured JSON profiles.
    Updates swimmer.physical_profile and swimmer.psychological_profile.
    """
    swimmer_context = build_swimmer_context(swimmer, db)

    history = (
        db.query(models.ProfileConversation)
        .filter(models.ProfileConversation.swimmer_id == swimmer.id)
        .order_by(models.ProfileConversation.created_at.asc())
        .all()
    )
    conversation_text = "\n".join(
        f"{'Coach' if e.role == 'coach' else 'AI'}: {e.message}" for e in history
    )

    prompt = f"""Based on the swimmer data and our conversation below, synthesise a structured profile.

SWIMMER DATA:
{swimmer_context}

CONVERSATION:
{conversation_text}

Return a JSON object with two keys:
1. "physical": an object covering aerobic_base, sprint_tendency, technical_strengths, technical_weaknesses, injury_history, training_load_response, recovery_rate, current_fitness_level (all as short text descriptions)
2. "psychological": an object covering motivation_style, competition_response, coachability, resilience, goal_orientation, response_to_hard_training, notes (all as short text descriptions)

Return only the JSON, no other text."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    profile_data = json.loads(raw)

    swimmer.physical_profile = profile_data.get("physical", {})
    swimmer.psychological_profile = profile_data.get("psychological", {})
    db.commit()

    return profile_data


# ---------------------------------------------------------------------------
# Versioned profile synthesis (race + training)
# ---------------------------------------------------------------------------

def _strip_json(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return raw.strip()


def synthesise_race_profile(swimmer: models.Swimmer, db: DBSession, conversation_context: str = None) -> dict:
    """
    Synthesise a new versioned race profile from all race observations + times.
    Compares against the previous version and generates a change_summary.
    Creates a new SwimmerProfileVersion row — never overwrites.
    """
    # Fetch all race observations
    race_obs = (
        db.query(models.SwimmerObservation)
        .filter(
            models.SwimmerObservation.swimmer_id == swimmer.id,
            models.SwimmerObservation.obs_type == "race",
        )
        .order_by(models.SwimmerObservation.date.desc())
        .all()
    )

    obs_lines = []
    for o in race_obs:
        date_str = f"({o.date})" if o.date else ""
        event_str = f"[{o.event}]" if o.event else ""
        obs_lines.append(f"  - {date_str}{event_str} {o.content}")
        if o.structured:
            for k, v in o.structured.items():
                if v:
                    obs_lines.append(f"      {k}: {v}")
    obs_text = "\n".join(obs_lines) if obs_lines else "No race observations recorded yet."

    # Fetch recent times + splits
    times = (
        db.query(models.SwimTime)
        .filter(models.SwimTime.swimmer_id == swimmer.id)
        .order_by(models.SwimTime.date.desc())
        .limit(30)
        .all()
    )
    times_lines = [
        f"  {t.event}: {_format_time(t.time_seconds)} ({t.date}) at {t.meet or 'unknown meet'}"
        + (f" | splits: {t.splits}" if t.splits else "")
        for t in times
    ]
    times_text = "\n".join(times_lines) if times_lines else "No times on record."

    # Fetch previous version for comparison
    previous = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "race",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    prev_text = (
        f"Previous race profile (synthesised {previous.created_at.date()}):\n{json.dumps(previous.data, indent=2)}"
        if previous
        else "No previous race profile — this is the first synthesis."
    )

    target_events = ", ".join(
        f"{e['event']} ({e.get('course','?')})" if isinstance(e, dict) else str(e)
        for e in (swimmer.target_events or [])
    )

    # Get age context to inform race profile interpretation
    age_context = _swimmer_age_context(swimmer) or ""

    prompt = f"""You are building a versioned race profile for a swimmer based on the coach's observations and race times.

Swimmer: {swimmer.name} | Gender: {swimmer.gender or '?'} | Squad: {swimmer.squad or '?'}
Target events: {target_events or 'not set'}
Course bias: {(swimmer.course_bias or 'unknown').replace('_', ' ')}

DEVELOPMENTAL CONTEXT:
{age_context}

RACE OBSERVATIONS ({len(race_obs)} total):
{obs_text}

RACE TIMES (most recent first):
{times_text}

{prev_text}

Synthesise a race profile for this swimmer. Focus on what you can actually infer from the data — do not speculate beyond it.
Consider: some pacing/fatigue patterns may be normal for their developmental stage (e.g., younger swimmers often show larger positive splits as anaerobic capacity develops).

Return JSON with these fields:
{{
  "pacing_tendency": "how they typically pace their races",
  "split_pattern": "observed split patterns — where they gain / lose time",
  "underwater_strength": "quality of underwaters / turns if observable",
  "pressure_response": "how they perform in races vs training, under pressure",
  "fatigue_profile": "where and how technique/speed degrades across a race",
  "event_profiles": {{"event_name": "specific notes for this event", ...}},
  "course_notes": "any observed SCM vs LCM differences",
  "age_context_notes": "any patterns that relate to developmental stage or are expected to evolve with maturation",
  "change_summary": "Compared to the previous profile: what has changed, what has improved or declined, what is newly observed. If this is the first synthesis write: Initial profile — then summarise the key characteristics in 2-3 sentences."
}}

Return only JSON. Use null for fields where data is genuinely insufficient."""

    if conversation_context:
        prompt += f"\n\n--- COACHING CONVERSATION (treat this as primary source — use it to inform and supplement the structured data above) ---\n{conversation_context}"

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    profile_data = json.loads(_strip_json(response.content[0].text))
    change_summary = profile_data.pop("change_summary", None)

    version = models.SwimmerProfileVersion(
        swimmer_id=swimmer.id,
        profile_type="race",
        data=profile_data,
        change_summary=change_summary,
        obs_count=len(race_obs),
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return _profile_version_out(version)


def synthesise_training_profile(swimmer: models.Swimmer, db: DBSession, conversation_context: str = None) -> dict:
    """
    Synthesise a new versioned training response profile from all training observations.
    Compares against the previous version and generates a change_summary.
    Creates a new SwimmerProfileVersion row — never overwrites.
    """
    training_types = ["aerobic", "threshold", "vo2", "speed", "recovery"]

    training_obs = (
        db.query(models.SwimmerObservation)
        .filter(
            models.SwimmerObservation.swimmer_id == swimmer.id,
            models.SwimmerObservation.obs_type.in_(training_types),
        )
        .order_by(models.SwimmerObservation.obs_type, models.SwimmerObservation.date.desc())
        .all()
    )

    by_type: dict = {}
    for o in training_obs:
        by_type.setdefault(o.obs_type, []).append(o)

    obs_sections = []
    type_labels = {
        "aerobic": "Aerobic", "threshold": "Threshold", "vo2": "VO2/Hard",
        "speed": "Speed/Sprint", "recovery": "Recovery",
    }
    for obs_type in training_types:
        items = by_type.get(obs_type, [])
        if not items:
            continue
        obs_sections.append(f"\n{type_labels[obs_type]} ({len(items)} observations):")
        for o in items:
            date_str = f"({o.date})" if o.date else ""
            obs_sections.append(f"  - {date_str} {o.content}")
            if o.structured:
                for k, v in o.structured.items():
                    if v:
                        obs_sections.append(f"      {k}: {v}")
    obs_text = "\n".join(obs_sections) if obs_sections else "No training observations recorded yet."

    # Previous version for comparison
    previous = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    prev_text = (
        f"Previous training profile (synthesised {previous.created_at.date()}):\n{json.dumps(previous.data, indent=2)}"
        if previous
        else "No previous training profile — this is the first synthesis."
    )

    # Get age and LTAD context to inform training response characterization
    age_context = _swimmer_age_context(swimmer) or ""

    prompt = f"""You are building a versioned training response profile for a swimmer based on the coach's observations.

Swimmer: {swimmer.name} | Gender: {swimmer.gender or '?'} | Squad: {swimmer.squad or '?'}

DEVELOPMENTAL CONTEXT (critical for interpreting training response):
{age_context}

TRAINING OBSERVATIONS:
{obs_text}

{prev_text}

Synthesise how this swimmer characteristically responds to each type of training stimulus.
Focus on patterns that repeat across observations — don't over-index on single data points.
Remember: training response differs by age. Younger swimmers (< 16) typically recover faster between sets but have lower absolute tolerance for high-intensity work. Characterize response patterns in light of developmental stage.

Return JSON:
{{
  "aerobic": "how they respond to aerobic volume work — HR, times, technique, energy",
  "threshold": "response to threshold sets — ability to hold pace, HR behaviour",
  "vo2": "response to hard VO2/race-pace work — times across sets, fatigue pattern",
  "speed": "response to sprint/speed work — quality of efforts, drop-off rate",
  "recovery": "recovery characteristics — between reps, between sessions, overnight. Note if age-appropriate.",
  "hr_profile": "observed HR patterns at different intensities if data available",
  "fatigue_markers": "what signals fatigue in this swimmer — technique, times, HR, behaviour",
  "age_response_notes": "specific patterns related to their developmental stage — how does their age/training age affect training response? What adaptations are typical vs atypical for this age?",
  "predictive_notes": "given a known session type/load, what would you expect from this swimmer? What training stimulus produces the best response?",
  "change_summary": "Compared to the previous profile: what has changed, what has improved or declined. If first synthesis write: Initial profile — then summarise key training characteristics in 2-3 sentences."
}}

Return only JSON. Use null for fields with insufficient data."""

    if conversation_context:
        prompt += f"\n\n--- COACHING CONVERSATION (treat this as primary source — use it to inform and supplement the structured data above) ---\n{conversation_context}"

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    profile_data = json.loads(_strip_json(response.content[0].text))
    change_summary = profile_data.pop("change_summary", None)

    version = models.SwimmerProfileVersion(
        swimmer_id=swimmer.id,
        profile_type="training",
        data=profile_data,
        change_summary=change_summary,
        obs_count=len(training_obs),
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return _profile_version_out(version)


def generate_readiness_assessment(swimmer: models.Swimmer, db: DBSession) -> dict:
    """
    Assess a swimmer's current fatigue/readiness state and produce a short-term forecast.
    Reads: recent session load, load events, exceptions, biological profile.
    Returns a structured assessment — not versioned, generated fresh on demand.
    """
    from datetime import date, timedelta
    today = date.today()

    # Recent sessions — last 4 weeks
    four_weeks_ago = today - timedelta(days=28)
    recent_entries = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer.id,
            models.Session.date >= four_weeks_ago,
        )
        .order_by(models.Session.date.desc())
        .all()
    )
    session_lines = []
    for entry, session in recent_entries:
        days_ago = (today - session.date).days
        intensity = f"Group {entry.group_done}" if entry.group_done else "group unknown"
        obs = f" — {entry.coach_observation[:80]}" if entry.coach_observation else ""
        attended = "Attended" if entry.attended else "Absent"
        session_lines.append(
            f"  {session.date} ({days_ago}d ago): {attended}, {intensity}"
            + (f", focus: {session.energy_system_focus}" if session.energy_system_focus else "")
            + obs
        )
    sessions_text = "\n".join(session_lines) if session_lines else "No session data in last 4 weeks."

    sessions_attended = sum(1 for e, _ in recent_entries if e.attended)
    sessions_total = len(recent_entries)

    # Load events — last 6 weeks
    six_weeks_ago = today - timedelta(days=42)
    load_events = (
        db.query(models.SwimmerLoadEvent)
        .filter(
            models.SwimmerLoadEvent.swimmer_id == swimmer.id,
            models.SwimmerLoadEvent.date_from >= six_weeks_ago,
        )
        .order_by(models.SwimmerLoadEvent.date_from.desc())
        .all()
    )
    severity_label = {1: "mild", 2: "moderate", 3: "significant"}
    load_lines = [
        f"  {e.event_type} ({severity_label.get(e.severity,'?')}): {e.date_from}"
        + (f" to {e.date_to}" if e.date_to else "")
        + (f" — {e.description}" if e.description else "")
        + ("" if e.resolved else " [ONGOING]")
        for e in load_events
    ]
    load_text = "\n".join(load_lines) if load_lines else "No significant load events in last 6 weeks."

    # Exceptions (absences) — last 6 weeks
    exceptions = (
        db.query(models.SwimmerException)
        .filter(
            models.SwimmerException.swimmer_id == swimmer.id,
            models.SwimmerException.date_to >= six_weeks_ago,
        )
        .order_by(models.SwimmerException.date_from.desc())
        .all()
    )
    exc_lines = [
        f"  {e.reason}: {e.date_from} to {e.date_to}{(' — ' + e.notes) if e.notes else ''}"
        for e in exceptions
    ]
    exc_text = "\n".join(exc_lines) if exc_lines else "No absences in last 6 weeks."

    # Upcoming meets — next 6 weeks
    six_weeks_ahead = today + timedelta(days=42)
    upcoming_targets = (
        db.query(models.MeetTarget, models.Meet)
        .join(models.Meet, models.MeetTarget.meet_id == models.Meet.id)
        .filter(
            models.MeetTarget.swimmer_id == swimmer.id,
            models.Meet.date >= today,
            models.Meet.date <= six_weeks_ahead,
        )
        .order_by(models.Meet.date)
        .all()
    )
    upcoming_lines = [
        f"  {meet.name} — {meet.date} ({(meet.date - today).days} days away)"
        + (f", events: {', '.join(target.events or [])}" if target.events else "")
        for target, meet in upcoming_targets
    ]
    upcoming_text = "\n".join(upcoming_lines) if upcoming_lines else "No meets in the next 6 weeks."

    # Biological profile (recovery characteristics)
    bio_profile = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "biological",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    bio_text = json.dumps(bio_profile.data, indent=2) if bio_profile else "No biological profile — use general recovery assumptions."

    # Get age and LTAD context to inform readiness assessment
    age_context = _swimmer_age_context(swimmer) or ""

    prompt = f"""You are assessing a swimmer's current fatigue and readiness state for their coach.
Today is {today}.

SWIMMER: {swimmer.name} | Squad: {swimmer.squad or '?'} | Gender: {swimmer.gender or '?'}

DEVELOPMENTAL CONTEXT (critical for interpreting recovery needs):
{age_context}

SESSIONS LAST 4 WEEKS ({sessions_attended}/{sessions_total} attended):
{sessions_text}

SIGNIFICANT LOAD EVENTS (last 6 weeks):
{load_text}

ABSENCES / EXCEPTIONS (last 6 weeks):
{exc_text}

UPCOMING MEETS:
{upcoming_text}

BIOLOGICAL PROFILE (recovery characteristics):
{bio_text}

Assess this swimmer's current state and short-term readiness. Consider:
- Accumulated fatigue from recent training load and intensity
- Impact of any competitions (acute fatigue, how long recovery typically takes)
- Illness/injury effects — detraining + physical stress, re-entry profile
- Holiday/absence effects — rested but detrained, different from being fresh mid-season
- Their known recovery rate from the biological profile
- **Developmental stage**: younger swimmers (< 16) typically need different recovery strategies than older/mature athletes. Be specific about age-appropriate workload and recovery timing.
- Upcoming competitions — is taper/freshening needed and when

Return JSON:
{{
  "current_state": "one of: fresh / normal / fatigued / accumulating / recovering_illness / recovering_injury / detrained_rested / pre_competition",
  "fatigue_level": "low / moderate / high / very_high",
  "summary": "2-3 sentences describing where this swimmer is right now and why",
  "key_factors": ["factor 1", "factor 2", ...],
  "seven_day_forecast": "what to expect in the next 7 days — fatigue trajectory, expected response to training",
  "fourteen_day_forecast": "outlook to 14 days — especially relevant if a meet is approaching",
  "session_recommendation": "what load/group is appropriate this week — be specific, and consider developmental stage when determining intensity/volume appropriateness",
  "watch_points": "anything to monitor or flag — signs of over-training, under-recovery, re-injury risk. Age-specific watch points if relevant.",
  "taper_note": "if a meet is within 3 weeks, any specific freshening/taper guidance. null if not relevant. Consider developmental stage in taper strategy."
}}

Return only JSON. Base all conclusions on the data provided."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1200,
        messages=[{"role": "user", "content": prompt}],
    )

    assessment = json.loads(_strip_json(response.content[0].text))
    assessment["generated_at"] = today.isoformat()
    assessment["swimmer_id"] = swimmer.id
    return assessment


def synthesise_biological_profile(swimmer: models.Swimmer, db: DBSession, conversation_context: str = None) -> dict:
    """
    Biological profile: a short plain-English summary derived from the training profile.
    """
    training = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )

    target_events = ", ".join(
        f"{e['event']} ({e.get('course','?')})" if isinstance(e, dict) else str(e)
        for e in (swimmer.target_events or [])
    )
    age_context = _swimmer_age_context(swimmer) or ""

    source = json.dumps(training.data, indent=2) if training else "No training profile available yet."
    if conversation_context:
        source += f"\n\nCoach notes:\n{conversation_context}"

    prompt = f"""You are a swimming coach's assistant. Based on the training profile below, write a short biological summary for {swimmer.name} ({swimmer.gender or '?'}, target events: {target_events or 'not set'}).

DEVELOPMENTAL CONTEXT:
{age_context}

TRAINING PROFILE:
{source}

Write 1–2 paragraphs in plain English. Cover: what kind of physiological athlete this is (aerobic vs sprint, endurance vs speed), their current development stage, any key physical characteristics or limiters visible from the training data, and what this means practically for their training. Be specific to what the data shows — don't pad with generic statements. No headers, no bullet points, just prose.

Return JSON:
{{
  "summary": "the 1-2 paragraph biological summary",
  "change_summary": "One sentence: what's new or changed since the last synthesis, or 'Initial biological profile' if first time."
}}

Return only JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    profile_data = json.loads(_strip_json(response.content[0].text))
    change_summary = profile_data.pop("change_summary", None)

    obs_count = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.swimmer_id == swimmer.id
    ).count()

    version = models.SwimmerProfileVersion(
        swimmer_id=swimmer.id,
        profile_type="biological",
        data=profile_data,
        change_summary=change_summary,
        obs_count=obs_count,
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return _profile_version_out(version)


def synthesise_technical_profile(swimmer: models.Swimmer, db: DBSession, conversation_context: str = None) -> dict:
    """
    Synthesise a technical profile covering stroke mechanics, movement quality, and coachability.
    Uses race/general observations + conversation context as primary input.
    """
    all_obs = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.swimmer_id == swimmer.id)
        .order_by(models.SwimmerObservation.obs_type, models.SwimmerObservation.date.desc())
        .all()
    )

    obs_lines = []
    for o in all_obs:
        date_str = f"({o.date})" if o.date else ""
        event_str = f"[{o.event}]" if o.event else ""
        obs_lines.append(f"  [{o.obs_type}] {date_str}{event_str} {o.content}")
    # Cap observations to prevent prompt overrun
    if len(obs_lines) > 60:
        obs_lines = obs_lines[:60]
        obs_text = "\n".join(obs_lines) + f"\n  ... ({len(all_obs) - 60} older observations omitted)"
    else:
        obs_text = "\n".join(obs_lines) if obs_lines else "No observations recorded."

    # Recent race times for context
    recent_times = (
        db.query(models.SwimTime)
        .filter(models.SwimTime.swimmer_id == swimmer.id)
        .order_by(models.SwimTime.date.desc())
        .limit(20)
        .all()
    )
    times_text = "\n".join(
        f"  {t.event}: {_format_time(t.time_seconds)} ({t.date})"
        for t in recent_times
    ) if recent_times else "No times on record."

    previous = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "technical",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    prev_text = (
        f"Previous technical profile ({previous.created_at.date()}):\n{json.dumps(previous.data, indent=2)}"
        if previous
        else "No previous technical profile — this is the first synthesis."
    )

    target_events = ", ".join(
        f"{e['event']} ({e.get('course','?')})" if isinstance(e, dict) else str(e)
        for e in (swimmer.target_events or [])
    )
    age_context = _swimmer_age_context(swimmer) or ""

    prompt = f"""You are building a technical profile for a competitive swimmer based on coaching observations.

SWIMMER: {swimmer.name} | Gender: {swimmer.gender or '?'} | Squad: {swimmer.squad or '?'}
Target events: {target_events or 'not set'}

DEVELOPMENTAL CONTEXT:
{age_context}

OBSERVATIONS ({len(all_obs)} total):
{obs_text}

RECENT TIMES:
{times_text}

{prev_text}

Produce a technical profile covering stroke mechanics and movement quality only.
This is NOT about race tactics, pacing, or energy — those belong in the race profile.
Focus on what the swimmer does physically in the water: technique, body position, skill execution.
Focus on patterns that repeat across observations — be specific where the data supports it.
Note where technical limitations are developmental vs trainable.

Return JSON:
{{
  "stroke_mechanics": "primary stroke technique — body position, catch, pull phase, kick, timing, breathing pattern. What stands out technically, good and bad.",
  "starts_turns": "observed quality of starts, turns, and underwaters — technique and consistency",
  "technical_strengths": "2-3 specific technical qualities that are a genuine asset",
  "technical_limiters": "the 1-2 technical issues most limiting current performance",
  "coachability": "how readily they adopt technical change — fast/slow learner, retention under fatigue, response to cues",
  "drill_response": "if observed: which drills or technical cues have worked well, which haven't landed",
  "event_specific": {{"event_name": "stroke technique differences specific to this event distance or stroke — e.g. kick timing changes, stroke rate adjustments, not pacing or race strategy"}},
  "priorities": "ranked list of technical things to work on, with brief reasoning for the order",
  "change_summary": "Compared to previous: what has changed technically. If first profile: Initial profile — summarise key technical picture in 2-3 sentences."
}}

Return only JSON. Use null for fields with insufficient evidence."""

    if conversation_context:
        prompt += f"\n\n--- COACHING CONVERSATION (primary source — use coach's observations here directly) ---\n{conversation_context}"

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text
    try:
        profile_data = json.loads(_strip_json(raw))
    except json.JSONDecodeError:
        # Truncated response — attempt repair by closing open structures
        raw_stripped = _strip_json(raw)
        # Close any unterminated string/object
        repaired = raw_stripped.rstrip().rstrip(",")
        if not repaired.endswith("}"):
            repaired += '"}'
        try:
            profile_data = json.loads(repaired)
        except json.JSONDecodeError:
            profile_data = {"stroke_mechanics": None, "parse_error": "Response truncated — re-synthesise with fewer observations."}
    change_summary = profile_data.pop("change_summary", None)

    version = models.SwimmerProfileVersion(
        swimmer_id=swimmer.id,
        profile_type="technical",
        data=profile_data,
        change_summary=change_summary,
        obs_count=len(all_obs),
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return _profile_version_out(version)


def build_performance_analysis_prompt(swimmer: models.Swimmer, db: DBSession) -> str:
    """Build (but do not send) the performance analysis prompt. Used by both the synthesise endpoint and the debug endpoint."""
    from datetime import date, timedelta
    import statistics

    all_times = (
        db.query(models.SwimTime)
        .filter(models.SwimTime.swimmer_id == swimmer.id)
        .order_by(models.SwimTime.event, models.SwimTime.date.asc())
        .all()
    )

    if not all_times:
        raise ValueError("No times on record — import times before running performance analysis.")

    # Group by event, compute best time, best WA points, and progression
    by_event: dict = {}
    for t in all_times:
        by_event.setdefault(t.event, []).append(t)

    one_year_ago = date.today() - timedelta(days=365)
    event_summaries = []
    wa_points_list = []

    for event, entries in sorted(by_event.items()):
        best = min(entries, key=lambda x: x.time_seconds)
        best_wa = max((t.wa_points for t in entries if t.wa_points), default=None)
        if best_wa:
            wa_points_list.append(best_wa)

        # Recent vs older bests (12-month window)
        recent = [t for t in entries if t.date and t.date >= one_year_ago]
        older  = [t for t in entries if not t.date or t.date < one_year_ago]
        recent_best = min(recent, key=lambda x: x.time_seconds).time_seconds if recent else None
        older_best  = min(older,  key=lambda x: x.time_seconds).time_seconds if older  else None

        progression = "insufficient data"
        if recent_best and older_best:
            delta = older_best - recent_best
            pct = delta / older_best * 100
            if pct > 1.5:
                progression = f"improving ({pct:.1f}% faster than pre-{one_year_ago.year})"
            elif pct < -1.0:
                progression = f"declining ({abs(pct):.1f}% slower than pre-{one_year_ago.year})"
            else:
                progression = "stable (< 1.5% change)"
        elif recent and not older:
            progression = "new event (< 12 months data)"

        # Split analysis — is the last half slower than first half?
        split_note = None
        if best.splits and len([s for s in best.splits if s is not None]) >= 2:
            valid = [s for s in best.splits if s is not None]
            mid = len(valid) // 2
            first_half = sum(valid[:mid])
            second_half = sum(valid[mid:])
            ratio = second_half / first_half if first_half > 0 else 1.0
            if ratio > 1.10:
                split_note = f"significant positive split (2nd half {((ratio-1)*100):.0f}% slower)"
            elif ratio > 1.04:
                split_note = f"moderate positive split"
            elif ratio < 0.97:
                split_note = "negative split (strong finish)"
            else:
                split_note = "even splits"

        line = (
            f"  {event}: best {_format_time(best.time_seconds)}"
            + (f" | WA pts: {best_wa:.0f}" if best_wa else "")
            + f" | {len(entries)} swims"
            + f" | progression: {progression}"
            + (f" | splits: {split_note}" if split_note else "")
            + (f" | best date: {best.date}" if best.date else "")
        )
        event_summaries.append(line)

    # WA points variance across events (identifies outlier events)
    wa_context = ""
    if len(wa_points_list) >= 3:
        avg_wa = statistics.mean(wa_points_list)
        stdev_wa = statistics.stdev(wa_points_list) if len(wa_points_list) > 1 else 0
        wa_context = f"\nWA points average across events: {avg_wa:.0f} (stdev {stdev_wa:.0f})"
        wa_context += "\nEvents notably below average WA points (likely biggest gains available):"
        for event, entries in sorted(by_event.items()):
            best_wa = max((t.wa_points for t in entries if t.wa_points), default=None)
            if best_wa and best_wa < avg_wa - stdev_wa:
                wa_context += f"\n  {event}: {best_wa:.0f} pts (avg {avg_wa:.0f}, diff {avg_wa-best_wa:.0f})"

    # Previous performance analysis for comparison — summarised to avoid prompt bloat
    previous = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "performance_analysis",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    if previous:
        prev_summary = {
            "change_summary": previous.data.get("change_summary") or previous.change_summary,
            "event_profile": previous.data.get("event_profile"),
            "aerobic_vs_sprint_bias": previous.data.get("aerobic_vs_sprint_bias"),
            "progression_summary": previous.data.get("progression_summary"),
            "training_priorities": [
                {"priority": p.get("priority"), "focus": p.get("focus"), "rationale": p.get("rationale")}
                for p in (previous.data.get("training_priorities") or [])
            ],
            "gains_narrative": previous.data.get("gains_narrative"),
        }
        prev_text = f"Previous analysis (synthesised {previous.created_at.date()}):\n{json.dumps(prev_summary)}"
    else:
        prev_text = "No previous analysis — this is the first synthesis."

    # Separate target events data from the rest
    target_event_list = swimmer.target_events or []
    target_event_names = []
    for e in target_event_list:
        name = e['event'] if isinstance(e, dict) else str(e)
        course = e.get('course', '') if isinstance(e, dict) else ''
        target_event_names.append((name, course))

    # Build detailed target event blocks (all time records for each target event)
    target_event_blocks = []
    for (ev_name, ev_course) in target_event_names:
        # Match event names loosely (e.g. "100 Freestyle" matches "100 Freestyle SCM" and "100 Freestyle LCM")
        matching = {k: v for k, v in by_event.items() if ev_name.lower() in k.lower()}
        if not matching:
            target_event_blocks.append(f"  {ev_name} ({ev_course or 'any'}): NO TIMES ON RECORD")
            continue
        lines = [f"  {ev_name} (target course: {ev_course or 'any'}):"]
        for event_key, entries in sorted(matching.items()):
            course_label = event_key.replace(ev_name, '').strip() or 'unknown course'
            best = min(entries, key=lambda x: x.time_seconds)
            best_wa = max((t.wa_points for t in entries if t.wa_points), default=None)
            recent = [t for t in entries if t.date and t.date >= one_year_ago]
            older = [t for t in entries if not t.date or t.date < one_year_ago]
            recent_best = min(recent, key=lambda x: x.time_seconds).time_seconds if recent else None
            older_best = min(older, key=lambda x: x.time_seconds).time_seconds if older else None
            if recent_best and older_best:
                delta_pct = (older_best - recent_best) / older_best * 100
                trend = f"improving {delta_pct:.1f}%" if delta_pct > 1.5 else (f"declining {abs(delta_pct):.1f}%" if delta_pct < -1.0 else "stable")
            elif recent and not older:
                trend = "new (<12mo data)"
            else:
                trend = "no recent data"
            split_note = None
            if best.splits and len([s for s in best.splits if s is not None]) >= 2:
                valid = [s for s in best.splits if s is not None]
                mid = len(valid) // 2
                ratio = sum(valid[mid:]) / sum(valid[:mid]) if sum(valid[:mid]) > 0 else 1.0
                split_note = f"sig positive split ({((ratio-1)*100):.0f}% slower 2nd half)" if ratio > 1.10 else ("moderate positive split" if ratio > 1.04 else ("negative split" if ratio < 0.97 else "even splits"))
            # Best time per calendar quarter — shows trend without flooding the prompt
            quarterly: dict = {}
            for t in entries:
                if not t.date:
                    continue
                key = (t.date.year, (t.date.month - 1) // 3 + 1)  # (year, quarter 1-4)
                if key not in quarterly or t.time_seconds < quarterly[key].time_seconds:
                    quarterly[key] = t
            quarter_labels = {1: 'Q1', 2: 'Q2', 3: 'Q3', 4: 'Q4'}
            time_history = " → ".join(
                f"{_format_time(quarterly[k].time_seconds)} ({k[0]} {quarter_labels[k[1]]})"
                for k in sorted(quarterly.keys())
            ) or "no dated times"
            lines.append(
                f"    {course_label}: best {_format_time(best.time_seconds)}"
                + (f" | WA {best_wa:.0f}" if best_wa else "")
                + f" | {len(entries)} swims | trend: {trend}"
                + (f" | splits: {split_note}" if split_note else "")
                + f"\n    Quarterly best: {time_history}"
            )
        target_event_blocks.append("\n".join(lines))

    target_events_section = "\n\n".join(target_event_blocks) if target_event_blocks else "No target events set — analysing all events equally."

    target_events_str = ", ".join(f"{n} ({c})" for n, c in target_event_names) if target_event_names else "not set"
    total_events = len(by_event)
    total_swims  = len(all_times)

    # Get age and LTAD context to inform recommendations
    age_context = _swimmer_age_context(swimmer) or ""

    prompt = f"""You are a performance analyst working with a swimming coach. Your primary job is to produce a deep, actionable analysis of this swimmer's TARGET EVENTS, then use the broader event history as supporting context.

SWIMMER: {swimmer.name}
DOB: {swimmer.dob or 'unknown'} | Gender: {swimmer.gender or '?'} | Squad: {swimmer.squad or '?'}
Target events: {target_events_str}
Total recorded swims: {total_swims} across {total_events} events

DEVELOPMENTAL CONTEXT (must inform all recommendations):
{age_context}

--- TARGET EVENT DEEP DIVE ---
{target_events_section}

--- FULL EVENT HISTORY (supporting context) ---
{chr(10).join(event_summaries)}
{wa_context}

{prev_text}

Your analysis must:
1. Lead with the target events — analyse each one individually: current level, trend, splits, where time is being lost, what would unlock the next step
2. Use the broader event history to characterise the swimmer type and support training recommendations
3. Be specific and evidence-based — name actual times, splits, WA points
4. Ensure all training recommendations are appropriate for the swimmer's LTAD stage

Return JSON:
{{
  "target_event_analysis": [
    {{
      "event": "event name e.g. 100 Freestyle SCM",
      "current_level": "best time, WA points, where that sits relative to their overall level",
      "trend": "improving / stable / declining — with evidence",
      "split_analysis": "what the split data shows about where time is lost, or null if no splits",
      "limiting_factor": "the primary physiological or technical factor currently limiting performance in this event",
      "next_step": "what would realistically unlock the next 1-2% improvement — specific and evidence-based",
      "sc_lc_gap": "comparison if both courses have data, null if not"
    }}
  ],
  "event_profile": "2-3 sentence characterisation of what kind of swimmer this is — sprint/distance/aerobic bias, based on WA points distribution across all events",
  "aerobic_vs_sprint_bias": "aerobic / sprint / balanced — with evidence from all events",
  "strongest_events": ["events where WA points are highest"],
  "opportunity_events": ["events, including any target events, where WA points are below their average — biggest gains here"],
  "progression_summary": "which events are improving, plateauing, declining — target events called out specifically",
  "age_appropriate_considerations": "what IS and ISN'T appropriate to pursue now given LTAD stage — what to build for later",
  "training_priorities": [
    {{
      "priority": 1,
      "focus": "e.g. Aerobic threshold / VO2max / Speed endurance / Sprint mechanics",
      "rationale": "specific evidence from target event and wider data",
      "target_events_benefited": ["target events this directly improves"],
      "age_appropriate_note": "developmental stage constraints or timing notes"
    }}
  ],
  "gains_narrative": "2-3 paragraph plain-English summary focused on the target events — where are the gains, why, and what we do about it. Developmentally appropriate framing throughout.",
  "change_summary": "vs previous analysis: what has changed. If first analysis: opening summary of the key picture."
}}

Return only valid JSON. Note where data is sparse — especially for target events with few recorded swims."""

    return prompt, total_swims


def synthesise_performance_analysis(swimmer: models.Swimmer, db: DBSession) -> dict:
    """
    Analyse all race times to identify where performance gains are available
    and what training would unlock them. Stored as a versioned profile.
    """
    prompt, total_swims = build_performance_analysis_prompt(swimmer, db)

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    profile_data = json.loads(_strip_json(response.content[0].text))
    change_summary = profile_data.pop("change_summary", None)

    version = models.SwimmerProfileVersion(
        swimmer_id=swimmer.id,
        profile_type="performance_analysis",
        data=profile_data,
        change_summary=change_summary,
        obs_count=total_swims,
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return _profile_version_out(version)


def _profile_version_out(v: models.SwimmerProfileVersion) -> dict:
    return {
        "id": v.id,
        "profile_type": v.profile_type,
        "data": v.data,
        "change_summary": v.change_summary,
        "obs_count": v.obs_count,
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }


# ---------------------------------------------------------------------------
# Historical onboarding
# ---------------------------------------------------------------------------

def build_historical_narrative(
    swimmer: models.Swimmer,
    background_text: str,
    db: DBSession,
) -> str:
    """
    Given coach's freetext description of a swimmer's background,
    Claude synthesises a structured training history narrative and initial profile seeds.
    """
    prompt = f"""A swimming coach has provided the following background about a swimmer who is joining their programme:

SWIMMER: {swimmer.name}
BACKGROUND (coach's words):
{background_text}

Write a structured training history narrative that captures:
1. Previous training context (club, years of experience, session frequency, training style)
2. Key events / injuries / breaks in training
3. What this swimmer's aerobic and physical base likely looks like coming in
4. Initial physical and psychological profile hypotheses (labelled clearly as inferred, not confirmed)

Write in professional coaching language. Be specific where the coach provided specifics; flag gaps where data is missing.
Keep it under 400 words."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )

    narrative = response.content[0].text.strip()

    db.add(models.TrainingHistoryNarrative(
        swimmer_id=swimmer.id,
        narrative=narrative,
        source="reconstructed",
    ))
    db.commit()

    return narrative


# ---------------------------------------------------------------------------
# Observation text parser
# ---------------------------------------------------------------------------

def parse_observations_text(
    raw_text: str,
    swimmers: list,
    db: DBSession,
) -> list:
    """
    Parse a free-text observation note and distribute per swimmer.
    e.g. "Tom, Sarah — recovery from champs. Everyone else — general fatigue."
    Returns list of {swimmer_id, observation}.
    """
    swimmer_list = "\n".join(f"- {s.name} (id: {s.id})" for s in swimmers)

    prompt = f"""A swimming coach has written the following observation note after a training session:

"{raw_text}"

The squad members at this session are:
{swimmer_list}

Parse this note and assign a specific observation to each swimmer.
Rules:
- If a swimmer is explicitly named, use exactly what was said about them.
- If the note applies to a group ("everyone", "the rest", "most", "others"), apply it to all swimmers not explicitly named.
- If a swimmer isn't mentioned and there is no group note, set their observation to null.
- Keep observations in first-person coaching voice, concise and factual.

Return a JSON array only — no other text:
[{{"swimmer_id": <int>, "observation": "<text or null>"}}, ...]"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    return json.loads(_strip_json(response.content[0].text))


# ---------------------------------------------------------------------------
# Session characterisation
# ---------------------------------------------------------------------------

SESSION_RESPONSE_SYSTEM = """You are an expert swimming coach's analyst.
Given a training session, a swimmer's full profile, and the coach's observation of that swimmer during the session,
characterise:
1. How this swimmer likely responded physiologically to this stimulus
2. What the expected adaptation will be over the next 48–72 hours
3. Any flags or concerns based on the observation

CRITICAL: Consider the swimmer's age and LTAD stage when interpreting response.
Fatigue markers, recovery needs, and adaptation patterns differ significantly by developmental stage.
What might be a concerning sign in one age group could be normal in another.

Be specific and evidence-based. Reference the swimmer's known profile. 2-3 short paragraphs."""


def characterise_session_entry(
    swimmer: models.Swimmer,
    session: models.Session,
    entry: models.SessionEntry,
    db: DBSession,
) -> str:
    """Generate per-swimmer characterisation after a session register is submitted."""
    swimmer_ctx = build_swimmer_context(swimmer, db)

    session_desc = session.title or f"Session on {session.date}"
    group_content = ""
    if session.planned_content and entry.group_done:
        group_key = str(entry.group_done)
        group_data = session.planned_content.get(group_key, {})
        group_content = group_data.get("sets", "") if isinstance(group_data, dict) else str(group_data)

    prompt = f"""{swimmer_ctx}

SESSION: {session_desc} ({session.date})
Coach intent: {session.coach_intent or 'Not specified'}
Energy system focus: {session.energy_system_focus or 'Not specified'}
Group done: {entry.group_done or 'Not specified'}
Session content (this group):
{group_content or 'Not available'}

Coach observation: {entry.coach_observation or 'No observation recorded'}

Characterise this swimmer's response to this session."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=500,
        system=get_system_prompt(db, extra=SESSION_RESPONSE_SYSTEM),
        messages=[{"role": "user", "content": prompt}],
    )

    return response.content[0].text.strip()


# ---------------------------------------------------------------------------
# Group recommendations
# ---------------------------------------------------------------------------

def recommend_groups(
    session: models.Session,
    swimmers: list[models.Swimmer],
    db: DBSession,
) -> list[dict]:
    """
    Given a session's group structure and all swimmers, recommend which group each should do.
    Returns list of {swimmer_id, swimmer_name, recommended_group, reasoning}
    Recommendations are age-appropriate and consider developmental stage.
    """
    groups_desc = ""
    if session.planned_content:
        for g, content in session.planned_content.items():
            sets_text = content.get("sets", "") if isinstance(content, dict) else str(content)
            groups_desc += f"\nGroup {g}:\n{sets_text[:300]}\n"

    swimmers_text = ""
    for s in swimmers:
        age_ctx = _swimmer_age_context(s)
        age_line = f" | Age context: {age_ctx.split(chr(10))[0]}" if age_ctx else ""
        profile_summary = ""
        if s.physical_profile:
            profile_summary = f"Physical: {s.physical_profile.get('aerobic_base','?')}, Sprint tendency: {s.physical_profile.get('sprint_tendency','?')}"
        swimmers_text += f"- {s.name} (id:{s.id}): {profile_summary} | Target events: {', '.join(s.target_events or [])}{age_line}\n"

    prompt = f"""SESSION: {session.title or session.date}
Intent: {session.coach_intent or 'Not specified'}

GROUP STRUCTURE:
{groups_desc}

SWIMMERS:
{swimmers_text}

For each swimmer, recommend which group (1, 2, or 3) they should do.
**Critical:** ensure recommendations are developmentally appropriate for each swimmer's age/LTAD stage.
Group intensity, volume, and focus should be suitable for their current stage.
Give a one-sentence reason for each.
Return as JSON array: [{{"swimmer_id": int, "name": str, "group": int, "reason": str}}, ...]
Return only JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        system=get_system_prompt(db),
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    return json.loads(raw)


# ---------------------------------------------------------------------------
# Micro-cycle periodization
# ---------------------------------------------------------------------------

def generate_micro_plan(swimmer: models.Swimmer, db: DBSession) -> dict:
    """
    Generate a 1-2 week micro-cycle plan for a swimmer based on their current state.
    """
    swimmer_ctx = build_swimmer_context(swimmer, db)

    # Get recent session entries
    recent_entries = (
        db.query(models.SessionEntry)
        .filter(models.SessionEntry.swimmer_id == swimmer.id)
        .order_by(models.SessionEntry.created_at.desc())
        .limit(10)
        .all()
    )
    entry_summary = ""
    for e in recent_entries:
        sess = db.query(models.Session).filter(models.Session.id == e.session_id).first()
        entry_summary += f"- {sess.date if sess else '?'}: Group {e.group_done}, {e.coach_observation or 'no obs'}\n"
        if e.ai_characterisation:
            entry_summary += f"  AI: {e.ai_characterisation[:100]}...\n"

    # Get schedule constraints
    schedules = (
        db.query(models.Schedule)
        .filter(models.Schedule.swimmer_id == swimmer.id)
        .all()
    )
    schedule_text = ""
    for s in schedules:
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        day = days[s.day_of_week] if s.day_of_week is not None else "?"
        schedule_text += f"  {day} {s.session_time or ''}: {s.status} {('('+s.notes+')') if s.notes else ''}\n"

    prompt = f"""{swimmer_ctx}

RECENT SESSIONS (last 10 attended):
{entry_summary or 'No recent session data'}

SCHEDULE:
{schedule_text or 'No schedule data'}

Generate a 2-week micro-cycle plan for this swimmer.
Include:
- Overall focus for the 2 weeks
- Session load recommendations (which sessions to prioritise, any to skip)
- Key emphasis within sessions (aerobic/threshold/speed/recovery weighting)
- Any individual modifications suggested based on their profile and recent response
- Rationale (why this plan, what are we trying to achieve)

**CRITICAL:** Ensure all recommendations are developmentally appropriate for this swimmer's LTAD stage.
Volume, intensity, and training type must suit their current developmental window.

Return as JSON: {{
  "focus": str,
  "date_from": "YYYY-MM-DD",
  "date_to": "YYYY-MM-DD",
  "session_recommendations": [str],
  "load_profile": str,
  "modifications": str,
  "rationale": str,
  "age_appropriate_note": str or null
}}"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1000,
        system=get_system_prompt(db),
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    plan_data = json.loads(raw)
    return plan_data


# ---------------------------------------------------------------------------
# Session planner
# ---------------------------------------------------------------------------

def _build_swimmer_brief(swimmer: models.Swimmer, db: DBSession) -> str:
    """Lightweight per-swimmer summary for pre-session planning."""
    from datetime import date as date_type
    from sqlalchemy import or_

    lines = [f"{swimmer.name}"]

    if swimmer.status != 'active':
        lines.append(f"  ⚠ Status: {swimmer.status.upper()}")

    today = date_type.today()
    active_load = (
        db.query(models.LoadEvent)
        .filter(
            models.LoadEvent.swimmer_id == swimmer.id,
            models.LoadEvent.date_from <= today,
            or_(models.LoadEvent.date_to == None, models.LoadEvent.date_to >= today),
        )
        .all()
    )
    for ev in active_load:
        lines.append(f"  ⚠ {ev.event_type}: {ev.notes or ''}")

    age_ctx = _swimmer_age_context(swimmer)
    if age_ctx:
        lines.append(f"  {age_ctx}")

    if swimmer.physical_profile:
        snippet = str(swimmer.physical_profile)[:200].replace('\n', ' ')
        lines.append(f"  Profile: {snippet}")

    return "\n".join(lines)


def plan_and_analyse_session(
    session_text: str,
    date_str: str,
    squad: str,
    expected_swimmers: list,
    coaching_context: str,
    db: DBSession,
) -> dict:
    """
    Parse a free-text session description and generate a pre-session analysis:
    - Structured session (groups, sets, volume)
    - Plan alignment with current training block
    - Per-swimmer group suggestions and notes
    - Expected physiological effects
    """
    swimmer_briefs = []
    for sw_info in expected_swimmers:
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == sw_info["id"]).first()
        if swimmer:
            swimmer_briefs.append(_build_swimmer_brief(swimmer, db))

    swimmers_block = "\n\n".join(swimmer_briefs) if swimmer_briefs else "No specific swimmers loaded."

    prompt = f"""You are an expert swimming performance coach helping plan a training session.

SESSION WRITTEN BY COACH:
{session_text}

DATE: {date_str or 'Not specified'}
SQUAD: {squad or 'Not specified'}

{coaching_context}

EXPECTED SWIMMERS:
{swimmers_block}

Parse this session and return a JSON object with this exact structure:

{{
  "parsed": {{
    "title": "concise session title",
    "energy_focus": "aerobic|threshold|speed|recovery|mixed",
    "warm_up": "warm up description, or null",
    "cool_down": "cool down description, or null",
    "total_volume_m": "estimated total metres as a string e.g. ~3200m",
    "groups": {{
      "1": {{"label": "Lead group", "sets": ["set description 1", "set description 2"]}},
      "2": {{"label": "Main group", "sets": ["set description 1", "set description 2"]}},
      "3": {{"label": "Modified", "sets": ["set description 1", "set description 2"]}}
    }}
  }},
  "plan_alignment": "2-3 sentences on how this session fits the current coaching context, training block, and where the squad is right now.",
  "per_swimmer": [
    {{
      "name": "Swimmer Name",
      "suggested_group": 1,
      "note": "One specific sentence about this swimmer — adaptation, health flag, or emphasis."
    }}
  ],
  "expected_effects": "2-3 sentences on the physiological target, what the coach should watch for during the session, and what adaptation to expect in the days following."
}}

Rules:
- If only one or two groups are described, derive the other groups with appropriate progressive modifications.
- If no expected swimmers, return per_swimmer as an empty array.
- Do not include markdown in set descriptions — plain text only.
- Keep set descriptions concise but complete (e.g. "6x400 on 5:30, threshold pace").
"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=2500,
        system=get_system_prompt(db),
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.rstrip("`").strip()

    return json.loads(raw)
