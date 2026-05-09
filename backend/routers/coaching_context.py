import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import get_client, MODEL

router = APIRouter()

SYSTEM_PROMPT = """You are an experienced swimming performance coach helping a fellow coach articulate and capture their coaching context and style.

Your role is to ask thoughtful questions across two areas:

**Area 1 — Coaching philosophy and current state:**
- Their philosophy and values: how they approach athlete development, what they prioritise long-term
- Where their squad currently is: fitness, technique, cohesion, key individuals, gaps or challenges
- Season targets and key competitions they're building towards
- What the current training block focus is and why

**Area 2 — How they actually coach (session style and preferences):**
- How they typically structure a session: warm-up style, main set format, cool-down, typical duration
- Preferred set formats: do they lean towards longer continuous work or shorter reps? Ladders? Descending sets? What does a typical main set look like?
- What Group 1 / Group 2 / Group 3 means to them: how they differentiate load and expectation between groups
- Their intensity/effort terminology: what do terms like "aerobic", "threshold", "VO2", "speed" actually mean in their sessions (effort level, HR zone, pace target, feel-based)?
- How they prefer to communicate intensity to swimmers: pace targets, HR, RPE, feel-based cues?
- Energy system balance: how much aerobic vs threshold vs speed work in a typical week?
- Any preferred drills, sets, or structures they come back to repeatedly

Ask one or two questions at a time — don't overwhelm. Cover both areas across the conversation. Probe deeper when answers are vague. Be conversational, not clinical.

When you have a rich picture across both areas, say "I think I have a good understanding now — want me to synthesise this into a coaching context summary?"

This document will be used as context for all AI-powered coaching decisions including writing sessions, reviewing training, and profiling swimmers — so the more specific the better."""


def _get_pending_conversation(db: DBSession):
    """Messages not yet linked to a finalised profile."""
    return (
        db.query(models.CoachingConversation)
        .filter(models.CoachingConversation.profile_id == None)
        .order_by(models.CoachingConversation.created_at)
        .all()
    )


def _current_profile(db: DBSession) -> Optional[models.CoachingProfile]:
    return (
        db.query(models.CoachingProfile)
        .filter(models.CoachingProfile.is_current == True)
        .first()
    )


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------

@router.get("/profiles")
def list_profiles(db: DBSession = Depends(get_db)):
    profiles = (
        db.query(models.CoachingProfile)
        .order_by(models.CoachingProfile.created_at.desc())
        .all()
    )
    return [_profile_out(p) for p in profiles]


@router.get("/current")
def get_current(db: DBSession = Depends(get_db)):
    p = _current_profile(db)
    if not p:
        return None
    return _profile_out(p, full=True)


@router.get("/profiles/{profile_id}")
def get_profile(profile_id: int, db: DBSession = Depends(get_db)):
    p = db.query(models.CoachingProfile).filter(models.CoachingProfile.id == profile_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Profile not found")
    return _profile_out(p, full=True)


# ---------------------------------------------------------------------------
# Conversation
# ---------------------------------------------------------------------------

@router.get("/conversation")
def get_conversation(db: DBSession = Depends(get_db)):
    messages = _get_pending_conversation(db)
    return [{"role": m.role, "message": m.message, "id": m.id} for m in messages]


@router.delete("/conversation")
def clear_conversation(db: DBSession = Depends(get_db)):
    """Start fresh — delete all pending (unfinalised) messages."""
    db.query(models.CoachingConversation).filter(
        models.CoachingConversation.profile_id == None
    ).delete()
    db.commit()
    return {"cleared": True}


@router.post("/chat")
def chat(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Send a coach message and get an AI response.
    Optionally pass update_context=True to prepend the current profile as context.
    """
    coach_message = body.get("message", "").strip()
    if not coach_message:
        raise HTTPException(status_code=400, detail="Message required")

    # Save coach message
    db.add(models.CoachingConversation(role="coach", message=coach_message))
    db.commit()

    # Build message history for Claude
    pending = _get_pending_conversation(db)
    messages = [{"role": "user" if m.role == "coach" else "assistant", "content": m.message}
                for m in pending]

    # If this is an update conversation, prepend the current profile as context
    current = _current_profile(db)
    system = SYSTEM_PROMPT
    if current and len(pending) == 1:
        # First message in what may be an update conversation
        system = SYSTEM_PROMPT + f"""

EXISTING COACHING CONTEXT (being updated):
{current.summary}

The coach is now providing updates or additions to this context. Help them articulate what has changed or evolved."""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=800,
        system=system,
        messages=messages,
    )

    ai_reply = response.content[0].text.strip()

    # Save AI reply
    db.add(models.CoachingConversation(role="ai", message=ai_reply))
    db.commit()

    return {"reply": ai_reply}


@router.post("/finalise")
def finalise(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Synthesise the pending conversation into a CoachingProfile snapshot.
    Accepts optional title from the coach.
    """
    title = body.get("title", "").strip() or "Coaching Context"

    pending = _get_pending_conversation(db)
    if not pending:
        raise HTTPException(status_code=400, detail="No conversation to finalise")

    conversation_text = "\n".join(
        f"{'Coach' if m.role == 'coach' else 'AI'}: {m.message}"
        for m in pending
    )

    current = _current_profile(db)
    prior_context = f"\nPRIOR CONTEXT:\n{current.summary}\n" if current else ""

    synthesis_prompt = f"""Based on the conversation below, write a rich coaching context document.

Structure it as follows (write in prose, not bullet points — this will be used as AI context for writing sessions, reviewing training, and profiling swimmers):

**Coaching Philosophy & Ethos**
[How the coach thinks about athlete development, what they value, how they approach coaching, what they prioritise long-term]

**Squad State Right Now**
[Where the group currently is — fitness, technique, cohesion, key individuals, gaps or challenges]

**Season Targets**
[Key meets, performance goals, what the season is building towards]

**Current Training Block Focus**
[What they're training right now, why, and what adaptation they're seeking]

**Session Style & Preferences**
[How they structure sessions, preferred set formats, typical warm-up/cool-down approach, whether they lean towards volume or intensity, any signature sets or structures they return to. What Group 1/2/3 means to them. How they differentiate load across the squad.]

**Intensity & Terminology**
[What their intensity labels actually mean: what "aerobic", "threshold", "VO2", "speed" looks like in their sessions — pace, HR, effort, feel-based cues. How they communicate intensity to swimmers. Typical energy system balance across a training week.]

**Key Coaching Priorities**
[The 2-3 most important things the coach is focused on right now]

---
{prior_context}
CONVERSATION:
{conversation_text}
"""

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": synthesis_prompt}],
    )

    summary = response.content[0].text.strip()

    # Parse sections from summary
    def extract_section(text, heading):
        import re
        pattern = rf"\*\*{re.escape(heading)}\*\*\s*(.*?)(?=\*\*|\Z)"
        match = re.search(pattern, text, re.DOTALL)
        return match.group(1).strip() if match else None

    # Unset previous current
    db.query(models.CoachingProfile).filter(
        models.CoachingProfile.is_current == True
    ).update({"is_current": False})

    profile = models.CoachingProfile(
        title=title,
        summary=summary,
        ethos=extract_section(summary, "Coaching Philosophy & Ethos"),
        squad_state=extract_section(summary, "Squad State Right Now"),
        targets=extract_section(summary, "Season Targets"),
        current_focus=extract_section(summary, "Current Training Block Focus"),
        is_current=True,
    )
    db.add(profile)
    db.flush()

    # Link pending messages to this profile
    for m in pending:
        m.profile_id = profile.id
    db.commit()

    return _profile_out(profile, full=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _profile_out(p: models.CoachingProfile, full: bool = False) -> dict:
    out = {
        "id": p.id,
        "title": p.title,
        "is_current": p.is_current,
        "created_at": p.created_at,
    }
    if full:
        def _extract(text, heading):
            import re
            if not text:
                return None
            pattern = rf"\*\*{re.escape(heading)}\*\*\s*(.*?)(?=\*\*|\Z)"
            match = re.search(pattern, text, re.DOTALL)
            return match.group(1).strip() if match else None

        out.update({
            "summary": p.summary,
            "ethos": p.ethos,
            "squad_state": p.squad_state,
            "targets": p.targets,
            "current_focus": p.current_focus,
            "session_style": _extract(p.summary, "Session Style & Preferences"),
            "intensity_terminology": _extract(p.summary, "Intensity & Terminology"),
        })
    return out


def get_current_coaching_context(db: DBSession) -> str:
    """Return the current coaching profile summary for use in AI prompts."""
    p = _current_profile(db)
    if not p:
        return ""
    return f"COACHING CONTEXT:\n{p.summary}"
