from datetime import date, timedelta
import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Body
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.importer import (
    bulk_import_sessions,
    extract_session_xlsx,
    save_session_xlsx_draft,
)
from backend.services import claude_service
from backend.services.availability import availability_on_date
from backend.services.openai_service import parse_whiteboard_photo
from backend.services.cycle_codes import cycle_context, link_session
from backend.services.terminology import coach_terminology_context

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


class SessionCreate(BaseModel):
    date: date
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    squad: Optional[str] = None
    title: Optional[str] = None
    coach_intent: Optional[str] = None
    energy_system_focus: Optional[str] = None
    energy_analysis: Optional[dict] = None
    coach_notes: Optional[str] = None
    groups: Optional[dict] = None   # {1: {description, sets}, 2: ..., 3: ...}
    individual_mods: Optional[dict] = None  # {"swimmer_name": "modification note"}
    pool_slot_id: Optional[int] = None
    status: Optional[str] = 'completed'
    course: Optional[str] = None   # SCM / LCM
    register_group_count: Optional[int] = Field(default=None, ge=1, le=3)
    microcycle_id: Optional[int] = None
    session_sequence: Optional[int] = Field(default=None, ge=1)


class CalendarStart(BaseModel):
    pool_slot_id: int
    date: date


class CalendarCancel(BaseModel):
    date: date
    reason: str
    pool_slot_id: Optional[int] = None
    session_id: Optional[int] = None


class CalendarDismiss(BaseModel):
    date: date
    pool_slot_id: Optional[int] = None
    session_id: Optional[int] = None


class RegisterEntry(BaseModel):
    swimmer_id: int
    attended: bool
    group_planned: Optional[int] = None
    sub_group_planned: Optional[str] = None
    group_done: Optional[int] = None
    sub_group_done: Optional[str] = None
    coach_observation: Optional[str] = None


class RegisterSubmit(BaseModel):
    entries: list[RegisterEntry]
    run_ai: bool = True
    session_complete: bool = True


class ExcelImportConfirm(BaseModel):
    draft: dict
    target_session_id: Optional[int] = None
    generate_predictions: bool = False


# ---------------------------------------------------------------------------
# Sessions CRUD
# ---------------------------------------------------------------------------

def _meaningful_group(content) -> bool:
    if not isinstance(content, dict):
        return False
    if str(content.get("description") or "").strip():
        return True
    sets = content.get("sets")
    if (isinstance(sets, list) and any(str(item or "").strip() for item in sets)) or (
        not isinstance(sets, list) and str(sets or "").strip()
    ):
        return True
    for value in (content.get("volume_breakdown") or {}).values():
        try:
            if float(value or 0) > 0:
                return True
        except (TypeError, ValueError):
            continue
    return False

@router.get("")
def list_sessions(
    squad: Optional[str] = None,
    limit: int = 30,
    offset: int = 0,
    db: DBSession = Depends(get_db),
):
    q = db.query(models.Session).order_by(models.Session.date.desc())
    if squad:
        q = q.filter(models.Session.squad == squad)
    sessions = q.offset(offset).limit(limit).all()
    return [_session_summary(s) for s in sessions]


@router.post("", status_code=201)
def create_session(body: SessionCreate, db: DBSession = Depends(get_db)):
    meaningful_groups = {
        group_num: content for group_num, content in (body.groups or {}).items()
        if _meaningful_group(content)
    }
    session = models.Session(
        date=body.date,
        start_time=body.start_time,
        end_time=body.end_time,
        squad=body.squad,
        title=body.title,
        coach_intent=body.coach_intent,
        energy_system_focus=body.energy_system_focus,
        energy_analysis=body.energy_analysis,
        coach_notes=body.coach_notes,
        planned_content=body.groups,
        individual_mods=body.individual_mods,
        register_group_count=(body.register_group_count if body.register_group_count is not None else (
            len(meaningful_groups) if meaningful_groups else None
        )),
        pool_slot_id=body.pool_slot_id,
        status=body.status or 'completed',
        course=body.course,
        source="manual",
    )
    db.add(session)
    db.flush()
    target_micro = None
    if body.microcycle_id:
        target_micro = db.query(models.Microcycle).filter(models.Microcycle.id == body.microcycle_id).first()
        if not target_micro:
            raise HTTPException(status_code=422, detail="Microcycle not found")
    link_session(session, db, microcycle=target_micro, session_sequence=body.session_sequence)

    if meaningful_groups:
        for group_num, content in meaningful_groups.items():
            sg = models.SessionGroup(
                session_id=session.id,
                group_number=int(group_num),
                description=content.get("description", ""),
                sets={"raw": content.get("sets", "")},
                volume_breakdown=content.get("volume_breakdown") or None,
            )
            db.add(sg)

    db.commit()
    db.refresh(session)
    return _session_detail(session, db)


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------

@router.get("/calendar")
def get_calendar(
    week_start: Optional[date] = None,
    db: DBSession = Depends(get_db),
):
    """
    Returns 7 days from week_start (defaults to current Monday).
    Merges pool slot recurring schedule with existing Session rows.
    Virtual 'planned'/'unlogged' items have no session_id.
    """
    today = date.today()
    if week_start is None:
        dow = today.weekday()
        week_start = today - timedelta(days=dow)

    days = []
    for offset in range(7):
        day_date = week_start + timedelta(days=offset)
        dow = day_date.weekday()

        slots = (
            db.query(models.PoolSlot)
            .filter(models.PoolSlot.day_of_week == dow, models.PoolSlot.active == True)
            .order_by(models.PoolSlot.time)
            .all()
        )
        existing = (
            db.query(models.Session)
            .filter(models.Session.date == day_date)
            .all()
        )
        slot_sessions = {s.pool_slot_id: s for s in existing if s.pool_slot_id}
        unlinked = [s for s in existing if not s.pool_slot_id]

        items = []
        for slot in slots:
            session = slot_sessions.get(slot.id)
            items.append(_calendar_item(day_date, today, slot=slot, session=session, db=db))
        for session in unlinked:
            items.append(_calendar_item(day_date, today, slot=None, session=session, db=db))

        items.sort(key=lambda x: x.get("time") or "99:99")
        days.append({"date": day_date, "day_name": DAY_NAMES[dow], "items": items})

    return days


@router.post("/calendar/start", status_code=201)
def start_calendar_session(body: CalendarStart, db: DBSession = Depends(get_db)):
    """Create (or return existing) a session row for a pool slot on a given date."""
    existing = db.query(models.Session).filter(
        models.Session.pool_slot_id == body.pool_slot_id,
        models.Session.date == body.date,
    ).first()
    if existing:
        if existing.status == "dismissed":
            existing.status = "active"
            db.commit()
            db.refresh(existing)
        return _session_detail(existing, db)

    slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == body.pool_slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")

    session = models.Session(
        date=body.date,
        start_time=slot.time,
        end_time=slot.end_time,
        squad=slot.squad,
        title=slot.label,
        pool_slot_id=body.pool_slot_id,
        course=slot.course,
        status="active",
        source="calendar",
    )
    db.add(session)
    db.flush()
    link_session(session, db)
    db.commit()
    db.refresh(session)
    return _session_detail(session, db)


@router.post("/calendar/cancel", status_code=201)
def cancel_calendar_session(body: CalendarCancel, db: DBSession = Depends(get_db)):
    """Cancel one occurrence while preserving its recurring timetable slot."""
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="A cancellation reason is required")

    if body.session_id:
        session = db.query(models.Session).filter(models.Session.id == body.session_id).first()
        if session:
            if session.date != body.date:
                raise HTTPException(status_code=400, detail="Session date does not match the selected occurrence")
            session.status = "cancelled"
            session.cancel_reason = reason
            db.commit()
            return {"session_id": session.id, "status": "cancelled", "cancel_reason": reason}

    # Reuse an occurrence materialised by a register or import instead of
    # creating a duplicate for the same timetable slot and date.
    if body.pool_slot_id:
        existing = db.query(models.Session).filter(
            models.Session.pool_slot_id == body.pool_slot_id,
            models.Session.date == body.date,
        ).first()
        if existing:
            existing.status = "cancelled"
            existing.cancel_reason = reason
            db.commit()
            return {"session_id": existing.id, "status": "cancelled", "cancel_reason": reason}

    # No existing row — create a cancelled record to preserve the history
    slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == body.pool_slot_id).first() if body.pool_slot_id else None
    session = models.Session(
        date=body.date,
        start_time=slot.time if slot else None,
        end_time=slot.end_time if slot else None,
        squad=slot.squad if slot else None,
        title=slot.label if slot else "Cancelled session",
        pool_slot_id=body.pool_slot_id,
        status="cancelled",
        cancel_reason=reason,
        source="calendar",
    )
    db.add(session)
    db.flush()
    link_session(session, db)
    db.commit()
    db.refresh(session)
    return {"session_id": session.id, "status": "cancelled", "cancel_reason": reason}


@router.post("/calendar/dismiss", status_code=201)
def dismiss_calendar_session(body: CalendarDismiss, db: DBSession = Depends(get_db)):
    """Hide one session occurrence from the home queue without cancelling the timetable slot."""
    session = None
    if body.session_id:
        session = db.query(models.Session).filter(models.Session.id == body.session_id).first()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    elif body.pool_slot_id:
        session = db.query(models.Session).filter(
            models.Session.pool_slot_id == body.pool_slot_id,
            models.Session.date == body.date,
        ).first()

    if session:
        if session.status == "cancelled":
            raise HTTPException(status_code=409, detail="A cancelled session cannot be dismissed")
        session.status = "dismissed"
    else:
        slot = db.query(models.PoolSlot).filter(models.PoolSlot.id == body.pool_slot_id).first()
        if not slot:
            raise HTTPException(status_code=404, detail="Slot not found")
        session = models.Session(
            date=body.date,
            start_time=slot.time,
            end_time=slot.end_time,
            squad=slot.squad,
            title=slot.label,
            pool_slot_id=slot.id,
            course=slot.course,
            status="dismissed",
            source="calendar",
        )
        db.add(session)

    if not session.microcycle_id:
        db.flush()
        link_session(session, db)

    db.commit()
    db.refresh(session)
    return {"session_id": session.id, "status": session.status}


@router.get("/{session_id}")
def get_session(session_id: int, db: DBSession = Depends(get_db)):
    session = _get_or_404(session_id, db)
    return _session_detail(session, db)


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: int, db: DBSession = Depends(get_db)):
    session = _get_or_404(session_id, db)
    db.query(models.SessionEntry).filter(models.SessionEntry.session_id == session_id).delete()
    db.query(models.SessionGroup).filter(models.SessionGroup.session_id == session_id).delete()
    db.query(models.AIAnalysis).filter(models.AIAnalysis.session_id == session_id).delete()
    db.query(models.SwimmerObservation).filter(models.SwimmerObservation.session_id == session_id).delete()
    db.delete(session)
    db.commit()


@router.put("/{session_id}")
def update_session(
    session_id: int,
    body: dict = Body(...),
    db: DBSession = Depends(get_db),
):
    session = _get_or_404(session_id, db)
    allowed = {"title", "coach_intent", "energy_system_focus", "coach_notes", "squad", "start_time", "end_time", "status", "cancel_reason", "course"}
    for k, v in body.items():
        if k in allowed:
            setattr(session, k, v)
    if "register_group_count" in body:
        count = body["register_group_count"]
        if count is not None and count not in (1, 2, 3):
            raise HTTPException(status_code=422, detail="Register group count must be 1, 2 or 3")
        session.register_group_count = count
    if "microcycle_id" in body or "session_sequence" in body:
        microcycle_id = body.get("microcycle_id", session.microcycle_id)
        micro = db.query(models.Microcycle).filter(models.Microcycle.id == microcycle_id).first() if microcycle_id else None
        if microcycle_id and not micro:
            raise HTTPException(status_code=422, detail="Microcycle not found")
        if not micro:
            session.microcycle_id = None
            session.session_sequence = None
            session.cycle_code = None
        else:
            sequence = body.get("session_sequence", session.session_sequence)
            if sequence is not None and (not isinstance(sequence, int) or sequence < 1):
                raise HTTPException(status_code=422, detail="Session sequence must be a positive integer")
            link_session(session, db, microcycle=micro, session_sequence=sequence)
    # Allow updating group volume_breakdown per group
    if "groups" in body:
        groups = db.query(models.SessionGroup).filter(models.SessionGroup.session_id == session_id).all()
        group_map = {g.group_number: g for g in groups}
        for group_num_str, content in body["groups"].items():
            gnum = int(group_num_str)
            if gnum in group_map and "volume_breakdown" in content:
                group_map[gnum].volume_breakdown = content["volume_breakdown"] or None
    db.commit()
    return _session_detail(session, db)


# ---------------------------------------------------------------------------
# Excel import
# ---------------------------------------------------------------------------

def _match_excel_import_target(draft: dict, db: DBSession) -> tuple[Optional[dict], list[str]]:
    """Attach an extracted draft to one unambiguous active recurring slot."""
    warnings = []
    try:
        session_date = date.fromisoformat(str(draft.get("date")))
    except (TypeError, ValueError):
        return None, ["The extracted date is invalid, so no timetable slot was matched."]
    start_time = draft.get("start_time")
    if not start_time:
        return None, warnings

    slots = db.query(models.PoolSlot).filter(
        models.PoolSlot.day_of_week == session_date.weekday(),
        models.PoolSlot.time == start_time,
        models.PoolSlot.active == True,
    ).all()
    if len(slots) != 1:
        if len(slots) > 1:
            warnings.append(
                f"More than one timetable slot starts at {start_time}; select the intended session before saving."
            )
        else:
            warnings.append(
                f"No active {session_date.strftime('%A')} timetable slot starts at {start_time}; "
                "the import will create an unlinked session."
            )
        return None, warnings

    slot = slots[0]
    existing = db.query(models.Session).filter(
        models.Session.date == session_date,
        models.Session.pool_slot_id == slot.id,
    ).first()
    if existing and existing.status == "cancelled":
        warnings.append("The matching timetable occurrence is cancelled; it cannot be overwritten.")
        return {
            "session_id": existing.id, "pool_slot_id": slot.id, "label": slot.label,
            "date": session_date, "time": slot.time, "status": "cancelled", "can_import": False,
        }, warnings

    draft["pool_slot_id"] = slot.id
    draft["squad"] = draft.get("squad") or slot.squad
    draft["course"] = draft.get("course") or slot.course
    return {
        "session_id": existing.id if existing else None,
        "pool_slot_id": slot.id,
        "label": slot.label,
        "date": session_date,
        "time": slot.time,
        "status": (existing.status if existing else "scheduled"),
        "can_import": True,
    }, warnings


@router.post("/import/excel")
async def import_excel(
    file: UploadFile = File(...),
    ai_check: bool = Form(False),
    expected_date: Optional[date] = Form(None),
    expected_pool_slot_id: Optional[int] = Form(None),
    expected_session_id: Optional[int] = Form(None),
    db: DBSession = Depends(get_db),
):
    content = await file.read()
    try:
        result = extract_session_xlsx(content, file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    suggested_target, matching_warnings = _match_excel_import_target(result["draft"], db)
    result["suggested_target"] = suggested_target
    result["warnings"].extend(matching_warnings)
    result["context_match"] = True
    if expected_date and result["draft"].get("date") != expected_date.isoformat():
        result["context_match"] = False
        result["warnings"].append(
            f"This upload was opened for {expected_date.isoformat()}, but the workbook is dated "
            f"{result['draft'].get('date')}. Go back and choose the matching workbook."
        )
    if expected_pool_slot_id and (
        not suggested_target or suggested_target.get("pool_slot_id") != expected_pool_slot_id
    ):
        result["context_match"] = False
        result["warnings"].append(
            "The workbook time does not match the timetable session selected from the home dashboard."
        )
    if expected_session_id and (
        not suggested_target or suggested_target.get("session_id") != expected_session_id
    ):
        result["context_match"] = False
        result["warnings"].append(
            "The workbook does not match the existing session selected from the home dashboard."
        )
    result["ai_review"] = None
    result["ai_energy_analysis"] = None
    if ai_check:
        try:
            analysis = claude_service.analyse_session_energy(result["draft"], coach_terminology_context(db))
            result["ai_review"] = analysis.pop("review", None)
            claude_service.apply_energy_analysis_to_draft(result["draft"], analysis)
            result["ai_energy_analysis"] = analysis
        except Exception:
            result["warnings"].append(
                "The optional AI consistency and energy analysis was unavailable; deterministic extraction still completed and you can generate the dose estimate later."
            )
    return result


@router.post("/import/excel/confirm", status_code=201)
def confirm_excel_import(body: ExcelImportConfirm, db: DBSession = Depends(get_db)):
    try:
        session = save_session_xlsx_draft(body.draft, db, body.target_session_id)
    except (TypeError, ValueError) as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    prediction_count = 0
    intelligence_error = None
    if body.generate_predictions:
        try:
            prediction_count = len(claude_service.generate_session_predictions(session, db))
            db.commit()
            db.refresh(session)
        except Exception as exc:
            db.rollback()
            session = _get_or_404(session.id, db)
            intelligence_error = str(exc)
    payload = _session_detail(session, db)
    payload["intelligence"] = {
        "prediction_count": prediction_count,
        "error": intelligence_error,
    }
    return payload


@router.post("/import/excel/bulk", status_code=201)
async def import_excel_bulk(
    files: list[UploadFile] = File(...),
    db: DBSession = Depends(get_db),
):
    pairs = [(f.filename, await f.read()) for f in files]
    result = bulk_import_sessions(pairs, db)
    return result


# ---------------------------------------------------------------------------
# Photo (whiteboard) import
# ---------------------------------------------------------------------------

@router.post("/import/photo", status_code=201)
async def import_photo(
    file: UploadFile = File(...),
    session_date: Optional[str] = Form(None),
    squad: Optional[str] = Form(None),
    db: DBSession = Depends(get_db),
):
    content = await file.read()
    mime = file.content_type or "image/jpeg"

    extracted = parse_whiteboard_photo(content, mime)

    parsed_date = None
    if session_date:
        from datetime import datetime
        for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
            try:
                parsed_date = datetime.strptime(session_date, fmt).date()
                break
            except ValueError:
                continue
    if not parsed_date and extracted.get("date"):
        from datetime import datetime
        try:
            parsed_date = datetime.strptime(extracted["date"], "%d/%m/%Y").date()
        except ValueError:
            pass

    session = models.Session(
        date=parsed_date,
        squad=squad,
        title=extracted.get("title"),
        planned_content=extracted.get("groups"),
        energy_system_focus=extracted.get("energy_system_focus"),
        coach_notes=extracted.get("notes"),
        register_group_count=(len(extracted.get("groups") or {}) or None),
        source="photo",
    )
    db.add(session)
    db.flush()
    link_session(session, db)

    for group_num, content_data in (extracted.get("groups") or {}).items():
        sg = models.SessionGroup(
            session_id=session.id,
            group_number=int(group_num),
            description=content_data.get("description", ""),
            sets={"raw": content_data.get("sets", "")},
        )
        db.add(sg)

    db.commit()
    return {"session_id": session.id, "extracted": extracted}


# ---------------------------------------------------------------------------
# Session intelligence: prescribed dose + pre-session swimmer questions
# ---------------------------------------------------------------------------

@router.post("/{session_id}/intelligence")
def generate_session_intelligence(
    session_id: int,
    body: dict = Body(default={}),
    db: DBSession = Depends(get_db),
):
    session = _get_or_404(session_id, db)
    refresh_energy = bool(body.get("refresh_energy"))
    swimmer_ids = body.get("swimmer_ids")

    if refresh_energy or not session.energy_analysis:
        draft = {
            "title": session.title,
            "coach_intent": session.coach_intent,
            "groups": {
                str(group.group_number): {
                    "description": group.description,
                    "sets": (group.sets or {}).get("raw") if isinstance(group.sets, dict) else group.sets,
                    "items": (group.sets or {}).get("items") if isinstance(group.sets, dict) else None,
                    "volume_breakdown": group.volume_breakdown,
                }
                for group in session.groups
            },
        }
        analysis = claude_service.analyse_session_energy(draft, coach_terminology_context(db))
        analysis.pop("review", None)
        claude_service.apply_energy_analysis_to_draft(draft, analysis)
        session.energy_analysis = analysis
        session.energy_system_focus = analysis.get("energy_system_focus") or session.energy_system_focus
        for group in session.groups:
            content = (draft.get("groups") or {}).get(str(group.group_number)) or {}
            if content.get("volume_breakdown"):
                group.volume_breakdown = content["volume_breakdown"]

    predictions = claude_service.generate_session_predictions(session, db, swimmer_ids=swimmer_ids)
    db.commit()
    db.refresh(session)
    return {
        "session": _session_detail(session, db),
        "predictions": predictions,
        "prediction_count": len(predictions),
    }


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------

@router.get("/{session_id}/register")
def get_register(session_id: int, db: DBSession = Depends(get_db)):
    """Return all active swimmers with existing entries pre-populated."""
    session = _get_or_404(session_id, db)
    # Normal slot assignments are planning hints, never a register boundary.
    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.status == "active",
    ).order_by(models.Swimmer.name).all()
    swimmer_ids = [swimmer.id for swimmer in swimmers]
    usual_swimmer_ids = set()
    if session.pool_slot_id:
        usual_swimmer_ids = {
            row[0] for row in db.query(models.SwimmerSlot.swimmer_id).filter(
                models.SwimmerSlot.pool_slot_id == session.pool_slot_id,
            ).all()
        }
    unavailable = availability_on_date(db, swimmer_ids, session.date)
    existing_entries = {
        e.swimmer_id: e
        for e in db.query(models.SessionEntry).filter(models.SessionEntry.session_id == session_id).all()
    }
    # Build planned group from macro group_definitions (primary source)
    planned_group_map = {}   # swimmer_id -> group_number
    planned_subgroup_map = {}  # swimmer_id -> sub_group_label

    # Look up current macro covering this session's date
    current_macro = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_from <= session.date,
        models.TrainingMacro.date_to >= session.date,
    ).order_by(models.TrainingMacro.date_from).first()
    if current_macro and current_macro.group_definitions:
        for g_label, defn in current_macro.group_definitions.items():
            # Map "G1" -> 1, "G2" -> 2, etc.
            try:
                g_num = int(g_label.replace("G", "").replace("g", ""))
            except ValueError:
                continue
            for sid in (defn.get("swimmer_ids") or []):
                planned_group_map[sid] = g_num

    # Also pull sub-group pre-assignment from session sub_groups (finer detail)
    for g in (session.groups or []):
        for sg in (g.sub_groups or []):
            for sid in (sg.swimmer_ids or []):
                if sid not in planned_group_map:
                    planned_group_map[sid] = g.group_number
                planned_subgroup_map[sid] = sg.label

    result = []
    for s in swimmers:
        e = existing_entries.get(s.id)
        availability = unavailable.get(s.id)
        result.append({
            "swimmer_id": s.id,
            "swimmer_name": s.name,
            "squad": s.squad,
            "attended": e.attended if e else None,
            "usual_for_slot": s.id in usual_swimmer_ids,
            "exception_reason": availability.get("reason") if availability else None,
            "availability": ({
                **availability,
                "date_from": availability["date_from"].isoformat(),
                "date_to": availability["date_to"].isoformat(),
            } if availability else None),
            "group_planned": (e.group_planned if e and e.group_planned else planned_group_map.get(s.id)),
            "sub_group_planned": (e.sub_group_planned if e and e.sub_group_planned else planned_subgroup_map.get(s.id)),
            "group_done": e.group_done if e else None,
            "sub_group_done": e.sub_group_done if e else None,
            "coach_observation": e.coach_observation if e else None,
            "ai_characterisation": _decode_ai_json(e.ai_characterisation) if e else None,
            "ai_expected_response": _decode_ai_json(e.ai_expected_response) if e else None,
            "entry_id": e.id if e else None,
        })
    return result


@router.put("/{session_id}/register")
def submit_register(
    session_id: int,
    body: RegisterSubmit,
    db: DBSession = Depends(get_db),
):
    """Submit attendance + observations. Optionally triggers AI characterisation."""
    session = _get_or_404(session_id, db)

    results = []
    for entry_data in body.entries:
        swimmer = db.query(models.Swimmer).filter(
            models.Swimmer.id == entry_data.swimmer_id
        ).first()
        if not swimmer:
            continue

        # Upsert entry
        existing = db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session_id,
            models.SessionEntry.swimmer_id == entry_data.swimmer_id,
        ).first()

        if existing:
            entry = existing
        else:
            entry = models.SessionEntry(session_id=session_id, swimmer_id=swimmer.id)
            db.add(entry)

        entry.attended = entry_data.attended
        entry.group_planned = entry_data.group_planned
        entry.sub_group_planned = entry_data.sub_group_planned
        entry.group_done = entry_data.group_done
        entry.sub_group_done = entry_data.sub_group_done
        entry.coach_observation = entry_data.coach_observation
        db.flush()

        # Mirror coach observation into swimmer observation log
        if entry_data.attended and entry_data.coach_observation and entry_data.coach_observation.strip():
            _energy_to_obs = {
                'aerobic': 'aerobic', 'threshold': 'threshold',
                'vo2': 'vo2', 'vo2max': 'vo2',
                'speed': 'speed', 'sprint': 'speed',
                'recovery': 'recovery',
            }
            obs_type = _energy_to_obs.get(
                (session.energy_system_focus or '').lower(), 'general'
            )
            existing_obs = db.query(models.SwimmerObservation).filter(
                models.SwimmerObservation.swimmer_id == swimmer.id,
                models.SwimmerObservation.session_id == session_id,
            ).first()
            if existing_obs:
                existing_obs.content = entry_data.coach_observation.strip()
                existing_obs.obs_type = obs_type
                if entry.ai_characterisation and not entry.ai_characterisation.startswith('[AI error'):
                    existing_obs.ai_summary = entry.ai_characterisation
            else:
                new_obs = models.SwimmerObservation(
                    swimmer_id=swimmer.id,
                    session_id=session_id,
                    obs_type=obs_type,
                    date=session.date,
                    content=entry_data.coach_observation.strip(),
                    ai_summary=entry.ai_characterisation if (
                        entry.ai_characterisation and not entry.ai_characterisation.startswith('[AI error')
                    ) else None,
                )
                db.add(new_obs)

        results.append({
            "swimmer_id": swimmer.id,
            "swimmer_name": swimmer.name,
            "attended": entry.attended,
            "ai_characterisation": entry.ai_characterisation,
            "ai_expected_response": _decode_ai_json(entry.ai_expected_response),
        })

    entry_rows = db.query(models.SessionEntry).filter(
        models.SessionEntry.session_id == session_id,
    ).all()
    entry_by_swimmer = {row.swimmer_id: row for row in entry_rows}

    # Predictions are generated once in a batch and cached. At register time
    # they remain hypotheses/questions; only the coach supplies observations.
    if body.run_ai:
        attended_ids = [row.swimmer_id for row in body.entries if row.attended]
        try:
            claude_service.generate_session_predictions(session, db, swimmer_ids=attended_ids)
        except Exception as exc:
            for result in results:
                if result["swimmer_id"] in attended_ids:
                    result["prediction_error"] = str(exc)

    # Only interpret response after the coach explicitly finishes the session.
    if body.run_ai and body.session_complete:
        try:
            assessments = claude_service.characterise_session_entries_batch(session, entry_rows, db)
            for swimmer_id, assessment in assessments.items():
                entry = entry_by_swimmer.get(swimmer_id)
                if not entry:
                    continue
                encoded = json.dumps(assessment, ensure_ascii=False)
                entry.ai_characterisation = encoded
                db.query(models.AIAnalysis).filter(
                    models.AIAnalysis.swimmer_id == swimmer_id,
                    models.AIAnalysis.session_id == session_id,
                    models.AIAnalysis.analysis_type == "session_response",
                ).delete()
                db.add(models.AIAnalysis(
                    swimmer_id=swimmer_id,
                    session_id=session_id,
                    analysis_type="session_response",
                    content=encoded,
                    model_used=claude_service.FAST_MODEL,
                ))
                observation = db.query(models.SwimmerObservation).filter(
                    models.SwimmerObservation.swimmer_id == swimmer_id,
                    models.SwimmerObservation.session_id == session_id,
                ).first()
                if observation:
                    observation.ai_summary = assessment.get("observed_response") or assessment.get("next_session_action")
        except Exception as exc:
            for result in results:
                entry = entry_by_swimmer.get(result["swimmer_id"])
                if entry and entry.attended and (entry.coach_observation or "").strip():
                    result["assessment_error"] = str(exc)

    for result in results:
        entry = entry_by_swimmer.get(result["swimmer_id"])
        if entry:
            result["ai_expected_response"] = _decode_ai_json(entry.ai_expected_response)
            result["ai_characterisation"] = _decode_ai_json(entry.ai_characterisation)

    # Create SwimmerSessionLoad records for attended swimmers
    for entry_data in body.entries:
        if not body.session_complete:
            continue
        if not entry_data.attended or not entry_data.group_done:
            db.query(models.SwimmerSessionLoad).filter(
                models.SwimmerSessionLoad.swimmer_id == entry_data.swimmer_id,
                models.SwimmerSessionLoad.session_id == session_id,
            ).delete()
            continue
        group = next((g for g in session.groups if g.group_number == entry_data.group_done), None)
        if not group:
            continue

        # Resolve volume: prefer sub-group breakdown, fall back to group-level breakdown
        volume = None
        sub_label = None
        if group.sub_groups:
            if entry_data.sub_group_done:
                sub = next((sg for sg in group.sub_groups if sg.label == entry_data.sub_group_done), None)
            else:
                sub = next(
                    (sg for sg in group.sub_groups if entry_data.swimmer_id in (sg.swimmer_ids or [])),
                    group.sub_groups[0] if group.sub_groups else None,
                )
            if sub and sub.volume_breakdown:
                volume = sub.volume_breakdown
                sub_label = sub.label

        if not volume and group.volume_breakdown:
            volume = group.volume_breakdown

        if not volume:
            continue

        existing_load = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.swimmer_id == entry_data.swimmer_id,
            models.SwimmerSessionLoad.session_id == session_id,
        ).first()
        if existing_load:
            existing_load.volume_breakdown = volume
            existing_load.sub_group_label = sub_label
        else:
            db.add(models.SwimmerSessionLoad(
                swimmer_id=entry_data.swimmer_id,
                session_id=session_id,
                session_date=session.date,
                group_number=entry_data.group_done,
                sub_group_label=sub_label,
                volume_breakdown=volume,
            ))

    # Attendance may be taken at the start. Completion is a separate coach
    # action after observations can be recorded.
    if body.session_complete:
        session.status = "completed"
    elif session.status != "completed":
        session.status = "active"
    db.commit()
    return results


# ---------------------------------------------------------------------------
# Observation text parser
# ---------------------------------------------------------------------------

@router.post("/{session_id}/parse-observations")
def parse_observations(
    session_id: int,
    body: dict = Body(...),
    db: DBSession = Depends(get_db),
):
    """
    Parse free-text observation notes into per-swimmer entries.
    Creates/updates SessionEntry.coach_observation for each swimmer matched.
    """
    session = _get_or_404(session_id, db)
    text = (body.get("text") or "").strip()
    if not text:
        return []

    swimmers = db.query(models.Swimmer).filter(models.Swimmer.active == True).order_by(models.Swimmer.name).all()
    parsed = claude_service.parse_observations_text(text, swimmers, db)

    results = []
    for item in parsed:
        swimmer_id = item.get("swimmer_id")
        observation = item.get("observation")
        if not swimmer_id or not observation:
            continue

        existing = db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session_id,
            models.SessionEntry.swimmer_id == swimmer_id,
        ).first()

        if existing:
            existing.coach_observation = observation
        else:
            entry = models.SessionEntry(
                session_id=session_id,
                swimmer_id=swimmer_id,
                coach_observation=observation,
            )
            db.add(entry)

        swimmer = next((s for s in swimmers if s.id == swimmer_id), None)
        results.append({
            "swimmer_id": swimmer_id,
            "swimmer_name": swimmer.name if swimmer else str(swimmer_id),
            "observation": observation,
        })

    db.commit()
    return results


# ---------------------------------------------------------------------------
# Group recommendations
# ---------------------------------------------------------------------------

@router.post("/{session_id}/recommend-groups")
def recommend_groups(session_id: int, db: DBSession = Depends(get_db)):
    session = _get_or_404(session_id, db)
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.active == True).all()
    recommendations = claude_service.recommend_groups(session, swimmers, db)
    return recommendations


# ---------------------------------------------------------------------------
# Session planner
# ---------------------------------------------------------------------------

@router.post("/plan")
def plan_session(body: dict = Body(...), db: DBSession = Depends(get_db)):
    """
    Parse a free-text session description and return a structured plan + AI analysis.
    Pulls expected swimmers from schedule for the given date/squad.
    """
    from backend.routers.coaching_context import get_current_coaching_context
    from datetime import date as date_type

    text = body.get("text", "").strip()
    date_str = body.get("date")
    squad = body.get("squad")

    if not text:
        raise HTTPException(400, "Session text required")

    # Resolve expected swimmers from schedule
    expected_swimmers = []
    if date_str:
        try:
            d = date_type.fromisoformat(date_str)
            day_of_week = d.weekday()  # 0=Mon … 6=Sun
            slots_q = db.query(models.PoolSlot).filter(
                models.PoolSlot.day_of_week == day_of_week,
                models.PoolSlot.active == True,
            )
            if squad:
                slots_q = slots_q.filter(models.PoolSlot.squad == squad)
            slots = slots_q.all()

            slot_ids = [slot.id for slot in slots]
            swimmer_ids = {
                swimmer_id for swimmer_id, in db.query(models.SwimmerSlot.swimmer_id).filter(
                    models.SwimmerSlot.pool_slot_id.in_(slot_ids)
                ).all()
            } if slot_ids else set()
            swimmer_ids.difference_update(availability_on_date(db, swimmer_ids, d))

            if swimmer_ids:
                swimmers = db.query(models.Swimmer).filter(
                    models.Swimmer.id.in_(swimmer_ids),
                    models.Swimmer.active == True,
                ).order_by(models.Swimmer.name).all()
                expected_swimmers = [{"id": s.id, "name": s.name} for s in swimmers]
        except (TypeError, ValueError):
            raise HTTPException(400, "Date must use YYYY-MM-DD format")

    coaching_context = get_current_coaching_context(db)

    result = claude_service.plan_and_analyse_session(
        session_text=text,
        date_str=date_str,
        squad=squad,
        expected_swimmers=expected_swimmers,
        coaching_context=coaching_context,
        db=db,
    )
    parsed = result.get("parsed") or {}
    planned_groups = {}
    group_items = list((parsed.get("groups") or {}).items())
    for index, (key, group) in enumerate(group_items):
        lines = []
        if index == 0 and parsed.get("warm_up"):
            lines.append(f"Warm up: {parsed['warm_up']}")
        lines.extend(group.get("sets") or [])
        if index == len(group_items) - 1 and parsed.get("cool_down"):
            lines.append(f"Cool down: {parsed['cool_down']}")
        planned_groups[str(key)] = {
            "description": group.get("label") or f"Group {key}",
            "sets": "\n".join(lines),
            "items": [],
        }

    draft = {
        "date": date_str,
        "title": parsed.get("title"),
        "coach_intent": parsed.get("coach_intent") or result.get("plan_alignment"),
        "groups": planned_groups,
        "source": "ai_planner",
    }
    try:
        analysis = claude_service.analyse_session_energy(draft, coach_terminology_context(db))
        claude_service.apply_energy_analysis_to_draft(draft, analysis)
        result["energy_analysis"] = analysis
        parsed["energy_focus"] = analysis.get("energy_system_focus") or parsed.get("energy_focus")
        if analysis.get("total_metres"):
            parsed["total_volume_m"] = f"{analysis['total_metres']}m"
        for key, group in (parsed.get("groups") or {}).items():
            analysed = planned_groups.get(str(key)) or {}
            group["volume_breakdown"] = analysed.get("volume_breakdown") or {}
            group["total_metres"] = analysed.get("total_metres")
    except Exception as exc:
        result["analysis_warning"] = f"The plan was created, but its zone breakdown could not be estimated: {exc}"
    result["expected_swimmers"] = expected_swimmers
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _effective_pool_config(slot, day_date: date) -> Optional[str]:
    """Return the actual pool config for a slot on a given date, handling alternating ends."""
    if not slot or not slot.pool_config:
        return None
    if not slot.alternate_ends:
        return slot.pool_config
    week_num = day_date.isocalendar()[1]
    opposite = {"deep_end": "shallow_end", "shallow_end": "deep_end"}
    return slot.pool_config if week_num % 2 == 1 else opposite.get(slot.pool_config, slot.pool_config)


def _get_or_404(session_id: int, db: DBSession) -> models.Session:
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _decode_ai_json(value):
    if not value or not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value


def _session_summary(s: models.Session) -> dict:
    context = cycle_context(s)
    return {
        "id": s.id,
        "date": s.date,
        "start_time": s.start_time,
        "end_time": s.end_time,
        "squad": s.squad,
        "title": s.title or (s.pool_slot.label if s.pool_slot else None),
        "source": s.source,
        "energy_system_focus": s.energy_system_focus,
        "energy_analysis": s.energy_analysis,
        "coach_intent": s.coach_intent,
        "status": s.status or "completed",
        "pool_slot_id": s.pool_slot_id,
        "cancel_reason": s.cancel_reason,
        "course": s.course,
        "register_group_count": s.register_group_count,
        "microcycle_id": s.microcycle_id,
        "session_sequence": s.session_sequence,
        "cycle_code": s.cycle_code,
        "cycle_context": context,
    }


def _calendar_item(day_date: date, today: date, slot, session, db: DBSession) -> dict:
    if session:
        status = session.status or "completed"
    elif day_date > today:
        status = "planned"
    else:
        status = "unlogged"

    entry_count = None
    registered = False
    groups = []
    if session and status in ("active", "completed"):
        entry_count = db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session.id,
            models.SessionEntry.attended == True,
        ).count()
        registered = db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session.id,
            models.SessionEntry.attended.isnot(None),
        ).count() > 0
    if session:
        groups = [
            {
                "group_number": group.group_number,
                "description": group.description,
                "sets": (group.sets or {}).get("raw") if isinstance(group.sets, dict) else None,
                "volume_breakdown": group.volume_breakdown,
            }
            for group in sorted(session.groups or [], key=lambda row: row.group_number)
        ]

    return {
        "slot_id": slot.id if slot else None,
        "session_id": session.id if session else None,
        "status": status,
        "label": (slot.label if slot else None) or (session.title if session else "Session"),
        "time": (session.start_time if session else None) or (slot.time if slot else None),
        "end_time": (session.end_time if session else None) or (slot.end_time if slot else None),
        "squad": (session.squad if session else None) or (slot.squad if slot else None),
        "title": session.title if session else None,
        "cancel_reason": session.cancel_reason if session else None,
        "entry_count": entry_count,
        "registered": registered,
        "coach_intent": session.coach_intent if session else None,
        "coach_notes": session.coach_notes if session else None,
        "individual_mods": session.individual_mods if session else None,
        "groups": groups,
        "register_group_count": session.register_group_count if session else None,
        "has_plan": bool(session and (
            session.coach_intent or session.coach_notes or session.planned_content or groups
        )),
        "course": (session.course if session else None) or (slot.course if slot else None),
        "lanes": slot.lanes if slot else None,
        "has_blocks": slot.has_blocks if slot else None,
        "pool_config": _effective_pool_config(slot, day_date),
        "alternate_ends": slot.alternate_ends if slot else False,
        "cycle_code": session.cycle_code if session else None,
        "cycle_context": cycle_context(session) if session else None,
    }


def _session_detail(s: models.Session, db: DBSession) -> dict:
    groups = db.query(models.SessionGroup).filter(models.SessionGroup.session_id == s.id).all()
    return {
        **_session_summary(s),
        "coach_notes": s.coach_notes,
        "planned_content": s.planned_content,
        "individual_mods": s.individual_mods,
        "groups": [
            {
                "id": g.id,
                "group_number": g.group_number,
                "description": g.description,
                "sets": g.sets,
                "volume_breakdown": g.volume_breakdown,
                "target_swimmer_ids": g.target_swimmer_ids,
                "sub_groups": [
                    {
                        "id": sg.id,
                        "label": sg.label,
                        "aim": sg.aim,
                        "sets": sg.sets,
                        "swimmer_ids": sg.swimmer_ids,
                        "volume_breakdown": sg.volume_breakdown,
                    }
                    for sg in (g.sub_groups or [])
                ],
            }
            for g in sorted(groups, key=lambda g: g.group_number)
        ],
    }
