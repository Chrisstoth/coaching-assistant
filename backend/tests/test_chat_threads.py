"""The chat's list of conversations: newest first, each named by what it's about."""
import os
import unittest
from datetime import datetime, timedelta, timezone

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.routers.ai_chat import thread_name_from  # noqa: E402
from backend.tests import reset_database  # noqa: E402


class ChatThreadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def test_a_conversation_is_named_by_its_first_message(self):
        self.assertEqual(thread_name_from("Cancel Thursday morning"), "Cancel Thursday morning")
        self.assertEqual(thread_name_from("  plan   tonight's\nsession "), "plan tonight's session")
        long = thread_name_from("Next week has to be lighter, half of them have mocks and the rest are tired")
        self.assertTrue(long.endswith("…"))
        self.assertLessEqual(len(long), 49)
        self.assertFalse(long[:-1].endswith(" "))
        self.assertEqual(thread_name_from("[Photo attached] Here's the gala timetable"), "Here's the gala timetable")
        self.assertEqual(thread_name_from("[Photo: session whiteboard]"), "Photo")

    def test_threads_come_newest_first_with_their_type(self):
        now = datetime.now(timezone.utc)
        with SessionLocal() as db:
            old = models.AIThread(name="Old chat", thread_type="general", created_at=now - timedelta(days=3))
            recent = models.AIThread(name="Recent chat", thread_type="general", created_at=now - timedelta(days=5))
            season = models.AIThread(name="Season Plan", thread_type="season_plan", created_at=now - timedelta(days=1))
            db.add_all([old, recent, season])
            db.flush()
            db.add(models.CoachAIMessage(role="user", message="hi", thread_id=old.id,
                                         created_at=now - timedelta(days=3)))
            # Started earliest, but talked in most recently.
            db.add(models.CoachAIMessage(role="user", message="hello", thread_id=recent.id,
                                         created_at=now - timedelta(minutes=5)))
            db.add(models.CoachAIMessage(role="assistant", message="hi coach", thread_id=recent.id,
                                         created_at=now - timedelta(minutes=4)))
            db.commit()

        http, h = self.client()
        with http:
            rows = http.get("/ai-chat/threads", headers=h).json()

        self.assertEqual([row["name"] for row in rows], ["Recent chat", "Season Plan", "Old chat"])
        self.assertEqual(rows[0]["thread_type"], "general")
        self.assertEqual(rows[0]["message_count"], 2)
        self.assertEqual(rows[1]["thread_type"], "season_plan")
        self.assertEqual(rows[1]["message_count"], 0)
        self.assertIn("last_message_at", rows[0])

    def test_clearing_a_conversation_lets_it_be_named_again(self):
        with SessionLocal() as db:
            thread = models.AIThread(name="Plan tonight", thread_type="general")
            db.add(thread)
            db.commit()
            thread_id = thread.id

        http, h = self.client()
        with http:
            cleared = http.delete(f"/ai-chat/messages?thread_id={thread_id}", headers=h)
        self.assertEqual(cleared.status_code, 200, cleared.text)
        with SessionLocal() as db:
            self.assertIsNone(db.get(models.AIThread, thread_id).name)


if __name__ == "__main__":
    unittest.main()
