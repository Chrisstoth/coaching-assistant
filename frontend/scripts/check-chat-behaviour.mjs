import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const coachAI = await readFile(new URL('../src/pages/CoachAI.jsx', import.meta.url), 'utf8')
const dashboard = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8')
const register = await readFile(new URL('../src/pages/Register.jsx', import.meta.url), 'utf8')
const cancellationDialog = await readFile(new URL('../src/components/SessionCancellationDialog.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')

assert.match(
  coachAI,
  /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/,
  'Chat Return must insert a newline; only Ctrl/Cmd+Enter should send.',
)
assert.match(coachAI, /recoverSavedReply/, 'Chat should recover replies saved after a dropped request.')
assert.match(coachAI, /athlete_profile_update/, 'Chat should offer a confirmed athlete profile update.')
assert.match(api, /updateAthleteProfileFromChat/, 'The athlete profile update API must be wired.')
assert.match(coachAI, /res\.cancellation_data/, 'Chat should open the confirmed session cancellation workflow.')
assert.match(dashboard, /SessionCancellationDialog/, 'The home session desk should expose session cancellation.')
assert.doesNotMatch(register, /getExpectedAttendance/, 'The register must not be filtered through usual attendance.')
assert.match(register, /How many different programmes are being done\?/, 'The register should ask for the session group structure when it is unknown.')
assert.match(register, /groupCount > 1/, 'Per-swimmer group controls should only appear for multi-group sessions.')
assert.match(coachAI, /How many different programmes were done\?/, 'The chat register should use the same group setup workflow.')
assert.match(cancellationDialog, /recurring timetable slot will stay in place/, 'Cancellation must explain that only one occurrence is affected.')

console.log('Chat behaviour checks passed')
