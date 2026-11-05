"""Reading old session files: finding them, dates, Word / rich text / Excel, and the checks."""
import io
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path
from unittest import mock

from openpyxl import Workbook

from backend.services import history_import as H
from backend.services import session_notation as N


def docx(paragraphs, table=None) -> bytes:
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    p = lambda t: f'<w:p><w:r><w:t xml:space="preserve">{t}</w:t></w:r></w:p>'  # noqa: E731
    tbl = ""
    if table:
        rows = "".join("<w:tr>" + "".join(f"<w:tc>{p(c)}</w:tc>" for c in row) + "</w:tr>" for row in table)
        tbl = f"<w:tbl>{rows}</w:tbl>"
    xml = f'<?xml version="1.0"?><w:document xmlns:w="{w}"><w:body>{"".join(p(t) for t in paragraphs)}{tbl}</w:body></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xml)
    return buf.getvalue()


def template_xlsx(rows) -> bytes:
    """The coach's session template: rows of (A, B, C, D, E, F, G, H, I, J)."""
    wb = Workbook()
    ws = wb.active
    ws["A1"] = "Monday 5th October AM"
    for r, values in rows.items():
        for col, v in zip("ABCDEFGHIJ", values):
            if v is not None:
                ws[f"{col}{r}"] = v
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class DatesAndFiles(unittest.TestCase):
    def test_dates_from_file_names(self):
        self.assertEqual(H.guess_date("251020 Monday PM", "2025-2026"), date(2025, 10, 20))   # YYMMDD
        self.assertEqual(H.guess_date("041215 Friday AM", "2015-2016"), date(2015, 12, 4))    # DDMMYY (Leeds)
        self.assertEqual(H.guess_date("03 wed am 12th nov", "2015-2016"), date(2015, 11, 12))
        self.assertEqual(H.guess_date("01 Monday 14th September 2015- AM", "2015-2016"), date(2015, 9, 14))
        self.assertEqual(H.guess_date("5th March", "2015-2016"), date(2016, 3, 5), "spring is the second year")
        self.assertIsNone(H.guess_date("Christmas schedule", "2015-2016"))

    def test_finding_session_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "BPSC 2026-2027"
            for rel, data in {
                "Silver 1/1.2.2/261026 Monday AM.pdf": b"%PDF one",
                "Silver 1/1.2.2/261026 Monday AM copy.pdf": b"%PDF one",            # same content
                "Lanzarote/Sessions/261027 Tuesday PM - Group 1.pdf": b"%PDF two",
                "Silver 1/261001 Camp Calendar.xlsx": b"x",
                "Silver 1/notes.docx": b"x",
                "Silver 1/261028 Wednesday AM.mov": b"x",
            }.items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
            files, skipped = H.find_files([root])
            names = {f.path.name: f for f in files}
            self.assertEqual(set(names), {"261026 Monday AM.pdf", "261026 Monday AM copy.pdf", "261027 Tuesday PM - Group 1.pdf"})
            home = names["261026 Monday AM.pdf"]
            self.assertEqual((home.period, home.week_code, home.slot, home.camp, home.squad), ("2026-2027", "1.2.2", "AM", None, "Silver 1"))
            self.assertEqual(names["261027 Tuesday PM - Group 1.pdf"].camp, "Lanzarote")
            self.assertEqual(skipped["not a session"], 2)
            self.assertEqual(H.fingerprint(names["261026 Monday AM.pdf"]), H.fingerprint(names["261026 Monday AM copy.pdf"]))


class Readers(unittest.TestCase):
    def test_word_text_keeps_tables(self):
        text = H.docx_text(docx(["Warm up", "400 free"], table=[["4 x 100", "IM", "1:40"], ["", "", ""]]))
        self.assertEqual(text, "Warm up\n400 free\n4 x 100 | IM | 1:40")

    def test_rich_text(self):
        rtf = rb"{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\*\generator x;}\f0 Warm up 500 free\par 8 x 50 IM\'92s\par}"
        self.assertEqual(H.rtf_text(rtf), "Warm up 500 free\n8 x 50 IM’s")

    def test_the_coaches_template_is_read_by_code(self):
        data = template_xlsx({
            4: ("Week Key:", None, None, "1.1.4"),
            5: ("Aim 1:", None, None, "Endurance"),
            7: ("Warm Up:", None, None, None, None, None, None, "Effort/20", "=SUM(I8:I9)", "=SUM(J8:J9)"),
            8: (1, "x", 200, "as", "Easy Swim", None, 240 / 86400, "12", "=C8", "=G8"),
            9: (4, "x", 50, "as", "Kick", None, 70 / 86400, None, "=A9*C9", "=A9*G9"),
            10: ("Main", None, None, None, "Group 1", None, None, "Effort/20", "=SUM(I11:I11)", "=SUM(J11:J11)"),
            11: (8, "x", 100, "as", "PB + 15", None, 95 / 86400, "16", "=A11*C11", "=A11*G11"),
        })
        out = H.import_template(H.read_cells(data), "251005 Monday AM.xlsx")
        s = out["session"]
        self.assertEqual((s["date"], s["slot"], s["weekKey"], s["aims"][0]), ("2025-10-05", "AM", "1.1.4", "Endurance"))
        self.assertEqual([b["name"] for b in s["blocks"]], ["Warm Up", "Main"])
        self.assertEqual([g["name"] for g in s["groups"]], ["Group 1"])
        self.assertEqual(N.items_to_text(s["blocks"][0]["items"]), ["200 Easy Swim @4:00 [12]", "4x50 Kick @1:10"])
        self.assertEqual([t["dist"] for t in N.totals_for(s)], [1200])

    def test_older_template_rounds(self):
        """2023-24: "2 x  Fins on" whose total multiplies the rows under it is a round, and it ends where its formula ends."""
        data = template_xlsx({
            7: ("Warm Up:", None, None, None, None, None, None, None, "=SUM(I8+I10)", None),
            8: (1, "x", 300, "as", "Easy Swim", 290 / 86400, None, None, "300", None),
            10: (2, "x", None, None, "Fins on", None, None, None, "=SUM(I11:I12)*A10", None),
            11: (4, "x", 75, "as", "Kick", 100 / 86400, None, None, "=A11*C11", None),
            12: (2, "x", 25, "as", "Fly kick", 40 / 86400, None, None, "=A12*C12", None),
            13: (1, "x", 100, "as", "Easy", 100 / 86400, None, None, "=A13*C13", None),
        })
        items = H.import_template(H.read_cells(data), "230921 Thursday AM.xlsx")["session"]["blocks"][0]["items"]
        self.assertEqual(N.items_to_text(items), ["300 Easy Swim @4:50", "2x Fins on", "  4x75 Kick @1:40", "  2x25 Fly kick @0:40", "100 Easy @1:40"])

    def test_the_files_own_total_checks_an_ai_reading(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "BPSC" / "2015-2016" / "Thursday 3rd September 2015 - AM.txt"
            p.parent.mkdir(parents=True)
            p.write_text("Warm up 500 free\n2600 or 2800m")
            info = H.find_files([p.parent])[0][0]
            decoded = {"blocks": [{"name": "Warm up", "groups": [], "text": "500 Free\n3x200 IM (or 2x200)"}], "stated_total": 2600}
            with mock.patch.object(H, "decode_with_ai", return_value=decoded):
                r = H.read_file(info)
            self.assertEqual((r.method, r.totals[0]["dist"], r.total_mismatch), ("ai", 1100, True))
            self.assertEqual(r.status, "doubts")
            self.assertIn("The file says 2600 m in total but I read 1,100 m.", r.notes)
            decoded["stated_total"] = 1100
            with mock.patch.object(H, "decode_with_ai", return_value=decoded):
                r = H.read_file(info)
            self.assertEqual((r.total_mismatch, r.status), (False, "clean"))


if __name__ == "__main__":
    unittest.main()
