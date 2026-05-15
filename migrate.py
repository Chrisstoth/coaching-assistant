"""
Migrate local SQLite data to Neon PostgreSQL.
Usage: set DATABASE_URL=<neon-url> && python migrate.py
"""
import os, sqlite3
from sqlalchemy import create_engine, text

SQLITE_PATH = "coaching.db"
PG_URL = os.environ.get("DATABASE_URL", "")

if not PG_URL or "sqlite" in PG_URL:
    print("ERROR: Set DATABASE_URL to your Neon PostgreSQL connection string first.")
    print('  Windows: $env:DATABASE_URL="postgresql+psycopg://..."')
    raise SystemExit(1)

if PG_URL.startswith("postgresql://") or PG_URL.startswith("postgres://"):
    PG_URL = PG_URL.replace("postgres://", "postgresql+psycopg://", 1).replace("postgresql://", "postgresql+psycopg://", 1)

# Tables in FK-safe order
BOOL_COLS = {
    "swimmers": ["active"],
    "pool_slots": ["active", "has_blocks", "alternate_ends"],
    "periodization_plans": ["ai_generated", "coach_approved"],
    "swimmer_load_events": ["resolved"],
    "session_entries": ["attended"],
    "coaching_profiles": ["is_current"],
    "coaching_notes": ["active"],
}

TABLES = [
    "swimmers", "meets", "pool_slots", "training_blocks", "training_macros", "season_blocks",
    "swim_times", "meet_targets", "swimmer_slots", "swimmer_exceptions",
    "schedules", "swimmer_load_events", "swimmer_profile_versions",
    "training_history_narratives", "profile_conversations",
    "sessions", "session_groups", "session_sub_groups", "session_entries",
    "swimmer_session_loads",
    "swimmer_observations", "periodization_plans", "ai_analyses",
    "coaching_profiles", "coaching_conversations",
    "ai_threads", "coach_ai_messages", "coaching_notes",
    "benchmark_logs", "swimmer_targets",
    "skill_outputs",
]

sqlite_conn = sqlite3.connect(SQLITE_PATH)
sqlite_conn.row_factory = sqlite3.Row
pg_engine = create_engine(PG_URL)

for table in TABLES:
    cur = sqlite_conn.execute(f"SELECT * FROM {table}")
    rows = cur.fetchall()
    if not rows:
        print(f"  {table}: empty, skipped")
        continue
    cols = [d[0] for d in cur.description]
    placeholders = ", ".join([f":{c}" for c in cols])
    col_list = ", ".join(cols)
    sql = text(f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING")
    bool_cols = BOOL_COLS.get(table, [])
    def fix_row(row):
        d = dict(row)
        for col in bool_cols:
            if col in d and d[col] is not None:
                d[col] = bool(d[col])
        return d

    with pg_engine.begin() as conn:
        conn.execute(sql, [fix_row(row) for row in rows])
    print(f"  {table}: {len(rows)} rows copied")

# Reset all sequences so new inserts get correct IDs
with pg_engine.begin() as conn:
    for table in TABLES:
        try:
            conn.execute(text(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                f"COALESCE((SELECT MAX(id) FROM {table}), 0) + 1, false)"
            ))
        except Exception:
            pass

sqlite_conn.close()
print("\nDone! All data migrated.")
