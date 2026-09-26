// How the coaching staff are shown. Kept free of React so the threading and
// ordering rules can be tested directly.

// Colours come from the validated series palette. Identity never rests on colour
// alone: every voice also carries its title and initials.
export const STAFF_STYLES = {
  physiologist: { title: 'Physiologist', initials: 'Ph', colour: '#0d9488' },
  analyst: { title: 'Performance Analyst', initials: 'PA', colour: '#3b82f6' },
  planner: { title: 'Periodisation Planner', initials: 'PP', colour: '#ea580c' },
  manager: { title: 'Swimmer Manager', initials: 'SM', colour: '#db2777' },
  meets: { title: 'Meet Manager', initials: 'MM', colour: '#65a30d' },
  sessions: { title: 'Session Writer', initials: 'SW', colour: '#9333ea' },
}

export const STAFF_ORDER = ['physiologist', 'analyst', 'planner', 'manager', 'meets', 'sessions']

// A disagreement put to the coach. Not a member of staff, so never in
// STAFF_ORDER: nobody can be asked to "speak" as the chair.
export const DECISION_STYLE = { title: 'Your call', initials: '?', colour: '#eab308' }

export function staffStyle(role) {
  if (role === 'chair') return DECISION_STYLE
  return STAFF_STYLES[role] || { title: role || 'Staff', initials: '?', colour: '#7f858c' }
}

// How a decision card reads once the coach has made the call.
export function decisionSummary(note) {
  if (!note || note.kind !== 'decision') return ''
  if (note.decision) return `Your call: ${note.decision}`
  const sides = (note.options || []).map(o => o.title || staffStyle(o.role).title)
  return sides.length ? `Waiting for you: ${sides.join(' or ')}` : 'Waiting for you'
}

// Group notes into threads: each top-level note with every reply beneath it,
// however deep, in the order they were written. A reply whose parent is not in
// the list stands on its own rather than disappearing.
export function threadNotes(notes) {
  const byId = new Map(notes.map(n => [n.id, n]))
  const rootOf = (note) => {
    let current = note
    const seen = new Set()
    while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parent_id)
    }
    return current
  }
  const threads = new Map()
  for (const note of [...notes].sort((a, b) => a.id - b.id)) {
    const root = rootOf(note)
    if (!threads.has(root.id)) threads.set(root.id, { note: root, replies: [] })
    if (root.id !== note.id) threads.get(root.id).replies.push(note)
  }
  return [...threads.values()]
}

function timeOf(value) {
  if (!value) return Number.POSITIVE_INFINITY   // not yet saved: it happened just now
  const t = Date.parse(value)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

// Chat messages and staff threads on one timeline, so a staff point appears
// straight after the exchange that prompted it.
export function mergeConversation(messages, notes) {
  const items = [
    ...messages.map((m, i) => ({ type: 'message', at: timeOf(m.created_at), order: i, message: m })),
    ...threadNotes(notes).map((t, i) => ({ type: 'staff', at: timeOf(t.note.created_at), order: i, thread: t })),
  ]
  return items.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    if (a.type !== b.type) return a.type === 'message' ? -1 : 1
    return a.order - b.order
  })
}

// What the staff are told a planning draft contains.
export function draftTopic(view) {
  if (!view) return ''
  const lines = [view.heading + (view.title ? `: ${view.title}` : '')]
  if (view.note) lines.push(view.note)
  for (const item of view.items.slice(0, 12)) {
    lines.push(`- ${item.title}${item.detail ? ` (${item.detail})` : ''}${item.body ? `: ${item.body}` : ''}`)
  }
  return lines.join('\n')
}

// What the staff are told a session draft contains, so they can chip in on
// the actual sets rather than the idea of them.
export function sessionTopic(result, coachText) {
  const plan = result?.parsed
  if (!plan) return ''
  const head = [`Session draft: ${plan.title || 'Untitled'}`]
  if (plan.energy_focus) head.push(`${plan.energy_focus} focus`)
  if (plan.total_volume_m) head.push(plan.total_volume_m)
  const lines = [head.join(', ')]
  if (coachText) lines.push(`The coach asked for: ${coachText}`)
  if (plan.warm_up) lines.push(`Warm up: ${plan.warm_up}`)
  for (const [num, group] of Object.entries(plan.groups || {})) {
    const sets = (Array.isArray(group?.sets) ? group.sets : [group?.sets]).filter(Boolean)
    lines.push(`Group ${num}${group?.label ? ` (${group.label})` : ''}: ${sets.join('; ')}`)
  }
  if (plan.cool_down) lines.push(`Cool down: ${plan.cool_down}`)
  if (result.plan_alignment) lines.push(`How it fits the plan: ${result.plan_alignment}`)
  const mods = (result.per_swimmer || []).filter(row => row.name && row.note).slice(0, 12)
  if (mods.length) {
    lines.push('Per swimmer: ' + mods.map(row => `${row.name}${row.suggested_group ? ` (G${row.suggested_group})` : ''}: ${row.note}`).join('; '))
  }
  return lines.join('\n').slice(0, 5800)
}

// A staff point, or the coach's call, turned into a revision request.
export function workInText(note) {
  if (!note) return ''
  if (note.kind === 'decision' && note.decision) return `I've decided: ${note.decision}. Work this into the session.`
  return `The ${staffStyle(note.role).title} says: ${note.message} Work this into the session.`
}
