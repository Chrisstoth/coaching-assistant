"""
Dashboard API — squad pulse and quick-view data.
"""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.availability import availability_ranges, is_excused, normalise_reason

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
        # A recently finished meet still needs its results prompt even when
        # nothing is coming up.
        return {
            "group_targets": [],
            "upcoming_meets": [],
            "awaiting_results": _meets_awaiting_results(db, today),
        }

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

    return {
        "group_targets": group_targets,
        "upcoming_meets": upcoming_meets,
        "awaiting_results": _meets_awaiting_results(db, today),
    }


PRIORITY_ORDER = {"A": 0, "B": 1, "C": 2}


@router.get("/galas")
def upcoming_galas(db: DBSession = Depends(get_db)):
    """
    The galas in the next month, nearest first, each with who's going and how
    much it matters to each of them (their A/B/C priority for that meet).
    Further out isn't Home's business; the Meets page has the rest.

    Who's going: a swimmer with targets for the meet or an entry that isn't
    withdrawn. Their priority is the one set on their targets, or else the
    highest on any of their entries. A squad's "target" meet is the first one
    any of its swimmers has targets for (the old countdown card).
    """
    today = date.today()
    cutoff = today + timedelta(days=31)
    meets = [m for m in db.query(models.Meet).filter(
        models.Meet.date != None,
        models.Meet.date <= cutoff,
        models.Meet.date >= today - timedelta(days=7),
    ).order_by(models.Meet.date).all() if (m.date_to or m.date) >= today][:8]
    if not meets:
        return {"meets": [], "swimmer_count": 0}

    meet_ids = [m.id for m in meets]
    targets = db.query(models.MeetTarget).filter(models.MeetTarget.meet_id.in_(meet_ids)).all()
    entries = db.query(models.MeetEntry).filter(
        models.MeetEntry.meet_id.in_(meet_ids),
        models.MeetEntry.status != "withdrawn",
    ).all()
    swimmer_ids = {t.swimmer_id for t in targets} | {e.swimmer_id for e in entries}
    swimmers = {s.id: s for s in db.query(models.Swimmer).filter(
        models.Swimmer.id.in_(swimmer_ids),
        models.Swimmer.active == True,
    ).all()} if swimmer_ids else {}

    going: dict = defaultdict(dict)   # meet_id → swimmer_id → {...}

    def row(meet_id, swimmer_id):
        if swimmer_id not in swimmers:
            return None
        s = swimmers[swimmer_id]
        return going[meet_id].setdefault(swimmer_id, {
            "swimmer_id": s.id, "name": s.name, "squad": s.squad,
            "priority": None, "events": [],
        })

    for t in targets:
        r = row(t.meet_id, t.swimmer_id)
        if not r:
            continue
        if (t.priority or "").upper() in PRIORITY_ORDER:
            r["priority"] = t.priority.upper()
        r["targeted"] = True
        for ev in t.events or []:
            if ev and ev not in r["events"]:
                r["events"].append(ev)
    for e in entries:
        r = row(e.meet_id, e.swimmer_id)
        if not r:
            continue
        if e.event_name and e.event_name not in r["events"]:
            r["events"].append(e.event_name)
        p = (e.priority or "").upper()
        if not r.get("targeted") and p in PRIORITY_ORDER and (
                r["priority"] is None or PRIORITY_ORDER[p] < PRIORITY_ORDER[r["priority"]]):
            r["priority"] = p

    # each squad's target meet: the first one its swimmers have targets for
    squad_target: dict = {}
    for m in meets:
        for t in targets:
            s = swimmers.get(t.swimmer_id)
            if t.meet_id == m.id and s:
                squad_target.setdefault(s.squad or "Squad", m.id)

    out = []
    for m in meets:
        people = sorted(going[m.id].values(), key=lambda r: (PRIORITY_ORDER.get(r["priority"], 3), r["name"]))
        for r in people:
            r.pop("targeted", None)
        counts = {p: sum(1 for r in people if r["priority"] == p) for p in PRIORITY_ORDER}
        out.append({
            "meet_id": m.id,
            "name": m.name,
            "date": str(m.date),
            "date_to": str(m.date_to) if m.date_to else None,
            "location": m.location,
            "course": m.course,
            "days_out": max(0, (m.date - today).days),
            "on_now": m.date <= today,
            "target_for": sorted(sq for sq, mid in squad_target.items() if mid == m.id),
            "priority_counts": counts,
            "swimmers": people,
        })
    return {
        "meets": out,
        "swimmer_count": len({r["swimmer_id"] for m in out for r in m["swimmers"]}),
    }


@router.get("/unwell")
def unwell_swimmers(db: DBSession = Depends(get_db)):
    """
    Who is injured or ill right now: the coach's "Right now" notes, then any
    injury logged as an absence, then swimmers marked injured on their profile,
    each only when nothing above already covers them.
    """
    from backend.services import current_notes as CN
    today = date.today()
    on_squad = ("active", "injury")
    items, covered = [], set()
    for n in CN.active_notes(db, None, today):
        if n.kind not in ("injury", "illness"):
            continue
        if n.swimmer and (not n.swimmer.active or n.swimmer.status not in on_squad):
            continue
        covered.add(n.swimmer_id)
        items.append({
            "swimmer_id": n.swimmer_id,
            "name": n.swimmer.name if n.swimmer else "Swimmer",
            "kind": n.kind,
            "title": n.title,
            "impact": n.impact,
            "since": n.date_from.isoformat() if n.date_from else None,
            "until": n.until.isoformat() if n.until else None,
            "source": "note",
        })
    absences = db.query(models.SwimmerException, models.Swimmer).join(
        models.Swimmer, models.SwimmerException.swimmer_id == models.Swimmer.id,
    ).filter(
        models.SwimmerException.date_from <= today,
        models.SwimmerException.date_to >= today,
        models.Swimmer.active == True,
        models.Swimmer.status.in_(on_squad),
    ).all()
    for ex, swimmer in absences:
        if swimmer.id in covered or normalise_reason(ex.reason) != "injury":
            continue
        covered.add(swimmer.id)
        items.append({
            "swimmer_id": swimmer.id,
            "name": swimmer.name,
            "kind": "injury",
            "title": ex.notes or "Injured",
            "impact": None,
            "since": ex.date_from.isoformat(),
            "until": ex.date_to.isoformat(),
            "source": "absence",
        })
    for swimmer in db.query(models.Swimmer).filter(
        models.Swimmer.active == True, models.Swimmer.status == "injury",
    ).all():
        if swimmer.id in covered:
            continue
        items.append({
            "swimmer_id": swimmer.id, "name": swimmer.name, "kind": "injury",
            "title": "Marked injured on their profile", "impact": None,
            "since": None, "until": None, "source": "profile",
        })
    order = {"injury": 0, "illness": 1}
    items.sort(key=lambda r: (order.get(r["kind"], 2), r["name"]))
    return {"items": items}


@router.get("/sessions-awaiting-debrief")
def sessions_awaiting_debrief(db: DBSession = Depends(get_db)):
    """
    Completed sessions from the last few days with nothing said about them yet.

    Kept to a short window: a debrief is worth doing while the session is still
    fresh, and stale prompts train the coach to ignore the card.
    """
    today = date.today()
    window_start = today - timedelta(days=3)
    sessions = db.query(models.Session).filter(
        models.Session.date >= window_start,
        models.Session.date <= today,
        models.Session.status == "completed",
        # Nobody expects a debrief of a session someone else took.
        models.Session.taken_by_other.isnot(True),
        # The coach chose not to debrief this one.
        models.Session.debrief_skipped_at == None,
    ).order_by(models.Session.date.desc()).all()

    items = []
    for session in sessions:
        debrief = db.query(models.SessionDebrief).filter(
            models.SessionDebrief.session_id == session.id,
        ).first()
        if debrief:
            continue
        attended = db.query(models.SessionEntry).filter(
            models.SessionEntry.session_id == session.id,
            models.SessionEntry.attended == True,
        ).count()
        if not attended:
            continue
        items.append({
            "session_id": session.id,
            "title": session.title or "Session",
            "date": str(session.date),
            "days_since": (today - session.date).days,
            "attended": attended,
        })
    return {"items": items}


@router.post("/sessions-awaiting-debrief/{session_id}/skip")
def skip_session_debrief(session_id: int, db: DBSession = Depends(get_db)):
    """Take this session off Home's debrief card without debriefing it."""
    session = db.query(models.Session).filter(models.Session.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.debrief_skipped_at = datetime.now(timezone.utc)
    db.commit()
    return {"skipped": True, "session_id": session.id}


def _meet_has_results(db: DBSession, meet, last_day: date) -> bool:
    """
    Whether this meet's times are already recorded.

    Times entered through the meet screen carry meet_id. Times that arrived by
    file import predate that link, so fall back to matching on the meet name
    within its own dates — otherwise an already-imported meet keeps prompting.
    """
    if db.query(models.SwimTime).filter(models.SwimTime.meet_id == meet.id).count():
        return True
    return bool(db.query(models.SwimTime).filter(
        models.SwimTime.date.between(meet.date, last_day),
        models.SwimTime.meet.ilike(f"%{(meet.name or '')[:20]}%"),
    ).count())


def _meets_awaiting_results(db: DBSession, today: date) -> list[dict]:
    """
    Meets that finished in the last fortnight and still have no results recorded.

    Surfaces from the day after the meet ends, so the prompt never competes with
    the meet itself, and disappears once results exist or the coach dismisses it.
    """
    window_start = today - timedelta(days=14)
    finished = db.query(models.Meet).filter(
        models.Meet.date != None,
        models.Meet.date >= window_start,
        models.Meet.results_prompt_dismissed_at == None,
    ).order_by(models.Meet.date.desc()).all()

    items = []
    for meet in finished:
        last_day = meet.date_to or meet.date
        if last_day >= today:
            continue
        if _meet_has_results(db, meet, last_day):
            continue
        expected = db.query(models.MeetTarget).filter(
            models.MeetTarget.meet_id == meet.id,
        ).count()
        items.append({
            "meet_id": meet.id,
            "name": meet.name,
            "date": str(meet.date),
            "date_to": str(meet.date_to) if meet.date_to else None,
            "location": meet.location,
            "course": meet.course,
            "days_since": (today - last_day).days,
            "swimmer_count": expected,
        })
    return items


@router.get("/availability")
def squad_availability(days: int = 42, db: DBSession = Depends(get_db)):
    """Current and upcoming excused non-training periods for active swimmers."""
    today = date.today()
    cutoff = today + timedelta(days=max(1, min(days, 180)))
    swimmers = db.query(models.Swimmer).filter(
        models.Swimmer.active == True,
        models.Swimmer.status == "active",
    ).order_by(models.Swimmer.name).all()
    swimmer_map = {swimmer.id: swimmer for swimmer in swimmers}
    ranges = availability_ranges(db, swimmer_map, today, cutoff)
    source_priority = {"meet_entry": 0, "exception": 1, "load_event": 2}
    items = []
    seen = set()
    for swimmer_id, events in ranges.items():
        for event in sorted(events, key=lambda item: source_priority.get(item["source"], 9)):
            key = (swimmer_id, event["reason"], event["date_from"], event["date_to"])
            if key in seen:
                continue
            seen.add(key)
            swimmer = swimmer_map.get(swimmer_id)
            if not swimmer:
                continue
            items.append({
                **event,
                "swimmer_name": swimmer.name,
                "date_from": event["date_from"].isoformat(),
                "date_to": event["date_to"].isoformat(),
                "is_current": event["date_from"] <= today <= event["date_to"],
                "days_until": max(0, (event["date_from"] - today).days),
            })
    items.sort(key=lambda item: (not item["is_current"], item["date_from"], item["swimmer_name"]))
    return {
        "items": items,
        "current_count": sum(item["is_current"] for item in items),
        "upcoming_count": sum(not item["is_current"] for item in items),
        "through": cutoff.isoformat(),
    }


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

    # Current-season attendance comes only from explicitly recorded registers.
    current_season = db.query(models.Season).filter(
        models.Season.is_current.is_(True),
    ).order_by(models.Season.date_from.desc()).first()
    monitoring_start = max(four_weeks_ago, current_season.date_from) if current_season else four_weeks_ago
    attendance_rows = []
    if current_season and current_season.date_from <= today <= current_season.date_to:
        attendance_rows = db.query(
            models.SessionEntry.swimmer_id,
            models.SessionEntry.attended,
            models.Session.date,
            models.Session.taken_by_other,
        ).join(
            models.Session, models.SessionEntry.session_id == models.Session.id,
        ).filter(
            models.SessionEntry.swimmer_id.in_(swimmer_ids),
            models.SessionEntry.attended.is_not(None),
            models.Session.date >= monitoring_start,
            models.Session.date <= today,
            models.Session.status != "cancelled",
        ).all()
    availability = availability_ranges(db, swimmer_ids, monitoring_start, today)
    attended_by_swimmer = defaultdict(int)
    recorded_by_swimmer = defaultdict(int)
    excused_by_swimmer = defaultdict(int)
    for sw_id, attended, session_date, taken_by_other in attendance_rows:
        if not attended and taken_by_other:
            continue  # someone else took it: their register isn't the coach's to vouch for
        if not attended and is_excused(availability, sw_id, session_date):
            excused_by_swimmer[sw_id] += 1
            continue
        recorded_by_swimmer[sw_id] += 1
        if attended:
            attended_by_swimmer[sw_id] += 1

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
        recorded = recorded_by_swimmer.get(sw.id, 0)
        current_availability = next((
            event for event in availability.get(sw.id, [])
            if event["date_from"] <= today <= event["date_to"]
        ), None)
        if not current_season or today < current_season.date_from:
            attendance_state = "season_not_started"
        elif today > current_season.date_to:
            attendance_state = "season_ended"
        elif recorded < 4:
            attendance_state = "building_baseline"
        else:
            attendance_state = "established"

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
            "sessions_expected": recorded,
            "sessions_recorded": recorded,
            "attendance_state": attendance_state,
            "baseline_sessions_needed": max(0, 4 - recorded),
            "sessions_excused": excused_by_swimmer.get(sw.id, 0),
            "current_availability": ({
                **current_availability,
                "date_from": current_availability["date_from"].isoformat(),
                "date_to": current_availability["date_to"].isoformat(),
            } if current_availability else None),
            "monitoring_start": monitoring_start.isoformat(),
            "season_id": current_season.id if current_season else None,
            "season_name": current_season.name if current_season else None,
            "approaching_target": target_data,
            "last_observation": obs_data,
            "has_recent_skill_flag": sw.id in flagged,
        })

    return result
