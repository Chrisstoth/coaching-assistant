import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

process.env.TZ = 'Europe/London'

const {
  bandRuns, loadSegments, smoothPath, pointFor, buildSeries,
  currentWeekIndex, seriesColour, SERIES_COLOURS, SERIES_LIMIT,
} = await import('../src/seasonTimeline.js')

const weeks = [
  { week_start: '2026-08-31', macro_seq: 1, block_seq: 1, micro_index: 1, is_current: false, load: { overall: 30 } },
  { week_start: '2026-09-07', macro_seq: 1, block_seq: 1, micro_index: 2, is_current: false, load: { overall: 50 } },
  { week_start: '2026-09-14', macro_seq: 1, block_seq: 1, micro_index: 3, is_current: true,  load: { overall: 70 } },
  { week_start: '2026-09-21', macro_seq: 1, block_seq: 2, micro_index: 1, is_current: false, load: null },
  { week_start: '2026-09-28', macro_seq: 1, block_seq: 2, micro_index: 2, is_current: false, load: { overall: 60 } },
  { week_start: '2026-10-05', macro_seq: 2, block_seq: 1, micro_index: 1, is_current: false, load: { overall: 40 } },
]

// Bands collapse contiguous weeks so a macro spanning five weeks draws once.
const macroBands = bandRuns(weeks, w => w.macro_seq)
assert.equal(macroBands.length, 2)
assert.deepEqual(
  macroBands.map(b => [b.key, b.start, b.span]),
  [[1, 0, 5], [2, 5, 1]],
  'A macro band must span every one of its weeks and start at the right column.',
)

const mesoBands = bandRuns(weeks, w => `${w.macro_seq}.${w.block_seq}`)
assert.deepEqual(mesoBands.map(b => b.span), [3, 2, 1], 'Mesos must split inside their macro.')

// A week with no agreed figure breaks the line rather than interpolating one.
const segments = loadSegments(weeks, w => (w.load ? w.load.overall : null))
assert.equal(segments.length, 2, 'A blank week must split the curve into two segments.')
assert.deepEqual(segments[0].map(p => p.value), [30, 50, 70])
assert.deepEqual(segments[1].map(p => p.value), [60, 40])
assert.deepEqual(segments[1].map(p => p.index), [4, 5], 'Segments must keep their absolute week index.')

// A zero is a real figure — an off week — and must not be dropped as falsy.
const withZero = loadSegments(
  [{ load: { overall: 0 } }, { load: { overall: 40 } }],
  w => (w.load ? w.load.overall : null),
)
assert.equal(withZero.length, 1, 'A load of 0 is a planned rest week, not a gap.')

const geom = { columnWidth: 20, height: 100, padding: 10, max: 100 }
assert.deepEqual(pointFor({ index: 0, value: 100 }, geom), { x: 10, y: 10 }, 'Full load sits at the top of the plot.')
assert.deepEqual(pointFor({ index: 0, value: 0 }, geom), { x: 10, y: 90 }, 'Zero load sits on the baseline.')
assert.deepEqual(pointFor({ index: 2, value: 50 }, geom), { x: 50, y: 50 })
// Out-of-range values are clamped rather than drawn outside the plot.
assert.equal(pointFor({ index: 0, value: 140 }, geom).y, 10)

const path = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }])
assert.match(path, /^M 0 0 C /, 'The curve must start with a move then bezier segments.')
assert.equal(smoothPath([]), '', 'No points must not produce a stray path.')
assert.equal(smoothPath([{ x: 5, y: 5 }]), 'M 5 5', 'A lone point draws a move only.')

assert.equal(currentWeekIndex(weeks), 2)
assert.equal(currentWeekIndex(weeks.map(w => ({ ...w, is_current: false }))), -1)

// Series: squad-wide alone when no pathway carries figures.
const soloSeries = buildSeries({ weeks, pathways: [] })
assert.equal(soloSeries.length, 1)
assert.equal(soloSeries[0].name, 'Load', 'A single series needs no legend, so it is not named after a group.')

const pathwayWeeks = weeks.map(w => ({
  ...w,
  load_by_pathway: { 7: { overall: 55 }, 9: { overall: 80 } },
}))
const multiSeries = buildSeries({
  weeks: pathwayWeeks,
  pathways: [
    { id: 7, name: 'Nationals', has_load: true },
    { id: 9, name: 'Regionals', has_load: true },
    { id: 11, name: 'County', has_load: false },
  ],
})
assert.deepEqual(multiSeries.map(s => s.name), ['Squad', 'Nationals', 'Regionals'],
  'Only pathways carrying figures get a line.')
assert.equal(multiSeries[1].valueFn(pathwayWeeks[0]), 55)
assert.equal(multiSeries[2].valueFn(pathwayWeeks[0]), 80)
// Colour follows the entity in fixed order, so filtering one out never repaints the rest.
assert.equal(multiSeries[1].colour, SERIES_COLOURS[1])
assert.equal(multiSeries[2].colour, SERIES_COLOURS[2])
assert.notEqual(seriesColour(SERIES_LIMIT), SERIES_COLOURS[0], 'Series colours must not cycle.')

const component = await readFile(new URL('../src/components/SeasonTimeline.jsx', import.meta.url), 'utf8')
assert.match(component, /md:hidden/, 'The timeline must render weeks as rows on a phone.')
assert.match(component, /hidden md:/, 'The timeline must render weeks as columns on a wide screen.')
assert.match(component, /coach_overrode/, 'A coach override must be visible on the chart.')

const seasonPlan = await readFile(new URL('../src/pages/SeasonPlan.jsx', import.meta.url), 'utf8')
assert.match(seasonPlan, /<SeasonTimeline/, 'The season page must show the timeline.')

console.log('Season timeline checks passed')
