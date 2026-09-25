// Layout maths for the season timeline. Kept free of React so the shapes it
// derives — bands, curve segments, tick placement — can be tested directly.

// Fixed series order for pathway load lines. Validated for colour-vision
// separation and contrast against the pool-900 surface; assign in order and
// never cycle — a seventh pathway folds into "Other" rather than repeating.
export const SERIES_COLOURS = ['#0d9488', '#ea580c', '#3b82f6', '#db2777', '#65a30d', '#9333ea']
export const SERIES_LIMIT = SERIES_COLOURS.length

export function seriesColour(index) {
  return SERIES_COLOURS[index] ?? '#7f858c'
}

export const PHASE_BAR = {
  base: '#3b82f6', build: '#22c55e', peak: '#f97316', taper: '#eab308',
  competition: '#ef4444', recovery: '#14b8a6', transition: '#444444',
}

export function phaseBar(type) {
  return PHASE_BAR[type] || PHASE_BAR.transition
}

// Contiguous runs of weeks sharing a key — the macro / meso / micro bands.
// Returns [{ key, label, start, span, weeks }] with start as a week index.
export function bandRuns(weeks, keyFn, labelFn) {
  const runs = []
  weeks.forEach((week, index) => {
    const key = keyFn(week)
    const previous = runs[runs.length - 1]
    if (previous && previous.key === key && key !== null && key !== undefined) {
      previous.span += 1
      previous.weeks.push(week)
      return
    }
    runs.push({
      key,
      label: labelFn ? labelFn(week) : key,
      start: index,
      span: 1,
      weeks: [week],
    })
  })
  return runs
}

// Weeks carrying a value, split into runs so a blank week breaks the line
// rather than drawing a straight lie across it.
export function loadSegments(weeks, valueFn) {
  const segments = []
  let current = null
  weeks.forEach((week, index) => {
    const value = valueFn(week)
    if (value === null || value === undefined || Number.isNaN(value)) {
      current = null
      return
    }
    if (!current) {
      current = []
      segments.push(current)
    }
    current.push({ index, value, week })
  })
  return segments
}

export function pointFor({ index, value }, { columnWidth, height, padding = 0, max = 100 }) {
  const usable = height - padding * 2
  return {
    x: index * columnWidth + columnWidth / 2,
    y: padding + usable - (Math.max(0, Math.min(max, value)) / max) * usable,
  }
}

// Catmull-Rom through the points, converted to cubic beziers. The coach's
// spreadsheet reads as a smooth curve and the shape is the whole point, so a
// polyline would lose the sawtooth's character.
export function smoothPath(points, tension = 0.5) {
  if (!points.length) return ''
  if (points.length === 1) {
    const { x, y } = points[0]
    return `M ${round(x)} ${round(y)}`
  }
  let d = `M ${round(points[0].x)} ${round(points[0].y)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] || points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] || p2
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension
    d += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(p2.x)} ${round(p2.y)}`
  }
  return d
}

function round(n) {
  return Math.round(n * 100) / 100
}

export function weekLabel(isoDate) {
  if (!isoDate) return ''
  const d = new Date(`${isoDate}T00:00:00`)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

// Which week holds today, or -1 when the season has not started or has ended.
export function currentWeekIndex(weeks) {
  return weeks.findIndex(w => w.is_current)
}

// Series the chart should draw: the squad-wide line, plus a line per pathway
// that actually has figures against it.
export function buildSeries(timeline) {
  const weeks = timeline?.weeks || []
  const pathways = (timeline?.pathways || []).filter(p => p.has_load).slice(0, SERIES_LIMIT - 1)
  const series = []

  const hasOverall = weeks.some(w => w.load && w.load.overall !== null && w.load.overall !== undefined)
  if (hasOverall || !pathways.length) {
    series.push({
      id: 'overall',
      name: pathways.length ? 'Squad' : 'Load',
      colour: seriesColour(0),
      valueFn: w => (w.load ? w.load.overall : null),
    })
  }

  pathways.forEach((pathway, i) => {
    series.push({
      id: `pathway-${pathway.id}`,
      name: pathway.name,
      colour: seriesColour(i + 1),
      pathwayId: pathway.id,
      valueFn: w => {
        const row = w.load_by_pathway && w.load_by_pathway[String(pathway.id)]
        return row ? row.overall : null
      },
    })
  })

  return series
}
