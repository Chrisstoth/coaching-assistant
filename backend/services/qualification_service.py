"""Deterministic qualification-standard normalization and swimmer comparison."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.event_normalizer import canonicalize_event, event_parts


def parse_time_seconds(value) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(";", ":")
    if not text or text.lower() in {"n/a", "na", "-", "none"}:
        return None
    parts = text.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return None
    return None


def format_time(seconds: Optional[float]) -> Optional[str]:
    if seconds is None:
        return None
    if seconds < 60:
        return f"{seconds:.2f}"
    minutes, remainder = divmod(seconds, 60)
    return f"{int(minutes)}:{remainder:05.2f}"


def normalize_standard(item: dict) -> Optional[dict]:
    event_name = item.get("event_name") or item.get("event")
    supplied_time = item.get("time") if item.get("time") not in (None, "") else item.get("time_seconds")
    seconds = parse_time_seconds(supplied_time)
    if not event_name or seconds is None:
        return None
    distance, stroke = event_parts(event_name)
    gender = str(item.get("gender") or "open").lower().replace("/", "_").replace(" ", "_")
    if gender in {"m", "male", "men", "men_open", "open_male"}:
        gender = "male_open"
    elif gender in {"f", "female", "women", "girls"}:
        gender = "female"
    elif gender not in {"open", "mixed"}:
        gender = "open"
    course = str(item.get("course") or "SCM").upper()
    course = {"SC": "SCM", "25M": "SCM", "LC": "LCM", "50M": "LCM"}.get(course, course)
    standard_type = str(item.get("standard_type") or "qualifying").lower().replace(" ", "_")
    return {
        "event_name": event_name,
        "canonical_event": canonicalize_event(event_name),
        "distance": distance,
        "stroke": stroke,
        "gender": gender,
        "age_label": item.get("age_label") or "open",
        "age_min": item.get("age_min"),
        "age_max": item.get("age_max"),
        "course": course,
        "standard_type": standard_type,
        "time_seconds": seconds,
        "time_display": item.get("time") or format_time(seconds),
        "source_page": item.get("source_page"),
        "raw_data": item,
    }


def _as_date(value) -> Optional[date]:
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _age_on(dob: date, on_date: date) -> int:
    return on_date.year - dob.year - ((on_date.month, on_date.day) < (dob.month, dob.day))


def _gender_matches(swimmer: models.Swimmer, standard: models.QualificationStandard) -> bool:
    if standard.gender in {None, "open", "mixed"}:
        return True
    swimmer_gender = (swimmer.gender or "").upper()
    return (standard.gender == "female" and swimmer_gender == "F") or (
        standard.gender == "male_open" and swimmer_gender in {"M", "O"}
    )


def _age_matches(swimmer: models.Swimmer, standard: models.QualificationStandard, rules: dict) -> tuple[bool, str]:
    age_date = _as_date(rules.get("age_as_of_date"))
    minimum = standard.age_min if standard.age_min is not None else rules.get("minimum_age")
    maximum = standard.age_max if standard.age_max is not None else rules.get("maximum_age")
    if minimum is None and maximum is None:
        return True, ""
    if not swimmer.dob or not age_date:
        return False, "Age or age-as-of date is missing"
    age = _age_on(swimmer.dob, age_date)
    if minimum is not None and age < int(minimum):
        return False, f"Age {age} is below {minimum}"
    if maximum is not None and age > int(maximum):
        return False, f"Age {age} is above {maximum}"
    return True, f"Age {age} at {age_date.isoformat()}"


def _level_allowed(swim: models.SwimTime, allowed_levels: list) -> bool:
    if not allowed_levels:
        return True
    digits = re.findall(r"\d+", str(swim.level or ""))
    if not digits:
        return False
    return int(digits[0]) in {int(level) for level in allowed_levels}


def recalculate_standard_set(standard_set_id: int, db: DBSession) -> dict:
    standard_set = db.query(models.QualificationStandardSet).filter(
        models.QualificationStandardSet.id == standard_set_id,
    ).first()
    if not standard_set:
        raise ValueError("Qualification standards set not found")
    rules = standard_set.rules or {}
    window_start = _as_date(rules.get("qualification_window_start"))
    window_end = _as_date(rules.get("qualification_window_end") or rules.get("entry_closing_date"))
    allowed_levels = rules.get("accepted_license_levels") or []
    conversion_allowed = bool(rules.get("long_course_conversions_accepted") or rules.get("conversion_method"))
    standards = list(standard_set.standards)
    swimmers = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True)).all()
    db.query(models.QualificationAssessment).filter(
        models.QualificationAssessment.standard_set_id == standard_set_id,
    ).delete()
    created = 0

    for swimmer in swimmers:
        swimmer_times = list(swimmer.times)
        for standard in standards:
            if not _gender_matches(swimmer, standard):
                continue
            age_ok, age_reason = _age_matches(swimmer, standard, rules)
            if not age_ok:
                continue
            event_times = [t for t in swimmer_times if canonicalize_event(t.event) == standard.canonical_event]
            dated = [t for t in event_times if (not window_start or (t.date and t.date >= window_start)) and
                     (not window_end or (t.date and t.date <= window_end))]
            licensed = [t for t in dated if _level_allowed(t, allowed_levels)]
            same_course = [t for t in licensed if (t.course or "").upper() == standard.course]
            best = min(same_course, key=lambda t: t.time_seconds) if same_course else None
            other_course = [t for t in licensed if (t.course or "").upper() != standard.course]

            if best:
                gap = round(best.time_seconds - standard.time_seconds, 2)
                gap_pct = round((gap / standard.time_seconds) * 100, 2)
                status = "achieved" if gap <= 0 else ("chasing" if gap_pct <= 3 else "outside")
                reason = f"Best eligible {standard.course} time; {age_reason}".strip("; ")
            elif other_course and conversion_allowed:
                best = min(other_course, key=lambda t: t.time_seconds)
                gap = gap_pct = None
                status = "conversion_required"
                reason = f"{best.course} time requires {rules.get('conversion_method') or 'approved conversion'}"
            else:
                gap = gap_pct = None
                status = "no_time"
                if event_times and not dated:
                    reason = "Matching times exist, but none are inside the qualification window"
                elif dated and not licensed:
                    reason = "Matching times exist, but none meet the accepted licence levels"
                else:
                    reason = "No eligible matching time"

            source = {
                "set": standard_set.source_sha256, "standard": standard.id,
                "swimmer": swimmer.id, "best": best.id if best else None,
                "rules": rules, "status": status,
            }
            db.add(models.QualificationAssessment(
                standard_set_id=standard_set_id, standard_id=standard.id, swimmer_id=swimmer.id,
                best_time_id=best.id if best else None, status=status,
                best_time_seconds=best.time_seconds if best else None,
                gap_seconds=gap, gap_percent=gap_pct, eligibility_reason=reason,
                source_hash=hashlib.sha256(json.dumps(source, sort_keys=True, default=str).encode()).hexdigest(),
            ))
            created += 1
    db.commit()
    return {"standard_set_id": standard_set_id, "swimmers": len(swimmers), "assessments": created}


def swimmer_qualification_status(standard_set_id: int, swimmer_id: int, db: DBSession) -> str:
    rows = db.query(models.QualificationAssessment).join(models.QualificationStandard).filter(
        models.QualificationAssessment.standard_set_id == standard_set_id,
        models.QualificationAssessment.swimmer_id == swimmer_id,
    ).all()
    if any(r.status == "achieved" and r.standard.standard_type in {"automatic", "qualifying"} for r in rows):
        return "qualified"
    if any(r.status == "achieved" and r.standard.standard_type in {"base", "consideration"} for r in rows):
        return "consideration"
    if any(r.status in {"chasing", "conversion_required"} for r in rows):
        return "chasing"
    return "not_qualified" if rows else "unknown"


def assessment_summary(standard_set_id: int, db: DBSession) -> list[dict]:
    rows = db.query(models.QualificationAssessment).filter(
        models.QualificationAssessment.standard_set_id == standard_set_id,
    ).all()
    grouped = {}
    for row in rows:
        swimmer = grouped.setdefault(row.swimmer_id, {
            "swimmer_id": row.swimmer_id, "swimmer": row.swimmer.name,
            "qualification_status": swimmer_qualification_status(standard_set_id, row.swimmer_id, db),
            "events": [],
        })
        swimmer["events"].append({
            "assessment_id": row.id, "standard_id": row.standard_id,
            "event": row.standard.canonical_event, "course": row.standard.course,
            "standard_type": row.standard.standard_type,
            "standard_time": row.standard.time_seconds, "standard_display": row.standard.time_display,
            "best_time": row.best_time_seconds, "best_time_display": format_time(row.best_time_seconds),
            "status": row.status, "gap_seconds": row.gap_seconds,
            "gap_percent": row.gap_percent, "reason": row.eligibility_reason,
        })
    return sorted(grouped.values(), key=lambda item: item["swimmer"])
