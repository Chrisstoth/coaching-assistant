/* Notes the coach takes during a session: which set a note can be about, which
   swimmers it names, and how a note is shown. Kept free of React so it can be
   tested on its own. */
import { blockGroupNames, isBlankLine, lineText, normalizeSession } from './notation/core.js'

const MAX_LABEL = 120

const clip = (text, max = MAX_LABEL) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function itemLabel(n) {
  if (n.t === 'round') {
    const inside = (n.items || []).filter(x => x.t === 'round' || !isBlankLine(x)).map(x => (x.t === 'round' ? `${x.times || 1}×(…)` : lineText(x)))
    return `${n.times || 1}× ${inside.length ? `(${inside.join(', ')})` : 'round'}${n.note ? ` ${n.note}` : ''}`
  }
  return lineText(n)
}

/* Every set a note can be about, block by block:
   [{ block_id, block, groups, options: [{ value, line_id, label, depth }] }].
   A block itself is an option too ("the whole warm-up"). Sets inside a round are
   listed under it, so tapping one in the poolside view finds its option. */
export function noteSetOptions(session) {
  if (!session || !Array.isArray(session.blocks)) return []
  const s = normalizeSession(JSON.parse(JSON.stringify(session)))
  return s.blocks
    .filter(b => b.kind !== 'notes' && (b.items || []).length)
    .map(b => {
      const block = (b.name || 'Block').trim()
      const options = [{ value: `block:${b.id}`, block_id: b.id, line_id: null, label: `${block} (all of it)`, depth: 0, ref: block }]
      const walk = (items, depth) => {
        for (const n of items || []) {
          if (n.t !== 'round' && isBlankLine(n)) continue
          const text = clip(itemLabel(n))
          if (!text) continue
          options.push({ value: `line:${n.id}`, block_id: b.id, line_id: n.id, label: text, depth, ref: `${block} · ${text}` })
          if (n.t === 'round') walk(n.items, depth + 1)
        }
      }
      walk(b.items, 1)
      return { block_id: b.id, block, groups: blockGroupNames(s, b), options }
    })
}

// The set_ref a note stores for an option value ("line:abc" or "block:xyz").
export function setRefFor(groups, value) {
  if (!value) return null
  for (const g of groups || []) {
    const o = g.options.find(x => x.value === value)
    if (o) return { block_id: o.block_id, line_id: o.line_id, label: clip(o.ref, 300) }
  }
  return null
}

export function setValueFor(ref) {
  if (!ref) return ''
  if (ref.line_id) return `line:${ref.line_id}`
  if (ref.block_id) return `block:${ref.block_id}`
  return ''
}

const firstName = name => String(name || '').trim().split(/\s+/)[0] || ''
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = (text, word) => word && new RegExp(`(^|[^\\p{L}'])${escapeRx(word)}(?=$|[^\\p{L}])`, 'iu').test(text)

/* The swimmers a note names, so dictating "Amy breathing left" tags Amy.
   A first name two swimmers share only counts when the full name is said. */
export function swimmersNamed(text, swimmers) {
  const t = String(text || '')
  if (!t.trim()) return []
  const firstCount = {}
  for (const s of swimmers || []) {
    const f = firstName(s.name).toLowerCase()
    if (f) firstCount[f] = (firstCount[f] || 0) + 1
  }
  return (swimmers || []).filter(s => {
    const full = String(s.name || '').trim()
    if (full.includes(' ') && mentions(t, full)) return true
    const f = firstName(full)
    return f.length > 1 && firstCount[f.toLowerCase()] === 1 && mentions(t, f)
  }).map(s => s.id)
}

export function newClientId() {
  const id = globalThis.crypto?.randomUUID?.()
  return id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// The server keeps times in UTC; a time without its zone came from SQLite and is UTC too.
function noteDate(value) {
  if (!value) return null
  const text = String(value)
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

// "20:42" on the phone's clock.
export function noteClock(value) {
  const d = noteDate(value)
  return d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''
}

// Server notes, plus any still waiting on the phone that the server doesn't have yet. Newest first.
export function mergeNotes(saved, waiting) {
  const known = new Set((saved || []).map(n => n.client_id).filter(Boolean))
  const pending = (waiting || []).filter(n => !known.has(n.client_id)).map(n => ({ ...n, id: `pending-${n.client_id}`, pending: true }))
  const at = n => noteDate(n.noted_at)?.getTime() || 0
  return [...(saved || []), ...pending].sort((a, b) => at(b) - at(a))
}
