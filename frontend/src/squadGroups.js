// Training groups on the Swimmers page: who trains together, and since when.
// A move is dated, so the weeks before it keep the old group. Kept free of
// React so the wording can be tested.

export function todayIso(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

export function dayLabel(iso) {
  if (!iso) return ''
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// The group a swimmer is in today, from the page's data.
export function currentGroupOf(data, swimmerId) {
  return (data?.groups || []).find(g => g.swimmers.some(s => s.id === swimmerId)) || null
}

export function everyone(data) {
  return [...(data?.groups || []).flatMap(g => g.swimmers), ...(data?.ungrouped || [])]
}

// "→ Senior from 3 Nov" for a move already agreed.
export function nextMoveLabel(swimmer) {
  const next = swimmer?.next
  if (!next) return ''
  return `→ ${next.group_name || 'no group'} from ${dayLabel(next.date_from)}`
}

// What a move will do, in words, before it is saved.
export function moveSummary({ names, fromName, toName, dateFrom, today }) {
  const who = names.length === 1 ? names[0] : `${names.length} swimmers`
  const where = toName ? `into ${toName}` : 'out of their group'
  const when = !dateFrom || dateFrom === today ? 'from today' : `from ${dayLabel(dateFrom)}`
  const before = fromName && dateFrom && dateFrom > today
    ? ` Until then they stay in ${fromName}.`
    : fromName && dateFrom && dateFrom < today
      ? ` Weeks from ${dayLabel(dateFrom)} are counted as ${toName || 'no group'}.`
      : ''
  return `${who} ${names.length === 1 ? 'moves' : 'move'} ${where} ${when}.${before}`
}

export function movePayload(swimmerIds, groupId, dateFrom, note) {
  return {
    swimmer_ids: [...swimmerIds],
    group_id: groupId ?? null,
    date_from: dateFrom || null,
    note: (note || '').trim() || null,
  }
}

// Swap a group with its neighbour and return the new running order of ids.
export function reorder(groups, index, step) {
  const ids = groups.map(g => g.id)
  const target = index + step
  if (target < 0 || target >= ids.length) return ids
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  return ids
}

export const GROUP_REVIEW_TOPIC =
  'Review the training groups. Is anyone in the wrong group - outgrown it, struggling in it, ' +
  'or training too few sessions to follow it - or an active swimmer in no group? ' +
  'Suggest any moves with a date that suits the plan.'

// A swimmer's group today and their next move, from their dated history.
export function groupNow(history, today) {
  const rows = history || []
  const current = rows.find(h => h.date_from <= today && (!h.date_to || h.date_to >= today)) || null
  const next = rows.filter(h => h.date_from > today).sort((a, b) => a.date_from.localeCompare(b.date_from))[0] || null
  return { current, next }
}

export function groupLine(history, today) {
  const { current, next } = groupNow(history, today)
  const now = current ? `${current.group_name} since ${dayLabel(current.date_from)}` : 'Not in a training group'
  return next ? `${now} · → ${next.group_name} from ${dayLabel(next.date_from)}` : now
}

// The groups a block's aims are written for: the squad's own groups, plus any
// label an older plan already has an aim under, so nothing written is lost.
export function aimLabels(groupNames, intents) {
  const names = (groupNames || []).length ? [...groupNames] : ['G1', 'G2', 'G3']
  for (const [label, text] of Object.entries(intents || {})) {
    if (text && !names.includes(label)) names.push(label)
  }
  return names
}

// "Regional", or "Regional → Winter Nationals from 5 Oct" for a branch to come.
export function pathwayTag(pathway) {
  if (!pathway) return ''
  const now = pathway.name || 'No pathway'
  return pathway.next ? `${now} → ${pathway.next.name} from ${dayLabel(pathway.next.date_from)}` : now
}

// "G1", "Group 2" - the register already numbers each session's sets that way.
export function looksLikeSetNumber(name) {
  return /^\s*(g|group|set)\s*\d+\s*$/i.test(name || '')
}
