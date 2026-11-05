"""The Python session notation gives the same answers as the Session Builder.

shared/notation/cases.json holds the builder's own answers (made by
frontend/scripts/build-notation-cases.mjs from the builder's code): how
hundreds of typed lines are read, dictation, intensity scales, and the totals,
text and zones of the coach's 16 saved sessions. This rebuilds every answer
in Python and compares.
"""
import copy
import json
import math
import unittest
from pathlib import Path

from backend.services import session_notation as N

ROOT = Path(__file__).resolve().parents[2] / "shared" / "notation"


def clean(x):
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items() if k != "id"}
    if isinstance(x, list):
        return [clean(v) for v in x]
    return x


def same(a, b, path="$"):
    """Deep equality where 4 == 4.0 and floats may differ in the last bits."""
    if isinstance(a, bool) or isinstance(b, bool):
        assert a == b, f"{path}: {a!r} != {b!r}"
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        assert math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9), f"{path}: {a!r} != {b!r}"
    elif isinstance(a, dict) and isinstance(b, dict):
        assert set(a) == set(b), f"{path}: keys {sorted(a)} != {sorted(b)}"
        for k in a:
            same(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        assert len(a) == len(b), f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            same(x, y, f"{path}[{i}]")
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


class SessionNotationMatchesTheBuilder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads((ROOT / "cases.json").read_text(encoding="utf8"))

    def check(self, name, actual, expected):
        with self.subTest(name):
            same(json.loads(json.dumps(actual)), expected, name)

    def test_scales(self):
        c = self.cases["scales"]
        self.check("systems", N.EFF_SYSTEMS, c["systems"])
        self.check("order", N.EFF_ORDER, c["order"])
        bands = [{"zone": b["zone"], "below": None if math.isinf(b["below"]) else b["below"]} for b in N.DEFAULT_ZONE_BANDS]
        self.check("bands", bands, c["bands"])

    def test_typed_lines(self):
        for c in self.cases["lines"]:
            nodes = N.parse_line_nodes(c["in"])
            self.check(c["in"], {"in": c["in"], "nodes": clean(nodes), "text": N.items_to_text(nodes),
                                 "stats": N.stats_of(nodes), "zones": N.item_zones(nodes)}, c)

    def test_descriptions(self):
        for c in self.cases["descs"]:
            d = c["in"]
            line = N.new_line({"reps": 4, "dist": 100, "desc": d, "int": 100})
            self.check(d, {
                "in": d, "parts": N.desc_parts(d, 1, True), "parts2": N.desc_parts(d), "plain": N.plain_desc(d),
                "timings": clean(N.part_timings(line)), "stats": N.node_stats(line), "note": N.is_note_line(N.new_line({"desc": d})),
                "parsed": clean(N.parse_line_nodes("4x100 " + d)),
            }, c)

    def test_text_blocks(self):
        for c in self.cases["texts"]:
            nodes = N.parse_text(c["in"])
            self.check(c["in"], {"in": c["in"], "nodes": clean(nodes), "text": N.items_to_text(nodes), "stats": N.stats_of(nodes)}, c)

    def test_numbered_lines_added_one_by_one(self):
        for c in self.cases["parts"]:
            first, *rest = c["in"]
            line = N.parse_line_nodes(first)[0]
            for p in rest:
                N.add_part(line, p)
            self.check(first, {"in": c["in"], "line": clean(line), "stats": N.node_stats(line), "text": N.line_text(line)}, c)

    def test_dictation(self):
        for c in self.cases["dictation"]:
            self.check(c["in"], {"in": c["in"], "speech": c["speech"], "out": N.normalize_dictation(c["in"], c["speech"]),
                                 "spoken": N.looks_spoken(c["in"])}, c)

    def test_intensity(self):
        e = self.cases["effort"]
        for c in e["toCanon"]:
            self.check(f"to {c['in']} {c['sys']}", N.eff_to_canon(c["in"], c["sys"]), c["out"])
        for c in e["fromCanon"]:
            self.check(f"from {c['in']} {c['sys']}", N.eff_from_canon(c["in"], c["sys"]), c["out"])
        for c in e["parse"]:
            self.check(f"parse {c['in']}", N.parse_effort(c["in"]), c["out"])

    def test_times(self):
        for c in self.cases["times"]:
            t = c["in"]
            self.check(t, {"in": t, "parse": N.parse_time(t), "cell": N.parse_timing_cell(t),
                           "fmt": N.fmt_time(N.parse_time(t)), "extract": N.extract_timing(t)}, c)

    def test_saved_sessions(self):
        for c in self.cases["sessions"]:
            raw = json.loads((ROOT / "sessions" / f"{c['id']}.json").read_text(encoding="utf8"))
            s = N.normalize_session(copy.deepcopy(raw["session"]))

            def gname(gid):
                return None if gid is None else N.group_name(s, gid)

            starts = N.block_starts(s)
            actual = {
                "id": c["id"],
                "title": N.display_title(s),
                "slot": N.slot_seconds(s),
                "groups": [g["name"] for g in s.get("groups") or []],
                "blocks": [{"name": b.get("name"), "groups": [gname(g) for g in b.get("groups") or []],
                            "stats": N.stats_of(b.get("items")), "starts": starts.get(b.get("id"))} for b in s["blocks"]],
                "totals": [{**t, "gid": gname(t["gid"])} for t in N.totals_for(s)],
                "zones": [{**z, "gid": gname(z["gid"])} for z in N.session_zones(s)],
                "perGroup": [{"group": g["name"], "blocks": [b.get("name") for b in N.session_for_group(s, g["id"])["blocks"]]}
                             for g in s.get("groups") or []],
                "text": {sys: N.session_text(s, sys) for sys in ("effort20", "bpsc", "sweetenham")},
            }
            self.check(c["id"], actual, c)


if __name__ == "__main__":
    unittest.main()
