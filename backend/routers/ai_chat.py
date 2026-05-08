import base64
from fastapi import APIRouter, Depends, HTTPException, Body, UploadFile, File, Form
from typing import Optional
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import (
    get_client, MODEL, get_system_prompt, get_swimmer_full_context,
    build_meets_context, build_periodization_context, build_session_writing_context,
    detect_topics, extract_slot_hint, classify_intent, _strip_json,
)

router = APIRouter()

MAX_HISTORY = 40


# ---------------------------------------------------------------------------
# Thread management
# ---------------------------------------------------------------------------

@router.get("/threads")
def get_threads(db: DBSession = Depends(get_db)):
    threads = db.query(models.AIThread).order_by(models.AIThread.created_at.asc()).all()
    return [{"id": t.id, "name": t.name, "created_at": t.created_at} for t in threads]


@router.post("/threads")
def create_thread(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    thread = models.AIThread(name=body.get("name") or None)
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return {"id": thread.id, "name": thread.name, "created_at": thread.created_at}


@router.patch("/threads/{thread_id}")
def rename_thread(thread_id: int, body: dict = Body(...), db: DBSession = Depends(get_db)):
    thread = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread.name = body.get("name", thread.name)
    db.commit()
    return {"id": thread.id, "name": thread.name}


@router.delete("/threads/{thread_id}", status_code=204)
def delete_thread(thread_id: int, db: DBSession = Depends(get_db)):
    thread = db.query(models.AIThread).filter(models.AIThread.id == thread_id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    db.delete(thread)
    db.commit()


def _find_mentioned_swimmers(text: str, db: DBSession) -> list:
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    text_lower = text.lower()
    matched = []
    for s in swimmers:
        name_parts = s.name.lower().split()
        first = name_parts[0] if name_parts else ""
        full = s.name.lower()
        if (len(first) >= 4 and first in text_lower) or full in text_lower:
            matched.append(s)
    return matched


def _all_mentioned_swimmers(messages: list, db: DBSession) -> list:
    """Find all swimmers mentioned across the full conversation, deduplicated."""
    seen_ids = set()
    result = []
    for msg in messages:
        for s in _find_mentioned_swimmers(msg.get("content", ""), db):
            if s.id not in seen_ids:
                seen_ids.add(s.id)
                result.append(s)
    return result


@router.get("/messages")
def get_messages(thread_id: Optional[int] = None, db: DBSession = Depends(get_db)):
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    return [{"id": m.id, "role": m.role, "message": m.message, "created_at": m.created_at} for m in msgs]


@router.post("/messages")
def send_message(body: dict = Body(...), db: DBSession = Depends(get_db)):
    text = body.get("message", "").strip()
    thread_id = body.get("thread_id")
    if not text:
        raise HTTPException(status_code=400, detail="Message required")

    db.add(models.CoachAIMessage(role="user", message=text, thread_id=thread_id))
    db.commit()

    all_msgs = (
        db.query(models.CoachAIMessage)
        .filter(models.CoachAIMessage.thread_id == thread_id)
        .order_by(models.CoachAIMessage.created_at.asc())
        .all()
    )
    recent = all_msgs[-MAX_HISTORY:]
    messages = [{"role": m.role, "content": m.message} for m in recent]

    # Base system prompt (squad snapshot + recent sessions + active coaching notes)
    system = get_system_prompt(db)

    # Detect topics from current message + recent history to decide what extra context to inject
    topics = detect_topics(text, messages[:-1])

    if 'competition' in topics:
        meets_ctx = build_meets_context(db)
        if meets_ctx:
            system += f"\n\n---\n{meets_ctx}"

    if 'planning' in topics:
        period_ctx = build_periodization_context(db)
        if period_ctx:
            system += f"\n\n---\n{period_ctx}"

    if 'register' in topics:
        # Inject register context — find likely session and list expected attendees
        from datetime import date as date_type, timedelta as tdelta
        slot_hint = extract_slot_hint(text)
        today_d = date_type.today()
        recent_sessions = (
            db.query(models.Session)
            .filter(
                models.Session.date >= today_d - tdelta(days=3),
                models.Session.date <= today_d,
                models.Session.status != 'cancelled',
            )
            .order_by(models.Session.date.desc())
            .limit(5)
            .all()
        )
        if recent_sessions:
            reg_lines = ["RECENT SESSIONS AVAILABLE FOR REGISTER:"]
            for s in recent_sessions:
                entries = db.query(models.SessionEntry).filter(models.SessionEntry.session_id == s.id).count()
                status = "register taken" if entries > 0 else "no register yet"
                reg_lines.append(f"  {s.date} | {s.title or 'Session'} | {status}")
            system += "\n\n---\n" + "\n".join(reg_lines)
            system += "\n\nREGISTER MODE — help the coach identify which session to register, then ask who attended and what groups they were in."

    if 'session_writing' in topics:
        slot_hint = extract_slot_hint(text)
        session_ctx = build_session_writing_context(db, slot_hint)
        if session_ctx:
            system += f"\n\n---\nSESSION WRITING MODE — you are helping design a training session. Use the slot and attendee information below to recommend group assignments and session structure. Check the design against recent training history and periodization focus.\n{session_ctx}"

    # Inject full profiles for any swimmers mentioned by name in this message
    mentioned_now = _find_mentioned_swimmers(text, db)
    if mentioned_now:
        profiles_block = "\n\n".join(get_swimmer_full_context(s, db) for s in mentioned_now)
        system += f"\n\n---\n{profiles_block}"

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        system=system,
        messages=messages,
    )

    reply = response.content[0].text.strip()
    db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
    db.commit()

    # Classify intent across the full conversation to suggest a save action
    all_mentioned = _all_mentioned_swimmers(messages, db)
    intent = classify_intent(messages + [{"role": "assistant", "content": reply}], all_mentioned, db)

    return {
        "reply": reply,
        "context_injected": [s.name for s in mentioned_now],
        "topics_detected": list(topics),
        "suggested_action": intent.get("suggested_action"),
        "intent": {
            "type": intent.get("intent"),
            "swimmer_id": intent.get("swimmer_id"),
            "swimmer_name": intent.get("swimmer_name"),
        },
    }


def _build_extraction_prompt(conversation: str, today: str) -> str:
    return f"""Extract a structured training session from this coaching conversation. Today's date: {today}.

CONVERSATION:
{conversation}

Return JSON:
{{
  "title": "session title",
  "date": "YYYY-MM-DD — use the date discussed, or today if not specified",
  "squad": "squad name if mentioned, else null",
  "energy_system_focus": "aerobic / threshold / vo2max / speed_endurance / sprint / recovery / mixed",
  "coach_intent": "1-2 sentences: why this session, what's the training goal",
  "groups": [
    {{
      "group_number": 1,
      "description": "who is in this group and why",
      "sets": ["set description 1", "set description 2"],
      "swimmer_names": ["first names of swimmers assigned to this group"]
    }}
  ]
}}

Rules:
- Include all groups discussed (typically 1-3)
- Sets should be as specific as the conversation allows — use the actual distances/reps/rest if mentioned
- If a set wasn't fleshed out, mark it as "TBC"
- Return only valid JSON"""


def _save_session_from_data(data: dict, db: DBSession) -> int:
    """Save a session dict (from extraction or draft edit) to DB. Returns session_id."""
    import json as _json
    from datetime import date as date_type, datetime

    today = date_type.today().isoformat()
    try:
        session_date = datetime.strptime(data.get("date", today), "%Y-%m-%d").date()
    except Exception:
        session_date = date_type.today()

    session = models.Session(
        date=session_date,
        title=data.get("title", "AI-designed session"),
        squad=data.get("squad"),
        energy_system_focus=data.get("energy_system_focus"),
        coach_intent=data.get("coach_intent"),
        source="ai_chat",
    )
    db.add(session)
    db.flush()

    all_swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    name_map = {s.name.lower(): s.id for s in all_swimmers}
    for s in all_swimmers:
        first = s.name.split()[0].lower()
        if first not in name_map:
            name_map[first] = s.id

    for grp in (data.get("groups") or []):
        swimmer_ids = [name_map[n.lower()] for n in (grp.get("swimmer_names") or []) if n.lower() in name_map]
        db.add(models.SessionGroup(
            session_id=session.id,
            group_number=grp.get("group_number", 1),
            description=grp.get("description", ""),
            sets=grp.get("sets") or [],
            target_swimmers=swimmer_ids,
        ))

    db.commit()
    db.refresh(session)
    return session.id


@router.post("/extract-session")
def extract_session_draft(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Extract session structure from conversation — returns draft JSON without saving."""
    import json
    from datetime import date as date_type

    thread_id = body.get("thread_id")
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    all_msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to extract from")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs[-40:]
    )
    today = date_type.today().isoformat()

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1200,
        messages=[{"role": "user", "content": _build_extraction_prompt(conversation, today)}],
    )

    data = json.loads(_strip_json(response.content[0].text))
    return data  # draft only — nothing saved


@router.post("/create-session")
def create_session_from_chat(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Save a confirmed session draft to the DB. Accepts the pre-edited draft directly."""
    if not body:
        raise HTTPException(status_code=400, detail="Session data required")
    session_id = _save_session_from_data(body, db)
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    return {"session_id": session_id, "title": session.title, "date": session.date.isoformat()}


@router.post("/messages-with-image")
async def send_message_with_image(
    message: str = Form(default=""),
    image: UploadFile = File(...),
    thread_id: Optional[int] = Form(default=None),
    db: DBSession = Depends(get_db),
):
    """Send a message with an attached image. Claude reads the image inline."""
    image_bytes = await image.read()
    media_type = image.content_type or "image/jpeg"
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    text = message.strip() or "Here's a session photo."

    # Save user message (text only for history — image is transient)
    display_text = f"[Photo attached] {text}" if text != "Here's a session photo." else "[Photo: session whiteboard]"
    db.add(models.CoachAIMessage(role="user", message=display_text, thread_id=thread_id))
    db.commit()

    # Build history for this thread
    all_msgs = (
        db.query(models.CoachAIMessage)
        .filter(models.CoachAIMessage.thread_id == thread_id)
        .order_by(models.CoachAIMessage.created_at.asc())
        .all()
    )
    recent = all_msgs[-MAX_HISTORY:]
    history = [{"role": m.role, "content": m.message} for m in recent[:-1]]  # exclude the message we just added

    # Always inject session writing context for photo messages
    slot_hint = extract_slot_hint(text)
    session_ctx = build_session_writing_context(db, slot_hint)
    system = get_system_prompt(db)
    if session_ctx:
        system += f"\n\n---\nSESSION WRITING MODE — extracting session from photo. Use slot and attendee context below.\n{session_ctx}"

    # Multimodal user message: image + text
    user_content = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": image_b64},
        },
        {
            "type": "text",
            "text": f"{text}\n\nPlease read this session photo and extract the training content. Identify the groups (Group 1/2/3 or A/B/C or similar), the sets for each group, and any swimmer names if visible. Then recommend which of the expected attendees (from the context above) should be in each group, with brief reasoning. Present it clearly so we can confirm before creating the session.",
        },
    ]

    messages_for_claude = history + [{"role": "user", "content": user_content}]

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        system=system,
        messages=messages_for_claude,
    )

    reply = response.content[0].text.strip()
    db.add(models.CoachAIMessage(role="assistant", message=reply, thread_id=thread_id))
    db.commit()

    # Classify intent
    all_mentioned = _all_mentioned_swimmers(
        [{"role": "user", "content": text}], db
    )
    intent = classify_intent(
        history + [{"role": "user", "content": text}, {"role": "assistant", "content": reply}],
        all_mentioned, db,
    )

    return {
        "reply": reply,
        "context_injected": [],
        "topics_detected": ["session_writing"],
        "suggested_action": "Review & create session",
        "intent": {
            "type": "session_writing",
            "swimmer_id": None,
            "swimmer_name": None,
        },
    }


@router.post("/create-meet")
def create_meet_from_chat(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Extract a meet + swimmer entries from the current conversation and save to DB."""
    import json
    from datetime import date as date_type

    thread_id = body.get("thread_id")
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    all_msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to extract meet from")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs[-30:]
    )
    today = date_type.today().isoformat()

    extraction_prompt = f"""Extract a competition meet and swimmer entries from this coaching conversation. Today's date: {today}.

CONVERSATION:
{conversation}

Return JSON:
{{
  "name": "meet name",
  "date": "YYYY-MM-DD — start date",
  "date_to": "YYYY-MM-DD — end date if multi-day, else same as date",
  "location": "venue/city or null",
  "course": "SCM or LCM or null",
  "level": "club / regional / national / international or null",
  "notes": "any other context mentioned, or null",
  "entries": [
    {{
      "swimmer_name": "first name or full name",
      "events": ["100 Freestyle", "200 Breaststroke"],
      "priority": "A or B or C — A=peak target, B=good swim, C=experience. Default B if not discussed.",
      "target_times": {{"100 Freestyle": "58.50"}} or null
    }}
  ]
}}

Rules:
- Use full event names like "100 Freestyle", "200 Breaststroke SCM" etc.
- Include every swimmer mentioned with their events
- Return only valid JSON"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=800,
        messages=[{"role": "user", "content": extraction_prompt}],
    )

    data = json.loads(_strip_json(response.content[0].text))

    from datetime import datetime
    def parse_date(s):
        try:
            return datetime.strptime(s, "%Y-%m-%d").date() if s else None
        except Exception:
            return None

    meet = models.Meet(
        name=data.get("name", "Meet"),
        date=parse_date(data.get("date")),
        date_to=parse_date(data.get("date_to")),
        location=data.get("location"),
        course=data.get("course"),
        level=data.get("level"),
        notes=data.get("notes"),
    )
    db.add(meet)
    db.flush()

    # Resolve swimmer names and create targets
    all_swimmers = db.query(models.Swimmer).filter(models.Swimmer.status == 'active').all()
    name_map = {s.name.lower(): s.id for s in all_swimmers}
    for s in all_swimmers:
        first = s.name.split()[0].lower()
        if first not in name_map:
            name_map[first] = s.id

    for entry in (data.get("entries") or []):
        swimmer_id = name_map.get(entry.get("swimmer_name", "").lower())
        if not swimmer_id:
            continue
        target = models.MeetTarget(
            meet_id=meet.id,
            swimmer_id=swimmer_id,
            events=entry.get("events", []),
            priority=entry.get("priority", "B"),
            target_times=entry.get("target_times"),
        )
        db.add(target)

    db.commit()
    db.refresh(meet)
    return {"meet_id": meet.id, "name": meet.name, "date": meet.date.isoformat() if meet.date else None}


@router.post("/start-register")
def start_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Identify the session for a register from day/time hint and return expected attendees.
    Called when coach says 'let's take a register for Monday PM'.
    """
    from datetime import date as date_type, timedelta

    text = body.get("message", "")
    slot_hint = extract_slot_hint(text)

    # Find the most recent matching session (within last 3 days)
    today = date_type.today()
    cutoff = today - timedelta(days=3)

    q = db.query(models.Session).filter(
        models.Session.date >= cutoff,
        models.Session.date <= today,
        models.Session.status != 'cancelled',
    ).order_by(models.Session.date.desc())

    sessions = q.all()

    # Filter by day hint
    matched_session = None
    if slot_hint.get('dow') is not None:
        for s in sessions:
            if s.date and s.date.weekday() == slot_hint['dow']:
                matched_session = s
                break

    # Fall back to most recent
    if not matched_session and sessions:
        matched_session = sessions[0]

    if not matched_session:
        return {"error": "No recent session found. Try specifying the date or creating the session first.", "sessions": []}

    # Get expected attendees from schedule
    from backend.routers.schedule import expected_attendance as _expected
    try:
        attendees = _expected(matched_session.date, squad=matched_session.squad, db=db)
    except Exception:
        attendees = []

    # Check if register already taken
    existing_entries = db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id == matched_session.id
    ).count()

    return {
        "session_id": matched_session.id,
        "session_title": matched_session.title or f"Session {matched_session.date}",
        "session_date": matched_session.date.isoformat(),
        "register_taken": existing_entries > 0,
        "attendees": attendees,
    }


@router.post("/parse-register")
def parse_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Parse a freetext attendance description into a structured register.
    e.g. "everyone's here except Tom and Sarah, Tom's injured"
    """
    import json

    session_id = body.get("session_id")
    message = body.get("message", "")
    attendees = body.get("attendees", [])  # list of {id, name, expected}

    if not attendees:
        raise HTTPException(status_code=400, detail="Attendees list required")

    attendee_list = "\n".join(f"- {a['name']} (expected: {'yes' if a.get('expected') else 'no'})" for a in attendees)

    parse_prompt = f"""Parse this attendance message into a register for the following swimmers.

EXPECTED SWIMMERS:
{attendee_list}

COACH'S MESSAGE: "{message}"

Return JSON:
{{
  "attendance": [
    {{
      "name": "swimmer name exactly as listed above",
      "present": true or false,
      "group": 1 or 2 or 3 or null,
      "note": "any observation mentioned, or null"
    }}
  ]
}}

Rules:
- If coach says "everyone except X" → mark all present except named
- If coach says "present: A, B, C" → mark only those as present
- Group assignment: if coach says "Group 1/2/3" or "A group/B group" map to 1/2/3
- If group not mentioned, use null
- Return only valid JSON"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": parse_prompt}],
    )

    data = json.loads(_strip_json(response.content[0].text))

    # Match parsed names back to IDs
    name_to_id = {a['name'].lower(): a['id'] for a in attendees}
    first_to_id = {}
    for a in attendees:
        first = a['name'].split()[0].lower()
        if first not in first_to_id:
            first_to_id[first] = a['id']

    result = []
    for entry in (data.get("attendance") or []):
        name = entry.get("name", "").lower()
        sid = name_to_id.get(name) or first_to_id.get(name.split()[0] if name else "")
        if sid:
            result.append({
                "swimmer_id": sid,
                "name": entry.get("name"),
                "present": entry.get("present", False),
                "group": entry.get("group"),
                "note": entry.get("note"),
            })

    return {"session_id": session_id, "attendance": result}


@router.post("/submit-register")
def submit_register(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """Save a confirmed attendance list as SessionEntry records."""
    session_id = body.get("session_id")
    attendance = body.get("attendance", [])

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")

    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Remove existing entries for this session (allow re-submission)
    db.query(models.SessionEntry).filter(models.SessionEntry.session_id == session_id).delete()

    for entry in attendance:
        db.add(models.SessionEntry(
            session_id=session_id,
            swimmer_id=entry["swimmer_id"],
            attended=entry.get("present", False),
            group_done=entry.get("group"),
            coach_observation=entry.get("note"),
        ))

    db.commit()
    return {"saved": len(attendance), "session_id": session_id}


@router.post("/pin-to-sessions")
def pin_to_sessions(body: dict = Body(default={}), db: DBSession = Depends(get_db)):
    """Summarise current conversation into a coaching note for pinning."""
    thread_id = body.get("thread_id")
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    all_msgs = q.order_by(models.CoachAIMessage.created_at.asc()).all()
    if not all_msgs:
        raise HTTPException(status_code=400, detail="No conversation to pin")

    conversation = "\n".join(
        f"{'Coach' if m.role == 'user' else 'AI'}: {m.message}" for m in all_msgs[-30:]
    )

    summary_prompt = f"""The following is a coaching conversation. Extract a concise coaching note that can be pinned to session planning for a specific date range.

CONVERSATION:
{conversation}

Return JSON:
{{
  "title": "short title (e.g. 'Tom — Coventry LC prep this week')",
  "body": "3-6 bullet points covering: the situation, the plan for each session, key things to watch, what to do after the event",
  "swimmer_names": ["list of swimmer first names mentioned"]
}}

Return only valid JSON."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": summary_prompt}],
    )

    import json
    from backend.services.claude_service import _strip_json
    data = json.loads(_strip_json(response.content[0].text))

    swimmer_names = data.get("swimmer_names", [])
    swimmer_ids = []
    resolved_names = []
    for name in swimmer_names:
        match = db.query(models.Swimmer).filter(
            models.Swimmer.name.ilike(f"%{name}%"),
            models.Swimmer.status == 'active'
        ).first()
        if match:
            swimmer_ids.append(match.id)
            resolved_names.append(match.name)

    return {
        "title": data.get("title", "Coaching note"),
        "body": data.get("body", ""),
        "swimmer_ids": swimmer_ids,
        "swimmer_names": resolved_names,
    }


@router.delete("/messages")
def clear_messages(thread_id: Optional[int] = None, db: DBSession = Depends(get_db)):
    q = db.query(models.CoachAIMessage)
    if thread_id is not None:
        q = q.filter(models.CoachAIMessage.thread_id == thread_id)
    q.delete()
    db.commit()
    return {"cleared": True}


@router.get("/context-status")
def context_status(db: DBSession = Depends(get_db)):
    profile = (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )
    if not profile:
        return {"active": False}
    return {"active": True, "title": profile.title, "created_at": profile.created_at}
