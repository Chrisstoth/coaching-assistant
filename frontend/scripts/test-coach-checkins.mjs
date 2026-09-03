import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = relative => fs.readFileSync(path.join(here, '..', relative), 'utf8')

const api = read('src/api.js')
const app = read('src/App.jsx')
const dashboard = read('src/pages/Dashboard.jsx')
const plan = read('src/pages/PlanHub.jsx')
const settings = read('src/pages/Settings.jsx')
const context = read('src/pages/CoachingContext.jsx')

for (const method of [
  'getCoachCheckInSettings', 'updateCoachCheckInSettings', 'getDueCoachCheckIns',
  'startCoachCheckIn', 'chatCoachCheckIn', 'completeCoachCheckIn', 'skipCoachCheckIn',
]) {
  assert.match(api, new RegExp(`\\b${method}:`), `Missing API method ${method}`)
}

assert.match(app, /path="\/coach-checkins"/)
assert.match(app, /path="\/coach-checkins\/:id"/)
assert.match(dashboard, /getDueCoachCheckIns/)
assert.match(dashboard, /CoachCheckInPrompts/)
assert.match(plan, /to="\/coach-checkins"/)
assert.match(settings, /monthly_reminder/)
assert.match(settings, /No reminders/)
assert.match(context, /lasting.*how and why/i)
assert.doesNotMatch(context, /Squad State Right Now/)

console.log('Coach check-in UI contract checks passed')
