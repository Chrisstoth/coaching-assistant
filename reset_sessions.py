"""
One-time reset: clears session/register test data.
Keeps swimmers, times, meets, targets, profiles, season plan, AI chats.
"""
from sqlalchemy import text
from backend.database import engine

tables = [
    "swimmer_session_load",
    "session_entries",
    "coaching_notes",
    "sessions",
]

with engine.connect() as conn:
    for table in tables:
        result = conn.execute(text(f"DELETE FROM {table}"))
        print(f"  {table}: {result.rowcount} rows deleted")
    conn.commit()

print("\nDone. Sessions and registers cleared — ready to start fresh Monday.")
