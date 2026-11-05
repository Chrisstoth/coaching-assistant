/* The poolside PDF: summary first, groups that swim at the same time side by side,
   rounds as lane-rope brackets. From the Session Builder artifact; the header and
   footer text and the logo now come from the club's settings. */
import { DIST_END, DKW, EFF_ORDER, EFF_STOPS, EFF_SYS, EFF_SYSTEMS, GROUP_COLORS, NUMW, NUMWORD, PART_LINE, PURE_TIME, RX_DIST, RX_PREFIX, RX_REPS, RX_ROUND, RX_SENDOFF, RX_STRONG, SET_START, T_R, T_SO, Z, addPart, appliesTo, avgEff, blockGroupNames, blockStarts, buildDesc, canonOf, capFirst, cellText, clamp, clockAdd, clockMins, cloneWithNewIds, descParts, displayTitle, effAvgText, effFromCanon, effHSL, effSys, effToCanon, esc, expandSeq, extractTiming, fmtDist, fmtTime, groupColor, groupLabel, groupName, hasNoteText, hasTiming, hexRgb, hoistFirstTiming, isBlankLine, isNoteLine, itemsToText, lineText, lineTiming, looksSpoken, lumOf, matchParen, mergeTiming, newBlock, newLine, newNotes, newRound, nodeStats, normalizeDictation, normalizeSession, parseEffort, parseLineNodes, parseRest, parseSetLine, parseText, parseTime, parseTimingCell, partTimings, partsNote, perRep, plainDesc, restLabel, restShort, sendoffText, sessionForGroup, sessionGroups, sessionText, setEffSys, slotSeconds, splitSets, statsOf, timeText, timingMode, timingToken, totalsFor, uid, wordsToDigits, zoneFor } from './core.js'
export function blockGroupLabel(s, b){
  const nm = (b.name || '').trim().toLowerCase();
  return blockGroupNames(s, b).map(grp => (nm && grp.toLowerCase().startsWith(nm + ' ') ? grp.slice(nm.length).trim() : (nm.includes(grp.toLowerCase()) ? '' : grp))).filter(Boolean).join(' / ');
}
export function exportFileName(s){
  const d = s.date ? new Date(s.date + 'T12:00:00') : null;
  const base = d && !isNaN(d) ? `${s.date.slice(2, 4)}${s.date.slice(5, 7)}${s.date.slice(8, 10)} ${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${s.slot || ''}`.trim() : displayTitle(s);
  return base.replace(/[\\/:*?"<>|]/g, '-') + '.xlsx';
}
/* PDF: a poolside session sheet. Summary first, groups that swim at the same time side by side, rounds as lane-rope brackets */
function pdfSafe(t){ return String(t == null ? '' : t).replace(/[→⇒]/g, '->').replace(/←/g, '<-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '?'); }
export function hslRgb(h, s, l){ s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [0, 8, 4].map(n => Math.round(255 * f(n))); }
const effRGB = e => { if (effSys().colored) return hexRgb(zoneFor(e, EFF_SYS).color); const [h, s, l] = effHSL(e); return hslRgb(h, s, l); };
export function buildSessionPdf(JsPDF, s, logo, fonts, printedAt, label = {}){
  const HEAD = (label.header || 'SESSION PLAN').toUpperCase(), FOOT = label.footer || 'Session plan'
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  let FAM = 'helvetica', custom = false;
  if (fonts && fonts.regular && fonts.bold && fonts.semibold) {
    try {
      [['R', fonts.regular, 'normal'], ['B', fonts.bold, 'bold'], ['SB', fonts.semibold, 'semibold'], ['I', fonts.italic || fonts.regular, 'italic']]
        .forEach(([k, b64, st]) => { doc.addFileToVFS(`BarlowSC-${k}.ttf`, b64); doc.addFont(`BarlowSC-${k}.ttf`, 'BarlowSC', st); });
      FAM = 'BarlowSC'; custom = true;
    } catch (e) { FAM = 'helvetica'; custom = false; }
  }
  const safe = t => custom ? String(t == null ? '' : t).replace(/[→⇒]/g, '->') : pdfSafe(t);
  const INK = [21, 23, 26], MUTED = [94, 101, 112], FAINT = [146, 152, 161], LINE = [221, 224, 229], ORANGE = [232, 100, 28], WHITE = [255, 255, 255], OKC = [44, 122, 75], BADC = [180, 35, 24], WARNC = [154, 83, 6];
  const font = (style, size, rgb) => { doc.setFont(FAM, custom ? style : (style === 'semibold' ? 'bold' : style)); doc.setFontSize(size); doc.setTextColor(...(rgb || INK)); };
  const T = (t, x, yy, o = {}) => doc.text(safe(t), x, yy, { baseline: 'top', ...o });
  const tw = t => doc.getTextWidth(safe(t));
  const wrap = (t, w) => doc.splitTextToSize(safe(t), Math.max(5, w));
  const LH = pt => pt * 0.3528 * 1.22;
  const PW = 210, PH = 297, M = 12, CW = PW - 2 * M, TOP = 12, BOTTOM = PH - 14, DEP = 5.2;
  const d = s.date ? new Date(s.date + 'T12:00:00') : null, okDate = d && !isNaN(d);
  const headTitle = (s.title && s.title.trim()) ? s.title.trim() : (okDate ? `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}` : 'Session');
  const starts = blockStarts(s);
  let y = TOP;

  /* header */
  if (logo) { try { doc.addImage(logo, /^data:image\/png/i.test(logo) ? 'PNG' : 'JPEG', M, y, 18, 18); } catch (e) {} }
  const tx = M + 22;
  let weekW = 0, tagW = 0;
  if (s._group) {
    font('bold', 13); tagW = tw(s._group.toUpperCase()) + 8;
    doc.setFillColor(...ORANGE); doc.roundedRect(PW - M - tagW, y, tagW, 9, 1.4, 1.4, 'F');
    font('semibold', 6.5, WHITE); T('GROUP', PW - M - tagW + 4, y + 0.9, { charSpace: 0.3 });
    font('bold', 13, WHITE); T(s._group.toUpperCase(), PW - M - tagW + 4, y + 3.3);
    tagW += 5;
  }
  if (s.weekKey) { font('bold', 18); weekW = Math.max(tw(s.weekKey), 12); font('semibold', 7.5, MUTED); T('WEEK', PW - M - tagW, y + 0.4, { align: 'right', charSpace: 0.35 }); font('bold', 18, INK); T(s.weekKey, PW - M - tagW, y + 4.4, { align: 'right' }); }
  weekW += tagW;
  font('semibold', 8, ORANGE); T(HEAD, tx, y + 0.4, { charSpace: 0.35 });
  let ts = 23; font('bold', ts); while (tw(headTitle.toUpperCase()) > PW - M - tx - weekW - 6 && ts > 14) { ts -= 1; font('bold', ts); }
  font('bold', ts, INK); T(headTitle.toUpperCase(), tx, y + 4.2);
  const sub = [[s.slot, s.start && s.end ? `${s.start}–${s.end}` : ''].filter(Boolean).join(' '), s.venue, s.coach].filter(x => x && String(x).trim());
  font('normal', 9.5, MUTED); T(sub.join('  ·  '), tx, y + 13.6);
  y += 21;
  const aims = (s.aims || []).map((a, i) => ({ a: (a || '').trim(), i })).filter(x => x.a);
  if (aims.length) {
    font('semibold', 7.5); const labW = tw('AIM 2') + 2.6;
    const one = aims.map(x => { font('normal', 9.5); return labW + tw(x.a); }).reduce((a, b) => a + b + 8, -8) <= CW;
    let ax = M;
    aims.forEach((x, k) => {
      font('normal', 9.5); const ls = one ? [x.a] : wrap(x.a, CW - labW);
      if (!one && k) { ax = M; }
      font('semibold', 7.5, ORANGE); T(`AIM ${x.i + 1}`, ax, y + 0.9, { charSpace: 0.3 });
      font('normal', 9.5, INK); ls.forEach((l, j) => T(l, ax + labW, y + j * LH(9.5)));
      if (one) { ax += labW + tw(x.a) + 8; } else y += ls.length * LH(9.5) + 0.8;
    });
    if (one) y += LH(9.5) + 0.8;
  }
  doc.setFillColor(...ORANGE); doc.rect(M, y + 0.6, CW, 1.1, 'F'); y += 5;

  /* block rows */
  const qtyText = n => { const hd = n.dist != null && n.dist !== ''; return hd ? (n.reps > 1 ? `${n.reps}×${n.dist}` : `${n.dist}`) : (n.reps > 1 ? `${n.reps}×` : ''); };
  const ropes = (x, yy, h, depth) => {
    for (let i = 0; i < depth; i++) {
      const rxp = x + i * DEP + 1.4, seg = 2.2;
      for (let k = Math.floor(yy / seg); k * seg < yy + h; k++) { const a = Math.max(yy, k * seg), e = Math.min(yy + h, (k + 1) * seg); if (e > a) { doc.setFillColor(...(k % 2 ? INK : ORANGE)); doc.rect(rxp, a, 1.2, e - a, 'F'); } }
    }
  };
  // send-off "@1:30" (second lane in grey), or a rest interval "20s rest"
  const drawTiming = (t, right, yy, small) => {
    const sz = small ? 9 : 9.5;
    if (t.int != null) {
      const b2 = t.int2 != null && t.int2 !== t.int ? t.int2 : null;
      if (b2 != null) { font('normal', sz - 1, MUTED); const sec = ` / ${fmtTime(b2)}`; T(sec, right, yy + 0.3, { align: 'right' }); const sw = tw(sec); font('semibold', sz, INK); T(`@${fmtTime(t.int)}`, right - sw, yy, { align: 'right' }); }
      else { font('semibold', sz, INK); T(`@${fmtTime(t.int)}`, right, yy, { align: 'right' }); }
    } else if (t.rest != null) { font('semibold', sz, INK); T(restLabel(t.rest), right, yy, { align: 'right' }); }
  };
  const pill = (text, right, yy) => {
    const e = parseEffort(text); text = effFromCanon(text); font('semibold', 8); const w = Math.max(10, tw(text) + 2.6), x = right - w, h = 4.4;
    if (!e) { doc.setFillColor(...LINE); doc.roundedRect(x, yy, w, h, 0.9, 0.9, 'F'); }
    else if (e.kind === 'single') { doc.setFillColor(...effRGB(e.mean)); doc.roundedRect(x, yy, w, h, 0.9, 0.9, 'F'); }
    else { const n = 8; for (let i = 0; i < n; i++) { const v = e.kind === 'build' ? e.lo + (e.hi - e.lo) * (i + 0.5) / n : (i < n / 2 ? e.lo : e.hi); doc.setFillColor(...effRGB(v).map(c => Math.round(c + (255 - c) * 0.5))); doc.rect(x + i * w / n, yy, w / n + 0.05, h, 'F'); } }
    const ink = e && e.kind === 'single' && lumOf(effRGB(e.mean)) < 0.55 ? WHITE : INK;
    if (e && e.kind === 'single' && lumOf(effRGB(e.mean)) > 0.9) { doc.setDrawColor(...LINE); doc.setLineWidth(0.25); doc.roundedRect(x, yy, w, h, 0.9, 0.9, 'S'); }
    font('semibold', 8, ink); T(text, x + w / 2, yy + 0.75, { align: 'center' });
  };
  function blockRows(b, w){
    const rows = [], st = statsOf(b.items), grp = s._group ? '' : blockGroupLabel(s, b);
    const twoLane = (function f(items){ return (items || []).some(n => n.t === 'round' ? f(n.items) : ((n.int != null && n.int2 != null && n.int2 !== n.int) || ((partTimings(n) || { parts: [] }).parts.some(q => q.own && q.own.int2 != null && q.own.int2 !== q.own.int)))); })(b.items);
    font('semibold', 9.5);
    const restW = (function f(items){ return (items || []).reduce((m, n) => n.t === 'round' ? Math.max(m, f(n.items)) : Math.max(m, n.int == null && n.rest != null ? tw(restLabel(n.rest)) + 1 : 0, ...((partTimings(n) || { parts: [] }).parts.map(q => q.own && q.own.int == null && q.own.rest != null ? tw(restLabel(q.own.rest)) + 1 : 0))), 0); })(b.items);
    font('semibold', 8);
    const effW = (function f(items){ return (items || []).reduce((m, n) => n.t === 'round' ? Math.max(m, f(n.items)) : (n.eff ? Math.max(m, tw(effFromCanon(n.eff)) + 2.6) : m), 0); })(b.items);
    const cols = { qty: 15, so: Math.max(twoLane ? 19 : 12.5, restW), eff: Math.max(11, effW), dist: 0, g: 1.8 };
    cols.desc = w - cols.qty - cols.so - cols.eff - cols.dist - cols.g * (cols.dist ? 4 : 3);
    const stt = b.kind === 'notes' ? [] : (starts.get(b.id) || []);
    const clock = s.start && stt.length ? (stt.length === 1 ? `${clockAdd(s.start, stt[0])}–${clockAdd(s.start, stt[0] + st.time)}` : `from ${stt.map(t0 => clockAdd(s.start, t0)).join(' / ')}`) : '';
    font('bold', 12.5); const nameT = (b.name || 'Block').toUpperCase(), nameW = tw(nameT);
    font('semibold', 7.5); const chipW = grp ? tw(grp.toUpperCase()) + 4 : 0;
    font('normal', 9); const clW = clock ? tw(clock) : 0;
    const oneLine = nameW + (chipW ? chipW + 2.5 : 0) + 5 + clW <= w;
    const hh = oneLine ? 8.4 : 12.2;
    rows.push({ h: hh, draw(x, yy){
      font('bold', 12.5, INK); T(nameT, x, yy + 0.8);
      if (grp) { const cx = x + nameW + 2.5; doc.setFillColor(...ORANGE); doc.roundedRect(cx, yy + 1.3, chipW, 4.2, 0.9, 0.9, 'F'); font('semibold', 7.5, WHITE); T(grp.toUpperCase(), cx + 2, yy + 1.95, { charSpace: 0 }); }
      if (clock) { font('normal', 9, MUTED); if (oneLine) T(clock, x + w, yy + 1.7, { align: 'right' }); else T(clock, x, yy + 6.2); }
      doc.setDrawColor(...INK); doc.setLineWidth(0.5); doc.line(x, yy + hh - 0.9, x + w, yy + hh - 0.9);
    } });
    if (b.kind === 'notes') {
      const PANEL = [243, 244, 246], pad = h => rows.push({ h, draw(x, yy){ doc.setFillColor(...PANEL); doc.rect(x, yy, w, h, 'F'); } });
      pad(1.8);
      String(b.text || '').trim().split('\n').forEach(pa => {
        font('normal', 10); const ls = pa.trim() ? wrap(pa.trim(), w - 7) : [''];
        ls.forEach(l => rows.push({ h: LH(10), draw(x, yy){ doc.setFillColor(...PANEL); doc.rect(x, yy, w, LH(10) + 0.05, 'F'); font('normal', 10, INK); T(l, x + 3.5, yy + 0.4); } }));
      });
      pad(2);
      return rows;
    }
    const add = (items, depth) => (items || []).forEach(n => {
      const off = depth * DEP;
      if (isBlankLine(n)) return;
      if (isNoteLine(n)) {
        font('italic', 9.5); const nl = wrap(plainDesc(n.desc), w - off - 1), h = nl.length * LH(9.5) + 2.6;
        rows.push({ h, draw(x, yy){ ropes(x, yy, h, depth); font('italic', 9.5, MUTED); nl.forEach((l, i) => T(l, x + off, yy + 1.3 + i * LH(9.5))); doc.setDrawColor(...LINE); doc.setLineWidth(0.15); doc.line(x + off, yy + h, x + w, yy + h); } });
        return;
      }
      if (n.t === 'round') {
        rows.push({ h: 6.4, draw(x, yy){
          ropes(x, yy, 6.4, depth); const x0 = x + off;
          font('bold', 12, ORANGE); const lab = `${n.times || 0}×`; T(lab, x0, yy + 1.1); const lw = tw(lab);
          font('semibold', 7.5, ORANGE); const word = n.times == 1 ? 'ROUND' : 'ROUNDS'; T(word, x0 + lw + 1.4, yy + 2.3, { charSpace: 0.3 }); const ww = tw(word) + 0.3 * word.length;
          if (n.note) { font('italic', 9, MUTED); const nt = wrap(n.note, w - off - lw - ww - 6)[0] || ''; T(nt, x0 + lw + ww + 3.2, yy + 1.9); }
        } });
        add(n.items, depth + 1); return;
      }
      const dp = partTimings(n);
      const first = dp ? (dp.prefix || dp.parts[0].text) : plainDesc(n.desc), numbered = dp && !dp.prefix;
      const dW = cols.desc - off - (numbered ? 4 : 0);
      font('normal', 10); const dl = first ? wrap(first, dW) : [];
      const h = Math.max(6.6, dl.length * LH(10) + 2.6);
      const restParts = dp ? (dp.prefix ? dp.parts : dp.parts.slice(1)) : [];
      rows.push({ h, draw(x, yy){
        ropes(x, yy, h, depth); const x0 = x + off, dx = x0 + cols.qty + cols.g;
        font('bold', 11.5, INK); T(qtyText(n), x0, yy + 1.4);
        if (numbered) { font('semibold', 8.5, ORANGE); T('1', dx, yy + 2.1); }
        font('normal', 10, INK); dl.forEach((l, i) => T(l, dx + (numbered ? 4 : 0), yy + 1.7 + i * LH(10)));
        let r = x + w;
        if (n.eff) pill(n.eff, r, yy + 1.2);
        r -= cols.eff + cols.g;
        drawTiming(lineTiming(n), r, yy + 1.8);
        if (!restParts.length) { doc.setDrawColor(...LINE); doc.setLineWidth(0.15); doc.line(x0, yy + h, x + w, yy + h); }
      } });
      restParts.forEach((pt, k) => {
        const last = k === restParts.length - 1, reps = n.reps || 1, cnt = dp.parts.length;
        const extra = last && reps !== cnt ? `  (${partsNote(n, cnt)})` : '';
        const ownT = pt.own && (pt.own.int != null || pt.own.rest != null) ? pt.eff : null;
        font('normal', 9.5); const pl = wrap(pt.text + extra, cols.desc - off - 4 + (ownT ? 0 : cols.so + cols.g));
        const ph = Math.max(5.2, pl.length * LH(9.5) + 1.4);
        rows.push({ h: ph, draw(x, yy){
          ropes(x, yy, ph, depth); const dx = x + off + cols.qty + cols.g;
          font('semibold', 8.5, ORANGE); T(String(pt.n), dx, yy + 0.9);
          font('normal', 9.5, INK); pl.forEach((l, i) => T(l, dx + 4, yy + 0.6 + i * LH(9.5)));
          if (ownT) drawTiming(ownT, x + w - cols.eff - cols.g, yy + 0.7, true);
          if (last) { doc.setDrawColor(...LINE); doc.setLineWidth(0.15); doc.line(x + off, yy + ph + 0.4, x + w, yy + ph + 0.4); }
        } });
      });
    });
    add(b.items, 0);
    if (rows.length === 1) rows.push({ h: 6, draw(x, yy){ font('italic', 9.5, FAINT); T('No sets yet', x, yy + 1.6); } });
    return rows;
  }

  /* placing blocks: stacked, or side by side when groups swim at the same time */
  const contHeader = () => { font('semibold', 7.5, MUTED); T(`${headTitle.toUpperCase()}  ·  ${HEAD}`, M, TOP, { charSpace: 0.3 }); doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(M, TOP + 4.6, PW - M, TOP + 4.6); y = TOP + 8; };
  const newPage = () => { doc.addPage(); contHeader(); };
  const placeStacked = b => {
    const rows = blockRows(b, CW);
    if (y + rows[0].h + (rows[1] ? rows[1].h : 0) > BOTTOM) newPage();
    rows.forEach((r, i) => {
      if (y + r.h > BOTTOM) { newPage(); font('semibold', 8, MUTED); T(`${(b.name || 'Block').toUpperCase()} (CONTINUED)`, M, y, { charSpace: 0.3 }); y += 5.5; }
      r.draw(M, y); y += r.h;
    });
    y += 5.5;
  };
  const placeSide = blocks => {
    const n = blocks.length, gap = 6, w = (CW - gap * (n - 1)) / n;
    const cols = blocks.map(b => blockRows(b, w)), H = Math.max(...cols.map(rs => rs.reduce((a, r) => a + r.h, 0)));
    if (H > BOTTOM - TOP - 10) { blocks.forEach(placeStacked); return; }
    if (y + H > BOTTOM) newPage();
    cols.forEach((rs, i) => { let yy = y; const x = M + i * (w + gap); rs.forEach(r => { r.draw(x, yy); yy += r.h; }); });
    if (n > 1) { doc.setDrawColor(...LINE); doc.setLineWidth(0.3); for (let i = 1; i < n; i++) { const lx = M + i * (w + gap) - gap / 2; doc.line(lx, y + 1, lx, y + H); } }
    y += H + 5.5;
  };
  s.blocks.filter(b => b.kind !== 'notes' || hasNoteText(b)).forEach(placeStacked);

  /* notes space */
  if (BOTTOM - y >= 20) {
    font('semibold', 7.5, MUTED); T('NOTES', M, y, { charSpace: 0.35 });
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2);
    for (let ly = y + 9; ly <= BOTTOM - 1; ly += 7.5) doc.line(M, ly, PW - M, ly);
  }

  /* footer */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); font('normal', 7, FAINT);
    T(`${FOOT}${printedAt ? '  ·  printed ' + printedAt : ''}`, M, PH - 9);
    if (pages > 1) T(`Page ${i} of ${pages}`, PW - M, PH - 9, { align: 'right' });
  }
  return doc;
}
