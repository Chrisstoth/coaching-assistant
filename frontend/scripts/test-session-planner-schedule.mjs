import assert from 'node:assert/strict'
import {
  buildSessionOccurrences,
  indexSessionsByOccurrence,
  nextSessionIndex,
  occurrenceKey,
  occurrenceRange,
} from '../src/sessionPlannerSchedule.js'

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

assert.deepEqual(occurrenceRange(occurrences), { date_from: '2026-08-24', date_to: '2026-08-25' })
assert.equal(occurrenceRange([]), null)

// Saved sessions are matched back to the occurrence they belong to, so the
// planner shows a record instead of offering a blank page over the top.
const index = indexSessionsByOccurrence([
  { id: 7, date: '2026-08-24', pool_slot_id: 1, has_plan: true },
  { id: 8, date: '2026-08-25', pool_slot_id: 3, has_plan: false },
  { id: 9, date: '2026-08-26', pool_slot_id: null, has_plan: true },
  { id: 10, pool_slot_id: 2, has_plan: true },
])
assert.equal(index['2026-08-24-1'].id, 7)
assert.equal(index['2026-08-25-3'].has_plan, false)
assert.equal(index[occurrenceKey('2026-08-26', null)].id, 9)
assert.equal(Object.keys(index).length, 3, 'a session with no date is ignored')

// Where an occurrence somehow holds two rows, the planned one is the record.
const contested = indexSessionsByOccurrence([
  { id: 11, date: '2026-08-24', pool_slot_id: 1, has_plan: false },
  { id: 12, date: '2026-08-24', pool_slot_id: 1, has_plan: true },
])
assert.equal(contested['2026-08-24-1'].id, 12)

console.log('Session planner schedule checks passed')
