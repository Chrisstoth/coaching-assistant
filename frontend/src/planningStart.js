// Getting a coach from an empty plan to a first outline, and on from there.
//
// Planning runs top down in three steps: outline the year into macrocycles,
// plan the blocks inside each, then plan the weeks. These helpers work out
// which step the coach is on and turn what the app already knows (the meet
// calendar, the weekly timetable, the squad) into a first request, so nobody
// has to face a blank chat box. Kept free of React so they can be tested.

const DAY_MS = 86400000

export const STEPS = [
  { key: 'outline', title: 'Outline the year', detail: 'Split the season into macrocycles, each building to a target meet.' },
  { key: 'blocks', title: 'Plan each macrocycle', detail: 'The blocks inside it: base, build, peak and taper.' },
  { key: 'weeks', title: 'Plan the weeks', detail: 'Which sessions run on which days, then write them.' },
]

export function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parse(value) {
  return value ? new Date(`${String(value).slice(0, 10)}T12:00:00`) : null
}

function monday(d) {
  const copy = new Date(d)
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7))
  return copy
}

export function planningStage(macros, macro) {
  if (!macros || macros.length === 0) return 'outline'
  if (!macro || !(macro.mesos || []).length) return 'blocks'
  return 'weeks'
}

// From this week to the last meet in the coming year, or a standard 44-week
// season when there are no meets to go on.
export function defaultSeasonWindow(today, meets) {
  const start = monday(today)
  const horizon = start.getTime() + 400 * DAY_MS
  const ahead = (meets || [])
    .map(m => parse(m.date_to || m.date))
    .filter(d => d && d.getTime() >= start.getTime() && d.getTime() <= horizon)
  let end = ahead.length ? new Date(Math.max(...ahead.map(d => d.getTime()))) : new Date(start.getTime() + 44 * 7 * DAY_MS)
  if (end.getTime() - start.getTime() < 12 * 7 * DAY_MS) end = new Date(start.getTime() + 12 * 7 * DAY_MS)
  return { from: isoDate(start), to: isoDate(end) }
}

const TARGET_LEVELS = ['regional', 'national', 'international', 'county']
const TARGET_NAMES = /champ|nationals|regionals|county|qualif|final/i

export function likelyTarget(meet) {
  const level = String(meet.level || '').toLowerCase()
  return TARGET_LEVELS.some(l => level.includes(l)) || TARGET_NAMES.test(meet.name || '')
}

// Meets inside the season, in date order, each marked if it looks like a
// meet worth building towards.
export function seasonMeets(meets, from, to) {
  const start = parse(from)
  const end = parse(to)
  return (meets || [])
    .filter(m => {
      const d = parse(m.date)
      return d && (!start || d >= start) && (!end || d <= end)
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(m => ({ ...m, suggested: likelyTarget(m) }))
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function weeklySchedule(slots, squad) {
  const rows = (slots || [])
    .filter(s => s.active !== false && (!squad || !s.squad || s.squad === squad))
    .sort((a, b) => (a.day_of_week - b.day_of_week) || String(a.time).localeCompare(String(b.time)))
  return {
    count: rows.length,
    label: rows.map(s => `${DAYS[s.day_of_week] || '?'} ${s.time}`).join(', '),
  }
}

function shortDate(value) {
  const d = parse(value)
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : value
}

// The first message, written from what the coach ticked.
export function outlineRequest({ from, to, squad, targets, schedule }) {
  const parts = [`Divide the season from ${shortDate(from)} to ${shortDate(to)} into macrocycles${squad ? ` for ${squad}` : ''}.`]
  if (targets && targets.length) {
    parts.push('Build each macrocycle towards one of these target meets: '
      + targets.map(t => `${t.name} (${shortDate(t.date)})`).join('; ') + '.')
    parts.push('Treat the other meets in the calendar as stepping stones.')
  } else {
    parts.push("I haven't picked target meets yet - suggest which meets in the calendar to build towards.")
  }
  if (schedule && schedule.count) parts.push(`We train ${schedule.count} sessions a week.`)
  return parts.join(' ')
}

// What to do next once there is an outline.
export function nextStep(stage, macro) {
  if (stage === 'blocks' && macro) {
    return {
      title: `Plan the blocks inside ${macro.name}`,
      detail: 'Base, build, peak and taper: the phases that lead to its target meet. The assistant proposes them and you approve.',
      label: `Plan ${macro.name}`,
      text: 'Plan the phases inside this macrocycle.',
    }
  }
  if (stage === 'weeks' && macro) {
    return {
      title: 'Plan the weeks',
      detail: 'Lay out which sessions run on which days in the next week of this block, then write each one in the session planner.',
      label: 'Plan next week',
      text: 'Plan the next week of this macrocycle: which sessions run on which days and what each is for.',
    }
  }
  return null
}
