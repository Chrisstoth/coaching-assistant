"""
Dashboard API — squad pulse and quick-view data.
"""
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models

router = APIRouter()


@router.get("/meet-countdowns")
def meet_countdowns(db: DBSession = Depends(get_db)):
    """
    Per-group target meet countdowns + general upcoming meets.
    Group targets: earliest upcoming meet where ≥1 swimmer in that squad has a MeetTarget.
    Upcoming: next 4 meets regardless of targets (quieter display).
    """
    today = date.today()
    cutoff = today + timedelta(weeks=24)

    upcoming = db.query(models.Meet).filter(
        models.Meet.date >= today,
        models.Meet.date <= cutoff,
    ).order_by(models.Meet.date).all()

    if not upcoming:
        return {"group_targets": [], "upcoming_meets": []}

    meet_ids = [m.id for m in upcoming]
    meet_map = {m.id: m for m in upcoming}

    # All meet targets for upcoming meets
    targets = db.query(models.MeetTarget).filter(
        models.MeetTarget.meet_id.in_(meet_ids),
    ).all()

    # Swimmer → squad mapping
    swimmer_ids = list({t.swimmer_id for t in targets})
    if swimmer_ids:
        swimmers = db.query(models.Swimmer).filter(
            models.Swimmer.id.in_(swimmer_ids)
        ).all()
        squad_by_swimmer = {s.id: (s.squad or "Squad") for s in swimmers}
    else:
        squad_by_swimmer = {}

    # Per squad: collect all targeted meet dates, pick earliest
    squad_meets: dict = {}  # squad → {meet_id: count}
    for t in targets:
        squad = squad_by_swimmer.get(t.swimmer_id, "Squad")
        meet = meet_map.get(t.meet_id)
        if not meet:
            continue
        if squad not in squad_meets or meet.date < squad_meets[squad]["date"]:
            squad_meets[squad] = {
                "date": meet.date,
                "meet_id": meet.id,
                "meet_name": meet.name,
            }

    group_targets = sorted([
        {
            "group": squad,
            "meet_name": info["meet_name"],
            "meet_id": info["meet_id"],
            "date": str(info["date"]),
            "days_out": (info["date"] - today).days,
        }
        for squad, info in squad_meets.items()
    ], key=lambda x: x["days_out"])

    # General upcoming meets list (up to 4, excludes already shown as group targets if they're the same)
    group_meet_ids = {g["meet_id"] for g in group_targets}
    upcoming_meets = [
        {
            "name": m.name,
            "meet_id": m.id,
            "date": str(m.date),
            "days_out": (m.date - today).days,
        }
        for m in upcoming[:6]
        if m.id not in group_meet_ids
    ][:4]

    return {"group_targets": group_targets, "upcoming_meets": upcoming_meets}


@router.get("/squad-pulse")
def squad_pulse(db: DBSession = Depends(get_db)):
    """
    Per-swimmer pulse data for the dashboard — attendance, approaching targets,
    last observation, and recent skill flag. All bulk-fetched for performance.
    """
    today = date.today()
    four_weeks_ago = today - timedelta(weeks=4)
    eight_weeks_ahead = today + timedelta(weeks=8)
    fourteen_days_ago = today - timedelta(days=14)

    # Active swimmers
    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.active == True,
        models.Swimmer.status == "active",
    ).order_by(models.Swimmer.name).all()

    if not swimmers:
        return []

    swimmer_ids = [s.id for s in swimmers]

    # Sessions attended last 4 weeks (count of SwimmerSessionLoad entries)
    loads = db.query(
        models.SwimmerSessionLoad.swimmer_id,
    ).filter(
        models.SwimmerSessionLoad.swimmer_id.in_(swimmer_ids),
        models.SwimmerSessionLoad.session_date >= four_weeks_ago,
    ).all()
    attended_by_swimmer = defaultdict(int)
    for (sw_id,) in loads:
        attended_by_swimmer[sw_id] += 1

    # Expected sessions: SwimmerSlot count × 4 weeks
    slots = db.query(
        models.SwimmerSlot.swimmer_id,
    ).filter(
        models.SwimmerSlot.swimmer_id.in_(swimmer_ids),
    ).all()
    slots_by_swimmer = defaultdict(int)
    for (sw_id,) in slots:
        slots_by_swimmer[sw_id] += 1

    # Approaching targets (deadline ≤ 8 weeks, unachieved)
    targets = db.query(models.SwimmerTarget).filter(
        models.SwimmerTarget.swimmer_id.in_(swimmer_ids),
        models.SwimmerTarget.achieved == False,
        models.SwimmerTarget.deadline != None,
        models.SwimmerTarget.deadline >= today,
        models.SwimmerTarget.deadline <= eight_weeks_ahead,
    ).order_by(models.SwimmerTarget.deadline).all()

    # Group targets by swimmer — keep nearest one per swimmer
    nearest_target: dict = {}
    for t in targets:
        if t.swimmer_id not in nearest_target:
            nearest_target[t.swimmer_id] = t

    # Bulk-fetch benchmarks for target swimmers (max effort, relevant stroke/distance)
    target_swimmer_ids = list(nearest_target.keys())
    all_benchmarks = []
    if target_swimmer_ids:
        all_benchmarks = db.query(models.BenchmarkLog).filter(
            models.BenchmarkLog.swimmer_id.in_(target_swimmer_ids),
            models.BenchmarkLog.effort == "max",
        ).order_by(models.BenchmarkLog.date.desc()).all()

    # Index benchmarks: (swimmer_id, stroke, distance) → latest
    bench_index: dict = {}
    for b in all_benchmarks:
        key = (b.swimmer_id, b.stroke, b.distance)
        if key not in bench_index:
            bench_index[key] = b

    # Last observation per swimmer (last 8 weeks for recency)
    eight_weeks_ago = today - timedelta(weeks=8)
    obs_list = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.swimmer_id.in_(swimmer_ids),
        models.SwimmerObservation.date >= eight_weeks_ago,
    ).order_by(models.SwimmerObservation.date.desc()).all()

    last_obs: dict = {}
    for o in obs_list:
        if o.swimmer_id not in last_obs:
            last_obs[o.swimmer_id] = o

    # Recent skill flags (swimmer-specific skill outputs in last 14 days)
    flagged = set()
    skill_outputs = db.query(models.SkillOutput.swimmer_id).filter(
        models.SkillOutput.swimmer_id.in_(swimmer_ids),
        models.SkillOutput.swimmer_id != None,
        models.SkillOutput.created_at >= fourteen_days_ago,
    ).all()
    for (sw_id,) in skill_outputs:
        flagged.add(sw_id)

    # Build result
    result = []
    for sw in swimmers:
        attended = attended_by_swimmer.get(sw.id, 0)
        slots_per_week = slots_by_swimmer.get(sw.id, 3)
        expected = slots_per_week * 4

        # Approaching target
        target_data = None
        t = nearest_target.get(sw.id)
        if t:
            weeks_out = (t.deadline - today).days // 7
            days_out = (t.deadline - today).days
            gap = None
            if t.target_time_seconds and t.stroke and t.distance:
                bench = bench_index.get((sw.id, t.stroke, t.distance))
                if bench:
                    gap = round(bench.time_seconds - t.target_time_seconds, 2)
            target_data = {
                "label": t.label,
                "deadline": str(t.deadline),
                "weeks_out": weeks_out,
                "days_out": days_out,
                "gap_seconds": gap,
            }

        # Last observation
        obs = last_obs.get(sw.id)
        obs_data = None
        if obs:
            content = obs.content or ""
            obs_data = {
                "date": str(obs.date),
                "days_ago": (today - obs.date).days,
                "snippet": content[:80].strip(),
            }

        result.append({
            "id": sw.id,
            "name": sw.name,
            "gender": sw.gender,
            "sessions_attended": attended,
            "sessions_expected": max(expected, 1),
            "approaching_target": target_data,
            "last_observation": obs_data,
            "has_recent_skill_flag": sw.id in flagged,
        })

    return result
