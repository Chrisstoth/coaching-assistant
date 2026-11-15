import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deskWeekStarts, deskWindow, isSessionNear, localDateKey, matchingWeeklySessions, proximateSessions, weekStartKey, weeklySessionQueue } from '../src/sessionProximity.js'

const mondayMorning = new Date(2026, 7, 24, 9, 30)
const mondayEvening = new Date(2026, 7, 24, 18, 0)

assert.equal(localDateKey(mondayMorning), '2026-08-24')
assert.equal(isSessionNear({ date: '2026-08-24', time: '06:00', status: 'active' }, mondayMorning), true)
assert.equal(isSessionNear({ date: '2026-08-24', time: '18:30', status: 'planned' }, mondayEvening), true)
assert.equal(isSessionNear({ date: '2026-08-24', time: '18:30', status: 'cancelled' }, mondayEvening), false)
assert.equal(isSessionNear({ date: '2026-08-25', time: '18:30', status: 'planned' }, mondayEvening), false)

const calendar = [{ date: '2026-08-24', items: [
  { slot_id: 1, time: '17:30', status: 'planned' },
  { session_id: 2, time: '19:00', status: 'active' },
  { session_id: 3, time: '20:00', status: 'cancelled' },
] }]
assert.deepEqual(proximateSessions(calendar, mondayEvening).map(item => item.session_id || item.slot_id), [2, 1])

const weeklyCalendar = [
  { date: '2026-08-24', items: [
    { slot_id: 1, time: '06:00', status: 'unlogged' },
    { session_id: 2, time: '20:30', status: 'completed' },
  ] },
  { date: '2026-08-25', items: [
    { slot_id: 3, time: '20:00', status: 'planned' },
    { slot_id: 4, time: '21:00', status: 'dismissed' },
  ] },
  { date: '2026-08-26', items: [{ slot_id: 5, time: '18:00', status: 'cancelled' }] },
]
assert.deepEqual(
  weeklySessionQueue(weeklyCalendar, mondayEvening).map(item => item.session_id || item.slot_id),
  [1, 3],
)

const microcycles = [{ sessions: [
  { day: 'Monday AM', session_type: 'aerobic' },
  { day: 'Monday PM', session_type: 'threshold' },
] }]
assert.deepEqual(
  matchingWeeklySessions(microcycles, { time: '18:30' }, '2026-08-24').map(item => item.session_type),
  ['threshold'],
)

// The desk is week-scoped, so it must ask the API for the week it will render.
// A bare /sessions/calendar call is cached under one key for every week, and the
// service worker will happily serve last week's reply into today's desk.
assert.equal(weekStartKey(new Date(2026, 8, 8, 7, 0)), '2026-09-07')   // Tuesday
assert.equal(weekStartKey(new Date(2026, 8, 7, 23, 59)), '2026-09-07') // Monday itself
assert.equal(weekStartKey(new Date(2026, 8, 13, 6, 0)), '2026-09-07')  // Sunday rolls back

const staleWeek = [{ date: '2026-08-31', items: [{ slot_id: 9, time: '06:00', status: 'unlogged' }] }]
assert.deepEqual(weeklySessionQueue(staleWeek, new Date(2026, 8, 8, 7, 0)), [])

// Sunday night planning Monday AM: the desk looks a couple of days ahead,
// into next week when it needs to.
const sundayNight = new Date(2026, 10, 15, 20, 30)
assert.deepEqual(deskWindow(sundayNight), { from: '2026-11-09', to: '2026-11-17' })
assert.deepEqual(deskWeekStarts(sundayNight), ['2026-11-09', '2026-11-16'])
const acrossWeeks = [
  { date: '2026-11-15', items: [{ slot_id: 1, time: '08:00', status: 'completed' }] },
  { date: '2026-11-16', items: [{ slot_id: 2, time: '05:30', status: 'unlogged' }] },
  { date: '2026-11-17', items: [{ slot_id: 3, time: '18:00', status: 'unlogged' }] },
  { date: '2026-11-18', items: [{ slot_id: 4, time: '18:00', status: 'unlogged' }] },
]
assert.deepEqual(weeklySessionQueue(acrossWeeks, sundayNight).map(item => item.slot_id), [2, 3])
// Saturday reaches Monday; midweek stays inside the week.
assert.deepEqual(deskWindow(new Date(2026, 10, 14, 9, 0)), { from: '2026-11-09', to: '2026-11-16' })
assert.deepEqual(deskWeekStarts(new Date(2026, 10, 11, 9, 0)), ['2026-11-09'])

for (const page of ['../src/pages/Dashboard.jsx', '../src/pages/TodaySession.jsx']) {
  const source = readFileSync(new URL(page, import.meta.url), 'utf8')
  assert.match(source, /getCalendar\(week/, `${page} must request the calendar by week start`)
}

// Someone else took it: it stays on the desk until it's over, then there's nothing to chase.
const covered = [{ date: '2026-08-24', items: [
  { session_id: 7, time: '06:00', end_time: '07:00', status: 'active', taken_by_other: true },
  { session_id: 8, time: '18:30', end_time: '19:30', status: 'active', taken_by_other: true },
  { session_id: 9, time: '06:00', end_time: '07:00', status: 'active' },
] }]
assert.deepEqual(weeklySessionQueue(covered, mondayMorning).map(item => item.session_id), [9, 8])

console.log('Session proximity checks passed')
