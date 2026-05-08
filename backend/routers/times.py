import json
from typing import Optional
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Query
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.importer import import_swimrankings_csv

router = APIRouter()


@router.post("/import/csv")
async def import_csv(
    file: UploadFile = File(...),
    event_name: str = Form(""),
    db: DBSession = Depends(get_db),
):
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")
    content = await file.read()
    result = import_swimrankings_csv(content, event_name, db)
    return result


@router.post("/import/csv/bulk")
async def import_csv_bulk(
    files: list[UploadFile] = File(...),
    event_names: str = Form("[]"),   # JSON array of strings, matching file order
    db: DBSession = Depends(get_db),
):
    """
    Import multiple swimrankings CSV files in one request.
    event_names: JSON array e.g. '["100 Freestyle", "200 Backstroke"]'
    If shorter than files list, remaining files get empty event name (inferred).
    """
    try:
        names = json.loads(event_names)
    except Exception:
        names = []

    summary = {"files": [], "total_imported": 0, "total_skipped": 0, "total_errors": 0}

    for i, file in enumerate(files):
        event_name = names[i] if i < len(names) else ""
        content = await file.read()
        try:
            result = import_swimrankings_csv(content, event_name, db)
            summary["files"].append({
                "filename": file.filename,
                "event": event_name or "(inferred)",
                "imported": result["imported"],
                "skipped": result["skipped"],
                "errors": result["errors"],
            })
            summary["total_imported"] += result["imported"]
            summary["total_skipped"] += result["skipped"]
            summary["total_errors"] += len(result["errors"])
        except Exception as e:
            summary["files"].append({"filename": file.filename, "error": str(e)})
            summary["total_errors"] += 1

    return summary


@router.delete("", status_code=200)
def delete_times(
    swimmer_id: Optional[int] = Query(None),
    db: DBSession = Depends(get_db),
):
    """
    Delete swim times.
    - No params: deletes ALL times for ALL swimmers.
    - ?swimmer_id=X: deletes only that swimmer's times.
    Returns count of deleted rows.
    """
    q = db.query(models.SwimTime)
    if swimmer_id is not None:
        q = q.filter(models.SwimTime.swimmer_id == swimmer_id)
    count = q.count()
    q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": count}
