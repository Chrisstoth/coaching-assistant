from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DBSession

from backend.database import get_db
from backend import models
from backend.services.claude_service import build_swimmer_context
from backend.services.openai_service import physiological_analysis

router = APIRouter()


class PhysioQuestion(BaseModel):
    question: str


@router.post("/physiology/{swimmer_id}")
def ask_physiology(swimmer_id: int, body: PhysioQuestion, db: DBSession = Depends(get_db)):
    """Ask OpenAI a physiological question about a specific swimmer."""
    swimmer = db.query(models.Swimmer).filter(models.Swimmer.id == swimmer_id).first()
    if not swimmer:
        raise HTTPException(status_code=404, detail="Swimmer not found")

    context = build_swimmer_context(swimmer, db)
    answer = physiological_analysis(context, body.question)

    db.add(models.AIAnalysis(
        swimmer_id=swimmer_id,
        analysis_type="physiological",
        content=f"Q: {body.question}\n\nA: {answer}",
        model_used="gpt-4o",
    ))
    db.commit()

    return {"question": body.question, "answer": answer}


@router.get("/analyses/{swimmer_id}")
def get_analyses(swimmer_id: int, analysis_type: str = None, limit: int = 20, db: DBSession = Depends(get_db)):
    """Retrieve stored AI analyses for a swimmer."""
    q = db.query(models.AIAnalysis).filter(models.AIAnalysis.swimmer_id == swimmer_id)
    if analysis_type:
        q = q.filter(models.AIAnalysis.analysis_type == analysis_type)
    analyses = q.order_by(models.AIAnalysis.created_at.desc()).limit(limit).all()
    return [
        {
            "id": a.id,
            "type": a.analysis_type,
            "content": a.content,
            "model": a.model_used,
            "created_at": a.created_at,
            "session_id": a.session_id,
        }
        for a in analyses
    ]
