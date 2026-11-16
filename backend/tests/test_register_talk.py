"""The spoken register: names the coach teaches it, and the quick model's suggestions."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.tests import reset_database  # noqa: E402


class RegisterTalkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        db = SessionLocal()
        try:
            niamh = models.Swimmer(name="Niamh Doyle", status="active")
            oliver = models.Swimmer(name="Oliver Reid", status="active")
            db.add_all([niamh, oliver])
            db.commit()
            self.niamh, self.oliver = niamh.id, oliver.id
        finally:
            db.close()

    def client(self):
        http = TestClient(app)
        token = http.post("/auth/login", json={"password": "test-password"}).json()["token"]
        return http, {"Authorization": f"Bearer {token}"}

    def test_a_taught_name_is_remembered_and_can_be_corrected(self):
        http, auth = self.client()
        saved = http.post("/ai-chat/register-aliases", json={"heard": " Neve ", "swimmer_id": self.niamh}, headers=auth)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["heard"], "neve")
        # Taught again for someone else: the newer tap wins, no duplicate.
        http.post("/ai-chat/register-aliases", json={"heard": "neve", "swimmer_id": self.oliver}, headers=auth)
        listed = http.get("/ai-chat/register-aliases", headers=auth).json()
        self.assertEqual(listed, [{"heard": "neve", "swimmer_id": self.oliver}])

    def test_a_real_name_or_unknown_swimmer_is_refused(self):
        http, auth = self.client()
        taken = http.post("/ai-chat/register-aliases", json={"heard": "Oliver", "swimmer_id": self.niamh}, headers=auth)
        self.assertEqual(taken.status_code, 409)
        missing = http.post("/ai-chat/register-aliases", json={"heard": "olly", "swimmer_id": 9999}, headers=auth)
        self.assertEqual(missing.status_code, 404)

    def test_tidy_only_returns_swimmers_from_the_squad_it_was_given(self):
        http, auth = self.client()
        reply = SimpleNamespace(
            content=[SimpleNamespace(text='{"matches": [{"heard": "Neve", "swimmer_id": %d}, {"heard": "Olly", "swimmer_id": 4242}, {"heard": "pool", "swimmer_id": null}]}' % self.niamh)],
            usage=SimpleNamespace(input_tokens=10, output_tokens=5),
        )
        fake = SimpleNamespace(messages=SimpleNamespace(create=lambda **_: reply))
        with patch("backend.routers.ai_chat.get_client", return_value=fake):
            result = http.post("/ai-chat/register-tidy", json={
                "words": ["Neve", "Olly", "pool"],
                "transcript": "group one girls Neve, boys Olly",
                "swimmers": [{"id": self.niamh, "name": "Niamh Doyle"}, {"id": self.oliver, "name": "Oliver Reid"}],
            }, headers=auth).json()
        self.assertEqual(result["matches"], [{"heard": "Neve", "swimmer_id": self.niamh}])

    def test_tidy_with_nothing_to_place_asks_nobody(self):
        http, auth = self.client()
        with patch("backend.routers.ai_chat.get_client", side_effect=AssertionError("no call")):
            result = http.post("/ai-chat/register-tidy", json={"words": [], "swimmers": []}, headers=auth).json()
        self.assertEqual(result, {"matches": []})


if __name__ == "__main__":
    unittest.main()
