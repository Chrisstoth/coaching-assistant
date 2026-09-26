// Writing a session with the staff, live. The Session Writer drafts from the
// brief and the plan; the specialists suggest changes to particular lines;
// nothing changes until the coach accepts. Kept free of React so the wording
// and the bookkeeping can be tested.

export const POLL_MS = 1500

export function isWorking(status) {
  return status === 'drafting' || status === 'reviewing'
}

export function statusLine(workshop) {
  if (!workshop) return 'Starting…'
  const thinking = (workshop.voices || []).filter(v => v.status === 'thinking').length
  switch (workshop.status) {
    case 'drafting':
      return 'The Session Writer is drafting from your brief and the plan…'
    case 'reviewing':
      return thinking
        ? `The staff are reading the draft (${thinking} still looking)…`
        : 'Gathering the staff’s suggestions…'
    case 'ready': {
      const pending = pendingCount(workshop.suggestions)
      return pending
        ? `${pending} suggestion${pending === 1 ? '' : 's'} waiting for you. Nothing changes until you accept.`
        : 'Ready. Use the session when you are happy with it.'
    }
    case 'failed':
      return workshop.error || 'Something went wrong writing the draft.'
    default:
      return ''
  }
}

export function pendingCount(suggestions) {
  return (suggestions || []).filter(s => s.status === 'pending').length
}

// Pending suggestions keyed by the line they are about.
export function pendingByLine(suggestions) {
  const out = {}
  for (const s of suggestions || []) {
    if (s.status !== 'pending') continue
    ;(out[s.line_id] = out[s.line_id] || []).push(s)
  }
  return out
}

export function changeLabel(s) {
  if (s.change === 'remove') return 'Take this line out'
  if (s.change === 'add_after') return `Add after: ${s.text}`
  return s.text
}

// Lines that are new or reworded since the last look, so they can be highlighted.
export function changedLineIds(before, after) {
  if (!before || !after) return []
  const old = new Map()
  for (const section of before.sections || []) {
    for (const line of section.lines) old.set(line.id, line.text)
  }
  const changed = []
  for (const section of after.sections || []) {
    for (const line of section.lines) {
      if (!old.has(line.id) || old.get(line.id) !== line.text) changed.push(line.id)
    }
  }
  return changed
}

export const DECIDED_LABEL = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  superseded: 'Overtaken by another change',
}
