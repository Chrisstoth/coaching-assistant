"""What each swimmer's training has actually given them, worked out in code.

The physiologist's judgement is only as good as the numbers under it, and a
fast model asked to add up eight weeks of session loads will get the sums
wrong. So the arithmetic happens here and the model only interprets it:

    - how much of each kind of work the swimmer got, against what their usual
      group swam across every session they were expected at
    - which kinds of session they keep missing
    - high-intensity work this week against their own recent usual
    - hard days stacked back to back, and how long since their last speed work
    - illness, injury and other load events, and the coach's own session notes

"Expected at" follows the register: a session counts when attendance was taken
for the swimmer and they were not excused (exams, holiday, competing).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.services.availability import availability_ranges, is_excused

VOLUME_KEYS = ["aerobic", "threshold", "vo2", "race_pace", "lact_tol", "short_race_pace", "kicking", "sprint"]
HIGH_INTENSITY = ("vo2", "race_pace", "lact_tol", "short_race_pace", "sprint")
SPEED = ("short_race_pace", "sprint")          # fast, neural work
AEROBIC = ("aerobic", "threshold")

ZONE_LABELS = {
    "aerobic": "aerobic", "threshold": "threshold", "vo2": "VO2", "race_pace": "race pace",
    "lact_tol": "lactate", "short_race_pace": "short race pace", "kicking": "kick", "sprint": "sprint",
}

WINDOW_WEEKS = 6
HARD_DAY_METRES = 400      # high-intensity metres that make a day a hard one
MIN_CHRONIC_HI = 300       # below this weekly usual, a ratio means nothing


@dataclass
class LoadProfile:
    swimmer_id: int
    name: str
    window_from: date
    window_to: date
    opportunities: int = 0
    attended: int = 0
    excused: int = 0
    by_focus: dict = field(default_factory=dict)        # focus -> [attended, offered]
    zone_got: dict = field(default_factory=dict)        # zone -> metres swum
    zone_available: dict = field(default_factory=dict)  # zone -> metres their group swam
    weekly: list = field(default_factory=list)          # [{week, total, hi, attended, offered}]
    hi_this_week: float = 0.0
    hi_usual: float = 0.0
    last_speed: Optional[date] = None
    hard_days_in_row: int = 0
    load_breakdown_missing: int = 0                     # attended sessions with no zone breakdown
    events: list = field(default_factory=list)
    notes: list = field(default_factory=list)           # [(date, text)]
    flags: list = field(default_factory=list)

    @property
    def attendance_pct(self) -> Optional[int]:
        return round(self.attended / self.opportunities * 100) if self.opportunities else None

    def share(self, zones) -> Optional[int]:
        """Percent of the available work in ``zones`` the swimmer actually got."""
        available = sum(self.zone_available.get(z, 0) for z in zones)
        if available <= 0:
            return None
        return round(sum(self.zone_got.get(z, 0) for z in zones) / available * 100)

    @property
    def hi_ratio(self) -> Optional[float]:
        if self.hi_usual < MIN_CHRONIC_HI:
            return None
        return round(self.hi_this_week / self.hi_usual, 2)


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _hi(volume: dict, zones=HIGH_INTENSITY) -> float:
    return float(sum((volume or {}).get(z, 0) or 0 for z in zones))


def _group_volume(session: models.Session, swimmer_id: int, group_number: Optional[int]) -> dict:
    """What the swimmer's group swam in a session - used for sessions they missed."""
    groups = list(session.groups or [])
    if not groups:
        return {}
    group = next((g for g in groups if g.group_number == group_number), None) or groups[0]
    for sub in group.sub_groups or []:
        if swimmer_id in (sub.swimmer_ids or []) and sub.volume_breakdown:
            return sub.volume_breakdown
    if group.volume_breakdown:
        return group.volume_breakdown
    subs = [s for s in group.sub_groups or [] if s.volume_breakdown]
    return subs[0].volume_breakdown if subs else {}


def load_profiles(db: DBSession, swimmers: list, today: Optional[date] = None,
                  weeks: int = WINDOW_WEEKS) -> list:
    """One LoadProfile per swimmer, all worked out from a handful of queries."""
    today = today or date.today()
    window_from = _monday(today) - timedelta(weeks=weeks - 1)
    ids = [s.id for s in swimmers]
    if not ids:
        return []

    rows = (
        db.query(models.SessionEntry, models.Session)
        .join(models.Session, models.SessionEntry.session_id == models.Session.id)
        .filter(
            models.SessionEntry.swimmer_id.in_(ids),
            models.SessionEntry.attended.is_not(None),
            models.Session.date >= window_from,
            models.Session.date <= today,
            models.Session.status != "cancelled",
        )
        .all()
    )
    loads = db.query(models.SwimmerSessionLoad).filter(
        models.SwimmerSessionLoad.swimmer_id.in_(ids),
        models.SwimmerSessionLoad.session_date >= window_from,
        models.SwimmerSessionLoad.session_date <= today,
    ).all()
    load_by = {(l.swimmer_id, l.session_id): l for l in loads}
    excused = availability_ranges(db, ids, window_from, today)

    events = db.query(models.SwimmerLoadEvent).filter(
        models.SwimmerLoadEvent.swimmer_id.in_(ids),
        models.SwimmerLoadEvent.date_from <= today,
    ).all()
    observations = db.query(models.SwimmerObservation).filter(
        models.SwimmerObservation.swimmer_id.in_(ids),
        models.SwimmerObservation.date >= window_from,
    ).all()

    by_swimmer = defaultdict(list)
    for entry, session in rows:
        by_swimmer[entry.swimmer_id].append((entry, session))

    profiles = []
    for swimmer in swimmers:
        p = LoadProfile(swimmer_id=swimmer.id, name=swimmer.name, window_from=window_from, window_to=today)
        mine = sorted(by_swimmer.get(swimmer.id, []), key=lambda r: r[1].date)
        usual_group = Counter(e.group_done for e, _ in mine if e.attended and e.group_done).most_common(1)
        usual_group = usual_group[0][0] if usual_group else None

        weekly = defaultdict(lambda: {"total": 0.0, "hi": 0.0, "attended": 0, "offered": 0})
        daily_hi = defaultdict(float)
        for entry, session in mine:
            if not entry.attended and is_excused(excused, swimmer.id, session.date):
                p.excused += 1
                continue
            p.opportunities += 1
            week = weekly[_monday(session.date)]
            week["offered"] += 1
            focus = (session.energy_system_focus or "").strip().lower() or None
            if focus:
                p.by_focus.setdefault(focus, [0, 0])[1] += 1

            load = load_by.get((swimmer.id, session.id))
            if entry.attended:
                p.attended += 1
                week["attended"] += 1
                if focus:
                    p.by_focus[focus][0] += 1
                volume = (load.volume_breakdown if load else None) or {}
                if not volume:
                    p.load_breakdown_missing += 1
                    volume = _group_volume(session, swimmer.id, entry.group_done or entry.group_planned)
                for zone in VOLUME_KEYS:
                    metres = float(volume.get(zone, 0) or 0)
                    p.zone_got[zone] = p.zone_got.get(zone, 0) + metres
                    p.zone_available[zone] = p.zone_available.get(zone, 0) + metres
                week["total"] += sum(float(volume.get(z, 0) or 0) for z in VOLUME_KEYS)
                hi = _hi(volume)
                week["hi"] += hi
                daily_hi[session.date] += hi
                if _hi(volume, SPEED) > 0 and (p.last_speed is None or session.date > p.last_speed):
                    p.last_speed = session.date
            else:
                volume = _group_volume(session, swimmer.id, entry.group_planned or usual_group)
                for zone in VOLUME_KEYS:
                    p.zone_available[zone] = p.zone_available.get(zone, 0) + float(volume.get(zone, 0) or 0)

            if entry.coach_observation and entry.coach_observation.strip():
                p.notes.append((session.date, entry.coach_observation.strip()))

        p.weekly = [{"week": wk, **vals} for wk, vals in sorted(weekly.items())]

        # High-intensity: the last seven days against the four weeks before.
        last7 = sum(v for d, v in daily_hi.items() if d > today - timedelta(days=7))
        before = [v for d, v in daily_hi.items()
                  if today - timedelta(days=35) < d <= today - timedelta(days=7)]
        p.hi_this_week = last7
        p.hi_usual = sum(before) / 4 if before else 0.0

        # Longest run of consecutive hard days in the last fortnight.
        run = best = 0
        for offset in range(13, -1, -1):
            day = today - timedelta(days=offset)
            run = run + 1 if daily_hi.get(day, 0) >= HARD_DAY_METRES else 0
            best = max(best, run)
        p.hard_days_in_row = best

        for ev in events:
            if ev.swimmer_id != swimmer.id:
                continue
            ongoing = not ev.resolved
            recent = (ev.date_to or ev.date_from) >= window_from
            if ongoing or recent:
                span = f"{ev.date_from}" + (f" to {ev.date_to}" if ev.date_to else "")
                p.events.append(f"{ev.event_type} ({span}, severity {ev.severity})"
                                + (" ONGOING" if ongoing else "")
                                + (f": {ev.description[:120]}" if ev.description else ""))

        seen = {text for _, text in p.notes}
        for obs in observations:
            if obs.swimmer_id == swimmer.id and obs.content and obs.content.strip() not in seen:
                p.notes.append((obs.date, f"[{obs.obs_type}] {obs.content.strip()}"))
        p.notes.sort(key=lambda n: n[0] or date.min, reverse=True)

        p.flags = _flags(p, today)
        profiles.append(p)
    return profiles


def _flags(p: LoadProfile, today: date) -> list:
    """Things a physiologist would want to look at. Conservative on purpose."""
    flags = []
    pct = p.attendance_pct
    if pct is not None and p.opportunities >= 4 and pct < 60:
        flags.append(f"attended {p.attended} of {p.opportunities} sessions ({pct}%)")

    aerobic = p.share(AEROBIC)
    if aerobic is not None and sum(p.zone_available.get(z, 0) for z in AEROBIC) >= 2000 and aerobic < 60:
        flags.append(f"got {aerobic}% of the aerobic work their group swam")
    speed = p.share(SPEED)
    if speed is not None and sum(p.zone_available.get(z, 0) for z in SPEED) >= 300 and speed < 50:
        flags.append(f"got {speed}% of the speed work their group swam")

    for focus, (att, offered) in sorted(p.by_focus.items()):
        if offered >= 3 and att / offered < 0.5:
            flags.append(f"missed {offered - att} of {offered} {focus}-focus sessions")

    ratio = p.hi_ratio
    if ratio is not None and ratio >= 1.5:
        flags.append(f"high-intensity work in the last 7 days is {ratio}x their usual week")
    if p.hard_days_in_row >= 3:
        flags.append(f"{p.hard_days_in_row} hard days in a row in the last fortnight")

    speed_offered = sum(p.zone_available.get(z, 0) for z in SPEED) > 0
    if speed_offered and p.attended:
        gap = (today - p.last_speed).days if p.last_speed else None
        if gap is None:
            flags.append(f"no speed work since at least {p.window_from}")
        elif gap >= 14:
            flags.append(f"no speed work for {gap} days")

    flags += [f"load event: {e}" for e in p.events if "ONGOING" in e]
    return flags


def _km(metres: float) -> str:
    return f"{metres / 1000:.1f}km"


def describe(p: LoadProfile, notes: int = 6) -> str:
    """One swimmer's figures, written for the physiologist to read."""
    lines = [f"TRAINING FIGURES for {p.name} ({p.window_from} to {p.window_to}, worked out from the register):"]
    if not p.opportunities:
        lines.append("  No register taken for this swimmer in this window - nothing to work from.")
    else:
        lines.append(f"  Attendance: {p.attended} of {p.opportunities} expected sessions"
                     + (f" ({p.attendance_pct}%)" if p.attendance_pct is not None else "")
                     + (f", {p.excused} more excused" if p.excused else ""))
        if p.by_focus:
            lines.append("  By session focus (attended/expected): " + ", ".join(
                f"{f} {a}/{o}" for f, (a, o) in sorted(p.by_focus.items())))
        got = {z: m for z, m in p.zone_got.items() if m}
        if got or any(p.zone_available.values()):
            parts = []
            for zone in VOLUME_KEYS:
                avail = p.zone_available.get(zone, 0)
                if avail <= 0:
                    continue
                parts.append(f"{ZONE_LABELS[zone]} {_km(p.zone_got.get(zone, 0))} of {_km(avail)}")
            lines.append("  Work got vs what their group swam: " + "; ".join(parts))
        if p.load_breakdown_missing:
            lines.append(f"  ({p.load_breakdown_missing} attended sessions had no per-swimmer breakdown; "
                         "their group's volume was used.)")
        if p.weekly:
            lines.append("  Weekly: " + " | ".join(
                f"{w['week'].strftime('%d %b')}: {w['attended']}/{w['offered']} sessions, "
                f"{_km(w['total'])}, high-intensity {w['hi']:.0f}m" for w in p.weekly))
        ratio = p.hi_ratio
        lines.append(f"  High-intensity (VO2, lactate, race pace, sprint): {p.hi_this_week:.0f}m in the last 7 days, "
                     f"usual {p.hi_usual:.0f}m a week" + (f" (ratio {ratio})" if ratio is not None else ""))
        lines.append(f"  Most hard days in a row (last 14 days): {p.hard_days_in_row}. "
                     f"Last speed work: {p.last_speed or 'none in this window'}")
    if p.events:
        lines.append("  Load events: " + "; ".join(p.events))
    if p.notes:
        lines.append("  Coach's session notes (newest first):")
        lines += [f"    {d}: {text[:220]}" for d, text in p.notes[:notes]]
    else:
        lines.append("  Coach's session notes: none in this window.")
    lines.append("  FLAGS: " + ("; ".join(p.flags) if p.flags else "none"))
    return "\n".join(lines)


def squad_summary(db: DBSession, squad: Optional[str] = None, today: Optional[date] = None,
                  limit: int = 40) -> str:
    """The whole squad at a glance: flagged swimmers first, the rest named."""
    q = db.query(models.Swimmer).filter(models.Swimmer.active.is_(True))
    if squad:
        q = q.filter(models.Swimmer.squad == squad)
    swimmers = q.order_by(models.Swimmer.name).limit(limit).all()
    return swimmers_summary(db, swimmers, "SQUAD TRAINING FIGURES", today=today)


def swimmers_summary(db: DBSession, swimmers: list, heading: str = "TRAINING FIGURES",
                     today: Optional[date] = None) -> str:
    """A group at a glance - a squad, or the swimmers expected at one session."""
    profiles = load_profiles(db, swimmers, today=today)
    if not profiles:
        return f"{heading}: no swimmers."
    flagged = [p for p in profiles if p.flags]
    clear = [p for p in profiles if not p.flags and p.opportunities]
    unknown = [p for p in profiles if not p.opportunities]
    start = profiles[0].window_from
    lines = [f"{heading} since {start} (worked out from the register):"]
    for p in flagged:
        lines.append(f"  {p.name} (attendance {p.attendance_pct if p.attendance_pct is not None else '?'}%, "
                     f"aerobic share {p.share(AEROBIC) if p.share(AEROBIC) is not None else '?'}%, "
                     f"high-intensity {p.hi_this_week:.0f}m vs usual {p.hi_usual:.0f}m): " + "; ".join(p.flags))
    if clear:
        lines.append("  Nothing flagged: " + ", ".join(p.name for p in clear))
    if unknown:
        lines.append("  No register in this window: " + ", ".join(p.name for p in unknown))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The planner's view: is the load building, and when was the last easier week?
# ---------------------------------------------------------------------------

BUILDING_PHASES = ("base", "build", "aerobic", "development", "general", "specific", "prep")
LIGHTER_WEEK = 0.85        # a week under 85% of the three before it counts as lighter
MAX_WEEKS_WITHOUT_LIGHTER = 4


def _phase_on(blocks: list, day: date) -> Optional[str]:
    for block in blocks:
        if block.date_from <= day <= block.date_to:
            return (block.phase_type or "").lower() or None
    return None


def _building(phase: Optional[str]) -> bool:
    return bool(phase) and any(word in phase for word in BUILDING_PHASES)


def _lighter_run(values: list) -> tuple:
    """(weeks since the last lighter week, index of that week or None).

    ``values`` is oldest-first. A week is lighter when it drops below
    LIGHTER_WEEK of the average of the up-to-three weeks before it.
    """
    last = None
    for i in range(1, len(values)):
        before = [v for v in values[max(0, i - 3):i] if v]
        if before and values[i] is not None and values[i] < LIGHTER_WEEK * (sum(before) / len(before)):
            last = i
    since = len(values) - 1 - last if last is not None else len(values)
    return since, last


def progression_summary(db: DBSession, squad: Optional[str] = None, macro_id: Optional[int] = None,
                        today: Optional[date] = None, weeks_back: int = 8, weeks_ahead: int = 6) -> str:
    """Delivered load week by week, the planned curve around today, and what stands out."""
    today = today or date.today()
    this_week = _monday(today)
    start = this_week - timedelta(weeks=weeks_back)
    macro = None
    if macro_id:
        macro = db.query(models.TrainingMacro).filter(models.TrainingMacro.id == macro_id).first()
        squad = squad or (macro.squad if macro else None)

    swimmers_q = db.query(models.Swimmer.id).filter(models.Swimmer.active.is_(True))
    if squad:
        swimmers_q = swimmers_q.filter(models.Swimmer.squad == squad)
    ids = [row[0] for row in swimmers_q.all()]

    blocks_q = db.query(models.SeasonBlock)
    if macro:
        blocks_q = blocks_q.filter(models.SeasonBlock.macro_id == macro.id)
    blocks = blocks_q.order_by(models.SeasonBlock.date_from).all()

    lines = ["LOAD PROGRESSION" + (f" for {squad}" if squad else "") + " (worked out in code):"]
    flags = []

    # What swimmers actually swam: average per swimmer who trained that week.
    delivered = []
    if ids:
        loads = db.query(models.SwimmerSessionLoad).filter(
            models.SwimmerSessionLoad.swimmer_id.in_(ids),
            models.SwimmerSessionLoad.session_date >= start,
            models.SwimmerSessionLoad.session_date < this_week,
        ).all()
        per_week = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
        for load in loads:
            vol = load.volume_breakdown or {}
            slot = per_week[_monday(load.session_date)][load.swimmer_id]
            slot[0] += sum(float(vol.get(z, 0) or 0) for z in VOLUME_KEYS)
            slot[1] += _hi(vol)
        for i in range(weeks_back):
            wk = start + timedelta(weeks=i)
            swimmers = per_week.get(wk, {})
            if swimmers:
                total = sum(v[0] for v in swimmers.values()) / len(swimmers)
                hi = sum(v[1] for v in swimmers.values()) / len(swimmers)
                delivered.append((wk, total, hi, len(swimmers)))
            else:
                delivered.append((wk, None, None, 0))

    recorded = [d for d in delivered if d[1] is not None]
    if recorded:
        parts = []
        previous = None
        for wk, total, hi, n in delivered:
            if total is None:
                parts.append(f"{wk.strftime('%d %b')}: nothing recorded")
                previous = None
                continue
            change = ""
            if previous:
                pct = round((total - previous) / previous * 100)
                change = f" ({pct:+d}%)"
                phase = _phase_on(blocks, wk)
                if _building(phase) and pct > 15:
                    flags.append(f"week of {wk.strftime('%d %b')} jumped {pct}% in a {phase} phase")
                elif _building(phase) and pct < -25:
                    flags.append(f"week of {wk.strftime('%d %b')} fell {abs(pct)}% during a {phase} phase")
            parts.append(f"{wk.strftime('%d %b')}: {_km(total)}{change}, high-intensity {hi:.0f}m, {n} swimmers")
            previous = total
        lines.append("  Delivered per swimmer (average of those who trained): " + " | ".join(parts))
        since, _ = _lighter_run([d[1] for d in delivered])
        lines.append(f"  Weeks since the last lighter delivered week: {since}")
        if since >= MAX_WEEKS_WITHOUT_LIGHTER and len(recorded) >= MAX_WEEKS_WITHOUT_LIGHTER:
            flags.append(f"{since} delivered weeks without a lighter week")
    else:
        lines.append("  Delivered load: no per-swimmer loads recorded in the last "
                     f"{weeks_back} weeks, so progression cannot be checked from the register.")

    # The planned curve (0-100) around today.
    if macro:
        points = db.query(models.SeasonLoadPoint).filter(
            models.SeasonLoadPoint.macro_id == macro.id,
            models.SeasonLoadPoint.pathway_id.is_(None),
            models.SeasonLoadPoint.week_start >= start,
            models.SeasonLoadPoint.week_start <= this_week + timedelta(weeks=weeks_ahead),
        ).order_by(models.SeasonLoadPoint.week_start).all()
        planned = [(p.week_start, p.overall) for p in points if p.overall is not None]
        if planned:
            lines.append("  Planned load (0-100): " + ", ".join(
                f"{wk.strftime('%d %b')} {v}" + (" <- this week" if wk == this_week else "")
                for wk, v in planned))
            ahead = [(wk, v) for wk, v in planned if wk >= this_week]
            run = 0
            for i in range(1, len(ahead)):
                if ahead[i][1] >= ahead[i - 1][1]:
                    run += 1
                else:
                    run = 0
                if run >= MAX_WEEKS_WITHOUT_LIGHTER:
                    flags.append(f"planned load keeps rising or holding for {run + 1} weeks to "
                                 f"{ahead[i][0].strftime('%d %b')} with no easier week")
                    break
        else:
            lines.append("  Planned load: no weekly curve set for this macrocycle yet.")

    phase_now = _phase_on(blocks, today)
    if phase_now:
        lines.append(f"  Phase this week: {phase_now}")
    lines.append("  FLAGS: " + ("; ".join(flags) if flags else "none"))
    return "\n".join(lines)
