from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from backend.database import init_db
from backend.routers import swimmers, sessions, times, meets, ai, periodization, schedule, coaching_context, ai_chat, coaching_notes
from backend.routers import auth, benchmarks, season, skills, dashboard
from backend.auth_dep import verify_token


def _migrate_season_blocks():
    """Add new columns to season_blocks and training_macros if missing."""
    from sqlalchemy import text, inspect as sa_inspect
    from backend.database import engine
    insp = sa_inspect(engine)
    tables = insp.get_table_names()

    if "season_blocks" in tables:
        cols = [c["name"] for c in insp.get_columns("season_blocks")]
        with engine.connect() as conn:
            if "squad" not in cols:
                conn.execute(text("ALTER TABLE season_blocks ADD COLUMN squad VARCHAR"))
            if "group_intents" not in cols:
                conn.execute(text("ALTER TABLE season_blocks ADD COLUMN group_intents JSON"))
            if "macro_id" not in cols:
                conn.execute(text("ALTER TABLE season_blocks ADD COLUMN macro_id INTEGER REFERENCES training_macros(id)"))
            conn.commit()


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

    if "ai_threads" in insp.get_table_names():
        thread_cols = [c["name"] for c in insp.get_columns("ai_threads")]
        with engine.connect() as conn:
            if "thread_type" not in thread_cols:
                conn.execute(text("ALTER TABLE ai_threads ADD COLUMN thread_type VARCHAR DEFAULT 'general'"))
            if "macro_id" not in thread_cols:
                conn.execute(text("ALTER TABLE ai_threads ADD COLUMN macro_id INTEGER REFERENCES training_macros(id)"))
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
    _migrate_season_blocks()
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

app.include_router(auth.router, prefix="/auth", tags=["Auth"])

_auth = [Depends(verify_token)]
app.include_router(swimmers.router, prefix="/swimmers", tags=["Swimmers"], dependencies=_auth)
app.include_router(sessions.router, prefix="/sessions", tags=["Sessions"], dependencies=_auth)
app.include_router(times.router, prefix="/times", tags=["Times"], dependencies=_auth)
app.include_router(meets.router, prefix="/meets", tags=["Meets"], dependencies=_auth)
app.include_router(ai.router, prefix="/ai", tags=["AI"], dependencies=_auth)
app.include_router(periodization.router, prefix="/periodization", tags=["Periodization"], dependencies=_auth)
app.include_router(schedule.router, prefix="/schedule", tags=["Schedule"], dependencies=_auth)
app.include_router(coaching_context.router, prefix="/coaching-context", tags=["Coaching Context"], dependencies=_auth)
app.include_router(ai_chat.router, prefix="/ai-chat", tags=["AI Chat"], dependencies=_auth)
app.include_router(coaching_notes.router, prefix="/coaching-notes", tags=["Coaching Notes"], dependencies=_auth)
app.include_router(benchmarks.router, prefix="/benchmarks", tags=["Benchmarks"], dependencies=_auth)
app.include_router(season.router, prefix="/season", tags=["Season Plan"], dependencies=_auth)
app.include_router(skills.router, prefix="/skills", tags=["Skills"], dependencies=_auth)
app.include_router(dashboard.router, prefix="/dashboard", tags=["Dashboard"], dependencies=_auth)


@app.get("/health")
def health():
    return {"status": "ok"}
