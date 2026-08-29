from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./coaching.db")
# psycopg3 requires postgresql+psycopg:// dialect prefix
if DATABASE_URL.startswith("postgresql://") or DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1).replace("postgresql://", "postgresql+psycopg://", 1)

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _portable_column_type(column_type: str, dialect_name: str) -> str:
    """Translate legacy SQLite migration types for the active database."""
    if dialect_name == "postgresql":
        upper = column_type.upper()
        if upper == "DATETIME":
            return "TIMESTAMP WITH TIME ZONE"
        if upper == "BOOLEAN DEFAULT 0":
            return "BOOLEAN DEFAULT FALSE"
    return column_type


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from backend import models  # noqa: F401 — ensures models register with Base
    Base.metadata.create_all(bind=engine)
    _apply_migrations()


def _apply_migrations():
    """
    Add any columns/tables that exist in the models but are missing from the DB.
    Safe to run on every startup — skips anything that already exists.
    """
    from sqlalchemy import text, inspect
    insp = inspect(engine)

    with engine.connect() as conn:
        # Helper: add a column if it doesn't exist
        def add_col(table, column, col_type):
            existing = [c["name"] for c in insp.get_columns(table)]
            if column not in existing:
                portable_type = _portable_column_type(col_type, conn.dialect.name)
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {portable_type}"))
                conn.commit()

        if "swimmers" in insp.get_table_names():
            add_col("swimmers", "course_bias", "VARCHAR")
            add_col("swimmers", "updated_at", "DATETIME")
            add_col("swimmers", "status", "VARCHAR DEFAULT 'active'")

        if "sessions" in insp.get_table_names():
            add_col("sessions", "start_time", "VARCHAR")
            add_col("sessions", "end_time", "VARCHAR")
            add_col("sessions", "status", "VARCHAR DEFAULT 'completed'")
            add_col("sessions", "pool_slot_id", "INTEGER")
            add_col("sessions", "cancel_reason", "TEXT")
            add_col("sessions", "course", "VARCHAR")
            add_col("sessions", "energy_analysis", "JSON")
            add_col("sessions", "microcycle_id", "INTEGER")
            add_col("sessions", "session_sequence", "INTEGER")
            add_col("sessions", "cycle_code", "VARCHAR")

        if "session_groups" in insp.get_table_names():
            add_col("session_groups", "volume_breakdown", "JSON")

        if "pool_slots" in insp.get_table_names():
            add_col("pool_slots", "end_time", "VARCHAR")
            add_col("pool_slots", "course", "VARCHAR")
            add_col("pool_slots", "lanes", "INTEGER")
            add_col("pool_slots", "has_blocks", "BOOLEAN")
            add_col("pool_slots", "pool_config", "VARCHAR")
            add_col("pool_slots", "alternate_ends", "BOOLEAN DEFAULT 0")

        if "meets" in insp.get_table_names():
            add_col("meets", "date_to", "DATE")
            add_col("meets", "course", "VARCHAR")
            add_col("meets", "level", "VARCHAR")
            add_col("meets", "warm_up_time", "VARCHAR")
            add_col("meets", "created_at", "DATETIME")

        if "meet_targets" in insp.get_table_names():
            add_col("meet_targets", "target_times", "JSON")
            add_col("meet_targets", "notes", "TEXT")

        if "swimmer_observations" in insp.get_table_names():
            add_col("swimmer_observations", "energy_zone", "VARCHAR")
            add_col("swimmer_observations", "ai_summary", "TEXT")
            add_col("swimmer_observations", "session_id", "INTEGER")

        if "coaching_conversations" in insp.get_table_names():
            add_col("coaching_conversations", "profile_id", "INTEGER")

        if "ai_threads" in insp.get_table_names():
            add_col("ai_threads", "rolling_summary", "TEXT")
            add_col("ai_threads", "summarized_through_message_id", "INTEGER")
            add_col("ai_threads", "summary_updated_at", "DATETIME")

        if "training_macros" in insp.get_table_names():
            add_col("training_macros", "season_id", "INTEGER")
            add_col("training_macros", "primary_meet_id", "INTEGER")
            add_col("training_macros", "sequence_index", "INTEGER DEFAULT 0")

        if "season_blocks" in insp.get_table_names():
            add_col("season_blocks", "sequence_index", "INTEGER DEFAULT 0")

        if "microcycles" in insp.get_table_names():
            add_col("microcycles", "sequence_index", "INTEGER DEFAULT 0")

        if "planning_pathways" in insp.get_table_names():
            add_col("planning_pathways", "qualification_standard_set_id", "INTEGER")

        if "planning_recommendations" in insp.get_table_names():
            add_col("planning_recommendations", "updated_at", "TIMESTAMP")
            add_col("planning_recommendations", "last_seen_at", "TIMESTAMP")
            add_col("planning_recommendations", "follow_up_at", "TIMESTAMP")
            add_col("planning_recommendations", "accepted_at", "TIMESTAMP")
            add_col("planning_recommendations", "actioned_at", "TIMESTAMP")
            add_col("planning_recommendations", "occurrence_count", "INTEGER DEFAULT 1")
            add_col("planning_recommendations", "coach_note", "TEXT")
            add_col("planning_recommendations", "discussion_thread_id", "INTEGER")
