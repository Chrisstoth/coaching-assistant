"""Coach-controlled planning intelligence and persistent assistant inbox."""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.services.planning_engine import (
    compact_context,
    record_recommendation_event,
    refresh_all_macros,
    refresh_macro,
)

router = APIRouter()


class SeasonIn(BaseModel):
    name: str
    squad: Optional[str] = None
    date_from: date
    date_to: date
    narrative: Optional[str] = None
    is_current: bool = True


class PathwayIn(BaseModel):
    macro_id: int
    name: str
    colour: str = "teal"
    objective: Optional[str] = None
    primary_meet_id: Optional[int] = None
    qualifier_meet_ids: list[int] = Field(default_factory=list)
    fallback_meet_id: Optional[int] = None
    qualification_standard_set_id: Optional[int] = None
    phase_config: Optional[dict] = None
    active: bool = True


class PathwayUpdate(BaseModel):
    name: Optional[str] = None
    colour: Optional[str] = None
    objective: Optional[str] = None
    primary_meet_id: Optional[int] = None
    qualifier_meet_ids: Optional[list[int]] = None
    fallback_meet_id: Optional[int] = None
    qualification_standard_set_id: Optional[int] = None
    phase_config: Optional[dict] = None
    active: Optional[bool] = None


class MembershipIn(BaseModel):
    swimmer_id: int
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    qualification_status: str = "unknown"
    notes: Optional[str] = None
    active: bool = True


class RefreshIn(BaseModel):
    macro_id: int
    as_of_date: Optional[date] = None


class RecommendationUpdate(BaseModel):
    status: Optional[str] = None
    follow_up_at: Optional[datetime] = None
    coach_note: Optional[str] = None


def _season_out(row):
    return {
        "id": row.id, "name": row.name, "squad": row.squad,
        "date_from": row.date_from.isoformat(), "date_to": row.date_to.isoformat(),
        "narrative": row.narrative, "is_current": row.is_current,
        "macro_ids": [m.id for m in row.macros],
    }


def _pathway_out(row):
    return {
        "id": row.id, "macro_id": row.macro_id, "name": row.name, "colour": row.colour,
        "objective": row.objective, "primary_meet_id": row.primary_meet_id,
        "primary_meet": row.primary_meet.name if row.primary_meet else None,
        "qualifier_meet_ids": row.qualifier_meet_ids or [],
        "fallback_meet_id": row.fallback_meet_id,
        "fallback_meet": row.fallback_meet.name if row.fallback_meet else None,
        "qualification_standard_set_id": row.qualification_standard_set_id,
        "qualification_standard_set": row.qualification_standard_set.name if row.qualification_standard_set else None,
        "phase_config": row.phase_config, "active": row.active,
        "members": [{
            "id": m.id, "swimmer_id": m.swimmer_id, "swimmer": m.swimmer.name,
            "qualification_status": m.qualification_status, "notes": m.notes,
            "date_from": m.date_from.isoformat() if m.date_from else None,
            "date_to": m.date_to.isoformat() if m.date_to else None, "active": m.active,
        } for m in row.memberships],
    }


def _action_destination(row) -> str:
    action = (row.proposed_action or {}).get("action")
    meet_id = (row.proposed_action or {}).get("meet_id") or (row.evidence or {}).get("meet_id")
    if action == "add_meet_entries" and meet_id:
        return f"/meets/{meet_id}"
    return "/season"


def _recommendation_out(row, db: Optional[Session] = None, include_events: bool = False):
    output = {
        "id": row.id, "macro_id": row.macro_id, "pathway_id": row.pathway_id,
        "swimmer_id": row.swimmer_id, "kind": row.kind, "severity": row.severity,
        "title": row.title, "detail": row.detail, "evidence": row.evidence,
        "proposed_action": row.proposed_action, "status": row.status,
        "created_at": row.created_at, "updated_at": row.updated_at,
        "last_seen_at": row.last_seen_at, "follow_up_at": row.follow_up_at,
        "accepted_at": row.accepted_at, "actioned_at": row.actioned_at,
        "resolved_at": row.resolved_at, "occurrence_count": row.occurrence_count or 1,
        "coach_note": row.coach_note, "discussion_thread_id": row.discussion_thread_id,
        "action_destination": _action_destination(row),
    }
    if db is not None:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == row.macro_id).first() if row.macro_id else None
        pathway = db.query(models.PlanningPathway).filter(models.PlanningPathway.id == row.pathway_id).first() if row.pathway_id else None
        swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == row.swimmer_id).first() if row.swimmer_id else None
        output.update({
            "macro_name": macro.name if macro else None,
            "pathway_name": pathway.name if pathway else None,
            "swimmer_name": swimmer.name if swimmer else None,
        })
    if include_events:
        output["history"] = [{
            "id": event.id, "event_type": event.event_type,
            "detail": event.detail, "created_at": event.created_at,
        } for event in row.events]
    return output


@router.get("/seasons")
def list_seasons(db: Session = Depends(get_db)):
    return [_season_out(s) for s in db.query(models.Season).order_by(models.Season.date_from).all()]


@router.get("/seasons/current")
def current_season(db: Session = Depends(get_db)):
    row = db.query(models.Season).filter(
        models.Season.is_current.is_(True),
    ).order_by(models.Season.date_from.desc()).first()
    return _season_out(row) if row else None


@router.post("/seasons/start", status_code=201)
def start_season(body: SeasonIn, db: Session = Depends(get_db)):
    """Start a monitoring/planning season without deleting historical evidence."""
    if body.date_to < body.date_from:
        raise HTTPException(422, "Season end date must be on or after its start date")

    existing = db.query(models.Season).filter(
        models.Season.is_current.is_(True),
        models.Season.name == body.name,
        models.Season.date_from == body.date_from,
        models.Season.date_to == body.date_to,
    ).first()
    if existing:
        return {**_season_out(existing), "linked_macros": 0, "resolved_old_recommendations": 0}

    db.query(models.Season).update({"is_current": False})
    row = models.Season(**{**body.model_dump(), "is_current": True})
    db.add(row)
    db.flush()

    overlapping_macros = db.query(models.TrainingMacro).filter(
        models.TrainingMacro.date_from <= body.date_to,
        models.TrainingMacro.date_to >= body.date_from,
    ).all()
    for macro in overlapping_macros:
        macro.season_id = row.id

    old_macro_ids = [macro_id for (macro_id,) in db.query(models.TrainingMacro.id).filter(
        models.TrainingMacro.date_to < body.date_from,
    ).all()]
    resolved = 0
    if old_macro_ids:
        old_recommendations = db.query(models.PlanningRecommendation).filter(
            models.PlanningRecommendation.macro_id.in_(old_macro_ids),
            models.PlanningRecommendation.status.in_(("open", "in_progress", "accepted", "snoozed")),
        ).all()
        now = datetime.now(timezone.utc)
        for recommendation in old_recommendations:
            previous_status = recommendation.status
            recommendation.status = "resolved"
            recommendation.resolved_at = now
            recommendation.updated_at = now
            recommendation.follow_up_at = None
            record_recommendation_event(db, recommendation, "season_rollover_resolved", {
                "from": previous_status,
                "new_season_id": row.id,
                "new_season": row.name,
            })
            resolved += 1

    db.commit()
    db.refresh(row)
    return {
        **_season_out(row),
        "linked_macros": len(overlapping_macros),
        "resolved_old_recommendations": resolved,
    }


@router.post("/seasons", status_code=201)
def create_season(body: SeasonIn, db: Session = Depends(get_db)):
    if body.date_to < body.date_from:
        raise HTTPException(422, "Season end date must be on or after its start date")
    if body.is_current:
        db.query(models.Season).update({"is_current": False})
    row = models.Season(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return _season_out(row)


@router.get("/pathways")
def list_pathways(macro_id: Optional[int] = None, db: Session = Depends(get_db)):
    query = db.query(models.PlanningPathway)
    if macro_id is not None:
        query = query.filter(models.PlanningPathway.macro_id == macro_id)
    return [_pathway_out(p) for p in query.order_by(models.PlanningPathway.name).all()]


@router.post("/pathways", status_code=201)
def create_pathway(body: PathwayIn, db: Session = Depends(get_db)):
    if not db.query(models.TrainingMacro).filter(models.TrainingMacro.id == body.macro_id).first():
        raise HTTPException(404, "Macro not found")
    row = models.PlanningPathway(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    refresh_macro(row.macro_id, db)
    return _pathway_out(row)


@router.patch("/pathways/{pathway_id}")
def update_pathway(pathway_id: int, body: PathwayUpdate, db: Session = Depends(get_db)):
    row = db.query(models.PlanningPathway).filter(models.PlanningPathway.id == pathway_id).first()
    if not row:
        raise HTTPException(404, "Pathway not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    refresh_macro(row.macro_id, db)
    return _pathway_out(row)


@router.delete("/pathways/{pathway_id}", status_code=204)
def delete_pathway(pathway_id: int, db: Session = Depends(get_db)):
    row = db.query(models.PlanningPathway).filter(models.PlanningPathway.id == pathway_id).first()
    if not row:
        raise HTTPException(404, "Pathway not found")
    macro_id = row.macro_id
    db.delete(row)
    db.commit()
    refresh_macro(macro_id, db)


@router.put("/pathways/{pathway_id}/members")
def replace_members(pathway_id: int, body: list[MembershipIn], db: Session = Depends(get_db)):
    pathway = db.query(models.PlanningPathway).filter(models.PlanningPathway.id == pathway_id).first()
    if not pathway:
        raise HTTPException(404, "Pathway not found")
    swimmer_ids = {item.swimmer_id for item in body}
    if len(swimmer_ids) != len(body):
        raise HTTPException(422, "Each swimmer can only appear once in a pathway")
    found = {s.id for s in db.query(models.Swimmer).filter(models.Swimmer.id.in_(swimmer_ids)).all()} if swimmer_ids else set()
    if found != swimmer_ids:
        raise HTTPException(422, "One or more swimmers do not exist")
    db.query(models.PathwayMembership).filter(models.PathwayMembership.pathway_id == pathway_id).delete()
    for item in body:
        db.add(models.PathwayMembership(pathway_id=pathway_id, **item.model_dump()))
    db.commit()
    db.refresh(pathway)
    refresh_macro(pathway.macro_id, db)
    return _pathway_out(pathway)


@router.post("/refresh")
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    try:
        counts = refresh_macro(body.macro_id, db, body.as_of_date)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {**counts, "context": compact_context(db, body.macro_id, body.as_of_date)}


@router.get("/status")
def status(macro_id: Optional[int] = None, db: Session = Depends(get_db)):
    pathways = list_pathways(macro_id, db)
    rec_query = db.query(models.PlanningRecommendation)
    if macro_id is not None:
        rec_query = rec_query.filter(models.PlanningRecommendation.macro_id == macro_id)
    recommendations = rec_query.order_by(models.PlanningRecommendation.created_at.desc()).all()
    return {
        "pathways": pathways,
        "recommendations": [_recommendation_out(r, db) for r in recommendations],
        "context": compact_context(db, macro_id),
    }


@router.get("/inbox")
def assistant_inbox(
    include_snoozed: bool = False,
    include_closed: bool = False,
    refresh: bool = True,
    limit: int = 100,
    db: Session = Depends(get_db),
):
    """Return the central assistant queue, refreshing local planning facts by default."""
    refresh_result = refresh_all_macros(db) if refresh else None
    query = db.query(models.PlanningRecommendation)
    if not include_closed:
        query = query.filter(models.PlanningRecommendation.status.in_(("open", "in_progress", "accepted", "snoozed")))
    if not include_snoozed:
        query = query.filter(models.PlanningRecommendation.status != "snoozed")
    rows = query.order_by(models.PlanningRecommendation.created_at.desc()).all()
    severity_order = {"critical": 0, "warning": 1, "info": 2}
    status_order = {"open": 0, "in_progress": 1, "accepted": 1, "snoozed": 2, "resolved": 3, "dismissed": 4}
    rows.sort(key=lambda row: (
        status_order.get(row.status, 9), severity_order.get(row.severity, 9),
        -(row.id or 0),
    ))
    all_active = db.query(models.PlanningRecommendation).filter(
        models.PlanningRecommendation.status.in_(("open", "in_progress", "accepted", "snoozed")),
    ).all()
    counts = {
        "open": sum(row.status == "open" for row in all_active),
        "in_progress": sum(row.status in {"in_progress", "accepted"} for row in all_active),
        "snoozed": sum(row.status == "snoozed" for row in all_active),
        "urgent": sum(row.status != "snoozed" and row.severity in {"critical", "warning"} for row in all_active),
    }
    return {
        "items": [_recommendation_out(row, db) for row in rows[:max(1, min(limit, 250))]],
        "counts": counts,
        "refreshed": refresh_result,
        "refreshed_at": datetime.now(timezone.utc),
    }


@router.post("/inbox/refresh")
def refresh_inbox(db: Session = Depends(get_db)):
    return {**refresh_all_macros(db), "inbox": assistant_inbox(refresh=False, db=db)}


@router.patch("/recommendations/{recommendation_id}")
def update_recommendation(recommendation_id: int, body: RecommendationUpdate, db: Session = Depends(get_db)):
    row = db.query(models.PlanningRecommendation).filter(models.PlanningRecommendation.id == recommendation_id).first()
    if not row:
        raise HTTPException(404, "Recommendation not found")
    allowed = {"open", "in_progress", "accepted", "snoozed", "dismissed", "resolved"}
    if body.status is not None and body.status not in allowed:
        raise HTTPException(422, "Invalid recommendation status")
    now = datetime.now(timezone.utc)
    previous_status = row.status
    if body.status is not None:
        row.status = "in_progress" if body.status == "accepted" else body.status
        if row.status == "in_progress":
            row.accepted_at = row.accepted_at or now
            row.follow_up_at = body.follow_up_at or row.follow_up_at or (now + timedelta(days=7))
        elif row.status == "snoozed":
            row.follow_up_at = body.follow_up_at or (now + timedelta(days=7))
        elif row.status in {"dismissed", "resolved"}:
            row.resolved_at = now
            row.follow_up_at = None
        elif row.status == "open":
            row.resolved_at = None
            row.follow_up_at = body.follow_up_at
    elif body.follow_up_at is not None:
        row.follow_up_at = body.follow_up_at
    if body.coach_note is not None:
        row.coach_note = body.coach_note.strip() or None
    row.updated_at = now
    record_recommendation_event(db, row, "status_changed", {
        "from": previous_status, "to": row.status,
        "follow_up_at": row.follow_up_at.isoformat() if row.follow_up_at else None,
    })
    db.commit()
    db.refresh(row)
    return _recommendation_out(row, db, include_events=True)


@router.post("/recommendations/{recommendation_id}/start")
def start_recommendation_action(recommendation_id: int, db: Session = Depends(get_db)):
    """Start the proposed task without silently making an under-specified planning change."""
    row = db.query(models.PlanningRecommendation).filter(models.PlanningRecommendation.id == recommendation_id).first()
    if not row:
        raise HTTPException(404, "Recommendation not found")
    now = datetime.now(timezone.utc)
    row.status = "in_progress"
    row.accepted_at = row.accepted_at or now
    row.actioned_at = now
    row.updated_at = now
    row.follow_up_at = now + timedelta(days=7)
    record_recommendation_event(db, row, "action_started", {
        "proposed_action": row.proposed_action or {}, "destination": _action_destination(row),
    })
    db.commit()
    db.refresh(row)
    return {
        "recommendation": _recommendation_out(row, db, include_events=True),
        "destination": _action_destination(row),
        "requires_coach_review": True,
    }


@router.post("/recommendations/{recommendation_id}/discuss")
def discuss_recommendation(recommendation_id: int, db: Session = Depends(get_db)):
    """Create a cost-free seeded planning thread; AI is called only after the coach replies."""
    row = db.query(models.PlanningRecommendation).filter(models.PlanningRecommendation.id == recommendation_id).first()
    if not row:
        raise HTTPException(404, "Recommendation not found")
    thread = db.query(models.AIThread).filter(models.AIThread.id == row.discussion_thread_id).first() if row.discussion_thread_id else None
    if thread is None:
        thread = models.AIThread(
            name=f"Follow-up — {row.title}"[:120],
            thread_type="season_plan",
            macro_id=row.macro_id,
        )
        db.add(thread)
        db.flush()
        context_bits = [row.detail]
        if row.coach_note:
            context_bits.append(f"Coach note: {row.coach_note}")
        db.add(models.CoachAIMessage(
            thread_id=thread.id,
            role="user",
            message="Assistant inbox follow-up:\n" + "\n".join(context_bits),
        ))
        db.add(models.CoachAIMessage(
            thread_id=thread.id,
            role="assistant",
            message=(
                "I’ve opened this planning follow-up. The underlying evidence and proposed action "
                "are linked to the inbox item; tell me what you are considering or ask me to work through the decision."
            ),
        ))
        row.discussion_thread_id = thread.id
    now = datetime.now(timezone.utc)
    if row.status in {"open", "snoozed"}:
        row.status = "in_progress"
        row.accepted_at = row.accepted_at or now
    row.updated_at = now
    row.follow_up_at = row.follow_up_at or (now + timedelta(days=7))
    record_recommendation_event(db, row, "discussion_opened", {"thread_id": thread.id})
    db.commit()
    return {"thread_id": thread.id, "recommendation": _recommendation_out(row, db)}
