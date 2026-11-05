"""Maggie's import queue and the style review."""
import io
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import Workbook  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import history_import as H, import_queue as Q, session_builder, style_review as SR  # noqa: E402
from backend.services import session_notation as N, workbooks as W  # noqa: E402
from backend.tests import reset_database  # noqa: E402


def template(path: Path):
    wb = Workbook()
    ws = wb.active
    ws["A1"] = "Monday 5th October AM"
    ws["A7"], ws["H7"] = "Main:", "Effort/20"
    ws["A8"], ws["B8"], ws["C8"], ws["D8"], ws["E8"], ws["G8"], ws["H8"] = 8, "x", 100, "as", "Free", 90 / 86400, "14"
    wb.save(path)


class ImportQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / "BPSC 2025-2026"
        (root / "Silver 1" / "1.1.4").mkdir(parents=True)
        (root / "Lanzarote").mkdir(parents=True)
        template(root / "Silver 1" / "1.1.4" / "251005 Monday AM.xlsx")
        (root / "Silver 1" / "251006 Tuesday PM.txt").write_text("Warm up 400\n6 x 100 BK on 1:50")
        (root / "Lanzarote" / "251007 Wednesday AM.txt").write_text("Camp: 3000 aerobic")
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def decode(self, terms):
        def fake(text, info, glossary="", formats="", model=None):
            if "BK" in text:
                return {"blocks": [{"name": "Main", "groups": [], "text": "400 Warm up\n6x100 BK @1:50"}], "unknown_terms": terms}
            return {"blocks": [{"name": "Main", "groups": [], "text": "3000 Aerobic"}]}
        return fake

    def test_the_queue_imports_clean_files_and_holds_doubtful_ones(self):
        with SessionLocal() as db, mock.patch.object(H, "decode_with_ai", self.decode(["BK"])):
            self.assertEqual(Q.scan(db, [self.root])["added"], 3)
            self.assertEqual(Q.scan(db, [self.root])["added"], 0, "a file is queued once")
            done = Q.run_batch(db)
            self.assertEqual(done, {"read": 3, "imported": 2, "pending": 1})
            camp = db.query(models.Session).filter(models.Session.date == date(2025, 10, 7)).one()
            self.assertEqual((camp.audience, camp.source), ({"kind": "camp", "label": "Lanzarote"}, "history"))
            sheet = db.query(models.Session).filter(models.Session.date == date(2025, 10, 5)).one()
            self.assertEqual(N.totals_for(sheet.builder)[0]["dist"], 800)
            self.assertEqual(sheet.groups[0].volume_breakdown, {"aerobic": 800}, "zone metres for the load counter")

            self.assertEqual(Q.questions(db), [{"term": "BK", "files": 1, "example": "251006 Tuesday PM.txt"}])
            self.assertEqual(Q.answer(db, "BK", "backstroke")["to_read_again"], 1)
            self.assertIn("**BK**: backstroke", W.read_page(db, "records", "glossary.md"))
        with SessionLocal() as db, mock.patch.object(H, "decode_with_ai", self.decode([])):
            self.assertEqual(Q.run_batch(db), {"read": 1, "imported": 1})

    def test_a_session_already_in_the_app_is_not_imported_twice(self):
        with SessionLocal() as db, mock.patch.object(H, "decode_with_ai", self.decode([])):
            s = models.Session(date=date(2025, 10, 5), squad="Silver 1", status="completed")
            db.add(s)
            db.flush()
            session_builder.apply_builder(db, s, {"date": "2025-10-05", "slot": "AM", "blocks": []})
            Q.scan(db, [self.root])
            Q.run_batch(db)
            item = db.query(models.ImportItem).filter(models.ImportItem.file_date == date(2025, 10, 5)).one()
            self.assertEqual((item.status, item.session_id), ("duplicate", s.id))

    def test_the_coach_works_the_queue_over_the_api(self):
        http = TestClient(app)
        with http, mock.patch.object(H, "decode_with_ai", self.decode(["BK"])):
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            self.assertEqual(http.post("/history-import/scan", headers=h).status_code, 422, "folders first")
            http.put("/history-import/roots", headers=h, json={"roots": [str(self.root)]})
            self.assertEqual(http.post("/history-import/scan", headers=h).json()["added"], 3)
            with SessionLocal() as db:
                Q.run_batch(db)
            pending = http.get("/history-import/items", headers=h).json()
            self.assertEqual(len(pending), 1)
            self.assertIn("6x100 BK @1:50", pending[0]["preview"])
            self.assertEqual(http.get("/history-import/questions", headers=h).json()[0]["term"], "BK")
            done = http.post(f"/history-import/items/{pending[0]['id']}", headers=h, json={"action": "import"}).json()
            self.assertEqual(done["status"], "imported")
            self.assertEqual(http.get("/history-import", headers=h).json()["periods"], {"2025-2026": {"imported": 3}})


class StyleReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            for d, text in ((date(2015, 10, 5), "1000 Pull paddles"), (date(2015, 10, 6), "800 Pull"),
                            (date(2025, 10, 5), "8x50 Fins fast @1:00 [19]"), (date(2025, 10, 6), "16x25 Fins @0:40 [20]")):
                s = models.Session(date=d, squad="Silver 1", status="completed")
                db.add(s)
                db.flush()
                session_builder.apply_builder(db, s, {"date": d.isoformat(), "slot": "AM",
                                                      "blocks": [{"id": "b", "name": "Main", "groups": [], "items": N.parse_text(text)}]})

    def test_how_the_sessions_changed(self):
        with SessionLocal() as db:
            stats = SR.period_stats(db, min_sessions=1)
            then, now = stats["2015-2016 Silver 1"], stats["2025-2026 Silver 1"]
            self.assertEqual((then["long_sets_per_session"], now["long_sets_per_session"]), (1.0, 0.0))
            self.assertEqual(then["equipment_per_session"]["pull"], 1.0)
            self.assertEqual(now["equipment_per_session"]["fins"], 1.0)

    def test_the_coaches_answers_fill_jess_style_pages(self):
        with SessionLocal() as db:
            SR.answer(db, "Long pull sets were in most sessions in 2015-16; none now.", "moved_on", "Too much shoulder load")
            SR.answer(db, "Fast fins work in most sessions since 2024.", "still_do")
            self.assertIn("Long pull sets", W.read_section(W.get_page(db, "sessions", "style/moved-on-from.md").content, "Moved on from"))
            self.assertIn("coach: Too much shoulder load", W.read_page(db, "sessions", "style/moved-on-from.md"))
            self.assertIn("Fast fins work", W.read_section(W.get_page(db, "sessions", "style/current-style.md").content, "Still do"))
            with self.assertRaises(W.WorkbookError):
                SR.answer(db, "x", "maybe")


if __name__ == "__main__":
    unittest.main()
