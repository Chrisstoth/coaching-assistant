"""Getting a new club started: the first-run checklist on the Home screen."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DBSession

from backend import models
from backend.database import get_db

router = APIRouter()


@router.get("/checklist")
def checklist(db: DBSession = Depends(get_db)):
    """Each first step and whether it's done. Ticks itself off as the club sets up."""
    s = db.query(models.SessionPresentationSettings).first()
    steps = [
        {"key": "pool", "label": "Add your pool times", "detail": "Your regular sessions: days, times and lanes.", "link": "/schedule",
         "done": db.query(models.PoolSlot).filter(models.PoolSlot.active.is_(True)).count() > 0},
        {"key": "swimmers", "label": "Add your swimmers", "detail": "Import a roster or swimrankings file, or add them one by one.", "link": "/import",
         "done": db.query(models.Swimmer).count() > 0},
        {"key": "plan", "label": "Set up the season plan", "detail": "Your groups, phases and meets. Swimmers get a plan from their group.", "link": "/season",
         "done": db.query(models.PlanDoc).filter_by(key="plan").count() > 0},
        {"key": "scale", "label": "Pick your intensity scale", "detail": "How intensity is shown and typed in your sessions.", "link": "/settings/intensity-scales",
         "done": bool(s and (s.effort_scale or s.custom_scales))},
        {"key": "club", "label": "Add your club name and logo", "detail": "For the top of session PDFs.", "link": "/settings/session-presentation",
         "done": bool(s and (s.club_name or s.logo_data_url))},
    ]
    return {"steps": steps, "done": sum(1 for x in steps if x["done"]), "total": len(steps)}
