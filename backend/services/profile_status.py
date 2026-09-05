"""Shared swimmer-profile readiness rules.

The foundation profile is deliberately separate from the living profile. The
foundation is a finite interview the coach can finish; race, training,
biological and technical summaries continue to develop through the season.
"""

from collections.abc import Iterable
from typing import Any


FOUNDATION_AREAS = (
    ("physical", "aerobic_base", "Aerobic base"),
    ("physical", "sprint_tendency", "Sprint and power"),
    ("physical", "race_pattern", "Race patterns"),
    ("physical", "fatigue_profile", "Fatigue and recovery"),
    ("physical", "training_response", "Training response"),
    ("psychological", "motivation_style", "Motivation"),
    ("psychological", "competition_response", "Competition mindset"),
    ("psychological", "response_to_hard_training", "Response to hard training"),
    ("psychological", "coachability", "Coachability and feedback"),
)

# Older profile synthesis used these names. They remain valid evidence so an
# existing profile is not made artificially incomplete by the clearer UI.
FOUNDATION_KEY_ALIASES = {
    "fatigue_profile": ("recovery_rate",),
    "training_response": ("training_load_response",),
}

LIVING_PROFILE_TYPES = (
    ("race", "Race"),
    ("training", "Training"),
    ("biological", "Biological"),
    ("technical", "Technical"),
)


def _meaningful(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def build_profile_status(
    swimmer: Any,
    profile_types: Iterable[str] = (),
    freshness: dict | None = None,
) -> dict:
    """Return one stable definition used by the API and every profile UI.

    `freshness` is the unified-profile watermark from
    claude_service.unified_profile_freshness. Completeness alone was misleading:
    a profile shows as complete forever, however far the observation record has
    moved on since it was built.
    """
    physical = swimmer.physical_profile if isinstance(swimmer.physical_profile, dict) else {}
    psychological = (
        swimmer.psychological_profile
        if isinstance(swimmer.psychological_profile, dict)
        else {}
    )
    stores = {"physical": physical, "psychological": psychological}
    known_types = set(profile_types or ())

    areas = []
    for section, key, label in FOUNDATION_AREAS:
        accepted_keys = (key, *FOUNDATION_KEY_ALIASES.get(key, ()))
        complete = any(_meaningful(stores[section].get(candidate)) for candidate in accepted_keys)
        if key == "race_pattern" and "race" in known_types:
            complete = True
        if key == "training_response" and "training" in known_types:
            complete = True
        areas.append({"key": key, "label": label, "complete": complete})

    completed = sum(1 for area in areas if area["complete"])
    total = len(areas)
    has_any_stored_profile = bool(completed or known_types)

    if completed == total:
        state = "complete"
        label = "Foundation complete"
        next_action = "Review foundation profile"
    elif has_any_stored_profile:
        state = "in_progress"
        label = "Foundation in progress" if completed else "Foundation not confirmed"
        next_action = "Review existing evidence" if known_types else "Continue foundation profile"
    else:
        state = "not_started"
        label = "Foundation not started"
        next_action = "Build foundation profile"

    living = [
        {"key": key, "label": label, "built": key in known_types}
        for key, label in LIVING_PROFILE_TYPES
    ]

    freshness = freshness or {}
    is_stale = bool(freshness.get("stale")) and bool(freshness.get("has_profile"))
    if is_stale:
        # Staleness outranks the completeness label. A profile that is complete
        # but forty observations behind is the case the coach most needs to see.
        since = freshness.get("observations_since") or 0
        label = f"Profile {since} observation{'' if since == 1 else 's'} behind"
        next_action = "Update profile"

    return {
        "state": state,
        "label": label,
        "completed_areas": completed,
        "total_areas": total,
        "completion_percent": round(completed / total * 100) if total else 0,
        "has_profile": has_any_stored_profile,
        "missing_areas": [area["label"] for area in areas if not area["complete"]],
        "areas": areas,
        "next_action": next_action,
        "living_sections": living,
        "living_built": sum(1 for section in living if section["built"]),
        "living_total": len(living),
        "stale": is_stale,
        "observations_since_profile": freshness.get("observations_since"),
        "profile_age_days": freshness.get("age_days"),
        "profile_synthesised_at": freshness.get("synthesised_at"),
        "unified_profile": bool(freshness.get("has_profile")),
    }
