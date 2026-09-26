// How a swimmer's week reads in the squad grid. A swimmer follows their
// group's plan, so a cell only carries what is different for them. Kept free
// of React so the reading can be tested.

const AWAY_LABELS = {
  holiday: 'Holiday', exams: 'Exams', work: 'Work', injury: 'Injury', competition: 'Competing',
  planned_rest: 'Planned rest', taper_rest: 'Taper rest', other: 'Away',
}

// The marks drawn in a cell, most important first. Colour is never the only
// signal: each mark has its own symbol and a spoken label.
export function cellMarks(cell) {
  if (!cell) return []
  const marks = []
  if ((cell.flags || []).length) marks.push({ symbol: '⚑', tone: 'flag', label: cell.flags.join('; ') })
  for (const kind of new Set(cell.events || [])) {
    marks.push({ symbol: '✚', tone: 'ill', label: kind === 'injury' ? 'Injured' : 'Ill' })
  }
  if ((cell.moves || []).length) marks.push({ symbol: '⇄', tone: 'move', label: cell.moves.join('; ') })
  if ((cell.away || []).length) {
    marks.push({ symbol: '✕', tone: 'away', label: cell.away.map(r => AWAY_LABELS[r] || r).join(', ') })
  }
  for (const meet of cell.meets || []) {
    const symbol = meet.state === 'entered' ? '●' : meet.state === 'planned' ? '◐' : '○'
    const how = meet.state === 'entered' ? 'Entered' : meet.state === 'planned' ? 'Planned' : 'On their pathway'
    marks.push({ symbol, tone: meet.state, label: `${how}: ${meet.name}${meet.events?.length ? ` (${meet.events.join(', ')})` : ''}` })
  }
  return marks
}

// Share of the week's sessions they came to, for shading past weeks.
export function attendanceShare(cell) {
  const att = cell?.attendance
  if (!att || !att[1]) return null
  return att[0] / att[1]
}

export function cellDetail(cell) {
  const lines = cellMarks(cell).map(m => m.label)
  const att = cell?.attendance
  if (att) lines.push(`Trained ${att[0]} of ${att[1]} sessions`)
  if (cell?.metres) {
    lines.push(`Swam ${(cell.metres / 1000).toFixed(1)}km`
      + (cell.hi_metres ? `, ${Math.round(cell.hi_metres)}m high intensity` : ''))
  }
  return lines
}

// Open by default when there is only one group to look at.
export function initialOpenGroups(groups) {
  return (groups || []).length === 1 ? { [groups[0].name]: true } : {}
}

export const MARK_TONES = {
  flag: 'text-amber-300',
  ill: 'text-red-400',
  away: 'text-pool-400',
  entered: 'text-green-400',
  planned: 'text-accent-300',
  pathway: 'text-pool-500',
  move: 'text-accent-300',
}
