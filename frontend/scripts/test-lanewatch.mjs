import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const { defaultSelection, pairsToSave, signInErrorMessage } = await import('../src/laneWatch.js')

// --- pairing: only a name AND date of birth match starts ticked --------------
const suggestions = [
  { swimmer_id: 1, lanewatch_swimmer_id: 'a', confidence: 'name and date of birth' },
  { swimmer_id: 2, lanewatch_swimmer_id: 'b', confidence: 'name only' },
]
assert.deepEqual(defaultSelection(suggestions), { '1:a': true, '2:b': false })
assert.deepEqual(defaultSelection(null), {})

// Ticked suggestions plus manual picks, never two pairs for one swimmer.
assert.deepEqual(
  pairsToSave(suggestions, { '1:a': true, '2:b': false }, { c: '2', d: '1', e: '' }),
  [{ swimmer_id: 1, lanewatch_swimmer_id: 'a' }, { swimmer_id: 2, lanewatch_swimmer_id: 'c' }],
  'A swimmer already paired is not paired again; an empty pick is ignored.',
)
assert.deepEqual(pairsToSave([], {}, {}), [])

// --- sign-in problems read as plain English -------------------------------------
assert.match(signInErrorMessage({ code: 'auth/unauthorized-domain' }), /authorised domains/)
assert.match(signInErrorMessage({ code: 'auth/popup-closed-by-user' }), /closed/)
assert.equal(signInErrorMessage({ message: 'odd' }), 'odd')

// --- the sign-in is thrown away straight after --------------------------------
const helper = await read('../src/laneWatch.js')
assert.match(helper, /inMemoryPersistence/, 'Nothing of the LaneWatch sign-in is kept in this browser.')
assert.match(helper, /auth\.signOut\(session\)/)
assert.match(helper, /import\('firebase\/auth'\)/, 'Firebase only loads when the coach connects.')

const panel = await read('../src/components/LaneWatchPanel.jsx')
assert.match(panel, /api\.connectLaneWatch\(token\)/)
assert.match(panel, /api\.disconnectLaneWatch\(\)/)
assert.match(panel, /revoked_at_lanewatch/, 'The coach is told if LaneWatch could not be told.')
const settings = await read('../src/pages/Settings.jsx')
assert.match(settings, /<LaneWatchPanel \/>/)

console.log('LaneWatch checks passed')
