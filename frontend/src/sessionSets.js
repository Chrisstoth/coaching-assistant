/**
 * Turns a set — however it reached us — into the four things a coach reads off
 * a poolside sheet: the dose (reps × distance), what to do, how hard, and the
 * clock. Excel imports already carry those as structured `items`; AI-planned
 * and hand-typed sessions arrive as a line of coach shorthand, so the same
 * shape is recovered by parsing. Effort is deliberately lifted out of the
 * wording into its own field: an isolated per-row effort is what later lets a
 * swimmer's levels be tracked against the row they actually swam.
 */

const DASH = '[-–—]'
// 1:30 / 90 / 90s / 1:30.5 — a clock value in the forms coaches write.
const CLOCK = '\\d{1,3}(?::\\d{2})?(?:\\.\\d{1,2})?\\s*(?:secs?|seconds?|s|mins?|"|\')?'
const CLOCK_RANGE = `${CLOCK}(?:\\s*${DASH}\\s*${CLOCK})?`

// A send-off puts the next rep on the clock; everything here reads as "on".
const SEND_OFF_PATTERNS = [
  new RegExp(`@\\s*(${CLOCK_RANGE})(?!\\s*%)`, 'i'),
  new RegExp(`\\b(?:off|on|o/)\\s*(${CLOCK_RANGE})(?!\\s*%)`, 'i'),
]

// "8x50 race pace 1:00" — a clock trailing the wording with no "@" at all.
// Tried only once the explicit rest wordings below have been ruled out.
const TRAILING_CLOCK = /(\d{1,3}:\d{2}(?:\.\d{1,2})?)\s*$/

// Time off between reps — a set can prescribe rest instead of a send-off.
const REST_PATTERNS = [
  new RegExp(`\\b(?:rest|ri)\\s*(?:of|=|:)?\\s*(${CLOCK_RANGE})`, 'i'),
  new RegExp(`\\bw(?:ith|/)\\s*(${CLOCK_RANGE})\\s*(?:rest|recovery)`, 'i'),
  new RegExp(`\\+?\\s*(${CLOCK_RANGE})\\s*(?:rest|recovery)\\b`, 'i'),
  new RegExp(`\\br\\s*[:=]?\\s*(${CLOCK_RANGE})`, 'i'),
  // A bare "…30s" left at the end of a line is rest, not a send-off.
  new RegExp(`\\b(\\d{1,3}\\s*(?:secs?|seconds?|s))\\s*$`, 'i'),
]

const EFFORT_PATTERNS = [
  // The coach template's own column: "effort 14/20".
  { kind: 'scale', re: /\b(?:effort\s*)?(\d{1,2}(?:\.\d)?)\s*\/\s*20\b/i, scale: 20 },
  { kind: 'rpe', re: /\brpe\s*[:=]?\s*(\d{1,2}(?:\.\d)?)(?:\s*\/\s*10)?\b/i, scale: 10 },
  { kind: 'percent', re: /\b(\d{2,3})\s*%(?:\s*(?:effort|max|pace))?/i, scale: 100 },
]

const TOTAL_METRES = /\|\s*(\d{2,5})\s*m\b/i
const REPEAT_ROW = /^\s*(?:x\s*(\d+)|(\d+)\s*x)\s*:?\s*$/i
const HEADING_ROW = /^\s*[A-Za-z][A-Za-z0-9 &'/-]{0,40}:\s*$/
const LEADING_LABEL = /^([A-Za-z][A-Za-z0-9 &'/-]{0,24}):\s+/
// "8 x 100", "8x100m", "3 × 400", or a bare "400".
const DOSE = /^\s*(?:(\d{1,3})\s*[x×]\s*)?(\d{1,5})\s*m?\b/i
const INNER_DOSE = /(?:(\d{1,3})\s*[x×]\s*)?(\d{2,5})\s*m?\b/i
// A distance shorter than this is a rep count or a lane number, not a swim.
const SHORTEST_REAL_DISTANCE = 25
// "4 x 25 fast + 25 easy" — a second distance swum inside every rep.
const EXTRA_DISTANCE = /\+\s*(\d{1,4})\b(?!\s*(?:s|sec|secs|seconds|%|\/))/gi

// The quickest a human could conceivably cover a metre, used only to tell a
// send-off apart from a rest: 30s under this floor cannot be a 200m send-off.
const FASTEST_SECONDS_PER_100 = 45

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function normaliseOne(part) {
  const text = clean(part).toLowerCase().replace(/["']/g, 's')
  if (!text) return ''
  const minutes = text.match(/^(\d{1,3})\s*mins?$/)
  if (minutes) return `${Number(minutes[1])}:00`
  const clock = text.match(/^(\d{1,3}):(\d{2})(?:\.(\d{1,2}))?$/)
  if (clock) {
    const fraction = clock[3] ? `.${clock[3]}` : ''
    // "0:30" is thirty seconds; say so the way a coach would.
    if (Number(clock[1]) === 0) return `${Number(clock[2])}${fraction}s`
    return `${Number(clock[1])}:${clock[2]}${fraction}`
  }
  const seconds = text.match(/^(\d{1,3})(?:\.(\d{1,2}))?\s*(?:s|sec|secs|second|seconds)?$/)
  if (!seconds) return ''
  const whole = Number(seconds[1])
  const fraction = seconds[2] ? `.${seconds[2]}` : ''
  if (whole < 60) return `${whole}${fraction}s`
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}${fraction}`
}

/** "90" and "90s" both mean ninety seconds; "1:30" is already a clock. */
export function normaliseClock(value) {
  const raw = clean(value)
  if (!raw) return ''
  return raw.split(/\s*[-–—]\s*/).map(normaliseOne).filter(Boolean).join('–')
}

/** Seconds behind a normalised clock — "1:30" → 90, "45s" → 45. */
export function clockSeconds(value) {
  const first = String(value || '').split('–')[0]
  const clock = first.match(/^(\d{1,3}):(\d{2}(?:\.\d{1,2})?)$/)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  const seconds = first.match(/^(\d{1,3}(?:\.\d{1,2})?)s$/)
  return seconds ? Number(seconds[1]) : null
}

const sendOff = value => ({ kind: 'send-off', value, label: `@ ${value}` })
const restFor = value => ({ kind: 'rest', value, label: `rest ${value}` })

/**
 * Pull the clock out of a line. A send-off and a prescribed rest print in the
 * same right-hand column but must never be confused for one another.
 */
function extractInterval(text) {
  for (const re of SEND_OFF_PATTERNS) {
    const match = text.match(re)
    const value = match && normaliseClock(match[1])
    if (value) return { rest: text.replace(match[0], ' '), interval: sendOff(value) }
  }
  for (const re of REST_PATTERNS) {
    const match = text.match(re)
    const value = match && normaliseClock(match[1])
    if (value) return { rest: text.replace(match[0], ' '), interval: restFor(value) }
  }
  const trailing = text.match(TRAILING_CLOCK)
  const trailingValue = trailing && normaliseClock(trailing[1])
  if (trailingValue) return { rest: text.replace(trailing[0], ' '), interval: sendOff(trailingValue) }
  return { rest: text, interval: null }
}

/**
 * No 200 goes on a 30-second send-off, so a clock that could not possibly
 * cover the distance is a rest the coach wrote in send-off shorthand.
 */
function reclassifyInterval(interval, distance) {
  if (!interval || interval.kind !== 'send-off' || !distance) return interval
  const seconds = clockSeconds(interval.value)
  if (seconds === null) return interval
  return seconds < (distance / 100) * FASTEST_SECONDS_PER_100 ? restFor(interval.value) : interval
}

function zoneFromWords(text, zones) {
  const candidates = (zones || [])
    .filter(zone => clean(zone?.label).length > 1)
    .sort((a, b) => clean(b.label).length - clean(a.label).length)
  for (const zone of candidates) {
    const label = clean(zone.label)
    const match = text.match(new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(label)})(?![A-Za-z0-9])`, 'i'))
    if (match) {
      // Lifting the word out is right at the edge of the wording ("3 x 800
      // aerobic"), but mid-sentence it would leave prose dangling — "build to
      // threshold" has to stay whole even though the effort column now says so.
      const before = clean(text.slice(0, match.index + match[1].length))
      const after = clean(text.slice(match.index + match[1].length + match[2].length))
      // A clock left after the zone word still counts as the end of the wording:
      // "@ race pace 1:00" reads as a race-pace 50 on the minute, not as prose.
      const trailing = !after || /^[·•,;:|)\]]/.test(after) || /^\d{1,3}(?::\d{2})?\s*s?$/.test(after)
      return {
        rest: trailing && !/\b(?:to|through|into|from|at)$/i.test(before) ? text.replace(match[2], ' ') : text,
        effort: { kind: 'zone', label, zone: zone.canonical_zone || null, colour: zone.colour || null, value: null, scale: null },
      }
    }
  }
  return { rest: text, effort: null }
}

/**
 * Effort belongs in its own column, never buried in the wording. It may be the
 * coach's numeric scale, an RPE, a percentage, or a named energy zone from the
 * club's own terminology — whichever the row happens to carry. This runs before
 * the clock is read so that a zone named "Recovery" is never mistaken for one.
 */
function extractEffort(text, zones) {
  for (const pattern of EFFORT_PATTERNS) {
    const match = text.match(pattern.re)
    if (!match) continue
    const value = Number(match[1])
    const label = pattern.kind === 'percent' ? `${value}%`
      : pattern.kind === 'rpe' ? `RPE ${value}`
      : `${value}/20`
    const named = zoneFromWords(text.replace(match[0], ' '), zones)
    return {
      rest: named.rest,
      effort: {
        kind: pattern.kind,
        value,
        scale: pattern.scale,
        label,
        zone: named.effort?.zone || null,
        colour: named.effort?.colour || null,
      },
    }
  }
  return zoneFromWords(text, zones)
}

function tidyDescription(text) {
  return clean(text)
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\(\s*\)/g, '')
    .replace(/(?:^|\s)@\s*(?=$|\s)/g, ' ')
    .replace(/\s*\+\s*$/, '')
    .replace(/^(?:\s*[·•›\-–—,;:]\s*)+/, '')
    .replace(/(?:\s*[·•›\-–—,;:]\s*)+$/, '')
    .trim()
}

/**
 * Parse one line of coach shorthand into a printable row.
 * `zones` are the club's terminology levels (label / colour / canonical_zone).
 */
export function parseSetLine(line, zones = []) {
  const raw = String(line ?? '')
  const depth = /^(?: {2,}|\t)/.test(raw) ? 1 : 0
  const text = clean(raw).replace(/^[•›]\s*/, '')
  if (!text) return null

  const repeat = text.match(REPEAT_ROW)
  if (repeat) {
    const times = Number(repeat[1] || repeat[2])
    return {
      kind: 'repeat', depth, repetitions: times, distance: null, label: '',
      dose: `${times} ×`, description: 'rounds of', interval: null, effort: null, totalMetres: null,
    }
  }

  let remainder = text
  let totalMetres = null
  const total = remainder.match(TOTAL_METRES)
  if (total) {
    totalMetres = Number(total[1])
    remainder = remainder.replace(total[0], ' ')
  }

  const withEffort = extractEffort(remainder, zones)
  const withInterval = extractInterval(withEffort.rest)
  remainder = withInterval.rest

  // "Warm up: 400 easy" carries a label before the dose; hold it separately so
  // it can lead the description instead of pushing the row out of the layout.
  let label = ''
  let body = remainder
  const labelMatch = remainder.match(LEADING_LABEL)
  if (labelMatch) {
    label = clean(labelMatch[1])
    body = remainder.slice(labelMatch[0].length)
  }
  let dose = body.match(DOSE)
  if (!dose) {
    // "Cool down 200 easy" — the dose sits behind a lead-in the coach typed.
    const inner = body.match(INNER_DOSE)
    if (inner && Number(inner[2]) >= SHORTEST_REAL_DISTANCE) {
      label = clean([label, body.slice(0, inner.index)].join(' '))
      body = body.slice(inner.index)
      dose = body.match(DOSE)
    }
  }

  if (!dose || !(Number(dose[2]) > 0)) {
    const noteText = tidyDescription(remainder)
    if (!noteText && !withInterval.interval && !withEffort.effort) return null
    return {
      kind: HEADING_ROW.test(text) ? 'heading' : 'note',
      depth, repetitions: null, distance: null, dose: '', label: '',
      description: noteText || text,
      interval: withInterval.interval,
      effort: withEffort.effort,
      totalMetres,
    }
  }

  const repetitions = dose[1] ? Number(dose[1]) : 1
  const distance = Number(dose[2])
  const wording = body.slice(dose[0].length)
  // Reps that swim a second leg ("+ 25 easy") cover more than reps × distance.
  const extra = [...wording.matchAll(EXTRA_DISTANCE)].reduce((sum, match) => sum + Number(match[1]), 0)
  return {
    kind: 'set',
    depth,
    repetitions,
    distance,
    label,
    dose: repetitions > 1 ? `${repetitions} × ${distance}` : `${distance}`,
    description: tidyDescription(wording),
    interval: reclassifyInterval(withInterval.interval, distance),
    effort: withEffort.effort,
    totalMetres: totalMetres ?? repetitions * (distance + extra),
  }
}

/** Build a row straight from an imported structured item — no guessing needed. */
export function rowFromItem(item, zones = []) {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'repeat') {
    const times = Number(item.repetitions) || 1
    return {
      kind: 'repeat', depth: 0, repetitions: times, distance: null, label: '',
      dose: `${times} ×`, description: 'rounds of', interval: null, effort: null, totalMetres: null,
    }
  }
  if (item.type === 'note') {
    return parseSetLine(item.text, zones) || {
      kind: 'note', depth: 0, repetitions: null, distance: null, dose: '', label: '',
      description: clean(item.text), interval: null, effort: null, totalMetres: null,
    }
  }
  if (item.type !== 'set') return null

  const repetitions = Number(item.repetitions) || 1
  const distance = Number(item.distance) || 0
  const wording = clean([item.stroke, item.description].filter(Boolean).join(' '))
  // A stand-in dose lets the same line parser lift any effort or clock the
  // coach typed into the description cell, judged against the real distance.
  const parsed = wording ? parseSetLine(`1 x ${distance || 100} ${wording}`, zones) : null
  const sendoffValue = normaliseClock(item.sendoff)
  const restValue = sendoffValue ? '' : normaliseClock(item.rest)
  const effortText = clean(item.effort)

  let effort = parsed?.effort || null
  if (effortText) {
    const numeric = Number(effortText.replace(/\s*\/\s*20$/, ''))
    effort = Number.isFinite(numeric)
      ? { kind: 'scale', value: numeric, scale: 20, label: `${numeric}/20`, zone: effort?.zone || null, colour: effort?.colour || null }
      : zoneFromWords(effortText, zones).effort
        || { kind: 'label', value: null, scale: null, label: effortText, zone: null, colour: null }
  }

  return {
    kind: 'set',
    depth: 0,
    repetitions,
    distance,
    label: '',
    dose: repetitions > 1 ? `${repetitions} × ${distance}` : `${distance}`,
    description: parsed?.description || tidyDescription(wording),
    interval: sendoffValue ? reclassifyInterval(sendOff(sendoffValue), distance)
      : restValue ? restFor(restValue)
      : parsed?.interval || null,
    effort,
    totalMetres: Number(item.total_metres) || repetitions * distance || null,
  }
}

/**
 * Every row for one group or sub-group, from whichever shape its sets took:
 * structured import items, an array of lines, or one newline-joined block.
 */
export function setRows(sets, zones = []) {
  if (!sets) return []
  if (Array.isArray(sets.items) && sets.items.length) {
    return sets.items.map(item => rowFromItem(item, zones)).filter(Boolean)
  }
  const lines = Array.isArray(sets) ? sets
    : typeof sets === 'string' ? sets.split('\n')
    : Array.isArray(sets.raw) ? sets.raw
    : typeof sets.raw === 'string' ? sets.raw.split('\n')
    : []
  return lines
    .flatMap(line => String(line ?? '').split('\n'))
    .map(line => parseSetLine(line, zones))
    .filter(Boolean)
}

/** Metres these rows add up to, counting rows inside a repeat block each round. */
export function rowsTotalMetres(rows) {
  let rounds = 1
  let total = 0
  for (const row of rows || []) {
    if (row.kind === 'repeat') {
      rounds = row.repetitions || 1
      continue
    }
    if (row.kind !== 'set' || !row.totalMetres) continue
    total += row.totalMetres * (row.depth ? rounds : 1)
    if (!row.depth) rounds = 1
  }
  return total
}
