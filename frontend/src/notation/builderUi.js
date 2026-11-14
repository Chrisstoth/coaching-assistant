/* The Session Builder screen, mounted inside the app.

   This is the Session Builder artifact's own screen code (editing, keyboard,
   drag and drop, selection, rounds, poolside view, dictation), wrapped in
   mountBuilder() so a React page can mount and unmount it. Its listeners are
   limited to the builder and removed on unmount. Saving goes through
   opts.save (the app's API) instead of the artifact's own storage; the library,
   backup files and the Excel import/export are gone (the app's session list and
   the history import replace them). Logic lives in ./core.js.
*/
import Sortable from 'sortablejs'
import { jsPDF } from 'jspdf'
import { sysDef, useScales, DIST_END, DKW, EFF_ORDER, EFF_STOPS, EFF_SYS, EFF_SYSTEMS, GROUP_COLORS, NUMW, NUMWORD, PART_LINE, PURE_TIME, RX_DIST, RX_PREFIX, RX_REPS, RX_ROUND, RX_SENDOFF, RX_STRONG, SET_START, T_R, T_SO, Z, addPart, appliesTo, avgEff, blockGroupNames, blockStarts, buildDesc, canonOf, capFirst, cellText, clamp, clockAdd, clockMins, cloneWithNewIds, descParts, displayTitle, effAvgText, effFromCanon, effHSL, effSys, effToCanon, esc, expandSeq, extractTiming, fmtDist, fmtTime, groupColor, groupLabel, groupName, hasNoteText, hasTiming, hexRgb, hoistFirstTiming, isBlankLine, isNoteLine, isTalkLine, itemsToText, lineText, lineTiming, looksSpoken, lumOf, matchParen, mergeTiming, newBlock, newLine, newNotes, newRound, nodeStats, normalizeDictation, normalizeSession, parseEffort, parseLineNodes, parseRest, parseSetLine, parseTalkTime, parseText, parseTime, parseTimingCell, partTimings, partsNote, perRep, plainDesc, restLabel, restShort, sendoffText, sessionForGroup, sessionGroups, sessionText, setEffSys, slotSeconds, splitSets, statsOf, timeText, timingMode, timingToken, totalsFor, uid, wordsToDigits, zoneFor } from './core.js'
import { buildSessionPdf, exportFileName, hslRgb } from './pdf.js'
import { loadPdfFonts } from './sessionPdf.js'
import { BUILDER_TEMPLATE } from './template.js'

export function mountBuilder(root, opts){
  /* Listeners the screen code adds to the page only react inside the builder,
     and are all removed again by destroy(). */
  const INSIDE_ONLY = new Set(['click', 'input', 'keydown', 'focusout', 'paste'])
  const listeners = []
  const track = target => new Proxy(target, {
    get(t, p){
      if (p === 'addEventListener') return (type, fn, o) => {
        const h = INSIDE_ONLY.has(type)
          ? e => { const x = e.target; if (x && x.nodeType === 1 && x !== t.body && !root.contains(x)) return; fn(e) }
          : fn
        t.addEventListener(type, h, o); listeners.push([t, type, h, o])
      }
      const v = Reflect.get(t, p, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  const document = track(globalThis.document)
  const window = track(globalThis.window)
  root.classList.add('sb')
  root.innerHTML = BUILDER_TEMPLATE

  // the club's intensity scales: its own beside the standard ones it hasn't hidden
  useScales(opts.customScales)
  const scaleList = (opts.scales && opts.scales.length ? opts.scales.slice() : EFF_ORDER.map(k => ({ key: k, name: EFF_SYSTEMS[k].name })))
    .filter(s => sysDef(s.key))
  for (const k of [opts.session && opts.session.effSys, opts.effSys]) if (k && sysDef(k) && !scaleList.some(s => s.key === k)) scaleList.push({ key: k, name: sysDef(k).name })
  { const pick = root.querySelector('#m-effsys'); if (pick) pick.innerHTML = scaleList.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('') }

  let cur = { id: null, session: null, loadedAt: 0 }
  let dirty = false, saving = false, saveTimer = null, retries = 0
  const STANDALONE = true
  const downloads = { save: (...a) => anchorSave(...a) }


/* ---------- colour ---------- */
const effColor = e => { if (effSys().colored) return zoneFor(e, EFF_SYS).color; const [h, s, l] = effHSL(e); return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`; };
function effBg(p){
  if (!p) return 'var(--line)';
  if (p.kind === 'build') return `linear-gradient(90deg, ${effColor(p.lo)}, ${effColor(p.hi)})`;
  if (p.kind === 'mix') return `repeating-linear-gradient(90deg, ${effColor(p.lo)} 0 5px, ${effColor(p.hi)} 5px 10px)`;
  return effColor(p.mean);
}
const effInk = p => (p && (effSys().colored ? lumOf(hexRgb(zoneFor(p.mean, EFF_SYS).color)) < 0.55 : effHSL(p.mean)[2] < 52)) ? '#FFFFFF' : '#15171A';
const dotStyle = p => p ? `background:${effBg(p)}` : '';

/* ---------- state ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
let view = 'edit', curGroup = '';
let noted = new Set();   // sets the coach has noted something about this session (poolside)
const sel = new Set();
const textMode = new Set();
let undoStack = [];
let sortables = [];
let lastDragEnd = 0, dragging = false;
let wakeLock = null;
const S = () => cur.session;

const ICON = {
  grip: '<svg viewBox="0 0 6 10" fill="currentColor"><circle cx="1.2" cy="1.2" r="1.1"/><circle cx="4.8" cy="1.2" r="1.1"/><circle cx="1.2" cy="5" r="1.1"/><circle cx="4.8" cy="5" r="1.1"/><circle cx="1.2" cy="8.8" r="1.1"/><circle cx="4.8" cy="8.8" r="1.1"/></svg>',
  mic: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2.2"/></svg>',
  dots: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>',
  talk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>'
};
// how long a talk runs when it's added from a menu; the coach changes it in the row
const TALK_DEFAULT = 120;

function blankSession(from){
  return {
    title: '', date: new Date().toISOString().slice(0, 10), slot: from?.slot || 'AM', effSys: from?.effSys || EFF_SYS,
    start: from?.start || '', end: from?.end || '', venue: from?.venue || '', coach: from?.coach || '', weekKey: '', aims: ['', ''],
    groups: (from && from.groups || []).map(g => ({ ...g })),
    blocks: [newBlock('Warm up'), newBlock('Main set'), newBlock('Swim down')]
  };
}

/* ---------- lookup ---------- */
function locIn(arr, id, parent){
  for (let i = 0; i < arr.length; i++) {
    const n = arr[i];
    if (n.id === id) return { node: n, arr, index: i, parent };
    if (n.t === 'round') { const r = locIn(n.items, id, n); if (r) return r; }
  }
  return null;
}
function locate(id){
  const blocks = S().blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.id === id) return { node: b, arr: blocks, index: i, parent: null, kind: 'block' };
    const r = locIn(b.items, id, b); if (r) return { ...r, block: b };
  }
  return null;
}
function contains(node, id){ return (node.items || []).some(n => n.id === id || contains(n, id)); }
function walk(items, fn){ (items || []).forEach(n => { fn(n); if (n.t === 'round') walk(n.items, fn); }); }

/* ---------- rendering ---------- */
function totHTML(st, n){
  if (n && isTalkLine(n)) return `<b>${fmtTime(st.time)}</b>`;
  return `<b>${fmtDist(st.dist)}</b> m${st.time ? ' · ' + fmtTime(st.time) : ''}`;
}
// the coach explaining the next set: a note of what to cover and how long it takes
function talkHTML(n){
  return `<div class="node line talk${sel.has(n.id) ? ' sel' : ''}" data-id="${n.id}">` +
    `<button class="grip" type="button" data-act="sel" aria-label="Select or drag this talk" aria-pressed="${sel.has(n.id)}">${ICON.grip}</button>` +
    `<span class="tlab">${ICON.talk}Talk</span>` +
    `<input class="cell desc" id="f-${n.id}-desc" data-f="desc" value="${esc(n.desc)}" placeholder="What you’ll cover: purpose, key points, who to speak to" aria-label="What the talk covers" autocomplete="off">` +
    `<input class="cell num int talkt" id="f-${n.id}-talk" data-f="talk" value="${esc(fmtTime(n.talk))}" placeholder="m:ss" inputmode="decimal" aria-label="How long the talk takes" title="How long you’ll talk before the set: 2, 2:00, 90s or 2 min" autocomplete="off">` +
    `<span class="tgap"></span><span class="tgap"></span>` +
    `<span class="tot" data-tot="${n.id}">${totHTML(nodeStats(n), n)}</span>` +
    `<button class="kebab" type="button" data-act="menu" data-for="${n.id}" aria-label="Talk options" aria-haspopup="menu">${ICON.dots}</button>` +
    `</div>`;
}
function blockTotHTML(b, st, starts){
  const a = avgEff(st); const s = S(); let clock = '';
  if (starts && starts.length && s.start) {
    clock = starts.length === 1 ? ` · ${clockAdd(s.start, starts[0])}–${clockAdd(s.start, starts[0] + st.time)}` : ` · from ${starts.map(t => clockAdd(s.start, t)).join(' / ')}`;
  }
  return `<b>${fmtDist(st.dist)}</b> m · ${st.time || st.time2 ? timeText(st) : '0:00'}${clock}${a != null ? ' · avg ' + effAvgText(a) : ''}`;
}
function lineHTML(n){
  if (isTalkLine(n)) return talkHTML(n);
  const st = nodeStats(n), e = parseEffort(n.eff), pe = descParts(n.desc, 1, true), md = timingMode(n);
  return `<div class="node line${sel.has(n.id) ? ' sel' : ''}" data-id="${n.id}">` +
    `<button class="grip" type="button" data-act="sel" aria-label="Select or drag this set" aria-pressed="${sel.has(n.id)}">${ICON.grip}</button>` +
    `<input class="cell num reps" id="f-${n.id}-reps" data-f="reps" value="${n.reps ?? ''}" placeholder="1" inputmode="numeric" aria-label="Reps" autocomplete="off">` +
    `<span class="x" aria-hidden="true">×</span>` +
    `<input class="cell num dist" id="f-${n.id}-dist" data-f="dist" value="${n.dist ?? ''}" placeholder="m" inputmode="numeric" aria-label="Distance in metres" autocomplete="off">` +
    (pe ? `<input class="cell desc" id="f-${n.id}-desc" data-f="desc" data-prefix="1" value="${esc(pe.rawPrefix)}" placeholder="Heading (optional)" aria-label="Set heading" autocomplete="off">`
        : `<input class="cell desc" id="f-${n.id}-desc" data-f="desc" value="${esc(n.desc)}" placeholder="What they swim" aria-label="Description" autocomplete="off">`) +
    `<input class="cell num int${md === 'rest' ? ' isrest' : ''}" id="f-${n.id}-int" data-f="int" value="${esc(md === 'send' ? fmtTime(n.int) : (n.rest != null ? 'r' + restShort(n.rest) : ''))}" placeholder="${md === 'rest' ? 'rest' : '@m:ss'}" aria-label="Send-off or rest" title="Send-off 1:30 · rest r20 · second lane 1:30/1:40" autocomplete="off">` +
    (md === 'rest'
      ? `<input class="cell num int2 est${n.est == null && n.dist ? ' need' : ''}" id="f-${n.id}-int2" data-f="est" value="${n.est != null ? fmtTime(n.est) : ''}" placeholder="~swim" aria-label="Estimated swim time per rep" title="Estimated swim time per rep, so the session time can include this set" autocomplete="off" inputmode="decimal">`
      : `<input class="cell num int2" id="f-${n.id}-int2" data-f="int2" value="${n.int2 != null ? fmtTime(n.int2) : ''}" placeholder="2nd" aria-label="Send-off for the second lane" autocomplete="off" inputmode="decimal" title="Send-off for the second lane, if it differs">`) +
    `<div class="eff"><i class="dot" data-dot="${n.id}" style="${dotStyle(e)}"></i><input class="cell num" id="f-${n.id}-eff" data-f="eff" value="${esc(effFromCanon(n.eff))}" placeholder="${esc(effSys().hint)}" aria-label="Intensity (${esc(effSys().name)})" autocomplete="off"></div>` +
    `<span class="tot" data-tot="${n.id}">${totHTML(st)}</span>` +
    `<button class="kebab" type="button" data-act="menu" data-for="${n.id}" aria-label="Set options" aria-haspopup="menu">${ICON.dots}</button>` +
    `<div class="parts${pe ? ' edit' : ''}" data-parts="${n.id}">${pe ? partsEditHTML(n, pe) : partsHTML(n)}</div>` +
    `</div>`;
}
function partsHTML(n){
  const d = descParts(n.desc); if (!d) return '';
  const note = partsNote(n, d.parts.length);
  return d.parts.map(p => `<span><b>${p.n}</b>${esc(p.text)}</span>`).join('') + (note ? `<em${note.includes('parts for') ? ' class="warn"' : ''}>${note}</em>` : '');
}
function partsEditHTML(n, pe){
  const note = partsNote(n, pe.parts.length), pt = partTimings(n, true), firstTxt = cellText(pt.first), hd = !!n.dist;
  return pt.parts.map((p, i) => `<div class="prow"><b>${i + 1}</b><input class="cell pin" id="p-${n.id}-${i}" data-part="${n.id}" data-pi="${i}" value="${esc(i === 0 ? p.raw : p.text)}" placeholder="Line ${i + 1}" aria-label="Line ${i + 1}" autocomplete="off" enterkeyhint="next">` +
    (i === 0 ? `<span class="pinherit" title="Line 1 uses the set’s turnaround">${esc(firstTxt)}</span>`
      : `<input class="cell num pint${p.own && !perRep(p.eff, hd).per ? ' need' : ''}" id="pt-${n.id}-${i}" data-ptime="${n.id}" data-pi="${i}" value="${esc(p.own ? cellText(p.own) : '')}" placeholder="${esc(firstTxt || '@m:ss')}" aria-label="Turnaround for line ${i + 1}" title="Leave blank to use line 1’s turnaround · send-off 1:30 · rest r20 ~1:20" autocomplete="off">`) +
    `</div>`).join('') +
    `<em class="pnote${note.includes('parts for') ? ' warn' : ''}" data-pnote="${n.id}">${note}</em>`;
}
const partTexts = id => $$(`[data-part="${id}"]`).sort((a, b) => a.dataset.pi - b.dataset.pi).map(x => {
  const ti = $(`#pt-${id}-${x.dataset.pi}`), tm = ti ? parseTimingCell(ti.value) : null;
  return [x.value.trim(), tm ? timingToken(tm) : ''].filter(Boolean).join(' ');
});
function currentParts(id){
  const l = locate(id); if (!l) return null;
  const el = $(`#f-${id}-desc`);
  if (el && el.dataset.prefix) return { prefix: el.value, texts: partTexts(id) };
  const pe = descParts(l.node.desc, 1, true);
  return pe ? { prefix: pe.rawPrefix, texts: pe.parts.map(p => p.text) } : null;
}
function setParts(id, texts, prefix, focus){
  const l = locate(id); if (!l) return;
  pushUndo(); l.node.desc = texts.length ? buildDesc(prefix, texts) : String(prefix || '').trim();
  renderBlocks(focus || null); markDirty();
}
// Shift+Enter: add the next numbered line under this set (what's already typed stays as its heading)
function startOrAddPart(id, afterIdx){
  const l = locate(id); if (!l || l.node.t !== 'line' || isTalkLine(l.node)) return;
  const cp = currentParts(id);
  if (cp) {
    if (afterIdx == null && cp.texts[cp.texts.length - 1] === '') { const el = $(`#p-${id}-${cp.texts.length - 1}`); if (el) el.focus(); return; }
    const at = afterIdx == null ? cp.texts.length : afterIdx + 1;
    cp.texts.splice(at, 0, ''); setParts(id, cp.texts, cp.prefix, { id: `p-${id}-${at}`, pos: 0 }); return;
  }
  setParts(id, [''], l.node.desc || '', { id: `p-${id}-0`, pos: 0 });
}
function removePart(id, i){
  const cp = currentParts(id); if (!cp) return;
  cp.texts.splice(i, 1);
  const focus = cp.texts.length ? (i > 0 ? { id: `p-${id}-${i - 1}`, pos: cp.texts[i - 1].length } : { id: `p-${id}-0`, pos: 0 }) : { id: `f-${id}-desc`, pos: String(cp.prefix || '').length };
  setParts(id, cp.texts, cp.prefix, focus);
}
function repaintLine(id){
  const el = $(`.node[data-id="${id}"]`), l = locate(id); if (!el || !l || l.node.t !== 'line') return;
  const a = document.activeElement, aid = a && el.contains(a) ? a.id : null, pos = aid ? a.selectionStart : null;
  el.outerHTML = lineHTML(l.node);
  if (aid) { const f = document.getElementById(aid); if (f) { f.focus(); try { f.setSelectionRange(pos, pos); } catch (e) {} } }
}
// drop empty numbered lines once you've moved away from them
function cleanParts(id){
  const box = $(`[data-parts="${id}"]`); if (!box || box.contains(document.activeElement)) return;
  const cp = currentParts(id), l = locate(id); if (!cp || !l) return;
  const keep = cp.texts.filter(x => x.trim()); if (keep.length === cp.texts.length) return;
  l.node.desc = keep.length ? buildDesc(cp.prefix, keep) : String(cp.prefix || '').trim();
  markDirty();
  const host = box.closest('.node[data-id]');
  if (host && host.contains(document.activeElement)) {
    if (keep.length) box.innerHTML = partsEditHTML(l.node, descParts(l.node.desc, 1, true));
    else { box.classList.remove('edit'); box.innerHTML = ''; const d = $(`#f-${id}-desc`); if (d) { delete d.dataset.prefix; d.placeholder = 'What they swim'; d.setAttribute('aria-label', 'Description'); } }
  } else repaintLine(id);
}
function quickHTML(parentId, ph){
  const on = micOn && micTarget === parentId;
  return `<div class="quick"><span class="plus" aria-hidden="true">+</span><input class="cell qin" id="q-${parentId}" data-quick="${parentId}" data-ph="${esc(ph)}" placeholder="${esc(on ? MIC_PH : ph)}" aria-label="Add a set" autocomplete="off" enterkeyhint="enter">` +
    (speechOK() ? `<button class="mic${on ? ' on' : ''}" type="button" data-act="mic" data-for="${parentId}" aria-pressed="${on}" aria-label="${on ? 'Stop listening' : 'Speak sets into this block'}" title="Speak sets (Chrome)">${ICON.mic}</button>` : '') + `</div>`;
}
function roundHTML(n){
  return `<div class="node round${sel.has(n.id) ? ' sel' : ''}" data-id="${n.id}">` +
    `<div class="round-head">` +
      `<button class="grip" type="button" data-act="sel" aria-label="Select or drag this round" aria-pressed="${sel.has(n.id)}">${ICON.grip}</button>` +
      `<label class="times"><input class="cell num" id="f-${n.id}-times" data-f="times" value="${n.times ?? ''}" inputmode="numeric" aria-label="Number of rounds" autocomplete="off"><span class="lbl">× round<span data-pl="${n.id}">${n.times == 1 ? '' : 's'}</span></span></label>` +
      `<input class="cell note" id="f-${n.id}-note" data-f="note" value="${esc(n.note)}" placeholder="Round note, e.g. 30s rest between rounds" aria-label="Round note" autocomplete="off">` +
      `<span class="tot" data-tot="${n.id}">${totHTML(nodeStats(n))}</span>` +
      `<button class="kebab" type="button" data-act="menu" data-for="${n.id}" aria-label="Round options" aria-haspopup="menu">${ICON.dots}</button>` +
    `</div>` +
    `<div class="round-body"><div class="rope" aria-hidden="true"></div><div class="round-inner">` +
      `<div class="items" data-parent="${n.id}">${itemsHTML(n.items)}</div>` +
      quickHTML(n.id, 'Add to this round · backspace on empty to step out') +
    `</div></div></div>`;
}
const itemsHTML = items => (items || []).map(n => n.t === 'round' ? roundHTML(n) : lineHTML(n)).join('');
function blockHTML(b, starts){
  if (b.kind === 'notes') {
    const rows = Math.max(3, String(b.text || '').split('\n').length + 1);
    return `<article class="block notesblock" data-id="${b.id}"><header class="bhead">` +
      `<button class="grip bgrip" type="button" aria-label="Drag to move these notes">${ICON.grip}</button>` +
      `<input class="bname" id="f-${b.id}-name" data-f="name" value="${esc(b.name)}" aria-label="Notes heading" autocomplete="off">` +
      gpickHTML(b) + `<div class="btot"><span class="ntag">Notes</span></div>` +
      `<button class="kebab" type="button" data-act="menu" data-for="${b.id}" aria-label="Notes options" aria-haspopup="menu">${ICON.dots}</button></header>` +
      `<textarea class="ntext" id="f-${b.id}-text" data-f="text" rows="${rows}" placeholder="Equipment, focus points, who leads each lane, reminders…" aria-label="Notes">${esc(b.text || '')}</textarea></article>`;
  }
  const st = statsOf(b.items);
  const head = `<header class="bhead">` +
    `<button class="grip bgrip" type="button" aria-label="Drag to reorder block">${ICON.grip}</button>` +
    `<input class="bname" id="f-${b.id}-name" data-f="name" value="${esc(b.name)}" aria-label="Block name" autocomplete="off">` +
    gpickHTML(b) +
    `<div class="btot" data-tot="${b.id}">${blockTotHTML(b, st, starts)}</div>` +
    `<button class="kebab" type="button" data-act="menu" data-for="${b.id}" aria-label="Block options" aria-haspopup="menu">${ICON.dots}</button>` +
    `</header>`;
  if (textMode.has(b.id)) {
    return `<article class="block" data-id="${b.id}">${head}<div class="textmode">` +
      `<textarea id="t-${b.id}" data-text="${b.id}" spellcheck="false" aria-label="Block as text">${esc(itemsToText(b.items).join('\n'))}</textarea>` +
      `<div class="help">One set per line: <code>3x50 Build 1-3 (1:05) [14->18]</code>. Send-off can be <code>@1:05</code>, <code>(60)</code>, <code>on 60</code> or <code>off 1:10</code>; add a second lane with a slash, <code>@1:30/1:40</code>. Numbered lines: <code>4x100 1) Kick 2) Drill 3) Swim 4) Build</code>, or put <code>1) Kick</code>, <code>2) Drill</code>… on the lines under the set; Shift+Enter starts the next number for you. Rest sets: <code>r20 ~1:20</code> (20s rest, about 1:20 per swim). Time you spend explaining the next set: <code>Talk 3:00 purpose and turns</code>. A turnaround after a numbered line is that line’s own: <code>2) Build @4:45</code>. <code>2 x (4 x 50, 2 x 100)</code> makes a 2× round in one line. A line like <code>3x</code> on its own starts a round; indent the lines under it with two spaces.</div>` +
      `<div class="bfoot"><span></span><span style="display:flex;gap:8px"><button class="btn" type="button" data-act="cancel-text" data-for="${b.id}">Cancel</button><button class="btn primary" type="button" data-act="apply-text" data-for="${b.id}">Apply</button></span></div>` +
      `</div></article>`;
  }
  return `<article class="block" data-id="${b.id}">${head}` +
    `<div class="colhead" aria-hidden="true"><span></span><span>Reps × dist</span><span>Description</span><span class="r">Send-off</span><span class="r">Lane 2</span><span>${esc(effSys().short)}</span><span class="r">Total</span><span></span></div>` +
    `<div class="items" data-parent="${b.id}">${itemsHTML(b.items)}</div>` +
    quickHTML(b.id, 'Add a set: 4x100 PB+10 off 2:00 [18]  ·  2 x (4 x 50, 2 x 100) makes a round') +
    `</article>`;
}

function gpickHTML(b){
  const s = S(); if (!(s.groups || []).length) return '<span></span>';
  const ids = b.groups || [];
  const inner = ids.length ? ids.map(id => `<i style="--gc:${groupColor(s, id)}"></i>${esc(groupName(s, id))}`).join(' ') : '<span class="all">All groups</span>';
  return `<button class="gpick" type="button" data-act="gpick" data-for="${b.id}" aria-label="Which groups swim this block" aria-haspopup="menu"><span class="lab">For</span>${inner}</button>`;
}
const visibleBlocks = () => S().blocks.filter(b => !curGroup || appliesTo(b, curGroup));
function renderGroupsEdit(){
  const s = S();
  // who swims each group is chosen by the app around the builder, when it offers that
  const who = g => {
    if (!opts.onWho) return '';
    const n = (g.swimmer_ids || []).length;
    return `<button type="button" class="gwho${n ? '' : ' none'}" data-act="who" data-gid="${g.id}" aria-label="Who swims ${esc(g.name)}: ${n} swimmer${n === 1 ? '' : 's'}">${n ? `${n} swimmer${n === 1 ? '' : 's'}` : 'Who?'}</button>`;
  };
  $('#groupsEdit').innerHTML = (s.groups || []).map(g => `<span class="gchip" style="--gc:${groupColor(s, g.id)}"><i></i><input id="g-${g.id}" data-gname="${g.id}" value="${esc(g.name)}" aria-label="Group name" autocomplete="off" size="${Math.max(5, g.name.length + 1)}">${who(g)}<button type="button" data-act="del-group" data-gid="${g.id}" aria-label="Remove ${esc(g.name)}">×</button></span>`).join('') +
    `<button class="btn quiet" type="button" data-act="add-group">+ Add group</button>` +
    ((s.groups || []).length ? '' : `<span class="ghint">One group swims everything. Add groups to give each its own sets.</span>`);
}
function renderTabs(){
  const s = S(), gs = s.groups || [], el = $('#gtabs');
  if (curGroup && !gs.some(g => g.id === curGroup)) curGroup = '';
  if (!gs.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<button type="button" data-act="tab" data-gid="" aria-pressed="${!curGroup}">All groups</button>` + gs.map(g => `<button type="button" data-act="tab" data-gid="${g.id}" aria-pressed="${curGroup === g.id}" style="--gc:${groupColor(s, g.id)}"><i></i>${esc(g.name)}</button>`).join('');
}
function renderBlocks(focus){
  const active = document.activeElement;
  const keep = focus || (active && active.id && $('#blocks').contains(active) ? { id: active.id, pos: active.selectionStart } : null);
  sortables.forEach(s => { try { s.destroy(); } catch (e) {} });
  sortables = [];
  const starts = blockStarts(S());
  $('#blocks').innerHTML = visibleBlocks().map(b => blockHTML(b, starts.get(b.id))).join('') || `<div class="panel loading"><b>No blocks for this group yet</b>Add one below, or give it a shared block from its menu.</div>`;
  renderTabs();
  initSortables();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.focus({ preventScroll: !!keep.noScroll }); if (keep.pos != null && el.setSelectionRange && el.type !== 'number') { try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) {} } }
  }
  renderSummary();
  renderSelbar();
  paintComments();
}
function renderMeta(){
  const s = S();
  $('#m-title').value = s.title || ''; $('#m-title').placeholder = displayTitle({ ...s, title: '' });
  $('#m-date').value = s.date || ''; $('#m-slot').value = s.slot || 'AM';
  $('#m-start').value = s.start || ''; $('#m-end').value = s.end || '';
  $('#m-venue').value = s.venue || ''; $('#m-coach').value = s.coach || ''; $('#m-week').value = s.weekKey || '';
  $('#m-aim0').value = (s.aims || [])[0] || ''; $('#m-aim1').value = (s.aims || [])[1] || '';
  renderGroupsEdit();
  $('#m-effsys').value = EFF_SYS; $('#scaleChart').innerHTML = scaleChartHTML();
  updateBarTitle();
}
function updateBarTitle(){ const s = S(); $('#barTitle').textContent = s ? displayTitle(s) + (s.slot ? ' · ' + s.slot : '') : ''; }

function stripHTML(t, slot){
  const used = t.time, scale = Math.max(slot || 0, used);
  if (!scale) return `<div class="strip" aria-hidden="true"></div>`;
  const segs = t.seq.map(x => `<span style="flex:${x.time} 0 0;background:${effBg(x.eff)}" title="${esc(x.label)}"></span>`).join('');
  const spare = slot && slot > used ? `<span class="spare" style="flex:${slot - used} 0 0" title="Time left in the session"></span>` : '';
  return `<div class="strip" role="img" aria-label="Effort across the session">${segs}${spare}</div>`;
}
function renderSummary(){
  const s = S(); const slot = slotSeconds(s);
  const tots = totalsFor(s);
  $('#summary').innerHTML = tots.map(t => {
    const a = avgEff(t);
    let pill = '';
    if (slot) {
      const spare = slot - Math.max(t.time, t.time2);
      pill = spare < 0 ? `<span class="pill bad">${fmtTime(-spare)} over</span>` : spare < 180 ? `<span class="pill warn">${fmtTime(spare)} spare</span>` : `<span class="pill ok">${fmtTime(spare)} spare</span>`;
    }
    const ends = s.start ? `finishes ${clockAdd(s.start, t.time)}` : '';
    const scale = Math.max(slot || 0, t.time);
    const hasG = (s.groups || []).length;
    return `<div class="panel gcard${hasG && curGroup === t.gid ? ' cur' : ''}"${hasG ? ` data-act="tab" data-gid="${t.gid}" role="button" tabindex="0"` : ''}>` +
      `<div class="gtop"><span class="gname">${esc(groupLabel(t.g))}</span><span class="gends">${ends}</span></div>` +
      `<div class="gbig"><span class="d">${fmtDist(t.dist)}<small>m</small></span><span class="t"><b>${fmtTime(t.time) || '0:00'}</b>${slot ? ' of ' + fmtTime(slot) : ''}</span></div>` +
      (t.time2 !== t.time ? `<div class="glane">2nd lane <b class="mono">${fmtTime(t.time2)}</b>${s.start ? ', finishes ' + clockAdd(s.start, t.time2) : ''}</div>` : '') +
      stripHTML(t, slot) +
      (scale ? `<div class="strip-scale"><span>${esc(s.start || '0:00')}</span><span>${s.start ? clockAdd(s.start, scale) : fmtTime(scale)}</span></div>` : '') +
      `<div class="gfoot">${pill}${a != null ? `<span>avg intensity <b class="mono">${esc(effAvgText(a))}</b></span>` : ''}</div>` +
      `</div>`;
  }).join('') +
  legendHTML();
}
function legendHTML(){
  const S = effSys();
  if (!S.zones) return `<div class="legend" style="grid-column:1/-1"><span>Effort /20</span><span class="mono">6</span><span class="ramp" style="background:linear-gradient(90deg,${[6, 9, 12, 14, 16, 18, 20].map(effColor).join(',')})"></span><span class="mono">20</span><span>· striped = mixed · fade = build</span></div>`;
  return `<div class="legend" style="grid-column:1/-1"><span>${esc(S.short)}</span>${S.zones.map(z => `<span class="zchip" style="background:${z.color || effColor(z.c)};color:${effInk({ mean: z.c })}">${esc(z.label)}</span>`).join('')}<span>· striped = mixed · fade = build</span></div>`;
}
function scaleChartHTML(){
  const lo = 6, hi = 22, span = hi - lo;
  const row = k => {
    const S = sysDef(k);
    const zs = S.zones || Array.from({ length: 16 }, (_, i) => Z(String(6 + i), 6 + i - 0.5, 6 + i + 0.5, 6 + i));
    const cells = zs.map(z => { const a = Math.max(lo, z.lo), b = Math.min(hi, z.hi); if (b <= a) return ''; const bg = z.color || (() => { const [h, s2, l] = effHSL(z.c); return `hsl(${h.toFixed(0)} ${s2.toFixed(0)}% ${l.toFixed(0)}%)`; })();
      const ink = lumOf(z.color ? hexRgb(z.color) : hslRgb(...effHSL(z.c))) < 0.55 ? '#fff' : '#15171A';
      return `<span style="flex:${b - a} 0 0;background:${bg};color:${ink}" title="${esc(z.label + (z.note ? ' · ' + z.note : ''))}">${S.zones || (6 + zs.indexOf(z)) % 2 === 0 ? esc(z.label) : ''}</span>`; }).join('');
    return `<div class="srow${k === EFF_SYS ? ' on' : ''}"><span class="sname">${esc(S.name)}</span><div class="sbar">${cells}</div></div>`;
  };
  return scaleList.map(s => row(s.key)).join('');
}
function refreshTotals(){
  const s = S(); const starts = blockStarts(s);
  s.blocks.forEach(b => {
    const bt = $(`[data-tot="${b.id}"]`); if (bt) bt.innerHTML = blockTotHTML(b, statsOf(b.items), starts.get(b.id));
    walk(b.items, n => {
      const el = $(`[data-tot="${n.id}"]`); if (el) el.innerHTML = totHTML(nodeStats(n), n);
      if (n.t === 'round') { const pl = $(`[data-pl="${n.id}"]`); if (pl) pl.textContent = n.times == 1 ? '' : 's'; }
      else {
        const d = $(`[data-dot="${n.id}"]`); if (d) d.setAttribute('style', dotStyle(parseEffort(n.eff)));
        const pp = $(`[data-parts="${n.id}"]`);
        if (pp && pp.classList.contains('edit')) { const pn = pp.querySelector('[data-pnote]'); if (pn) { const note = partsNote(n, pp.querySelectorAll('[data-part]').length); pn.textContent = note; pn.classList.toggle('warn', note.includes('parts for')); } }
        else if (pp) pp.innerHTML = partsHTML(n);
      }
    });
  });
  renderSummary(); updateBarTitle();
}

/* ---------- poolside ---------- */
const poolTiming = t => (t.int != null ? '@' + fmtTime(t.int) + (t.int2 != null && t.int2 !== t.int ? ' / ' + fmtTime(t.int2) : '') : (t.rest != null ? restLabel(t.rest) : ''));
function poolItems(items){
  // data-nid: tapping a set poolside notes something about it (when the app asks for that)
  const nid = n => `data-nid="${esc(n.id)}"`, nc = n => (noted.has(n.id) ? ' noted' : '');
  return (items || []).map(n => {
    if (n.t === 'round') return `<div class="pr"><div class="prl${nc(n)}" ${nid(n)}><span>${n.times || 1}× round${n.times == 1 ? '' : 's'}</span>${n.note ? `<em>${esc(n.note)}</em>` : ''}</div><div class="prb"><div class="rope" aria-hidden="true"></div><div>${poolItems(n.items)}</div></div></div>`;
    if (isTalkLine(n)) return `<div class="pl talk${nc(n)}" ${nid(n)}><span class="pq">Talk</span><span class="pd">${esc(plainDesc(n.desc))}</span><span class="pi">${esc(fmtTime(n.talk))}</span><span></span></div>`;
    if (isBlankLine(n)) return '';
    if (isNoteLine(n)) return `<div class="pl note${nc(n)}" ${nid(n)}><span class="pd">${esc(plainDesc(n.desc))}</span></div>`;
    const q = n.dist != null && n.dist !== '' ? ((n.reps && n.reps > 1) ? `${n.reps}×${n.dist}` : `${n.dist}`) : (n.reps && n.reps > 1 ? `${n.reps}×` : '');
    const e = parseEffort(n.eff), dp = partTimings(n);
    const parts = dp ? `<div class="pparts">${dp.parts.map(p => `<span><b>${p.n}</b>${esc(p.text)}${p.own && (p.own.int != null || p.own.rest != null) ? ` <em class="ptime">${esc(poolTiming(p.eff))}</em>` : ''}</span>`).join('')}</div>` : '';
    return `<div class="pl${dp ? ' has-parts' : ''}${nc(n)}" ${nid(n)}><span class="pq">${q}</span><span class="pd">${esc(dp ? dp.prefix : plainDesc(n.desc))}</span><span class="pi">${esc(poolTiming(lineTiming(n)))}</span>${n.eff ? `<span class="pe" style="background:${effBg(e)};color:${effInk(e)}">${esc(effFromCanon(n.eff))}</span>` : '<span></span>'}</div>` + parts;
  }).join('');
}
function renderPool(){
  const all = S(), s = sessionForGroup(all, curGroup || null), tots = totalsFor(s);
  const kick = [s.date ? new Date(s.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '', s.slot, s.start && s.end ? `${s.start}–${s.end}` : ''].filter(Boolean).join(' · ');
  const aims = (s.aims || []).filter(a => a && a.trim());
  $('#pool').innerHTML =
    ((all.groups || []).length ? `<nav class="gtabs" style="position:static">` + `<button type="button" data-act="tab" data-gid="" aria-pressed="${!curGroup}">All groups</button>` + all.groups.map(g => `<button type="button" data-act="tab" data-gid="${g.id}" aria-pressed="${curGroup === g.id}" style="--gc:${groupColor(all, g.id)}"><i></i>${esc(g.name)}</button>`).join('') + `</nav>` : '') +
    `<header class="phead"><div class="pkicker">${esc(kick)}${s._group ? ' · ' + esc(s._group) : ''}</div><h1>${esc(displayTitle(s))}</h1>` +
    `<div class="pmeta">${esc([s.venue, s.weekKey ? 'Week ' + s.weekKey : '', s.coach].filter(Boolean).join(' · '))}</div>` +
    (aims.length ? `<ul class="paims">${aims.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '') + `</header>` +
    `<div class="ptots">${tots.map(t => `<div><span>${esc(groupLabel(t.g))}</span><b>${fmtDist(t.dist)} m</b><em>${timeText(t)}</em></div>`).join('')}</div>` +
    `<div class="prun">` + s.blocks.map(b => {
      const st = statsOf(b.items), gn = s._group ? [] : blockGroupNames(all, b);
      if (b.kind === 'notes') return hasNoteText(b) ? `<section class="pblock pnotes"><div class="pbh"><h2>${esc(b.name || 'Notes')}</h2>${gn.length ? `<span class="pchips">${gn.map(x => `<span class="pchip">${esc(x)}</span>`).join('')}</span>` : ''}</div><div class="pnote">${esc(String(b.text).trim())}</div></section>` : '';
      return `<section class="pblock"><div class="pbh"><h2>${esc(b.name || 'Block')}</h2>${gn.length ? `<span class="pchips">${gn.map(n => `<span class="pchip">${esc(n)}</span>`).join('')}</span>` : ''}<span class="ptot">${fmtDist(st.dist)} m · ${timeText(st)}</span></div>${poolItems(b.items) || '<div class="pl"><span class="pd" style="color:var(--muted)">No sets yet</span></div>'}</section>`;
    }).join('') + `</div>`;
}
async function setView(v){
  view = v;
  if (opts.onView) opts.onView(v);
  $('#vEdit').setAttribute('aria-pressed', v === 'edit'); $('#vPool').setAttribute('aria-pressed', v === 'pool');
  $('#editor').hidden = v !== 'edit'; $('#pool').hidden = v !== 'pool';
  if (v === 'pool') {
    renderPool(); window.scrollTo(0, 0);
    try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { wakeLock = null; }
  } else {
    if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
}

/* ---------- drag & drop ---------- */
function initSortables(){
  $$('#blocks .items[data-parent]').forEach(el => {
    sortables.push(Sortable.create(el, {
      group: 'sets', handle: '.grip', draggable: '.node', animation: 140, forceFallback: true, fallbackOnBody: true, delay: 220, touchStartThreshold: 5,
      swapThreshold: 0.6, emptyInsertThreshold: 18, fallbackTolerance: 4, ghostClass: 'ghost', chosenClass: 'chosen',
      onStart(){ dragging = true; sweep = null; closeMenu(); },
      onEnd(evt){
        if (dragging) lastDragEnd = Date.now(); dragging = false;
        const id = evt.item.dataset.id, to = evt.to.dataset.parent;
        const idx = evt.newDraggableIndex ?? evt.newIndex;
        if (evt.from === evt.to && (evt.oldDraggableIndex ?? evt.oldIndex) === idx) return;
        setTimeout(() => moveNode(id, to, idx), 0);
      }
    }));
  });
  sortables.push(Sortable.create($('#blocks'), {
    handle: '.bgrip', draggable: '.block', animation: 140, forceFallback: true, fallbackTolerance: 4, ghostClass: 'ghost',
    onEnd(evt){
      if (evt.oldIndex === evt.newIndex) return;
      setTimeout(() => {
        pushUndo();
        const ids = $$('#blocks > .block').map(el => el.dataset.id), vis = new Set(ids), byId = new Map(S().blocks.map(b => [b.id, b]));
        const slots = S().blocks.map((b, i) => (vis.has(b.id) ? i : -1)).filter(i => i >= 0), nb = S().blocks.slice();
        slots.forEach((slot, k) => { nb[slot] = byId.get(ids[k]); }); S().blocks = nb;
        renderBlocks(); markDirty();
      }, 0);
    }
  }));
}
function moveNode(id, toParent, index){
  const l = locate(id), target = locate(toParent);
  if (!l || !target || toParent === id || (l.node.t === 'round' && contains(l.node, toParent))) { renderBlocks(); return; }
  pushUndo();
  l.arr.splice(l.index, 1);
  target.node.items.splice(clamp(index, 0, target.node.items.length), 0, l.node);
  renderBlocks(); markDirty();
}

/* ---------- operations ---------- */
function pushUndo(){ undoStack.push(JSON.stringify({ blocks: S().blocks, groups: S().groups || [] })); if (undoStack.length > 40) undoStack.shift(); }
function undo(){
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  const u = JSON.parse(undoStack.pop()); S().blocks = u.blocks; S().groups = u.groups; sel.clear(); renderGroupsEdit(); renderBlocks(); refreshTotals(); markDirty(); toast('Undone');
}
// Enter: jump to the next empty cell to the right (lane 2 and the heading are optional, so they're skipped)
function enterNext(id, from){
  const keys = ['reps', 'dist', 'desc', 'int', 'int2', 'eff'];
  for (let k = keys.indexOf(from) + 1; k > 0 && k < keys.length; k++) {
    const el = document.getElementById(`f-${id}-${keys[k]}`); if (!el) continue;
    if (keys[k] === 'int2') { const l = locate(id); if (!l || timingMode(l.node) !== 'rest' || l.node.est != null) continue; }
    if (keys[k] === 'desc' && el.dataset.prefix) continue;
    if (!el.value.trim()) { el.focus(); return true; }
  }
  return false;
}
function addLineAfter(id){
  const l = locate(id); if (!l) return;
  pushUndo(); const n = newLine(); l.arr.splice(l.index + 1, 0, n);
  renderBlocks({ id: `f-${n.id}-reps` }); markDirty();
}
function opIndent(id){
  const l = locate(id); if (!l || l.kind === 'block') return;
  const prev = l.arr[l.index - 1];
  if (!prev || prev.t !== 'round') { toast('To indent a set, it needs a round directly above it. Or use Wrap in round.'); return; }
  pushUndo(); l.arr.splice(l.index, 1); prev.items.push(l.node); renderBlocks(); markDirty();
}
function opOutdent(id){
  const l = locate(id); if (!l || l.kind === 'block') return;
  if (!l.parent || l.parent.t !== 'round') { toast('This set is already at the top level of its block.'); return; }
  const pl = locate(l.parent.id);
  pushUndo(); l.arr.splice(l.index, 1); pl.arr.splice(pl.index + 1, 0, l.node); renderBlocks(); markDirty();
}
function opMove(id, dir){
  const l = locate(id); if (!l) return;
  if (l.kind === 'block') {
    const vis = visibleBlocks(), k = vis.indexOf(l.node), other = vis[k + dir]; if (!other) return;
    const a = S().blocks.indexOf(l.node), b = S().blocks.indexOf(other);
    pushUndo(); [S().blocks[a], S().blocks[b]] = [S().blocks[b], S().blocks[a]]; renderBlocks(); markDirty(); return;
  }
  const j = l.index + dir; if (j < 0 || j >= l.arr.length) return;
  pushUndo(); [l.arr[l.index], l.arr[j]] = [l.arr[j], l.arr[l.index]]; renderBlocks(); markDirty();
}
function opWrap(ids, times){
  const locs = ids.map(locate).filter(Boolean);
  if (!locs.length) return;
  const arr = locs[0].arr;
  if (locs.some(x => x.arr !== arr || x.kind === 'block')) { toast('Pick sets from the same level to wrap them together.'); return; }
  locs.sort((a, b) => a.index - b.index);
  pushUndo();
  const nodes = locs.map(x => x.node), first = locs[0].index;
  for (let i = locs.length - 1; i >= 0; i--) arr.splice(locs[i].index, 1);
  const r = newRound(times, nodes); arr.splice(first, 0, r);
  sel.clear(); renderBlocks({ id: `f-${r.id}-note`, noScroll: true }); markDirty();
  toast(`${nodes.length} set${nodes.length > 1 ? 's' : ''} now ${times}× round${times > 1 ? 's' : ''}`);
}
function opUnwrap(id){ const l = locate(id); if (!l || l.node.t !== 'round') return; pushUndo(); l.arr.splice(l.index, 1, ...l.node.items); renderBlocks(); markDirty(); }
function opDup(id){ const l = locate(id); if (!l) return; pushUndo(); const c = cloneWithNewIds(l.node); if (l.kind === 'block') c.name = (c.name || 'Block') + ' copy'; l.arr.splice(l.index + 1, 0, c); renderBlocks(); markDirty(); }
function opDel(id){
  const l = locate(id); if (!l) return;
  pushUndo(); l.arr.splice(l.index, 1); sel.delete(id); textMode.delete(id); renderBlocks(); markDirty();
  const what = l.kind === 'block' ? `block “${l.node.name || 'Block'}”` : l.node.t === 'round' ? `${l.node.times}× round` : isTalkLine(l.node) ? 'talk' : 'set';
  toast(`Deleted ${what}`, 'Undo', undo);
}
function addFromQuick(parentId, text){
  const target = locate(parentId); if (!target) return;
  if (!text.includes('\n')) text = normalizeDictation(text, looksSpoken(text));
  if (!text.includes('\n') && PART_LINE.test(text)) {
    const lastLine = [...target.node.items].reverse().find(n => n.t === 'line' && !isTalkLine(n));
    if (lastLine) { pushUndo(); addPart(lastLine, text); renderBlocks({ id: `q-${parentId}` }); markDirty(); return; }
  }
  const nodes = text.includes('\n') ? parseText(text) : parseLineNodes(text);
  if (!nodes.length) return;
  pushUndo(); target.node.items.push(...nodes);
  const lastRound = !text.includes('\n') && nodes.length === 1 && nodes[0].t === 'round' && !nodes[0].items.length ? nodes[0] : null;
  renderBlocks({ id: `q-${lastRound ? lastRound.id : parentId}` }); markDirty();
}

/* ---------- menu ---------- */
const pop = $('#pop');
function openMenu(btn, id){
  const l = locate(id); if (!l) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform); const mod = mac ? '⌘' : 'Ctrl';
  let html = '';
  if (l.kind === 'block') {
    const s = S(), gs = s.groups || [], vis = visibleBlocks(), vi = vis.indexOf(l.node);
    const shared = !l.node.groups.length || l.node.groups.length > 1;
    const fork = curGroup && shared ? `<button data-op="fork">Make a separate copy for ${esc(groupName(s, curGroup))}</button>` : '';
    const copies = gs.length ? gs.map(g => `<button data-op="copyto" data-gid="${g.id}">Copy for ${esc(g.name)}</button>`).join('') + '<hr>' : '';
    const isN = l.node.kind === 'notes', what = isN ? 'notes' : 'block';
    html = (isN ? '' : `<button data-op="btext">${textMode.has(id) ? 'Back to rows' : 'Edit as text'}</button>`) +
      `<button data-op="up" ${vi <= 0 ? 'disabled' : ''}>Move ${what} up</button>` +
      `<button data-op="down" ${vi === vis.length - 1 ? 'disabled' : ''}>Move ${what} down</button>` +
      `<button data-op="dup">Duplicate ${what}</button>` + (isN ? '' : `<button data-op="talk-start">Talk at the start</button><button data-op="notes-after">Add notes below</button>`) + `<hr>` + fork + copies + `<button data-op="del" class="danger">Delete ${what}</button>`;
  } else {
    const prev = l.arr[l.index - 1];
    const canIn = prev && prev.t === 'round', canOut = l.parent && l.parent.t === 'round';
    html = (isTalkLine(l.node) ? '' : `<button data-op="talk-before">Talk before this ${l.node.t === 'round' ? 'round' : 'set'}</button><hr>`) +
      `<button data-op="wrap" data-times="2">Wrap in 2× round</button><button data-op="wrap" data-times="3">Wrap in 3× round</button>` +
      `<button data-op="indent" ${canIn ? '' : 'disabled'}>Into round above <kbd>${mod} ]</kbd></button>` +
      `<button data-op="outdent" ${canOut ? '' : 'disabled'}>Out of this round <kbd>${mod} [</kbd></button>` +
      (l.node.t === 'round' ? `<button data-op="unwrap">Remove round, keep sets</button>` : '') + `<hr>` +
      `<button data-op="up" ${l.index === 0 ? 'disabled' : ''}>Move up <kbd>Alt ↑</kbd></button>` +
      `<button data-op="down" ${l.index === l.arr.length - 1 ? 'disabled' : ''}>Move down <kbd>Alt ↓</kbd></button>` +
      `<button data-op="dup">Duplicate <kbd>${mod} D</kbd></button><hr>` +
      `<button data-op="del" class="danger">${l.node.t === 'round' ? 'Delete round and its sets' : isTalkLine(l.node) ? 'Delete talk' : 'Delete set'}</button>`;
  }
  pop.innerHTML = html; pop.dataset.for = id; pop.hidden = false;
  const r = btn.getBoundingClientRect(); const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let top = r.bottom + 4; if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  pop.style.top = top + 'px'; pop.style.left = clamp(r.right - pw, 8, window.innerWidth - pw - 8) + 'px';
  const first = pop.querySelector('button:not(:disabled)'); if (first) first.focus();
}
function closeMenu(){ pop.hidden = true; }
pop.addEventListener('click', e => {
  const pb = e.target.closest('button[data-pdf]');
  if (pb) { closeMenu(); const v = pb.dataset.pdf; if (v === 'zip') exportAllPdfs(); else exportPdf(v || null); return; }
  const b = e.target.closest('button[data-op]'); if (!b || b.disabled) return;
  const id = pop.dataset.for, op = b.dataset.op; closeMenu();
  const l = locate(id); if (!l) return;
  if (op === 'btext') { if (textMode.has(id)) textMode.delete(id); else textMode.add(id); renderBlocks(textMode.has(id) ? { id: 't-' + id } : null); return; }
  if (op === 'up') return opMove(id, -1);
  if (op === 'down') return opMove(id, 1);
  if (op === 'dup') return opDup(id);
  if (op === 'del') return opDel(id);
  if (op === 'wrap') return opWrap([id], +b.dataset.times);
  if (op === 'indent') return opIndent(id);
  if (op === 'outdent') return opOutdent(id);
  if (op === 'unwrap') return opUnwrap(id);
  if (op === 'copyto') return opCopyTo(id, b.dataset.gid);
  if (op === 'notes-after') { pushUndo(); const nb = newNotes(curGroup ? [curGroup] : (l.node.groups || [])); l.arr.splice(l.index + 1, 0, nb); renderBlocks({ id: `f-${nb.id}-text` }); markDirty(); return; }
  if (op === 'fork') return opFork(id, curGroup);
  if (op === 'talk-before') return addTalk(l.arr, l.index);
  if (op === 'talk-start') return addTalk(l.node.items, 0);
});
// a talk goes in just before the set it explains; the note gets the cursor
function addTalk(arr, index){
  pushUndo(); const n = newLine({ talk: TALK_DEFAULT }); arr.splice(index, 0, n);
  renderBlocks({ id: `f-${n.id}-desc` }); markDirty();
}
pop.addEventListener('change', e => {
  const t = e.target; if (!t.dataset.gtoggle && t.dataset.gtoggle !== '') return;
  const l = locate(t.dataset.block); if (!l) return;
  pushUndo();
  const g = t.dataset.gtoggle, all = (S().groups || []).map(x => x.id);
  if (g === '') l.node.groups = [];
  else {
    let cur = l.node.groups.length ? l.node.groups.slice() : all.slice();
    cur = t.checked ? [...new Set([...cur, g])] : cur.filter(x => x !== g);
    if (!cur.length) { toast('A block needs at least one group. Use Delete block to remove it.'); t.checked = true; undoStack.pop(); return; }
    l.node.groups = all.filter(x => cur.includes(x));
  }
  renderBlocks(); refreshTotals(); markDirty();
  openGroupPicker(null, l.node.id);
});
function openGroupPicker(btn, id){
  const s = S(), l = locate(id); if (!l) return;
  const ids = l.node.groups, all = !ids.length;
  pop.innerHTML = `<div class="phead">Who swims this block?</div>` +
    `<label><input type="checkbox" data-gtoggle="" data-block="${id}" ${all ? 'checked' : ''}>All groups</label><hr>` +
    (s.groups || []).map(g => `<label style="--gc:${groupColor(s, g.id)}"><input type="checkbox" data-gtoggle="${g.id}" data-block="${id}" ${all || ids.includes(g.id) ? 'checked' : ''}><i></i>${esc(g.name)}</label>`).join('');
  pop.dataset.for = id; pop.hidden = false;
  if (btn) {
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + 4; if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    pop.style.top = top + 'px'; pop.style.left = clamp(r.left, 8, window.innerWidth - pw - 8) + 'px';
  }
}
function opCopyTo(id, gid){
  const l = locate(id); if (!l || l.kind !== 'block') return;
  pushUndo(); const c = cloneWithNewIds(l.node); c.groups = [gid]; l.arr.splice(l.index + 1, 0, c);
  renderBlocks(); refreshTotals(); markDirty(); toast(`Copied for ${groupName(S(), gid)}. It’s now separate from the original.`);
}
function opFork(id, gid){
  const l = locate(id); if (!l || l.kind !== 'block' || !gid) return;
  const all = (S().groups || []).map(x => x.id);
  pushUndo();
  const c = cloneWithNewIds(l.node); c.groups = [gid];
  l.node.groups = (l.node.groups.length ? l.node.groups : all).filter(x => x !== gid);
  l.arr.splice(l.index + 1, 0, c);
  renderBlocks(); refreshTotals(); markDirty(); toast(`${groupName(S(), gid)} now has its own copy. Changes to it won’t affect the other groups.`);
}
function addGroup(){
  const s = S(); s.groups = s.groups || [];
  pushUndo(); const g = { id: 'g' + uid(), name: `Group ${s.groups.length + 1}` }; s.groups.push(g);
  renderGroupsEdit(); renderBlocks(); refreshTotals(); markDirty();
  const el = $(`#g-${g.id}`); if (el) { el.focus(); el.select(); }
}
function deleteGroup(gid){
  const s = S(), name = groupName(s, gid);
  pushUndo();
  const before = s.blocks.length;
  s.blocks = s.blocks.filter(b => !(b.groups.length === 1 && b.groups[0] === gid));
  s.blocks.forEach(b => { if (b.groups.length) b.groups = b.groups.filter(x => x !== gid); });
  s.groups = s.groups.filter(g => g.id !== gid);
  if (curGroup === gid) curGroup = '';
  renderGroupsEdit(); renderBlocks(); refreshTotals(); markDirty();
  const gone = before - s.blocks.length;
  toast(`Removed ${name}${gone ? ` and its ${gone} block${gone > 1 ? 's' : ''}` : ''}`, 'Undo', undo);
}
document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-act="menu"],[data-act="gpick"],[data-act="pdf"]')) closeMenu(); });
window.addEventListener('scroll', () => { if (!pop.hidden) closeMenu(); }, { passive: true });

/* ---------- selection bar ---------- */
function renderSelbar(){
  const bar = $('#selbar');
  for (const id of [...sel]) if (!locate(id)) sel.delete(id);
  if (!sel.size) { bar.hidden = true; return; }
  bar.innerHTML = `<span class="lbl">${sel.size} selected</span><span>Wrap as</span>` + [2, 3, 4].map(t => `<button class="hot" type="button" data-act="wrap-sel" data-times="${t}">${t}×</button>`).join('') +
    `<label class="seln"><input id="selN" inputmode="numeric" placeholder="n" aria-label="Number of rounds" autocomplete="off">×</label>` +
    `<span class="hint">or press 2–9</span><button type="button" data-act="del-sel">Delete</button><button type="button" data-act="clear-sel">Clear</button>`;
  bar.hidden = false;
}
let lastSel = null, sweep = null;
function paintSel(){
  $$('#blocks .node[data-id]').forEach(el => {
    const on = sel.has(el.dataset.id); el.classList.toggle('sel', on);
    const g = el.querySelector(':scope > .grip, :scope > .round-head > .grip'); if (g) g.setAttribute('aria-pressed', on);
  });
  renderSelbar();
}
function toggleSel(id, range){
  if (range && lastSel && lastSel !== id) {
    const a = locate(lastSel), b = locate(id);
    if (a && b && a.arr === b.arr) { const i = Math.min(a.index, b.index), j = Math.max(a.index, b.index); for (let k = i; k <= j; k++) sel.add(a.arr[k].id); lastSel = id; paintSel(); return; }
  }
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  lastSel = id; paintSel();
}
// Swipe down the grip dots to select a run of sets at one level (hold still first to drag instead).
document.addEventListener('pointerdown', e => {
  const g = e.target.closest && e.target.closest('#blocks .node > .grip, #blocks .round-head > .grip');
  if (!g || e.button > 0 || e.shiftKey) { sweep = null; return; }
  const l = locate(g.closest('.node[data-id]').dataset.id); if (!l) return;
  sweep = { arr: l.arr, startIdx: l.index, moved: false, before: new Set(sel) };
});
document.addEventListener('pointermove', e => {
  if (!sweep || dragging) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const host = el && el.closest && el.closest('#blocks .node[data-id]'); if (!host) return;
  let l = locate(host.dataset.id);
  while (l && l.arr !== sweep.arr && l.parent && l.parent.t === 'round') l = locate(l.parent.id);
  if (!l || l.arr !== sweep.arr || (l.index === sweep.startIdx && !sweep.moved)) return;
  sweep.moved = true;
  const i = Math.min(sweep.startIdx, l.index), j = Math.max(sweep.startIdx, l.index);
  sel.clear(); sweep.before.forEach(x => sel.add(x));
  for (let k = i; k <= j; k++) sel.add(sweep.arr[k].id);
  lastSel = sweep.arr[l.index].id; paintSel();
});
document.addEventListener('pointerup', () => { if (sweep && sweep.moved) lastDragEnd = Date.now(); sweep = null; });
document.addEventListener('pointercancel', () => { sweep = null; });

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, actionLabel, action){
  const t = $('#toast'); if (!t) return;   // the builder has been closed
  t.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button type="button" id="toastAct">${esc(actionLabel)}</button>` : '');
  t.hidden = false;
  if (actionLabel) $('#toastAct').onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 3200);
}

/* ---------- events ---------- */
document.addEventListener('input', e => {
  const t = e.target; if (!S()) return;
  if (t.dataset.gname) {
    const g = (S().groups || []).find(x => x.id === t.dataset.gname); if (!g) return;
    g.name = t.value; t.size = Math.max(5, t.value.length + 1);
    renderTabs(); renderBlocks(); refreshTotals(); markDirty(); return;
  }
  if (t.dataset.meta) {
    const k = t.dataset.meta, s = S();
    if (k === 'effSys') { s.effSys = t.value; setEffSys(t.value); renderBlocks(); $('#scaleChart').innerHTML = scaleChartHTML(); if (view === 'pool') renderPool(); markDirty(); return; }
    if (k === 'aim0' || k === 'aim1') { s.aims = s.aims || ['', '']; s.aims[+k.slice(3)] = t.value; }
    else s[k] = t.value;
    if (k === 'date') $('#m-title').placeholder = displayTitle({ ...s, title: '' });
    refreshTotals(); markDirty(); return;
  }
  if (t.dataset.part || t.dataset.ptime) {
    const id = t.dataset.part || t.dataset.ptime, l = locate(id); if (!l) return;
    if (t.dataset.ptime) t.classList.toggle('bad', parseTimingCell(t.value) === null);
    const el = $(`#f-${id}-desc`);
    l.node.desc = buildDesc(el && el.dataset.prefix ? el.value : '', partTexts(id));
    refreshTotals(); markDirty(); return;
  }
  if (t.classList.contains('ntext')) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }
  const f = t.dataset.f; if (!f) return;
  const host = t.closest('[data-id]'); if (!host) return;
  const l = locate(host.dataset.id); if (!l) return;
  const n = l.node;
  if (f === 'reps' || f === 'dist' || f === 'times') { const v = parseInt(t.value, 10); n[f] = isNaN(v) ? null : v; }
  else if (f === 'int') { const tm = parseTimingCell(t.value); t.classList.toggle('bad', tm === null); if (tm) Object.assign(n, tm); }
  else if (f === 'est') { n.est = t.value.trim() ? parseTime(t.value) : null; t.classList.toggle('bad', !!t.value.trim() && n.est == null); t.classList.toggle('need', n.est == null && !!n.dist); }
  else if (f === 'int2') { n[f] = parseTime(t.value); t.classList.toggle('bad', !!t.value.trim() && n[f] == null); }
  else if (f === 'eff') n.eff = effToCanon(t.value);
  else if (f === 'talk') { const v = parseTalkTime(t.value); t.classList.toggle('bad', v == null); if (v != null) n.talk = v; }
  else if (f === 'desc' && t.dataset.prefix) n.desc = buildDesc(t.value, partTexts(n.id));
  else n[f] = t.value;
  refreshTotals(); markDirty();
});
document.addEventListener('focusout', e => {
  const t = e.target;
  if (t.dataset && t.dataset.part) {
    const box = t.closest('.parts'), rel = e.relatedTarget;
    if (!(rel && box && box.contains(rel))) { const id = t.dataset.part; setTimeout(() => cleanParts(id), 0); }
  }
  if (t.dataset && t.dataset.f === 'desc' && !t.dataset.prefix) {
    const host = t.closest('.node[data-id]'), rel = e.relatedTarget, l = host && locate(host.dataset.id);
    if (l && !(rel && host.contains(rel)) && descParts(l.node.desc, 1, true)) setTimeout(() => repaintLine(l.node.id), 0);
  }
  if (t.dataset && t.dataset.f === 'eff') { const host = t.closest('[data-id]'); const l = host && locate(host.dataset.id); if (l) t.value = effFromCanon(l.node.eff); }
  // a talk's time shows as m:ss once you leave it; a time that couldn't be read goes back to the last good one
  if (t.dataset && t.dataset.f === 'talk') { const host = t.closest('[data-id]'); const l = host && locate(host.dataset.id); if (l) { t.value = fmtTime(l.node.talk); t.classList.remove('bad'); } }
  if (t.dataset && (t.dataset.f === 'int' || t.dataset.f === 'int2' || t.dataset.f === 'est')) {
    const f = t.dataset.f, host = t.closest('.node[data-id]'), l = host && locate(host.dataset.id);
    if (l) {
      const n = l.node, md = timingMode(n), ok = !t.classList.contains('bad');
      if (ok) t.value = f === 'int' ? (md === 'send' ? fmtTime(n.int) : (n.rest != null ? 'r' + restShort(n.rest) : '')) : (n[f] != null ? fmtTime(n[f]) : '');
      const c2 = $(`#f-${n.id}-int2`), want = md === 'rest' ? 'est' : 'int2', rel = e.relatedTarget;
      const stale = (c2 && c2.dataset.f !== want) || (f === 'int' && n.int2 != null && c2 && c2.dataset.f === 'int2' && c2.value !== fmtTime(n.int2)) || !!host.querySelector('[data-ptime]');
      if (stale && !(rel && rel.tagName === 'BUTTON' && host.contains(rel))) setTimeout(() => repaintLine(n.id), 0);
    }
  }
  if (t.dataset && t.dataset.ptime) { const tm = parseTimingCell(t.value); if (tm) { t.value = cellText(tm); t.classList.remove('bad'); } }
});
document.addEventListener('keydown', e => {
  const t = e.target; const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { if (!pop.hidden) { closeMenu(); return; } if (!$('#textModal').hidden) { $('#textModal').hidden = true; return; } if (sel.size) { sel.clear(); renderBlocks(); return; } }
  if (t.id === 'selN' && e.key === 'Enter') { e.preventDefault(); const n = parseInt(t.value, 10); if (n > 0) opWrap([...sel], n); return; }
  if (sel.size && !mod && !e.altKey && !(t.matches && t.matches('input,textarea,select'))) {
    if (/^[2-9]$/.test(e.key)) { e.preventDefault(); opWrap([...sel], +e.key); return; }
    if (e.key === 'Delete') { e.preventDefault(); $('[data-act="del-sel"]').click(); return; }
  }
  if (t.dataset && t.dataset.text && e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    const v = t.value, pos = t.selectionStart, ls = v.lastIndexOf('\n', pos - 1) + 1, le = v.indexOf('\n', pos), line = v.slice(ls, le < 0 ? v.length : le);
    const ind = line.match(/^ */)[0], pm = line.match(/^\s*(\d{1,2})\)/);
    let ins;
    if (pm) ins = `\n${ind}${+pm[1] + 1}) `;
    else { const ns = line.trim() ? parseLineNodes(line) : []; ins = ns.length === 1 && ns[0].t === 'round' && !ns[0].items.length ? `\n${ind}  ` : `\n${ind}${line.trim() ? '1) ' : ''}`; }
    t.setRangeText(ins, pos, t.selectionEnd, 'end');
    return;
  }
  if (t.dataset && t.dataset.quick && micOn && micTarget === t.dataset.quick && t.classList.contains('hearing')) { t.classList.remove('hearing'); }
  if (t.dataset && t.dataset.quick) {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      const pid = t.dataset.quick, v = t.value.trim();
      if (!v || /^\d{1,2}\)$/.test(v)) return;
      addFromQuick(pid, v);
      const tgt = locate(pid), lastItem = tgt && tgt.node.items[tgt.node.items.length - 1], q = $(`#q-${pid}`);
      if (q && lastItem && lastItem.t === 'line' && document.activeElement === q) { const pe = descParts(lastItem.desc, 1, true); q.value = `${(pe ? pe.parts.length : 0) + 1}) `; q.setSelectionRange(q.value.length, q.value.length); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); const v = t.value.trim(); if (/^\d{1,2}\)$/.test(v)) { t.value = ''; return; } if (v) addFromQuick(t.dataset.quick, v); return; }
    if ((e.key === 'Backspace' && !t.value) || e.key === 'Escape') {
      const l = locate(t.dataset.quick);
      if (l && l.parent) { e.preventDefault(); const up = $(`#q-${l.parent.id}`); if (up) up.focus(); }
      return;
    }
    return;
  }
  if (t.dataset && t.dataset.ptime) {
    const id = t.dataset.ptime, i = +t.dataset.pi;
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); startOrAddPart(id, i); return; }
    if (e.key === 'Enter' && !mod && !e.altKey) { e.preventDefault(); if (!enterNext(id, 'desc')) addLineAfter(id); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) { const el = $(`#pt-${id}-${i + (e.key === 'ArrowUp' ? -1 : 1)}`); if (el) { e.preventDefault(); el.focus(); } return; }
    return;
  }
  if (t.dataset && t.dataset.part) {
    const id = t.dataset.part, i = +t.dataset.pi;
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); startOrAddPart(id, i); return; }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      if (!t.value.trim()) { const cp = currentParts(id), l = locate(id); if (cp && l) { cp.texts.splice(i, 1); l.node.desc = cp.texts.length ? buildDesc(cp.prefix, cp.texts) : String(cp.prefix || '').trim(); repaintLine(id); } }
      if (!enterNext(id, 'desc')) addLineAfter(id);
      return;
    }
    if (e.key === 'Backspace' && !t.value && t.selectionStart === 0) { e.preventDefault(); removePart(id, i); return; }
    if (e.key === 'ArrowUp' && !e.altKey) { const el = i > 0 ? $(`#p-${id}-${i - 1}`) : $(`#f-${id}-desc`); if (el) { e.preventDefault(); el.focus(); } return; }
    if (e.key === 'ArrowDown' && !e.altKey) { const el = $(`#p-${id}-${i + 1}`); if (el) { e.preventDefault(); el.focus(); } return; }
    return;
  }
  const host = t.closest && t.closest('.node[data-id]');
  if (host && t.dataset.f) {
    const id = host.dataset.id;
    if (e.key === 'Enter' && e.shiftKey && !mod && !e.altKey) { e.preventDefault(); const l = locate(id); if (l && l.node.t === 'round') { const q = $(`#q-${id}`); if (q) q.focus(); } else startOrAddPart(id); return; }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const l = locate(id);
      if (l && l.node.t === 'round') { const q = $(`#q-${id}`); if (q) q.focus(); }
      else if (!enterNext(id, t.dataset.f === 'est' ? 'int2' : t.dataset.f)) addLineAfter(id);
      return;
    }
    if (mod && e.key === ']') { e.preventDefault(); opIndent(id); return; }
    if (mod && e.key === '[') { e.preventDefault(); opOutdent(id); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); opDup(id); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); opMove(id, e.key === 'ArrowUp' ? -1 : 1); return; }
  }
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !(t.matches && t.matches('input,textarea,select'))) { e.preventDefault(); undo(); }
});
document.addEventListener('paste', e => {
  const t = e.target; if (!t.dataset || !t.dataset.quick) return;
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (text.includes('\n')) { e.preventDefault(); addFromQuick(t.dataset.quick, text); }
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || !S()) return;
  const act = b.dataset.act;
  if (act === 'sel') { if (Date.now() - lastDragEnd < 300) return; const host = b.closest('.node[data-id]'); if (host) toggleSel(host.dataset.id, e.shiftKey); return; }
  if (act === 'menu') { const id = b.dataset.for; if (!pop.hidden && pop.dataset.for === id) closeMenu(); else openMenu(b, id); return; }
  if (act === 'wrap-sel') return opWrap([...sel], +b.dataset.times);
  if (act === 'del-sel') { const ids = [...sel]; pushUndo(); ids.forEach(id => { const l = locate(id); if (l) l.arr.splice(l.arr.indexOf(l.node), 1); }); sel.clear(); renderBlocks(); markDirty(); toast(`Deleted ${ids.length}`, 'Undo', undo); return; }
  if (act === 'clear-sel') { sel.clear(); renderBlocks(); return; }
  if (act === 'tab') { curGroup = b.dataset.gid || ''; sel.clear(); renderBlocks(); refreshTotals(); if (view === 'pool') renderPool(); return; }
  if (act === 'add-group') return addGroup();
  if (act === 'del-group') return deleteGroup(b.dataset.gid);
  if (act === 'who') { if (opts.onWho) opts.onWho(b.dataset.gid); return; }
  if (act === 'gpick') { if (!pop.hidden && pop.dataset.for === b.dataset.for) closeMenu(); else openGroupPicker(b, b.dataset.for); return; }
  if (act === 'mic') { micToggle(b.dataset.for); return; }
  if (act === 'add-notes') { pushUndo(); const nb = newNotes(curGroup ? [curGroup] : []); S().blocks.push(nb); renderBlocks({ id: `f-${nb.id}-text` }); markDirty(); toast('Notes added. Drag the dots beside the heading to move them.'); return; }
  if (act === 'add-block') { pushUndo(); const nb = newBlock('New block', curGroup ? [curGroup] : []); S().blocks.push(nb); renderBlocks({ id: `f-${nb.id}-name` }); const el = $(`#f-${nb.id}-name`); if (el) el.select(); markDirty(); return; }
  if (act === 'apply-text') { const id = b.dataset.for; const l = locate(id); const ta = $(`#t-${id}`); if (l && ta) { pushUndo(); l.node.items = parseText(ta.value); textMode.delete(id); renderBlocks(); markDirty(); toast('Block updated from text', 'Undo', undo); } return; }
  if (act === 'cancel-text') { textMode.delete(b.dataset.for); renderBlocks(); return; }
  if (act === 'view') return setView(b.dataset.v);
  if (act === 'copy') return copyText();
  if (act === 'pdf') return pdfMenu(b);
  if (act === 'close-modal') { $('#textModal').hidden = true; return; }
  if (act === 'copy-week') { flushNow(); if (opts.copyNextWeek) opts.copyNextWeek(); return; }
});

/* ---------- copy / export ---------- */
function copyText(){
  const text = sessionText(sessionForGroup(S(), curGroup || null));
  const fallback = () => { $('#textOut').value = text; $('#textModal').hidden = false; const ta = $('#textOut'); ta.focus(); ta.select(); };
  try {
    const p = navigator.clipboard && navigator.clipboard.writeText(text);
    if (p) p.then(() => toast('Session copied as text'), fallback); else fallback();
  } catch (e) { fallback(); }
}
/* ---------- speaking sets (Chrome, in the offline copy) ---------- */
const MIC_PH = 'Listening… “4 by 50 on 1 10”, “line 2 build”, “undo”, “stop”';
let rec = null, micOn = false, micTarget = null, micIdle = null;
const speechOK = () => STANDALONE && !!(window.SpeechRecognition || window.webkitSpeechRecognition) && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
function repaintMic(){
  $$('.mic').forEach(b => { const on = micOn && b.dataset.for === micTarget; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', on ? 'Stop listening' : 'Speak sets into this block'); });
  $$('.qin').forEach(q => { const on = micOn && q.dataset.quick === micTarget; q.placeholder = on ? MIC_PH : (q.dataset.ph || ''); if (!on && q.classList.contains('hearing')) { q.value = ''; q.classList.remove('hearing'); } });
}
function bumpIdle(){ clearTimeout(micIdle); micIdle = setTimeout(() => { if (micOn) { micStop(); toast('Stopped listening after a quiet spell. Tap the mic to carry on.'); } }, 90000); }
function micStop(){
  micOn = false; clearTimeout(micIdle);
  if (rec) { rec.onend = null; try { rec.stop(); } catch (e) {} }
  rec = null; repaintMic();
}
function micStart(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
  rec = new SR(); rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  rec.onresult = ev => {
    bumpIdle(); let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i], tx = (r[0] && r[0].transcript || '').trim();
      if (r.isFinal) handleSpoken(tx); else interim += (interim ? ' ' : '') + tx;
    }
    const q = micTarget && $(`#q-${micTarget}`);
    if (q && micOn) { q.value = interim; q.classList.toggle('hearing', !!interim); }
  };
  rec.onerror = ev => {
    const msg = { 'not-allowed': 'Chrome didn’t let this page use the microphone. Allow it from the icon in the address bar, or use the mic on your keyboard instead.', 'service-not-allowed': 'Chrome’s speech service isn’t available here.', network: 'Speech needs an internet connection in Chrome.', 'audio-capture': 'No microphone found.' }[ev.error];
    if (msg) { toast(msg); micStop(); }
  };
  rec.onend = () => { if (!micOn) return; try { rec.start(); } catch (e) { setTimeout(() => { if (micOn && rec) { try { rec.start(); } catch (e2) { micStop(); } } }, 400); } };
  try { rec.start(); } catch (e) { toast('Couldn’t start listening.'); rec = null; return; }
  micOn = true; bumpIdle(); repaintMic();
  toast('Listening. Say a set, like “4 by 50 on 1 10”. Say “stop” when you’re done.');
}
function micToggle(pid){
  if (micOn && micTarget === pid) { micStop(); return; }
  micTarget = pid;
  if (micOn) repaintMic(); else micStart();
}
function handleSpoken(raw){
  const t = String(raw || '').trim().replace(/[.!?]+$/, ''); if (!t || !micTarget) return;
  if (/^(?:undo|undo that|scratch that|delete that|remove that)$/i.test(t)) { undo(); return; }
  if (/^(?:stop|stop listening|that'?s it|done|finished|finish)$/i.test(t)) { micStop(); toast('Stopped listening'); return; }
  if (/^(?:end(?: of)?|close|out of)(?: the)? round$|^back out$/i.test(t)) { const l = locate(micTarget); if (l && l.parent) { micTarget = l.parent.id; repaintMic(); toast('Out of the round'); } return; }
  const nb = t.match(/^(?:new|next|add(?: a)?) block(?:\s+(?:called|named)\s+|\s+)?(.*)$/i);
  if (nb) { pushUndo(); const b = newBlock(nb[1] ? capFirst(nb[1]) : 'New block', curGroup ? [curGroup] : []); S().blocks.push(b); micTarget = b.id; renderBlocks({ id: `q-${b.id}` }); markDirty(); toast(`Added block “${b.name}”`); return; }
  const pid = micTarget, text = normalizeDictation(t, true);
  addFromQuick(pid, text);
  const tgt = locate(pid), last = tgt && tgt.node.items[tgt.node.items.length - 1];
  if (last && last.t === 'round' && !last.items.length) { micTarget = last.id; toast(`Started a ${last.times}× round. Say its sets, then “end round”.`); }
  else if (last && last.t === 'line') toast(`Added ${lineText(last)}  ·  say “undo” to take it back`);
  repaintMic();
}

/* ---------- import ---------- */
function pdfMenu(btn){
  const s = S(), gs = s.groups || [];
  if (!gs.length) { exportPdf(null); return; }
  pop.innerHTML = `<div class="phead">Session plan PDF</div>` + gs.map(g => `<button data-pdf="${g.id}" style="--gc:${groupColor(s, g.id)}">${esc(g.name)}<kbd>${curGroup === g.id ? 'this tab' : ''}</kbd></button>`).join('') +
    `<hr><button data-pdf="zip">All groups, one PDF each</button>`;
  pop.dataset.for = ''; pop.hidden = false;
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
  pop.style.top = (r.bottom + 4) + 'px'; pop.style.left = clamp(r.right - pw, 8, window.innerWidth - pw - 8) + 'px';
}
async function exportPdf(gid){
  if (!downloads) return;
  const fonts = await pdfReady(); if (!fonts) return;
  const sess = sessionForGroup(S(), gid);
  let blob; try { blob = pdfFor(sess, fonts).output('blob'); } catch (e) { toast('Could not build the PDF.'); return; }
  await saveFile(pdfName(S(), sess._group), blob, 'PDF saved');
}
function anchorSave({ filename, data }){
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 8000);
  return Promise.resolve({ status: 'saved' });
}
/* ---------- storage ---------- */
function setStatus(st, text){ const el = $('#status'); if (!el) return; el.dataset.s = st; $('#statusText').textContent = text; }   // no-op once closed
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); else if (view === 'pool' && !wakeLock) setView('pool'); });
window.addEventListener('pagehide', flushNow);

  /* ---------- PDF (fonts bundled with the app, logo and header from the club's settings) ---------- */
  async function pdfReady(){ let fonts = null; try { fonts = await loadPdfFonts() } catch (e) { fonts = null } return fonts || {} }
  const pdfFor = (sess, fonts) => buildSessionPdf(jsPDF, sess, opts.logo || null, fonts && fonts.regular ? fonts : null,
    new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    { header: opts.pdfHeader || 'Session plan', footer: opts.pdfFooter || 'Session plan' })
  const pdfName = (s, gname) => exportFileName(s).replace(/\.xlsx$/, '') + (gname ? ` - ${gname.replace(/[\/:*?"<>|]/g, '-')}` : '') + '.pdf'
  async function saveFile(filename, blob, okMsg){ try { await downloads.save({ filename, data: blob }); toast(okMsg) } catch (e) { toast('The file could not be saved here.') } }
  async function exportAllPdfs(){
    const fonts = await pdfReady(), s = S()
    try { for (const g of s.groups) await saveFile(pdfName(s, g.name), pdfFor(sessionForGroup(s, g.id), fonts).output('blob'), `PDF saved for ${g.name}`) }
    catch (e) { toast('Could not build the PDFs.') }
  }

  /* ---------- saving through the app ---------- */
  function markDirty(){
    dirty = true
    setStatus('unsaved', 'Unsaved')
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 900)
    if (opts.onChange) opts.onChange()
  }
  function flushNow(){ clearTimeout(saveTimer); if (dirty) return flush() }
  async function flush(){
    if (!dirty || !S()) return
    if (saving) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 600); return }
    saving = true; dirty = false; setStatus('saving', 'Saving…')
    const body = JSON.parse(JSON.stringify(S()))
    try {
      const res = await opts.save(body)
      retries = 0
      setStatus(dirty ? 'unsaved' : 'saved', dirty ? 'Unsaved' : 'Saved')
      if (opts.onSaved) opts.onSaved(res)
    } catch (e) {
      dirty = true
      if (retries < 3) { retries++; setStatus('unsaved', 'Retrying…'); saveTimer = setTimeout(flush, 1500 + Math.random() * 800) }
      else { setStatus('error', 'Not saved'); toast('Saving failed. Your changes are still here; edit again to try again.'); retries = 0 }
    } finally { saving = false }
  }
  function openSession(id, session){
    cur = { id, session: JSON.parse(JSON.stringify(session)), loadedAt: 1 }
    if (!cur.session.aims) cur.session.aims = ['', '']
    normalizeSession(cur.session); curGroup = ''
    setEffSys(cur.session.effSys || opts.effSys || 'effort20')
    if (!Array.isArray(cur.session.blocks)) cur.session.blocks = []
    undoStack = []; sel.clear(); textMode.clear(); dirty = false
    $('#loading').hidden = true
    $('#editor').hidden = view !== 'edit'; $('#pool').hidden = view !== 'pool'
    renderMeta(); renderBlocks()
    if (view === 'pool') renderPool()
    setStatus('saved', 'Saved')
  }

  /* ---------- the staff's comments, pinned under the line they are about ---------- */
  let comments = []
  function paintComments(){
    if (!root.isConnected && !root.parentNode) return
    $$('.sc-pin', root).forEach(el => el.remove())
    const loose = []
    for (const c of comments.filter(x => x.status === 'open')) {
      const host = c.line_id && root.querySelector(`.node[data-id="${c.line_id}"]`)
      if (!host) { loose.push(c); continue }
      host.insertAdjacentHTML('beforeend',
        `<div class="sc-pin${c.flag === 'safety' ? ' safety' : ''}" data-cid="${c.id}"><span class="who">${esc(c.name)}${c.flag === 'safety' ? ' · safety' : ''}</span>${esc(c.message)}` +
        `<div class="acts"><button type="button" data-cmt="accept">Accept</button><button type="button" data-cmt="dismiss">${c.flag === 'safety' ? 'Acknowledge' : 'Dismiss'}</button>` +
        `<button type="button" data-cmt="useful" aria-pressed="${c.useful === true}">Useful</button><button type="button" data-cmt="notuseful" aria-pressed="${c.useful === false}">Not useful</button></div></div>`)
    }
    if (opts.onLooseComments) opts.onLooseComments(loose)
  }
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-cmt]'); if (!b) return
    const pin = b.closest('[data-cid]'), id = pin && +pin.dataset.cid; if (!id || !opts.onComment) return
    const c = comments.find(x => x.id === id)
    const action = b.dataset.cmt
    opts.onComment(c, action)
  })

  /* ---------- poolside: tap a set to note something about it ---------- */
  function holds(items, id){ return (items || []).some(n => n.id === id || (n.t === 'round' && holds(n.items, id))) }
  const onPoolTap = e => {
    if (view !== 'pool' || !opts.onPoolNote) return
    const el = e.target.closest && e.target.closest('#pool [data-nid]'); if (!el || !root.contains(el)) return
    const id = el.dataset.nid, block = S().blocks.find(b => holds(b.items, id))
    if (block) opts.onPoolNote({ block_id: block.id, line_id: id })
  }
  root.addEventListener('click', onPoolTap); listeners.push([root, 'click', onPoolTap, undefined])
  if (opts.onPoolNote) root.classList.add('sb-notes')

  /* ---------- Jess's draft, added as new blocks ---------- */
  function addBlocks(blocks, meta = {}){
    pushUndo()
    const s = S()
    // the empty starter blocks make way for the draft
    s.blocks = s.blocks.filter(b => (b.items || []).length || (b.kind === 'notes' && hasNoteText(b)))
    s.blocks.push(...blocks)
    if (meta.title && !s.title) s.title = meta.title
    ;(meta.aims || []).forEach((a, i) => { s.aims = s.aims || ['', '']; if (a && !s.aims[i]) s.aims[i] = a })
    renderMeta(); renderBlocks(); markDirty()
    toast("Jess's draft is in. Edit anything; Undo takes it out again.", 'Undo', undo)
  }

  if (speechOK()) { const tip = $('#tipSpeech'), alt = $('#tipDictate'); if (tip) tip.hidden = false; if (alt) alt.hidden = true }
  $('#brandName').textContent = opts.brand || 'Session Builder'
  openSession(opts.id, opts.session)
  if (opts.view === 'pool') setView('pool')

  return {
    flush: flushNow,
    getSession: () => JSON.parse(JSON.stringify(S())),
    // the session's groups with their colours, for the app's "who swims each group"
    groups: () => (S().groups || []).map(g => ({ ...g, swimmer_ids: [...(g.swimmer_ids || [])], color: groupColor(S(), g.id) })),
    // who swims each group, already saved by the app: no save of its own
    setGroupSwimmers(saved){
      const byId = Object.fromEntries((saved || []).map(g => [g.id, g]))
      for (const g of S().groups || []) {
        const x = byId[g.id]; if (!x) continue
        g.swimmer_ids = [...(x.swimmer_ids || [])]
        if (x.training_group_id) g.training_group_id = x.training_group_id; else delete g.training_group_id
      }
      renderGroupsEdit()
    },
    setView,
    view: () => view,
    // the sets with a note from this session, marked in the poolside view
    setNoted(ids){ noted = new Set(ids || []); if (view === 'pool') renderPool() },
    setComments(list){ comments = list || []; paintComments() },
    addBlocks,
    destroy(){
      flushNow()
      try { micStop() } catch (e) {}
      if (wakeLock) { try { wakeLock.release() } catch (e) {} }
      sortables.forEach(s => { try { s.destroy() } catch (e) {} })
      clearTimeout(saveTimer); clearTimeout(toastTimer)
      listeners.forEach(([t, type, h, o]) => t.removeEventListener(type, h, o))
      root.innerHTML = ''; root.classList.remove('sb', 'sb-notes')
    },
  }

}
