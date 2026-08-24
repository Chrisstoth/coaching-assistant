"""Deterministic, persisted planning intelligence for competition-led programmes.

The engine deliberately does not call an LLM.  It turns stored pathway, meet and
entry data into compact snapshots which can be reused by screens and AI skills.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.qualification_service import swimmer_qualification_status


DEFAULT_PHASE_CONFIG = {
    "race_specific_days": 28,
    "build_days": 56,
    "taper_days": {"A": 10, "B": 4, "C": 0},
    "taper_load": 0.70,
    "race_specific_load": 0.90,
    "build_load": 1.05,
    "base_load": 1.0,
}


def _meet(db: DBSession, meet_id: Optional[int]) -> Optional[models.Meet]:
    return db.query(models.Meet).filter(models.Meet.id == meet_id).first() if meet_id else None


def _config(pathway: models.PlanningPathway) -> dict:
    merged = dict(DEFAULT_PHASE_CONFIG)
    supplied = pathway.phase_config or {}
    merged.update({k: v for k, v in supplied.items() if k != "taper_days"})
    merged["taper_days"] = {**DEFAULT_PHASE_CONFIG["taper_days"], **(supplied.get("taper_days") or {})}
    return merged


def _choose_target(pathway: models.PlanningPathway, membership: models.PathwayMembership,
                   as_of: date, db: DBSession) -> tuple[Optional[models.Meet], str]:
    status = (membership.qualification_status or "unknown").lower()
    primary = _meet(db, pathway.primary_meet_id)
    fallback = _meet(db, pathway.fallback_meet_id)
    qualifiers = [m for m in (_meet(db, mid) for mid in (pathway.qualifier_meet_ids or [])) if m]
    future_qualifiers = sorted((m for m in qualifiers if m.date and m.date >= as_of), key=lambda m: m.date)

    if status in {"qualified", "consideration", "not_required"}:
        return primary or fallback, "primary"
    if status in {"chasing", "not_qualified"} and future_qualifiers:
        return future_qualifiers[0], "qualifier"
    if status == "not_qualified":
        return fallback or primary, "fallback" if fallback else "primary"
    return primary or fallback, "primary" if primary else "fallback"


def _priority(meet_id: Optional[int], swimmer_id: int, db: DBSession) -> str:
    if not meet_id:
        return "B"
    target = db.query(models.MeetTarget).filter(
        models.MeetTarget.meet_id == meet_id,
        models.MeetTarget.swimmer_id == swimmer_id,
    ).first()
    return ((target.priority if target else None) or "B").upper()


def _phase(target_date: Optional[date], as_of: date, priority: str, config: dict) -> dict:
    if not target_date:
        return {"phase": "unassigned", "weeks": None, "race_start": None,
                "taper_start": None, "load": 1.0}
    days = (target_date - as_of).days
    race_start = target_date - timedelta(days=int(config["race_specific_days"]))
    taper_days = int(config["taper_days"].get(priority, config["taper_days"]["B"]))
    taper_start = target_date - timedelta(days=taper_days) if taper_days else target_date
    if days < 0:
        phase, load = "post_competition", 0.75
    elif as_of >= taper_start:
        phase, load = "taper", float(config["taper_load"])
    elif as_of >= race_start:
        phase, load = "race_specific", float(config["race_specific_load"])
    elif days <= int(config["build_days"]):
        phase, load = "build", float(config["build_load"])
    else:
        phase, load = "base", float(config["base_load"])
    return {"phase": phase, "weeks": round(days / 7, 1), "race_start": race_start,
            "taper_start": taper_start, "load": load}


def _events(meet_id: Optional[int], swimmer_id: int, db: DBSession) -> list[dict]:
    if not meet_id:
        return []
    entries = db.query(models.MeetEntry).filter(
        models.MeetEntry.meet_id == meet_id,
        models.MeetEntry.swimmer_id == swimmer_id,
    ).all()
    if entries:
        return [{"event": e.canonical_event or e.event_name, "priority": e.priority,
                 "target_time": e.target_time, "timetable_linked": bool(e.meet_event_id)} for e in entries]
    target = db.query(models.MeetTarget).filter(
        models.MeetTarget.meet_id == meet_id,
        models.MeetTarget.swimmer_id == swimmer_id,
    ).first()
    return [{"event": e, "priority": target.priority, "target_time": (target.target_times or {}).get(e),
             "timetable_linked": False} for e in (target.events or [])] if target else []


def _fingerprint(*values) -> str:
    return hashlib.sha256("|".join(str(v) for v in values).encode()).hexdigest()[:24]


def record_recommendation_event(
    db: DBSession,
    recommendation: models.PlanningRecommendation,
    event_type: str,
    detail: Optional[dict] = None,
) -> None:
    db.add(models.PlanningRecommendationEvent(
        recommendation=recommendation,
        event_type=event_type,
        detail=detail or {},
    ))


def _recommend(db: DBSession, *, macro_id: int, pathway_id: Optional[int], swimmer_id: Optional[int],
               kind: str, severity: str, title: str, detail: str, evidence: dict, proposed_action: dict) -> str:
    now = datetime.now(timezone.utc)
    fingerprint = _fingerprint(macro_id, pathway_id, swimmer_id, kind)
    row = db.query(models.PlanningRecommendation).filter(
        models.PlanningRecommendation.fingerprint == fingerprint,
    ).first()
    if row:
        row.title, row.detail, row.evidence, row.proposed_action = title, detail, evidence, proposed_action
        row.severity = severity
        row.updated_at = now
        row.last_seen_at = now
        if row.status == "resolved":
            row.status = "open"
            row.resolved_at = None
            row.follow_up_at = None
            row.occurrence_count = (row.occurrence_count or 1) + 1
            record_recommendation_event(db, row, "reopened", {"reason": "condition_recurred"})
    else:
        row = models.PlanningRecommendation(
            macro_id=macro_id, pathway_id=pathway_id, swimmer_id=swimmer_id, kind=kind,
            severity=severity, title=title, detail=detail, evidence=evidence,
            proposed_action=proposed_action, fingerprint=fingerprint, updated_at=now,
            last_seen_at=now, occurrence_count=1,
        )
        db.add(row)
        record_recommendation_event(db, row, "detected", {"severity": severity})
    return fingerprint


def wake_due_followups(db: DBSession, now: Optional[datetime] = None) -> int:
    """Return snoozed inbox items to the open queue when their review time arrives."""
    now = now or datetime.now(timezone.utc)
    due = db.query(models.PlanningRecommendation).filter(
        models.PlanningRecommendation.status == "snoozed",
        models.PlanningRecommendation.follow_up_at.is_not(None),
        models.PlanningRecommendation.follow_up_at <= now,
    ).all()
    for row in due:
        row.status = "open"
        row.follow_up_at = None
        row.updated_at = now
        record_recommendation_event(db, row, "follow_up_due")
    if due:
        db.commit()
    return len(due)


def refresh_all_macros(db: DBSession, as_of: Optional[date] = None) -> dict:
    """Refresh every macro with active pathways; this is local and makes no AI calls."""
    macro_query = db.query(models.PlanningPathway.macro_id).join(
        models.TrainingMacro,
        models.PlanningPathway.macro_id == models.TrainingMacro.id,
    ).filter(models.PlanningPathway.active.is_(True))
    current_season = db.query(models.Season).filter(
        models.Season.is_current.is_(True),
    ).order_by(models.Season.date_from.desc()).first()
    if current_season:
        macro_query = macro_query.filter(models.TrainingMacro.season_id == current_season.id)
    macro_ids = [row[0] for row in macro_query.distinct().all()]
    totals = {"macros": 0, "pathways": 0, "swimmers": 0, "snapshots": 0, "follow_ups_due": 0}
    for macro_id in macro_ids:
        counts = refresh_macro(macro_id, db, as_of)
        totals["macros"] += 1
        for key in ("pathways", "swimmers", "snapshots"):
            totals[key] += counts[key]
    totals["follow_ups_due"] = wake_due_followups(db)
    return totals


def refresh_macro(macro_id: int, db: DBSession, as_of: Optional[date] = None) -> dict:
    """Recompute cached state. Existing recommendations retain coach decisions."""
    as_of = as_of or date.today()
    macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
    if not macro:
        raise ValueError("Macro not found")
    pathways = db.query(models.PlanningPathway).filter(
        models.PlanningPathway.macro_id == macro_id,
        models.PlanningPathway.active.is_(True),
    ).all()
    db.query(models.PlanningSnapshot).filter(
        models.PlanningSnapshot.macro_id == macro_id,
        models.PlanningSnapshot.as_of_date == as_of,
    ).delete()
    counts = {"pathways": len(pathways), "swimmers": 0, "snapshots": 0}
    pathway_target_dates = []
    seen_recommendations = set()

    for pathway in pathways:
        config = _config(pathway)
        memberships = [m for m in pathway.memberships if m.active and
                       (not m.date_from or m.date_from <= as_of) and (not m.date_to or m.date_to >= as_of)]
        for membership in memberships:
            effective_status = membership.qualification_status
            if pathway.qualification_standard_set_id:
                effective_status = swimmer_qualification_status(
                    pathway.qualification_standard_set_id, membership.swimmer_id, db,
                )
            original_status = membership.qualification_status
            membership.qualification_status = effective_status
            target, target_role = _choose_target(pathway, membership, as_of, db)
            membership.qualification_status = original_status
            priority = _priority(target.id if target else None, membership.swimmer_id, db)
            phase = _phase(target.date if target else None, as_of, priority, config)
            events = _events(target.id if target else None, membership.swimmer_id, db)
            flags = []
            if not target:
                flags.append("no_target_meet")
                seen_recommendations.add(_recommend(db, macro_id=macro_id, pathway_id=pathway.id, swimmer_id=membership.swimmer_id,
                           kind="missing_target", severity="warning", title="No usable target meet",
                           detail=f"{membership.swimmer.name} has no target meet for {pathway.name}.",
                           evidence={"qualification_status": membership.qualification_status},
                           proposed_action={"action": "assign_target_meet"}))
            elif effective_status == "consideration":
                flags.append("consideration_not_guaranteed")
                seen_recommendations.add(_recommend(
                    db, macro_id=macro_id, pathway_id=pathway.id, swimmer_id=membership.swimmer_id,
                    kind="consideration_entry", severity="info", title="Consideration time achieved",
                    detail=f"{membership.swimmer.name} has a consideration standard for {target.name}, not a guaranteed place.",
                    evidence={"meet_id": target.id, "standard_set_id": pathway.qualification_standard_set_id},
                    proposed_action={"action": "retain_fallback_until_acceptance"},
                ))
            elif not events:
                flags.append("no_event_entries")
                seen_recommendations.add(_recommend(db, macro_id=macro_id, pathway_id=pathway.id, swimmer_id=membership.swimmer_id,
                           kind="missing_entries", severity="warning", title="Target events not assigned",
                           detail=f"{membership.swimmer.name} targets {target.name}, but has no stored events.",
                           evidence={"meet_id": target.id, "meet": target.name},
                           proposed_action={"action": "add_meet_entries", "meet_id": target.id}))
            if target and 0 <= (target.date - as_of).days < int(config["race_specific_days"]):
                flags.append("compressed_preparation")
                seen_recommendations.add(_recommend(db, macro_id=macro_id, pathway_id=pathway.id, swimmer_id=membership.swimmer_id,
                           kind="compressed_preparation", severity="warning", title="Compressed preparation window",
                           detail=f"{membership.swimmer.name} has {(target.date - as_of).days} days until {target.name}.",
                           evidence={"target_date": target.date.isoformat(), "days": (target.date - as_of).days},
                           proposed_action={"action": "review_load_and_taper", "phase": phase["phase"]}))

            source = {
                "pathway": pathway.id, "member": membership.id, "status": effective_status,
                "target": target.id if target else None, "date": target.date.isoformat() if target and target.date else None,
                "priority": priority, "events": events, "config": config, "as_of": as_of.isoformat(),
            }
            db.add(models.PlanningSnapshot(
                macro_id=macro_id, pathway_id=pathway.id, swimmer_id=membership.swimmer_id,
                as_of_date=as_of, target_meet_id=target.id if target else None,
                target_date=target.date if target else None, weeks_to_target=phase["weeks"],
                current_phase=phase["phase"], race_specific_start=phase["race_start"],
                taper_start=phase["taper_start"], load_multiplier=phase["load"],
                qualification_status=effective_status, event_summary=events,
                flags=flags + ([f"target_role:{target_role}"] if target else []),
                source_hash=_fingerprint(json.dumps(source, sort_keys=True, default=str)),
            ))
            counts["swimmers"] += 1
            counts["snapshots"] += 1
            if target and target.date:
                pathway_target_dates.append((pathway.id, pathway.name, target.date))

    if pathway_target_dates:
        earliest, latest = min(pathway_target_dates, key=lambda x: x[2]), max(pathway_target_dates, key=lambda x: x[2])
        spread = (latest[2] - earliest[2]).days
        if spread >= 14:
            seen_recommendations.add(_recommend(db, macro_id=macro_id, pathway_id=None, swimmer_id=None,
                       kind="split_timing", severity="info", title="Pathways need different loading timelines",
                       detail=f"Targets span {spread} days: {earliest[1]} peaks before {latest[1]}.",
                       evidence={"earliest": earliest[2].isoformat(), "latest": latest[2].isoformat(), "spread_days": spread},
                       proposed_action={"action": "differentiate_microcycle_loads", "earlier_pathway_id": earliest[0]}))

    stale = db.query(models.PlanningRecommendation).filter(
        models.PlanningRecommendation.macro_id == macro_id,
        models.PlanningRecommendation.status.in_(("open", "in_progress", "accepted", "snoozed")),
    ).all()
    for recommendation in stale:
        if recommendation.fingerprint not in seen_recommendations:
            recommendation.status = "resolved"
            recommendation.resolved_at = datetime.now(timezone.utc)
            recommendation.follow_up_at = None
            recommendation.updated_at = recommendation.resolved_at
            record_recommendation_event(
                db, recommendation, "auto_resolved", {"reason": "condition_no_longer_present"},
            )

    db.commit()
    return counts


def compact_context(db: DBSession, macro_id: Optional[int] = None, as_of: Optional[date] = None) -> dict:
    query = db.query(models.PlanningSnapshot)
    if macro_id is not None:
        query = query.filter(models.PlanningSnapshot.macro_id == macro_id)
    if as_of:
        query = query.filter(models.PlanningSnapshot.as_of_date == as_of)
    rows = query.order_by(models.PlanningSnapshot.as_of_date.desc()).all()
    if not as_of:
        latest_by_swimmer = {}
        for row in rows:
            latest_by_swimmer.setdefault((row.macro_id, row.pathway_id, row.swimmer_id), row)
        rows = list(latest_by_swimmer.values())
    return {
        "generated_from_saved_state": True,
        "rows": [{
            "macro_id": r.macro_id, "pathway": r.pathway.name, "swimmer_id": r.swimmer_id,
            "swimmer": r.swimmer.name, "target_meet": r.target_meet.name if r.target_meet else None,
            "target_date": r.target_date.isoformat() if r.target_date else None,
            "weeks_to_target": r.weeks_to_target, "phase": r.current_phase,
            "taper_start": r.taper_start.isoformat() if r.taper_start else None,
            "load_multiplier": r.load_multiplier, "qualification": r.qualification_status,
            "events": [e.get("event") for e in (r.event_summary or [])], "flags": r.flags or [],
        } for r in rows],
    }
