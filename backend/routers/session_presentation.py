import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db
from backend.services.claude_service import FAST_MODEL, create_message, response_text
from backend.services.terminology import CANONICAL_ZONES, DEFAULT_LEVELS


router = APIRouter()

def _default_payload() -> dict:
    return {
        "club_name": "",
        "logo_data_url": None,
        "terminology_name": "LaneWatch energy zones",
        "terminology_levels": DEFAULT_LEVELS,
    }


def _settings_out(row: models.SessionPresentationSettings | None) -> dict:
    if not row:
        return _default_payload()
    return {
        "club_name": row.club_name or "",
        "logo_data_url": row.logo_data_url,
        "terminology_name": row.terminology_name or "Custom system",
        "terminology_levels": row.terminology_levels or [],
        "updated_at": row.updated_at,
    }


def _clean_levels(value) -> list[dict]:
    if not isinstance(value, list) or len(value) > 20:
        raise HTTPException(status_code=422, detail="Terminology levels must be a list of at most 20 items")
    cleaned = []
    seen_ids = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise HTTPException(status_code=422, detail="Each terminology level must be an object")
        label = str(item.get("label") or "").strip()[:60]
        if not label:
            raise HTTPException(status_code=422, detail="Every terminology level needs a label")
        raw_id = str(item.get("id") or label).strip().lower()
        level_id = re.sub(r"[^a-z0-9_-]+", "-", raw_id).strip("-")[:60] or f"level-{index + 1}"
        if level_id in seen_ids:
            level_id = f"{level_id}-{index + 1}"
        seen_ids.add(level_id)
        canonical = str(item.get("canonical_zone") or "").strip().lower()
        if canonical not in CANONICAL_ZONES:
            canonical = "mixed"
        colour = str(item.get("colour") or "#2563eb").strip()
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", colour):
            colour = "#2563eb"
        cleaned.append({
            "id": level_id,
            "label": label,
            "description": str(item.get("description") or "").strip()[:500],
            "colour": colour.lower(),
            "canonical_zone": canonical,
        })
    return cleaned


@router.get("")
def get_settings(db: DBSession = Depends(get_db)):
    return _settings_out(db.query(models.SessionPresentationSettings).first())


@router.put("")
def update_settings(body: dict = Body(...), db: DBSession = Depends(get_db)):
    club_name = str(body.get("club_name") or "").strip()[:100]
    terminology_name = str(body.get("terminology_name") or "Custom system").strip()[:100]
    levels = _clean_levels(body.get("terminology_levels") or [])
    logo = body.get("logo_data_url")
    if logo:
        if not isinstance(logo, str) or not re.match(r"^data:image/(png|jpeg|webp);base64,", logo, re.I):
            raise HTTPException(status_code=422, detail="Logo must be a PNG, JPEG or WebP image")
        if len(logo) > 1_500_000:
            raise HTTPException(status_code=413, detail="Logo is too large; use an image under 1 MB")

    row = db.query(models.SessionPresentationSettings).first()
    if not row:
        row = models.SessionPresentationSettings(id=1)
        db.add(row)
    row.club_name = club_name or None
    row.logo_data_url = logo or None
    row.terminology_name = terminology_name
    row.terminology_levels = levels
    db.commit()
    db.refresh(row)
    return _settings_out(row)


@router.post("/check-equivalencies")
def check_equivalencies(body: dict = Body(...)):
    system_name = str(body.get("terminology_name") or "Custom system").strip()[:100]
    levels = _clean_levels(body.get("terminology_levels") or [])
    if not levels:
        raise HTTPException(status_code=422, detail="Add at least one level before running the AI check")
    source = [{"id": row["id"], "label": row["label"], "description": row["description"]} for row in levels]
    prompt = f"""Map this coach-defined swimming intensity/energy terminology to LaneWatch's stable internal zones.
The coach's definition is authoritative. Use the description and intended training dose, not the label alone.
If a level spans several systems, choose mixed. Kicking is a content category, not an intensity, and should only
be selected when the definition specifically describes kick volume.

SYSTEM NAME: {system_name}
COACH LEVELS: {json.dumps(source, ensure_ascii=False)}
CANONICAL ZONES: {json.dumps(CANONICAL_ZONES)}

Return JSON only as an array with exactly one item per supplied level:
[{{"id":"level-id","canonical_zone":"one exact canonical zone","reason":"one short reason","confidence":"low|moderate|high"}}]"""
    response = create_message(
        model=FAST_MODEL,
        operation="map_energy_terminology",
        max_tokens=min(1800, 160 + len(levels) * 120),
        messages=[{"role": "user", "content": prompt}],
    )
    try:
        raw = response_text(response).strip()
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I | re.S)
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="The AI check did not return a usable mapping") from exc

    by_id = {str(item.get("id")): item for item in parsed if isinstance(item, dict)} if isinstance(parsed, list) else {}
    mappings = []
    for level in levels:
        suggestion = by_id.get(level["id"], {})
        canonical = str(suggestion.get("canonical_zone") or "mixed").lower()
        if canonical not in CANONICAL_ZONES:
            canonical = "mixed"
        mappings.append({
            "id": level["id"],
            "canonical_zone": canonical,
            "reason": str(suggestion.get("reason") or "No reliable rationale returned.")[:300],
            "confidence": str(suggestion.get("confidence") or "low")[:20],
        })
    return {"mappings": mappings, "model": FAST_MODEL}
