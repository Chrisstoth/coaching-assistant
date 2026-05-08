from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./coaching.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


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
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"))
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
