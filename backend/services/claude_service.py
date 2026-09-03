"""
Claude API integration for coaching analysis, profiling, and planning.
"""
import os
import json
import inspect
import re
from datetime import date
from typing import Optional
import anthropic
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.availability import availability_ranges, is_excused
from backend.services.event_normalizer import canonicalize_event, event_parts
from backend.services.profile_status import (
    FOUNDATION_KEY_ALIASES,
    LIVING_PROFILE_TYPES,
    build_profile_status,
)
from backend.services.terminology import coach_terminology_context

_client: Optional[anthropic.Anthropic] = None
_client_proxy = None


def _get_raw_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    return _client


class _MessagesProxy:
    def create(self, **kwargs):
        operation = kwargs.pop("operation", None) or inspect.currentframe().f_back.f_code.co_name
        return create_message(operation=operation, **kwargs)


class _ClientProxy:
    messages = _MessagesProxy()


def get_client():
    """Compatibility client that routes all message calls through telemetry."""
    global _client_proxy
    if _client_proxy is None:
        _client_proxy = _ClientProxy()
    return _client_proxy


MODEL = os.getenv("ANTHROPIC_PRIMARY_MODEL", "claude-sonnet-5")
FAST_MODEL = os.getenv("ANTHROPIC_FAST_MODEL", "claude-haiku-4-5-20251001")
PRIMARY_EFFORT = os.getenv("ANTHROPIC_EFFORT", "medium")
PLANNING_EFFORT = os.getenv("ANTHROPIC_PLANNING_EFFORT", "high")
TRANSCRIPTION_MODEL = os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe")
COACHING_CONTEXT_CHAR_LIMIT = max(
    1800,
    min(int(os.getenv("AI_COACHING_CONTEXT_CHAR_LIMIT", "3200")), 6000),
)

_MODEL_PRICES_PER_MTOK = {
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    "gpt-4o-mini-transcribe": (1.25, 5.0),
}


def _usage_value(usage, name: str) -> int:
    value = getattr(usage, name, 0) if usage is not None else 0
    return int(value or 0)


def record_ai_usage(provider: str, model: str, operation: str, *, input_tokens=0,
                    output_tokens=0, cache_read_tokens=0, cache_write_tokens=0):
    """Persist token counts and an estimate without storing prompts or personal data."""
    input_price, output_price = _MODEL_PRICES_PER_MTOK.get(model, (0.0, 0.0))
    estimated_cost = (
        input_tokens * input_price
        + output_tokens * output_price
        + cache_read_tokens * input_price * 0.1
        + cache_write_tokens * input_price * 1.25
    ) / 1_000_000
    try:
        from backend.database import SessionLocal
        with SessionLocal() as usage_db:
            usage_db.add(models.AIUsageLog(
                provider=provider,
                model=model,
                operation=operation,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read_tokens,
                cache_write_tokens=cache_write_tokens,
                estimated_cost_usd=estimated_cost,
            ))
            usage_db.commit()
    except Exception:
        # Telemetry must never make a coaching request fail.
        pass


def create_message(*, model: Optional[str] = None, operation: Optional[str] = None,
                   effort: Optional[str] = None, **kwargs):
    """Cost-aware Claude call with central model routing and usage telemetry."""
    selected_model = model or MODEL
    if selected_model == MODEL and selected_model.startswith("claude-sonnet-5"):
        kwargs.setdefault("output_config", {"effort": effort or PRIMARY_EFFORT})
    response = _get_raw_client().messages.create(model=selected_model, **kwargs)
    usage = getattr(response, "usage", None)
    caller = inspect.currentframe().f_back.f_code.co_name if operation is None else operation
    record_ai_usage(
        "anthropic",
        selected_model,
        caller,
        input_tokens=_usage_value(usage, "input_tokens"),
        output_tokens=_usage_value(usage, "output_tokens"),
        cache_read_tokens=_usage_value(usage, "cache_read_input_tokens"),
        cache_write_tokens=_usage_value(usage, "cache_creation_input_tokens"),
    )
    return response


def response_text(response) -> str:
    """Return the text blocks from a Claude response, ignoring thinking/tool blocks."""
    parts = []
    for block in getattr(response, "content", None) or []:
        if isinstance(block, dict):
            block_type = block.get("type")
            value = block.get("text")
        else:
            block_type = getattr(block, "type", None)
            value = getattr(block, "text", None)
        if (block_type in (None, "text")) and isinstance(value, str):
            parts.append(value)
    if not parts:
        raise ValueError("Claude response did not contain a text block")
    return "\n".join(parts).strip()


def review_session_import(draft: dict) -> dict:
    """Use the fast model as a read-only sanity check after deterministic extraction."""
    compact = {
        "date": draft.get("date"),
        "start_time": draft.get("start_time"),
        "end_time": draft.get("end_time"),
        "title": draft.get("title"),
        "coach_intent": draft.get("coach_intent"),
        "groups": draft.get("groups"),
    }
    prompt = f"""Check this deterministically extracted swimming-session spreadsheet for likely extraction errors.
Do not critique the coaching plan and do not rewrite it. Check only internal consistency: date/weekday,
time formatting, repeat blocks, row and stated distance totals, missing descriptions, impossible effort values,
and obvious truncated or corrupted text. A typo in the coach's original wording is not an extraction failure.

EXTRACTED DATA:
{json.dumps(compact, ensure_ascii=False, separators=(',', ':'))}

Return JSON only:
{{"status":"ok" or "check", "issues":["short concrete issue"], "summary":"one short sentence"}}
Return an empty issues array when the extraction is internally consistent."""
    response = create_message(
        model=FAST_MODEL,
        operation="review_session_import",
        max_tokens=350,
        messages=[{"role": "user", "content": prompt}],
    )
    parsed = json.loads(_strip_json(response.content[0].text))
    issues = [str(issue)[:240] for issue in (parsed.get("issues") or [])[:6]]
    return {
        "status": "check" if issues else "ok",
        "issues": issues,
        "summary": str(parsed.get("summary") or ("No consistency issues found." if not issues else "Review suggested."))[:300],
        "model": FAST_MODEL,
    }


SESSION_ENERGY_KEYS = [
    "aerobic", "threshold", "vo2", "race_pace", "lact_tol",
    "short_race_pace", "kicking", "sprint",
]


def _clean_zone_breakdown(value: object) -> dict:
    raw = value if isinstance(value, dict) else {}
    cleaned = {}
    for key in SESSION_ENERGY_KEYS:
        try:
            metres = max(0, int(round(float(raw.get(key, 0) or 0))))
        except (TypeError, ValueError):
            metres = 0
        cleaned[key] = metres
    return cleaned


def analyse_session_energy(draft: dict, coach_language: str = "") -> dict:
    """Estimate programme dose from sets, durations, send-offs and recovery.

    This is deliberately labelled as an estimate of the prescribed session,
    not a measurement of any swimmer's physiological response.
    """
    compact_groups = {}
    for key, group in (draft.get("groups") or {}).items():
        if not isinstance(group, dict):
            continue
        compact_groups[str(key)] = {
            "description": group.get("description"),
            "sets": group.get("sets"),
            "items": group.get("items"),
            "stated_total_metres": group.get("total_metres"),
        }
    prompt = f"""Analyse this swimming session as a prescribed external training dose.
Use repetition duration/distance, send-off, likely work time, recovery, work-to-rest ratio,
intensity wording, accumulated repetitions, stroke and kick content. Energy systems overlap:
classify the primary training emphasis of each metre and state uncertainty. Do not claim to
measure swimmer fatigue or actual metabolic contribution.

SESSION:
{json.dumps({"title": draft.get("title"), "intent": draft.get("coach_intent"), "groups": compact_groups}, ensure_ascii=False)}

{coach_language}

Return JSON only:
{{
  "review": {{"status":"ok|check","issues":["short concrete issue"],"summary":"one short sentence"}},
  "energy_system_focus": "aerobic|threshold|vo2|race_pace|lact_tol|sprint|recovery|mixed",
  "primary_emphasis": "short plain-English description",
  "density": "low|moderate|high|very_high",
  "total_metres": 0,
  "group_breakdowns": {{
    "1": {{
      "total_metres": 0,
      "zones": {{"aerobic":0,"threshold":0,"vo2":0,"race_pace":0,"lact_tol":0,"short_race_pace":0,"kicking":0,"sprint":0}},
      "work_rest_summary": "short description",
      "likely_cost": "short description"
    }}
  }},
  "segments": [{{"label":"set label","metres":0,"zone":"one exact zone key","reason":"brief work/rest rationale"}}],
  "assumptions": ["important assumption"],
  "confidence": "low|moderate|high"
}}

Rules:
- Group zone metres should sum to that group's total whenever distances are available.
- Kicking is a content category here; count kick metres under kicking rather than double-counting.
- Use work/rest structure over labels when they conflict.
- Keep canonical zone keys exactly as specified in JSON. In plain-English fields such as primary_emphasis,
  work_rest_summary, likely_cost and reasons, use the coach's terminology when supplied.
- Keep segments and assumptions concise."""
    response = create_message(
        model=FAST_MODEL,
        operation="analyse_session_energy",
        max_tokens=1400,
        timeout=30.0,
        messages=[{"role": "user", "content": prompt}],
    )
    parsed = json.loads(_strip_json(response.content[0].text))
    group_breakdowns = {}
    for key, value in (parsed.get("group_breakdowns") or {}).items():
        if not isinstance(value, dict):
            continue
        zones = _clean_zone_breakdown(value.get("zones"))
        total = sum(zones.values())
        group_breakdowns[str(key)] = {
            "total_metres": total,
            "zones": zones,
            "work_rest_summary": str(value.get("work_rest_summary") or "")[:300],
            "likely_cost": str(value.get("likely_cost") or "")[:300],
        }
    total_metres = max((row["total_metres"] for row in group_breakdowns.values()), default=0)
    return {
        "version": 1,
        "kind": "ai_estimated_prescribed_dose",
        "energy_system_focus": str(parsed.get("energy_system_focus") or "mixed")[:40],
        "primary_emphasis": str(parsed.get("primary_emphasis") or "")[:300],
        "density": str(parsed.get("density") or "moderate")[:30],
        "total_metres": total_metres or int(parsed.get("total_metres") or 0),
        "group_breakdowns": group_breakdowns,
        "segments": [row for row in (parsed.get("segments") or []) if isinstance(row, dict)][:20],
        "assumptions": [str(row)[:240] for row in (parsed.get("assumptions") or [])[:8]],
        "confidence": str(parsed.get("confidence") or "moderate")[:30],
        "model": FAST_MODEL,
        "review": {
            "status": "check" if (parsed.get("review") or {}).get("issues") else "ok",
            "issues": [str(row)[:240] for row in ((parsed.get("review") or {}).get("issues") or [])[:6]],
            "summary": str((parsed.get("review") or {}).get("summary") or "No consistency issues found.")[:300],
            "model": FAST_MODEL,
        },
    }


def apply_energy_analysis_to_draft(draft: dict, analysis: dict) -> dict:
    """Attach a reviewed AI dose estimate to an extracted draft."""
    draft["energy_analysis"] = analysis
    draft["energy_system_focus"] = analysis.get("energy_system_focus")
    groups = draft.get("groups") or {}
    for key, breakdown in (analysis.get("group_breakdowns") or {}).items():
        group = groups.get(str(key)) or groups.get(int(key) if str(key).isdigit() else key)
        if isinstance(group, dict):
            group["volume_breakdown"] = breakdown.get("zones") or {}
            if breakdown.get("total_metres"):
                group["total_metres"] = breakdown["total_metres"]
    return draft


def _prediction_swimmer_brief(swimmer: models.Swimmer, session: models.Session, db: DBSession) -> dict:
    recent_entries = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer.id,
            models.SessionEntry.attended.is_(True),
            models.Session.date < session.date,
        )
        .order_by(models.Session.date.desc())
        .limit(5)
        .all()
    )
    recent_session_ids = [prior.id for _, prior in recent_entries]
    recent_loads = {
        row.session_id: row for row in db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.swimmer_id == swimmer.id,
            models.SwimmerSessionLoad.session_id.in_(recent_session_ids),
        ).all()
    } if recent_session_ids else {}
    recent = []
    for entry, prior in recent_entries:
        load = recent_loads.get(prior.id)
        recent.append({
            "date": prior.date.isoformat(),
            "focus": prior.energy_system_focus,
            "cycle_code": prior.cycle_code,
            "group_done": entry.group_done,
            "zone_load": load.volume_breakdown if load else None,
            "observation": entry.coach_observation,
            "prior_assessment": entry.ai_characterisation,
        })

    planned_group = None
    planned_sub_group = None
    for group in session.groups:
        if swimmer.id in (group.target_swimmer_ids or []):
            planned_group = group.group_number
        for sub_group in group.sub_groups or []:
            if swimmer.id in (sub_group.swimmer_ids or []):
                planned_group = group.group_number
                planned_sub_group = sub_group.label
    macro = session.microcycle.macro if session.microcycle else None
    if not macro and session.microcycle and session.microcycle.block:
        macro = session.microcycle.block.macro
    if not planned_group and macro and macro.group_definitions:
        for label, definition in macro.group_definitions.items():
            if not isinstance(definition, dict):
                continue
            if swimmer.id not in (definition.get("swimmer_ids") or []):
                continue
            try:
                planned_group = int(str(label).lower().replace("group", "").replace("g", "").strip())
            except ValueError:
                planned_group = label
            break
    training_profile = (
        db.query(models.SwimmerProfileVersion)
        .filter(
            models.SwimmerProfileVersion.swimmer_id == swimmer.id,
            models.SwimmerProfileVersion.profile_type == "training",
        )
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .first()
    )
    active_events = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.swimmer_id == swimmer.id,
        models.SwimmerLoadEvent.date_from <= session.date,
        models.SwimmerLoadEvent.resolved.is_(False),
    ).all()
    return {
        "swimmer_id": swimmer.id,
        "name": swimmer.name,
        "dob": swimmer.dob.isoformat() if swimmer.dob else None,
        "target_events": swimmer.target_events or [],
        "strengths": swimmer.strengths,
        "development": swimmer.weaknesses,
        "physical_profile": swimmer.physical_profile or {},
        "profile_notes": (swimmer.profile_notes or "")[:600],
        "training_response_profile": training_profile.data if training_profile else {},
        "planned_group": planned_group,
        "planned_sub_group": planned_sub_group,
        "recent_observed_sessions": recent,
        "active_load_events": [{"type": row.event_type, "severity": row.severity, "description": row.description} for row in active_events],
    }


def generate_session_predictions(
    session: models.Session,
    db: DBSession,
    swimmer_ids: Optional[list[int]] = None,
) -> list[dict]:
    """Create cached pre-session predictions and focused coach questions in one call."""
    if swimmer_ids is None and not session.squad:
        return []
    query = db.query(models.Swimmer).filter(models.Swimmer.status == "active")
    if swimmer_ids is not None:
        query = query.filter(models.Swimmer.id.in_(swimmer_ids))
    elif session.squad:
        query = query.filter(models.Swimmer.squad == session.squad)
    swimmers = query.order_by(models.Swimmer.name).all()
    if not swimmers:
        return []

    existing_entries = {
        row.swimmer_id: row for row in db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session.id,
            models.SessionEntry.swimmer_id.in_([row.id for row in swimmers]),
        ).all()
    }
    pending = [row for row in swimmers if not existing_entries.get(row.id) or not existing_entries[row.id].ai_expected_response]
    if not pending:
        cached = []
        for swimmer in swimmers:
            value = existing_entries[swimmer.id].ai_expected_response
            try:
                cached.append(json.loads(value))
            except (TypeError, json.JSONDecodeError):
                cached.append({
                    "swimmer_id": swimmer.id,
                    "predicted_response": str(value),
                    "kind": "legacy_prediction",
                })
        return cached

    from backend.services.cycle_codes import cycle_context
    cycle = cycle_context(session)
    session_groups = [{
        "group_number": group.group_number,
        "description": group.description,
        "sets": group.sets,
        "volume_breakdown": group.volume_breakdown,
    } for group in session.groups]
    briefs = [_prediction_swimmer_brief(row, session, db) for row in pending]
    prompt = f"""Prepare pre-session coaching predictions for the swimmers below.
This is a hypothesis and question-generation task, not an observation task. Never state that a swimmer
is fatigued, struggled, maintained technique, or completed work unless the supplied historical coach
observations say so. The coach is the source of truth for what happens today.

SESSION:
{json.dumps({"date": session.date.isoformat(), "title": session.title, "intent": session.coach_intent, "cycle": cycle, "energy_analysis": session.energy_analysis, "groups": session_groups}, ensure_ascii=False)}

SWIMMERS:
{json.dumps(briefs, ensure_ascii=False)}

Return JSON only as an array with exactly one item per supplied swimmer:
[{{
  "swimmer_id": 1,
  "predicted_response": "brief hypothesis",
  "relative_load": "low|appropriate|high|unclear",
  "fatigue_cost": "low|moderate|high|unclear",
  "expected_recovery": "brief range with uncertainty",
  "training_emphasis": "what adaptation this session is expected to emphasise for them",
  "watch_question": "one specific poolside-observable question, or null",
  "watch_reason": "why this is worth checking, tied to supplied evidence, or null",
  "priority": 0,
  "evidence": ["specific supplied fact"],
  "next_session_consideration": "provisional guidance, explicitly dependent on today's coach observation"
}}]

Priority: 0=no question, 1=useful, 2=important, 3=high concern. Ask only when prior evidence,
the swimmer profile, an active load event, or today's technical goal makes the answer genuinely useful.
Questions must be observable, e.g. pace consistency, stroke count/length, technique under fatigue,
recovery between repetitions, or whether planned quality was completed. Do not ask generic questions."""
    response = create_message(
        model=FAST_MODEL,
        operation="generate_session_predictions",
        max_tokens=min(5000, 450 + len(pending) * 180),
        messages=[{"role": "user", "content": prompt}],
    )
    parsed = json.loads(_strip_json(response.content[0].text))
    by_id = {int(row.get("swimmer_id")): row for row in parsed if isinstance(row, dict) and row.get("swimmer_id")}
    saved = []
    for swimmer in pending:
        prediction = by_id.get(swimmer.id) or {
            "swimmer_id": swimmer.id,
            "predicted_response": "Insufficient evidence for a personalised prediction.",
            "relative_load": "unclear", "fatigue_cost": "unclear", "expected_recovery": "unclear",
            "training_emphasis": session.energy_system_focus or "unspecified",
            "watch_question": None, "watch_reason": None, "priority": 0,
            "evidence": [], "next_session_consideration": "Record a coach observation before adjusting the next session.",
        }
        prediction["kind"] = "ai_prediction_not_observation"
        prediction["session_id"] = session.id
        entry = existing_entries.get(swimmer.id)
        if not entry:
            entry = models.SessionEntry(session_id=session.id, swimmer_id=swimmer.id)
            db.add(entry)
            existing_entries[swimmer.id] = entry
        entry.ai_expected_response = json.dumps(prediction, ensure_ascii=False)
        saved.append(prediction)
    db.flush()
    return saved


def characterise_session_entries_batch(
    session: models.Session,
    entries: list[models.SessionEntry],
    db: DBSession,
) -> dict[int, dict]:
    """Interpret coach observations for multiple swimmers in one post-session call."""
    observed = [row for row in entries if row.attended and (row.coach_observation or "").strip()]
    if not observed:
        return {}
    from backend.services.cycle_codes import cycle_context
    swimmers = {row.id: row for row in db.query(models.Swimmer).filter(
        models.Swimmer.id.in_([entry.swimmer_id for entry in observed]),
    ).all()}
    rows = []
    for entry in observed:
        swimmer = swimmers.get(entry.swimmer_id)
        if not swimmer:
            continue
        try:
            prediction = json.loads(entry.ai_expected_response) if entry.ai_expected_response else None
        except (TypeError, json.JSONDecodeError):
            prediction = entry.ai_expected_response
        rows.append({
            "swimmer": _prediction_swimmer_brief(swimmer, session, db),
            "group_done": entry.group_done,
            "sub_group_done": entry.sub_group_done,
            "prediction": prediction,
            "coach_observation_today": entry.coach_observation,
        })
    prompt = f"""Interpret the coach's post-session observations. The coach observation is the only evidence
of what happened today. Compare it with the cached pre-session prediction, swimmer history, session dose
and cycle position. Do not add unobserved symptoms, pace, heart rate, fatigue or technical outcomes.

SESSION:
{json.dumps({"id": session.id, "date": session.date.isoformat(), "title": session.title, "intent": session.coach_intent, "cycle": cycle_context(session), "energy_analysis": session.energy_analysis}, ensure_ascii=False)}

OBSERVED SWIMMERS:
{json.dumps(rows, ensure_ascii=False)}

Return JSON only as an array:
[{{
  "swimmer_id": 1,
  "observed_response": "what the coach's note supports",
  "prediction_comparison": "confirmed|partly_confirmed|not_confirmed|unclear, with one sentence",
  "fatigue_and_recovery": "cautious interpretation and expected recovery",
  "next_session_action": "one practical adjustment or thing to retain",
  "future_watchpoint": "one specific question for the next relevant session, or null",
  "profile_evidence": "whether this is new evidence, repeated evidence, or too little to update a profile",
  "confidence": "low|moderate|high"
}}]

Keep each field short. A single observation must not redefine the swimmer's profile."""
    response = create_message(
        model=FAST_MODEL,
        operation="characterise_session_entries_batch",
        max_tokens=min(4000, 500 + len(rows) * 220),
        messages=[{"role": "user", "content": prompt}],
    )
    parsed = json.loads(_strip_json(response.content[0].text))
    return {
        int(row["swimmer_id"]): row for row in parsed
        if isinstance(row, dict) and row.get("swimmer_id")
    }


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
- Use the coaching context provided below to make responses specific to this squad, not generic.

What this system can do — you have a live database:
- Swimmer records, times, observations, loads, qualifications and plans are real and persistent.
- Use the read-only database tools proactively instead of guessing or asking the coach to repeat stored facts.
- For timetable facts, use get_session_context with the weekday name. Never infer that a stored slot is missing from model context alone.
- Recurring slot assignments are planning hints only. They do not prove attendance, absence, or that a swimmer completed a session.
- A session occurrence without a submitted register is not attendance evidence. Only SessionEntry register data can support claims that a swimmer attended or missed a session.
- Retrieve the smallest useful slice: resolve the swimmer first, then request only the times, observations, load or planning state needed.
- Never claim that a database change has been made. Conversational changes are proposed and applied only through the app's confirmation or draft-review workflow.
- Specialist session, macro, meso, micro and taper requests are handled by structured planning workflows outside this general conversation.
- If evidence is missing, say what was checked and ask one focused question.
"""


def _legacy_write_capable_tools() -> list:
    """Deprecated schemas retained temporarily while the read-only agent beds in."""
    return [
        {
            "name": "get_recent_sessions",
            "description": "Get sessions from the last N days with their content, groups, and which swimmers attended. Use this when the coach asks about recent training, last week's sessions, what was done recently, etc.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "Number of days to look back (default 14, max 60)"}
                },
                "required": []
            }
        },
        {
            "name": "get_swimmer_detail",
            "description": "Get detailed info on a specific swimmer: profile, recent times, observations, load events, benchmarks. Use when the coach asks about a specific swimmer's progress, times, history, or status.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_name": {"type": "string", "description": "Full or partial name of the swimmer"}
                },
                "required": ["swimmer_name"]
            }
        },
        {
            "name": "update_swimmer_status",
            "description": "Update a swimmer's status. Use when the coach says a swimmer is going on sabbatical, is injured, or is returning to training.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_name": {"type": "string", "description": "Full or partial name of the swimmer"},
                    "status": {"type": "string", "enum": ["active", "sabbatical", "injury"], "description": "New status"}
                },
                "required": ["swimmer_name", "status"]
            }
        },
        {
            "name": "add_swimmer_observation",
            "description": "Save a coaching observation to a swimmer's profile. Use when the coach makes a specific observation about a swimmer's training response, race performance, or states a coaching intent/focus for them.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_name": {"type": "string"},
                    "content": {"type": "string", "description": "The observation text"},
                    "obs_type": {"type": "string", "enum": ["race", "aerobic", "threshold", "vo2", "speed", "recovery", "physical", "general", "coaching_intent"], "description": "Type of observation"},
                    "date": {"type": "string", "description": "ISO date string YYYY-MM-DD, defaults to today"}
                },
                "required": ["swimmer_name", "content", "obs_type"]
            }
        },
        {
            "name": "get_season_plan",
            "description": "Get the full season plan: all macros with their meso phases, group definitions, upcoming meets. Always call this before creating or editing a plan so you know what already exists.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "update_season_plan",
            "description": "Update an existing macro's name, narrative, dates, or group definitions. Use when the coach wants to change something about the overall macro plan.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "macro_id": {"type": "integer", "description": "ID of the macro to update (from get_season_plan)"},
                    "name": {"type": "string"},
                    "narrative": {"type": "string"},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                    "group_definitions": {"type": "object", "description": "Full updated group definitions — replaces existing"}
                },
                "required": ["macro_id"]
            }
        },
        {
            "name": "add_meso",
            "description": "Add a new meso phase to an existing macro.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "macro_id": {"type": "integer", "description": "ID of the parent macro"},
                    "name": {"type": "string"},
                    "phase_type": {"type": "string", "enum": ["base", "build", "peak", "taper", "competition", "recovery", "transition"]},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                    "group_intents": {"type": "object", "description": "Intent per group: {G1: '...', G2: '...'}"},
                    "notes": {"type": "string"}
                },
                "required": ["macro_id", "name", "phase_type", "date_from", "date_to"]
            }
        },
        {
            "name": "update_meso",
            "description": "Edit an existing meso phase — change its dates, phase type, group intents, or notes.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "meso_id": {"type": "integer", "description": "ID of the meso to update (from get_season_plan)"},
                    "name": {"type": "string"},
                    "phase_type": {"type": "string", "enum": ["base", "build", "peak", "taper", "competition", "recovery", "transition"]},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                    "group_intents": {"type": "object"},
                    "notes": {"type": "string"}
                },
                "required": ["meso_id"]
            }
        },
        {
            "name": "delete_meso",
            "description": "Delete a meso phase from a macro. Use only when the coach explicitly asks to remove a phase.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "meso_id": {"type": "integer", "description": "ID of the meso to delete"}
                },
                "required": ["meso_id"]
            }
        },
        {
            "name": "update_session",
            "description": "Edit an existing session — update its title, coach intent, energy system focus, notes, or group content/sets. Use when the coach wants to change something about a specific session.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "integer", "description": "ID of the session to update (from get_recent_sessions)"},
                    "title": {"type": "string"},
                    "coach_intent": {"type": "string"},
                    "energy_system_focus": {"type": "string"},
                    "coach_notes": {"type": "string"},
                    "groups": {
                        "type": "object",
                        "description": "Updated group content keyed by group number string. Each value: {description, sets}. Only include groups you want to change."
                    }
                },
                "required": ["session_id"]
            }
        },
        {
            "name": "cancel_session",
            "description": "Mark a whole squad session as cancelled and preserve the reason. Use when the coach says a session was/is cancelled, including bank holidays. Identify it by session_id where possible, otherwise by date plus optional squad/start time.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "integer"},
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "squad": {"type": "string"},
                    "start_time": {"type": "string", "description": "HH:MM if the date has multiple sessions"},
                    "reason": {"type": "string", "description": "e.g. Public holiday, pool unavailable, coach unavailable"}
                },
                "required": ["reason"]
            }
        },
        {
            "name": "add_swimmer_availability",
            "description": "Save a period when one swimmer is not expected at normal training. Use for holidays, competitions not already linked through a meet entry, exams, work, injury, or a deliberate taper/planned rest day. This is excused and must not be described as poor attendance.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_id": {"type": "integer"},
                    "reason": {"type": "string", "enum": ["holiday", "competition", "planned_rest", "taper_rest", "exams", "work", "injury", "other"]},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                    "notes": {"type": "string"}
                },
                "required": ["swimmer_id", "reason", "date_from", "date_to"]
            }
        },
        {
            "name": "create_season_plan",
            "description": "Create a macro training plan with meso blocks inside it. Use this when the coach describes their season plan and wants it saved as a blueprint — with macro dates, narrative intent, group definitions (who is in each group), and the meso phases within the macro. Always call get_season_plan first to check what already exists before creating.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Macro name, e.g. 'Spring 2026 — County Prep'"},
                    "squad": {"type": "string", "description": "Squad name, e.g. 'Silver 1'"},
                    "date_from": {"type": "string", "description": "Start date YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "End date YYYY-MM-DD"},
                    "narrative": {"type": "string", "description": "Overall coaching narrative for the macro — what you're trying to achieve across the full period"},
                    "group_definitions": {
                        "type": "object",
                        "description": "Group assignments — keys are G1/G2/G3, values have description and swimmer_ids (use swimmer IDs from the squad snapshot). Example: {G1: {description: 'Top tier', swimmer_ids: [1,5,8]}}",
                    },
                    "mesos": {
                        "type": "array",
                        "description": "The meso phases within this macro, in order",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "phase_type": {"type": "string", "enum": ["base", "build", "peak", "taper", "competition", "recovery", "transition"]},
                                "date_from": {"type": "string"},
                                "date_to": {"type": "string"},
                                "group_intents": {
                                    "type": "object",
                                    "description": "Free-text intent per group for this meso. Keys: G1, G2, G3"
                                },
                                "notes": {"type": "string"}
                            },
                            "required": ["name", "phase_type", "date_from", "date_to"]
                        }
                    }
                },
                "required": ["name", "date_from", "date_to", "mesos"]
            }
        },
    ]


def get_tools() -> list:
    """Compact, read-only tools for the conversational coaching agent.

    Planning and data changes are deliberately handled by the app's review and
    confirmation flows. Keeping this schema small also avoids paying to resend
    large tool descriptions with every conversational turn.
    """
    return [
        {
            "name": "find_swimmer",
            "description": "Resolve a swimmer name to an ID before requesting their data.",
            "input_schema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
        {
            "name": "get_swimmer_summary",
            "description": "Get a compact profile, attendance and current readiness summary for one swimmer ID.",
            "input_schema": {
                "type": "object",
                "properties": {"swimmer_id": {"type": "integer"}},
                "required": ["swimmer_id"],
            },
        },
        {
            "name": "get_swim_times",
            "description": "Get recent or event-specific race times for one swimmer. Event aliases are accepted (for example fly/butterfly, free/freestyle, or '50/100 fly'). Omit event to inspect the athlete's latest results across all events.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_id": {"type": "integer"},
                    "event": {"type": "string"},
                    "course": {"type": "string", "enum": ["SCM", "LCM"]},
                    "limit": {"type": "integer"},
                },
                "required": ["swimmer_id"],
            },
        },
        {
            "name": "get_training_load",
            "description": "Get aggregated training volume and attendance for one swimmer over a recent period.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_id": {"type": "integer"},
                    "days": {"type": "integer"},
                },
                "required": ["swimmer_id"],
            },
        },
        {
            "name": "get_observations",
            "description": "Get recent coach observations for one swimmer, optionally filtered by type.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_id": {"type": "integer"},
                    "days": {"type": "integer"},
                    "obs_type": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["swimmer_id"],
            },
        },
        {
            "name": "get_qualification_status",
            "description": "Get a swimmer's latest qualification assessments and gaps.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_id": {"type": "integer"},
                    "standard_set_id": {"type": "integer"},
                    "limit": {"type": "integer"},
                },
                "required": ["swimmer_id"],
            },
        },
        {
            "name": "get_planning_state",
            "description": "Get cached pathway, phase, target-meet and open planning-alert state.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "swimmer_id": {"type": "integer"},
                    "macro_id": {"type": "integer"},
                },
                "required": [],
            },
        },
        {
            "name": "list_meets",
            "description": "List upcoming meets with target and entry counts.",
            "input_schema": {
                "type": "object",
                "properties": {"days_ahead": {"type": "integer"}},
                "required": [],
            },
        },
        {
            "name": "get_recent_sessions",
            "description": "Get recent session content and attendance. Use only when session-level detail is needed.",
            "input_schema": {
                "type": "object",
                "properties": {"days": {"type": "integer"}},
                "required": [],
            },
        },
        {
            "name": "get_season_plan",
            "description": "Get the existing macros, mesocycles, groups and target meets.",
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
        {
            "name": "get_session_context",
            "description": "Get pool slot, usual slot assignments, explicit register state and recent-load context for a day or time of day. Slot assignments are not attendance.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "day": {
                        "type": "string",
                        "enum": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
                        "description": "Preferred weekday input; use the name stated by the coach.",
                    },
                    "day_of_week": {
                        "type": "integer", "minimum": 0, "maximum": 6,
                        "description": "Legacy input only: 0=Monday, 1=Tuesday, 2=Wednesday, 3=Thursday, 4=Friday, 5=Saturday, 6=Sunday.",
                    },
                    "time_period": {"type": "string", "enum": ["AM", "PM"]},
                },
                "required": [],
            },
        },
    ]


def execute_tool(tool_name: str, tool_input: dict, db: DBSession) -> str:
    """Execute a tool call and return the result as a string."""
    from datetime import date as date_type, timedelta

    def as_date(value):
        if isinstance(value, str):
            return date_type.fromisoformat(value)
        return value

    def dump(value):
        return json.dumps(value, default=str, separators=(",", ":"))

    if tool_name == "find_swimmer":
        name = " ".join(str(tool_input.get("name") or "").split())
        if not name:
            return dump({"error": "name is required"})
        matches = (
            db.query(models.Swimmer)
            .filter(models.Swimmer.name.ilike(f"%{name}%"), models.Swimmer.active == True)
            .order_by(models.Swimmer.name)
            .limit(8)
            .all()
        )
        return dump({"matches": [
            {"id": s.id, "name": s.name, "squad": s.squad, "status": s.status}
            for s in matches
        ]})

    if tool_name == "get_swimmer_summary":
        swimmer_id = int(tool_input["swimmer_id"])
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
        if not swimmer:
            return dump({"error": "swimmer not found"})
        today = date_type.today()
        latest_profiles = {}
        for profile_type in ("race", "training"):
            profile = (
                db.query(models.SwimmerProfileVersion)
                .filter(
                    models.SwimmerProfileVersion.swimmer_id == swimmer_id,
                    models.SwimmerProfileVersion.profile_type == profile_type,
                )
                .order_by(models.SwimmerProfileVersion.created_at.desc())
                .first()
            )
            if profile:
                latest_profiles[profile_type] = {
                    "data": profile.data,
                    "change": profile.change_summary,
                    "as_of": profile.created_at,
                }
        load_events = (
            db.query(models.SwimmerLoadEvent)
            .filter(
                models.SwimmerLoadEvent.swimmer_id == swimmer_id,
                models.SwimmerLoadEvent.resolved == False,
            )
            .order_by(models.SwimmerLoadEvent.date_from.desc())
            .limit(5)
            .all()
        )
        return dump({
            "id": swimmer.id,
            "name": swimmer.name,
            "dob": swimmer.dob,
            "gender": swimmer.gender,
            "squad": swimmer.squad,
            "status": swimmer.status,
            "target_events": swimmer.target_events or [],
            "strengths": swimmer.strengths,
            "weaknesses": swimmer.weaknesses,
            "profile_notes": (swimmer.profile_notes or "")[:800],
            "physical_profile": swimmer.physical_profile,
            "psychological_profile": swimmer.psychological_profile,
            "synthesised_profiles": latest_profiles,
            "attendance": build_attendance_stats(swimmer_id, db),
            "active_load_events": [
                {"type": e.event_type, "from": e.date_from, "to": e.date_to,
                 "severity": e.severity, "description": e.description}
                for e in load_events
            ],
            "as_of": today,
        })

    if tool_name == "get_swim_times":
        swimmer_id = int(tool_input["swimmer_id"])
        limit = max(1, min(int(tool_input.get("limit", 12)), 30))
        query = db.query(models.SwimTime).filter(models.SwimTime.swimmer_id == swimmer_id)
        if tool_input.get("course"):
            query = query.filter(models.SwimTime.course == tool_input["course"])

        # Fetch before applying the event limit so aliases such as "fly" match
        # stored labels such as "Butterfly", and compound requests can return
        # both distances. The profile Times tab reads these same SwimTime rows.
        rows = query.order_by(models.SwimTime.date.desc()).all()
        requested_event = str(tool_input.get("event") or "").strip()
        if requested_event:
            requested_distances = {
                int(value) for value in re.findall(
                    r"\b(25|50|100|200|400|800|1500)\b",
                    requested_event.lower(),
                )
            }
            _, requested_stroke = event_parts(requested_event)
            requested_canonical = canonicalize_event(requested_event)

            def event_matches(row) -> bool:
                parsed_distance, parsed_stroke = event_parts(row.event)
                _, stored_stroke = event_parts(row.stroke or "")
                row_distance = row.distance or parsed_distance
                row_stroke = stored_stroke or parsed_stroke or ""
                if requested_distances and row_distance not in requested_distances:
                    return False
                if requested_stroke and row_stroke != requested_stroke:
                    return False
                if requested_distances or requested_stroke:
                    return True
                row_canonical = canonicalize_event(row.event)
                return requested_canonical in row_canonical or row_canonical in requested_canonical

            rows = [row for row in rows if event_matches(row)]

        best_by_event = {}
        for row in rows:
            key = (canonicalize_event(row.event), row.course)
            best_by_event[key] = min(best_by_event.get(key, row.time_seconds), row.time_seconds)
        rows = rows[:limit]
        return dump({"times": [
            {"event": r.event, "course": r.course, "time_seconds": r.time_seconds,
             "wa_points": r.wa_points, "date": r.date, "meet": r.meet,
             "level": r.level, "round": r.round,
             "is_personal_best": r.time_seconds == best_by_event[(canonicalize_event(r.event), r.course)],
             "seconds_from_pb": round(
                 r.time_seconds - best_by_event[(canonicalize_event(r.event), r.course)], 2
             )}
            for r in rows
        ]})

    if tool_name == "get_training_load":
        swimmer_id = int(tool_input["swimmer_id"])
        days = max(7, min(int(tool_input.get("days", 28)), 90))
        cutoff = date_type.today() - timedelta(days=days)
        rows = (
            db.query(models.SwimmerSessionLoad)
            .filter(
                models.SwimmerSessionLoad.swimmer_id == swimmer_id,
                models.SwimmerSessionLoad.session_date >= cutoff,
            )
            .order_by(models.SwimmerSessionLoad.session_date.desc())
            .all()
        )
        totals = {}
        total_metres = 0.0
        for row in rows:
            for zone, value in (row.volume_breakdown or {}).items():
                if isinstance(value, (int, float)):
                    totals[zone] = totals.get(zone, 0.0) + value
                    total_metres += value
        entries = (
            db.query(models.SessionEntry)
            .join(models.Session)
            .filter(
                models.SessionEntry.swimmer_id == swimmer_id,
                models.Session.date >= cutoff,
                models.Session.status != "cancelled",
            )
            .all()
        )
        recorded = [e for e in entries if e.attended is not None]
        attended = len([e for e in recorded if e.attended])
        return dump({
            "days": days,
            "sessions_with_load": len(rows),
            "total_metres": total_metres,
            "volume_by_zone": totals,
            "attendance": {"attended": attended, "recorded": len(recorded)},
            "recent_sessions": [
                {"date": r.session_date, "group": r.group_number,
                 "sub_group": r.sub_group_label, "volume": r.volume_breakdown or {}}
                for r in rows[:12]
            ],
        })

    if tool_name == "get_observations":
        swimmer_id = int(tool_input["swimmer_id"])
        days = max(7, min(int(tool_input.get("days", 56)), 180))
        limit = max(1, min(int(tool_input.get("limit", 12)), 30))
        cutoff = date_type.today() - timedelta(days=days)
        query = db.query(models.SwimmerObservation).filter(
            models.SwimmerObservation.swimmer_id == swimmer_id,
            models.SwimmerObservation.date >= cutoff,
        )
        if tool_input.get("obs_type"):
            query = query.filter(models.SwimmerObservation.obs_type == tool_input["obs_type"])
        rows = query.order_by(models.SwimmerObservation.date.desc()).limit(limit).all()
        return dump({"observations": [
            {"date": r.date, "type": r.obs_type, "event": r.event,
             "energy_zone": r.energy_zone, "content": r.content[:700],
             "structured": r.structured}
            for r in rows
        ]})

    if tool_name == "get_qualification_status":
        swimmer_id = int(tool_input["swimmer_id"])
        limit = max(1, min(int(tool_input.get("limit", 20)), 50))
        query = db.query(models.QualificationAssessment).filter(
            models.QualificationAssessment.swimmer_id == swimmer_id
        )
        if tool_input.get("standard_set_id"):
            query = query.filter(
                models.QualificationAssessment.standard_set_id == int(tool_input["standard_set_id"])
            )
        rows = query.order_by(models.QualificationAssessment.calculated_at.desc()).limit(limit).all()
        return dump({"assessments": [
            {"set_id": r.standard_set_id, "set": r.standard_set.name,
             "event": r.standard.event_name, "course": r.standard.course,
             "standard_type": r.standard.standard_type,
             "standard_seconds": r.standard.time_seconds, "status": r.status,
             "best_seconds": r.best_time_seconds, "gap_seconds": r.gap_seconds,
             "gap_percent": r.gap_percent, "reason": r.eligibility_reason}
            for r in rows
        ]})

    if tool_name == "get_planning_state":
        query = db.query(models.PlanningSnapshot)
        if tool_input.get("swimmer_id"):
            query = query.filter(models.PlanningSnapshot.swimmer_id == int(tool_input["swimmer_id"]))
        if tool_input.get("macro_id"):
            query = query.filter(models.PlanningSnapshot.macro_id == int(tool_input["macro_id"]))
        snapshots = query.order_by(
            models.PlanningSnapshot.as_of_date.desc(), models.PlanningSnapshot.id.desc()
        ).limit(20).all()
        rec_query = db.query(models.PlanningRecommendation).filter(
            models.PlanningRecommendation.status.in_(["open", "accepted", "snoozed"])
        )
        if tool_input.get("swimmer_id"):
            rec_query = rec_query.filter(
                models.PlanningRecommendation.swimmer_id == int(tool_input["swimmer_id"])
            )
        if tool_input.get("macro_id"):
            rec_query = rec_query.filter(
                models.PlanningRecommendation.macro_id == int(tool_input["macro_id"])
            )
        recommendations = rec_query.order_by(models.PlanningRecommendation.created_at.desc()).limit(15).all()
        return dump({
            "snapshots": [
                {"swimmer_id": s.swimmer_id, "swimmer": s.swimmer.name,
                 "macro_id": s.macro_id, "pathway": s.pathway.name,
                 "as_of": s.as_of_date, "target_meet": s.target_meet.name if s.target_meet else None,
                 "target_date": s.target_date, "weeks_to_target": s.weeks_to_target,
                 "phase": s.current_phase, "race_specific_start": s.race_specific_start,
                 "taper_start": s.taper_start, "load_multiplier": s.load_multiplier,
                 "qualification": s.qualification_status, "flags": s.flags or []}
                for s in snapshots
            ],
            "recommendations": [
                {"id": r.id, "kind": r.kind, "severity": r.severity,
                 "title": r.title, "detail": r.detail[:700], "status": r.status,
                 "follow_up_at": r.follow_up_at}
                for r in recommendations
            ],
        })

    if tool_name == "list_meets":
        days = max(14, min(int(tool_input.get("days_ahead", 120)), 366))
        today = date_type.today()
        rows = (
            db.query(models.Meet)
            .filter(models.Meet.date >= today, models.Meet.date <= today + timedelta(days=days))
            .order_by(models.Meet.date)
            .limit(40)
            .all()
        )
        return dump({"meets": [
            {"id": m.id, "name": m.name, "date": m.date, "date_to": m.date_to,
             "course": m.course, "level": m.level, "location": m.location,
             "target_count": len(m.targets), "entry_count": len(m.entries)}
            for m in rows
        ]})

    if tool_name == "get_session_context":
        day_names = {
            "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
            "friday": 4, "saturday": 5, "sunday": 6,
        }
        named_day = str(tool_input.get("day") or "").strip().lower()
        day_of_week = day_names.get(named_day)
        if day_of_week is None:
            day_of_week = tool_input.get("day_of_week")
        hint = {
            "dow": day_of_week,
            "time_period": tool_input.get("time_period"),
        }
        context = build_session_writing_context(db, hint)
        return context[:12000] if context else "No matching session context found."

    if tool_name == "get_recent_sessions":
        days = min(int(tool_input.get("days", 14)), 60)
        cutoff = date_type.today() - timedelta(days=days)
        sessions = (
            db.query(models.Session)
            .filter(
                models.Session.date >= cutoff,
                models.Session.status != 'cancelled',
            )
            .order_by(models.Session.date.desc())
            .limit(30)
            .all()
        )
        if not sessions:
            return f"No sessions found in the last {days} days."
        lines = [f"SESSIONS (last {days} days):"]
        for s in sessions:
            title = s.title or s.energy_system_focus or "Session"
            intent = f" — {s.coach_intent[:100]}" if s.coach_intent else ""
            lines.append(f"\n{s.date} | {title}{intent}")
            # Groups
            groups = db.query(models.SessionGroup).filter(models.SessionGroup.session_id == s.id).all()
            for g in groups:
                desc = g.description or ""
                sets_str = "; ".join(str(x) for x in (g.sets or [])[:3])
                lines.append(f"  Group {g.group_number}: {desc[:80]}" + (f" | Sets: {sets_str[:100]}" if sets_str else ""))
            # Attendance
            entries = (
                db.query(models.SessionEntry)
                .filter(models.SessionEntry.session_id == s.id)
                .all()
            )
            if entries:
                present = []
                absent = []
                for e in entries:
                    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == e.swimmer_id).first()
                    name = swimmer.name if swimmer else f"id={e.swimmer_id}"
                    if e.attended:
                        grp = f" (G{e.group_done})" if e.group_done else ""
                        obs = f" — {e.coach_observation[:60]}" if e.coach_observation else ""
                        present.append(f"{name}{grp}{obs}")
                    else:
                        absent.append(name)
                if present:
                    lines.append(f"  Attended ({len(present)}): {', '.join(present[:15])}")
                if absent:
                    lines.append(f"  Absent: {', '.join(absent[:10])}")
            else:
                lines.append("  No register taken.")
        return "\n".join(lines)

    elif tool_name == "get_swimmer_detail":
        name = tool_input.get("swimmer_name", "")
        swimmer = db.query(models.Swimmer).filter(
            models.Swimmer.name.ilike(f"%{name}%"),
            models.Swimmer.status != 'inactive'
        ).first()
        if not swimmer:
            return f"Could not find swimmer matching '{name}'"
        return get_swimmer_full_context(swimmer, db)

    elif tool_name == "update_swimmer_status":
        name = tool_input.get("swimmer_name", "")
        new_status = tool_input.get("status", "")
        swimmer = db.query(models.Swimmer).filter(
            models.Swimmer.name.ilike(f"%{name}%"),
            models.Swimmer.status != 'inactive'
        ).first()
        if not swimmer:
            return f"Could not find swimmer matching '{name}'"
        swimmer.status = new_status
        db.commit()
        return f"Updated {swimmer.name}'s status to {new_status}."

    elif tool_name == "add_swimmer_observation":
        name = tool_input.get("swimmer_name", "")
        swimmer = db.query(models.Swimmer).filter(
            models.Swimmer.name.ilike(f"%{name}%"),
            models.Swimmer.status != 'inactive'
        ).first()
        if not swimmer:
            return f"Could not find swimmer matching '{name}'"
        obs_date = tool_input.get("date") or date_type.today().isoformat()
        obs = models.SwimmerObservation(
            swimmer_id=swimmer.id,
            obs_type=tool_input.get("obs_type", "general"),
            content=tool_input.get("content", ""),
            date=obs_date,
        )
        db.add(obs)
        db.commit()
        return f"Saved {tool_input.get('obs_type', 'general')} observation for {swimmer.name}: {tool_input.get('content', '')[:100]}"

    elif tool_name == "update_season_plan":
        macro_id = tool_input.get("macro_id")
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
        if not macro:
            return f"Macro ID {macro_id} not found."
        for field in ("name", "narrative", "date_from", "date_to", "group_definitions"):
            if field in tool_input:
                value = as_date(tool_input[field]) if field in ("date_from", "date_to") else tool_input[field]
                setattr(macro, field, value)
        db.commit()
        return f"Updated macro '{macro.name}'."

    elif tool_name == "add_meso":
        macro_id = tool_input.get("macro_id")
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
        if not macro:
            return f"Macro ID {macro_id} not found."
        meso = models.SeasonBlock(
            macro_id=macro_id,
            name=tool_input["name"],
            squad=macro.squad,
            phase_type=tool_input.get("phase_type"),
            date_from=as_date(tool_input["date_from"]),
            date_to=as_date(tool_input["date_to"]),
            group_intents=tool_input.get("group_intents"),
            notes=tool_input.get("notes"),
        )
        db.add(meso)
        db.commit()
        return f"Added meso '{meso.name}' ({meso.date_from} → {meso.date_to}) to macro '{macro.name}'."

    elif tool_name == "update_meso":
        meso_id = tool_input.get("meso_id")
        meso = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == meso_id).first()
        if not meso:
            return f"Meso ID {meso_id} not found."
        for field in ("name", "phase_type", "date_from", "date_to", "group_intents", "notes"):
            if field in tool_input:
                value = as_date(tool_input[field]) if field in ("date_from", "date_to") else tool_input[field]
                setattr(meso, field, value)
        db.commit()
        return f"Updated meso '{meso.name}'."

    elif tool_name == "delete_meso":
        meso_id = tool_input.get("meso_id")
        meso = db.query(models.SeasonBlock).filter(models.SeasonBlock.id == meso_id).first()
        if not meso:
            return f"Meso ID {meso_id} not found."
        name = meso.name
        db.delete(meso)
        db.commit()
        return f"Deleted meso '{name}'."

    elif tool_name == "update_session":
        session_id = tool_input.get("session_id")
        session = db.query(models.Session).filter(models.Session.id == session_id).first()
        if not session:
            return f"Session ID {session_id} not found."
        for field in ("title", "coach_intent", "energy_system_focus", "coach_notes"):
            if field in tool_input:
                setattr(session, field, tool_input[field])
        if "groups" in tool_input:
            for group_num_str, content in tool_input["groups"].items():
                group_num = int(group_num_str)
                group = next((g for g in session.groups if g.group_number == group_num), None)
                if group:
                    if "description" in content:
                        group.description = content["description"]
                    if "sets" in content:
                        group.sets = {"raw": content["sets"]}
                else:
                    new_group = models.SessionGroup(
                        session_id=session.id,
                        group_number=group_num,
                        description=content.get("description", ""),
                        sets={"raw": content.get("sets", "")},
                    )
                    db.add(new_group)
        db.commit()
        return f"Updated session '{session.title or session.date}'."

    elif tool_name == "cancel_session":
        session = None
        session_id = tool_input.get("session_id")
        if session_id:
            session = db.query(models.Session).filter(models.Session.id == session_id).first()
            if not session:
                return f"Session ID {session_id} not found."
        else:
            target_date = as_date(tool_input.get("date"))
            if not target_date:
                return "A session_id or date is required to cancel a session."
            query = db.query(models.Session).filter(models.Session.date == target_date)
            if tool_input.get("squad"):
                query = query.filter(models.Session.squad == tool_input["squad"])
            if tool_input.get("start_time"):
                query = query.filter(models.Session.start_time == tool_input["start_time"])
            matches = query.all()
            if len(matches) > 1:
                choices = ", ".join(f"ID {row.id} ({row.start_time or 'time unknown'}, {row.squad or 'no squad'})" for row in matches)
                return f"More than one session matches {target_date}: {choices}. Ask the coach which one."
            if matches:
                session = matches[0]
            else:
                slot_query = db.query(models.PoolSlot).filter(
                    models.PoolSlot.day_of_week == target_date.weekday(),
                    models.PoolSlot.active.is_(True),
                )
                if tool_input.get("squad"):
                    slot_query = slot_query.filter(models.PoolSlot.squad == tool_input["squad"])
                if tool_input.get("start_time"):
                    slot_query = slot_query.filter(models.PoolSlot.time == tool_input["start_time"])
                slots = slot_query.all()
                if len(slots) != 1:
                    choices = ", ".join(
                        f"slot {row.id} ({row.time}, {row.squad or 'no squad'}, {row.label or 'unlabelled'})"
                        for row in slots[:8]
                    )
                    return f"I cannot uniquely identify the session on {target_date}. Matching choices: {choices or 'none'}. Ask for the time or squad."
                slot = slots[0]
                session = models.Session(
                    date=target_date,
                    start_time=slot.time,
                    end_time=slot.end_time,
                    squad=slot.squad,
                    title=slot.label,
                    pool_slot_id=slot.id,
                    course=slot.course,
                    source="calendar",
                )
                db.add(session)
                db.flush()
                from backend.services.cycle_codes import link_session
                link_session(session, db)
        session.status = "cancelled"
        session.cancel_reason = tool_input["reason"].strip()
        db.commit()
        return f"Cancelled session ID {session.id} on {session.date}: {session.cancel_reason}."

    elif tool_name == "add_swimmer_availability":
        from backend.services.availability import normalise_reason

        swimmer = db.query(models.Swimmer).filter(
            models.Swimmer.id == tool_input.get("swimmer_id"),
        ).first()
        if not swimmer:
            return f"Swimmer ID {tool_input.get('swimmer_id')} not found."
        date_from = as_date(tool_input.get("date_from"))
        date_to = as_date(tool_input.get("date_to"))
        if not date_from or not date_to or date_to < date_from:
            return "Availability requires a valid date range with the end on or after the start."
        reason = normalise_reason(tool_input.get("reason"))
        existing = db.query(models.SwimmerException).filter(
            models.SwimmerException.swimmer_id == swimmer.id,
            models.SwimmerException.reason == reason,
            models.SwimmerException.date_from == date_from,
            models.SwimmerException.date_to == date_to,
        ).first()
        if not existing:
            db.add(models.SwimmerException(
                swimmer_id=swimmer.id,
                reason=reason,
                date_from=date_from,
                date_to=date_to,
                notes=(tool_input.get("notes") or "").strip() or None,
            ))
        if reason == "competition":
            load_event = db.query(models.SwimmerLoadEvent).filter(
                models.SwimmerLoadEvent.swimmer_id == swimmer.id,
                models.SwimmerLoadEvent.event_type == "competition",
                models.SwimmerLoadEvent.date_from == date_from,
                models.SwimmerLoadEvent.date_to == date_to,
            ).first()
            if not load_event:
                db.add(models.SwimmerLoadEvent(
                    swimmer_id=swimmer.id,
                    event_type="competition",
                    date_from=date_from,
                    date_to=date_to,
                    severity=2,
                    description=(tool_input.get("notes") or "Competition").strip(),
                    resolved=date_to <= date_type.today(),
                ))
        db.commit()
        return f"Saved {reason.replace('_', ' ')} availability for {swimmer.name}: {date_from} to {date_to}."

    elif tool_name == "get_season_plan":
        today = date_type.today()
        lines = []

        # Full macro/meso structure with IDs for editing
        macros = db.query(models.TrainingMacro).order_by(models.TrainingMacro.date_from).all()
        if macros:
            lines.append("SEASON PLAN (macros and meso phases):")
            for macro in macros:
                status = "CURRENT" if macro.date_from <= today <= macro.date_to else ("PAST" if macro.date_to < today else "UPCOMING")
                lines.append(f"\nMACRO [id={macro.id}] {macro.name} | {macro.squad or 'no squad'} | {macro.date_from} → {macro.date_to} | {status}")
                if macro.narrative:
                    lines.append(f"  Narrative: {macro.narrative[:200]}")
                if macro.group_definitions:
                    for g, defn in macro.group_definitions.items():
                        desc = defn.get("description", "")
                        names = defn.get("swimmer_names") or [str(i) for i in (defn.get("swimmer_ids") or [])]
                        lines.append(f"  {g}: {desc} — {', '.join(names) if names else 'no swimmers assigned'}")
                mesos = db.query(models.SeasonBlock).filter(
                    models.SeasonBlock.macro_id == macro.id
                ).order_by(models.SeasonBlock.date_from).all()
                for meso in mesos:
                    total_days = (meso.date_to - meso.date_from).days + 1
                    total_weeks = max(1, round(total_days / 7))
                    meso_status = "NOW" if meso.date_from <= today <= meso.date_to else ""
                    lines.append(f"  MESO [id={meso.id}] {meso.name} | {meso.phase_type} | {meso.date_from} → {meso.date_to} ({total_weeks}w) {meso_status}")
                    if meso.group_intents:
                        for g, intent in meso.group_intents.items():
                            if intent:
                                lines.append(f"    {g}: {intent[:100]}")
        else:
            lines.append("No macros defined yet.")
            # Fall back to orphan mesos
            current_block = db.query(models.SeasonBlock).filter(
                models.SeasonBlock.date_from <= today, models.SeasonBlock.date_to >= today
            ).first()
            if current_block:
                lines.append(f"Current block [id={current_block.id}]: {current_block.name} ({current_block.phase_type})")

        # Upcoming meets
        meets = db.query(models.Meet).filter(
            models.Meet.date >= today, models.Meet.date <= today + timedelta(days=120)
        ).order_by(models.Meet.date).all()
        if meets:
            lines.append("\nUPCOMING MEETS (120 days):")
            for m in meets:
                lines.append(f"  [id={m.id}] {m.date} | {m.name} | {m.location or ''}")

        return "\n".join(lines) if lines else "No season plan data available."

    elif tool_name == "create_season_plan":
        try:
            macro = models.TrainingMacro(
                name=tool_input["name"],
                squad=tool_input.get("squad"),
                date_from=as_date(tool_input["date_from"]),
                date_to=as_date(tool_input["date_to"]),
                narrative=tool_input.get("narrative"),
                group_definitions=tool_input.get("group_definitions"),
            )
            db.add(macro)
            db.flush()

            meso_names = []
            for meso_data in tool_input.get("mesos", []):
                meso = models.SeasonBlock(
                    macro_id=macro.id,
                    name=meso_data["name"],
                    squad=tool_input.get("squad"),
                    phase_type=meso_data.get("phase_type"),
                    date_from=as_date(meso_data["date_from"]),
                    date_to=as_date(meso_data["date_to"]),
                    group_intents=meso_data.get("group_intents"),
                    notes=meso_data.get("notes"),
                )
                db.add(meso)
                meso_names.append(f"{meso_data['name']} ({meso_data['date_from']} → {meso_data['date_to']})")

            db.commit()
            return (
                f"Season plan created: '{macro.name}' ({macro.date_from} → {macro.date_to})\n"
                f"Mesos: {', '.join(meso_names)}\n"
                f"Group definitions saved: {list((tool_input.get('group_definitions') or {}).keys())}"
            )
        except Exception as e:
            db.rollback()
            return f"Failed to create season plan: {str(e)}"

    return f"Unknown tool: {tool_name}"


def _coaching_context_for_prompt(profile: models.CoachingProfile, *, full: bool = False) -> str:
    """Return only durable coaching identity; dated planning facts live elsewhere."""
    if not profile:
        return ""

    sections = []
    if profile.ethos:
        ethos_limit = 1800 if full else 900
        sections.append(f"Coaching Philosophy & Ethos: {profile.ethos.strip()[:ethos_limit]}")

    # The remaining durable sections are held in the versioned summary.
    for heading, compact_limit in (
        ("Motivations & Coaching Identity", 550),
        ("Communication & Relationships", 550),
        ("Session Style & Preferences", 650),
        ("Intensity & Terminology", 650),
        ("Decision-making & Growth Edges", 500),
    ):
        match = re.search(
            rf"\*\*{re.escape(heading)}\*\*\s*(.*?)(?=\n\*\*|\Z)",
            profile.summary or "",
            re.DOTALL | re.IGNORECASE,
        )
        if match:
            limit = 1800 if full else compact_limit
            sections.append(f"{heading}: {match.group(1).strip()[:limit]}")

    durable = "\n".join(sections).strip()
    return durable if full else durable[:COACHING_CONTEXT_CHAR_LIMIT]


def _current_season_prompt_context(db: DBSession) -> str:
    """Small, durable season boundary supplied to every planning conversation."""
    from datetime import date as date_type

    season = db.query(models.Season).filter(
        models.Season.is_current.is_(True),
    ).order_by(models.Season.date_from.desc()).first()
    if not season:
        return (
            "CURRENT SEASON: Not started in the app. Treat recent attendance as "
            "unbaselined and ask the coach to start the season before judging patterns."
        )
    today = date_type.today()
    if today < season.date_from:
        position = f"starts in {(season.date_from - today).days} days"
    elif today > season.date_to:
        position = f"ended {(today - season.date_to).days} days ago"
    else:
        position = f"week {(today - season.date_from).days // 7 + 1}"
    return (
        f"CURRENT SEASON: {season.name} | {season.date_from} to {season.date_to} | {position}. "
        "History before the start remains useful background. For current attendance, a missing "
        "register is unknown, not an absence; only judge a pattern from recorded opportunities."
    )


def get_system_prompt(
    db: DBSession,
    extra: str = "",
    include_squad_snapshot: bool = True,
    include_recent_sessions: bool = True,
    include_active_notes: bool = True,
    include_approaching_targets: bool = True,
    full_coaching_context: bool = False,
) -> str:
    """Build the full system prompt: base identity + coaching context + squad snapshot + recent sessions + active coaching notes."""
    from datetime import date as date_type
    profile = (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )
    parts = [BASE_SYSTEM, f"---\n{_current_season_prompt_context(db)}"]
    terminology = coach_terminology_context(db)
    if terminology:
        parts.append(f"---\n{terminology}")
    if profile:
        coaching_context = _coaching_context_for_prompt(
            profile,
            full=full_coaching_context,
        )
        if coaching_context:
            parts.append(f"---\nCOACHING CONTEXT:\n{coaching_context}")

    if include_squad_snapshot:
        squad_snap = build_squad_snapshot(db)
        if squad_snap:
            parts.append(f"---\n{squad_snap}")

    if include_recent_sessions:
        sessions_snap = build_recent_sessions_summary(db)
        if sessions_snap:
            parts.append(f"---\n{sessions_snap}")

    # Active coaching notes — temporary plans pinned to date ranges
    today = date_type.today()
    active_notes = []
    if include_active_notes:
        active_notes = (
            db.query(models.CoachingNote)
            .filter(
                models.CoachingNote.active == True,
                models.CoachingNote.date_to >= today,
            )
            .order_by(models.CoachingNote.date_from)
            .limit(12)
            .all()
        )
    if active_notes:
        note_lines = ["ACTIVE COACHING NOTES (temporary plans — do not treat as permanent profile data):"]
        for n in active_notes:
            swimmers_str = f" [{', '.join(n.swimmer_names)}]" if n.swimmer_names else ""
            note_lines.append(f"\n[{n.title}{swimmers_str} | {n.date_from} to {n.date_to}]\n{n.body[:1200]}")
        parts.append("---\n" + "\n".join(note_lines))

    # Approaching swimmer targets — surface any unachieved targets with deadlines in the next 8 weeks
    if include_approaching_targets:
        approaching_targets = _build_approaching_targets(db, today)
        if approaching_targets:
            parts.append(f"---\n{approaching_targets}")

    if extra:
        parts.append(f"---\n{extra}")
    return "\n\n".join(parts)


SEASON_PLAN_BASE = """You are a specialist season planning assistant for competitive swimming. Your role is different from the poolside coaching assistant — you are here to help the coach build and refine the season's training structure from the top down.

You work through a hierarchy:
  MACRO (season arc, 9-12 months) → MESO (training blocks, 3-6 weeks each) → MICRO (weekly session sequence)

Session writing is NOT done here. If the coach asks to write a specific session, direct them to the main coaching chat or the Calendar. Your job is the structure above that.

HOW TO WORK:
- Be progressive. Build the macro first, then drill into mesos, then micros.
- At each level, ask what you need before proposing — especially about key competitions and how the block before went.
- When a level is agreed, confirm it before moving down. "Happy with that macro structure? I'll now plan the first block."
- Reference what was already decided in this conversation. If the macro has been agreed, the mesos must fit inside it.
- Keep replies planning-focused and strategic. No poolside-style responses.

WHAT YOU CAN DO:
- Plan the macro (full season arc)
- Plan individual meso blocks within the macro
- Plan micro cycles (weekly session sequences) within a meso
- Suggest group composition
- Adjust any level based on coach feedback

WHAT YOU CANNOT DO (redirect to main chat):
- Write specific session sets
- Log observations or benchmark times
- Answer questions about individual swimmers' form or technique today

Always show where you are in the hierarchy. If you're planning a meso, say which macro phase it sits in. If you're planning a micro, say which week of which meso."""


def get_season_plan_system_prompt(db: DBSession, macro_id: int = None) -> str:
    """Build the system prompt for a season planning thread — includes macro/meso context."""
    from datetime import date as date_type
    parts = [SEASON_PLAN_BASE, f"---\n{_current_season_prompt_context(db)}"]
    terminology = coach_terminology_context(db)
    if terminology:
        parts.append(f"---\n{terminology}")

    # Coaching philosophy
    profile = (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )
    if profile and profile.summary:
        parts.append(f"---\nCOACHING CONTEXT:\n{_coaching_context_for_prompt(profile, full=True)}")

    # Current macro and its phases
    today = date_type.today()
    macro = None
    if macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        macro = db.query(models.TrainingMacro).filter(
            models.TrainingMacro.date_from <= today,
            models.TrainingMacro.date_to >= today,
        ).order_by(models.TrainingMacro.date_from).first()

    if macro:
        macro_lines = [f"CURRENT MACRO: {macro.name} | {macro.date_from} to {macro.date_to}"]
        if macro.narrative:
            macro_lines.append(f"Season narrative: {macro.narrative[:400]}")
        if macro.group_definitions:
            macro_lines.append("Groups:")
            for g_label, defn in macro.group_definitions.items():
                desc = defn.get("description", "") if isinstance(defn, dict) else str(defn)
                macro_lines.append(f"  {g_label}: {desc}")

        mesos = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.macro_id == macro.id
        ).order_by(models.SeasonBlock.date_from).all()

        if mesos:
            macro_lines.append("Phases in this macro:")
            for m in mesos:
                weeks = max(1, round((m.date_to - m.date_from).days / 7))
                status = "CURRENT" if m.date_from <= today <= m.date_to else ("PAST" if m.date_to < today else "FUTURE")
                macro_lines.append(f"  [{status}] {m.phase_type or '?'} — {m.name} | {m.date_from} to {m.date_to} ({weeks}w)")
        else:
            macro_lines.append("No phases planned yet in this macro.")

        parts.append("---\n" + "\n".join(macro_lines))

    # Upcoming meets (next 52 weeks)
    from datetime import timedelta
    cutoff = today + timedelta(weeks=52)
    meets = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= cutoff,
    ).order_by(models.Meet.date).limit(30).all()

    if meets:
        meet_lines = ["KEY COMPETITIONS (next 12 months — the macro must be built around these):"]
        for m in meets:
            weeks_out = (m.date - today).days // 7
            priority = f" | Priority: {m.level}" if m.level else ""
            meet_lines.append(f"  {m.date} ({weeks_out}w out): {m.name}{priority}")
        parts.append("---\n" + "\n".join(meet_lines))

    return "\n\n".join(parts)


ATHLETE_PLAN_BASE = """You are the athlete development assistant for a competitive swimming club. Your focus is on individual swimmer development, adaptation, and readiness — helping the coach think through decisions about specific athletes.

YOUR FOCUS:
- Individual swimmer development pathways and training response
- Readiness for competition or increased load
- Group placement decisions and rationale
- Event selection and target-setting for specific swimmers
- Recognising who needs more attention, a load change, or a different approach
- Patterns across the squad — who is thriving, who is plateauing, who might be at risk

THIS IS NOT FOR:
- Writing session sets (use the main chat for that)
- Building the season macro/meso/micro structure (use the season planning thread for that)

HOW TO WORK:
- When the coach mentions a swimmer by name, draw on everything you know about them — profile, recent times, recent sessions, targets
- Ask targeted questions to fill gaps. The coach's eye is the primary signal — data gives context, not the verdict
- Think in terms of individual athlete context: training age, developmental stage, event profile, and what the last block has shown
- Be specific. "Their aerobic markers are plateauing over the last 6 weeks despite consistent attendance" beats "they seem to be doing okay"

CRITICAL: You cannot reliably judge adaptation from times alone. A swimmer may be mid-adaptation, de-loading, or peaking early. Always ask what the coach is observing at the pool before drawing conclusions."""


def get_athlete_plan_system_prompt(db: DBSession) -> str:
    """Build the system prompt for an athlete planning thread."""
    from datetime import date as date_type, timedelta
    parts = [ATHLETE_PLAN_BASE, f"---\n{_current_season_prompt_context(db)}"]
    terminology = coach_terminology_context(db)
    if terminology:
        parts.append(f"---\n{terminology}")

    # Coaching philosophy
    profile = (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )
    if profile and profile.summary:
        parts.append(f"---\nCOACHING CONTEXT:\n{_coaching_context_for_prompt(profile)}")

    # Current macro + phase (brief context)
    today = date_type.today()
    macro = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_from <= today,
        models.TrainingMacro.date_to >= today,
    ).order_by(models.TrainingMacro.date_from).first()

    if macro:
        lines = [f"CURRENT MACRO: {macro.name} | {macro.date_from} to {macro.date_to}"]
        if macro.group_definitions:
            lines.append("Groups:")
            for g_label, defn in macro.group_definitions.items():
                desc = defn.get("description", "") if isinstance(defn, dict) else str(defn)
                lines.append(f"  {g_label}: {desc}")
        current_meso = db.query(models.SeasonBlock).filter(
            models.SeasonBlock.macro_id == macro.id,
            models.SeasonBlock.date_from <= today,
            models.SeasonBlock.date_to >= today,
        ).first()
        if current_meso:
            weeks_in = max(1, round((today - current_meso.date_from).days / 7))
            total_weeks = max(1, round((current_meso.date_to - current_meso.date_from).days / 7))
            lines.append(f"Current phase: {current_meso.phase_type or '?'} — {current_meso.name} (week {weeks_in} of {total_weeks})")
        parts.append("---\n" + "\n".join(lines))

    # Upcoming meets (next 8 weeks)
    eight_weeks_ahead = today + timedelta(weeks=8)
    meets = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= eight_weeks_ahead,
    ).order_by(models.Meet.date).all()
    if meets:
        meet_lines = ["UPCOMING MEETS:"]
        for m in meets:
            days = (m.date - today).days
            meet_lines.append(f"  {m.name} — {m.date} ({days}d)")
        parts.append("---\n" + "\n".join(meet_lines))

    # Planning cohorts — shared development goals
    cohorts = db.query(models.PlanningCohort).order_by(models.PlanningCohort.name).all()
    if cohorts:
        active_swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
        swimmer_map = {s.id: s for s in active_swimmers}
        cohort_lines = ["PLANNING COHORTS — when a swimmer is mentioned, reference their cohort goals:"]
        for c in cohorts:
            members = [s.name for s in active_swimmers if s.planning_cohort_id == c.id]
            if not members:
                continue
            cohort_lines.append(f"  {c.name}: {', '.join(members)}")
            if c.goals:
                cohort_lines.append(f"    Development goals: {c.goals}")
            if c.target_meet_ids:
                target_meets = []
                for mid in c.target_meet_ids:
                    m = db.query(models.Meet).filter(models.Meet.id == mid).first()
                    if m:
                        weeks_out = (m.date - today).days // 7 if m.date else None
                        target_meets.append(f"{m.name} ({m.date}, {weeks_out}w out)" if weeks_out else m.name)
                if target_meets:
                    cohort_lines.append(f"    Target meets: {', '.join(target_meets)}")
        if len(cohort_lines) > 1:
            parts.append("---\n" + "\n".join(cohort_lines))

    return "\n\n".join(parts)


def _build_approaching_targets(db: DBSession, today) -> str:
    """Surface unachieved swimmer targets with deadlines in the next 8 weeks."""
    from datetime import timedelta
    from sqlalchemy import desc as _desc
    cutoff = today + timedelta(weeks=8)
    targets = (
        db.query(models.SwimmerTarget)
        .filter(
            models.SwimmerTarget.achieved == False,
            models.SwimmerTarget.deadline != None,
            models.SwimmerTarget.deadline <= cutoff,
        )
        .order_by(models.SwimmerTarget.deadline)
        .all()
    )
    if not targets:
        return ""

    lines = ["APPROACHING SWIMMER TARGETS (unachieved, deadline within 8 weeks — surface these proactively):"]
    for tgt in targets:
        sw = db.query(models.Swimmer).filter(models.Swimmer.id == tgt.swimmer_id).first()
        if not sw:
            continue
        days_left = (tgt.deadline - today).days
        deadline_str = f"{tgt.deadline} ({days_left}d)"

        if tgt.target_time_seconds and tgt.distance and tgt.stroke and tgt.effort:
            bm = (
                db.query(models.BenchmarkLog)
                .filter(
                    models.BenchmarkLog.swimmer_id == tgt.swimmer_id,
                    models.BenchmarkLog.distance == tgt.distance,
                    models.BenchmarkLog.stroke == tgt.stroke,
                    models.BenchmarkLog.effort == tgt.effort,
                )
                .order_by(_desc(models.BenchmarkLog.date))
                .first()
            )
            if bm:
                gap = bm.time_seconds - tgt.target_time_seconds
                status = f"current {bm.time_seconds:.2f}s, {'+' if gap > 0 else ''}{gap:.2f}s to go"
            else:
                status = f"target {tgt.target_time_seconds:.2f}s — no benchmark recorded yet"
            lines.append(f"  {sw.name} | {tgt.label} | {status} | deadline {deadline_str}")
        else:
            desc = f" — {tgt.description[:80]}" if tgt.description else ""
            lines.append(f"  {sw.name} | {tgt.label}{desc} | deadline {deadline_str}")
    return "\n".join(lines)


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

    # Build cohort lookup
    cohorts = {c.id: c for c in db.query(models.PlanningCohort).all()}

    today = date_type.today()
    lines = [f"YOUR SQUAD ({len(swimmers)} active swimmers):"]

    for s in swimmers:
        parts = [s.name]

        # Cohort
        if s.planning_cohort_id and s.planning_cohort_id in cohorts:
            parts.append(f"[{cohorts[s.planning_cohort_id].name}]")

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

    # Cohort development goals summary
    if cohorts:
        lines.append("")
        lines.append("PLANNING COHORTS (shared development goals):")
        for cohort in cohorts.values():
            members = [s.name for s in swimmers if s.planning_cohort_id == cohort.id]
            if not members:
                continue
            lines.append(f"  {cohort.name} ({len(members)} swimmers: {', '.join(members)})")
            if cohort.goals:
                lines.append(f"    Goals: {cohort.goals[:200]}")
            if cohort.target_meet_ids:
                meet_names = []
                for mid in cohort.target_meet_ids:
                    m = db.query(models.Meet).filter(models.Meet.id == mid).first()
                    if m:
                        meet_names.append(f"{m.name} ({m.date})" if m.date else m.name)
                if meet_names:
                    lines.append(f"    Target meets: {', '.join(meet_names)}")

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
    block = build_block_status_context(swimmer, db)
    parts = [f"DETAILED PROFILE — {swimmer.name.upper()}:\n{profile}"]
    if group:
        parts.append(group)
    if block:
        parts.append(block)
    return "\n\n".join(parts)


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


def build_block_status_context(swimmer: models.Swimmer, db: DBSession) -> str:
    """
    Current meso, group assignment, group intent, and recent load trend for a swimmer.
    Appended to get_swimmer_detail so the AI can answer 'how is X doing against the plan?'
    """
    from datetime import date as date_type, timedelta
    from collections import defaultdict

    today = date_type.today()
    VOLUME_KEYS = ['aerobic', 'threshold', 'vo2', 'race_pace', 'lact_tol', 'short_race_pace', 'kicking', 'sprint']

    def iso_week(d):
        yr, wk, _ = d.isocalendar()
        return f"{yr}-W{wk:02d}"

    lines = []

    # Current meso
    current_meso = db.query(models.SeasonBlock).filter(
        models.SeasonBlock.date_from <= today,
        models.SeasonBlock.date_to >= today,
    ).order_by(models.SeasonBlock.date_from).first()

    if current_meso:
        week_in = (today - current_meso.date_from).days // 7 + 1
        total_weeks = max(1, round((current_meso.date_to - current_meso.date_from).days / 7))
        lines.append(f"Current meso: {current_meso.name} | {current_meso.phase_type or 'no phase'} | week {week_in}/{total_weeks} | {current_meso.date_from} → {current_meso.date_to}")
        if current_meso.notes:
            lines.append(f"  Meso notes: {current_meso.notes[:200]}")

        # Group assignment
        group_label = None
        if current_meso.macro_id:
            macro = db.query(models.TrainingMacro).filter(
                models.TrainingMacro.id == current_meso.macro_id
            ).first()
            if macro and macro.group_definitions:
                for g, defn in macro.group_definitions.items():
                    if swimmer.id in (defn.get("swimmer_ids") or []):
                        group_label = g
                        desc = defn.get("description", "")
                        lines.append(f"  Assigned group: {g}" + (f" ({desc})" if desc else ""))
                        break

        # Group intent for this meso
        if group_label and current_meso.group_intents:
            intent = current_meso.group_intents.get(group_label)
            if intent:
                lines.append(f"  Group intent this meso: {intent}")
    else:
        lines.append("No current meso block defined.")

    # Weekly load — last 6 weeks
    six_weeks_ago = today - timedelta(weeks=6)
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.swimmer_id == swimmer.id,
        models.SwimmerSessionLoad.session_date >= six_weeks_ago,
    ).all()

    weekly_totals: dict = defaultdict(float)
    for load in loads:
        wk = iso_week(load.session_date)
        weekly_totals[wk] += sum((load.volume_breakdown or {}).get(k, 0) for k in VOLUME_KEYS)

    # Build ordered week list (last 6 weeks)
    ordered_weeks = []
    d = six_weeks_ago
    seen = set()
    while d <= today:
        lbl = iso_week(d)
        if lbl not in seen:
            ordered_weeks.append(lbl)
            seen.add(lbl)
        d += timedelta(days=7)

    active_weeks = [(wk, weekly_totals[wk]) for wk in ordered_weeks if weekly_totals[wk] > 0]
    if active_weeks:
        week_strs = [f"{wk}: {total:.0f}m" for wk, total in active_weeks]
        lines.append(f"Weekly load (last 6 weeks): {', '.join(week_strs)}")
        if len(active_weeks) >= 2:
            last, prev = active_weeks[-1][1], active_weeks[-2][1]
            if prev > 0:
                pct = ((last - prev) / prev) * 100
                trend = f"+{pct:.0f}%" if pct > 5 else (f"{pct:.0f}%" if pct < -5 else "stable")
                lines.append(f"  Load trend (vs previous active week): {trend}")
    else:
        lines.append("No volume load data recorded in last 6 weeks.")

    return "BLOCK STATUS:\n" + "\n".join(f"  {l}" if not l.startswith("  ") else l for l in lines) if lines else ""


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
        .limit(12)
        .all()
    )
    if not meets:
        return ""

    lines = [f"UPCOMING MEETS (next {months_ahead} months):"]
    meet_ids = [m.id for m in meets]
    targets = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id.in_(meet_ids)).all()
    swimmer_ids = {target.swimmer_id for target in targets}
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.id.in_(swimmer_ids)).all() if swimmer_ids else []
    swimmer_by_id = {swimmer.id: swimmer for swimmer in swimmers}
    targets_by_meet = {}
    for target in targets:
        targets_by_meet.setdefault(target.meet_id, []).append(target)
    for m in meets:
        date_str = m.date.isoformat() if m.date else "date TBC"
        end_str = f"–{m.date_to.isoformat()}" if m.date_to else ""
        course = f" {m.course}" if m.course else ""
        level = f" [{m.level}]" if m.level else ""
        lines.append(f"  {m.name} | {date_str}{end_str}{course}{level} | {m.location or ''}")

        for session in list(m.timetable_sessions or [])[:4]:
            times = ", ".join(filter(None, [
                f"warm-up {session.warm_up_time}" if session.warm_up_time else None,
                f"start {session.start_time}" if session.start_time else None,
            ]))
            event_names = [
                (event.get("name") or str(event)) if isinstance(event, dict) else str(event)
                for event in (session.events or [])[:12]
            ]
            lines.append(f"    Session: {session.name} | {session.date or 'date TBC'}{f' | {times}' if times else ''} | {', '.join(event_names) or 'events TBC'}")

        for t in targets_by_meet.get(m.id, []):
            swimmer = swimmer_by_id.get(t.swimmer_id)
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
    Season block context (primary) or legacy periodization plans as fallback.
    Injected when planning topics detected.
    """
    from datetime import date as date_type, timedelta
    today = date_type.today()
    lines = []

    # Season blocks (primary source)
    current_block = (
        db.query(models.SeasonBlock)
        .filter(models.SeasonBlock.date_from <= today, models.SeasonBlock.date_to >= today)
        .first()
    )
    next_block = (
        db.query(models.SeasonBlock)
        .filter(models.SeasonBlock.date_from > today)
        .order_by(models.SeasonBlock.date_from)
        .first()
    )

    if current_block:
        total_days = (current_block.date_to - current_block.date_from).days + 1
        total_weeks = max(1, round(total_days / 7))
        week_in = min(total_weeks, (today - current_block.date_from).days // 7 + 1)
        lines.append(f"CURRENT TRAINING BLOCK: {current_block.name} (Week {week_in} of {total_weeks} | {current_block.date_from} – {current_block.date_to})")
        if current_block.phase_type:
            lines.append(f"  Phase: {current_block.phase_type}")
        if current_block.emphasis:
            emp_str = ", ".join(f"{k} {v}%" for k, v in current_block.emphasis.items() if v)
            lines.append(f"  Planned emphasis: {emp_str}")
        if current_block.notes:
            lines.append(f"  Notes: {current_block.notes[:120]}")

        # Actual distribution since block start
        sessions = (
            db.query(models.Session)
            .filter(
                models.Session.date >= current_block.date_from,
                models.Session.date <= today,
                models.Session.status != 'cancelled',
                models.Session.energy_system_focus.isnot(None),
            )
            .all()
        )
        if sessions:
            dist = {}
            for s in sessions:
                dist[s.energy_system_focus] = dist.get(s.energy_system_focus, 0) + 1
            total = sum(dist.values())
            dist_str = ", ".join(f"{v}x {k} ({round(v/total*100)}%)" for k, v in sorted(dist.items(), key=lambda x: -x[1]))
            lines.append(f"  Actual this block ({total} sessions): {dist_str}")

            # Flag gaps vs planned
            if current_block.emphasis:
                gaps = []
                for focus, planned in current_block.emphasis.items():
                    actual_pct = round(dist.get(focus, 0) / total * 100) if total else 0
                    diff = actual_pct - planned
                    if diff <= -15:
                        gaps.append(f"{focus} is UNDER-represented ({actual_pct}% actual vs {planned}% planned)")
                    elif diff >= 15:
                        gaps.append(f"{focus} is OVER-represented ({actual_pct}% actual vs {planned}% planned)")
                if gaps:
                    lines.append(f"  Block alignment gaps: {'; '.join(gaps)}")

        # Active coaching intents in this block
        intents = (
            db.query(models.SwimmerObservation)
            .filter(
                models.SwimmerObservation.obs_type == 'coaching_intent',
                models.SwimmerObservation.date >= current_block.date_from,
            )
            .order_by(models.SwimmerObservation.date.desc())
            .limit(10)
            .all()
        )
        if intents:
            lines.append("  Active swimmer intents this block:")
            for i in intents:
                swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == i.swimmer_id).first()
                name = swimmer.name if swimmer else "?"
                lines.append(f"    {name}: {i.content[:100]}")

    if next_block:
        weeks_away = (next_block.date_from - today).days // 7
        lines.append(f"NEXT BLOCK: {next_block.name} starts {next_block.date_from} ({weeks_away}w away)")

    # Upcoming meets (next 8 weeks)
    upcoming = (
        db.query(models.Meet)
        .filter(models.Meet.date >= today, models.Meet.date <= today + timedelta(weeks=8))
        .order_by(models.Meet.date)
        .limit(6)
        .all()
    )
    if upcoming:
        lines.append("UPCOMING MEETS (8 weeks):")
        for m in upcoming:
            targets = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id == m.id).all()
            a_swimmers = [t for t in targets if t.priority == 'A']
            swimmer_names = []
            for t in a_swimmers[:4]:
                s = db.query(models.Swimmer).filter(models.Swimmer.id == t.swimmer_id).first()
                if s:
                    swimmer_names.append(s.name.split()[0])
            a_str = f" | A targets: {', '.join(swimmer_names)}" if swimmer_names else ""
            course = f" ({m.course})" if m.course else ""
            lines.append(f"  {m.date} | {m.name}{course}{a_str}")

    # Fall back to old periodization plans if no season blocks defined
    if not current_block and not next_block:
        recent = today - timedelta(days=14)
        plans = (
            db.query(models.PeriodizationPlan)
            .join(models.Swimmer)
            .filter(models.Swimmer.status == 'active', models.PeriodizationPlan.date_to >= recent)
            .order_by(models.PeriodizationPlan.plan_type, models.PeriodizationPlan.date_from)
            .all()
        )
        if plans:
            lines.append("PERIODIZATION PLANS (active/recent):")
            for p in plans:
                swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == p.swimmer_id).first()
                if not swimmer:
                    continue
                date_range = f"{p.date_from} – {p.date_to}" if p.date_from and p.date_to else ""
                focus = f" | focus: {p.focus[:80]}" if p.focus else ""
                lines.append(f"  {swimmer.name} | {p.plan_type} | {date_range}{focus}")

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

        # Usual timetable assignments for this slot. These are not attendance.
        swimmer_links = (
            db.query(models.SwimmerSlot)
            .filter(models.SwimmerSlot.pool_slot_id == slot.id)
            .all()
        )
        swimmer_ids = [l.swimmer_id for l in swimmer_links]
        if not swimmer_ids:
            lines.append("  No usual swimmer assignments are configured for this slot.")
            continue

        swimmers = (
            db.query(models.Swimmer)
            .filter(models.Swimmer.id.in_(swimmer_ids), models.Swimmer.status == 'active')
            .order_by(models.Swimmer.name)
            .all()
        )
        lines.append(f"  Usual slot assignments ({len(swimmers)}; planning hint only, not attendance):")

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
            register_count = db.query(models.SessionEntry).filter(
                models.SessionEntry.session_id == s.id,
            ).count()
            register_state = (
                f"REGISTER SUBMITTED ({register_count} swimmers marked)"
                if register_count
                else "NO REGISTER SUBMITTED — do not infer attendance"
            )
            lines.append(f"  {s.date} | {s.title or 'Session'}{focus}{intent} | {register_state}")

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
    # For each usually assigned swimmer, count only explicitly registered attendance by focus type
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
        'goal time', 'aim for', 'target is', 'target time', 'needs to hit',
    ]) or re.search(r'\b(?:set|add|create|give)\b.{0,60}\btarget\b', full):
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
  "intent": one of ["session_writing","meet_creation","season_plan","coaching_intent","status_change","general"],
  "swimmer_name": "first name only, or null if squad-wide discussion",
  "confidence": "high" or "low",
  "suggested_action": "short label e.g. 'Create this session' — or null if general chat or low confidence",
  "new_status": "sabbatical, injury, or active — only set when intent is status_change, otherwise null"
}}

Rules:
- session_writing: actively designing/writing a specific training session (groups, sets, structure) — suggested_action should be "Create this session"
- meet_creation: adding a new competition meet with swimmer entries and events — suggested_action should be "Create this meet"
- season_plan: discussing macro/meso structure, annual planning
- coaching_intent: coach has stated a training direction or priority for a swimmer (e.g. "needs more aerobic work", "should focus on X this block") and the conversation has examined and refined it — suggested_action should be "Save intent to [swimmer name]'s profile"
- status_change: coach is changing a swimmer's status — sabbatical (taking a break from swimming), injury (injured/unable to train), or returning to active — suggested_action should be "Mark [swimmer name] as sabbatical" / "Mark [swimmer name] as injured" / "Mark [swimmer name] as active"
- general: everything else — profile discussions, coaching science, analysis, planning conversations
- Only return high confidence if the conversation has clearly been building something concrete
- For session_writing, return high confidence once the session structure/groups/sets have been discussed
- For meet_creation, return high confidence once meet name/date and at least one swimmer's events have been confirmed
- For coaching_intent, return high confidence only after the intent has been discussed (not just first stated) — there should be some back-and-forth
- For status_change, return high confidence as soon as the coach clearly states the swimmer is going on sabbatical, is injured, or is returning — no back-and-forth needed
- Return null for suggested_action if intent is general or confidence is low"""

    response = get_client().messages.create(
        model=FAST_MODEL,
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
            "new_status": data.get("new_status") if data.get("intent") == "status_change" else None,
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
    current_season = db.query(models.Season).filter(
        models.Season.is_current.is_(True),
    ).order_by(models.Season.date_from.desc()).first()
    monitoring_start = max(four_weeks_ago, current_season.date_from) if current_season else four_weeks_ago

    # All-time
    all_rows = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer_id,
            models.SessionEntry.attended.is_not(None),
            models.Session.status != 'cancelled',
        )
        .all()
    )
    if all_rows:
        all_start = min(session.date for _, session in all_rows)
        all_end = max(session.date for _, session in all_rows)
        excused_ranges = availability_ranges(db, [swimmer_id], all_start, all_end)
    else:
        excused_ranges = {}

    def counts_as_opportunity(entry, session):
        return bool(entry.attended) or not is_excused(excused_ranges, swimmer_id, session.date)

    countable_all = [row for row in all_rows if counts_as_opportunity(*row)]
    all_total = len(countable_all)
    all_attended = sum(1 for entry, _ in countable_all if entry.attended)
    all_excused = len(all_rows) - all_total
    overall_pct = round(all_attended / all_total * 100) if all_total else None

    # Last 4 weeks
    recent_entries = []
    if current_season and current_season.date_from <= today <= current_season.date_to:
        recent_entries = (
            db.query(models.SessionEntry, models.Session)
            .join(models.Session, models.SessionEntry.session_id == models.Session.id)
            .filter(
                models.SessionEntry.swimmer_id == swimmer_id,
                models.SessionEntry.attended.is_not(None),
                models.Session.date >= monitoring_start,
                models.Session.date <= today,
                models.Session.status != 'cancelled',
            )
            .all()
        )
    countable_recent = [row for row in recent_entries if counts_as_opportunity(*row)]
    four_week_total = len(countable_recent)
    four_week_attended = sum(1 for e, _ in countable_recent if e.attended)
    four_week_excused = len(recent_entries) - four_week_total
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
            db.query(models.SessionEntry, models.Session)
            .join(models.Session, models.SessionEntry.session_id == models.Session.id)
            .filter(
                models.SessionEntry.swimmer_id == swimmer_id,
                models.SessionEntry.session_id.in_(session_ids),
                models.SessionEntry.attended.is_not(None),
            )
            .all()
        )
        if not slot_entries:
            continue
        countable_slot = [row for row in slot_entries if counts_as_opportunity(*row)]
        if not countable_slot:
            continue
        slot_attended = sum(1 for e, _ in countable_slot if e.attended)
        per_slot[label] = {
            "attended": slot_attended,
            "total": len(countable_slot),
            "excused": len(slot_entries) - len(countable_slot),
            "pct": round(slot_attended / len(countable_slot) * 100),
        }

    # Weekly breakdown — last 8 weeks
    eight_weeks_ago = today - timedelta(weeks=8)
    weekly_start = max(eight_weeks_ago, current_season.date_from) if current_season else eight_weeks_ago
    weekly_rows = []
    if current_season and current_season.date_from <= today <= current_season.date_to:
        weekly_rows = (
            db.query(models.SessionEntry, models.Session)
            .join(models.Session, models.SessionEntry.session_id == models.Session.id)
            .filter(
                models.SessionEntry.swimmer_id == swimmer_id,
                models.SessionEntry.attended.is_not(None),
                models.Session.date >= weekly_start,
                models.Session.date <= today,
                models.Session.status != 'cancelled',
            )
            .all()
        )
    week_map: dict = {}
    for entry, session in weekly_rows:
        iso = session.date.isocalendar()
        key = f"{iso[0]}-W{iso[1]:02d}"
        if key not in week_map:
            week_map[key] = {"week": key, "attended": 0, "total": 0, "excused": 0}
        if not counts_as_opportunity(entry, session):
            week_map[key]["excused"] += 1
            continue
        week_map[key]["total"] += 1
        if entry.attended:
            week_map[key]["attended"] += 1
    weekly = sorted(week_map.values(), key=lambda x: x["week"])

    return {
        "overall_pct": overall_pct,
        "overall_attended": all_attended,
        "overall_total": all_total,
        "overall_excused": all_excused,
        "four_week_pct": four_week_pct,
        "four_week_attended": four_week_attended,
        "four_week_total": four_week_total,
        "four_week_excused": four_week_excused,
        "attendance_state": (
            "season_not_started" if not current_season or today < current_season.date_from
            else "season_ended" if today > current_season.date_to
            else "building_baseline" if four_week_total < 4
            else "established"
        ),
        "monitoring_start": monitoring_start.isoformat(),
        "current_season": current_season.name if current_season else None,
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

def extract_benchmark_items_from_conversation(conversation: str, swimmers: list) -> list:
    """
    Parse a coaching conversation into benchmark/target drafts without saving.
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
            model=FAST_MODEL,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = _strip_json(response.content[0].text.strip())
        items = json.loads(raw)
    except Exception:
        return []

    return items if isinstance(items, list) else []


def extract_benchmarks_from_conversation(conversation: str, swimmers: list, db: DBSession) -> list:
    """Extract and save confirmed observed benchmarks; formal targets use review first."""
    items = extract_benchmark_items_from_conversation(conversation, swimmers)
    today = date.today().isoformat()

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
            model=FAST_MODEL,
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
        model=FAST_MODEL,
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
        model=FAST_MODEL,
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

    from backend.services.cycle_codes import cycle_context
    cycle = cycle_context(session)
    cycle_line = "Not linked to a planned cycle"
    if cycle:
        hierarchy = " > ".join(filter(None, [
            cycle.get("macrocycle_name"), cycle.get("mesocycle_name"), cycle.get("microcycle_label"),
        ]))
        cycle_line = f"{cycle.get('code') or 'linked'} | {hierarchy} | phase: {cycle.get('phase_type') or 'unspecified'}"

    session_desc = session.title or f"Session on {session.date}"
    group_content = ""
    if session.planned_content and entry.group_done:
        group_key = str(entry.group_done)
        group_data = session.planned_content.get(group_key, {})
        group_content = group_data.get("sets", "") if isinstance(group_data, dict) else str(group_data)

    prompt = f"""{swimmer_ctx}

SESSION: {session_desc} ({session.date})
Cycle position: {cycle_line}
Coach intent: {session.coach_intent or 'Not specified'}
Energy system focus: {session.energy_system_focus or 'Not specified'}
Group done: {entry.group_done or 'Not specified'}
Session content (this group):
{group_content or 'Not available'}

Coach observation: {entry.coach_observation or 'No observation recorded'}

Characterise this swimmer's response to this session."""

    response = get_client().messages.create(
        model=FAST_MODEL,
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
        effort=PLANNING_EFFORT,
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

def _build_swimmer_brief(swimmer: models.Swimmer, db: DBSession, target_date=None) -> str:
    """Lightweight per-swimmer summary for pre-session planning."""
    from datetime import date as date_type
    from sqlalchemy import or_

    lines = [f"{swimmer.name}"]

    if swimmer.status != 'active':
        lines.append(f"  ⚠ Status: {swimmer.status.upper()}")

    planning_date = target_date or date_type.today()
    active_load = (
        db.query(models.SwimmerLoadEvent)
        .filter(
            models.SwimmerLoadEvent.swimmer_id == swimmer.id,
            models.SwimmerLoadEvent.date_from <= planning_date,
            or_(models.SwimmerLoadEvent.date_to == None, models.SwimmerLoadEvent.date_to >= planning_date),
        )
        .all()
    )
    for ev in active_load:
        lines.append(f"  ⚠ {ev.event_type}: {ev.description or ''}")

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
    planning_date = None
    if date_str:
        try:
            planning_date = date.fromisoformat(date_str)
        except ValueError:
            pass

    swimmer_briefs = []
    for sw_info in expected_swimmers:
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == sw_info["id"]).first()
        if swimmer:
            swimmer_briefs.append(_build_swimmer_brief(swimmer, db, planning_date))

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
    "coach_intent": "one sentence describing the purpose of the session",
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
- The coach may provide a rough idea rather than a written programme. Fill in sensible distances,
  repetitions, recoveries and send-offs so the result is usable, and state material assumptions.
- If the coach provides a complete programme, including text extracted from a photo, preserve its
  distances, repetitions, recoveries and send-offs exactly; structure it without substituting content.
- Warm-up and cool-down are optional. Use null when the session is intentionally one continuous or
  progressive main set; do not force classic section headings onto it.
- Return only the meaningful groups the coach described or that the expected swimmers genuinely need,
  with a maximum of three. Do not manufacture extra groups just to fill the schema.
- If no expected swimmers, return per_swimmer as an empty array.
- Do not include markdown in set descriptions — plain text only.
- Keep set descriptions concise but complete (e.g. "6x400 on 5:30, threshold pace").
"""

    response = get_client().messages.create(
        model=FAST_MODEL,
        max_tokens=1800,
        timeout=35.0,
        system=get_system_prompt(db),
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response_text(response)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.rstrip("`").strip()

    result = json.loads(raw)
    if not isinstance(result, dict) or not isinstance(result.get("parsed"), dict):
        raise ValueError("The session planner returned an invalid plan.")

    parsed = result["parsed"]
    cleaned_groups = {}
    for key, group in list((parsed.get("groups") or {}).items())[:3]:
        if not isinstance(group, dict):
            continue
        sets = group.get("sets") or []
        if isinstance(sets, str):
            sets = [line.strip() for line in sets.splitlines() if line.strip()]
        else:
            sets = [str(line).strip() for line in sets if str(line).strip()]
        if sets:
            cleaned_groups[str(key)] = {
                "label": str(group.get("label") or f"Group {key}").strip(),
                "sets": sets,
            }
    if not cleaned_groups:
        cleaned_groups["1"] = {"label": "Session", "sets": [session_text]}
    parsed["groups"] = cleaned_groups
    result["per_swimmer"] = result.get("per_swimmer") if isinstance(result.get("per_swimmer"), list) else []
    return result


# ---------------------------------------------------------------------------
# Profile Wizard — structured biological interview
# ---------------------------------------------------------------------------

WIZARD_SYSTEM = """You are running a structured biological profiling interview for a swimming coach.

Your job is to build a deep, evidence-based biological profile of a swimmer by asking targeted questions and interpreting the coach's responses alongside the swimmer's times data.

The profile you build must be useful for:
- Session and season planning (what training will work for this swimmer)
- Group allocation decisions (Group 1/2/3 split)
- Understanding how this swimmer will respond to different stimuli

Foundation areas to cover across the conversation:
1. AEROBIC BASE — how well the swimmer holds pace over distance, how quickly they fatigue in longer sets, what the coach sees in aerobic-dominant sessions
2. SPRINT / POWER PROFILE — alactic power, max speed, top-end speed quality, 15m burst vs 50m held speed
3. RACE PATTERNS — split tendency (positive/negative/even), where they fade, how they respond to race stress
4. FATIGUE & RECOVERY — how long they need between hard efforts, how they look at the end of a hard week, recovery between sessions
5. TRAINING RESPONSE — what types of training they seem to respond well to, what doesn't seem to work, any notable adaptation patterns the coach has observed
6. MOTIVATION — what engages them, what reduces engagement, and whether motivation is mainly intrinsic or external
7. COMPETITION MINDSET — how they respond to pressure, expectations, nerves, setbacks, and success
8. HARD-TRAINING MINDSET — what happens psychologically in difficult sets and what support helps
9. COACHABILITY — how they receive, understand, retain, and act on feedback

Rules:
- Ask one focused area at a time. Don't fire a list of questions.
- Reference the times data when you have it — e.g. "I can see their 200 times have plateaued while their 100 has improved — what do you notice about their endurance in training?"
- Build on what the coach says — ask follow-up questions to get specifics, not generic answers.
- When you have enough on an area, move to the next one naturally.
- Be professional and direct — coaching partner tone, not chatbot.
- When you've covered all nine areas, briefly name any area that still lacks evidence. Once all nine have useful evidence, tell the coach the foundation is complete and prompt them to save.
- If the supplied foundation progress says nothing is missing, treat this as a review: ask what has changed or what the coach wants to correct, rather than restarting the full interview.

Open the conversation with a brief intro and your first targeted question — using the swimmer's times data to frame it."""


def _build_wizard_times_summary(swimmer: models.Swimmer, db: DBSession) -> str:
    """Compact times summary for the wizard — best time per event with trend indicator."""
    from datetime import date, timedelta
    one_year_ago = date.today() - timedelta(days=365)

    all_times = (
        db.query(models.SwimTime)
        .filter(models.SwimTime.swimmer_id == swimmer.id)
        .order_by(models.SwimTime.event, models.SwimTime.date.asc())
        .all()
    )
    if not all_times:
        return "No times on record."

    by_event: dict = {}
    for t in all_times:
        by_event.setdefault(t.event, []).append(t)

    lines = []
    for event, entries in sorted(by_event.items()):
        best = min(entries, key=lambda x: x.time_seconds)
        recent = [t for t in entries if t.date and t.date >= one_year_ago]
        older  = [t for t in entries if not t.date or t.date < one_year_ago]
        if recent and older:
            r_best = min(recent, key=lambda x: x.time_seconds).time_seconds
            o_best = min(older,  key=lambda x: x.time_seconds).time_seconds
            delta_pct = (o_best - r_best) / o_best * 100
            trend = f"+{delta_pct:.1f}% improving" if delta_pct > 1.5 else (f"{delta_pct:.1f}% declining" if delta_pct < -1.0 else "stable")
        elif recent and not older:
            trend = "new (<12mo)"
        else:
            trend = "no recent data"
        lines.append(f"  {event}: best {_format_time(best.time_seconds)} ({best.date}) — {trend}")

    return "\n".join(lines)


def build_foundation_interview_context(swimmer: models.Swimmer, db: DBSession) -> dict:
    """Return compact live evidence for a tailored foundation interview."""
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(models.SwimmerProfileVersion.swimmer_id == swimmer.id)
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    latest_profiles = {}
    for version in versions:
        if version.profile_type not in latest_profiles:
            latest_profiles[version.profile_type] = {
                "data": version.data,
                "change_summary": version.change_summary,
                "created_at": version.created_at.isoformat() if version.created_at else None,
            }
    profile_types = {version.profile_type for version in versions}
    status = build_profile_status(swimmer, profile_types)
    observations = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.swimmer_id == swimmer.id)
        .order_by(models.SwimmerObservation.date.desc(), models.SwimmerObservation.created_at.desc())
        .limit(12)
        .all()
    )
    session_entries = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id == swimmer.id,
            models.SessionEntry.attended.is_(True),
            models.SessionEntry.coach_observation.isnot(None),
        )
        .order_by(models.Session.date.desc())
        .limit(8)
        .all()
    )
    histories = (
        db.query(models.TrainingHistoryNarrative)
        .filter(models.TrainingHistoryNarrative.swimmer_id == swimmer.id)
        .order_by(models.TrainingHistoryNarrative.created_at.desc())
        .limit(3)
        .all()
    )
    return {
        "as_of": date.today().isoformat(),
        "swimmer": {
            "id": swimmer.id,
            "name": swimmer.name,
            "dob": swimmer.dob.isoformat() if swimmer.dob else None,
            "age_group": models.get_age_group(swimmer.dob),
            "gender": swimmer.gender,
            "squad": swimmer.squad,
            "target_events": swimmer.target_events or [],
            "strengths": swimmer.strengths,
            "development_areas": swimmer.weaknesses,
            "profile_notes": swimmer.profile_notes,
        },
        "foundation": {
            "physical": swimmer.physical_profile or {},
            "psychological": swimmer.psychological_profile or {},
            "coverage": status,
        },
        "living_profiles": latest_profiles,
        "times_summary": _build_wizard_times_summary(swimmer, db),
        "recent_observations": [
            {
                "date": row.date.isoformat() if row.date else None,
                "type": row.obs_type,
                "event": row.event,
                "content": row.content,
            }
            for row in observations
        ],
        "recent_session_observations": [
            {
                "date": session.date.isoformat(),
                "session": session.title,
                "cycle_code": session.cycle_code,
                "energy_focus": session.energy_system_focus,
                "group_done": entry.group_done,
                "observation": entry.coach_observation,
            }
            for entry, session in session_entries
        ],
        "training_history": [
            {"source": row.source, "narrative": row.narrative}
            for row in histories
        ],
    }


_QUESTION_STOPWORDS = {
    "a", "about", "and", "are", "as", "at", "be", "before", "do", "does",
    "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that",
    "the", "their", "them", "they", "this", "to", "what", "when", "which",
    "with", "you", "your",
}


def _question_terms(value: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9]+", value.casefold())
        if len(token) > 2 and token not in _QUESTION_STOPWORDS
    }


def _repeats_prior_question(reply: str, prior_questions: list[str]) -> bool:
    new_questions = re.findall(r"[^?]*\?", reply or "")
    for question in new_questions:
        new_terms = _question_terms(question)
        if len(new_terms) < 3:
            continue
        for prior in prior_questions:
            prior_terms = _question_terms(prior)
            if len(prior_terms) < 3:
                continue
            overlap = len(new_terms & prior_terms) / min(len(new_terms), len(prior_terms))
            if overlap >= 0.72:
                return True
    return False


def wizard_chat(
    swimmer: models.Swimmer,
    messages: list[dict],
    db: DBSession,
) -> str:
    """
    Stateless wizard chat. Takes full message history, returns next AI message.
    If messages is empty, generates the opening question.
    """
    context = build_foundation_interview_context(swimmer, db)
    foundation_status = context["foundation"]["coverage"]
    completed_areas = ", ".join(
        area["label"] for area in foundation_status["areas"] if area["complete"]
    ) or "none"
    missing_areas = ", ".join(foundation_status["missing_areas"]) or "none"

    prior_questions = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for sentence in re.findall(r"[^?]*\?", str(message.get("content") or "")):
            cleaned = " ".join(sentence.split()).strip()
            if cleaned:
                prior_questions.append(cleaned[-320:])

    swimmer_intro = f"""SWIMMER-SPECIFIC EVIDENCE:
{json.dumps(context, ensure_ascii=False)}

STORED FOUNDATION PROGRESS BEFORE THIS INTERVIEW:
Already covered: {completed_areas}
Still missing: {missing_areas}
Substantive coach answers in the current conversation also count as covered even though they are not yet stored.

QUESTIONS ALREADY ASKED IN THIS INTERVIEW:
{json.dumps(prior_questions[-12:], ensure_ascii=False)}

INTERVIEW CONTROL:
- Before replying, privately build a nine-area coverage ledger from stored evidence plus the conversation.
- Do not ask a question that is semantically equivalent to anything in QUESTIONS ALREADY ASKED.
- Select the next missing or ambiguous area; if the coach just gave a broad answer, ask one concrete follow-up before moving on.
- Make the question recognisably about {swimmer.name}: anchor it to one supplied target event, time trend, coach observation, profile fact or prior answer when relevant evidence exists.
- Never use another swimmer's pattern as a template and never infer psychological traits from times.
- Ask one question at a time. State briefly why this particular missing detail matters for coaching {swimmer.name}.
- If all nine areas are covered, stop interviewing, summarise the remaining uncertainty, and invite the coach to save."""

    system = f"{WIZARD_SYSTEM}\n\n---\n{swimmer_intro}"

    if not messages:
        api_messages = [{"role": "user", "content": "(Start the profiling interview.)"}]
    else:
        api_messages = messages

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=800,
        system=system,
        messages=api_messages,
    )
    reply = response.content[0].text.strip()
    if prior_questions and _repeats_prior_question(reply, prior_questions):
        correction = get_client().messages.create(
            model=MODEL,
            max_tokens=800,
            system=system,
            messages=[
                *api_messages,
                {"role": "assistant", "content": reply},
                {"role": "user", "content": (
                    "That draft repeats an earlier question. Choose a different missing or ambiguous "
                    "foundation area, anchor it to different evidence for this swimmer, and ask one question only."
                )},
            ],
        )
        reply = correction.content[0].text.strip()
    return reply


FOUNDATION_DRAFT_FIELDS = {
    "physical": (
        "aerobic_base",
        "sprint_tendency",
        "race_pattern",
        "fatigue_profile",
        "training_response",
    ),
    "psychological": (
        "motivation_style",
        "competition_response",
        "response_to_hard_training",
        "coachability",
    ),
}


def draft_foundation_from_existing_evidence(
    swimmer: models.Swimmer,
    db: DBSession,
) -> dict:
    """Copy directly matching stored profile fields into a review-only foundation draft.

    This deliberately performs no model call. It carries forward existing text
    without asking an AI to reinterpret broad summaries as narrower athlete facts.
    """
    versions = (
        db.query(models.SwimmerProfileVersion)
        .filter(models.SwimmerProfileVersion.swimmer_id == swimmer.id)
        .order_by(models.SwimmerProfileVersion.created_at.desc())
        .all()
    )
    latest_profiles = {}
    for version in versions:
        if version.profile_type not in latest_profiles:
            latest_profiles[version.profile_type] = version

    observations = (
        db.query(models.SwimmerObservation)
        .filter(models.SwimmerObservation.swimmer_id == swimmer.id)
        .order_by(models.SwimmerObservation.date.desc(), models.SwimmerObservation.created_at.desc())
        .limit(40)
        .all()
    )
    coaching_notes = [
        note for note in db.query(models.CoachingNote).filter(models.CoachingNote.active.is_(True)).all()
        if swimmer.id in (note.swimmer_ids or [])
    ]
    histories = (
        db.query(models.TrainingHistoryNarrative)
        .filter(models.TrainingHistoryNarrative.swimmer_id == swimmer.id)
        .order_by(models.TrainingHistoryNarrative.created_at.desc())
        .limit(5)
        .all()
    )

    existing_physical = swimmer.physical_profile if isinstance(swimmer.physical_profile, dict) else {}
    existing_psychological = (
        swimmer.psychological_profile if isinstance(swimmer.psychological_profile, dict) else {}
    )
    if not any((
        existing_physical,
        existing_psychological,
        latest_profiles,
        observations,
        coaching_notes,
        histories,
        swimmer.profile_notes,
        swimmer.strengths,
        swimmer.weaknesses,
    )):
        raise ValueError("No existing profile evidence is available to carry over")

    # Each destination accepts only explicitly matching structured fields. The
    # priority order chooses the most specific source and avoids blending broad
    # biological summaries or untyped notes into claims they may not support.
    carryover_map = {
        ("physical", "aerobic_base"): (
            ("training", "aerobic", "Training profile · Aerobic"),
        ),
        ("physical", "sprint_tendency"): (
            ("performance_analysis", "aerobic_vs_sprint_bias", "Performance analysis · Aerobic/sprint bias"),
            ("training", "speed", "Training profile · Speed"),
        ),
        ("physical", "race_pattern"): (
            ("race", "pacing_tendency", "Race profile · Pacing tendency"),
            ("race", "split_pattern", "Race profile · Split pattern"),
            ("technical", "race_execution", "Technical profile · Race execution"),
        ),
        ("physical", "fatigue_profile"): (
            ("race", "fatigue_profile", "Race profile · Fatigue profile"),
            ("training", "fatigue_markers", "Training profile · Fatigue markers"),
            ("training", "recovery", "Training profile · Recovery"),
        ),
        ("physical", "training_response"): (
            ("training", "predictive_notes", "Training profile · Predictive notes"),
            ("training", "__change_summary__", "Training profile · Summary"),
        ),
        ("psychological", "competition_response"): (
            ("race", "pressure_response", "Race profile · Pressure response"),
        ),
        ("psychological", "coachability"): (
            ("technical", "coachability", "Technical profile · Coachability"),
            ("technical", "drill_response", "Technical profile · Drill response"),
        ),
    }
    multi_source_fields = {
        ("physical", "race_pattern"),
        ("psychological", "coachability"),
    }

    def source_text(profile_type: str, key: str) -> Optional[str]:
        version = latest_profiles.get(profile_type)
        if not version:
            return None
        value = version.change_summary if key == "__change_summary__" else (version.data or {}).get(key)
        if not isinstance(value, str) or not value.strip():
            return None
        return value.strip()

    result = {"physical": {}, "psychological": {}}
    existing_by_section = {
        "physical": existing_physical,
        "psychological": existing_psychological,
    }
    for section, fields in FOUNDATION_DRAFT_FIELDS.items():
        for field in fields:
            accepted_keys = (field, *FOUNDATION_KEY_ALIASES.get(field, ()))
            existing_value = next(
                (
                    existing_by_section[section].get(key)
                    for key in accepted_keys
                    if existing_by_section[section].get(key) is not None
                    and str(existing_by_section[section].get(key)).strip()
                ),
                None,
            )
            if existing_value is not None:
                value = str(existing_value).strip()[:2500]
                evidence = "Already saved in the confirmed foundation profile."
                confidence = "confirmed"
            else:
                matches = []
                for profile_type, source_key, label in carryover_map.get((section, field), ()):
                    if (
                        (section, field) == ("physical", "race_pattern")
                        and matches
                        and profile_type != "race"
                    ):
                        break
                    text = source_text(profile_type, source_key)
                    if text and all(text != existing_text for _, existing_text in matches):
                        matches.append((label, text))
                    if matches and (section, field) not in multi_source_fields:
                        break
                if matches:
                    if len(matches) == 1:
                        value = matches[0][1][:2500]
                    else:
                        value = "\n\n".join(f"{label}: {text}" for label, text in matches)[:2500]
                    sources = "; ".join(label for label, _ in matches)
                    evidence = f"Copied directly from {sources}. No new interpretation was generated."
                    confidence = "supported"
                else:
                    value = None
                    evidence = "No directly matching stored profile field; coach input is needed."
                    confidence = "missing"
            result[section][field] = {
                "value": value,
                "evidence": evidence,
                "confidence": confidence,
            }

    result["uses_ai"] = False
    result["method"] = "direct_profile_carryover"
    living_profile_keys = {key for key, _ in LIVING_PROFILE_TYPES}
    result["source_counts"] = {
        "living_profiles": len([key for key in latest_profiles if key in living_profile_keys]),
        "observations": len(observations),
        "coaching_notes": len(coaching_notes),
        "history_narratives": len(histories),
    }
    return result


def save_wizard_profile(
    swimmer: models.Swimmer,
    messages: list[dict],
    db: DBSession,
    preserve_existing: bool = False,
) -> dict:
    """
    Synthesise the wizard conversation into physical_profile + psychological_profile JSON
    and save a SwimmerProfileVersion with type "wizard".
    """
    context = build_foundation_interview_context(swimmer, db)
    conversation_text = "\n".join(
        f"{'Coach' if m['role'] == 'user' else 'AI'}: {m['content']}"
        for m in messages
    )
    prompt = f"""Synthesize the coach-confirmed foundation evidence from this swimmer interview.

LIVE SWIMMER CONTEXT:
{json.dumps(context, ensure_ascii=False)}

PROFILING CONVERSATION:
{conversation_text}

Return JSON with exactly the nine foundation fields below:
{{
  "physical": {{
    "aerobic_base": "concise coach-supported description or null",
    "sprint_tendency": "concise coach-supported description or null",
    "race_pattern": "concise coach-supported description or null",
    "fatigue_profile": "concise coach-supported description or null",
    "training_response": "concise coach-supported description or null"
  }},
  "psychological": {{
    "motivation_style": "concise coach-supported description or null",
    "competition_response": "concise coach-supported description or null",
    "response_to_hard_training": "concise coach-supported description or null",
    "coachability": "concise coach-supported description or null"
  }}
}}

Rules:
- The coach's answers are the authority for new or changed foundation facts.
- Current confirmed foundation values are context, not fields to rewrite. Return null unless the conversation clearly adds to or corrects them.
- Times and living profiles can frame physical evidence but cannot establish psychological traits.
- Do not turn an AI question, suggestion or assumption into an athlete fact.
- Where evidence is insufficient, return null.
- Preserve specific observable detail and avoid generic coaching language.
Return only JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    profile_data = json.loads(_strip_json(response.content[0].text))

    def clean_section(section: str) -> dict:
        raw = profile_data.get(section) if isinstance(profile_data, dict) else {}
        if not isinstance(raw, dict):
            return {}
        cleaned = {}
        for key in FOUNDATION_DRAFT_FIELDS[section]:
            value = raw.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                cleaned[key] = text[:2500]
        return cleaned

    proposed_physical = clean_section("physical")
    proposed_psychological = clean_section("psychological")

    def merge_non_null(existing: dict, proposed: dict) -> dict:
        merged = dict(existing or {})
        for key, value in (proposed or {}).items():
            if value is not None:
                merged[key] = value
        return merged

    if preserve_existing:
        physical = merge_non_null(swimmer.physical_profile, proposed_physical)
        psychological = merge_non_null(
            swimmer.psychological_profile,
            proposed_psychological,
        )
    else:
        physical = proposed_physical
        psychological = proposed_psychological

    swimmer.physical_profile = physical
    swimmer.psychological_profile = psychological
    stored_profile = {"physical": physical, "psychological": psychological}

    version = models.SwimmerProfileVersion(
        swimmer_id=swimmer.id,
        profile_type="wizard",
        data=stored_profile,
        change_summary=(
            f"Foundation saved from the API interview; "
            f"{len(proposed_physical) + len(proposed_psychological)} reviewed field(s) added or updated."
        ),
        obs_count=len(messages),
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return _profile_version_out(version)
