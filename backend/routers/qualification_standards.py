"""Qualification document extraction, review and deterministic comparison APIs."""
import hashlib
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services import openai_service
from backend.services.claude_service import FAST_MODEL
from backend.services.qualification_service import (
    assessment_summary, normalize_standard, recalculate_standard_set,
)

router = APIRouter()


def _standard_out(row):
    return {
        "id": row.id, "event_name": row.event_name, "canonical_event": row.canonical_event,
        "distance": row.distance, "stroke": row.stroke, "gender": row.gender,
        "age_label": row.age_label, "age_min": row.age_min, "age_max": row.age_max,
        "course": row.course, "standard_type": row.standard_type,
        "time_seconds": row.time_seconds, "time_display": row.time_display,
        "source_page": row.source_page,
    }


def _set_out(row, detail=False):
    counts = {}
    for standard in row.standards:
        counts[standard.standard_type] = counts.get(standard.standard_type, 0) + 1
    result = {
        "id": row.id, "meet_id": row.meet_id, "name": row.name,
        "organiser": row.organiser, "season_label": row.season_label,
        "status": row.status, "rules": row.rules or {},
        "source_filename": row.source_filename, "source_sha256": row.source_sha256,
        "extraction_model": row.extraction_model,
        "extraction_notes": row.extraction_notes or [],
        "standard_count": len(row.standards), "standard_type_counts": counts,
        "assessment_count": len(row.assessments), "created_at": row.created_at,
        "confirmed_at": row.confirmed_at,
    }
    if detail:
        result["standards"] = [_standard_out(s) for s in sorted(
            row.standards, key=lambda s: (s.gender or "", s.age_min or 0, s.distance or 0, s.standard_type),
        )]
    return result


def _get_or_404(set_id: int, db: Session):
    row = db.query(models.QualificationStandardSet).filter(models.QualificationStandardSet.id == set_id).first()
    if not row:
        raise HTTPException(404, "Qualification standards set not found")
    return row


@router.get("")
def list_sets(meet_id: Optional[int] = None, db: Session = Depends(get_db)):
    query = db.query(models.QualificationStandardSet)
    if meet_id is not None:
        query = query.filter(models.QualificationStandardSet.meet_id == meet_id)
    return [_set_out(row) for row in query.order_by(models.QualificationStandardSet.created_at.desc()).all()]


@router.get("/{set_id}")
def get_set(set_id: int, db: Session = Depends(get_db)):
    return _set_out(_get_or_404(set_id, db), detail=True)


@router.post("/extract", status_code=201)
async def extract_document(
    document: UploadFile = File(...),
    meet_id: Optional[int] = Form(default=None),
    db: Session = Depends(get_db),
):
    if meet_id and not db.query(models.Meet).filter(models.Meet.id == meet_id).first():
        raise HTTPException(404, "Meet not found")
    content = await document.read()
    if not content:
        raise HTTPException(422, "The document is empty")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "Qualification document must be 10 MB or smaller")
    mime_type = document.content_type or "application/pdf"
    if mime_type != "application/pdf" and not mime_type.startswith("image/"):
        raise HTTPException(415, "Upload a PDF or image")
    digest = hashlib.sha256(content).hexdigest()
    existing = db.query(models.QualificationStandardSet).filter(
        models.QualificationStandardSet.source_sha256 == digest,
        models.QualificationStandardSet.meet_id == meet_id,
    ).first()
    if existing:
        return _set_out(existing, detail=True)

    extracted = openai_service.parse_qualification_document(content, mime_type)
    metadata, rules = extracted.get("metadata") or {}, extracted.get("rules") or {}
    row = models.QualificationStandardSet(
        meet_id=meet_id, name=metadata.get("name") or document.filename or "Qualification standards",
        organiser=metadata.get("organiser"), season_label=metadata.get("season_label"),
        rules=rules, source_filename=document.filename, source_mime_type=mime_type,
        source_sha256=digest, source_document=content, extraction_model=FAST_MODEL,
        extraction_notes=extracted.get("warnings") or [], status="draft",
    )
    db.add(row)
    db.flush()
    invalid = 0
    for item in extracted.get("standards") or []:
        normalized = normalize_standard(item)
        if not normalized:
            invalid += 1
            continue
        db.add(models.QualificationStandard(standard_set_id=row.id, **normalized))
    if invalid:
        row.extraction_notes = [*(row.extraction_notes or []), f"{invalid} rows had no usable event/time and were skipped."]
    db.commit()
    db.refresh(row)
    return _set_out(row, detail=True)


@router.patch("/{set_id}")
def update_set(set_id: int, body: dict = Body(...), db: Session = Depends(get_db)):
    row = _get_or_404(set_id, db)
    if row.status == "confirmed" and body.get("status") != "draft":
        raise HTTPException(409, "Return this set to draft before editing it")
    for key in {"name", "organiser", "season_label", "meet_id", "rules", "extraction_notes", "status"}:
        if key in body:
            setattr(row, key, body[key])
    db.commit()
    db.refresh(row)
    return _set_out(row, detail=True)


@router.put("/{set_id}/standards")
def replace_standards(set_id: int, body: list[dict] = Body(...), db: Session = Depends(get_db)):
    row = _get_or_404(set_id, db)
    if row.status == "confirmed":
        raise HTTPException(409, "Return this set to draft before editing standards")
    normalized_rows = []
    for item in body:
        normalized = normalize_standard(item)
        if not normalized:
            raise HTTPException(422, f"Invalid standard row: {item}")
        normalized_rows.append(normalized)
    db.query(models.QualificationStandard).filter(
        models.QualificationStandard.standard_set_id == set_id,
    ).delete()
    for item in normalized_rows:
        db.add(models.QualificationStandard(standard_set_id=set_id, **item))
    db.commit()
    db.refresh(row)
    return _set_out(row, detail=True)


@router.post("/{set_id}/confirm")
def confirm_set(set_id: int, db: Session = Depends(get_db)):
    row = _get_or_404(set_id, db)
    if not row.standards:
        raise HTTPException(422, "No standards have been extracted")
    row.status = "confirmed"
    row.confirmed_at = datetime.now(timezone.utc)
    db.commit()
    try:
        result = recalculate_standard_set(set_id, db)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    db.refresh(row)
    return {"standard_set": _set_out(row, detail=True), "comparison": result}


@router.post("/{set_id}/recalculate")
def recalculate(set_id: int, db: Session = Depends(get_db)):
    _get_or_404(set_id, db)
    try:
        return recalculate_standard_set(set_id, db)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/{set_id}/assessments")
def get_assessments(set_id: int, db: Session = Depends(get_db)):
    row = _get_or_404(set_id, db)
    return {"standard_set": _set_out(row), "swimmers": assessment_summary(set_id, db)}


@router.delete("/{set_id}", status_code=204)
def delete_set(set_id: int, db: Session = Depends(get_db)):
    row = _get_or_404(set_id, db)
    db.delete(row)
    db.commit()
