// Target sets: the coach's recipe for training target times from PBs,
// e.g. "100 PB ÷ 4 for each 25, then +0.5 and +1.0". The server works the
// times out; this file only turns the form into a request and back.

export const BASE_DISTANCES = [50, 100, 200, 400, 800, 1500]
export const REP_DISTANCES = [25, 50, 75, 100, 150, 200, 400]
export const STROKES = ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly', 'Individual Medley']
export const SHORT_STROKE = {
  Freestyle: 'Free', Backstroke: 'Back', Breaststroke: 'Breast', Butterfly: 'Fly', 'Individual Medley': 'IM',
}

export const DEFAULT_DRAFT = {
  name: '',
  squad: '',
  base_distance: 100,
  rep_distance: 25,
  offsetsText: '0, 0.5, 1.0',
  course: 'SCM',
  strokes: null,       // null = each swimmer's target events
  decimals: 1,
}

const plain = n => (Math.round(n * 10) === n * 10 ? n.toFixed(1) : String(n))

// [0, 0.5, 1] → "0, 0.5, 1.0"
export function offsetsToText(offsets = []) {
  return offsets.map(o => (o === 0 ? '0' : (o < 0 ? '-' : '') + plain(Math.abs(o)))).join(', ')
}

// "0, +0.5, 1" → { offsets: [0, 0.5, 1] }. "PB" counts as 0.
export function parseOffsets(text) {
  const parts = String(text || '').split(/[,;\s]+/).map(p => p.trim()).filter(Boolean)
  if (!parts.length) return { offsets: [], error: 'Add at least one time, e.g. 0 for PB pace' }
  const offsets = []
  for (const part of parts) {
    const value = /^pb$/i.test(part) ? 0 : Number(part.replace('−', '-'))
    if (!Number.isFinite(value)) return { offsets: [], error: `"${part}" isn't a number of seconds` }
    const rounded = Math.round(value * 100) / 100
    if (!offsets.includes(rounded)) offsets.push(rounded)
  }
  if (offsets.length > 6) return { offsets: [], error: 'Up to six times per set' }
  return { offsets, error: null }
}

export function draftFromSet(set) {
  if (!set) return { ...DEFAULT_DRAFT }
  return {
    name: set.name || '',
    squad: set.squad || '',
    base_distance: set.base_distance ?? null,
    rep_distance: set.rep_distance,
    offsetsText: offsetsToText(set.offsets),
    course: set.course || 'SCM',
    strokes: set.strokes || null,
    decimals: set.decimals || 1,
  }
}

export function payloadFromDraft(draft) {
  const { offsets, error } = parseOffsets(draft.offsetsText)
  return {
    error,
    payload: {
      name: draft.name.trim(),
      squad: draft.squad || null,
      base_distance: draft.base_distance || null,
      rep_distance: Number(draft.rep_distance),
      offsets,
      course: draft.course,
      strokes: draft.strokes && draft.strokes.length ? draft.strokes : null,
      decimals: Number(draft.decimals) || 1,
    },
  }
}

export function toggleStroke(strokes, stroke) {
  const current = strokes || []
  const next = current.includes(stroke) ? current.filter(s => s !== stroke) : [...current, stroke]
  return next.length ? STROKES.filter(s => next.includes(s)) : null
}

// Search by swimmer name; rows stay with their swimmer.
export function filterSwimmers(swimmers = [], search = '') {
  const q = search.trim().toLowerCase()
  return q ? swimmers.filter(s => s.name.toLowerCase().includes(q)) : swimmers
}

export function countTimes(swimmers = []) {
  return swimmers.reduce((n, s) => n + s.rows.filter(r => r.times.length).length, 0)
}

// --- Target sets used in a session -------------------------------------------

export function addSessionTarget(links = [], targetSetId, note = '') {
  const rest = links.filter(l => l.target_set_id !== targetSetId)
  return { targets: [...rest, { target_set_id: targetSetId, note: note.trim() || null }] }
}

export function removeSessionTarget(links = [], targetSetId) {
  return { targets: links.filter(l => l.target_set_id !== targetSetId) }
}

export function swimmersFromLabel(source) {
  return {
    register: 'Swimmers on the register',
    audience: 'Swimmers the session was written for',
    squad: 'Everyone in the squad (no register yet)',
  }[source] || 'No swimmers yet'
}

// "2026-11-12", "06:00" → "Thu 12 Nov · 06:00"
export function sessionLabel(row) {
  const [y, m, d] = row.date.split('-').map(Number)
  const day = new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return [day, row.start_time, row.title].filter(Boolean).join(' · ')
}
