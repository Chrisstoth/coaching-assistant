"""Coach-facing terminology layered over stable internal training-zone keys."""

from sqlalchemy.orm import Session as DBSession

from backend import models


CANONICAL_ZONES = [
    "recovery", "aerobic", "threshold", "vo2", "race_pace",
    "lact_tol", "short_race_pace", "sprint", "kicking", "mixed",
]

DEFAULT_LEVELS = [
    {"id": "recovery", "label": "Recovery", "description": "Easy restorative swimming with low physiological cost.", "colour": "#16a34a", "canonical_zone": "recovery"},
    {"id": "aerobic", "label": "Aerobic", "description": "Sustainable aerobic work with repeatable technique.", "colour": "#2563eb", "canonical_zone": "aerobic"},
    {"id": "threshold", "label": "Threshold", "description": "Controlled hard work around sustainable threshold pace.", "colour": "#d97706", "canonical_zone": "threshold"},
    {"id": "vo2", "label": "VO2", "description": "High aerobic power work with purposeful recovery.", "colour": "#dc2626", "canonical_zone": "vo2"},
    {"id": "race_pace", "label": "Race pace", "description": "Competition-pace work for a named event or distance.", "colour": "#7c3aed", "canonical_zone": "race_pace"},
    {"id": "lact_tol", "label": "Lactate tolerance", "description": "Very hard repeated work targeting glycolytic tolerance.", "colour": "#db2777", "canonical_zone": "lact_tol"},
    {"id": "sprint", "label": "Sprint", "description": "Maximal short-duration speed and power work.", "colour": "#ea580c", "canonical_zone": "sprint"},
]


def get_presentation_settings(db: DBSession):
    try:
        return db.query(models.SessionPresentationSettings).first()
    except (AttributeError, TypeError):
        return None


def coach_terminology_context(db: DBSession) -> str:
    """Instructions that make AI conversation use the coach's vocabulary.

    Canonical keys remain mandatory for structured output and persistence so a
    vocabulary change never splits training history.
    """
    settings = get_presentation_settings(db)
    if not settings or not settings.terminology_levels:
        return ""
    rows = []
    for item in settings.terminology_levels:
        if not isinstance(item, dict) or not item.get("label"):
            continue
        label = str(item["label"]).strip()[:60]
        canonical = str(item.get("canonical_zone") or "mixed").strip()[:40]
        description = str(item.get("description") or "No additional definition supplied.").strip()[:500]
        rows.append(f'- "{label}" = internal `{canonical}`. Coach definition: {description}')
    if not rows:
        return ""
    return "\n".join([
        f"COACH INTENSITY / ENERGY LANGUAGE: {settings.terminology_name or 'Custom system'}",
        *rows,
        "COMMUNICATION RULE: In natural-language replies, plans, headings and explanations, use the coach's labels above. "
        "Use a canonical term in parentheses only when it prevents genuine ambiguity or the coach asks for the scientific/internal mapping.",
        "DATA RULE: In JSON fields, tool inputs, database values, calculations and historical aggregation, continue using the exact internal canonical key. "
        "Translate it back into the coach's label when presenting the result.",
        "Do not infer that two coach labels are interchangeable merely because they share an internal equivalent; preserve each supplied definition and context.",
    ])


def coach_zone_label(db: DBSession, canonical_zone: str) -> str:
    key = str(canonical_zone or "").strip().lower()
    if key == "speed":
        key = "sprint"
    settings = get_presentation_settings(db)
    if settings:
        for item in settings.terminology_levels or []:
            if isinstance(item, dict) and item.get("canonical_zone") == key and item.get("label"):
                return str(item["label"])
    return str(canonical_zone or "")
