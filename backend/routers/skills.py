"""
Specialist AI skills — focused, high-quality endpoints with deep domain prompts.
Each skill has a single, tightly-scoped job and gets exactly the context it needs.
"""
import json
import os
from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Body, HTTPException
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import get_client, MODEL, PLANNING_EFFORT, response_text
from backend.services.availability import availability_ranges
from backend.services.planning_engine import compact_context, refresh_macro

router = APIRouter()

VOLUME_KEYS = ['aerobic', 'threshold', 'vo2', 'race_pace', 'lact_tol', 'short_race_pace', 'kicking', 'sprint']


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _get_coaching_philosophy(db: DBSession) -> str:
    """Returns coaching philosophy text from the current CoachingProfile."""
    profile = db.query(models.CoachingProfile).filter(
        models.CoachingProfile.is_current == True
    ).first()
    if not profile:
        return ""
    parts = []
    if profile.ethos:
        parts.append(f"Coaching philosophy: {profile.ethos[:300]}")
    if profile.current_focus:
        parts.append(f"Current training focus: {profile.current_focus[:200]}")
    if profile.squad_state:
        parts.append(f"Squad state: {profile.squad_state[:200]}")
    return "\n".join(parts)


def _make_brief_reply(full_text: str) -> str:
    """Extract the key flag and recommendation from a full skill analysis for poolside brevity."""
    section_headers = [
        '**Key Flag**', '**Key Coaching Decision**',
        '**Recommendation**', '**Next Steps**', '**Next Block Recommendation**',
    ]
    sections: dict = {}
    current_key = None
    for line in full_text.split('\n'):
        matched = next((h for h in section_headers if h in line), None)
        if matched:
            current_key = matched
            sections[current_key] = []
        elif current_key and line.strip():
            sections[current_key].append(line.strip())

    parts = []
    for key in ['**Key Flag**', '**Key Coaching Decision**']:
        if key in sections:
            parts.append(f"{key}\n" + '\n'.join(sections[key][:2]))
    for key in ['**Recommendation**', '**Next Steps**', '**Next Block Recommendation**']:
        if key in sections:
            parts.append(f"{key}\n" + '\n'.join(sections[key][:3]))

    return '\n\n'.join(parts) if parts else full_text[:600]


def _format_thread_context(messages: list) -> str:
    """Format recent chat messages as a context string to orient a skill call."""
    if not messages:
        return ""
    lines = ["RECENT CONVERSATION CONTEXT (last messages in this thread — use to understand what the coach is asking and why):"]
    for m in messages[-8:]:
        role = "Coach" if m.get("role") == "user" else "AI"
        content = m.get("content", "")
        if isinstance(content, str) and content.strip():
            lines.append(f"  {role}: {content[:300]}")
    return "\n".join(lines)


def _meet_timetable_lines(meet: models.Meet, limit_sessions: int = 4, limit_events: int = 12) -> list[str]:
    """Compact competition-session detail for planning without flooding the prompt."""
    sessions = list(meet.timetable_sessions or [])[:limit_sessions]
    if not sessions:
        return []
    lines = []
    for session in sessions:
        times = "/".join(filter(None, [
            f"WU {session.warm_up_time}" if session.warm_up_time else None,
            f"start {session.start_time}" if session.start_time else None,
        ]))
        event_names = [
            (event.get("name") or str(event)) if isinstance(event, dict) else str(event)
            for event in (session.events or [])[:limit_events]
        ]
        suffix = f" | {times}" if times else ""
        lines.append(f"    Session: {session.name} ({session.date or 'date TBC'}){suffix}: {', '.join(event_names) or 'events TBC'}")
    return lines


def _planning_state_lines(db: DBSession, macro_id: Optional[int] = None,
                          as_of: Optional[date] = None) -> list[str]:
    """Small, cached pathway summary shared by planning skills."""
    planning_date = as_of or date.today()
    macro = None
    if macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.date_from <= planning_date,
            models.TrainingMacro.date_to >= planning_date,
        ).order_by(models.TrainingMacro.date_from).first()
    if not macro:
        return []
    pathway_count = db.query(models.PlanningPathway).filter(
        models.PlanningPathway.macro_id == macro.id,
        models.PlanningPathway.active.is_(True),
    ).count()
    if not pathway_count:
        return []
    has_snapshot = db.query(models.PlanningSnapshot).filter(
        models.PlanningSnapshot.macro_id == macro.id,
        models.PlanningSnapshot.as_of_date == planning_date,
    ).first()
    if not has_snapshot:
        refresh_macro(macro.id, db, planning_date)
    rows = compact_context(db, macro.id, planning_date).get("rows", [])
    grouped = defaultdict(list)
    for row in rows:
        key = (row["pathway"], row["target_meet"], row["target_date"], row["phase"],
               row["taper_start"], row["load_multiplier"])
        grouped[key].append(row)
    lines = ["SAVED PLANNING-AGENT STATE (deterministic; use this instead of re-deriving target timing):"]
    for (pathway, meet, target_date, phase, taper_start, load), members in list(grouped.items())[:12]:
        names = ", ".join(member["swimmer"] for member in members[:12])
        qualification = sorted({member["qualification"] or "unknown" for member in members})
        lines.append(
            f"  {pathway}: {names} | target {meet or 'UNASSIGNED'} {target_date or ''} | "
            f"phase {phase}, taper {taper_start or 'n/a'}, load x{load:g} | qualification {', '.join(qualification)}"
        )
        flagged = [f"{m['swimmer']}: {', '.join(m['flags'])}" for m in members if m.get("flags")]
        if flagged:
            lines.append(f"    Flags: {'; '.join(flagged[:6])}")
    lines.append("  Treat pathway timing as an individualisation constraint; do not silently change assignments or dates.")
    return lines


def _save_skill_output(
    db: DBSession,
    skill_type: str,
    full_output: str,
    brief_output: str = None,
    swimmer_id: int = None,
    entity_type: str = None,
    entity_id: int = None,
    entity_name: str = None,
    thread_id: int = None,
):
    """Persist a skill output to the skill_outputs table for history view."""
    try:
        db.add(models.SkillOutput(
            skill_type=skill_type,
            swimmer_id=swimmer_id,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            full_output=full_output,
            brief_output=brief_output or _make_brief_reply(full_output),
            thread_id=thread_id,
        ))
        db.commit()
    except Exception:
        db.rollback()


# ---------------------------------------------------------------------------
# Session Planning Skill
# ---------------------------------------------------------------------------

PLAN_SESSION_SYSTEM = """You are a specialist session planner for competitive swimming. You output ONLY valid JSON — no markdown fences, no prose outside the JSON.

Your job: design one training session that is phase-appropriate, energy-system-sequenced, and correctly differentiated across however many groups the situation calls for.

SESSION DURATION:
You will be given the session duration in minutes. Every set you write must fit within that time.
- Estimate 1 minute per 50m at aerobic pace as a rough guide
- Include transition time between sets (~2 min each)
- A 60-min session: ~2800-3400m total. A 75-min session: ~3500-4200m. A 90-min session: ~4200-5200m
- If no duration is given, assume 75 minutes

PERIODIZATION RULES (apply these — do not ignore them):
- Base phase: 70-80% aerobic, minimal race pace (<10%), no lact_tol or sprint
- Build phase: 55-65% aerobic, 20-25% threshold, 10-15% VO2/race_pace
- Peak phase: 45-55% aerobic, 15-20% threshold, 20-25% VO2/race_pace, 5-10% sprint
- Taper phase: volume drops 30-50% vs build peak; intensity maintained — race_pace, short_race_pace, sprint dominate the work component
- Recovery phase: 90%+ aerobic or kicking, nothing harder than aerobic

ENERGY SYSTEM SEQUENCING RULES:
- After a VO2 session: must wait 48h before next VO2 or race_pace session
- After a race_pace/sprint session: must wait 48h before next race_pace/sprint
- After threshold: 24h recovery before next threshold+ session
- Aerobic and recovery sessions can follow anything

GROUP STRUCTURE — decide how many groups are needed:
- Not always 3. Could be 1 (whole squad same session), 2, 3, 4, or more
- Base the decision on: how different the swimmers' needs are, their event specialties, their current load and attendance, what the coach has requested
- Name groups by what makes sense: "G1", "G2", "Sprint Lane", "Distance Lane", "Development", etc.
- Each group must have a clear reason to be different from the others — if two groups would do near-identical sessions, merge them

GROUP VOLUME:
Do not use fixed metre targets. Use the actual recent weekly volumes provided in context as your baseline.
- Progress volume from last week where the phase calls for loading; hold or reduce where it calls for recovery or taper
- Taper phase: reduce volume 20-40% from the most recent build week
- Recovery phase: reduce to ~50-60% of recent training volume

INDIVIDUAL SWIMMER CONTEXT:
Each swimmer is listed with: 2-week attendance, 4-week zone breakdown, target events, and any active flags (injury, illness, low readiness). Group definitions are also provided.
Use this to:
- Decide the right number of groups and what differentiates them (volume, intensity, event focus)
- Flag any swimmer who needs a different group or modification today — low attendance, hasn't hit this zone, active injury, event specialty mismatch
- Consider target events when writing sets: sprinters need short race pace and power work; distance swimmers need sustained pace sets; stroke specialists need stroke-specific sets
- Include any swimmers needing different handling in the "individual_mods" JSON field — one entry per swimmer, one line of reasoning. Omit the key entirely if no modifications needed

Session structure (always follow this):
1. Warm-up (aerobic): easy swim, drill, kick — scale to session duration
2. Pre-main/activation: build pace, stroke focus
3. Main set: the energy system focus of the session
4. Cool-down: easy swim

Volume breakdown key definitions:
- aerobic: zone 1-2 effort, comfortable
- threshold: zone 3-4, CSS/AT pace work, sustained effort
- vo2: zone 4-5, hard intervals
- race_pace: competition-speed reps, typically 50-200m efforts
- lact_tol: above race pace, short reps with very short rest
- short_race_pace: very short (25-50m) at race speed, taper/peak
- kicking: kick sets regardless of pace
- sprint: maximal effort, ≤25m, neurological/power focus

Count metres accurately. Sum of volume_breakdown must equal total session metres.

OUTPUT FORMAT (JSON only, no markdown):
{
  "title": "descriptive session title",
  "coach_intent": "1-2 sentences: what this session is trying to achieve and why it fits here in the block",
  "energy_system_focus": "aerobic|threshold|vo2|race_pace|recovery",
  "reasoning": "2-3 sentences on energy system choice, phase fit, and why you chose this group structure.",
  "individual_mods": {
    "Swimmer Name": "one line: what they should do differently today and why — different group, modified set, avoid X"
  },
  "groups": {
    "G1": {
      "label": "human-readable group name, e.g. 'Sprint/Middle Distance'",
      "description": "one sentence: who is in this group and what is their focus for this session",
      "sets": "full set list — each set on a new line, include reps × distance @ send-off/target pace",
      "volume_breakdown": {
        "aerobic": 0, "threshold": 0, "vo2": 0, "race_pace": 0,
        "lact_tol": 0, "short_race_pace": 0, "kicking": 0, "sprint": 0
      }
    }
  }
}
Add as many groups as needed under the "groups" key, numbered G1, G2, G3... or named descriptively."""


def _build_session_skill_context(db: DBSession, target_date: Optional[date] = None, squad: Optional[str] = None) -> str:
    """Build the rich context block fed to the session planning skill."""
    today = target_date or date.today()
    lines = []

    # Coaching philosophy — inject first so it frames everything else
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.append("COACHING PHILOSOPHY:")
        for ln in philosophy.split('\n'):
            lines.append(f"  {ln}")
        lines.append("")

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    # Current meso
    current_meso = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).order_by(models.SeasonBlock.date_from).first()

    if current_meso:
        week_in = (today - current_meso.date_from).days // 7 + 1
        total_weeks = max(1, round((current_meso.date_to - current_meso.date_from).days / 7))
        lines.append(f"CURRENT MESO: {current_meso.name} | {current_meso.phase_type or 'unspecified phase'} | week {week_in}/{total_weeks}")
        if current_meso.notes:
            lines.append(f"Meso notes: {current_meso.notes[:300]}")
        if current_meso.group_intents:
            lines.append("Group intents this meso:")
            for g, intent in current_meso.group_intents.items():
                lines.append(f"  {g}: {intent}")
    else:
        lines.append("CURRENT MESO: None defined — plan a general session.")

    lines.append("")
    session_macro_id = current_meso.macro_id if current_meso else None
    planning_lines = _planning_state_lines(db, session_macro_id, today)
    if planning_lines:
        lines.extend(planning_lines)
        lines.append("")

    # Recent sessions (last 14 days)
    cutoff = today - timedelta(days=14)
    recent = (
        db.query(models.Session)
        .filter(
            models.Session.date >= cutoff,
            models.Session.date <= today,
            models.Session.status != 'cancelled',
        )
        .order_by(models.Session.date.desc())
        .limit(10)
        .all()
    )

    if recent:
        lines.append("RECENT SESSIONS (last 14 days — use for energy system sequencing):")
        for s in recent:
            day_diff = (today - s.date).days
            day_label = f"today" if day_diff == 0 else f"{day_diff}d ago"
            focus = s.energy_system_focus or "unspecified"
            lines.append(f"  {s.date} ({day_label}): {s.title or 'Session'} | energy: {focus}")
            groups = db.query(models.SessionGroup).filter(models.SessionGroup.session_id == s.id).all()
            for g in sorted(groups, key=lambda x: x.group_number):
                if g.description:
                    lines.append(f"    G{g.group_number}: {g.description[:80]}")
    else:
        lines.append("RECENT SESSIONS: None in last 14 days.")

    lines.append("")

    # Poolside observations from recent sessions — quality signal for today's session
    recent_obs = db.query(models.SessionEntry).join(models.Session).filter(
        models.SessionEntry.coach_observation != None,
        models.SessionEntry.coach_observation != '',
        models.Session.date >= cutoff,
        models.Session.date <= today,
    ).order_by(models.Session.date.desc()).limit(20).all()

    if recent_obs:
        lines.append("POOLSIDE OBSERVATIONS (last 14 days — consider session quality and fatigue signals):")
        for e in recent_obs:
            sess = db.query(models.Session).filter(models.Session.id == e.session_id).first()
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == e.swimmer_id).first()
            if sess and sw:
                lines.append(f"  {sess.date} {sw.name}: {e.coach_observation[:150]}")
        lines.append("")

    # Weekly load per group (last 4 weeks)
    four_weeks_ago = today - timedelta(weeks=4)
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.session_date >= four_weeks_ago,
    ).all()

    # Aggregate by week + group
    group_weekly: dict = defaultdict(lambda: defaultdict(float))
    for load in loads:
        wk = iso_week(load.session_date)
        gnum = load.group_number or 0
        group_weekly[wk][gnum] += sum((load.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS)

    if group_weekly:
        lines.append("WEEKLY LOAD BY GROUP (last 4 weeks, metres):")
        sorted_weeks = sorted(group_weekly.keys())[-4:]
        for wk in sorted_weeks:
            gdata = group_weekly[wk]
            parts = [f"G{g}: {v:.0f}m" for g, v in sorted(gdata.items()) if g > 0]
            lines.append(f"  {wk}: {', '.join(parts) if parts else 'no data'}")
    else:
        lines.append("WEEKLY LOAD: No load data recorded yet.")

    lines.append("")

    # Upcoming meets (next 8 weeks)
    cutoff_meet = today + timedelta(weeks=8)
    meets = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= cutoff_meet,
    ).order_by(models.Meet.date).limit(12).all()

    if meets:
        lines.append("UPCOMING MEETS (consider in session planning):")
        for m in meets:
            days_out = (m.date - today).days
            lines.append(f"  {m.date} ({days_out}d): {m.name} | {m.level or ''} | {m.course or ''}")
            lines.extend(_meet_timetable_lines(m, limit_sessions=3, limit_events=8))
    else:
        lines.append("UPCOMING MEETS: None in next 8 weeks.")

    lines.append("")

    # Group membership (so skill knows who is in each group)
    current_macro = None
    if current_meso and current_meso.macro_id:
        current_macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.id == current_meso.macro_id
        ).first()

    # Pre-fetch readiness scores keyed by swimmer_id
    from sqlalchemy import desc as _rd
    _recent_readiness = (
        db.query(models.AIAnalysis)
        .filter(models.AIAnalysis.analysis_type == "readiness")
        .order_by(_rd(models.AIAnalysis.created_at))
        .limit(60)
        .all()
    )
    _readiness_by_swimmer: dict = {}
    for _r in _recent_readiness:
        if _r.swimmer_id and _r.swimmer_id not in _readiness_by_swimmer:
            try:
                _readiness_by_swimmer[_r.swimmer_id] = json.loads(_r.content)
            except Exception:
                pass

    # Pre-fetch unresolved load events keyed by swimmer_id
    _load_events = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.resolved == False,
    ).all()
    _load_events_by_swimmer: dict = defaultdict(list)
    for _le in _load_events:
        _load_events_by_swimmer[_le.swimmer_id].append(_le)

    if current_macro and current_macro.group_definitions:
        lines.append("GROUP DEFINITIONS AND INDIVIDUAL CONTEXT:")
        lines.append("(Use group definitions + individual data to decide how many groups to plan and what differentiates them)")
        two_weeks_ago = today - timedelta(weeks=2)

        # Total sessions available in last 2 and 4 weeks (squad-wide denominator)
        total_2wk = db.query(models.Session).filter(
            models.Session.date >= two_weeks_ago,
            models.Session.date <= today,
            models.Session.status != 'cancelled',
        ).count()
        total_4wk = db.query(models.Session).filter(
            models.Session.date >= four_weeks_ago,
            models.Session.date <= today,
            models.Session.status != 'cancelled',
        ).count()

        for g_label, defn in current_macro.group_definitions.items():
            desc = defn.get("description", "")
            intent = (current_meso.group_intents or {}).get(g_label, "") if current_meso else ""
            swimmer_ids = defn.get("swimmer_ids") or []
            group_header = f"\n  {g_label}: {desc}"
            if intent:
                group_header += f"\n    Intent this meso: {intent}"
            lines.append(group_header)
            if not swimmer_ids:
                lines.append("    No swimmers assigned yet.")
                continue

            for sid in swimmer_ids[:15]:
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == sid).first()
                if not sw:
                    continue

                # Sessions attended last 2 weeks
                att_2wk = db.query(models.SessionEntry).join(models.Session).filter(
                    models.SessionEntry.swimmer_id == sid,
                    models.SessionEntry.attended == True,
                    models.Session.date >= two_weeks_ago,
                    models.Session.date <= today,
                ).count()

                # Zone breakdown last 4 weeks
                sw_loads = db.query(models.SwimmerSessionLoad).filter(
                    models.SwimmerSessionLoad.swimmer_id == sid,
                    models.SwimmerSessionLoad.session_date >= four_weeks_ago,
                ).all()
                zone_totals: dict = {k: 0 for k in VOLUME_KEYS}
                for l in sw_loads:
                    for k in VOLUME_KEYS:
                        zone_totals[k] += (l.volume_breakdown or {}).get(k, 0)
                total_vol = sum(zone_totals.values())
                dominant_zones = [k for k in VOLUME_KEYS if zone_totals[k] > 0]
                zone_str = ", ".join(
                    f"{k}:{zone_totals[k]/1000:.1f}km" for k in dominant_zones
                ) if dominant_zones else "no load recorded"

                # Target events
                events = sw.target_events or []
                event_strs = [e.get("event", "") if isinstance(e, dict) else str(e) for e in events]
                event_str = f" | events: {', '.join(event_strs)}" if event_strs else ""

                # Active load events
                flags = []
                for e in _load_events_by_swimmer.get(sid, [])[:2]:
                    flags.append(f"{e.event_type}{': ' + e.notes[:50] if e.notes else ''}")

                # Readiness (only flag if low)
                r_data = _readiness_by_swimmer.get(sid)
                if r_data:
                    r_score = r_data.get("readiness_score")
                    r_load = r_data.get("recommended_load")
                    if r_score is not None and r_score <= 5:
                        flags.append(f"readiness {r_score}/10{' — ' + r_load if r_load else ''}")

                flag_str = f" ⚑ {' | '.join(flags)}" if flags else ""
                att_str = f"{att_2wk}/{total_2wk} sessions (2wk)"
                vol_str = f"{total_vol/1000:.1f}km/4wk" if total_vol > 0 else "no volume"
                lines.append(f"    {sw.name}: {att_str} | {vol_str} | zones: {zone_str}{event_str}{flag_str}")
    else:
        lines.append("GROUP MEMBERSHIP: No macro group assignments yet.")

    lines.append("")

    # Pool config for target date — including session duration
    if target_date:
        dow = target_date.weekday()
        slots = db.query(models.PoolSlot).filter(
            models.PoolSlot.day_of_week == dow,
            models.PoolSlot.active == True,
        ).all()
        if slots:
            lines.append("")
            lines.append(f"POOL CONFIG for {target_date} ({target_date.strftime('%A')}):")
            for slot in slots:
                duration_str = ""
                if slot.time and slot.end_time:
                    try:
                        from datetime import datetime as _dtt
                        t_start = _dtt.strptime(slot.time, "%H:%M")
                        t_end = _dtt.strptime(slot.end_time, "%H:%M")
                        mins = int((t_end - t_start).total_seconds() / 60)
                        duration_str = f" | {mins} minutes"
                    except Exception:
                        pass
                lines.append(f"  {slot.time}-{slot.end_time or '?'}{duration_str} | {slot.course or 'SCM'} | {slot.lanes or '?'} lanes | blocks: {slot.has_blocks}")

        # Swimmer availability — check exceptions on this date
        active_swimmers = db.query(models.Swimmer).filter(models.Swimmer.active == True).all()
        swimmer_map = {swimmer.id: swimmer for swimmer in active_swimmers}
        availability_today = availability_ranges(db, swimmer_map, target_date, target_date)
        if availability_today:
            lines.append(f"\nSWIMMER ABSENCES on {target_date}:")
            for swimmer_id, events in availability_today.items():
                swimmer = swimmer_map.get(swimmer_id)
                for event in events[:1]:
                    lines.append(f"  {swimmer.name}: {event['label']}" + (f" ({event['detail']})" if event['detail'] else ""))

    return "\n".join(lines)


def run_plan_session(
    request_text: str,
    db: DBSession,
    target_date: Optional[date] = None,
    squad: Optional[str] = None,
    coach_context: Optional[str] = None,
    brief: bool = False,
) -> dict:
    """
    Core session planning skill logic — callable from HTTP endpoint or internal routing.
    Returns { reply, draft } without saving to any thread.
    """
    context = _build_session_skill_context(db, target_date=target_date, squad=squad)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""COACHING CONTEXT:
{context}{thread_block}

COACH'S REQUEST:
{request_text}

Design the session now. Output valid JSON only."""

    response = get_client().messages.create(
        model=MODEL,
        effort=PLANNING_EFFORT,
        max_tokens=2000,
        system=PLAN_SESSION_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    raw = response_text(response)

    # Strip any accidental markdown fences
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("```").strip()

    draft = json.loads(raw)

    # Extract reasoning before it goes into the draft
    reasoning = draft.pop("reasoning", "")
    reply = _build_reply(draft, reasoning, target_date)

    if brief:
        reply = f"**Session Plan — {draft.get('title', 'Session')}**\n\n*{draft.get('energy_system_focus', '').title()} focus*\n\n{draft.get('coach_intent', '')}"

    if target_date:
        draft["date"] = target_date.isoformat()

    _save_skill_output(db, "session_plan", reply, entity_type="squad")

    return {"reply": reply, "draft": draft}


@router.post("/plan-session")
def plan_session(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Session planning skill — generates a periodized session with full volume breakdown
    per group, based on current meso phase, energy system sequencing, and group membership.
    Can be called directly from the UI (Calendar Plan button etc.).
    """
    request_text = body.get("request", "Plan a training session for the squad.")
    thread_id = body.get("thread_id")
    target_date_str = body.get("target_date")
    squad = body.get("squad")

    target_date = None
    if target_date_str:
        from datetime import datetime as _dt
        try:
            target_date = _dt.strptime(target_date_str, "%Y-%m-%d").date()
        except ValueError:
            pass

    try:
        result = run_plan_session(request_text, db, target_date=target_date, squad=squad)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Skill returned malformed JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Session planning skill failed: {e}")

    # Save to thread if provided
    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return {
        "reply": result["reply"],
        "draft": result["draft"],
        "context_summary": f"Based on: {_context_summary(db, target_date)}",
    }


def _build_reply(draft: dict, reasoning: str, target_date: Optional[date]) -> str:
    """Turn the structured draft into a readable chat reply."""
    title = draft.get("title", "Session")
    focus = draft.get("energy_system_focus", "")
    intent = draft.get("coach_intent", "")
    date_str = f" for {target_date.strftime('%A')} {target_date.day} {target_date.strftime('%B')}" if target_date else ""

    lines = [f"**{title}**{date_str}"]
    if focus:
        lines.append(f"*{focus.title()} focus*")
    if reasoning:
        lines.append(f"\n{reasoning}")
    if intent:
        lines.append(f"\n*Intent: {intent}*")

    groups = draft.get("groups", {})
    for g_key in sorted(groups.keys(), key=lambda x: str(x)):
        g = groups[g_key]
        vols = g.get("volume_breakdown", {})
        total = sum(v for v in vols.values() if isinstance(v, (int, float)))
        km = f"{total/1000:.1f}km" if total > 0 else ""
        label = g.get("label") or f"Group {g_key}"
        lines.append(f"\n**{label}** {km}")
        if g.get("description"):
            lines.append(g["description"])
        sets = g.get("sets", "")
        if sets:
            set_lines = [l.strip() for l in sets.split('\n') if l.strip()][:4]
            for sl in set_lines:
                lines.append(f"  {sl}")
            if len(sets.split('\n')) > 4:
                lines.append("  *(more sets in draft)*")

    individual_mods = draft.get("individual_mods") or {}
    if individual_mods:
        lines.append("\n**Individual Modifications**")
        for name, note in individual_mods.items():
            lines.append(f"  {name}: {note}")

    lines.append("\nReview the draft below — edit anything before creating the session.")
    return "\n".join(lines)


def _context_summary(db: DBSession, target_date: Optional[date]) -> str:
    today = target_date or date.today()
    meso = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).first()
    parts = []
    if meso:
        parts.append(f"{meso.name} ({meso.phase_type or 'phase'})")
    recent_count = db.query(models.Session).filter(
        models.Session.date >= today - timedelta(days=14),
        models.Session.status != 'cancelled',
    ).count()
    parts.append(f"{recent_count} recent sessions")
    return ", ".join(parts) if parts else "general context"


# ---------------------------------------------------------------------------
# Swimmer Adaptation Review Skill
# ---------------------------------------------------------------------------

ADAPTATION_REVIEW_SYSTEM = """You are a specialist swimming adaptation analyst. Your job is to systematically assess whether a swimmer is responding to training as intended, and identify the single most important thing the coach should know.

Apply the framework below without deviation. Be direct and specific — reference the actual data provided. Do not pad with generic sports science text.

FRAMEWORK:

1. Load vs Meso Intent
Compare the swimmer's actual weekly volumes (by zone) against the group intent stated for this meso phase. Is the dose matching the plan?
- Look for sustained mismatches: consistently below intent (under-stimulation), or above intent without recovery (accumulation risk)
- A single low week (illness, life event) is noise — a 3-week pattern is signal
- Flag if their actual dominant zone doesn't match the phase (e.g. doing race_pace in a base phase)

2. Adaptation Signals
Are benchmarks and observations showing the expected response for this training stimulus?
- Aerobic/base block → expect: aerobic benchmark improvement, lower effort at same pace, better volume tolerance
- Threshold block → expect: CSS/AT times dropping, improved maintenance across a set, less recovery needed
- VO2/race_pace block → expect: faster rep times, improved repeatability, higher top-end ceiling
- If signals absent, ask: high load + flat benchmarks = fatigue accumulation? Low load + flat benchmarks = insufficient stimulus?
- Distinguish short-term fatigue (expected in a build) from maladaptation (sustained plateau or decline)

CRITICAL — Race results as adaptation evidence:
Race times are NOT reliable adaptation signals unless the swimmer is in a peak, taper, or competition phase AND has at least 3 results showing a consistent trend across separate meets.
- A single race result during a base or build block carries almost no diagnostic weight — fatigue, technique work, or deliberate under-taper explain flat or slower times
- Do not interpret one poor gala as evidence the training plan isn't working
- If race times are included, note the phase they occurred in. Only weight them as adaptation evidence if the phase context supports it
- The correct adaptation signal during base/build is training benchmarks, not competition results

3. Consistency
Attendance rate and load continuity over 6-8 weeks. Gaps break adaptation cycles.
- Regular attender with consistent load: adaptation compounds
- Irregular attender: each return is effectively a re-introduction to load
- Flag the trend: improving, stable, declining, or inconsistent

4. Developmental Context (include only if relevant)
Age, school year, maturation stage. A swimmer in a growth spurt or exam period behaves differently. Don't over-interpret flat benchmarks in a 14-year-old growing 5cm.

5. Key Flag
ONE thing. The most important coaching decision or observation point right now. Not a list. Make it specific and name it directly.

6. Recommendation
One concrete next step. Options: session modification, load adjustment, conversation to have, continue as planned with rationale, schedule a benchmark test.

FORMAT (use exactly these headers, nothing else):
**Load vs Intent**
[2-3 sentences]

**Adaptation Signals**
[2-3 sentences]

**Consistency**
[1-2 sentences]

**Context Note** ← only include this section if developmental/life context is genuinely relevant
[1-2 sentences]

**Key Flag**
[1-2 sentences — specific, named, actionable]

**Recommendation**
[1 sentence — concrete next step]

Total length: readable in 60 seconds at the pool. No waffle."""


def _build_adaptation_context(swimmer: models.Swimmer, db: DBSession) -> str:
    """Structured context for the adaptation review skill — richer than the general swimmer context."""
    today = date.today()
    lines = []
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.extend(["COACHING CONTEXT:", philosophy, ""])

    # Swimmer basics
    from backend.models import get_age_at_dec31, get_school_year
    age = get_age_at_dec31(swimmer.dob) if swimmer.dob else None
    school_yr = get_school_year(swimmer.dob) if swimmer.dob else None
    age_str = f"Age {age} (Dec 31)" if age else "age unknown"
    school_str = f"Year {school_yr}" if school_yr else "post-school"
    lines.append(f"SWIMMER: {swimmer.name} | {swimmer.squad or 'no squad'} | {age_str} | {school_str}")
    lines.append(f"Status: {swimmer.status} | Target events: {', '.join(e.get('event','') if isinstance(e, dict) else str(e) for e in (swimmer.target_events or []))}")
    if swimmer.strengths:
        lines.append(f"Strengths: {swimmer.strengths[:200]}")
    if swimmer.weaknesses:
        lines.append(f"Weaknesses: {swimmer.weaknesses[:200]}")
    lines.append("")

    # Current meso + group assignment
    current_meso = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).order_by(models.SeasonBlock.date_from).first()

    group_label = None
    group_intent = None

    if current_meso:
        week_in = (today - current_meso.date_from).days // 7 + 1
        total_weeks = max(1, round((current_meso.date_to - current_meso.date_from).days / 7))
        lines.append(f"CURRENT MESO: {current_meso.name} | {current_meso.phase_type or 'no phase'} | week {week_in}/{total_weeks}")
        if current_meso.macro_id:
            macro = db.query(models.TrainingMacro).filter(
                models.TrainingMacro.id == current_meso.macro_id
            ).first()
            if macro and macro.group_definitions:
                for g, defn in macro.group_definitions.items():
                    if swimmer.id in (defn.get("swimmer_ids") or []):
                        group_label = g
                        desc = defn.get("description", "")
                        lines.append(f"Assigned group: {g}" + (f" ({desc})" if desc else ""))
                        break
        if group_label and current_meso.group_intents:
            group_intent = current_meso.group_intents.get(group_label)
            if group_intent:
                lines.append(f"Group intent this meso: {group_intent}")
    else:
        lines.append("CURRENT MESO: None defined.")
    lines.append("")

    # Weekly load — last 8 weeks broken down by zone
    eight_weeks_ago = today - timedelta(weeks=8)
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.swimmer_id == swimmer.id,
        models.SwimmerSessionLoad.session_date >= eight_weeks_ago,
    ).all()

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    weekly_vols: dict = defaultdict(lambda: {k: 0 for k in VOLUME_KEYS})
    for load in loads:
        wk = iso_week(load.session_date)
        for k in VOLUME_KEYS:
            weekly_vols[wk][k] += (load.volume_breakdown or {}).get(k, 0)

    # Attendance counts per week
    entries = db.query(models.SessionEntry).join(models.Session).filter(
        models.SessionEntry.swimmer_id == swimmer.id,
        models.SessionEntry.attended == True,
        models.Session.date >= eight_weeks_ago,
    ).all()
    weekly_sessions: dict = defaultdict(int)
    for e in entries:
        sess = db.query(models.Session).filter(models.Session.id == e.session_id).first()
        if sess:
            weekly_sessions[iso_week(sess.date)] += 1

    # Total sessions available per week
    total_sessions_per_week: dict = defaultdict(int)
    all_sessions = db.query(models.Session).filter(
        models.Session.date >= eight_weeks_ago,
        models.Session.status != 'cancelled',
    ).all()
    for s in all_sessions:
        total_sessions_per_week[iso_week(s.date)] += 1

    # Build ordered weeks
    ordered_weeks = []
    d = eight_weeks_ago
    seen = set()
    while d <= today:
        lbl = iso_week(d)
        if lbl not in seen:
            ordered_weeks.append(lbl)
            seen.add(lbl)
        d += timedelta(days=7)

    lines.append("WEEKLY LOAD (last 8 weeks):")
    total_attended = 0
    total_possible = 0
    active_weeks = 0
    for wk in ordered_weeks:
        vols = weekly_vols[wk]
        total = sum(vols.values())
        attended = weekly_sessions.get(wk, 0)
        possible = total_sessions_per_week.get(wk, 0)
        total_attended += attended
        total_possible += possible
        if total > 0 or attended > 0:
            active_weeks += 1
        zone_parts = [f"{k}:{vols[k]:.0f}m" for k in VOLUME_KEYS if vols[k] > 0]
        zone_str = " | ".join(zone_parts) if zone_parts else "no load recorded"
        lines.append(f"  {wk}: {total/1000:.1f}km total | {attended}/{possible} sessions | {zone_str}")

    attendance_pct = round((total_attended / total_possible) * 100) if total_possible > 0 else 0
    lines.append(f"8-week attendance: {total_attended}/{total_possible} sessions ({attendance_pct}%)")
    lines.append("")

    # Peer group comparison — how does this swimmer's load compare to group peers?
    if group_label and current_meso and current_meso.macro_id:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.id == current_meso.macro_id
        ).first()
        if macro and macro.group_definitions:
            peer_ids = [
                sid for sid in (macro.group_definitions.get(group_label, {}).get("swimmer_ids") or [])
                if sid != swimmer.id
            ]
            if peer_ids:
                peer_loads = db.query(models.SwimmerSessionLoad).filter(
                    models.SwimmerSessionLoad.swimmer_id.in_(peer_ids),
                    models.SwimmerSessionLoad.session_date >= eight_weeks_ago,
                ).all()
                peer_weekly: dict = defaultdict(float)
                for pl in peer_loads:
                    wk = iso_week(pl.session_date)
                    peer_weekly[wk] += sum((pl.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS)

                this_swimmer_weekly_totals = [sum(weekly_vols[wk].values()) for wk in ordered_weeks if sum(weekly_vols[wk].values()) > 0]
                group_avg_per_week = [peer_weekly.get(wk, 0) / len(peer_ids) for wk in ordered_weeks if peer_weekly.get(wk, 0) > 0]

                if this_swimmer_weekly_totals and group_avg_per_week:
                    my_avg = sum(this_swimmer_weekly_totals) / len(this_swimmer_weekly_totals)
                    group_avg = sum(group_avg_per_week) / len(group_avg_per_week)
                    pct_diff = round(((my_avg - group_avg) / group_avg) * 100) if group_avg > 0 else 0
                    comparison = "above" if pct_diff > 5 else "below" if pct_diff < -5 else "in line with"
                    lines.append(f"GROUP PEER COMPARISON ({group_label}, {len(peer_ids)} peers):")
                    lines.append(f"  This swimmer avg: {my_avg:.0f}m/week | Group avg: {group_avg:.0f}m/week | {abs(pct_diff)}% {comparison} group average")
                    lines.append("")

    # Benchmarks — last 6 per category, with trend
    from sqlalchemy import desc as sa_desc
    bm_rows = db.query(models.BenchmarkLog).filter(
        models.BenchmarkLog.swimmer_id == swimmer.id,
    ).order_by(sa_desc(models.BenchmarkLog.date)).limit(40).all()

    bm_by_cat: dict = defaultdict(list)
    for b in bm_rows:
        key = f"{b.distance}m {b.stroke} {b.effort}"
        bm_by_cat[key].append({"date": b.date.isoformat(), "time": b.time_seconds, "notes": b.notes or ""})

    if bm_by_cat:
        lines.append("BENCHMARKS (most recent first, up to 4 per category):")
        for cat, entries_list in list(bm_by_cat.items())[:8]:
            entries_list = entries_list[:4]
            trend = ""
            if len(entries_list) >= 2:
                diff = entries_list[0]["time"] - entries_list[1]["time"]
                if diff < -0.5:
                    trend = " → IMPROVING"
                elif diff > 0.5:
                    trend = " → SLOWER"
                else:
                    trend = " → STABLE"
            times_str = " / ".join(f"{e['time']:.2f}s ({e['date'][:10]})" for e in entries_list)
            lines.append(f"  {cat}{trend}: {times_str}")
    else:
        lines.append("BENCHMARKS: None recorded.")
    lines.append("")

    # Training content — what sessions did they actually do? (not just volume)
    attended_entries = db.query(models.SessionEntry).join(models.Session).filter(
        models.SessionEntry.swimmer_id == swimmer.id,
        models.SessionEntry.attended == True,
        models.Session.date >= eight_weeks_ago,
    ).order_by(models.Session.date.desc()).limit(16).all()

    if attended_entries:
        lines.append("TRAINING CONTENT (last 8 weeks, sessions attended):")
        for e in attended_entries:
            sess = db.query(models.Session).filter(models.Session.id == e.session_id).first()
            if not sess:
                continue
            focus = sess.energy_system_focus or "unspecified"
            g_num = e.group_done or e.group_planned
            group_desc = ""
            if g_num:
                grp = db.query(models.SessionGroup).filter(
                    models.SessionGroup.session_id == sess.id,
                    models.SessionGroup.group_number == g_num,
                ).first()
                if grp and grp.description:
                    group_desc = f" | {grp.description[:80]}"
            lines.append(f"  {sess.date}: {sess.title or 'Session'} | {focus}{group_desc}")
        lines.append("")

    # Poolside observations from session register (coach_observation on SessionEntry)
    entry_obs = db.query(models.SessionEntry).join(models.Session).filter(
        models.SessionEntry.swimmer_id == swimmer.id,
        models.SessionEntry.coach_observation != None,
        models.SessionEntry.coach_observation != '',
        models.Session.date >= eight_weeks_ago,
    ).order_by(models.Session.date.desc()).limit(10).all()

    if entry_obs:
        lines.append("POOLSIDE NOTES (from session register, last 8 weeks):")
        for e in entry_obs:
            sess = db.query(models.Session).filter(models.Session.id == e.session_id).first()
            if sess:
                lines.append(f"  {sess.date}: {e.coach_observation[:200]}")
        lines.append("")

    # Formal observations (SwimmerObservation — last 6)
    obs = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.swimmer_id == swimmer.id,
    ).order_by(models.SwimmerObservation.date.desc()).limit(6).all()

    if obs:
        lines.append("LOGGED OBSERVATIONS (last 6):")
        for o in obs:
            lines.append(f"  [{o.obs_type}] {o.date}: {o.content[:200]}")
    else:
        lines.append("LOGGED OBSERVATIONS: None recorded.")
    lines.append("")

    # Swimmer targets — cross-referenced with current benchmarks
    targets = db.query(models.SwimmerTarget).filter(
        models.SwimmerTarget.swimmer_id == swimmer.id,
        models.SwimmerTarget.achieved == False,
    ).order_by(models.SwimmerTarget.deadline).all()

    if targets:
        lines.append("SWIMMER TARGETS (unachieved):")
        for tgt in targets:
            deadline_str = f" | deadline {tgt.deadline}" if tgt.deadline else ""
            if tgt.target_time_seconds and tgt.distance and tgt.stroke and tgt.effort:
                # Find most recent matching benchmark
                bm = db.query(models.BenchmarkLog).filter(
                    models.BenchmarkLog.swimmer_id == swimmer.id,
                    models.BenchmarkLog.distance == tgt.distance,
                    models.BenchmarkLog.stroke == tgt.stroke,
                    models.BenchmarkLog.effort == tgt.effort,
                ).order_by(models.BenchmarkLog.date.desc()).first()
                if bm:
                    gap = bm.time_seconds - tgt.target_time_seconds
                    gap_str = f"+{gap:.2f}s to go" if gap > 0 else "TARGET MET"
                    lines.append(f"  {tgt.label}: target {tgt.target_time_seconds:.2f}s | current {bm.time_seconds:.2f}s ({bm.date}) | {gap_str}{deadline_str}")
                else:
                    lines.append(f"  {tgt.label}: target {tgt.target_time_seconds:.2f}s | no matching benchmark recorded{deadline_str}")
            else:
                desc = f" — {tgt.description[:120]}" if tgt.description else ""
                lines.append(f"  {tgt.label}{desc}{deadline_str}")
        lines.append("")

    # Recent race times (last 8) — tagged with training phase at time of race
    from sqlalchemy import desc as _desc
    times = db.query(models.SwimTime).filter(
        models.SwimTime.swimmer_id == swimmer.id,
    ).order_by(_desc(models.SwimTime.date)).limit(8).all()

    if times:
        # Build a phase lookup: for each race date, find what block was active
        all_blocks = db.query(models.SeasonBlock).order_by(models.SeasonBlock.date_from).all()
        def phase_at(d):
            for blk in all_blocks:
                if blk.date_from <= d <= blk.date_to:
                    return blk.phase_type or "unknown"
            return "no block"

        lines.append("RECENT RACE TIMES (phase at time of race shown — weight accordingly):")
        for t in times:
            wa = f" ({t.wa_points:.0f} WA pts)" if t.wa_points else ""
            phase = phase_at(t.date)
            reliability = " ← use caution: build/base phase result" if phase in ("base", "build", "aerobic") else ""
            lines.append(f"  {t.date} [{phase}]: {t.event} — {t.time_seconds:.2f}s{wa}{reliability}")

    return "\n".join(lines)


def run_adaptation_review(
    swimmer_name: str,
    db: DBSession,
    save_to_profile: bool = True,
    coach_context: Optional[str] = None,
    brief: bool = False,
) -> dict:
    """
    Core adaptation review skill logic — callable from HTTP endpoint or internal chat routing.
    Returns { reply, swimmer_id, swimmer_name }.
    """
    swimmer = db.query(models.Swimmer).filter(
        models.Swimmer.name.ilike(f"%{swimmer_name}%"),
        models.Swimmer.status != 'inactive',
    ).first()
    if not swimmer:
        return {
            "reply": f"I couldn't find a swimmer matching '{swimmer_name}'. Check the name and try again.",
            "swimmer_id": None,
            "swimmer_name": swimmer_name,
        }

    context = _build_adaptation_context(swimmer, db)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""{context}{thread_block}

Perform the adaptation review for {swimmer.name} now using the framework."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1200,
        system=ADAPTATION_REVIEW_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    analysis = response.content[0].text.strip()

    # Prepend swimmer name as header
    reply = f"**Adaptation Review — {swimmer.name}**\n\n{analysis}"
    brief_reply = f"**{swimmer.name} — Key Flags**\n\n{_make_brief_reply(analysis)}"

    if brief:
        reply = brief_reply

    # Optionally save a summary as an observation
    if save_to_profile:
        key_flag = ""
        if "**Key Flag**" in analysis:
            parts = analysis.split("**Key Flag**")
            if len(parts) > 1:
                key_flag = parts[1].split("**")[0].strip()
        obs_content = f"Adaptation review: {key_flag}" if key_flag else "Adaptation review completed."
        db.add(models.SwimmerObservation(
            swimmer_id=swimmer.id,
            obs_type="review",
            content=obs_content,
            date=date.today(),
        ))
        db.commit()

    _save_skill_output(
        db, "adaptation_review", reply, brief_output=brief_reply,
        swimmer_id=swimmer.id, entity_type="swimmer",
        entity_id=swimmer.id, entity_name=swimmer.name,
    )

    return {
        "reply": reply,
        "swimmer_id": swimmer.id,
        "swimmer_name": swimmer.name,
    }


@router.post("/review-swimmer")
def review_swimmer(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Swimmer adaptation review skill — systematic analysis of load vs intent,
    adaptation signals, consistency, and one key flag. Called directly from swimmer profile
    or routed from chat when "how is [name] doing?" type intent is detected.
    """
    swimmer_name = body.get("swimmer_name") or body.get("name", "")
    swimmer_id = body.get("swimmer_id")
    thread_id = body.get("thread_id")
    save_to_profile = body.get("save_to_profile", True)

    if not swimmer_name and swimmer_id:
        sw = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
        swimmer_name = sw.name if sw else ""

    if not swimmer_name:
        raise HTTPException(status_code=400, detail="swimmer_name or swimmer_id required")

    try:
        result = run_adaptation_review(swimmer_name, db, save_to_profile=save_to_profile)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Adaptation review skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Block Review Skill
# ---------------------------------------------------------------------------

BLOCK_REVIEW_SYSTEM = """You are a specialist training block analyst for competitive swimming. Your job is to assess how a meso-cycle was actually delivered and what it means for individual and squad development.

Apply this framework without deviation. Be direct — reference the actual data. No generic sports science padding.

FRAMEWORK:

1. Phase Delivery
Did the squad actually train in the way this phase was intended?
- Compare the dominant energy system zones delivered to what the phase_type demands
- Base → expected 70-80% aerobic; Build → 55-65% aerobic + threshold rising; Peak → VO2/race_pace climbing; Taper → volume drop, intensity maintained
- Flag if actual delivery diverged from phase intent and say why it matters

2. Group Analysis (one paragraph per group that has data)
For each group:
- Did load build progressively, plateau, or drop? Compare to the previous block baseline provided
- Did the group intent match what was actually delivered by zone?
- Flag the most notable issue or strength for this group

3. Attendance & Continuity
Overall squad attendance rate for the block. Who had significant gaps? Gaps break adaptation — a swimmer missing 30%+ of a block will not adapt as planned.
- Flag any swimmer with attendance below 70% of block sessions
- Note if the whole squad had a gap week (squad-level disruption vs individual)

4. Adaptation Signals (based on observations and benchmarks logged during the block)
What did coaches observe and what do benchmarks show? Are these consistent with the intended training stimulus?
- Cross-reference: base phase observations should show volume tolerance, tiredness mid-block, then lift
- Build/peak observations should show improved repeatability, faster test sets
- Flag if observations contradict the training stimulus
- For any swimmer with a target deadline within 6 weeks of block end: did this block move the needle toward it? Are they on track?
- Race results: only weight them as adaptation evidence if the phase is peak/taper/competition. For base/build phases, note them but do not use as primary evidence

5. Key Coaching Decision
The one most important thing to carry forward. This could be: a load adjustment, a group reassignment, a swimmer to watch closely, a phase intent that needs revising, or "continue as planned." Make it specific — name individuals if relevant.

6. Next Block Recommendation
Given what this block delivered: what phase type should come next, what should load do (increase/maintain/reduce), and is there anything about the group intents that needs updating?

FORMAT (use exactly these headers):
**Phase Delivery**
[2-3 sentences]

**Group Analysis**
[1-2 paragraphs — one per group with data]

**Attendance & Continuity**
[2-3 sentences, name individuals with gaps]

**Adaptation Signals**
[2-3 sentences from observations data]

**Key Coaching Decision**
[1-2 sentences — specific and named]

**Next Block Recommendation**
[2-3 sentences — phase, load direction, intent notes]

Total length: readable in 90 seconds at the pool. No waffle."""


def _build_block_review_context(block: models.SeasonBlock, db: DBSession) -> str:
    """Rich context for the block review skill — squad-level focus."""
    lines = []

    # Coaching philosophy first
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.append("COACHING PHILOSOPHY:")
        for ln in philosophy.split('\n'):
            lines.append(f"  {ln}")
        lines.append("")

    # Block basics
    total_weeks = max(1, round((block.date_to - block.date_from).days / 7))
    lines.append(f"BLOCK: {block.name} | Phase: {block.phase_type or 'unspecified'}")
    lines.append(f"Period: {block.date_from} to {block.date_to} ({total_weeks} weeks)")
    if block.notes:
        lines.append(f"Block notes: {block.notes[:300]}")

    # Macro context + group membership
    macro = None
    if block.macro_id:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.id == block.macro_id
        ).first()
    if macro:
        lines.append(f"Parent macro: {macro.name}")
        if macro.narrative:
            lines.append(f"Season narrative: {macro.narrative[:200]}")

    lines.append("")

    # Group intents
    if block.group_intents:
        lines.append("GROUP INTENTS (coach's stated goals for this block):")
        for g, intent in block.group_intents.items():
            if intent:
                lines.append(f"  {g}: {intent}")
    else:
        lines.append("GROUP INTENTS: None defined.")
    lines.append("")

    # Group membership from macro
    group_swimmer_map: dict = {}  # g_label -> list of (id, name)
    if macro and macro.group_definitions:
        lines.append("GROUP MEMBERSHIP:")
        for g_label, defn in macro.group_definitions.items():
            swimmer_ids = defn.get("swimmer_ids") or []
            names = []
            for sid in swimmer_ids:
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == sid).first()
                if sw:
                    names.append(sw.name)
                    group_swimmer_map.setdefault(g_label, []).append((sid, sw.name))
            desc = defn.get("description", "")
            lines.append(f"  {g_label}: {desc} — {', '.join(names) if names else 'none assigned'}")
        lines.append("")

    # Sessions within the block
    sessions_in_block = db.query(models.Session).filter(
        models.Session.date >= block.date_from,
        models.Session.date <= block.date_to,
        models.Session.status != 'cancelled',
    ).all()

    lines.append(f"SESSIONS IN BLOCK: {len(sessions_in_block)} total")
    if sessions_in_block:
        energy_counts: dict = defaultdict(int)
        for s in sessions_in_block:
            focus = s.energy_system_focus or "unspecified"
            energy_counts[focus] += 1
        lines.append("Energy system mix across sessions: " + ", ".join(
            f"{k}: {v}" for k, v in sorted(energy_counts.items(), key=lambda x: -x[1])
        ))
    lines.append("")

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    # Build ordered weeks for the block
    ordered_weeks = []
    d = block.date_from
    seen_wks = set()
    while d <= block.date_to:
        lbl = iso_week(d)
        if lbl not in seen_wks:
            ordered_weeks.append(lbl)
            seen_wks.add(lbl)
        d += timedelta(days=7)

    # Load data for the block period
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.session_date >= block.date_from,
        models.SwimmerSessionLoad.session_date <= block.date_to,
    ).all()

    # Per-group weekly aggregates
    group_weekly: dict = defaultdict(lambda: defaultdict(lambda: {k: 0 for k in VOLUME_KEYS}))
    swimmer_weekly: dict = defaultdict(lambda: defaultdict(lambda: {k: 0 for k in VOLUME_KEYS}))
    swimmer_ids_with_load = set()
    for load in loads:
        wk = iso_week(load.session_date)
        gnum = load.group_number or 0
        swimmer_ids_with_load.add(load.swimmer_id)
        for k in VOLUME_KEYS:
            v = (load.volume_breakdown or {}).get(k, 0)
            group_weekly[gnum][wk][k] += v
            swimmer_weekly[load.swimmer_id][wk][k] += v

    # Per-group weekly load summary
    lines.append("WEEKLY LOAD BY GROUP (metres):")
    for gnum in sorted(group_weekly.keys()):
        g_label = f"G{gnum}" if gnum > 0 else "unassigned"
        lines.append(f"  {g_label}:")
        for wk in ordered_weeks:
            vols = group_weekly[gnum][wk]
            total = sum(vols.values())
            if total > 0:
                zone_parts = [f"{k}:{vols[k]:.0f}" for k in VOLUME_KEYS if vols[k] > 0]
                lines.append(f"    {wk}: {total:.0f}m | {' | '.join(zone_parts)}")
            else:
                lines.append(f"    {wk}: no data")
    lines.append("")

    # Attendance per swimmer
    session_ids = {s.id for s in sessions_in_block}
    total_sessions = len(sessions_in_block)

    swimmer_attendance: dict = defaultdict(int)
    all_entries = db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id.in_(list(session_ids)),
    ).all() if session_ids else []
    for entry in all_entries:
        if entry.attended:
            swimmer_attendance[entry.swimmer_id] += 1

    # All swimmers who appeared in entries or loads
    all_swimmer_ids = (set(swimmer_attendance.keys()) | swimmer_ids_with_load)
    if all_swimmer_ids:
        lines.append(f"ATTENDANCE (out of {total_sessions} sessions):")
        all_swimmers = db.query(models.Swimmer).filter(
            models.Swimmer.id.in_(list(all_swimmer_ids))
        ).order_by(models.Swimmer.name).all()
        for sw in all_swimmers:
            attended = swimmer_attendance.get(sw.id, 0)
            pct = round((attended / total_sessions) * 100) if total_sessions > 0 else 0
            flag = " ← LOW ATTENDANCE" if pct < 70 and total_sessions >= 3 else ""
            lines.append(f"  {sw.name}: {attended}/{total_sessions} ({pct}%){flag}")
        lines.append("")

    # Per-swimmer load totals (block total by zone)
    if swimmer_weekly:
        lines.append("PER-SWIMMER BLOCK TOTALS:")
        for sw_id in sorted(swimmer_ids_with_load):
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == sw_id).first()
            if not sw:
                continue
            wk_data = swimmer_weekly[sw_id]
            block_vols = {k: sum(wk_data[wk].get(k, 0) for wk in ordered_weeks) for k in VOLUME_KEYS}
            block_total = sum(block_vols.values())
            if block_total > 0:
                zone_parts = [f"{k}:{block_vols[k]:.0f}m" for k in VOLUME_KEYS if block_vols[k] > 0]
                lines.append(f"  {sw.name}: {block_total/1000:.1f}km total | {' | '.join(zone_parts)}")
        lines.append("")

    # Poolside notes from session register (SessionEntry.coach_observation) during this block
    if session_ids:
        entry_obs = db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id.in_(list(session_ids)),
            models.SessionEntry.coach_observation != None,
            models.SessionEntry.coach_observation != '',
        ).order_by(models.SessionEntry.session_id.desc()).limit(30).all()

        if entry_obs:
            lines.append(f"POOLSIDE NOTES FROM REGISTERS ({len(entry_obs)} total):")
            for e in entry_obs:
                sess = db.query(models.Session).filter(models.Session.id == e.session_id).first()
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == e.swimmer_id).first()
                if sess and sw:
                    lines.append(f"  {sess.date} {sw.name}: {e.coach_observation[:160]}")
            lines.append("")

    # Formal observations logged during the block (SwimmerObservation)
    obs = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.date >= block.date_from,
        models.SwimmerObservation.date <= block.date_to,
    ).order_by(models.SwimmerObservation.date.desc()).limit(20).all()

    if obs:
        lines.append(f"LOGGED OBSERVATIONS DURING BLOCK ({len(obs)} total):")
        for o in obs:
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == o.swimmer_id).first()
            name = sw.name if sw else f"Swimmer {o.swimmer_id}"
            lines.append(f"  [{o.obs_type}] {o.date} {name}: {o.content[:200]}")
    else:
        lines.append("LOGGED OBSERVATIONS: None during this block.")
    lines.append("")

    # Before / after benchmarks — tightened window (4wk before, 1wk after block end)
    bm_pre_window = timedelta(weeks=4)
    bm_post_window = timedelta(weeks=1)
    from sqlalchemy import desc as _bm_desc
    bm_before = db.query(models.BenchmarkLog).filter(
        models.BenchmarkLog.date >= block.date_from - bm_pre_window,
        models.BenchmarkLog.date < block.date_from,
    ).order_by(_bm_desc(models.BenchmarkLog.date)).limit(40).all()

    bm_after = db.query(models.BenchmarkLog).filter(
        models.BenchmarkLog.date >= block.date_from,
        models.BenchmarkLog.date <= block.date_to + bm_post_window,
    ).order_by(_bm_desc(models.BenchmarkLog.date)).limit(40).all()

    if bm_before or bm_after:
        lines.append("BENCHMARK COMPARISON (up to 4wk before block vs during/1wk after — reflects this block's adaptation):")
        bm_map: dict = defaultdict(lambda: {"before": None, "after": None})
        for b in bm_before:
            key = (b.swimmer_id, f"{b.distance}m {b.stroke} {b.effort}")
            if bm_map[key]["before"] is None:
                bm_map[key]["before"] = b
        for b in bm_after:
            key = (b.swimmer_id, f"{b.distance}m {b.stroke} {b.effort}")
            if bm_map[key]["after"] is None:
                bm_map[key]["after"] = b
        for (sw_id, cat), bm in bm_map.items():
            if bm["before"] and bm["after"]:
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == sw_id).first()
                name = sw.name if sw else f"Swimmer {sw_id}"
                diff = bm["after"].time_seconds - bm["before"].time_seconds
                direction = "IMPROVED" if diff < -0.5 else "SLOWER" if diff > 0.5 else "STABLE"
                lines.append(f"  {name} {cat}: {bm['before'].time_seconds:.2f}s → {bm['after'].time_seconds:.2f}s ({diff:+.2f}s) {direction}")
        lines.append("")

    # Race results during and up to 2 weeks after block end — phase-tagged
    from sqlalchemy import desc as _rt_desc
    race_cutoff_from = block.date_from
    race_cutoff_to = block.date_to + timedelta(weeks=2)
    race_times = db.query(models.SwimTime).filter(
        models.SwimTime.date >= race_cutoff_from,
        models.SwimTime.date <= race_cutoff_to,
    ).order_by(_rt_desc(models.SwimTime.date)).limit(30).all()

    if race_times:
        lines.append(f"RACE RESULTS DURING/AFTER BLOCK (phase: {block.phase_type or 'unspecified'}):")
        if block.phase_type in ("base", "build", "aerobic"):
            lines.append("  NOTE: This was a base/build phase. Race results carry low diagnostic weight — fatigue and technique change expected.")
        for t in race_times:
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == t.swimmer_id).first()
            name = sw.name if sw else f"Swimmer {t.swimmer_id}"
            wa = f" ({t.wa_points:.0f} WA pts)" if t.wa_points else ""
            lines.append(f"  {t.date} {name}: {t.event} — {t.time_seconds:.2f}s{wa}")
        lines.append("")

    # Swimmer targets — flag any with deadlines in or near this block
    target_window_end = block.date_to + timedelta(weeks=6)
    block_targets = db.query(models.SwimmerTarget).filter(
        models.SwimmerTarget.achieved == False,
        models.SwimmerTarget.deadline != None,
        models.SwimmerTarget.deadline <= target_window_end,
    ).order_by(models.SwimmerTarget.deadline).all()

    if block_targets:
        lines.append("SWIMMER TARGETS RELEVANT TO THIS BLOCK (deadline within 6 weeks of block end):")
        for tgt in block_targets:
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == tgt.swimmer_id).first()
            if not sw:
                continue
            if tgt.target_time_seconds and tgt.distance and tgt.stroke and tgt.effort:
                bm = db.query(models.BenchmarkLog).filter(
                    models.BenchmarkLog.swimmer_id == tgt.swimmer_id,
                    models.BenchmarkLog.distance == tgt.distance,
                    models.BenchmarkLog.stroke == tgt.stroke,
                    models.BenchmarkLog.effort == tgt.effort,
                ).order_by(_bm_desc(models.BenchmarkLog.date)).first()
                if bm:
                    gap = bm.time_seconds - tgt.target_time_seconds
                    status = f"current {bm.time_seconds:.2f}s | {'+' if gap > 0 else ''}{gap:.2f}s to target"
                else:
                    status = "no benchmark recorded"
                lines.append(f"  {sw.name}: {tgt.label} — target {tgt.target_time_seconds:.2f}s | {status} | deadline {tgt.deadline}")
            else:
                lines.append(f"  {sw.name}: {tgt.label} | deadline {tgt.deadline}")
        lines.append("")

    # Previous block baseline — for load progression comparison
    prev_block = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_to < block.date_from,
        models.SeasonBlock.macro_id == block.macro_id,
    ).order_by(models.SeasonBlock.date_to.desc()).first()

    if not prev_block and block.macro_id is None:
        prev_block = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.date_to < block.date_from,
        ).order_by(models.SeasonBlock.date_to.desc()).first()

    if prev_block:
        prev_loads = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.session_date >= prev_block.date_from,
            models.SwimmerSessionLoad.session_date <= prev_block.date_to,
        ).all()
        prev_group_totals: dict = defaultdict(float)
        prev_session_counts: dict = defaultdict(int)
        for pl in prev_loads:
            gnum = pl.group_number or 0
            prev_group_totals[gnum] += sum((pl.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS)
            prev_session_counts[gnum] += 1

        prev_weeks = max(1, round((prev_block.date_to - prev_block.date_from).days / 7))
        lines.append(f"PREVIOUS BLOCK BASELINE: {prev_block.name} ({prev_block.phase_type or '?'}, {prev_weeks}w)")
        for gnum in sorted(prev_group_totals.keys()):
            if gnum > 0:
                sessions = prev_session_counts[gnum]
                avg_per_session = prev_group_totals[gnum] / sessions if sessions > 0 else 0
                lines.append(f"  G{gnum}: {prev_group_totals[gnum]/1000:.1f}km total | {avg_per_session:.0f}m/session avg ({sessions} sessions)")
        lines.append("(Use this to assess whether current block represents load progression, plateau, or reduction)")
        lines.append("")

    return "\n".join(lines)


def run_block_review(
    block_id: int,
    db: DBSession,
    coach_context: Optional[str] = None,
    brief: bool = False,
) -> dict:
    """
    Core block review skill — callable from HTTP endpoint or internal chat routing.
    Returns { reply, block_id, block_name, analysis }.
    """
    block = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == block_id).first()
    if not block:
        return {
            "reply": f"Block {block_id} not found.",
            "block_id": block_id,
            "block_name": None,
            "analysis": None,
        }

    context = _build_block_review_context(block, db)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""{context}{thread_block}

Perform the block review for '{block.name}' now using the framework."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        system=BLOCK_REVIEW_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    analysis = response.content[0].text.strip()

    reply = f"**Block Review — {block.name}**\n\n{analysis}"
    if brief:
        reply = f"**Block — {block.name}**\n\n{_make_brief_reply(analysis)}"

    _save_skill_output(
        db, "block_review", reply,
        entity_type="block", entity_id=block.id, entity_name=block.name,
    )

    return {
        "reply": reply,
        "analysis": analysis,
        "block_id": block.id,
        "block_name": block.name,
    }


@router.post("/review-block")
def review_block(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Block review skill — squad-level analysis of how a meso-cycle was delivered.
    Covers phase delivery, group analysis, attendance, adaptation signals, and next block recommendation.
    """
    block_id = body.get("block_id")
    thread_id = body.get("thread_id")

    if not block_id:
        raise HTTPException(status_code=400, detail="block_id required")

    try:
        result = run_block_review(block_id, db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Block review skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Race Analysis Skill
# ---------------------------------------------------------------------------

RACE_ANALYSIS_SYSTEM = """You are a specialist race analyst for competitive swimming. Your job is to assess how a squad performed at a meet, what the race results reveal about training effectiveness, and what should change.

Apply this framework. Be direct — name swimmers, reference specific events and times. No generic sports science.

USING SWIMMER PROFILES:
Where swimmer profiles are provided (target events, strengths, development areas, sprint/endurance tendency), use them to contextualise split patterns:
- A sprint-biased swimmer producing a large positive split in a 100 is concerning; a distance swimmer producing one is less surprising
- A swimmer with "weak back half" as a development area who still positive-splits confirms a known issue; if they improved it, flag it
- Use the sprint/endurance profile to assess whether race selection is appropriate

TRAINING BENCHMARKS:
Where TRAINING BENCHMARKS data is provided, use it to assess whether race performances reflect training capability:
- If a swimmer beat their training benchmark: notable — they performed above their known training ceiling, good signal
- If a swimmer matched benchmark: consistent — training and racing are aligned
- If a swimmer missed benchmark by >1s: flag it — below training capability, potential taper, nerves, or preparation issue
- In Next Steps: where benchmarks were beaten, explicitly suggest updating them (state the new time). This allows the coach to confirm updates via chat.

FRAMEWORK:

1. Meet Overview
Squad summary: how many swimmers competed, how many events, overall performance vs targets.
- Count: PBs achieved, targets HIT, targets MISSED (use the explicit HIT/MISSED labels from the data)
- Flag: any unexpected standout performances (much faster or much slower than target/benchmark)
- If no targets were set: comment on times relative to previous personal bests in the time data

2. Taper Response
Did the training load reduction before the meet work?
- Look at training load in the 2-3 weeks before the meet vs the 4-6 weeks prior
- A good taper: load drops 30-50%, intensity maintained → swimmer arrives fresh
- Signs of over-taper: very low load 2+ weeks out → flat performance, lacking sharpness
- Signs of under-taper: high load right up to meet → heavy legs, missing target times
- Assign each swimmer a taper response: Peaked / Adequate / Flat / Unclear (if no pre-meet load data)
- Name specific swimmers — don't just say "some swimmers"

3. Split Analysis
For swimmers who have split data: what do the splits reveal?
- Front-end vs back-end speed: going out too fast (positive split = pace fades), negative splitting (strong finish), or even splits
- Use swimmer profiles to interpret: sprint-biased swimmers, distance swimmers, and known development areas all change what a split pattern means
- Event-specific expectations:
  - Sprint (50-100m): want even splits or slightly negative; a large positive split = strength deficit or anaerobic power issue
  - Middle distance (200-400m): negative split or even pace for 400m is elite; positive split = aerobic capacity gap
  - Distance (800-1500m): steady acceleration through the race is normal; big positive split = pacing error or fatigue
- Identify the dominant split pattern across the squad and what it means for training
- If splits are missing for most swimmers, note it briefly and skip detail

4. Training-Race Connection
Did what was trained show up in performance?
- Race pace work in training → should show in front-end speed and repeatability in heats vs finals
- Aerobic base work → should show in back-end resilience and even splits
- A swimmer who did mostly aerobic base but competed in sprint events: may show strong back half, weaker start
- Flag disconnects: if training was threshold-heavy but race performance shows poor repeatability, the stimulus may not be right
- Cross-reference with benchmark data: swimmers who beat their training benchmarks at this meet are transferring training effectively
- If pre-meet training data is sparse, say so and focus only on what can be assessed

5. Individual Flags (up to 3 swimmers)
The most coaching-relevant individual findings. Pick: biggest PB, biggest miss vs target, best taper response, worst taper response, beat training benchmark, or a split pattern that needs addressing. One sentence per swimmer — be specific.

6. Next Steps
Two or three concrete actions for the next training block. Options: adjust taper timing, change energy system emphasis, address a split issue, adjust group assignments, target specific events at next meet.
IMPORTANT: If any swimmer beat their training benchmark, include a specific line: "Update benchmark — [Swimmer]: [event] to [new time]". The coach will confirm these updates via chat, and they will be logged.

FORMAT (use exactly these headers):
**Meet Overview**
[3-4 sentences]

**Taper Response**
[3-4 sentences, name swimmers]

**Split Analysis**
[2-4 sentences — if no split data, say so in one sentence and skip]

**Training-Race Connection**
[2-3 sentences]

**Individual Flags**
- [Swimmer name]: [one specific finding]
- [Swimmer name]: [one specific finding]
- [Swimmer name]: [one specific finding if relevant]

**Next Steps**
- [action 1]
- [action 2]
- [action 3 if relevant — benchmark updates go here if applicable]

Total length: readable in 2 minutes. Be specific, name names, reference actual times."""


def _fmt_time(seconds: float) -> str:
    """Format seconds as m:ss.xx or ss.xx."""
    if seconds < 60:
        return f"{seconds:.2f}s"
    m = int(seconds // 60)
    s = seconds - m * 60
    return f"{m}:{s:05.2f}"


def _build_race_analysis_context(meet: models.Meet, db: DBSession) -> str:
    """Rich context for the race analysis skill."""
    lines = []
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.extend(["COACHING CONTEXT:", philosophy, ""])

    meet_end = meet.date_to or meet.date
    meet_start = meet.date

    lines.append(f"MEET: {meet.name}")
    if meet.date:
        date_str = str(meet.date) + (f" – {meet.date_to}" if meet.date_to and meet.date_to != meet.date else "")
        lines.append(f"Date: {date_str} | Course: {meet.course or 'unknown'} | Level: {meet.level or 'unknown'}")
    if meet.notes:
        lines.append(f"Notes: {meet.notes[:200]}")
    lines.extend(_meet_timetable_lines(meet, limit_sessions=8, limit_events=20))
    lines.append("")

    # Meet targets per swimmer
    targets_list = db.query(models.MeetTarget).filter(
        models.MeetTarget.meet_id == meet.id,
    ).all()

    target_map: dict = {}
    for t in targets_list:
        target_map[t.swimmer_id] = {
            "events": t.events or [],
            "priority": t.priority,
            "target_times": t.target_times or {},
            "notes": t.notes,
        }

    # Build swimmer profile map for all swimmers with targets or results
    # (populated now, used throughout)
    from sqlalchemy import desc as _sw_desc

    def _swimmer_profile_line(sw: models.Swimmer) -> str:
        parts = []
        if sw.target_events:
            events = [e.get('event', '') if isinstance(e, dict) else str(e) for e in sw.target_events[:4]]
            parts.append(f"target events: {', '.join(events)}")
        if sw.strengths:
            parts.append(f"strengths: {sw.strengths[:80]}")
        if sw.weaknesses:
            parts.append(f"development: {sw.weaknesses[:80]}")
        if sw.physical_profile and isinstance(sw.physical_profile, dict):
            sprint = sw.physical_profile.get('sprint_tendency') or sw.physical_profile.get('sprint_vs_endurance')
            if sprint:
                parts.append(f"sprint/endurance profile: {str(sprint)[:60]}")
        return " | ".join(parts) if parts else "no profile data"

    if target_map:
        lines.append(f"SWIMMERS WITH MEET TARGETS ({len(target_map)}):")
        for sw_id, tdata in target_map.items():
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == sw_id).first()
            if sw:
                events_str = ", ".join(tdata["events"]) if tdata["events"] else "events not specified"
                priority = f" [Priority {tdata['priority']}]" if tdata["priority"] else ""
                lines.append(f"  {sw.name}{priority}: {events_str}")
                lines.append(f"    Profile: {_swimmer_profile_line(sw)}")
                for ev, ttime in (tdata["target_times"] or {}).items():
                    lines.append(f"    Target time: {ev} → {ttime}")
                if tdata.get("notes"):
                    lines.append(f"    Notes: {tdata['notes'][:100]}")
        lines.append("")
    else:
        lines.append("MEET TARGETS: None set — analysis will use PBs as reference.\n")

    # Times recorded at this meet — match by meet name OR date range
    from sqlalchemy import or_ as sa_or
    times_at_meet = []
    if meet_start:
        times_at_meet = db.query(models.SwimTime).filter(
            sa_or(
                models.SwimTime.meet.ilike(f"%{meet.name[:20]}%"),
                models.SwimTime.date.between(meet_start, meet_end or meet_start),
            )
        ).order_by(models.SwimTime.swimmer_id, models.SwimTime.event).all()

    swimmer_times: dict = defaultdict(list)
    seen_time_ids: set = set()
    for t in times_at_meet:
        if t.id not in seen_time_ids:
            swimmer_times[t.swimmer_id].append(t)
            seen_time_ids.add(t.id)

    if swimmer_times:
        lines.append(f"RACE RESULTS ({len(swimmer_times)} swimmers, {sum(len(v) for v in swimmer_times.values())} times):")
        for sw_id, sw_times in swimmer_times.items():
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == sw_id).first()
            if not sw:
                continue
            # Show profile inline if not already shown in the targets section
            if sw_id not in target_map:
                lines.append(f"  {sw.name} [{_swimmer_profile_line(sw)}]:")
            else:
                lines.append(f"  {sw.name}:")

            # Group by event for heat vs final comparison
            by_event: dict = defaultdict(list)
            for t in sw_times:
                by_event[t.event].append(t)

            for event, ev_times in by_event.items():
                # Sort by round order: Heat < Semi < Final, then by time
                round_order = {"heat": 0, "semi": 1, "semifinal": 1, "final": 2}
                ev_times.sort(key=lambda x: (round_order.get((x.round or "").lower(), 1), x.time_seconds))

                # 12-month trend for this event (all times in the year before this meet)
                twelve_months_ago = (meet_start - timedelta(days=365)) if meet_start else None
                trend_times = db.query(models.SwimTime).filter(
                    models.SwimTime.swimmer_id == sw_id,
                    models.SwimTime.event == event,
                    models.SwimTime.date < meet_start,
                    models.SwimTime.date >= twelve_months_ago,
                ).order_by(models.SwimTime.date.asc()).all() if meet_start else []

                pb = min((t.time_seconds for t in trend_times), default=None) if trend_times else None
                trend_str = ""
                if trend_times:
                    trend_vals = " → ".join(
                        f"{_fmt_time(t.time_seconds)} ({t.date.strftime('%b %y') if t.date else '?'})"
                        for t in trend_times
                    )
                    trend_str = f"12m trend: {trend_vals}"

                # Heat vs Final within this meet
                if len(ev_times) > 1:
                    heat_t = ev_times[0]
                    final_t = ev_times[-1]
                    hf_diff = final_t.time_seconds - heat_t.time_seconds
                    hf_str = f"{_fmt_time(heat_t.time_seconds)} [{heat_t.round or 'H'}] → {_fmt_time(final_t.time_seconds)} [{final_t.round or 'F'}] ({hf_diff:+.2f}s heat→final)"
                    # Target comparison uses the best (final) time
                    best_t = final_t
                else:
                    best_t = ev_times[0]
                    hf_str = None

                # PB comparison using best time
                pb_str = ""
                if pb is not None:
                    diff = best_t.time_seconds - pb
                    if diff < -0.1:
                        pb_str = " ← PB"
                    elif diff > 0.1:
                        pb_str = f" ({diff:+.2f}s off PB {_fmt_time(pb)})"

                # Target comparison — explicit HIT / MISSED label
                tgt_str = ""
                if sw_id in target_map:
                    event_short = event.replace(" SCM", "").replace(" LCM", "")
                    for k, v in (target_map[sw_id]["target_times"] or {}).items():
                        if event_short.lower() in k.lower() or k.lower() in event_short.lower():
                            try:
                                v_str = str(v)
                                tgt_secs = float(v_str.split(':')[0]) * 60 + float(v_str.split(':')[1]) if ':' in v_str else float(v_str)
                                gap = best_t.time_seconds - tgt_secs
                                if gap <= 0:
                                    tgt_str = f" | TARGET HIT ✓ ({gap:+.2f}s vs {_fmt_time(tgt_secs)})"
                                else:
                                    tgt_str = f" | MISSED TARGET by {gap:.2f}s (target {_fmt_time(tgt_secs)})"
                            except (ValueError, IndexError):
                                tgt_str = f" | target: {v}"
                            break

                if hf_str:
                    lines.append(f"    {event}: {hf_str}{pb_str}{tgt_str}")
                else:
                    round_str = f" [{best_t.round}]" if best_t.round else ""
                    lines.append(f"    {event}{round_str}: {_fmt_time(best_t.time_seconds)}{pb_str}{tgt_str}")

                if trend_str:
                    lines.append(f"      {trend_str.strip()}")

                # Splits for best/final time
                if best_t.splits and any(s for s in best_t.splits if s):
                    valid_splits = [s for s in best_t.splits if s]
                    if len(valid_splits) >= 2:
                        legs, prev_s = [], 0.0
                        for sp in valid_splits:
                            legs.append(sp - prev_s)
                            prev_s = sp
                        lines.append(f"      50m legs: {' / '.join(f'{leg:.2f}' for leg in legs)}")
        lines.append("")
    else:
        lines.append("RACE RESULTS: No times found matching this meet name or date.\n")

    # Training benchmarks — race time vs current training benchmark per swimmer/event
    if swimmer_times:
        bench_lines = []
        for sw_id, sw_times in swimmer_times.items():
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == sw_id).first()
            if not sw:
                continue
            by_event: dict = defaultdict(list)
            for t in sw_times:
                by_event[t.event].append(t)

            sw_bench_lines = []
            for event, ev_times in by_event.items():
                # Determine stroke and distance from event string
                # e.g. "100 Freestyle SCM" → distance=100, stroke="free"
                event_norm = event.lower().replace(" scm", "").replace(" lcm", "").strip()
                stroke_map = {"freestyle": "free", "backstroke": "back", "breaststroke": "breast",
                              "butterfly": "fly", "free": "free", "back": "back",
                              "breast": "breast", "fly": "fly", "medley": "im"}
                matched_stroke = None
                for word, sk in stroke_map.items():
                    if word in event_norm:
                        matched_stroke = sk
                        break
                dist = None
                for token in event_norm.split():
                    if token.isdigit():
                        dist = int(token)
                        break

                if not matched_stroke or not dist:
                    continue

                # Get the most recent max-effort benchmark for this swimmer/stroke/distance
                bench = db.query(models.BenchmarkLog).filter(
                    models.BenchmarkLog.swimmer_id == sw_id,
                    models.BenchmarkLog.stroke == matched_stroke,
                    models.BenchmarkLog.distance == dist,
                    models.BenchmarkLog.effort == "max",
                    models.BenchmarkLog.date < (meet_start or date.today()),
                ).order_by(models.BenchmarkLog.date.desc()).first()

                if not bench:
                    continue

                # Best race time at this meet
                ev_times_sorted = sorted(ev_times, key=lambda x: x.time_seconds)
                best_race = ev_times_sorted[0]
                gap = best_race.time_seconds - bench.time_seconds
                bench_age_days = (meet_start - bench.date).days if meet_start and bench.date else None
                age_str = f" (benchmark from {bench.date}, {bench_age_days}d before meet)" if bench_age_days is not None else ""

                if gap <= -0.5:
                    label = f"BEAT training benchmark by {abs(gap):.2f}s — update benchmark"
                elif gap <= 0:
                    label = f"matched training benchmark ({gap:+.2f}s)"
                else:
                    label = f"{gap:+.2f}s off training benchmark"

                sw_bench_lines.append(f"    {event}: race {_fmt_time(best_race.time_seconds)} vs benchmark {_fmt_time(bench.time_seconds)} → {label}{age_str}")

            if sw_bench_lines:
                bench_lines.append(f"  {sw.name}:")
                bench_lines.extend(sw_bench_lines)

        if bench_lines:
            lines.append("TRAINING BENCHMARKS (max-effort, race vs benchmark):")
            lines.extend(bench_lines)
            lines.append("  Note: where race beats benchmark, suggest updating it in Next Steps.")
            lines.append("")

    # Pre-meet training load (8 weeks before meet)
    if meet_start:
        pre_meet_start = meet_start - timedelta(weeks=8)
        loads = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.session_date >= pre_meet_start,
            models.SwimmerSessionLoad.session_date < meet_start,
        ).all()

        swimmer_pre_load: dict = defaultdict(lambda: {"taper": {k: 0 for k in VOLUME_KEYS}, "pre": {k: 0 for k in VOLUME_KEYS}, "base": {k: 0 for k in VOLUME_KEYS}})
        for load in loads:
            days_out = (meet_start - load.session_date).days
            bucket = "taper" if days_out <= 14 else "pre" if days_out <= 28 else "base"
            for k in VOLUME_KEYS:
                swimmer_pre_load[load.swimmer_id][bucket][k] += (load.volume_breakdown or {}).get(k, 0)

        all_relevant_sw_ids = set(swimmer_times.keys()) | set(target_map.keys())
        sw_ids_with_load = {sw_id for sw_id in all_relevant_sw_ids if sw_id in swimmer_pre_load}

        if sw_ids_with_load:
            lines.append("PRE-MEET TRAINING LOAD:")
            for sw_id in sorted(sw_ids_with_load):
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == sw_id).first()
                if not sw:
                    continue
                pl = swimmer_pre_load[sw_id]
                base_pw = sum(pl["base"].values()) / 4
                pre_pw = sum(pl["pre"].values()) / 2
                taper_pw = sum(pl["taper"].values()) / 2
                taper_note = ""
                if base_pw > 0:
                    pct = round((1 - taper_pw / base_pw) * 100)
                    taper_note = f" ({pct}% reduction vs base)"
                lines.append(f"  {sw.name}: base avg {base_pw:.0f}m/wk → pre-taper {pre_pw:.0f}m/wk → final 2wks {taper_pw:.0f}m/wk{taper_note}")
            lines.append("")

    # Race observations around the meet
    if meet_start:
        obs_start = meet_start - timedelta(days=3)
        obs_end = (meet_end or meet_start) + timedelta(days=3)
        obs = db.query(models.SwimmerObservation).filter(
            models.SwimmerObservation.date >= obs_start,
            models.SwimmerObservation.date <= obs_end,
            models.SwimmerObservation.obs_type == 'race',
        ).order_by(models.SwimmerObservation.date.desc()).limit(20).all()

        if obs:
            lines.append(f"RACE OBSERVATIONS ({len(obs)}):")
            for o in obs:
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == o.swimmer_id).first()
                name = sw.name if sw else f"Swimmer {o.swimmer_id}"
                lines.append(f"  {o.date} {name}: {o.content[:200]}")
            lines.append("")

    return "\n".join(lines)


def run_race_analysis(
    meet_id: int,
    db: DBSession,
    coach_context: Optional[str] = None,
    brief: bool = False,
) -> dict:
    """
    Core race analysis skill — callable from HTTP endpoint or internal chat routing.
    Returns { reply, meet_id, meet_name, analysis }.
    """
    meet = db.query(models.Meet).filter(models.Meet.id == meet_id).first()
    if not meet:
        return {
            "reply": f"Meet {meet_id} not found.",
            "meet_id": meet_id,
            "meet_name": None,
            "analysis": None,
        }

    context = _build_race_analysis_context(meet, db)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""{context}{thread_block}

Perform the race analysis for '{meet.name}' now using the framework."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1800,
        system=RACE_ANALYSIS_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    analysis = response.content[0].text.strip()

    reply = f"**Race Analysis — {meet.name}**\n\n{analysis}"
    if brief:
        reply = f"**{meet.name} — Key Findings**\n\n{_make_brief_reply(analysis)}"

    _save_skill_output(
        db, "race_analysis", reply,
        entity_type="meet", entity_id=meet.id, entity_name=meet.name,
    )

    return {
        "reply": reply,
        "analysis": analysis,
        "meet_id": meet.id,
        "meet_name": meet.name,
    }


@router.post("/analyse-meet")
def analyse_meet(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Race analysis skill — post-meet analysis covering taper response, split patterns,
    training-race connection, individual flags, and next steps.
    """
    meet_id = body.get("meet_id")
    thread_id = body.get("thread_id")

    if not meet_id:
        raise HTTPException(status_code=400, detail="meet_id required")

    try:
        result = run_race_analysis(meet_id, db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Race analysis skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Group Composition Skill
# ---------------------------------------------------------------------------

SUGGEST_GROUPS_SYSTEM = """You are a specialist swimming coach analyst. Your job is to recommend how a squad of swimmers should be divided into training groups.

You output ONLY valid JSON — no markdown fences, no prose outside the JSON.

CORE PRINCIPLE — GROUPS ARE TRAINING NEEDS, NOT RANKINGS:
Groups are not a performance ranking. They are built around what sessions each swimmer needs. Two swimmers at similar performance levels may need completely different training stimuli — a sprinter and a distance swimmer, a high-attender vs someone who trains 2x/week, an improving junior vs an established senior. The goal is to create groups where the coach can write sessions that genuinely serve all members.

GROUPING AXES — consider all of these, not just times:
1. LOAD CAPACITY — how much volume can they absorb and recover from? (from session load data)
2. SESSION FREQUENCY — how many times/week do they attend? A 2x/week swimmer cannot ride the progression of a 5x/week group. They need a group where missing 2 sessions isn't catastrophic.
3. EVENT SPECIALISATION — sprint (50-100m) vs middle distance (200-400m) vs distance (800m+) vs IM. These need fundamentally different session emphases. If a group is heavily mixed, note that and suggest how the coach manages it.
4. DEVELOPMENT TRAJECTORY — is the swimmer improving fast (needs challenge)? Plateaued (may need different stimulus)? Post-peak or returning from injury (needs careful load management)?
5. TARGET ALIGNMENT — if multiple swimmers are targeting the same meet or event, grouping them together for the lead-up phase makes coordination easier.
6. PRACTICAL COACHING — the coach has to run this on pool deck. A group that requires 4 different sets simultaneously is unmanageable. Weight practicality.

WHAT NOT TO DO:
- Do not rank swimmers and split into top/middle/bottom. That is too simplistic.
- Do not suggest more groups than the coach can realistically manage (usually 2-4).
- Do not assign every swimmer a different group because their needs differ slightly — find the clusters.
- Do not comment on individual performance quality. You can note load capacity and trajectory from data, but do not characterise swimmers as "good" or "weak".

BORDERLINE CASES:
For swimmers who sit between groups, present both options with the trade-off explicitly. The coach decides — you surface the question, not the answer.

CURRENT vs PROPOSED:
If current group assignments are provided, compare and flag moves. Do not suggest unnecessary disruption — only flag a move if there's a genuine training need reason, not just because the data slightly shifted.

OUTPUT FORMAT (JSON only, no markdown):
{
  "proposed_groups": [
    {
      "label": "use existing label if there's a macro, otherwise suggest a descriptive name",
      "description": "what unifies this group's training needs in 1 sentence",
      "defining_characteristics": "load capacity, frequency, event mix, or other key shared trait",
      "swimmers": [
        {
          "name": "swimmer name",
          "rationale": "1 sentence: why this group fits this swimmer specifically"
        }
      ],
      "session_approach": "what sessions for this group typically look like — energy emphasis, volume range, key format"
    }
  ],
  "borderline_cases": [
    {
      "swimmer": "name",
      "between_groups": ["group A", "group B"],
      "case_for_higher": "specific reason",
      "case_for_lower": "specific reason",
      "lean": "slight lean toward X — but coach knows this swimmer"
    }
  ],
  "moves_from_current": [
    {
      "swimmer": "name",
      "from_group": "current group label",
      "to_group": "proposed group label",
      "reason": "specific training need reason for the move"
    }
  ],
  "event_mix_notes": "1-2 sentences on how event specialisation is distributed across groups and how the coach should handle mixed-event groups",
  "squad_notes": "1-2 sentences: anything notable about overall squad composition that affects how groups should work",
  "rationale": "2-3 sentences: the overall grouping logic applied — what drove the main decisions"
}"""


def _build_squad_profile(db: DBSession, macro_id: Optional[int] = None) -> str:
    """Build a per-swimmer profile summary for the whole active squad."""
    today = date.today()
    eight_weeks_ago = today - timedelta(weeks=8)
    twelve_months_ago = today - timedelta(days=365)

    # Current macro for existing group assignments
    macro = None
    if macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.date_from <= today,
            models.TrainingMacro.date_to >= today,
        ).order_by(models.TrainingMacro.date_from).first()

    # Build current group membership map
    current_group_map: dict = {}  # swimmer_id -> group_label
    if macro and macro.group_definitions:
        for g_label, defn in macro.group_definitions.items():
            for sid in (defn.get("swimmer_ids") or []):
                current_group_map[sid] = g_label

    lines = []
    lines.append(f"TODAY: {today}")
    lines.append("")

    # Coaching philosophy
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.append("COACHING PHILOSOPHY:")
        for ln in philosophy.split('\n'):
            lines.append(f"  {ln}")
        lines.append("")

    if macro:
        lines.append(f"CURRENT MACRO: {macro.name} | {macro.date_from} to {macro.date_to}")
        if macro.group_definitions:
            lines.append("Existing groups:")
            for g_label, defn in macro.group_definitions.items():
                sw_ids = defn.get("swimmer_ids") or []
                names = []
                for sid in sw_ids:
                    sw = db.query(models.Swimmer).filter(models.Swimmer.id == sid).first()
                    if sw:
                        names.append(sw.name)
                lines.append(f"  {g_label}: {defn.get('description', '')} — {', '.join(names) if names else 'unassigned'}")
        lines.append("")

    # Per-swimmer profiles
    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.active == True,
        models.Swimmer.status == "active",
    ).order_by(models.Swimmer.name).all()

    lines.append(f"SQUAD ({len(swimmers)} active swimmers):")
    lines.append("")

    for sw in swimmers:
        current_group = current_group_map.get(sw.id, "unassigned")

        # Age
        age_str = ""
        if sw.dob:
            age = (today - sw.dob).days // 365
            age_str = f"age {age}"

        # Target events
        events_str = ""
        if sw.target_events:
            evs = [e.get('event', '') if isinstance(e, dict) else str(e) for e in sw.target_events[:4]]
            events_str = ", ".join(e for e in evs if e)

        # Sprint vs distance tendency
        tendency = ""
        if sw.physical_profile and isinstance(sw.physical_profile, dict):
            t = sw.physical_profile.get('sprint_tendency') or sw.physical_profile.get('sprint_vs_endurance')
            if t:
                tendency = str(t)[:50]

        header_parts = [sw.name]
        if age_str:
            header_parts.append(age_str)
        if sw.gender:
            header_parts.append(sw.gender)
        if current_group != "unassigned":
            header_parts.append(f"currently {current_group}")
        lines.append(f"  {'  |  '.join(header_parts)}")

        if events_str:
            lines.append(f"    Events: {events_str}")
        if tendency:
            lines.append(f"    Tendency: {tendency}")
        if sw.strengths:
            lines.append(f"    Strengths: {sw.strengths[:100]}")
        if sw.weaknesses:
            lines.append(f"    Development: {sw.weaknesses[:100]}")

        # Session attendance last 8 weeks
        loads_8w = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.swimmer_id == sw.id,
            models.SwimmerSessionLoad.session_date >= eight_weeks_ago,
        ).all()

        if loads_8w:
            sessions_per_week = len(loads_8w) / 8
            total_vol = sum(sum((l.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS) for l in loads_8w)
            avg_per_session = total_vol / len(loads_8w) if loads_8w else 0
            # Zone breakdown
            zone_totals = {k: sum((l.volume_breakdown or {}).get(k, 0) for l in loads_8w) for k in VOLUME_KEYS}
            dominant_zone = max(zone_totals, key=lambda k: zone_totals[k]) if total_vol > 0 else "unknown"
            lines.append(f"    Load (8wk): {sessions_per_week:.1f} sessions/wk | avg {avg_per_session:.0f}m/session | dominant zone: {dominant_zone}")
        else:
            lines.append(f"    Load (8wk): no data")

        # Regular pool slots (attendance pattern)
        slots = db.query(models.SwimmerSlot).filter(
            models.SwimmerSlot.swimmer_id == sw.id,
        ).all()
        if slots:
            DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            slot_days = sorted({s.pool_slot.day_of_week for s in slots if s.pool_slot})
            slot_str = ", ".join(DAYS_SHORT[d] for d in slot_days)
            lines.append(f"    Regular slots ({len(slots)}): {slot_str}")

        # Best times last 12 months (top 2 events)
        recent_times = db.query(models.SwimTime).filter(
            models.SwimTime.swimmer_id == sw.id,
            models.SwimTime.date >= twelve_months_ago,
        ).order_by(models.SwimTime.date.desc()).all()

        if recent_times:
            by_event: dict = defaultdict(list)
            for t in recent_times:
                by_event[t.event].append(t.time_seconds)
            best_by_event = {ev: min(ts) for ev, ts in by_event.items()}
            top_events = sorted(best_by_event.items(), key=lambda x: x[1])[:2]
            times_str = " | ".join(f"{ev}: {_fmt_time(t)}" for ev, t in top_events)
            lines.append(f"    Recent bests: {times_str}")

        # Max-effort benchmarks
        benches = db.query(models.BenchmarkLog).filter(
            models.BenchmarkLog.swimmer_id == sw.id,
            models.BenchmarkLog.effort == "max",
        ).order_by(models.BenchmarkLog.date.desc()).limit(3).all()
        if benches:
            bench_str = " | ".join(f"{b.distance}m {b.stroke}: {_fmt_time(b.time_seconds)}" for b in benches)
            lines.append(f"    Benchmarks (max): {bench_str}")

        # Unachieved targets
        targets = db.query(models.SwimmerTarget).filter(
            models.SwimmerTarget.swimmer_id == sw.id,
            models.SwimmerTarget.achieved == False,
        ).order_by(models.SwimmerTarget.deadline).limit(3).all()
        if targets:
            tgt_parts = []
            for t in targets:
                label = t.label
                deadline_str = f" by {t.deadline}" if t.deadline else ""
                tgt_parts.append(f"{label}{deadline_str}")
            lines.append(f"    Targets: {' | '.join(tgt_parts)}")

        lines.append("")

    return "\n".join(lines)


def run_suggest_groups(
    request_text: str,
    db: DBSession,
    macro_id: Optional[int] = None,
    coach_context: Optional[str] = None,
) -> dict:
    """
    Group composition skill — suggests how to partition the squad into training groups.
    Returns { reply, draft } where draft is the structured group proposal.
    """
    context = _build_squad_profile(db, macro_id=macro_id)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""SQUAD PROFILE:
{context}{thread_block}

COACH REQUEST:
{request_text}

Suggest the group composition now. Output valid JSON only."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=2000,
        system=SUGGEST_GROUPS_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    raw = response.content[0].text.strip()

    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("```").strip()

    draft = json.loads(raw)
    reply = _build_groups_reply(draft)

    _save_skill_output(db, "suggest_groups", reply, entity_type="squad")
    return {"reply": reply, "draft": draft}


def _build_groups_reply(draft: dict) -> str:
    """Build a readable chat reply from the group suggestion draft."""
    lines = ["**Proposed Squad Groups**", ""]

    for g in (draft.get("proposed_groups") or []):
        label = g.get("label", "Group")
        desc = g.get("description", "")
        chars = g.get("defining_characteristics", "")
        approach = g.get("session_approach", "")
        swimmers = g.get("swimmers") or []

        lines.append(f"**{label}**")
        if desc:
            lines.append(f"*{desc}*")
        if chars:
            lines.append(f"Characteristics: {chars}")
        if approach:
            lines.append(f"Session approach: {approach}")
        if swimmers:
            lines.append("Swimmers:")
            for s in swimmers:
                name = s.get("name", "")
                rationale = s.get("rationale", "")
                lines.append(f"  — {name}: {rationale}" if rationale else f"  — {name}")
        lines.append("")

    moves = draft.get("moves_from_current") or []
    if moves:
        lines.append("**Proposed moves from current grouping:**")
        for m in moves:
            lines.append(f"  {m.get('swimmer')}: {m.get('from_group')} → {m.get('to_group')} | {m.get('reason', '')}")
        lines.append("")

    borderline = draft.get("borderline_cases") or []
    if borderline:
        lines.append("**Borderline cases — coach decision needed:**")
        for b in borderline:
            sw = b.get("swimmer", "")
            between = " vs ".join(b.get("between_groups") or [])
            lean = b.get("lean", "")
            case_for = b.get("case_for_higher", "")
            case_against = b.get("case_for_lower", "")
            lines.append(f"  {sw} ({between})")
            if case_for:
                lines.append(f"    For higher group: {case_for}")
            if case_against:
                lines.append(f"    For lower group: {case_against}")
            if lean:
                lines.append(f"    AI lean: {lean}")
        lines.append("")

    event_notes = draft.get("event_mix_notes", "")
    squad_notes = draft.get("squad_notes", "")
    rationale = draft.get("rationale", "")

    if event_notes:
        lines.append(f"Event mix: {event_notes}")
    if squad_notes:
        lines.append(f"Squad notes: {squad_notes}")
    if rationale:
        lines.append(f"\n{rationale}")

    lines.append("\nConfirm, adjust any placement, or ask me to explain a specific decision.")
    return "\n".join(lines)


@router.post("/suggest-groups")
def suggest_groups(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Group composition skill — analyses the full squad and suggests training group
    partitions based on load capacity, attendance, event specialisation, development
    trajectory, and target alignment.
    """
    request_text = body.get("request", "Suggest how to group the squad for training.")
    macro_id = body.get("macro_id")
    thread_id = body.get("thread_id")

    try:
        result = run_suggest_groups(request_text, db, macro_id=macro_id)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Skill returned malformed JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Group suggestion skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Macro Planning Skill
# ---------------------------------------------------------------------------

MACRO_PLAN_SYSTEM = """You are a specialist season architect for competitive swimming. Your job is to design the full-season macro plan — the top-level structure that all meso and micro planning flows from.

You output ONLY valid JSON — no markdown fences, no prose outside the JSON.

KEY COMPETITIONS FIRST:
You cannot plan a macro without knowing when the priority meets are. If the coach has not provided key competition dates, ask before producing a plan:
"Before I draft the season arc — what are the priority competitions? I need the key meets and approximate dates to work backwards from."
If competitions are provided in context or the request, proceed directly to the JSON plan.

PHASE SEQUENCING RULES:
Standard phase sequence (repeats for each competition cycle):
  Base -> Build -> Peak -> Taper -> Competition -> Recovery -> [repeat]
- NEVER jump from Base to Taper, or from Recovery to Peak without a Build/Peak in between
- After each Competition: Recovery (1-2 weeks) before returning to Base or Build
- Transition blocks (active rest between macros/seasons) sit between Recovery and the next Base
- Multiple competition cycles in one season are normal — e.g. short course season + long course season

WORKING BACKWARDS FROM MEETS:
Always plan backwards from key competition dates:
1. Place Taper ending on the meet date (1-2 weeks)
2. Place Peak immediately before Taper (2-3 weeks)
3. Place Build immediately before Peak (4-5 weeks)
4. Fill earlier weeks with Base (6-8 weeks per cycle)
5. Place Recovery after each competition (1-2 weeks), then restart cycle

TYPICAL SEASON DURATIONS:
- Full season: 9-12 months
- Base block: 6-8 weeks (longer = more aerobic investment; diminishing returns beyond 8 weeks)
- Build block: 4-5 weeks
- Peak block: 2-3 weeks
- Taper block: 1-2 weeks (3 weeks = over-taper risk)
- Competition block: 1-2 weeks
- Recovery block: 1-2 weeks

GROUP DEFINITIONS AT MACRO LEVEL:
Groups defined here are the training groups for the whole season. Use descriptive labels that reflect the actual group character — not generic G1/G2/G3 unless that is what the coach uses. Examples: "Senior", "Junior", "Development", "Sprint Lane", "Distance Group", "Masters". Each group should have a clearly differentiated training profile.

OUTPUT FORMAT (JSON only, no markdown):
{
  "name": "2025-26 Season",
  "date_from": "YYYY-MM-DD",
  "date_to": "YYYY-MM-DD",
  "narrative": "2-3 sentences: overall season focus and goals",
  "group_definitions": {
    "<label>": {
      "description": "training profile of this group",
      "session_approach": "what sessions typically look like for this group"
    }
  },
  "phases": [
    {
      "name": "descriptive name",
      "phase_type": "base|build|peak|taper|competition|recovery|transition",
      "date_from": "YYYY-MM-DD",
      "date_to": "YYYY-MM-DD",
      "weeks": <int>,
      "focus": "1 sentence: what this phase is building toward",
      "group_intents": {
        "<label>": "specific intent for this group this phase"
      }
    }
  ],
  "key_competition_cycles": ["e.g. Short Course Nationals April", "Long Course Regionals July"],
  "rationale": "2-3 sentences: why this structure — key decisions made",
  "planning_assumptions": ["assumption 1", "assumption 2"]
}"""


def _build_macro_plan_context(db: DBSession) -> str:
    """Rich context for the macro planning skill."""
    today = date.today()
    lines = []
    lines.append(f"TODAY: {today}")
    lines.append("")

    # Coaching philosophy
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.append("COACHING PHILOSOPHY:")
        for ln in philosophy.split('\n'):
            lines.append(f"  {ln}")
        lines.append("")

    # Upcoming meets (next 52 weeks) — targets the macro must be built around
    cutoff = today + timedelta(weeks=52)
    meets = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= cutoff,
    ).order_by(models.Meet.date).limit(30).all()

    if meets:
        lines.append("UPCOMING MEETS (next 52 weeks — build macro around these):")
        for m in meets:
            weeks_out = (m.date - today).days // 7
            lines.append(f"  {m.date} ({weeks_out}w out): {m.name} | {m.level or ''} | {m.course or ''}")
            lines.extend(_meet_timetable_lines(m, limit_sessions=4, limit_events=6))
    else:
        lines.append("UPCOMING MEETS: None found in next 52 weeks — ask the coach for key competition dates.")
    lines.append("")

    # Existing macros — show so we don't duplicate
    existing_macros = db.query(models.TrainingMacro).order_by(
        models.TrainingMacro.date_from.desc()
    ).limit(3).all()

    if existing_macros:
        lines.append("EXISTING MACROS (do not duplicate):")
        for em in existing_macros:
            status = "CURRENT" if em.date_from <= today <= em.date_to else ("PAST" if em.date_to < today else "FUTURE")
            total_weeks = max(1, round((em.date_to - em.date_from).days / 7))
            lines.append(f"  [{status}] {em.name} | {em.date_from} to {em.date_to} ({total_weeks}w)")
            if em.narrative:
                lines.append(f"    {em.narrative[:200]}")
        lines.append("")

    # Recent season history: last 2 macros and their phase sequences
    past_macros = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_to < today,
    ).order_by(models.TrainingMacro.date_to.desc()).limit(2).all()

    if past_macros:
        lines.append("RECENT SEASON HISTORY (last 2 macros — context for what was done before):")
        for pm in past_macros:
            total_weeks = max(1, round((pm.date_to - pm.date_from).days / 7))
            lines.append(f"  {pm.name} | {pm.date_from} to {pm.date_to} ({total_weeks}w)")
            phases = db.query(models.SeasonBlock).filter(
                models.SeasonBlock.macro_id == pm.id,
            ).order_by(models.SeasonBlock.date_from).all()
            if phases:
                phase_seq = " -> ".join(
                    f"{p.phase_type or '?'} ({max(1, round((p.date_to - p.date_from).days / 7))}w)"
                    for p in phases
                )
                lines.append(f"    Phase sequence: {phase_seq}")
            else:
                lines.append("    Phase sequence: no phases recorded")
        lines.append("")

    # Active squad summary: swimmer count, event mix, group labels if already defined
    active_swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.is_active == True,
    ).all()

    if active_swimmers:
        lines.append(f"ACTIVE SQUAD: {len(active_swimmers)} swimmers")
        # Event mix — count primary strokes/distances from targets or recent entries
        event_counts: dict = defaultdict(int)
        for sw in active_swimmers:
            sw_targets = db.query(models.SwimmerTarget).filter(
                models.SwimmerTarget.swimmer_id == sw.id,
                models.SwimmerTarget.achieved == False,
            ).limit(3).all()
            for tgt in sw_targets:
                if tgt.distance and tgt.stroke:
                    category = "sprint" if tgt.distance <= 100 else ("distance" if tgt.distance >= 400 else "middle")
                    event_counts[category] += 1

        if event_counts:
            mix_parts = [f"{cat}: {cnt}" for cat, cnt in sorted(event_counts.items())]
            lines.append(f"  Event mix (by target): {', '.join(mix_parts)}")
        lines.append("")

    # Group labels from the most recent current or future macro
    current_macro = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_to >= today,
    ).order_by(models.TrainingMacro.date_from).first()

    if current_macro and current_macro.group_definitions:
        lines.append(f"EXISTING GROUP LABELS (from {current_macro.name}):")
        for g_label, defn in current_macro.group_definitions.items():
            desc = defn.get("description", "")
            swimmer_ids = defn.get("swimmer_ids") or []
            lines.append(f"  {g_label} ({len(swimmer_ids)} swimmers): {desc[:150]}")
        lines.append("(Use these labels in the new macro if they still apply, or redefine them.)")
        lines.append("")

    # Swimmer targets with deadlines — key individual goals the season should serve
    target_cutoff = today + timedelta(weeks=52)
    sw_targets = db.query(models.SwimmerTarget).filter(
        models.SwimmerTarget.achieved == False,
        models.SwimmerTarget.deadline != None,
        models.SwimmerTarget.deadline >= today,
        models.SwimmerTarget.deadline <= target_cutoff,
    ).order_by(models.SwimmerTarget.deadline).all()

    if sw_targets:
        lines.append("SWIMMER TARGETS (unachieved, next 52 weeks — season should serve these):")
        for tgt in sw_targets[:20]:  # cap to avoid context overflow
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == tgt.swimmer_id).first()
            if not sw:
                continue
            weeks_out = (tgt.deadline - today).days // 7
            event_str = f"{tgt.distance}m {tgt.stroke}" if tgt.distance and tgt.stroke else tgt.label
            target_time_str = f" -> target {_fmt_time(tgt.target_time_seconds)}" if tgt.target_time_seconds else ""
            lines.append(f"  {sw.name}: {event_str}{target_time_str} | deadline {tgt.deadline} ({weeks_out}w)")
        lines.append("")

    planning_lines = _planning_state_lines(db)
    if planning_lines:
        lines.extend(planning_lines)
        lines.append("")

    return "\n".join(lines)


def run_plan_macro(
    request_text: str,
    db: DBSession,
    coach_context: Optional[str] = None,
) -> dict:
    """
    Core macro planning skill — callable from HTTP endpoint or internal chat routing.
    Returns { reply, draft } where draft is a TrainingMacro+phases-compatible object.
    If Claude needs more info (e.g. asks for competition dates), returns { reply, draft: None, needs_input: True }.
    """
    context = _build_macro_plan_context(db)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""SEASON CONTEXT:
{context}{thread_block}

COACH REQUEST:
{request_text}

Plan the full season macro now. If you need key competition dates first, ask. Otherwise output valid JSON only."""

    response = get_client().messages.create(
        model=MODEL,
        effort=PLANNING_EFFORT,
        max_tokens=2400,
        system=MACRO_PLAN_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    raw = response.content[0].text.strip()

    # Claude may ask a clarifying question (e.g. requesting competition dates)
    if not raw.startswith("{"):
        _save_skill_output(db, "macro_plan", raw, entity_type="squad")
        return {"reply": raw, "draft": None, "needs_input": True}

    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("```").strip()

    draft = json.loads(raw)
    reply = _build_macro_reply(draft)

    _save_skill_output(db, "macro_plan", reply, entity_type="squad")
    return {"reply": reply, "draft": draft}


def _build_macro_reply(draft: dict) -> str:
    """Build a readable chat reply from the macro draft."""
    name = draft.get("name", "Season Plan")
    d_from = draft.get("date_from", "")
    d_to = draft.get("date_to", "")
    narrative = draft.get("narrative", "")

    lines = [f"**{name}**"]
    if d_from and d_to:
        lines.append(f"*{d_from} to {d_to}*")
    if narrative:
        lines.append(f"\n{narrative}")

    phases = draft.get("phases") or []
    if phases:
        lines.append("")
        lines.append("**Phase Arc:**")
        for p in phases:
            p_name = p.get("name", "")
            p_type = p.get("phase_type", "")
            p_from = p.get("date_from", "")
            p_to = p.get("date_to", "")
            p_weeks = p.get("weeks", "?")
            p_focus = p.get("focus", "")
            date_range = f"{p_from} -> {p_to}" if p_from and p_to else ""
            line = f"  {p_name} | {p_type} | {date_range} ({p_weeks}w)"
            if p_focus:
                line += f" | {p_focus}"
            lines.append(line)

    group_defs = draft.get("group_definitions") or {}
    if group_defs:
        lines.append("")
        lines.append("**Groups:**")
        for g_label, g_defn in group_defs.items():
            if isinstance(g_defn, dict):
                desc = g_defn.get("description", "")
                lines.append(f"  **{g_label}:** {desc}")

    rationale = draft.get("rationale", "")
    if rationale:
        lines.append(f"\n{rationale}")

    key_cycles = draft.get("key_competition_cycles") or []
    if key_cycles:
        lines.append(f"\nCompetition cycles: {', '.join(key_cycles)}")

    assumptions = draft.get("planning_assumptions") or []
    if assumptions:
        lines.append("\nPlanning assumptions:")
        for a in assumptions[:4]:
            lines.append(f"  - {a}")

    lines.append("\nConfirm this structure to create the macro, or adjust any phase — dates, duration, focus, or group composition.")
    return "\n".join(lines)


@router.post("/plan-macro")
def plan_macro(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Macro planning skill — designs the full season arc including phase sequence and group definitions.
    Returns a TrainingMacro+phases-compatible draft.
    """
    request_text = body.get("request", "Plan the season macro.")
    thread_id = body.get("thread_id")

    try:
        result = run_plan_macro(request_text, db)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Skill returned malformed JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Macro planning skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Meso Planning Skill
# ---------------------------------------------------------------------------

MESO_PLAN_SYSTEM = """You are a specialist periodization planner for competitive swimming. Your job is to recommend the next meso-cycle (training block) that fits logically in the season structure given what has been done and what is coming up.

You output ONLY valid JSON — no markdown fences, no prose outside the JSON.

USING SWIMMER TARGETS:
The context will include SWIMMER TARGETS — individual deadlines for key performances. Use these to:
- Align the phase type with the proximity of those deadlines (a swimmer with a key meet in 5 weeks needs peak/taper work NOW, not another base block)
- Note in group_intents when a subset of swimmers need event-specific emphasis (e.g. "G1 sprinters tapering for County Champs from week 3")
- Flag in notes if different swimmers in the same group have conflicting target timelines

COACH ASSESSMENT (critical — do not infer this yourself):
You cannot reliably determine whether a training block was successful from race times or benchmark counts alone:
- Mid-block, no PBs is normal and expected
- Older swimmers may not PB for months even in a very effective block
- A block can be highly successful for some swimmers and not others in the same group
- The coach knows whether the training is landing — you do not

If the coach has provided a qualitative read on how the current/recent block has gone (in the conversation context or request), use it heavily. If they haven't, ask before finalising the phase recommendation. Something like: "Before I suggest the next phase — how did this block land? Any swimmers who really absorbed the work, any who struggled?"

Never characterise block quality as "successful" or "poor" based solely on the objective data provided.

PERIODIZATION RULES:

Phase sequence (standard progression — deviations are justified by meet schedule):
- Base -> Build -> Peak -> Taper -> Competition -> Recovery -> Transition -> Base
- Do NOT jump from Base to Taper, or Recovery to Peak without justification
- After Competition: Recovery (1-2 weeks) before returning to Base or Build
- After Taper: typically Competition, then Recovery

Phase duration guidelines:
- Base: 3-6 weeks (longer = more aerobic investment, diminishing returns beyond 6 weeks)
- Build: 3-5 weeks
- Peak: 2-4 weeks (too long = stale)
- Taper: 1-2 weeks (3 weeks = over-taper risk)
- Recovery: 1-2 weeks
- Transition: 1-3 weeks (active rest between macros)

Meet awareness (CRITICAL):
- Meet in <=2 weeks: Taper or final Peak should already be in progress
- Meet in 2-4 weeks: Peak or short Taper phase
- Meet in 4-8 weeks: Build or Peak, taper will follow
- Meet in 8+ weeks: Base or Build appropriate
- No meets in next 12 weeks: Base or Build to bank fitness

Load targets per phase (use as calibration benchmarks, not rigid rules — actual targets depend on group capability and recent load):
- Base: high-volume group ~4500-5500m/session, mid ~3500-4500m, development ~2500-3500m; 70-80% aerobic
- Build: similar volume + threshold rising; deload in final week before next phase
- Peak: volume drops 15-25% vs build; VO2 and race_pace dominate the work sets
- Taper: volume drops 30-50% vs build peak; intensity maintained at race_pace/sprint

Group intents — use the EXACT group labels from the MACRO context (not generic G1/G2/G3 unless those are the actual labels):
- Lead/high group: name the training emphasis and the target adaptation specifically
- Mid group: note key modification vs lead group (volume, intensity, set structure)
- Development/modified group: technique-emphasis or reduced-load version with clear rationale

OUTPUT FORMAT (JSON only, no markdown):
Use the ACTUAL group labels from the macro in group_intents and load_targets — whatever labels appear in the MACRO context (e.g. "Senior", "Junior", "G1", "Development", etc.)
{
  "name": "descriptive block name (e.g. 'Aerobic Base 2', 'Pre-Nationals Peak')",
  "phase_type": "base|build|peak|taper|competition|recovery|transition",
  "duration_weeks": <integer 1-8>,
  "date_from": "YYYY-MM-DD",
  "date_to": "YYYY-MM-DD",
  "group_intents": {
    "<group_label>": "specific intent for this group this block",
    "<group_label>": "specific intent for this group this block"
  },
  "notes": "1-2 sentences: caveats, watch-points, swimmer target conflicts, or conditions on this recommendation",
  "rationale": "2-3 sentences: WHY this phase now — the data, meet timing, squad momentum, swimmer targets",
  "key_session_types": ["session type 1", "session type 2", "session type 3"],
  "load_targets": {
    "<group_label>": "e.g. 4500-5500m/session, aerobic dominant",
    "<group_label>": "e.g. 3500-4500m/session"
  }
}"""


def _build_meso_plan_context(db: DBSession, macro_id: Optional[int] = None) -> str:
    """Rich context for the meso planning skill."""
    today = date.today()
    lines = []
    lines.append(f"TODAY: {today}")
    lines.append("")

    # Coaching philosophy
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.append("COACHING PHILOSOPHY:")
        for ln in philosophy.split('\n'):
            lines.append(f"  {ln}")
        lines.append("")

    macro = None
    if macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.date_from <= today,
            models.TrainingMacro.date_to >= today,
        ).order_by(models.TrainingMacro.date_from).first()

    if macro:
        total_weeks = max(1, round((macro.date_to - macro.date_from).days / 7))
        lines.append(f"MACRO: {macro.name} | {macro.date_from} to {macro.date_to} ({total_weeks}w)")
        if macro.narrative:
            lines.append(f"Season narrative: {macro.narrative[:300]}")
        if macro.group_definitions:
            lines.append("Groups:")
            for g_label, defn in macro.group_definitions.items():
                desc = defn.get("description", "")
                swimmer_ids = defn.get("swimmer_ids") or []
                names = []
                for sid in swimmer_ids[:8]:
                    sw = db.query(models.Swimmer).filter(models.Swimmer.id == sid).first()
                    if sw:
                        names.append(sw.name)
                lines.append(f"  {g_label}: {desc} -- {', '.join(names) if names else 'none assigned'}")
        lines.append("")

        mesos = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.macro_id == macro.id,
        ).order_by(models.SeasonBlock.date_from).all()

        if mesos:
            lines.append("EXISTING PHASES IN THIS MACRO:")
            for m in mesos:
                weeks = max(1, round((m.date_to - m.date_from).days / 7))
                status = "CURRENT" if m.date_from <= today <= m.date_to else ("PAST" if m.date_to < today else "FUTURE")
                lines.append(f"  [{status}] {m.phase_type or '?'} -- {m.name} | {m.date_from} to {m.date_to} ({weeks}w)")
                if m.group_intents:
                    for g, intent in m.group_intents.items():
                        if intent:
                            lines.append(f"    {g}: {intent[:120]}")
        else:
            lines.append("EXISTING PHASES: None yet in this macro.")

        all_mesos_sorted = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.macro_id == macro.id,
        ).order_by(models.SeasonBlock.date_to.desc()).all()
        latest_end = all_mesos_sorted[0].date_to if all_mesos_sorted else None
        if latest_end:
            next_start = latest_end + timedelta(days=1)
            lines.append(f"\nSUGGESTED START DATE: {next_start} (day after last planned phase ends)")
        else:
            lines.append(f"\nSUGGESTED START DATE: {today}")
        lines.append("")
    else:
        lines.append("MACRO: None found -- planning a standalone block.")
        lines.append(f"SUGGESTED START DATE: {today}")
        lines.append("")

    # Recent squad load (last 6 weeks)
    six_weeks_ago = today - timedelta(weeks=6)
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.session_date >= six_weeks_ago,
    ).all()

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    group_weekly: dict = defaultdict(lambda: defaultdict(float))
    for load in loads:
        wk = iso_week(load.session_date)
        gnum = load.group_number or 0
        group_weekly[gnum][wk] += sum((load.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS)

    if group_weekly:
        lines.append("RECENT SQUAD LOAD (last 6 weeks):")
        all_weeks = sorted({wk for g in group_weekly.values() for wk in g})[-6:]
        for wk in all_weeks:
            parts = [f"G{g}: {group_weekly[g].get(wk, 0):.0f}m" for g in sorted(group_weekly) if g > 0]
            if parts:
                lines.append(f"  {wk}: {', '.join(parts)}")
    else:
        lines.append("RECENT SQUAD LOAD: No data yet.")
    lines.append("")

    # Upcoming meets (next 16 weeks)
    cutoff = today + timedelta(weeks=16)
    meets = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= cutoff,
    ).order_by(models.Meet.date).limit(16).all()

    if meets:
        lines.append("UPCOMING MEETS (critical for phase timing):")
        for m in meets:
            weeks_out = (m.date - today).days // 7
            lines.append(f"  {m.date} ({weeks_out}w out): {m.name} | {m.level or ''} | {m.course or ''}")
            lines.extend(_meet_timetable_lines(m, limit_sessions=4, limit_events=10))
    else:
        lines.append("UPCOMING MEETS: None in next 16 weeks.")
    lines.append("")

    # Swimmer targets — deadlines within the next 16 weeks (same window as meets)
    target_cutoff = today + timedelta(weeks=16)
    sw_targets = db.query(models.SwimmerTarget).filter(
        models.SwimmerTarget.achieved == False,
        models.SwimmerTarget.deadline != None,
        models.SwimmerTarget.deadline <= target_cutoff,
        models.SwimmerTarget.deadline >= today,
    ).order_by(models.SwimmerTarget.deadline).all()

    if sw_targets:
        lines.append("SWIMMER TARGETS (unachieved, deadline within 16 weeks — align phase timing):")
        for tgt in sw_targets:
            sw = db.query(models.Swimmer).filter(models.Swimmer.id == tgt.swimmer_id).first()
            if not sw:
                continue
            weeks_out = (tgt.deadline - today).days // 7
            # Find their group
            sw_group = None
            if macro and macro.group_definitions:
                for g_label, defn in macro.group_definitions.items():
                    if tgt.swimmer_id in (defn.get("swimmer_ids") or []):
                        sw_group = g_label
                        break
            group_str = f" [{sw_group}]" if sw_group else ""
            # Latest benchmark for this swimmer/stroke/distance
            bench_str = ""
            if tgt.stroke and tgt.distance:
                bench = db.query(models.BenchmarkLog).filter(
                    models.BenchmarkLog.swimmer_id == tgt.swimmer_id,
                    models.BenchmarkLog.stroke == tgt.stroke,
                    models.BenchmarkLog.distance == tgt.distance,
                    models.BenchmarkLog.effort == (tgt.effort or "max"),
                ).order_by(models.BenchmarkLog.date.desc()).first()
                if bench:
                    bench_str = f" | current benchmark {_fmt_time(bench.time_seconds)}"
            event_str = f"{tgt.distance}m {tgt.stroke}" if tgt.distance and tgt.stroke else tgt.label
            target_time_str = f" → target {_fmt_time(tgt.target_time_seconds)}" if tgt.target_time_seconds else ""
            lines.append(f"  {sw.name}{group_str}: {event_str}{target_time_str}{bench_str} | deadline {tgt.deadline} ({weeks_out}w)")
        lines.append("(Use these to sequence the phase — if key swimmers have targets in 4-6w, peak/taper must start this block)")
        lines.append("")

    # Swimmer availability — exceptions in the next 10 weeks (covers proposed block)
    lookahead = today + timedelta(weeks=10)
    availability_swimmers = db.query(models.Swimmer).filter(models.Swimmer.active == True).all()
    availability_map = {swimmer.id: swimmer for swimmer in availability_swimmers}
    all_exceptions = availability_ranges(db, availability_map, today, lookahead)

    if all_exceptions:
        lines.append("SWIMMER AVAILABILITY ISSUES (next 10 weeks — factor into phase design):")
        for swimmer_id, events in all_exceptions.items():
            swimmer = availability_map.get(swimmer_id)
            for event in events:
                duration_days = (event["date_to"] - max(event["date_from"], today)).days + 1
                detail = f" — {event['detail']}" if event["detail"] else ""
                lines.append(f"  {swimmer.name}: {event['label']} | {event['date_from']} to {event['date_to']} ({duration_days}d){detail}")
        lines.append("(Consider whether these absences will break adaptation continuity for key swimmers)")
        lines.append("")

    # Current phase status
    current_block = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).order_by(models.SeasonBlock.date_from).first()

    if current_block:
        week_in = (today - current_block.date_from).days // 7 + 1
        total_weeks = max(1, round((current_block.date_to - current_block.date_from).days / 7))
        days_remaining = (current_block.date_to - today).days
        lines.append(f"CURRENT PHASE: {current_block.name} | {current_block.phase_type} | week {week_in}/{total_weeks} | {days_remaining}d remaining")
    else:
        last_block = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.date_to < today,
        ).order_by(models.SeasonBlock.date_to.desc()).first()
        if last_block:
            days_since = (today - last_block.date_to).days
            lines.append(f"LAST PHASE ENDED: {last_block.name} ({last_block.phase_type}) -- {days_since} days ago")
        else:
            lines.append("CURRENT PHASE: None -- no phases have been planned yet.")

    # Individual adaptation signals per group — 4-week zone breakdown + attendance for key swimmers
    four_weeks_ago = today - timedelta(weeks=4)
    if macro and macro.group_definitions:
        swimmer_loads: dict = {}
        all_loads = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.session_date >= four_weeks_ago,
        ).all()
        for load in all_loads:
            if load.swimmer_id not in swimmer_loads:
                swimmer_loads[load.swimmer_id] = {"sessions": 0, "zones": {k: 0 for k in VOLUME_KEYS}}
            swimmer_loads[load.swimmer_id]["sessions"] += 1
            for k in VOLUME_KEYS:
                swimmer_loads[load.swimmer_id]["zones"][k] += (load.volume_breakdown or {}).get(k, 0)

        # Recent observations for adaptation characterisation (last 4 weeks)
        recent_obs = db.query(models.SwimmerObservation).filter(
            models.SwimmerObservation.date >= four_weeks_ago,
        ).order_by(models.SwimmerObservation.date.desc()).all()
        obs_by_swimmer: dict = defaultdict(list)
        for o in recent_obs:
            obs_by_swimmer[o.swimmer_id].append(o.content[:80])

        adapt_lines = []
        for g_label, defn in macro.group_definitions.items():
            sw_ids = defn.get("swimmer_ids") or []
            if not sw_ids:
                continue
            group_adapt = []
            for sid in sw_ids[:10]:  # cap at 10 per group
                sw = db.query(models.Swimmer).filter(models.Swimmer.id == sid).first()
                if not sw:
                    continue
                load_data = swimmer_loads.get(sid)
                if not load_data:
                    group_adapt.append(f"    {sw.name}: no load data in last 4 weeks")
                    continue
                sessions = load_data["sessions"]
                zones = load_data["zones"]
                total_m = sum(zones.values())
                # Dominant zone
                dominant = max(zones, key=lambda k: zones[k]) if total_m > 0 else "unknown"
                dominant_pct = round(zones[dominant] / total_m * 100) if total_m > 0 else 0
                obs_note = f" | obs: {obs_by_swimmer[sid][0]}" if obs_by_swimmer.get(sid) else ""
                group_adapt.append(f"    {sw.name}: {sessions} sessions | {total_m:.0f}m total | dominant zone {dominant} ({dominant_pct}%){obs_note}")
            if group_adapt:
                adapt_lines.append(f"  {g_label}:")
                adapt_lines.extend(group_adapt)

        if adapt_lines:
            lines.append("")
            lines.append("INDIVIDUAL ADAPTATION (last 4 weeks, per group):")
            lines.extend(adapt_lines)

    planning_lines = _planning_state_lines(db, macro.id if macro else None, today)
    if planning_lines:
        lines.append("")
        lines.extend(planning_lines)

    return "\n".join(lines)


def run_plan_meso(
    request_text: str,
    db: DBSession,
    macro_id: Optional[int] = None,
    coach_context: Optional[str] = None,
    brief: bool = False,
) -> dict:
    """
    Core meso planning skill — callable from HTTP endpoint or internal chat routing.
    Returns { reply, draft } where draft is a SeasonBlock-compatible object.
    """
    context = _build_meso_plan_context(db, macro_id=macro_id)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""SEASON CONTEXT:
{context}{thread_block}

COACH REQUEST:
{request_text}

Plan the next phase now. Output valid JSON only."""

    response = get_client().messages.create(
        model=MODEL,
        effort=PLANNING_EFFORT,
        max_tokens=1200,
        system=MESO_PLAN_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    raw = response.content[0].text.strip()

    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("```").strip()

    draft = json.loads(raw)

    rationale = draft.pop("rationale", "")
    key_session_types = draft.pop("key_session_types", [])
    load_targets = draft.pop("load_targets", {})

    reply = _build_meso_reply(draft, rationale, key_session_types, load_targets)

    if brief:
        reply = f"**{draft.get('name', 'Next Phase')}** — {draft.get('phase_type', '').title()}, {draft.get('duration_weeks', '?')}w\n\n{rationale[:300] if rationale else draft.get('notes', '')}"

    _save_skill_output(db, "meso_plan", reply, entity_type="squad")

    return {"reply": reply, "draft": draft}


def _build_meso_reply(draft: dict, rationale: str, key_session_types: list, load_targets: dict) -> str:
    """Build a readable chat reply from the meso draft."""
    name = draft.get("name", "Next Phase")
    phase = draft.get("phase_type", "")
    dur = draft.get("duration_weeks", "?")
    d_from = draft.get("date_from", "")
    d_to = draft.get("date_to", "")

    lines = [f"**{name}**"]
    if phase:
        lines.append(f"*{phase.title()} phase -- {dur} weeks*")
    if d_from and d_to:
        lines.append(f"*{d_from} to {d_to}*")
    if rationale:
        lines.append(f"\n{rationale}")

    group_intents = draft.get("group_intents", {})
    if group_intents:
        lines.append("")
        for g, intent in group_intents.items():
            if intent:
                lines.append(f"**{g}:** {intent}")

    if load_targets:
        lines.append("")
        for g, tgt in load_targets.items():
            lines.append(f"  {g} target: {tgt}")

    if key_session_types:
        lines.append(f"\nKey sessions: {', '.join(key_session_types[:4])}")

    if draft.get("notes"):
        lines.append(f"\nNote: {draft['notes']}")

    lines.append("\nReview the draft below -- edit dates or intents before creating the block.")
    return "\n".join(lines)


@router.post("/plan-meso")
def plan_meso(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Meso planning skill — recommends the next training block based on phase sequence,
    meet timing, recent load, and group composition. Returns a SeasonBlock-compatible draft.
    """
    request_text = body.get("request", "What should the next training phase be?")
    macro_id = body.get("macro_id")
    thread_id = body.get("thread_id")

    try:
        result = run_plan_meso(request_text, db, macro_id=macro_id)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Skill returned malformed JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Meso planning skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Micro Planning Skill
# ---------------------------------------------------------------------------

MICRO_PLAN_SYSTEM = """You are a specialist weekly training planner for competitive swimming. Your job is to design the session sequence for an upcoming week (or short cycle) that fits coherently within the current meso-cycle phase.

You output ONLY valid JSON — no markdown fences, no prose outside the JSON.

CONVERSATION FIRST:
Before producing a full weekly plan, you must understand the squad's current state. If the coach has not provided a qualitative read on how the squad is going into this week (energy, fatigue, readiness, any individual concerns), ask first:
"Before I map out the week — how is the squad going into it? Any swimmers carrying fatigue, or anyone you want to prioritise differently this week?"
Once the coach responds, produce the plan. If they have already given context in the conversation, proceed directly.

ENERGY SYSTEM SEQUENCING RULES:
- Never schedule VO2 or lact_tol on consecutive days
- Aerobic/CSS work can follow any session (good recovery filler)
- Sprint/short_race_pace: best at start of a week when fresh, or after a recovery day
- Race_pace: needs at least one recovery or aerobic day before the next hard session
- Recovery/technique sessions: place after the hardest session of the week (not before)
- Threshold is moderate intensity — can be placed day after aerobic, but not day after VO2

PROGRESSION WITHIN A MESO:
Use the MESO POSITION to calibrate the week's loading:
- Week 1 of base/build: introduction load — moderate intensity, build athlete tolerance
- Middle weeks: progressive loading — volume and/or intensity step up each week
- Penultimate week (before deload): peak loading week — highest volume or intensity of the block
- Final week / deload: reduce volume 15-25%, maintain intensity, consolidate adaptations
- If the coach says the squad is fatigued: back off — a deload this week is more valuable than pushing through

GROUP DIFFERENTIATION (critical):
Not all sessions are the same across groups, and you need to think about this explicitly for each session:
- SHARED SESSION (all groups together): same energy system, same main set structure, just volume/rep-count scaled. Most practical — one lane plan for the coach.
- PARALLEL VARIATION: groups train at the same time but with different emphases (e.g. G1 race-pace intervals, G2 threshold, G3 aerobic technique). Same pool, coach moves between lanes.
- SEPARATE SESSION: different session type entirely for a group — can happen when groups have divergent phase needs (e.g. G1 tapering while G2 and G3 still building).

For each session, decide which model fits best and make it explicit. Think about:
- Can the coach realistically run this as one session with group variations? Or does it need to be different sessions?
- Are there groups at different points in their phase (e.g. a swimmer in G1 with a meet in 2 weeks vs G3 still in base)?
- Swimmer targets — if some G1 swimmers have an imminent target event, their session this week may need to shift toward race prep while others in the same slot continue base work
- The practical reality: one coach, multiple lanes — the more differentiated the sessions, the more cognitive load

Name the groups using the EXACT labels from the context. Never use G1/G2/G3 unless those are the actual group labels.

RECOVERY AND POOL CONSTRAINTS:
- Use the actual pool slots from the context — don't invent sessions on days with no slot
- Note pool configuration (full pool / deep end / shallow end) — blocks-available sessions suit race starts and sprint work
- Slot duration matters: a 60-min slot cannot hold the same volume as a 90-min slot

WHAT TO OUTPUT:
Produce two things in JSON:
1. This week's session plan — one entry per pool slot, with session type, energy focus, group differentiation mode, and per-group emphasis
2. A progression summary — where this week sits in the meso arc and what changes next week

Do NOT assess whether the previous block was good or bad. The coach provides that judgement. Your job is to sequence the week intelligently given what you're told.

OUTPUT FORMAT (JSON only, no markdown):
{
  "week_label": "descriptive label e.g. 'Week 2 — Base Loading' or 'Deload Week'",
  "week_of": "YYYY-MM-DD (Monday of this week)",
  "meso_position_note": "1 sentence: where this week sits — e.g. 'Week 2 of 4 in base block. Stepping up from last week.'",
  "progression_note": "1 sentence: how load/intensity changes this week vs last",
  "sessions": [
    {
      "date": "YYYY-MM-DD",
      "day": "Monday",
      "slot_label": "slot label or time",
      "duration_mins": <integer or null>,
      "differentiation_mode": "shared|parallel_variation|separate",
      "session_type": "aerobic|threshold|vo2|race_pace|lact_tol|sprint|recovery|technique",
      "energy_focus": "aerobic|threshold|vo2|race_pace|sprint|recovery",
      "key_emphasis": "one short phrase — what the main set is trying to achieve (overall or for lead group)",
      "groups": {
        "<group_label>": {
          "session_type": "same as overall OR different if parallel_variation/separate",
          "energy_focus": "same or different",
          "emphasis": "what THIS group is doing — specific to their needs, phase, and targets",
          "volume_modifier": "e.g. 'full', '80%', '60% + extra drill'"
        }
      },
      "pool_note": "optional — flag if pool config affects the session (e.g. 'no blocks — skip dive starts')"
    }
  ],
  "recovery_placement": "1 sentence: where recovery sits this week and why",
  "next_week_direction": "1 sentence: what changes next week — more load, less load, intensity shift, or deload",
  "coach_flags": ["any individual swimmer flags the AI noticed from the availability/exception data — max 3"]
}"""


def _build_micro_plan_context(db: DBSession, week_start: Optional[date] = None) -> str:
    """Rich context for the micro (weekly) planning skill."""
    today = date.today()
    # Default week_start to the coming Monday
    if week_start is None:
        days_until_monday = (7 - today.weekday()) % 7
        week_start = today + timedelta(days=days_until_monday if days_until_monday > 0 else 0)
    week_end = week_start + timedelta(days=6)

    lines = []
    lines.append(f"TODAY: {today}")
    lines.append(f"PLANNING WEEK: {week_start} (Mon) to {week_end} (Sun)")
    lines.append("")
    active_swimmers = db.query(models.Swimmer).filter(models.Swimmer.is_active == True).all()
    swimmer_name_by_id = {swimmer.id: swimmer.name for swimmer in active_swimmers}

    # Coaching philosophy
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.append("COACHING PHILOSOPHY:")
        for ln in philosophy.split('\n'):
            lines.append(f"  {ln}")
        lines.append("")

    # Current meso and position within it
    current_meso = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= week_start,
        models.SeasonBlock.date_to >= week_start,
    ).order_by(models.SeasonBlock.date_from).first()

    if not current_meso:
        # Try to find the next upcoming meso
        current_meso = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.date_from > week_start,
        ).order_by(models.SeasonBlock.date_from).first()

    if current_meso:
        meso_start = current_meso.date_from
        meso_end = current_meso.date_to
        total_weeks = max(1, round((meso_end - meso_start).days / 7))
        week_in = max(1, (week_start - meso_start).days // 7 + 1)
        weeks_remaining = max(0, (meso_end - week_start).days // 7)

        # Determine loading archetype for this week
        if total_weeks >= 4:
            if week_in == total_weeks:
                loading_type = "DELOAD WEEK (final week — reduce volume, consolidate)"
            elif week_in == total_weeks - 1:
                loading_type = "PEAK LOAD WEEK (highest load before deload)"
            elif week_in == 1:
                loading_type = "INTRODUCTION WEEK (build tolerance, moderate load)"
            else:
                loading_type = "PROGRESSIVE LOADING WEEK (step up from last week)"
        else:
            loading_type = f"week {week_in} of short {total_weeks}-week block"

        lines.append(f"CURRENT MESO: {current_meso.name} | {current_meso.phase_type or 'unspecified'}")
        lines.append(f"Week {week_in} of {total_weeks} | {weeks_remaining} weeks remaining | {loading_type}")
        if current_meso.notes:
            lines.append(f"Block notes: {current_meso.notes[:200]}")
        if current_meso.group_intents:
            lines.append("Group intents this block:")
            for g, intent in current_meso.group_intents.items():
                if intent:
                    lines.append(f"  {g}: {intent[:150]}")
        lines.append("")

        saved_micros = db.query(models.Microcycle).filter(
            models.Microcycle.block_id == current_meso.id,
            models.Microcycle.week_start < week_start,
        ).order_by(models.Microcycle.week_start.desc()).limit(3).all()
        if saved_micros:
            lines.append("RECENT SAVED MICROCYCLES (durable plan memory; most recent first):")
            for micro in saved_micros:
                session_types = [
                    session.get("session_type") or session.get("energy_focus")
                    for session in (micro.sessions or []) if isinstance(session, dict)
                ]
                lines.append(
                    f"  {micro.week_start}: {micro.label} [{micro.status}] | "
                    f"{', '.join(filter(None, session_types)) or 'no session types'}"
                )
                if micro.progression_note:
                    lines.append(f"    Progression: {micro.progression_note[:180]}")
            lines.append("")
    else:
        lines.append("CURRENT MESO: None defined — planning a general week.")
        week_in = 1
        total_weeks = 1
        lines.append("")

    # Macro group definitions — who is in each group
    macro = None
    current_meso_macro_id = getattr(current_meso, 'macro_id', None) if current_meso else None
    if current_meso_macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == current_meso_macro_id).first()
    if not macro:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.date_from <= week_start,
            models.TrainingMacro.date_to >= week_start,
        ).order_by(models.TrainingMacro.date_from).first()

    group_swimmer_ids: dict = {}
    if macro and macro.group_definitions:
        lines.append("GROUPS:")
        for g_label, defn in macro.group_definitions.items():
            sw_ids = defn.get("swimmer_ids") or []
            group_swimmer_ids[g_label] = sw_ids
            names = [swimmer_name_by_id[sid] for sid in sw_ids[:8] if sid in swimmer_name_by_id]
            lines.append(f"  {g_label}: {defn.get('description', '')} -- {', '.join(names) if names else 'none assigned'}")
        lines.append("")

    planning_lines = _planning_state_lines(db, macro.id if macro else None, week_start)
    if planning_lines:
        lines.extend(planning_lines)
        lines.append("")

    # Pool slots for the planning week — expanded to actual dates
    DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    active_slots = db.query(models.PoolSlot).filter(models.PoolSlot.active == True).all()

    if active_slots:
        slot_ids = [slot.id for slot in active_slots]
        all_attendees = db.query(models.SwimmerSlot).filter(models.SwimmerSlot.pool_slot_id.in_(slot_ids)).all()
        attendee_ids_by_slot = defaultdict(list)
        for attendee in all_attendees:
            attendee_ids_by_slot[attendee.pool_slot_id].append(attendee.swimmer_id)
        lines.append("POOL SLOTS THIS WEEK:")
        for day_offset in range(7):
            slot_date = week_start + timedelta(days=day_offset)
            day_name = DAYS[day_offset]
            day_slots = [s for s in active_slots if s.day_of_week == day_offset]
            if not day_slots:
                continue
            for slot in sorted(day_slots, key=lambda s: s.time or ""):
                # Duration
                dur_str = ""
                if slot.time and slot.end_time:
                    try:
                        from datetime import datetime as _dt
                        t_start = _dt.strptime(slot.time, "%H:%M")
                        t_end = _dt.strptime(slot.end_time, "%H:%M")
                        dur_mins = int((t_end - t_start).total_seconds() // 60)
                        dur_str = f" ({dur_mins}min)"
                    except ValueError:
                        pass

                # Pool config
                pool_str = ""
                if slot.pool_config:
                    pool_str = f" | {slot.pool_config}"
                if slot.has_blocks:
                    pool_str += " | blocks"
                if slot.course:
                    pool_str += f" | {slot.course}"

                # Who normally attends via SwimmerSlot
                attendee_names = [
                    swimmer_name_by_id[swimmer_id]
                    for swimmer_id in attendee_ids_by_slot.get(slot.id, [])[:12]
                    if swimmer_id in swimmer_name_by_id
                ]

                slot_label = slot.label or f"{slot.squad or 'squad'} {slot.time}"
                lines.append(f"  {slot_date} {day_name} {slot.time}{dur_str}: {slot_label}{pool_str}")
                if attendee_names:
                    lines.append(f"    Normal attendees ({len(attendee_names)}): {', '.join(attendee_names)}")
        lines.append("")

    # Swimmer exceptions/availability issues this week
    availability_swimmers = db.query(models.Swimmer).filter(models.Swimmer.active == True).all()
    availability_map = {swimmer.id: swimmer for swimmer in availability_swimmers}
    exceptions_this_week = availability_ranges(db, availability_map, week_start, week_end)

    if exceptions_this_week:
        lines.append("AVAILABILITY ISSUES THIS WEEK:")
        for swimmer_id, events in exceptions_this_week.items():
            swimmer = availability_map.get(swimmer_id)
            for event in events:
                overlap_start = max(event["date_from"], week_start)
                overlap_end = min(event["date_to"], week_end)
                detail = f" — {event['detail']}" if event["detail"] else ""
                lines.append(f"  {swimmer.name}: {event['label']} | {overlap_start} to {overlap_end}{detail}")
        lines.append("")

    # Recent session history (last 2 weeks) — energy system emphasis
    two_weeks_ago = week_start - timedelta(weeks=2)
    recent_sessions = db.query(models.Session).filter(
        models.Session.date >= two_weeks_ago,
        models.Session.date < week_start,
    ).order_by(models.Session.date.desc()).limit(14).all()

    if recent_sessions:
        lines.append("RECENT SESSIONS (last 2 weeks — for sequencing context):")
        for s in recent_sessions:
            energy = s.energy_system_focus or "unspecified"
            intent = f" | intent: {s.coach_intent[:80]}" if s.coach_intent else ""
            lines.append(f"  {s.date} {DAYS[s.date.weekday()] if s.date else ''}: {s.title or 'session'} | energy: {energy}{intent}")
        lines.append("")

    # Load progression within this meso — weekly totals per group
    if current_meso and current_meso.date_from:
        meso_loads = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.session_date >= current_meso.date_from,
            models.SwimmerSessionLoad.session_date < week_start,
        ).all()

        def iso_week(d):
            yr, wk, _ = d.isocalendar()
            return f"{yr}-W{wk:02d}"

        group_weekly_meso: dict = defaultdict(lambda: defaultdict(float))
        for load in meso_loads:
            wk = iso_week(load.session_date)
            gnum = load.group_number or 0
            group_weekly_meso[gnum][wk] += sum((load.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS)

        if group_weekly_meso:
            lines.append("LOAD PROGRESSION THIS MESO (weekly totals by group):")
            all_wks = sorted({wk for g in group_weekly_meso.values() for wk in g})
            for wk in all_wks[-6:]:
                parts = [f"G{g}: {group_weekly_meso[g].get(wk, 0):.0f}m" for g in sorted(group_weekly_meso) if g > 0]
                if parts:
                    lines.append(f"  {wk}: {', '.join(parts)}")
            lines.append("")

    # Upcoming meets — flag if taper context needed
    upcoming_meets = db.query(models.Meet).filter(
        models.Meet.date >= week_start,
        models.Meet.date <= week_start + timedelta(weeks=4),
    ).order_by(models.Meet.date).limit(8).all()

    if upcoming_meets:
        lines.append("UPCOMING MEETS (next 4 weeks — may affect session selection):")
        for m in upcoming_meets:
            days_out = (m.date - week_start).days
            lines.append(f"  {m.date} ({days_out}d out): {m.name}")
            lines.extend(_meet_timetable_lines(m, limit_sessions=4, limit_events=12))
        lines.append("")

    return "\n".join(lines)


def run_plan_micro(
    request_text: str,
    db: DBSession,
    week_start: Optional[date] = None,
    coach_context: Optional[str] = None,
) -> dict:
    """
    Core micro planning skill — callable from HTTP endpoint or internal chat routing.
    Returns { reply, draft } where draft is the structured week plan.
    """
    context = _build_micro_plan_context(db, week_start=week_start)

    thread_block = f"\n\n{coach_context}" if coach_context else ""
    user_message = f"""WEEK CONTEXT:
{context}{thread_block}

COACH REQUEST:
{request_text}

Plan this week now. If you need the coach's qualitative read on the squad's state before finalising, ask. Otherwise output valid JSON only."""

    response = get_client().messages.create(
        model=MODEL,
        effort=PLANNING_EFFORT,
        max_tokens=1600,
        system=MICRO_PLAN_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    raw = response.content[0].text.strip()

    # The response might be a question (coach state check) rather than JSON
    if not raw.startswith("{"):
        # Claude is asking the coach a question — return as plain reply
        _save_skill_output(db, "micro_plan", raw, entity_type="squad")
        return {"reply": raw, "draft": None, "needs_input": True}

    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("```").strip()

    draft = json.loads(raw)
    reply = _build_micro_reply(draft)

    _save_skill_output(db, "micro_plan", reply, entity_type="squad")
    return {"reply": reply, "draft": draft}


def _build_micro_reply(draft: dict) -> str:
    """Build a readable chat reply from the micro week draft."""
    lines = [f"**{draft.get('week_label', 'Weekly Plan')}**"]
    meso_pos = draft.get("meso_position_note", "")
    prog_note = draft.get("progression_note", "")
    if meso_pos:
        lines.append(f"*{meso_pos}*")
    if prog_note:
        lines.append(f"*{prog_note}*")
    lines.append("")

    sessions = draft.get("sessions") or []
    for s in sessions:
        day = s.get("day", "")
        date_str = s.get("date", "")
        slot = s.get("slot_label", "")
        session_type = s.get("session_type", "")
        emphasis = s.get("key_emphasis", "")
        dur = s.get("duration_mins")
        diff_mode = s.get("differentiation_mode", "shared")
        dur_str = f" ({dur}min)" if dur else ""
        pool_note = s.get("pool_note", "")

        mode_tag = {"shared": "", "parallel_variation": " *(parallel variation)*", "separate": " *(separate sessions)*"}.get(diff_mode, "")
        header = f"**{day} {date_str}** — {slot}{dur_str}: *{session_type}*{mode_tag}"
        if emphasis:
            header += f" | {emphasis}"
        lines.append(header)

        groups = s.get("groups") or {}
        for g_label, g_data in groups.items():
            if isinstance(g_data, dict):
                g_emphasis = g_data.get("emphasis", "")
                g_vol = g_data.get("volume_modifier", "")
                g_type = g_data.get("session_type", "")
                g_parts = []
                if g_type and g_type != session_type:
                    g_parts.append(g_type)
                if g_emphasis:
                    g_parts.append(g_emphasis)
                if g_vol and g_vol.lower() not in ("full", "same"):
                    g_parts.append(g_vol)
                if g_parts:
                    lines.append(f"  {g_label}: {' | '.join(g_parts)}")
            elif isinstance(g_data, str) and g_data.lower() != "same":
                lines.append(f"  {g_label}: {g_data}")
        if pool_note:
            lines.append(f"  _{pool_note}_")

    recovery = draft.get("recovery_placement", "")
    next_week = draft.get("next_week_direction", "")
    flags = draft.get("coach_flags") or []

    if recovery:
        lines.append(f"\nRecovery: {recovery}")
    if next_week:
        lines.append(f"Next week: {next_week}")
    if flags:
        lines.append("\nFlags:")
        for f in flags:
            lines.append(f"  — {f}")

    lines.append("\nAdjust any session, swap days, or change group differentiation — just tell me what to change.")
    return "\n".join(lines)


@router.post("/plan-micro")
def plan_micro(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Micro planning skill — designs the week's session sequence within the current meso phase.
    Applies energy system sequencing, progression logic, and pool slot constraints.
    Returns a day-by-day session plan with progression context.
    """
    request_text = body.get("request", "Plan the training week.")
    week_start_str = body.get("week_start")
    thread_id = body.get("thread_id")

    week_start_date = None
    if week_start_str:
        try:
            week_start_date = date.fromisoformat(week_start_str)
        except ValueError:
            pass

    try:
        result = run_plan_micro(request_text, db, week_start=week_start_date)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Skill returned malformed JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Micro planning skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Taper Planning Skill
# ---------------------------------------------------------------------------

TAPER_PLAN_SYSTEM = """You are a specialist taper planner for competitive swimming. Your job is to design a personalised pre-meet taper for a specific swimmer given their event profile, current load, and meet date.

Output ONLY valid JSON — no markdown fences, no prose outside the JSON.

TAPER PRINCIPLES:

Volume reduction curve (adjust for swimmer profile):
- Sprinters (50-100m primary events): reduce volume 20-30% per week; maintain intensity; more race pace activation
- Middle distance (200-400m): reduce volume 30-40% per week; shift from threshold to race pace
- Distance (800m+): reduce volume 35-50% across taper; longer taper window acceptable
- Junior swimmers (under 16): shorter taper (7-10 days); residual fitness drops faster; risk of going stale in a long taper

Taper duration:
- Club meet / regional: 7-10 days
- National / major championships: 10-14 days
- Multiple events over 3+ days: taper toward the LAST event, not the first

Intensity during taper:
- Do NOT reduce intensity — only volume
- Race pace and short_race_pace sets should INCREASE as a proportion of volume
- Remove threshold sets in the final 5 days
- No VO2 or sustained high-lactate work in the final 7 days
- Sprint activation (2-4 x 15-25m maximal) should appear in the final 3-4 days

Activation sessions (final week):
- Day -5 to -3: 1-2 quality sessions with race pace reps (50-100m at target pace), short rest
- Day -2 or -1: light quality session — 3-5 x 25-50m at race pace, drill, starts
- Day of meet (if applicable): race-day warm-up only — 15-20 min easy + short activation

Common taper mistakes to flag:
- Dropping volume AND intensity simultaneously (performance goes flat)
- Taper too long for the level of meet (goes stale)
- Missing the final activation session (swimmer arrives undertrained for speed)

Course change:
- SCM to LCM (or vice versa): add 1-2 course-specific sessions before the taper window

OUTPUT FORMAT (JSON only):
{
  "taper_start": "YYYY-MM-DD",
  "taper_length_days": <integer>,
  "volume_at_taper_start_pct": <integer>,
  "week_by_week": [
    {
      "week_label": "-2 weeks",
      "days_before_meet": 14,
      "volume_pct": <% of base>,
      "intensity_note": "what intensity work to keep",
      "key_sessions": ["session type 1", "session type 2"],
      "remove": ["what to drop this week"]
    }
  ],
  "activation_protocol": "exact description of final 3-4 days sessions",
  "warmup_protocol": "meet day warm-up: distance, sets, effort levels",
  "key_watchpoints": ["watchpoint 1", "watchpoint 2"],
  "course_note": "note if course change applies, or null",
  "rationale": "2-3 sentences: WHY this taper shape for this swimmer"
}"""


def _build_taper_context(swimmer: models.Swimmer, meet, db: DBSession) -> str:
    """Context block for the taper planning skill."""
    today = date.today()
    lines = []
    philosophy = _get_coaching_philosophy(db)
    if philosophy:
        lines.extend(["COACHING CONTEXT:", philosophy, ""])

    from backend.models import get_age_at_dec31
    age = get_age_at_dec31(swimmer.dob) if swimmer.dob else None
    age_str = f"Age {age} (Dec 31)" if age else "age unknown"

    lines.append(f"SWIMMER: {swimmer.name} | {swimmer.squad or 'no squad'} | {age_str}")
    events = swimmer.target_events or []
    events_str = ", ".join(e.get("event", "") if isinstance(e, dict) else str(e) for e in events)
    lines.append(f"Target events: {events_str or 'not specified'}")
    if swimmer.strengths:
        lines.append(f"Strengths: {swimmer.strengths[:150]}")
    lines.append("")

    if meet:
        meet_start = meet.date
        days_to_meet = (meet_start - today).days if meet_start else None
        meet_end = meet.date_to or meet.date
        duration_days = (meet_end - meet_start).days + 1 if meet_start and meet_end else 1
        lines.append(f"TARGET MEET: {meet.name}")
        lines.append(f"  Date: {meet_start} to {meet_end} ({duration_days} day(s))")
        lines.append(f"  Course: {meet.course or 'unknown'} | Level: {meet.level or 'unknown'}")
        lines.extend(_meet_timetable_lines(meet, limit_sessions=8, limit_events=20))
        if days_to_meet is not None:
            lines.append(f"  Days to meet: {days_to_meet}")
            if days_to_meet < 7:
                lines.append("  !! VERY SHORT LEAD TIME — taper must start immediately")
        target = db.query(models.MeetTarget).filter(
            models.MeetTarget.meet_id == meet.id,
            models.MeetTarget.swimmer_id == swimmer.id,
        ).first()
        if target:
            lines.append(f"  Events entered: {', '.join(target.events or [])}")
            if target.target_times:
                for ev, t in target.target_times.items():
                    lines.append(f"    Target: {ev} → {t}")
    else:
        lines.append("TARGET MEET: None specified — plan a generic pre-meet taper.")
    lines.append("")

    # Current load (last 6 weeks)
    six_weeks_ago = today - timedelta(weeks=6)
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.swimmer_id == swimmer.id,
        models.SwimmerSessionLoad.session_date >= six_weeks_ago,
    ).all()

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    weekly: dict = defaultdict(lambda: {k: 0 for k in VOLUME_KEYS})
    for load in loads:
        wk = iso_week(load.session_date)
        for k in VOLUME_KEYS:
            weekly[wk][k] += (load.volume_breakdown or {}).get(k, 0)

    if weekly:
        lines.append("CURRENT LOAD (last 6 weeks — use as 100% baseline):")
        recent_totals = []
        for wk in sorted(weekly.keys()):
            vols = weekly[wk]
            total = sum(vols.values())
            recent_totals.append(total)
            zone_parts = [f"{k}:{vols[k]:.0f}" for k in VOLUME_KEYS if vols[k] > 0]
            lines.append(f"  {wk}: {total:.0f}m | {' | '.join(zone_parts)}")
        if recent_totals:
            lines.append(f"  Peak: {max(recent_totals):.0f}m/wk | Average: {sum(recent_totals)/len(recent_totals):.0f}m/wk")
    else:
        lines.append("CURRENT LOAD: No load data — assume standard squad volume.")
    lines.append("")

    # Course change check
    current_slot = db.query(models.PoolSlot).filter(models.PoolSlot.active == True).first()
    if current_slot and meet and meet.course:
        pool_course = (current_slot.course or "SCM").upper()
        meet_course = (meet.course or "").upper()
        if pool_course != meet_course and meet_course:
            lines.append(f"COURSE CHANGE: Training {pool_course} → competing {meet_course}.")
            lines.append("")

    # Recent benchmarks
    from sqlalchemy import desc as _tb_desc
    bms = db.query(models.BenchmarkLog).filter(
        models.BenchmarkLog.swimmer_id == swimmer.id,
    ).order_by(_tb_desc(models.BenchmarkLog.date)).limit(8).all()
    if bms:
        lines.append("RECENT BENCHMARKS:")
        for b in bms[:6]:
            lines.append(f"  {b.date}: {b.distance}m {b.stroke} {b.effort} — {b.time_seconds:.2f}s")
        lines.append("")

    # Active load events
    load_events = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.swimmer_id == swimmer.id,
        models.SwimmerLoadEvent.resolved == False,
    ).order_by(models.SwimmerLoadEvent.date.desc()).limit(5).all()
    if load_events:
        lines.append("ACTIVE LOAD EVENTS:")
        for ev in load_events:
            lines.append(f"  {ev.date}: {ev.event_type} — {ev.description or ''} (impact: {ev.load_impact or 'unknown'})")

    return "\n".join(lines)


def run_plan_taper(
    swimmer_name: str,
    db: DBSession,
    meet_id: Optional[int] = None,
    coach_context: Optional[str] = None,
    brief: bool = False,
) -> dict:
    """
    Core taper planning skill. Returns { reply, draft, swimmer_id, swimmer_name }.
    """
    swimmer = db.query(models.Swimmer).filter(
        models.Swimmer.name.ilike(f"%{swimmer_name}%"),
        models.Swimmer.status != 'inactive',
    ).first()
    if not swimmer:
        return {
            "reply": f"I couldn't find a swimmer matching '{swimmer_name}'.",
            "draft": None, "swimmer_id": None, "swimmer_name": swimmer_name,
        }

    meet = None
    if meet_id:
        meet = db.query(models.Meet).filter(models.Meet.id == meet_id).first()
    if not meet:
        meet = db.query(models.Meet).filter(
            models.Meet.date >= date.today(),
        ).order_by(models.Meet.date).first()

    context = _build_taper_context(swimmer, meet, db)
    thread_block = f"\n\n{coach_context}" if coach_context else ""
    meet_name = meet.name if meet else "the next meet"

    user_message = f"""SWIMMER AND MEET CONTEXT:
{context}{thread_block}

Design the personalised taper for {swimmer.name} ahead of {meet_name}. Output valid JSON only."""

    response = get_client().messages.create(
        model=MODEL,
        effort=PLANNING_EFFORT,
        max_tokens=1500,
        system=TAPER_PLAN_SYSTEM,
        messages=[{"role": "user", "content": user_message}],
    )
    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("```").strip()

    draft = json.loads(raw)
    rationale = draft.pop("rationale", "")

    lines_r = [f"**Taper Plan — {swimmer.name} → {meet_name}**"]
    lines_r.append(f"*Taper starts {draft.get('taper_start', '?')} | {draft.get('taper_length_days', '?')} days*")
    if rationale:
        lines_r.append(f"\n{rationale}")
    for w in (draft.get("week_by_week") or []):
        label = w.get("week_label", "")
        vol = w.get("volume_pct", "?")
        lines_r.append(f"\n**{label}** — {vol}% volume")
        if w.get("intensity_note"):
            lines_r.append(f"  Intensity: {w['intensity_note']}")
        if w.get("key_sessions"):
            lines_r.append(f"  Keep: {', '.join(w['key_sessions'][:3])}")
        if w.get("remove"):
            lines_r.append(f"  Remove: {', '.join(w['remove'][:3])}")
    if draft.get("activation_protocol"):
        lines_r.append(f"\n**Activation (final days)**\n{draft['activation_protocol']}")
    if draft.get("warmup_protocol"):
        lines_r.append(f"\n**Meet warm-up**\n{draft['warmup_protocol']}")
    watchpoints = draft.get("key_watchpoints", [])
    if watchpoints:
        lines_r.append("\n**Watch for**")
        for w in watchpoints[:4]:
            lines_r.append(f"• {w}")
    if draft.get("course_note"):
        lines_r.append(f"\n*Course note: {draft['course_note']}*")

    reply = "\n".join(lines_r)

    if brief:
        reply = (
            f"**{swimmer.name} — Taper for {meet_name}**\n\n"
            f"Start: {draft.get('taper_start', '?')} | {draft.get('taper_length_days', '?')} days\n\n"
            f"{rationale[:400] if rationale else ''}"
            + ("\n\n" + "\n".join(f"• {w}" for w in watchpoints[:3]) if watchpoints else "")
        )

    _save_skill_output(
        db, "taper_plan", reply,
        swimmer_id=swimmer.id, entity_type="swimmer",
        entity_id=swimmer.id, entity_name=swimmer.name,
    )
    return {"reply": reply, "draft": draft, "swimmer_id": swimmer.id, "swimmer_name": swimmer.name}


@router.post("/plan-taper")
def plan_taper(
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    """
    Taper planning skill — personalised pre-meet taper with volume reduction curve,
    activation sessions, and meet-day warm-up protocol.
    """
    swimmer_name = body.get("swimmer_name") or body.get("name", "")
    swimmer_id = body.get("swimmer_id")
    meet_id = body.get("meet_id")
    thread_id = body.get("thread_id")
    brief = body.get("brief", False)

    if not swimmer_name and swimmer_id:
        sw = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
        swimmer_name = sw.name if sw else ""

    if not swimmer_name:
        raise HTTPException(status_code=400, detail="swimmer_name or swimmer_id required")

    try:
        result = run_plan_taper(swimmer_name, db, meet_id=meet_id, brief=brief)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Skill returned malformed JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Taper planning skill failed: {e}")

    if thread_id is not None:
        db.add(models.CoachAIMessage(
            role="assistant",
            message=result["reply"],
            thread_id=thread_id,
        ))
        db.commit()

    return result


# ---------------------------------------------------------------------------
# Skill History Endpoints
# ---------------------------------------------------------------------------

@router.get("/history")
def get_skill_history(
    skill_type: Optional[str] = None,
    swimmer_id: Optional[int] = None,
    limit: int = 20,
    db: DBSession = Depends(get_db),
):
    """Return recent skill outputs for history/audit view."""
    from sqlalchemy import desc as _sh_desc
    q = db.query(models.SkillOutput)
    if skill_type:
        q = q.filter(models.SkillOutput.skill_type == skill_type)
    if swimmer_id:
        q = q.filter(models.SkillOutput.swimmer_id == swimmer_id)
    rows = q.order_by(_sh_desc(models.SkillOutput.created_at)).limit(limit).all()
    return [
        {
            "id": r.id,
            "skill_type": r.skill_type,
            "swimmer_id": r.swimmer_id,
            "entity_type": r.entity_type,
            "entity_id": r.entity_id,
            "entity_name": r.entity_name,
            "brief_output": r.brief_output,
            "full_output": r.full_output,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/history/{swimmer_id}")
def get_swimmer_skill_history(
    swimmer_id: int,
    db: DBSession = Depends(get_db),
):
    """Return skill outputs for a specific swimmer."""
    from sqlalchemy import desc as _swh_desc
    rows = (
        db.query(models.SkillOutput)
        .filter(models.SkillOutput.swimmer_id == swimmer_id)
        .order_by(_swh_desc(models.SkillOutput.created_at))
        .limit(30)
        .all()
    )
    return [
        {
            "id": r.id,
            "skill_type": r.skill_type,
            "entity_name": r.entity_name,
            "brief_output": r.brief_output,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
