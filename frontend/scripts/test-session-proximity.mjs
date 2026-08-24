import assert from 'node:assert/strict'
import { isSessionNear, localDateKey, matchingWeeklySessions, proximateSessions } from '../src/sessionProximity.js'

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

const microcycles = [{ sessions: [
  { day: 'Monday AM', session_type: 'aerobic' },
  { day: 'Monday PM', session_type: 'threshold' },
] }]
assert.deepEqual(
  matchingWeeklySessions(microcycles, { time: '18:30' }, '2026-08-24').map(item => item.session_type),
  ['threshold'],
)

console.log('Session proximity checks passed')
