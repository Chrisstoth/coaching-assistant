"""How this coach works - rules the coach has asked the staff to remember.

A rule comes from the coach answering a specialist ("that's not how I write
sets - I use mixed structures to keep them engaged"). The specialist offers it
as a rule; nothing is remembered until the coach taps Remember, so a one-off
comment ("not today, they're tired") never becomes a standing instruction.

Every rule reaches the Session Writer and every specialist, before anything
else they read, along with the session style from the coach's own profile.
"""

from __future__ import annotations

import re
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models

MAX_RULES_IN_PROMPT = 25


def rules(db: DBSession, include_inactive: bool = False) -> list:
    q = db.query(models.CoachGuidance)
    if not include_inactive:
        q = q.filter(models.CoachGuidance.active.is_(True))
    return q.order_by(models.CoachGuidance.created_at.desc(), models.CoachGuidance.id.desc()).all()


def session_style(db: DBSession) -> str:
    """The "Session Style & Preferences" section of the coach's profile, if written."""
    from backend.routers.coaching_context import _current_profile
    try:
        profile = _current_profile(db)
    except Exception:
        return ""
    if not profile or not profile.summary:
        return ""
    match = re.search(r"\*\*Session Style & Preferences\*\*\s*(.*?)(?=\n\*\*|\Z)", profile.summary,
                      re.DOTALL | re.IGNORECASE)
    return match.group(1).strip()[:900] if match else ""


def prompt_block(db: DBSession, role: Optional[str] = None) -> str:
    """The coach's rules as the staff read them - first, and not to be trimmed."""
    lines = []
    for rule in rules(db)[:MAX_RULES_IN_PROMPT]:
        if rule.role and role and rule.role != role:
            continue
        lines.append(f"- {rule.text}")
    style = session_style(db)
    if not lines and not style:
        return ""
    out = ["HOW THIS COACH WORKS - the coach's own rules. Follow them; never suggest against them."]
    out += lines
    if style:
        out.append(f"The coach's session style, in their profile: {style}")
    return "\n".join(out)


def add(db: DBSession, text: str, role: Optional[str] = None, source: Optional[str] = None) -> models.CoachGuidance:
    text = (text or "").strip()
    if not text:
        raise ValueError("A rule needs some words")
    rule = models.CoachGuidance(text=text[:500], role=role or None, source=(source or "")[:200] or None)
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


def out(rule: models.CoachGuidance) -> dict:
    return {"id": rule.id, "text": rule.text, "role": rule.role, "source": rule.source, "active": rule.active,
            "created_at": rule.created_at.isoformat() if rule.created_at else None}
