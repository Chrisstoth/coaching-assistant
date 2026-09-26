// Who is on a pathway, and from when. Swimmers in one training group can be
// on different pathways, and a swimmer can branch onto another pathway from a
// date - so saving the list must keep every date already recorded.

import { dayLabel } from './squadGroups.js'

// The list the server replaces the pathway's members with.
export function membersPayload(existing, chosenIds, joinFrom) {
  const known = new Map((existing || []).map(m => [m.swimmer_id, m]))
  return [...chosenIds].map(id => {
    const m = known.get(id)
    if (m) {
      return {
        swimmer_id: id,
        date_from: m.date_from || null,
        date_to: m.date_to || null,
        qualification_status: m.qualification_status || 'unknown',
        notes: m.notes || null,
        active: m.active !== false,
      }
    }
    return { swimmer_id: id, date_from: joinFrom || null, date_to: null, qualification_status: 'unknown', notes: null, active: true }
  })
}

// "Nia Hart from 5 Oct", "Ella Moss until 4 Oct".
export function memberLabel(m, today) {
  let label = m.swimmer
  if (m.date_from && m.date_from > today) label += ` from ${dayLabel(m.date_from)}`
  if (m.date_to) label += ` until ${dayLabel(m.date_to)}`
  return label
}

export function memberEnded(m, today) {
  return Boolean(m.date_to && m.date_to < today) || m.active === false
}

// Active swimmers with no pathway still running in this macrocycle. Every
// swimmer aims at a meet each macrocycle, so this list should end up empty.
export function withoutPathway(swimmers, pathways, today) {
  const placed = new Set((pathways || []).flatMap(p => p.members.filter(m => !memberEnded(m, today)).map(m => m.swimmer_id)))
  return (swimmers || []).filter(s => s.active !== false && (s.status || 'active') === 'active' && !placed.has(s.id))
}
