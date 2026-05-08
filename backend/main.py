from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from backend.database import init_db
from backend.routers import swimmers, sessions, times, meets, ai, periodization, schedule, coaching_context, ai_chat, coaching_notes


def _migrate_threads():
    """Add thread_id column if missing, create default thread, migrate orphan messages."""
    from sqlalchemy.orm import Session as OrmSession
    from sqlalchemy import text, inspect as sa_inspect
    from backend.database import engine
    from backend import models

    insp = sa_inspect(engine)
    if "coach_ai_messages" in insp.get_table_names():
        cols = [c["name"] for c in insp.get_columns("coach_ai_messages")]
        if "thread_id" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE coach_ai_messages ADD COLUMN thread_id INTEGER REFERENCES ai_threads(id)"))
                conn.commit()

    with OrmSession(engine) as db:
        if db.query(models.AIThread).count() == 0:
            default = models.AIThread(name="Main")
            db.add(default)
            db.flush()
            db.query(models.CoachAIMessage).filter(
                models.CoachAIMessage.thread_id.is_(None)
            ).update({"thread_id": default.id})
            db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _migrate_threads()
    yield


app = FastAPI(
    title="Swimming Coaching Assistant",
    description="AI-powered coaching assistant for swim squads",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(swimmers.router, prefix="/swimmers", tags=["Swimmers"])
app.include_router(sessions.router, prefix="/sessions", tags=["Sessions"])
app.include_router(times.router, prefix="/times", tags=["Times"])
app.include_router(meets.router, prefix="/meets", tags=["Meets"])
app.include_router(ai.router, prefix="/ai", tags=["AI"])
app.include_router(periodization.router, prefix="/periodization", tags=["Periodization"])
app.include_router(schedule.router, prefix="/schedule", tags=["Schedule"])
app.include_router(coaching_context.router, prefix="/coaching-context", tags=["Coaching Context"])
app.include_router(ai_chat.router, prefix="/ai-chat", tags=["AI Chat"])
app.include_router(coaching_notes.router, prefix="/coaching-notes", tags=["Coaching Notes"])


@app.get("/health")
def health():
    return {"status": "ok"}
