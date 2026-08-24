import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const coachAI = await readFile(new URL('../src/pages/CoachAI.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')

assert.match(
  coachAI,
  /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/,
  'Chat Return must insert a newline; only Ctrl/Cmd+Enter should send.',
)
assert.match(coachAI, /recoverSavedReply/, 'Chat should recover replies saved after a dropped request.')
assert.match(coachAI, /athlete_profile_update/, 'Chat should offer a confirmed athlete profile update.')
assert.match(api, /updateAthleteProfileFromChat/, 'The athlete profile update API must be wired.')

console.log('Chat behaviour checks passed')
