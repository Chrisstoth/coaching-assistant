import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

process.env.TZ = 'Europe/London'

const { calendarDayLabel, localDateIso, mondayFor } = await import('../src/calendarDates.js')

const monday24August = new Date(2026, 7, 24, 0, 0, 0)
assert.equal(
  localDateIso(monday24August),
  '2026-08-24',
  'A BST local Monday must not be converted to the previous UTC Sunday.',
)
assert.equal(localDateIso(mondayFor(new Date(2026, 7, 30, 12))), '2026-08-24')
assert.equal(localDateIso(mondayFor(new Date(2026, 7, 31, 12))), '2026-08-31')
assert.match(calendarDayLabel('2026-08-24'), /^Monday 24 August$/)

const planHub = await readFile(new URL('../src/pages/PlanHub.jsx', import.meta.url), 'utf8')
assert.match(planHub, /to="\/calendar"[\s\S]*?>Calendar</, 'Plan should expose Calendar as its own action.')
assert.match(planHub, /to="\/session-planner"[\s\S]*?>Write Session</, 'Plan should expose Write Session separately.')

console.log('Calendar date and navigation checks passed')
