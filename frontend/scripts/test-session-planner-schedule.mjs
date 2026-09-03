import assert from 'node:assert/strict'
import { buildSessionOccurrences, nextSessionIndex } from '../src/sessionPlannerSchedule.js'

const slots = [
  { id: 1, day_of_week: 0, time: '05:30', label: 'Monday AM' },
  { id: 2, day_of_week: 0, time: '19:15', label: 'Monday PM' },
  { id: 3, day_of_week: 1, time: '06:00', label: 'Tuesday AM' },
]

const mondayMorning = new Date(2026, 7, 24, 4, 0)
const occurrences = buildSessionOccurrences(slots, mondayMorning, 0, 1)

assert.deepEqual(
  occurrences.map(occurrence => occurrence.key),
  ['2026-08-24-1', '2026-08-24-2', '2026-08-25-3'],
)
assert.equal(nextSessionIndex(occurrences, mondayMorning), 0)
assert.equal(nextSessionIndex(occurrences, new Date(2026, 7, 24, 6, 0)), 1)

const dstWeekend = buildSessionOccurrences(
  [{ id: 4, day_of_week: 6, time: '06:00', label: 'Sunday AM' }],
  new Date(2026, 9, 24, 12, 0),
  0,
  2,
)
assert.equal(dstWeekend[0].date, '2026-10-25')

console.log('Session planner schedule checks passed')
