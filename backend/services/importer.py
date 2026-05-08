"""
Handles ingestion of swimrankings CSVs and bulk .xlsx session files.
"""
import re
import io
from datetime import datetime, date
from typing import Optional
import pandas as pd
from rapidfuzz import process as fuzzy_process
from sqlalchemy.orm import Session as DBSession

from backend import models


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def parse_time_to_seconds(time_str: str) -> Optional[float]:
    """Convert 'MM:SS.ss' or 'SS.ss' to float seconds."""
    if not time_str or pd.isna(time_str):
        return None
    time_str = str(time_str).strip()
    if ":" in time_str:
        parts = time_str.split(":")
        try:
            return float(parts[0]) * 60 + float(parts[1])
        except ValueError:
            return None
    try:
        return float(time_str)
    except ValueError:
        return None


def infer_distance_from_time(time_seconds: float, stroke: str) -> Optional[int]:
    """
    Rough distance inference from time + stroke.
    Returns most likely distance in metres, or None.
    """
    if time_seconds is None:
        return None
    stroke_lower = (stroke or "").lower()
    # Very rough ranges for each distance/stroke combo
    ranges = {
        50: (20, 80),
        100: (45, 200),
        200: (100, 400),
        400: (230, 600),
        800: (480, 1100),
        1500: (900, 2200),
    }
    # Butterfly and backstroke are slightly slower at 200+
    for dist, (lo, hi) in ranges.items():
        if lo <= time_seconds <= hi:
            return dist
    return None


# ---------------------------------------------------------------------------
# Swimmer matching
# ---------------------------------------------------------------------------

def match_or_create_swimmer(
    name: str,
    swimrankings_id: Optional[str],
    dob: Optional[str],
    gender: Optional[str],
    db: DBSession,
    threshold: int = 85,
) -> models.Swimmer:
    """
    Return existing Swimmer or create a new one.
    Matching priority: swimrankings_id > exact name > fuzzy name.
    """
    # 1. Match by swimrankings ID
    if swimrankings_id:
        existing = db.query(models.Swimmer).filter(
            models.Swimmer.swimrankings_id == str(swimrankings_id)
        ).first()
        if existing:
            return existing

    # 2. Exact name match
    existing = db.query(models.Swimmer).filter(
        models.Swimmer.name == name
    ).first()
    if existing:
        return existing

    # 3. Fuzzy name match
    all_names = [s.name for s in db.query(models.Swimmer.name).all()]
    if all_names:
        result = fuzzy_process.extractOne(name, all_names)
        match, score = (result[0], result[1]) if result else (None, 0)
        if score >= threshold:
            existing = db.query(models.Swimmer).filter(
                models.Swimmer.name == match
            ).first()
            if existing:
                return existing

    # 4. Create new swimmer
    parsed_dob = None
    if dob and not pd.isna(dob):
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%m/%d/%Y"):
            try:
                parsed_dob = datetime.strptime(str(dob), fmt).date()
                break
            except ValueError:
                continue

    swimmer = models.Swimmer(
        name=name,
        swimrankings_id=str(swimrankings_id) if swimrankings_id and not pd.isna(swimrankings_id) else None,
        dob=parsed_dob,
        gender=str(gender)[0].upper() if gender and not pd.isna(gender) else None,
        active=True,
    )
    db.add(swimmer)
    db.flush()  # get ID without full commit
    return swimmer


# ---------------------------------------------------------------------------
# Swimrankings CSV import
# ---------------------------------------------------------------------------

def import_swimrankings_csv(
    file_content: bytes,
    event_name: str,
    db: DBSession,
) -> dict:
    """
    Parse a swimrankings CSV export and upsert times into the DB.

    Expected columns (subset used):
    Time, WA Pts, Round, Date, Meet, Venue, Club, Level,
    Name, ID, Stroke, Course, Split 1-8, Gender, Age, WA Points/Age, DoB
    """
    df = pd.read_csv(io.BytesIO(file_content))
    df.columns = [c.strip() for c in df.columns]

    results = {"imported": 0, "skipped": 0, "new_swimmers": 0, "errors": []}

    split_cols = [c for c in df.columns if re.match(r"Split \d+", c)]

    for _, row in df.iterrows():
        try:
            name = str(row.get("Name", "")).strip()
            if not name:
                continue

            swimmer = match_or_create_swimmer(
                name=name,
                swimrankings_id=row.get("ID"),
                dob=row.get("DoB"),
                gender=row.get("Gender"),
                db=db,
            )
            is_new = swimmer.id is None
            if is_new:
                results["new_swimmers"] += 1

            time_seconds = parse_time_to_seconds(row.get("Time"))
            if time_seconds is None:
                results["errors"].append(f"Could not parse time for {name}: {row.get('Time')}")
                continue

            stroke = str(row.get("Stroke", "")).strip()
            course = str(row.get("Course", "")).strip().upper()

            # Parse distance from event_name if it starts with a number, else infer from time
            distance = None
            if event_name:
                m = re.match(r'^(\d+)', event_name.strip())
                if m:
                    distance = int(m.group(1))
            if distance is None:
                distance = infer_distance_from_time(time_seconds, stroke)

            # Build canonical event string: always "{base} {course}"
            # Strip any existing course suffix from event_name to avoid duplication
            base = (event_name or f"{distance or '?'} {stroke}").strip()
            for suffix in ('SCM', 'LCM'):
                if base.upper().endswith(suffix):
                    base = base[:-len(suffix)].strip()
            constructed_event = f"{base} {course}".strip() if course else base

            # Parse date
            raw_date = row.get("Date")
            parsed_date = None
            if raw_date and not pd.isna(raw_date):
                for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
                    try:
                        parsed_date = datetime.strptime(str(raw_date), fmt).date()
                        break
                    except ValueError:
                        continue

            # Splits
            splits = []
            for sc in split_cols:
                val = row.get(sc)
                splits.append(parse_time_to_seconds(val) if val and not pd.isna(val) else None)

            # Dedup: same swimmer + event + date + time
            existing_time = db.query(models.SwimTime).filter(
                models.SwimTime.swimmer_id == swimmer.id,
                models.SwimTime.event == constructed_event,
                models.SwimTime.date == parsed_date,
                models.SwimTime.time_seconds == time_seconds,
            ).first()

            if existing_time:
                results["skipped"] += 1
                continue

            wa_pts = None
            raw_wa = row.get("WA Pts")
            if raw_wa and not pd.isna(raw_wa):
                try:
                    wa_pts = float(raw_wa)
                except ValueError:
                    pass

            wa_pts_age = None
            raw_wpa = row.get("WA Points/Age")
            if raw_wpa and not pd.isna(raw_wpa):
                try:
                    wa_pts_age = float(raw_wpa)
                except ValueError:
                    pass

            age_at_swim = None
            raw_age = row.get("Age")
            if raw_age and not pd.isna(raw_age):
                try:
                    age_at_swim = float(raw_age)
                except ValueError:
                    pass

            swim_time = models.SwimTime(
                swimmer_id=swimmer.id,
                event=constructed_event,
                stroke=stroke,
                course=course,
                distance=distance,
                time_seconds=time_seconds,
                wa_points=wa_pts,
                wa_points_age=wa_pts_age,
                date=parsed_date,
                meet=str(row.get("Meet", "")).strip() or None,
                venue=str(row.get("Venue", "")).strip() or None,
                level=str(row.get("Level", "")).strip() or None,
                round=str(row.get("Round", "")).strip() or None,
                splits=splits if any(s is not None for s in splits) else None,
                age_at_swim=age_at_swim,
                source="csv",
            )
            db.add(swim_time)
            results["imported"] += 1

        except Exception as e:
            results["errors"].append(f"Row error ({row.get('Name', '?')}): {str(e)}")

    db.commit()
    return results


# ---------------------------------------------------------------------------
# Excel session import (single file)
# ---------------------------------------------------------------------------

def import_session_xlsx(
    file_content: bytes,
    filename: str,
    db: DBSession,
) -> dict:
    """
    Parse a single .xlsx session file.
    Tries to extract: date, title, group structure (1/2/3), set content.
    Returns the created Session id and any warnings.
    """
    result = {"session_id": None, "warnings": []}

    # Infer date from filename (e.g. "2024-03-15 Thursday AM.xlsx")
    inferred_date = None
    date_match = re.search(r"(\d{4}-\d{2}-\d{2}|\d{2}[\-/]\d{2}[\-/]\d{4})", filename)
    if date_match:
        for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
            try:
                inferred_date = datetime.strptime(date_match.group(1), fmt).date()
                break
            except ValueError:
                continue

    xl = pd.ExcelFile(io.BytesIO(file_content))
    sheet_name = xl.sheet_names[0]
    df = xl.parse(sheet_name, header=None)

    # Flatten all cell values into text lines for parsing
    lines = []
    for _, row in df.iterrows():
        row_text = " | ".join(
            str(v).strip() for v in row if v is not None and str(v).strip() not in ("", "nan")
        )
        if row_text:
            lines.append(row_text)

    raw_text = "\n".join(lines)

    # Try to pick up a title from first non-empty row
    title = lines[0][:120] if lines else filename.replace(".xlsx", "")

    # Try to detect date in sheet content if not in filename
    if not inferred_date:
        for line in lines[:5]:
            for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
                try:
                    inferred_date = datetime.strptime(line.strip(), fmt).date()
                    break
                except ValueError:
                    continue
            if inferred_date:
                break

    if not inferred_date:
        result["warnings"].append(f"Could not infer date from '{filename}' — session saved without date")

    # Group detection: look for "Group 1/2/3" or "Lane 1/2/3" markers
    groups_raw = {}
    current_group = None
    group_pattern = re.compile(r"group\s*(\d)", re.IGNORECASE)
    for line in lines:
        gm = group_pattern.search(line)
        if gm:
            current_group = int(gm.group(1))
            groups_raw[current_group] = []
        elif current_group is not None:
            groups_raw[current_group].append(line)

    if not groups_raw:
        # No explicit group markers — treat whole session as group 1
        groups_raw[1] = lines
        result["warnings"].append("No group markers found — all content assigned to Group 1")

    # Build session
    planned_content = {
        str(g): {"sets": "\n".join(content)} for g, content in groups_raw.items()
    }

    session = models.Session(
        date=inferred_date,
        title=title,
        planned_content=planned_content,
        source="excel",
        coach_notes=f"Imported from: {filename}",
    )
    db.add(session)
    db.flush()

    for group_num, content in groups_raw.items():
        sg = models.SessionGroup(
            session_id=session.id,
            group_number=group_num,
            description="\n".join(content[:5]),  # first 5 lines as description
            sets={"raw": "\n".join(content)},
        )
        db.add(sg)

    db.commit()
    result["session_id"] = session.id
    return result


# ---------------------------------------------------------------------------
# Bulk Excel session import
# ---------------------------------------------------------------------------

def bulk_import_sessions(
    files: list[tuple[str, bytes]],
    db: DBSession,
) -> dict:
    """
    Import multiple .xlsx session files.
    files: list of (filename, bytes) tuples
    """
    summary = {"sessions_created": 0, "errors": [], "warnings": [], "session_ids": []}

    for filename, content in files:
        try:
            result = import_session_xlsx(content, filename, db)
            if result["session_id"]:
                summary["sessions_created"] += 1
                summary["session_ids"].append(result["session_id"])
            summary["warnings"].extend([f"[{filename}] {w}" for w in result["warnings"]])
        except Exception as e:
            summary["errors"].append(f"[{filename}] {str(e)}")

    return summary
