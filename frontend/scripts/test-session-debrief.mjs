import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = relative => fs.readFileSync(path.join(here, '..', relative), 'utf8')

const api = read('src/api.js')
const app = read('src/App.jsx')
const debrief = read('src/pages/SessionDebrief.jsx')
const dashboard = read('src/pages/Dashboard.jsx')
const sessionDetail = read('src/pages/SessionDetail.jsx')
const register = read('src/pages/Register.jsx')
const overlay = read('src/components/RegisterSavedOverlay.jsx')
const coachAI = read('src/pages/CoachAI.jsx')
const voiceHook = read('src/hooks/useWhisperVoice.js')

for (const method of [
  'getSessionDebriefs', 'startSessionDebrief', 'getSessionDebrief',
  'sendDebriefMessage', 'completeSessionDebrief', 'commitSessionDebrief',
  'getSessionsAwaitingDebrief',
]) {
  assert.match(api, new RegExp(`\\b${method}:`), `Missing API method ${method}`)
}

// Routes: the page is reachable both fresh and by id.
assert.match(app, /path="\/debrief"/)
assert.match(app, /path="\/debrief\/:id"/)

// Entry points: session page, Today card, and straight after saving a register.
assert.match(sessionDetail, /\/debrief\?session=/, 'Session page needs a debrief link')
assert.match(dashboard, /SessionDebriefPrompts/)
assert.match(dashboard, /getSessionsAwaitingDebrief/)
assert.match(register, /\/debrief\?session=/, 'Register should offer the debrief after saving')
assert.match(overlay, /onDebrief/)

// Voice input is shared, not duplicated.
assert.match(voiceHook, /transcribeAudio/)
assert.doesNotMatch(coachAI, /function useWhisperVoice/, 'CoachAI should import the shared hook')
assert.match(coachAI, /from '\.\.\/hooks\/useWhisperVoice'/)
assert.match(debrief, /useWhisperVoice/)

// Review-before-commit is the whole point: nothing may auto-save.
assert.match(debrief, /commitSessionDebrief/)
assert.match(debrief, /Drop this/, 'Each proposal must be rejectable')
assert.match(debrief, /Edit wording/, 'The coach must be able to correct wording')
assert.match(debrief, /until you save/i, 'The screen must say nothing is saved yet')
assert.match(debrief, /low confidence/, 'Low-confidence extractions must be flagged')

// The background write-up must not trap the coach on the page.
assert.match(debrief, /status === 'processing'/)
assert.match(debrief, /background/i)

// The register box is attendance logistics now, not training response.
assert.match(register, /Attendance note/i)
assert.doesNotMatch(register, /What did you observe against the watchpoint\?/)
assert.match(register, /in the debrief/, 'Watchpoints should point at the debrief')

console.log('Session debrief UI contract checks passed')
