/* Session notation: how a session is written, read and added up.

   Taken unchanged from the BPSC Session Builder artifact (the parser, the
   totals, the text format, the intensity scales and dictation), so the app
   reads a set exactly the way the builder did. The backend has a Python twin
   in backend/services/session_notation.py. Both are checked against the same
   reference answers in shared/notation/cases.json; if one of them changes,
   regenerate the cases with `node scripts/build-notation-cases.mjs` and make
   the other match.

   Model: a session has blocks; a block has items; an item is a line
   ({t:'line', reps, dist, desc, int, int2, rest, est, eff}) or a round
   ({t:'round', times, note, items}). Times are seconds. Intensity (eff) is
   stored on one common scale (Effort /20, 6–21) whatever scale it is shown in.
*/
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fmtTime(sec){
  if (sec == null || isNaN(sec)) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function parseTime(str){
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  let m = s.match(/^(\d+):(\d{1,2})$/); if (m) return (+m[1]) * 60 + (+m[2]);
  m = s.match(/^(\d+)\.(\d{2})$/); if (m) return (+m[1]) * 60 + (+m[2]);
  m = s.match(/^(\d+)$/); if (m) { const n = +m[1]; return n < 10 ? n * 60 : n; }
  return null;
}
const fmtDist = m => Math.round(m).toLocaleString('en-GB');
function clockMins(hhmm){ const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function clockAdd(hhmm, sec){
  const base = clockMins(hhmm); if (base == null) return '';
  const t = Math.floor(base + sec / 60);
  const h = Math.floor(t / 60) % 24, mm = t % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
function slotSeconds(s){ const a = clockMins(s.start), b = clockMins(s.end); return (a == null || b == null || b <= a) ? null : (b - a) * 60; }

function parseEffort(str){
  if (!str) return null;
  const s = String(str);
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  const kind = /->|→|>/.test(s) ? 'build' : (nums.length > 1 ? 'mix' : 'single');
  return { lo: nums[0], hi: nums[nums.length - 1], mean: nums.reduce((a, b) => a + b, 0) / nums.length, kind };
}

/* Intensity scales. Every effort value is stored on one common scale (Chris's Effort /20, 6–21) and shown in the session's chosen system.
   Zone boundaries line the systems up by heart rate where they publish it (Sweetenham bbm, BPSC 10-second counts) and by purpose otherwise;
   Effort /20 is calibrated to how Chris has used it alongside his HR colours (HR 22–24 ≈ 12–13, HR 24–25 ≈ 14, HR 27 ≈ 16, fast 25s 19, HVO 21). */
const Z = (label, lo, hi, c, extra = {}) => ({ label, lo, hi, c, ...extra });
const EFF_SYSTEMS = {
  effort20: { name: 'Effort /20', short: 'Effort/20', hint: '/20', numeric: true },
  rpe: { name: 'RPE 0–10 (Borg CR10)', short: 'RPE', hint: '1–10', zones: [
    Z('1', 0, 7.5, 7, { note: 'very easy' }), Z('2', 7.5, 9.5, 8.5, { note: 'easy' }), Z('3', 9.5, 11.5, 10.5, { note: 'moderate' }), Z('4', 11.5, 13.5, 12.5, { note: 'somewhat hard' }),
    Z('5', 13.5, 15, 14.25, { note: 'hard' }), Z('6', 15, 16.5, 15.75), Z('7', 16.5, 17.5, 17, { note: 'very hard' }), Z('8', 17.5, 18.5, 18), Z('9', 18.5, 19.75, 19.1), Z('10', 19.75, 99, 20.5, { note: 'maximal' }) ] },
  bpsc: { name: 'BPSC HR colours', short: 'HR colour', hint: 'Red…', colored: true, zones: [
    Z('White', 0, 12.5, 10, { color: '#F1F2F4', note: '≤24' }), Z('Yellow', 12.5, 14.5, 13.5, { color: '#F4D03F', note: '25' }), Z('Pink', 14.5, 16.5, 15.5, { color: '#F29AC2', note: '26–28' }),
    Z('Red', 16.5, 17.5, 17, { color: '#D62839', note: '29–30' }), Z('Purple', 17.5, 18.5, 18, { color: '#7D3C98', note: '31–33' }), Z('Blue', 18.5, 20.5, 19.5, { color: '#1F6FD1', note: 'max effort / race pace' }),
    Z('Gold', 20.5, 99, 21, { color: '#C9A227', note: 'speed & power' }) ] },
  urbanchek: { name: 'Urbanchek colours', short: 'Urbanchek', hint: 'Pink…', colored: true, zones: [
    Z('White', 0, 11.5, 9, { color: '#F1F2F4', note: 'easy aerobic' }), Z('Pink', 11.5, 15.5, 13.5, { color: '#F29AC2', note: 'aerobic' }), Z('Red', 15.5, 17.25, 16.5, { color: '#D62839', note: 'threshold' }),
    Z('Blue', 17.25, 17.75, 17.5, { color: '#1F6FD1', note: 'just above threshold' }), Z('Purple', 17.75, 18.75, 18, { color: '#7D3C98', note: 'VO2 max / race pace' }), Z('Green', 18.75, 99, 19.5, { color: '#2E9D57', note: 'lactate production / sprint' }) ] },
  sweetenham: { name: 'Sweetenham (British Swimming)', short: 'Sweetenham', hint: 'A3…', zones: [
    Z('A1', 0, 12.5, 10, { note: 'aerobic, ≤60 bbm' }), Z('A2', 12.5, 14.5, 13.5, { note: 'aerobic, 50–60 bbm' }), Z('A3', 14.5, 16.5, 15.5, { note: 'aerobic development, 30–50 bbm' }),
    Z('AT', 16.5, 17.5, 17, { note: 'anaerobic threshold, 20–30 bbm' }), Z('MVO2', 17.5, 18.5, 18, { alias: ['vo2'], note: 'VO2 max, 10–20 bbm' }), Z('LT', 18.5, 19.25, 19, { note: 'lactate tolerance' }),
    Z('LP', 19.25, 20.5, 20, { note: 'lactate production' }), Z('Speed', 20.5, 99, 21, { alias: ['sp', 'hvo', 'sprint'], note: 'HVO / alactic sprint' }) ] },
  maglischo: { name: 'Maglischo energy systems', short: 'Maglischo', hint: 'EN2…', zones: [
    Z('REC', 0, 9.5, 8, { note: 'recovery' }), Z('EN1', 9.5, 15.5, 12.5, { note: 'basic endurance' }), Z('EN2', 15.5, 17.5, 16.5, { note: 'threshold endurance' }), Z('EN3', 17.5, 18.5, 18, { note: 'overload endurance' }),
    Z('SP1', 18.5, 19.25, 19, { note: 'lactate tolerance' }), Z('SP2', 19.25, 20.5, 20, { note: 'lactate production' }), Z('SP3', 20.5, 99, 21, { note: 'power' }) ] }
};
const EFF_ORDER = ['effort20', 'rpe', 'bpsc', 'urbanchek', 'sweetenham', 'maglischo'];
/* The app: every club gets the standard scales; anything else is the club's own (BPSC's HR colours are BPSC's).
   A club's scales sit beside these without changing them; one that keeps a standard key shows instead of it. */
const STANDARD_SCALES = ['effort20', 'rpe', 'urbanchek', 'sweetenham', 'maglischo'];
const CUSTOM_SCALES = {};
const sysDef = k => CUSTOM_SCALES[k] || EFF_SYSTEMS[k];
function useScales(custom){ for (const k of Object.keys(CUSTOM_SCALES)) delete CUSTOM_SCALES[k]; for (const s of custom || []) if (s && s.key) CUSTOM_SCALES[s.key] = s; }
const showsNumbers = sys => sys === 'effort20' || !(sysDef(sys) || {}).zones;
let EFF_SYS = 'effort20';
const setEffSys = k => { EFF_SYS = sysDef(k) ? k : 'effort20'; };
const effSys = () => sysDef(EFF_SYS) || EFF_SYSTEMS.effort20;
function zoneFor(v, sys){ const zs = (sysDef(sys) || {}).zones; if (!zs) return null; return zs.find(z => v >= z.lo && v < z.hi) || (v < zs[0].lo ? zs[0] : zs[zs.length - 1]); }
// stored (common scale) → what the chosen system shows
function effFromCanon(text, sys = EFF_SYS){
  if (!text) return text || '';
  if (showsNumbers(sys)) return String(text).replace(/\d+\.\d+/g, m => String(Math.round(+m)));
  return String(text).replace(/\d+(?:\.\d+)?/g, m => zoneFor(+m, sys).label);
}
// what was typed (any system's labels, or numbers in the chosen system) → stored common scale
function canonOf(tok, sys){
  if (/^\d/.test(tok)) { if (sys === 'rpe') { const z = EFF_SYSTEMS.rpe.zones.find(q => q.label === String(Math.min(10, Math.max(1, Math.round(+tok))))); return z ? z.c : null; } return +tok; }
  const t = tok.toLowerCase();
  for (const k of [sys, 'bpsc', 'sweetenham', 'maglischo', 'urbanchek', ...Object.keys(CUSTOM_SCALES)]) { const S = sysDef(k); if (!S || !S.zones || k === 'rpe') continue; const z = S.zones.find(q => q.label.toLowerCase() === t || (q.alias || []).includes(t)); if (z) return z.c; }
  return null;
}
function effToCanon(text, sys = EFF_SYS){
  if (!text) return '';
  return String(text).replace(/[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?/g, tok => { const v = canonOf(tok, sys); return v == null ? tok : String(v); });
}
function effAvgText(a){ if (a == null) return ''; if (showsNumbers(EFF_SYS)) return `${a.toFixed(1)}/20`; return zoneFor(a, EFF_SYS).label; }
const hexRgb = h => { const x = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)); };
const lumOf = rgb => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

/* model */
// talk (seconds) is only there on a talk line, so ordinary sets keep their shape
const newLine = (p = {}) => { const n = { id: uid(), t: 'line', reps: p.reps ?? null, dist: p.dist ?? null, desc: p.desc ?? '', int: p.int ?? null, int2: p.int2 ?? null, rest: p.rest ?? null, est: p.est ?? null, eff: p.eff ?? '' }; if (p.talk != null) n.talk = p.talk; return n; };
const newRound = (times = 2, items = [], note = '') => ({ id: uid(), t: 'round', times, note, items });
// groups: [] = every group swims it, otherwise the ids of the groups that do. A string is the old single-group label (normalised on load).
const newBlock = (name = 'Block', groups = [], items) => { const b = { id: uid(), name, groups: Array.isArray(groups) ? groups.slice() : [], items: items || [] }; if (typeof groups === 'string' && groups.trim()) b.group = groups.trim(); return b; };
const GROUP_COLORS = ['#E8641C', '#0F8B8D', '#4B5BD7', '#B83280', '#7A8B1E', '#5E6B7A', '#A0522D', '#2B6CB0'];
// bring older sessions (one free-text group per block) into the named-groups model
function normalizeSession(s){
  if (!s) return s;
  if (!Array.isArray(s.groups)) {
    s.groups = [];
    (s.blocks || []).forEach(b => { const g = (b.group || '').trim(); if (g && !s.groups.some(x => x.name.toLowerCase() === g.toLowerCase())) s.groups.push({ id: 'g' + uid(), name: g }); });
  }
  const ids = new Set(s.groups.map(g => g.id));
  (s.blocks || []).forEach(b => {
    if (typeof b.group === 'string') { const g = b.group.trim(), m = g && s.groups.find(x => x.name.toLowerCase() === g.toLowerCase()); b.groups = m ? [m.id] : (Array.isArray(b.groups) ? b.groups : []); delete b.group; }
    if (!Array.isArray(b.groups)) b.groups = [];
    b.groups = b.groups.filter(id => ids.has(id));
  });
  return s;
}
const sessionGroups = s => (s.groups && s.groups.length ? s.groups : [{ id: null, name: '' }]);
const groupName = (s, id) => ((s.groups || []).find(g => g.id === id) || {}).name || '';
const groupColor = (s, id) => GROUP_COLORS[Math.max(0, (s.groups || []).findIndex(g => g.id === id)) % GROUP_COLORS.length];
const blockGroupNames = (s, b) => (b.groups && b.groups.length ? b.groups.map(id => groupName(s, id)).filter(Boolean) : []);
// one group's session: the blocks it swims (shared ones included)
function sessionForGroup(s, gid){
  if (gid == null || !(s.groups || []).some(g => g.id === gid)) return s;
  return { ...s, blocks: s.blocks.filter(b => appliesTo(b, gid)), groups: s.groups.filter(g => g.id === gid), _group: groupName(s, gid) };
}

/* Turnaround: a send-off (@1:30, with an optional second lane @1:30/1:40), or a rest interval (r20) with an estimated swim time per rep (~1:20) */
const T_SO = '(\\d{1,2}[:.]\\d{2}|\\d{2,3})', T_SO2 = '(?:\\s*\\/\\s*(\\d{1,2}[:.]\\d{2}|\\d{2,3}))?';
const T_R = '(\\d{1,2}[:.]\\d{2}|:\\d{2}|\\d{1,3})', T_RU = '(?:\\s*(s|secs?|seconds|mins?|minutes)\\b)?', T_END = '(?=[\\s,;)\\]]|$)';
function parseRest(v, unit){ const x = String(v).trim(); if (/^:\d{2}$/.test(x)) return +x.slice(1); if (/^\d{1,3}$/.test(x)) return unit && /^m/i.test(unit) ? +x * 60 : +x; return parseTime(x); }
const restShort = sec => (sec < 60 ? String(sec) : fmtTime(sec));
const restLabel = sec => (sec < 60 ? `${sec}s rest` : `${fmtTime(sec)} rest`);
function extractTiming(str){
  let s = ' ' + String(str || '') + ' ', m;
  const out = { int: null, int2: null, rest: null, est: null };
  const cut = () => { s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); };
  if ((m = s.match(new RegExp('(?:^|\\s)@\\s*(\\d+(?:[:.]\\d{1,2})?)' + T_SO2 + T_END)))
    || (m = s.match(new RegExp('\\(\\s*' + T_SO + T_SO2 + '\\s*\\)')))
    || (m = s.match(new RegExp('(?:^|\\s)(?:on|off)\\s+' + T_SO + T_SO2 + T_END, 'i')))) { out.int = parseTime(m[1]); if (m[2]) out.int2 = parseTime(m[2]); cut(); }
  else if ((m = s.match(new RegExp('(?:^|\\s)@?r\\s*' + T_R + T_RU + T_END, 'i')))
    || (m = s.match(new RegExp('(?:^|\\s)(?:w\\/)\\s*' + T_R + T_RU + T_END, 'i')))) { out.rest = parseRest(m[1], m[2]); cut(); }
  else if ((m = s.match(new RegExp('(?:^|\\s)rest\\s+' + T_R + T_RU + T_END, 'i')))) { out.rest = parseRest(m[1], m[2]); cut(); out.restWord = true; }
  else if ((m = s.match(new RegExp('(?:^|\\s)(\\d{1,2}[:.]\\d{2}|:\\d{2}|\\d{1,3}(?=\\s*(?:s|secs?|seconds|mins?|minutes)\\b))' + T_RU + '\\s+rest\\b', 'i')))) { out.rest = parseRest(m[1], m[2]); cut(); }
  if ((m = s.match(new RegExp('(?:^|\\s)(?:~|≈|est\\.?\\s+)\\s*' + T_SO + T_END, 'i')))) { out.est = parseTime(m[1]); cut(); }
  out.s = s.replace(/\s{2,}/g, ' ').trim();
  return out;
}
const hasTiming = t => !!t && (t.int != null || t.rest != null || t.est != null);
const timingMode = t => (t.int != null ? 'send' : (t.rest != null || t.est != null ? 'rest' : 'none'));
const lineTiming = n => ({ int: n.int ?? null, int2: n.int2 ?? null, rest: n.rest ?? null, est: n.est ?? null });
// seconds per rep for each lane; a rest set needs an estimated swim time (a rest-only line, like "Rest 2 mins", is just the rest)
function perRep(t, hasDist){
  if (t.int != null) return { per: t.int, per2: t.int2 != null ? t.int2 : t.int };
  if (t.est != null) { const v = t.est + (t.rest || 0); return { per: v, per2: v }; }
  if (t.rest != null && !hasDist) return { per: t.rest, per2: t.rest };
  if (t.int2 != null) return { per: 0, per2: t.int2 };
  return { per: 0, per2: 0 };
}
// a numbered line's own turnaround; anything it leaves out comes from line 1 (and line 1 from the set)
function mergeTiming(base, own){
  if (!hasTiming(own)) return base;
  if (own.int != null) return { int: own.int, int2: own.int2 ?? null, rest: null, est: null };
  if (own.rest != null) return { int: null, int2: null, rest: own.rest, est: own.est ?? base.est ?? null };
  return base.int != null ? base : { int: null, int2: null, rest: base.rest ?? null, est: own.est };
}
function partTimings(n, edit){
  const dp = descParts(n.desc, edit ? 1 : 2, !!edit); if (!dp) return null;
  const base = lineTiming(n);
  const parts = dp.parts.map(p => { const tm = extractTiming(p.text), own = hasTiming(tm); return { n: p.n, raw: p.text, text: own ? tm.s : p.text, own: own ? tm : null }; });
  const first = mergeTiming(base, parts[0] && parts[0].own);
  parts.forEach((p, i) => { p.eff = i === 0 ? first : mergeTiming(first, p.own); });
  return { ...dp, parts, first };
}
// the timing in its short typed form, as it shows in a cell ("1:30", "1:30/1:40", "r20", "r20 ~1:20", "~6:00")
function cellText(t){
  if (!t) return '';
  if (t.int != null) return fmtTime(t.int) + (t.int2 != null && t.int2 !== t.int ? '/' + fmtTime(t.int2) : '');
  return [t.rest != null ? 'r' + restShort(t.rest) : '', t.est != null ? '~' + fmtTime(t.est) : ''].filter(Boolean).join(' ');
}
const timingToken = t => (t && t.int != null ? '@' : '') + cellText(t);
function parseTimingCell(v){
  const x = String(v || '').trim().replace(/^@\s*/, '');
  if (!x) return { int: null, rest: null };
  const one = parseTime(x); if (one != null) return { int: one, rest: null };
  const two = x.match(/^([\d:.]+)\s*\/\s*([\d:.]+)$/);
  if (two && parseTime(two[1]) != null && parseTime(two[2]) != null) return { int: parseTime(two[1]), int2: parseTime(two[2]), rest: null };
  const tm = extractTiming(x); if (tm.s) return null;
  if (tm.int != null) return { int: tm.int, int2: tm.int2, rest: null };
  const o = { int: null, rest: tm.rest }; if (tm.est != null) o.est = tm.est; return o;
}
function hoistFirstTiming(line){
  if (hasTiming(line)) return;
  const pe = descParts(line.desc, 1, true); if (!pe) return;
  const tm = extractTiming(pe.parts[0].text); if (!hasTiming(tm)) return;
  ['int', 'int2', 'rest', 'est'].forEach(k => { line[k] = tm[k] ?? null; });
  const texts = pe.parts.map(q => q.text); texts[0] = tm.s;
  line.desc = buildDesc(pe.rawPrefix, texts);
}
function nodeStats(n){
  if (n.t === 'round') return statsOf(n.items, n.times);
  if (isTalkLine(n)) { const t = +n.talk || 0; return { dist: 0, time: t, time2: t, et: 0, kt: 0 }; }
  const reps = n.reps || 1, dist = n.dist || 0, hd = !!dist;
  let time = 0, time2 = 0;
  const pt = partTimings(n);
  if (pt && pt.parts.some(q => q.own)) {
    // each numbered line covers reps ÷ lines reps when that divides evenly, otherwise one rep each; reps with no line follow line 1
    const k = pt.parts.length, each = reps % k === 0 ? reps / k : 1, covered = Math.min(k, Math.floor(reps / each));
    for (let i = 0; i < covered; i++) { const r = perRep(pt.parts[i].eff, hd); time += each * r.per; time2 += each * r.per2; }
    const left = reps - each * covered; if (left > 0) { const r = perRep(pt.first, hd); time += left * r.per; time2 += left * r.per2; }
  } else { const r = perRep(lineTiming(n), hd); time = reps * r.per; time2 = reps * r.per2; }
  const e = parseEffort(n.eff);
  return { dist: reps * dist, time, time2, et: e && time ? time * e.mean : 0, kt: e && time ? time : 0 };
}
function statsOf(items, times){
  const k = times == null ? 1 : (times || 0);
  const acc = { dist: 0, time: 0, time2: 0, et: 0, kt: 0 };
  (items || []).forEach(n => { const s = nodeStats(n); acc.dist += s.dist; acc.time += s.time; acc.time2 += s.time2; acc.et += s.et; acc.kt += s.kt; });
  return { dist: acc.dist * k, time: acc.time * k, time2: acc.time2 * k, et: acc.et * k, kt: acc.kt * k };
}
const avgEff = st => st.kt ? st.et / st.kt : null;

function appliesTo(b, gid){ return gid == null || !b.groups || !b.groups.length || b.groups.includes(gid); }
function expandSeq(items, out){
  for (const n of items || []) {
    if (out.length > 3000) return;
    if (n.t === 'round') { for (let i = 0; i < (n.times || 0); i++) expandSeq(n.items, out); }
    else { const st = nodeStats(n); if (st.time > 0) out.push({ time: st.time, eff: parseEffort(n.eff), label: lineText(n) }); }
  }
}
function totalsFor(s){
  return sessionGroups(s).map(({ id: gid, name: g }) => {
    const acc = { dist: 0, time: 0, time2: 0, et: 0, kt: 0 }; const seq = [];
    s.blocks.forEach(b => { if (appliesTo(b, gid)) { const st = statsOf(b.items); acc.dist += st.dist; acc.time += st.time; acc.time2 += st.time2; acc.et += st.et; acc.kt += st.kt; expandSeq(b.items, seq); } });
    return { g, gid, ...acc, seq };
  });
}
function blockStarts(s){
  const res = new Map();
  sessionGroups(s).forEach(({ id: g }) => {
    let t = 0;
    s.blocks.forEach(b => { if (appliesTo(b, g)) { if (!res.has(b.id)) res.set(b.id, []); const arr = res.get(b.id); if (!arr.includes(t)) arr.push(t); t += statsOf(b.items).time; } });
  });
  return res;
}

/* text format */
const DIST_END = '(?!\\d|[:.]\\d|s\\b|secs?\\b|\\s*min|\\))';
const RX_ROUND = new RegExp('^(\\d+)\\s*(?:x|×|rounds?\\b)(?!\\s*\\d+' + DIST_END + ')\\s*(.*)$', 'i');
const RX_REPS = new RegExp('^(\\d+)\\s*[x×]\\s*(\\d+)' + DIST_END + '\\s*(?:m\\b)?\\s*(.*)$', 'i');
const RX_DIST = new RegExp('^(\\d+)' + DIST_END + '\\s*(?:m\\b)?\\s*(.*)$', 'i');
const RX_PREFIX = /^(\d+)\s*(?:[x×]|rounds?\b)\s*(?:of\b\s*)?/i;
const SET_START = /^(?:\d+\s*[x×]\s*\d|\d+\s*(?:[x×]|rounds?\b)\s*(?:of\b\s*)?\(|\d{2,4}(?:\s*m\b)?(?=[\s,;)]|$))/i;
const PURE_TIME = /^\s*(\d{1,2}[:.]\d{2}|\d{2,3})\s*$/;
function matchParen(s, open){
  let d = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return i; }
  return -1;
}
// Split "4 x 50, 2 x 100" into sets. "N x M" after a comma always starts a set; a bare distance ("25 Free") only does
// inside a round's brackets, or when the part before the comma has its own send-off — so "50 No Free, 25 Free" stays one description.
const RX_STRONG = /^\d+\s*[x×]\s*\d|^\d+\s*(?:[x×]|rounds?\b)\s*(?:of\b\s*)?\(/i;
const RX_SENDOFF = /(?:^|\s)@\s*\d|\(\s*(?:\d{1,2}[:.]\d{2}|\d{2,3})\s*\)|(?:^|\s)(?:on|off)\s+(?:\d{1,2}[:.]\d{2}|\d{2,3})(?=[\s,;)]|$)/i;
function splitSets(s, loose){
  const parts = []; let d = 0, sq = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') d++; else if (c === ')') d = Math.max(0, d - 1);
    else if (c === '[') sq++; else if (c === ']') sq = Math.max(0, sq - 1);
    else if ((c === ',' || c === ';') && !d && !sq) {
      const next = s.slice(i + 1).trim();
      if (SET_START.test(next) && !/^\d+\s*(?:m\s*)?each\b/i.test(next) && (loose || RX_STRONG.test(next) || RX_SENDOFF.test(s.slice(start, i)))) { parts.push(s.slice(start, i)); start = i + 1; }
    }
  }
  parts.push(s.slice(start));
  return parts.map(x => x.trim()).filter(Boolean);
}
// One typed line → one or more sets. A leading "N x" or "N rounds of" applies to everything after it on the line.
function parseLineNodes(text, loose){
  const s = String(text).trim(); if (!s) return [];
  const m = s.match(RX_PREFIX);
  if (m) {
    const n = +m[1] || 1, rest = s.slice(m[0].length);
    if (rest[0] === '(') {
      const close = matchParen(rest, 0);
      const inner = close < 0 ? rest.slice(1) : rest.slice(1, close);
      if (!PURE_TIME.test(inner)) {
        const round = newRound(n, parseLineNodes(inner, true));
        const after = close < 0 ? '' : rest.slice(close + 1).trim();
        if (/^[,;]/.test(after)) return [round, ...parseLineNodes(after.slice(1), loose)];
        if (after) {
          const t = after.match(/^(?:\(\s*(\d{1,2}[:.]\d{2}|\d{2,3})\s*\)|(?:@|on\s+|off\s+)\s*(\d{1,2}[:.]\d{2}|\d{2,3}))$/i);
          const only = round.items.length === 1 && round.items[0].t === 'line' && round.items[0].int == null ? round.items[0] : null;
          if (t && only) only.int = parseTime(t[1] || t[2]);
          else round.note = after.replace(/^[-–:]\s*/, '');
        }
        return [round];
      }
    }
    if (/^\d+\s*[x×]\s*\d/.test(rest) || (/round/i.test(m[0]) && SET_START.test(rest))) return [newRound(n, parseLineNodes(rest, true))];
  }
  const parts = splitSets(s, loose);
  return (parts.length === 1 ? [parseSetLine(parts[0])] : parts.flatMap(p => parseLineNodes(p, loose))).filter(Boolean);
}
/* Talk: time the coach spends explaining the next set (its purpose, the details, a word with one swimmer) before anyone pushes off.
   "Talk 3 min purpose and turns" → a talk line { talk: 180, desc: 'purpose and turns' }. It counts toward the session time; no metres, no intensity.
   The time comes first: m:ss, a number with a unit (90s, 2 min, 3m, 1.5 mins), or a bare minute count ("Talk 2"). "Explain" needs m:ss,
   seconds or "min", so "Explain 50 fly" and "Explain 25m underwater" stay notes. Anything over half an hour isn't a talk. */
const TALK_T = '(\\d{1,2}[:.]\\d{2}|\\d{1,3}(?:\\.\\d)?\\s*(?:s|secs?|seconds?|m|mins?|minutes?)\\b|\\d{1,2}(?![\\d:.]|\\s*[x×]))';
const RX_TALK = new RegExp('^(?:(?:coach|team)\\s+)?(talk|brief(?:ing)?|chat|explain)\\b\\s*(?:for\\s+)?(?:[:\\-–]\\s*)?' + TALK_T + '(?!\\d)(.*)$', 'i');
const TALK_MAX = 1800;
const isTalkLine = n => !!n && n.t === 'line' && n.talk != null;
function talkSecs(v){
  const x = String(v == null ? '' : v).trim();
  if (/^\d{1,2}[:.]\d{2}$/.test(x)) return parseTime(x);
  const m = x.match(/^(\d{1,3}(?:\.\d)?)\s*([a-z]*)$/i); if (!m) return null;
  const n = +m[1], u = m[2].toLowerCase();
  if (!u) return n < 10 ? n * 60 : n;
  return Math.round(/^m/.test(u) ? n * 60 : n);
}
// the time typed into a talk row's cell: "2", "2:00", "90s", "2 min"
function parseTalkTime(v){
  const x = String(v == null ? '' : v).trim(); if (!x) return null;
  if (!new RegExp('^' + TALK_T + '$', 'i').test(x)) return null;
  const t = talkSecs(x); return t != null && t > 0 && t <= TALK_MAX ? t : null;
}
function parseTalk(text){
  const m = String(text).trim().match(RX_TALK); if (!m) return null;
  if (/^explain/i.test(m[1]) && /^\d+(?:\.\d)?(?:\s*m)?$/i.test(m[2])) return null;
  const t = talkSecs(m[2]); if (!t || t > TALK_MAX) return null;
  return newLine({ desc: m[3].replace(/^[\s,;:\-–]+/, '').replace(/\s{2,}/g, ' ').trim(), talk: t });
}
function parseSetLine(text){
  let s = String(text).trim();
  if (!s) return null;
  const talk = parseTalk(s); if (talk) return talk;
  let m = s.match(RX_ROUND);
  if (m) {
    const rest = m[2].replace(/^[:\-–]\s*|^of\s+/i, '').trim();
    if (rest && SET_START.test(rest)) return newRound(+m[1] || 1, parseLineNodes(rest, true));
    return newRound(+m[1] || 1, [], rest);
  }
  const p = { reps: null, dist: null, desc: '', int: null, int2: null, rest: null, est: null, eff: '' };
  const em = s.match(/\[([^\]]*)\]/);
  if (em) { p.eff = effToCanon(em[1].trim()); s = (s.slice(0, em.index) + ' ' + s.slice(em.index + em[0].length)).trim(); }
  else { const e2 = s.match(/\s(?:e|eff|effort)\s*(\d[\d.\s>\-\/→]*)$/i); if (e2) { p.eff = effToCanon(e2[1].trim()); s = s.slice(0, e2.index).trim(); } }
  // "4 x 50 alt max dive start (1:10) and max finish (1:50)": alternating reps, each option on its own turnaround
  if (!descParts(s, 1, true)) {
    const q = s.match(RX_REPS) || s.match(RX_DIST), after = q ? q[q.length - 1] : s;
    const am = after.match(/^(alt(?:ernate|ernating)?\.?)\s+(.+)$/i);
    if (am) {
      const opts = am[2].split(/\s+(?:and|&|then)\s+|\s*;\s*|\s+\/\s+|,\s+(?=\S)/i).map(x => x.trim()).filter(Boolean);
      if (opts.length >= 2 && opts.filter(x => hasTiming(extractTiming(x))).length >= 2) s = s.slice(0, s.length - after.length) + am[1] + ' ' + opts.map((x, i) => `${i + 1}) ${x}`).join(' ');
    }
  }
  // timing typed before the numbered lines is the set's; timing after "2) …" belongs to that line
  const pm = descParts(s, 1, true), tail = pm ? s.slice(pm.at).trim() : '';
  const tm = extractTiming(pm ? s.slice(0, pm.at) : s); s = tm.s;
  ['int', 'int2', 'rest', 'est'].forEach(k => { if (tm[k] != null) p[k] = tm[k]; });
  if ((m = s.match(RX_REPS))) { p.reps = +m[1]; p.dist = +m[2]; s = m[3]; }
  else if ((m = s.match(RX_DIST))) { p.dist = +m[1]; s = m[2]; }
  p.desc = s.replace(/^[\s,;:\-–]+/, '').replace(/^as\s+/i, '').replace(/[\s,;]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!p.desc && tm.restWord && !tail && p.dist == null) p.desc = 'Rest';
  if (tail) p.desc = (p.desc ? p.desc + ' ' : '') + tail;
  if (p.reps === 1) p.reps = null;
  const line = newLine(p); hoistFirstTiming(line);
  return line;
}
function parseText(text){
  const root = [];
  const lines = String(text).replace(/\t/g, '  ').split(/\r?\n/);
  let stack = null, last = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (PART_LINE.test(raw) && last && last.t === 'line' && !isTalkLine(last)) { addPart(last, raw); continue; }
    const ind = raw.match(/^ */)[0].length;
    if (!stack) stack = [{ ind, items: root }];
    while (stack.length > 1 && ind < stack[stack.length - 1].ind) { stack.pop(); const top = stack[stack.length - 1]; last = top.items[top.items.length - 1] || null; }
    const top = stack[stack.length - 1];
    let target = top;
    if (ind > top.ind && last && last.t === 'round' && top.items.includes(last)) { stack.push({ ind, items: last.items }); target = stack[stack.length - 1]; }
    const nodes = parseLineNodes(raw);
    if (!nodes.length) continue;
    target.items.push(...nodes);
    last = nodes[nodes.length - 1];
  }
  return root;
}
// "1) Kick 2) Drill 3) Swim 4) Build" → what each rep does. Markers start at 1 and never go backwards.
const PART_LINE = /^\s*\d{1,2}\)\s*\S/;
function descParts(desc, min = 2, keepEmpty = false){
  // markers count up from 1 (a repeat of the same number is allowed); any other "N)" is text, e.g. "(HR 24)"
  const str = String(desc || ''), re = /(^|[\s,;\/]+)(\d{1,2})\)/g, marks = []; let m;
  while ((m = re.exec(str))) {
    const n = +m[2], last = marks[marks.length - 1];
    if (last ? (n !== last.n && n !== last.n + 1) : n !== 1) continue;
    let end = re.lastIndex; while (str[end] === ' ') end++;
    marks.push({ n, sepAt: m.index, end });
  }
  if (marks.length < Math.max(1, min)) return null;
  const rawPrefix = str.slice(0, marks[0].sepAt).trim();
  const prefix = rawPrefix.replace(/[\s,;\/:\-–]+$/, '').trim();
  let parts = marks.map((k, i) => ({ n: k.n, text: str.slice(k.end, i + 1 < marks.length ? marks[i + 1].sepAt : str.length).replace(/[\s,;\/]+$/, '').trim() }));
  if (!keepEmpty) { parts = parts.filter(p => p.text); if (parts.length < min) return null; }
  return { prefix, rawPrefix, parts, at: marks[0].sepAt };
}
const buildDesc = (prefix, texts) => [String(prefix || '').trim(), ...texts.map((t, i) => `${i + 1}) ${String(t || '').trim()}`.trim())].filter(Boolean).join(' ');
// the description as it should print: unfinished empty "N)" lines dropped
function plainDesc(desc){
  const d = String(desc || ''), pe = descParts(d, 1, true);
  if (!pe || pe.parts.every(p => p.text)) return d.trim();
  const keep = pe.parts.map(p => p.text).filter(Boolean);
  return keep.length ? buildDesc(pe.rawPrefix, keep) : pe.rawPrefix;
}
// a line with words only (no reps, distance, send-off or intensity) is a note, e.g. "Fins on" or "Explain the main set"
const isNoteLine = n => n.t === 'line' && n.talk == null && (n.dist == null || n.dist === '') && !(n.reps > 1) && n.int == null && n.int2 == null && n.rest == null && n.est == null && !n.eff && !!plainDesc(n.desc) && !descParts(n.desc);
const isBlankLine = n => n.t === 'line' && n.talk == null && (n.dist == null || n.dist === '') && !(n.reps > 1) && n.int == null && n.int2 == null && n.rest == null && n.est == null && !n.eff && !plainDesc(n.desc);
const newNotes = (groups = []) => ({ id: uid(), kind: 'notes', name: 'Additional notes', groups: groups.slice(), text: '', items: [] });
const hasNoteText = b => !!String(b.text || '').trim();
function addPart(line, text){
  let t = text.trim(), eff = '';
  // "2) swim" said or typed after "2x100 kick": the set's own text becomes line 1; numbers always continue in order
  const pe0 = descParts(line.desc, 1, true), have = pe0 ? pe0.parts.length : 0, nm = t.match(/^(\d{1,2})\)\s*/);
  if (nm) {
    let next = have + 1;
    if (!have && +nm[1] >= 2 && String(line.desc || '').trim()) { line.desc = '1) ' + String(line.desc).trim(); next = 2; }
    t = `${next}) ` + t.slice(nm[0].length);
  }
  const em = t.match(/\[([^\]]*)\]/); if (em) { eff = effToCanon(em[1].trim()); t = (t.slice(0, em.index) + ' ' + t.slice(em.index + em[0].length)).replace(/\s{2,}/g, ' ').trim(); }
  line.desc = (line.desc ? line.desc + ' ' : '') + t;
  if (eff && !line.eff) line.eff = eff;
  hoistFirstTiming(line);
}
function sendoffText(n){
  const a = n.int != null ? n.int : n.int2, b = n.int != null && n.int2 != null && n.int2 !== n.int ? n.int2 : null;
  return a == null ? '' : fmtTime(a) + (b != null ? '/' + fmtTime(b) : '');
}
const timeText = st => fmtTime(st.time) + (st.time2 !== st.time ? ' / ' + fmtTime(st.time2) : '');
function lineText(n){
  if (isTalkLine(n)) return ['Talk ' + fmtTime(n.talk), plainDesc(n.desc)].filter(Boolean).join(' ');
  const parts = [];
  if (n.dist != null && n.dist !== '') parts.push((n.reps && n.reps > 1 ? n.reps + 'x' : '') + n.dist);
  const d = plainDesc(n.desc), pe = descParts(d, 1, true);
  if (pe) { if (pe.rawPrefix) parts.push(pe.rawPrefix); } else if (d) parts.push(d);
  const tt = timingToken(lineTiming(n)) || (n.int2 != null ? '@' + fmtTime(n.int2) : ''); if (tt) parts.push(tt);
  if (n.eff) parts.push('[' + effFromCanon(n.eff) + ']');
  if (pe) parts.push(d.slice(pe.at).trim());
  return parts.join(' ');
}
function itemsToText(items, depth = 0){
  const pad = '  '.repeat(depth); const out = [];
  (items || []).forEach(n => {
    if (n.t === 'round') { out.push(pad + (n.times || 1) + 'x' + (n.note ? ' ' + n.note : '')); out.push(...itemsToText(n.items, depth + 1)); }
    else if (!isBlankLine(n)) out.push(pad + lineText(n));
  });
  return out;
}
function displayTitle(s){
  if (s.title && s.title.trim()) return s.title.trim();
  if (s.date) { const d = new Date(s.date + 'T12:00:00'); if (!isNaN(d)) return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`; }
  return 'Untitled session';
}
function groupLabel(g){ return g || 'Everyone'; }
function sessionText(s){
  const out = [];
  out.push(displayTitle(s) + (s.slot ? ' · ' + s.slot : '') + (s.start && s.end ? ' · ' + s.start + '–' + s.end : ''));
  const line2 = [s.venue, s.weekKey ? 'Week ' + s.weekKey : ''].filter(Boolean).join(' · ');
  if (line2) out.push(line2);
  const aims = (s.aims || []).filter(a => a && a.trim());
  if (aims.length) out.push('Aims: ' + aims.join('; '));
  s.blocks.forEach(b => {
    const st = statsOf(b.items), gn = blockGroupNames(s, b);
    if (b.kind === 'notes') { if (!hasNoteText(b)) return; out.push('', (b.name || 'Notes').toUpperCase() + (gn.length ? ' (' + gn.join(', ') + ')' : ''), ...String(b.text).trim().split('\n')); return; }
    out.push('');
    out.push((b.name || 'Block').toUpperCase() + (gn.length ? ' (' + gn.join(', ') + ')' : '') + ' · ' + fmtDist(st.dist) + ' m · ' + timeText(st));
    out.push(...itemsToText(b.items));
  });
  out.push('');
  out.push('Totals: ' + totalsFor(s).map(t => groupLabel(t.g) + ' ' + fmtDist(t.dist) + ' m · ' + timeText(t)).join(' | '));
  return out.join('\n');
}
function cloneWithNewIds(n){
  const c = JSON.parse(JSON.stringify(n));
  (function re(x){ x.id = uid(); (x.items || []).forEach(re); })(c);
  return c;
}

const EFF_STOPS = [[0, 95, 30, 60], [0.45, 44, 82, 55], [0.7, 22, 88, 52], [0.9, 4, 76, 47], [1.08, -20, 66, 40]];
function effHSL(e){
  const t = clamp((e - 6) / 14, 0, 1.08);
  let i = 0; while (i < EFF_STOPS.length - 2 && t > EFF_STOPS[i + 1][0]) i++;
  const a = EFF_STOPS[i], b = EFF_STOPS[i + 1];
  const f = clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
  const h = ((a[1] + (b[1] - a[1]) * f) % 360 + 360) % 360;
  return [h, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

function partsNote(n, k){
  const reps = n.reps || 1; if (k < 2 || reps === k) return '';
  const alt = /^alt/i.test((descParts(n.desc, 1, true) || {}).rawPrefix || '');
  return reps % k === 0 ? (alt ? `alternating, ${reps / k} of each` : `each part ×${reps / k}`) : `${k} parts for ${reps} reps`;
}

/* Dictation: turn how sets are said ("four by fifty on one ten, twenty seconds rest") into the shorthand the parser reads.
   speech = true for the mic button: number words become digits and "on 110" means 1:10. Keyboard dictation and typing get the safe rules only. */
const capFirst = x => x.charAt(0).toUpperCase() + x.slice(1);
const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordsToDigits(text){
  const w = text.replace(/([a-z])-([a-z])/gi, '$1 $2').split(/\s+/).filter(Boolean), out = [];
  const v = x => (x == null ? undefined : NUMW[x.toLowerCase()]);
  for (let i = 0; i < w.length;) {
    if (/^a$/i.test(w[i]) && /^hundred$/i.test(w[i + 1] || '')) w[i] = 'one';
    let cur = v(w[i]);
    if (cur == null) { out.push(w[i]); i++; continue; }
    i++;
    if (cur > 0 && cur < 10 && /^hundred$/i.test(w[i] || '')) {
      cur *= 100; i++;
      if (/^and$/i.test(w[i] || '') && v(w[i + 1]) != null) i++;
      const t = v(w[i]); if (t != null && t > 0 && t < 100) { cur += t; i++; if (t >= 20 && v(w[i]) > 0 && v(w[i]) < 10) { cur += v(w[i]); i++; } }
    } else if (cur >= 20 && v(w[i]) > 0 && v(w[i]) < 10) { cur += v(w[i]); i++; }
    out.push(String(cur));
    if (/^oh$/i.test(w[i] || '') && v(w[i + 1]) > 0 && v(w[i + 1]) < 10) { out.push('0' + v(w[i + 1])); i += 2; }
  }
  return out.join(' ');
}
// keyboard dictation writes what you said: "4 by 50 …", "four by fifty …", "two hundred easy …"
const NUMWORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
function looksSpoken(t){
  const x = String(t || '').trim();
  return /\b\d+\s+(?:by|times|lots of)\s+\d/i.test(x)
    || new RegExp('^(?:a|' + NUMWORD + ')(?:[\\s-]+' + NUMWORD + '|\\s+hundred)*\\s+(?:by|times|x|lots of)\\b', 'i').test(x)
    || new RegExp('^(?:a|' + NUMWORD + ')(?:[\\s-]+' + NUMWORD + ')*\\s+hundred\\b', 'i').test(x)
    || new RegExp('^' + NUMWORD + '[\\s-]+(?:fifties|hundreds|twenty[\\s-]?fives|seventy[\\s-]?fives)\\b', 'i').test(x)
    || /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i.test(x);
}
const DKW = '(on|off|at|rest|recovery|about|around|roughly|approximately|approx|estimate|est|hold|holding)';
function normalizeDictation(raw, speech){
  let t = String(raw || '').trim();
  if (speech) {
    t = t.replace(/([^\d])[.,;!?]+(?=\s|$)/g, '$1').replace(/\b(twenty|seventy)[\s-]?fives\b/gi, (m, a) => (/^t/i.test(a) ? '25s' : '75s'))
      .replace(/\bone[\s-]fifties\b/gi, '150s').replace(/\bfifties\b/gi, '50s').replace(/\btwo hundreds\b/gi, '200s').replace(/\bhundreds\b/gi, '100s');
    t = t.replace(/^(for|fore)\s+(by|times|lots of|x)\b/i, '4 $2').replace(/^(to|too)\s+(by|times|lots of|x)\b/i, '2 $2').replace(/^(won)\s+(by|times|x)\b/i, '1 $2')
      .replace(/^(line|number|part)\s+(to|too)\b/i, '$1 2').replace(/^(line|number|part)\s+(for|fore)\b/i, '$1 4').replace(/^(line|number|part)\s+won\b/i, '$1 1');
    t = wordsToDigits(t);
    t = t.replace(/\bplus\b/gi, '+').replace(/\bheart rate\b/gi, 'HR').replace(/\b(HR)\s+(\d{2})\s+(?:to|through)\s+(\d{2})\b/gi, '$1 $2-$3')
      .replace(/\b(build|builds|descend|descending)\s+(\d)\s+(?:to|through)\s+(\d)\b/gi, (m, w, a, c) => `${capFirst(w)} ${a}-${c}`);
    t = t.replace(/^(\d+)\s+(25|50|75|100|150|200|250|300|400|500|800)s\b(?!\s+(?:rest|recovery|break))/i, '$1x$2');
  }
  // reps × distance: "4 by 50", "4 times 50", "4 lots of 50", "4 by 1 50" (= 150)
  t = t.replace(/\b(\d+)\s*(?:x|×|by|times|lots of)\s*(\d)\s+(\d{2})\b(?!\s*(?:seconds?|secs?|minutes?)\b)/gi, (m, a, b, c) => `${a}x${b}${c}`)
    .replace(/\b(\d+)\s*(?:×|by|times|lots of)\s*(\d+)\b/gi, '$1x$2').replace(/\b(\d+)\s+x\s+(\d+)\b/gi, '$1x$2')
    .replace(/\b(\d+)\s+times\s+(?:through|round|around)\b/gi, '$1x');
  // send-off words: "every 1:10", "on the 1:10", "leaving on 1:10"
  t = t.replace(/\b(?:leaving|leave|going|go)\s+(on|every)\b/gi, '$1').replace(/\bevery\s+(?=(?:the\s+)?(?:\d{1,2}:\d{2}|\d{1,3}\b|a minute))/gi, 'on ')
    .replace(new RegExp('\\b' + DKW + '\\s+the\\s+(?=\\d|a minute)', 'gi'), '$1 ');
  // times after a keyword: "1 minute 10", "a minute and a half", "1 10", and (speech) "110"
  t = t.replace(/\ba minute and a half\b/gi, '1:30').replace(/\b(\d{1,2}) and a half minutes\b/gi, '$1:30').replace(/\b(\d{1,2}) minutes? and a half\b/gi, '$1:30').replace(/\ba minute\b/gi, '1 minute');
  t = t.replace(new RegExp('\\b' + DKW + '\\s+(\\d{1,2})\\s+minutes?(?:\\s+(?:and\\s+)?(\\d{1,2})(?:\\s+seconds?)?)?\\b', 'gi'), (m, k, a, b) => `${k} ${a}:${b != null ? String(b).padStart(2, '0') : '00'}`);
  t = t.replace(new RegExp('\\b' + DKW + '\\s+(\\d)\\s+(\\d{2})\\b(?!\\s*(?:seconds?|secs?)\\b)', 'gi'), (m, k, a, b) => (+b < 60 ? `${k} ${a}:${b}` : m));
  if (speech) t = t.replace(new RegExp('\\b' + DKW + '\\s+(\\d)(\\d{2})\\b(?!\\s*(?:seconds?|secs?)\\b)', 'gi'), (m, k, a, b) => (+b < 60 ? `${k} ${a}:${b}` : m));
  // estimated swim time: "about 1:20 each", "roughly 45 seconds a rep"
  const EST = '(?:about|around|roughly|approximately|approx\\.?|estimated?|est)';
  t = t.replace(new RegExp('\\b' + EST + '\\s+(\\d{1,2}:\\d{2})(?:\\s+(?:each|per\\s+(?:rep|one|swim|\\d+)|a\\s+(?:rep|swim)))?\\b', 'gi'), '~$1')
    .replace(new RegExp('\\b' + EST + '\\s+(\\d{1,3})\\s+(?:seconds?|secs?)(?:\\s+(?:each|per\\s+(?:rep|one|swim|\\d+)|a\\s+(?:rep|swim)))?\\b', 'gi'), (m, a) => '~' + fmtTime(+a));
  // rest: "with 20 seconds rest", "1 minute rest", "rest 30 seconds", "20 seconds recovery"
  t = t.replace(/\b(?:with\s+)?(\d{1,3})\s*(?:s|secs?|seconds?)\s+(?:of\s+)?(?:rest|recovery|break)\b/gi, '$1s rest')
    .replace(/\b(?:with\s+)?(\d{1,2})\s+minutes?\s+(?:of\s+)?(?:rest|recovery|break)\b/gi, '$1:00 rest')
    .replace(/\b(?:with\s+)?(\d{1,2}:\d{2})\s+(?:of\s+)?(?:rest|recovery|break)\b/gi, '$1 rest')
    .replace(/\b(?:rest|recovery)\s+(?:of\s+|for\s+)?(\d{1,3})\s*(?:s|secs?|seconds?)\b/gi, 'rest $1').replace(/\brecovery\s+(?=\d)/gi, 'rest ');
  t = t.replace(new RegExp('\\b' + DKW + '\\s+(\\d{1,3})\\s+(?:seconds?|secs?)\\b', 'gi'), '$1 $2');
  t = t.replace(/\bat\s+(\d{1,2}:\d{2})\b/gi, 'on $1');
  // intensity: "effort 14", "effort 14 to 18", "effort 14 building to 18", "zone red"
  t = t.replace(/\b(?:effort|intensity|zone)\s+(?:of\s+|at\s+)?([a-z0-9]+)(?:\s+(?:to|through|-)\s+([a-z0-9]+)|\s+(?:building|build|builds)\s+to\s+([a-z0-9]+))?\b/gi, (m, a, b, c) => {
    const ok = x => /^\d{1,2}$/.test(x) || canonOf(x, EFF_SYS) != null; if (!ok(a) || (b && !ok(b)) || (c && !ok(c))) return m;
    return `[${a}${b ? '-' + b : c ? '->' + c : ''}]`;
  });
  // numbered lines: "line 2 build on 4:45" → "2) build on 4:45"
  t = t.replace(/^(?:line|number|no\.?|part|step)\s+(\d{1,2})\b[\s:,.\-]*/i, '$1) ');
  return t.replace(/\s{2,}/g, ' ').replace(/[\s.]+$/, '').trim();
}

export { CUSTOM_SCALES, STANDARD_SCALES, sysDef, useScales, DIST_END, DKW, EFF_ORDER, EFF_STOPS, EFF_SYS, EFF_SYSTEMS, GROUP_COLORS, NUMW, NUMWORD, PART_LINE, PURE_TIME, RX_DIST, RX_PREFIX, RX_REPS, RX_ROUND, RX_SENDOFF, RX_STRONG, SET_START, T_R, T_SO, Z, addPart, appliesTo, avgEff, blockGroupNames, blockStarts, buildDesc, canonOf, capFirst, cellText, clamp, clockAdd, clockMins, cloneWithNewIds, descParts, displayTitle, effAvgText, effFromCanon, effHSL, effSys, effToCanon, esc, expandSeq, extractTiming, fmtDist, fmtTime, groupColor, groupLabel, groupName, hasNoteText, hasTiming, hexRgb, hoistFirstTiming, isBlankLine, isNoteLine, isTalkLine, itemsToText, lineText, lineTiming, looksSpoken, lumOf, matchParen, mergeTiming, newBlock, newLine, newNotes, newRound, nodeStats, normalizeDictation, normalizeSession, parseEffort, parseLineNodes, parseRest, parseSetLine, parseTalk, parseTalkTime, parseText, parseTime, parseTimingCell, partTimings, partsNote, perRep, plainDesc, restLabel, restShort, sendoffText, sessionForGroup, sessionGroups, sessionText, setEffSys, slotSeconds, splitSets, statsOf, timeText, timingMode, timingToken, totalsFor, uid, wordsToDigits, zoneFor }
