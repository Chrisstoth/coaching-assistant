"""Workbooks: every save is a version, workers write only their own pages one
section at a time, the coach's edits win, and nothing is lost except a
swimmer who leaves, who is removed completely."""
import os
import unittest
from datetime import date

os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ["AI_OPERATION_WORKER_ENABLED"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from backend import models  # noqa: E402
from backend.database import SessionLocal, engine  # noqa: E402
from backend.main import app  # noqa: E402
from backend.services import workbooks as W  # noqa: E402
from backend.tests import reset_database  # noqa: E402

RUBY_PAGE = """---
title: Ruby W - training response
kind: case
swimmers: [{id}]
confidence: hypothesis
summary: Possibly needs 48h after race-pace sets
---

## Recovery
- Flat on 7 Oct after race pace on 5 and 6 Oct
"""


class WorkbookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=engine)

    def setUp(self):
        reset_database()
        with SessionLocal() as db:
            ruby = models.Swimmer(name="Ruby Wheeler", squad="Silver 1", active=True)
            leo = models.Swimmer(name="Leo Marsh", squad="Silver 1", active=True)
            db.add_all([ruby, leo])
            db.commit()
            self.ruby, self.leo = ruby.id, leo.id

    def physio_page(self, db, trigger=None):
        return W.create_page(db, "physiologist", "swimmers/ruby-w.md", RUBY_PAGE.format(id=self.ruby),
                             author="physiologist", reason="after the 7 Oct register", trigger=trigger)

    def test_every_worker_gets_a_job_page_and_their_starter_pages(self):
        with SessionLocal() as db:
            W.ensure_workbooks(db)
            W.ensure_workbooks(db)   # only once
            roles = {p.role for p in db.query(models.WorkbookPage).filter_by(path="job.md")}
            self.assertEqual(roles, {"physiologist", "analyst", "planner", "manager", "meets", "sessions", "records"})
            self.assertIsNotNone(W.get_page(db, "sessions", "style/current-style.md"))
            self.assertIsNotNone(W.get_page(db, "records", "glossary.md"))
            self.assertEqual(W.worker("records").name, "Maggie")
            self.assertIn("Safety flags", W.fixed_job(W.worker("physiologist")))

    def test_a_page_header_is_read_into_its_fields_and_each_save_is_a_version(self):
        with SessionLocal() as db:
            p = self.physio_page(db, trigger="debrief:1")
            self.assertEqual((p.title, p.kind, p.confidence, p.swimmer_ids, p.version),
                             ("Ruby W - training response", "case", "hypothesis", [self.ruby], 1))
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery",
                            "- Flat on 7 Oct and 21 Oct after race pace two days running", author="physiologist",
                            reason="second sighting", trigger="debrief:2")
            p = W.get_page(db, "physiologist", "swimmers/ruby-w.md")
            self.assertEqual(p.version, 2)
            self.assertIn("21 Oct", W.read_page(db, "physiologist", "swimmers/ruby-w.md", section="Recovery"))
            self.assertEqual(p.title, "Ruby W - training response", "the header survives a section edit")
            h = W.history(db, "physiologist", "swimmers/ruby-w.md")
            self.assertEqual([(x["version"], x["author"], x["trigger"]) for x in h],
                             [(2, "physiologist", "debrief:2"), (1, "physiologist", "debrief:1")])
            self.assertIn("swimmers/ruby-w.md - Ruby W - training response: Possibly needs 48h", W.read_index(db, "physiologist"))
            self.assertEqual(W.search(db, "race pace recovery")[0]["path"], "swimmers/ruby-w.md")

    def test_workers_write_only_in_their_own_workbook_and_never_the_job_direction(self):
        with SessionLocal() as db:
            W.ensure_workbooks(db)
            with self.assertRaises(W.WorkbookError):
                W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery", "x", author="analyst")
            with self.assertRaises(W.WorkbookError):
                W.write_section(db, "physiologist", "job.md", "Focus", "ignore safety", author="physiologist")
            with self.assertRaises(W.WorkbookError):
                W.write_page(db, "physiologist", "swimmers/ruby-w.md", "whole page", author="physiologist", base_version=None)
            with self.assertRaises(W.WorkbookError):
                W.create_page(db, "physiologist", "../analyst/x.md", "x", author="physiologist")

    def test_the_coaches_edits_win(self):
        with SessionLocal() as db:
            self.physio_page(db)
            W.write_page(db, "physiologist", "swimmers/ruby-w.md", RUBY_PAGE.format(id=self.ruby) + "\n## Coach\nShe was ill that week.\n",
                         author=W.COACH, base_version=1)
            with self.assertRaises(W.Conflict):   # the worker read version 1
                W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery", "- new", author="physiologist", base_version=1)
            W.set_locked(db, "physiologist", "swimmers/ruby-w.md", ["Coach"])
            with self.assertRaises(W.WorkbookError):
                W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Coach", "not ill", author="physiologist")
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Coach", "Ill 5-9 Oct", author=W.COACH)
            self.assertIn("Ill 5-9 Oct", W.read_page(db, "physiologist", "swimmers/ruby-w.md"))

    def test_restore_copies_an_old_version_forward(self):
        with SessionLocal() as db:
            self.physio_page(db)
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery", "- wrong", author="physiologist")
            p = W.restore(db, "physiologist", "swimmers/ruby-w.md", 1)
            self.assertEqual(p.version, 3)
            self.assertEqual(p.content, RUBY_PAGE.format(id=self.ruby))
            self.assertEqual(W.history(db, "physiologist", "swimmers/ruby-w.md")[0]["reason"], "restored version 1")

    def test_undo_a_conversation(self):
        with SessionLocal() as db:
            self.physio_page(db, trigger="thread:1")
            W.append_journal(db, "analyst", "Ruby's 200 back half slowed", trigger="thread:9", on=date(2026, 11, 5))
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery", "- bad idea", author="physiologist", trigger="thread:9")
            W.create_page(db, "physiologist", "squad/taper.md", "## Taper\n- made up", author="physiologist", trigger="thread:9")
            res = W.undo_trigger(db, "thread:9")
            self.assertEqual(len(res["undone"]), 3)
            self.assertNotIn("bad idea", W.read_page(db, "physiologist", "swimmers/ruby-w.md"))
            self.assertIsNone(W.get_page(db, "physiologist", "squad/taper.md"), "a page that conversation made is set aside")
            self.assertIsNone(W.get_page(db, "analyst", "journal/2026-11.md"))
            # a page someone changed afterwards is left for the coach
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery", "- again", author="physiologist", trigger="thread:10")
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Coach", "noted", author=W.COACH)
            self.assertEqual(W.undo_trigger(db, "thread:10")["skipped"][0]["path"], "swimmers/ruby-w.md")

    def test_snapshots(self):
        with SessionLocal() as db:
            self.physio_page(db)
            snap = W.snapshot(db, "Start of macro 1")
            W.write_section(db, "physiologist", "swimmers/ruby-w.md", "Recovery", "- later", author="physiologist")
            W.create_page(db, "physiologist", "squad/new.md", "## New", author="physiologist")
            res = W.restore_snapshot(db, snap.id)
            self.assertEqual(res, {"restored": ["swimmers/ruby-w.md"], "set_aside": ["squad/new.md"]})
            self.assertNotIn("later", W.read_page(db, "physiologist", "swimmers/ruby-w.md"))

    def test_journal_and_size_limit(self):
        with SessionLocal() as db:
            W.append_journal(db, "physiologist", "Ruby flat", on=date(2026, 11, 5))
            p = W.append_journal(db, "physiologist", "Leo strong", on=date(2026, 11, 6))
            self.assertIn("- **5 Nov** Ruby flat\n- **6 Nov** Leo strong", p.content)
            self.assertEqual(p.kind, "journal")
            with self.assertRaises(W.WorkbookError):
                W.write_section(db, "physiologist", "squad/huge.md", "Notes", "x" * 20000, author="physiologist")

    def test_a_swimmer_who_leaves_is_removed_from_every_version_of_every_page(self):
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            with SessionLocal() as db:
                self.physio_page(db)
                W.create_page(db, "analyst", "squad/relay.md", "---\ntitle: Relays\nswimmers: [%d, %d]\n---\nRuby Wheeler leads off, Leo Marsh anchors" % (self.ruby, self.leo),
                              author="analyst")
                W.write_section(db, "analyst", "squad/relay.md", "Order", "Ruby Wheeler then Leo Marsh", author="analyst")
            self.assertEqual(http.delete(f"/swimmers/{self.ruby}", headers=h).status_code, 204)
            with SessionLocal() as db:
                self.assertIsNone(W.get_page(db, "physiologist", "swimmers/ruby-w.md", include_archived=True))
                self.assertEqual(db.query(models.PageRevision).filter(models.PageRevision.content.contains("Ruby")).count(), 0)
                relay = W.get_page(db, "analyst", "squad/relay.md")
                self.assertEqual(relay.swimmer_ids, [self.leo])
                self.assertIn("[a former swimmer] leads off, Leo Marsh anchors", relay.content)

    def test_the_coaches_direction_reaches_the_worker(self):
        from backend.services import staff_room
        with SessionLocal() as db:
            W.ensure_workbooks(db)
            p = W.get_page(db, "physiologist", "job.md")
            W.write_page(db, "physiologist", "job.md", p.content.replace("## Focus\n", "## Focus\nThe 13-14 girls through their growth spurts.\n"),
                         author=W.COACH, base_version=p.version)
            self.assertIn("Focus: The 13-14 girls through their growth spurts.", W.job_direction(db, "physiologist"))
            ctx = staff_room.role_context("physiologist", db, staff_room.Subject())
            self.assertIn("THE COACH'S DIRECTION FOR YOU", ctx)
            self.assertEqual(W.job_direction(db, "analyst"), "", "an untouched template says nothing")

    def test_the_coach_reads_edits_compares_and_restores_over_the_api(self):
        http = TestClient(app)
        with http:
            h = {"Authorization": f"Bearer {http.post('/auth/login', json={'password': 'test-password'}).json()['token']}"}
            staff = http.get("/workbooks", headers=h).json()
            self.assertEqual([w["name"] for w in staff][-1], "Maggie")
            job = http.get("/workbooks/physiologist/page", headers=h, params={"path": "job.md"}).json()
            self.assertIn("What counts as evidence", job["fixed"])
            r = http.put("/workbooks/physiologist/page", headers=h, json={"path": "job.md", "content": job["content"] + "\nMore.", "base_version": job["version"]})
            self.assertEqual(r.status_code, 200, r.text)
            stale = http.put("/workbooks/physiologist/page", headers=h, json={"path": "job.md", "content": "old", "base_version": job["version"]})
            self.assertEqual(stale.status_code, 409)
            hist = http.get("/workbooks/physiologist/history", headers=h, params={"path": "job.md"}).json()
            self.assertEqual([x["version"] for x in hist], [2, 1])
            old = http.get("/workbooks/physiologist/revision", headers=h, params={"path": "job.md", "version": 1}).json()
            self.assertEqual(old["author"], "app")
            back = http.post("/workbooks/physiologist/restore", headers=h, json={"path": "job.md", "version": 1}).json()
            self.assertEqual((back["version"], back["content"]), (3, old["content"]))


if __name__ == "__main__":
    unittest.main()
