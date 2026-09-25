"""Decide which planning skill a coach's message is asking for.

Keyword matching got the chat this far, but the signal lists have started to
overlap — "plan the season" belongs to two of them — and every new skill makes
the collision worse. The model reads the message instead and names one skill.

The classifier only ever narrows: when it is unavailable, disabled, or unsure,
callers fall back to the keyword matchers, so behaviour degrades to exactly
what it was before.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

from backend.services.claude_service import FAST_MODEL, get_client, response_text

# One label per skill the chat can route to. Descriptions are what the model
# reads, so they carry the distinctions the keyword lists could not.
SKILL_CATALOGUE = [
    ("macro_plan",
     "Build or restructure a macrocycle: the overall shape of a season or a "
     "multi-month block, its phases and its target meets."),
    ("meso_plan",
     "Plan one training block or phase within a season — what the next few "
     "weeks should emphasise."),
    ("micro_plan",
     "Plan a single week: which sessions run on which days and what each is for."),
    ("pathway_plan",
     "Decide who is aiming at which competition, and where swimmers go instead "
     "if they do not get the qualifying time. Includes branching a group or an "
     "individual swimmer onto a different target meet."),
    ("suggest_groups",
     "Divide the squad into training groups by ability, event or development need."),
    ("taper_plan", "Plan the taper into a competition for a named swimmer."),
    ("swimmer_review", "Review one named swimmer's progress, training response or profile."),
    ("block_review", "Review how a training block that has already run actually went."),
    ("race_analysis", "Analyse results and performances from a meet that has happened."),
    ("session_generation", "Write an actual pool session — sets, distances, intervals."),
    ("none",
     "Ordinary conversation, a question, or anything that is not a request to "
     "produce one of the plans above."),
]

VALID_LABELS = {name for name, _ in SKILL_CATALOGUE}

_SYSTEM = """You route a swimming coach's message to exactly one planning skill.

Skills:
{catalogue}

Reply with the single skill label and nothing else. No punctuation, no
explanation. If the message is not clearly asking for one of these, reply
"none". Prefer "none" over a guess — a wrong route is worse than no route.""".format(
    catalogue="\n".join(f"- {name}: {desc}" for name, desc in SKILL_CATALOGUE)
)


def routing_enabled() -> bool:
    """Model routing is on unless explicitly switched off."""
    return os.getenv("PLANNING_INTENT_ROUTING", "on").strip().lower() not in ("off", "0", "false")


@lru_cache(maxsize=512)
def _classify_cached(text: str) -> Optional[str]:
    try:
        response = get_client().messages.create(
            model=FAST_MODEL,
            max_tokens=12,
            system=_SYSTEM,
            messages=[{"role": "user", "content": text}],
            operation="planning_intent",
        )
        label = response_text(response).strip().lower().strip(".\"' ")
    except Exception:
        return None
    if label not in VALID_LABELS:
        return None
    return None if label == "none" else label


def classify_planning_intent(text: str) -> Optional[str]:
    """Name the skill this message is asking for, or None to fall back.

    None means "no opinion" — never "definitely nothing". Callers treat it as a
    signal to use their keyword matchers unchanged.
    """
    if not routing_enabled():
        return None
    cleaned = (text or "").strip()
    # Very short messages carry too little signal to be worth a model call, and
    # the keyword matchers handle the stock phrases well.
    if len(cleaned) < 8:
        return None
    return _classify_cached(cleaned[:2000])


def route_matches(routed: Optional[str], label: str, keyword_hit: bool) -> bool:
    """Whether a skill branch should fire.

    With a route, the model's choice decides — that is the point of asking it.
    Without one, the keyword matcher decides exactly as before.
    """
    if routed is None:
        return bool(keyword_hit)
    return routed == label


def route_allows(routed: Optional[str], label: str, keyword_hit) -> bool:
    """The same decision for skills that must first extract an entity.

    A named swimmer or meet has to come from the message itself, so the model
    can veto one of these branches but cannot force it without that name.
    """
    if not keyword_hit:
        return False
    return routed is None or routed == label
