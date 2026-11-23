import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const { callbackAddress, defaultSelection, pairsToSave, readCallback } = await import('../src/laneWatch.js')

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

// --- Connect with LaneWatch: the coach signs in on LaneWatch, never here ------
assert.equal(callbackAddress('https://deckxtra.netlify.app'), 'https://deckxtra.netlify.app/lanewatch/callback')
assert.deepEqual(readCallback('?code=abc&state=s1'), { state: 's1', code: 'abc', error: null })
assert.deepEqual(readCallback('?error=access_denied&state=s1'), { state: 's1', code: null, error: 'access_denied' })
assert.deepEqual(readCallback(''), { state: '', code: null, error: null })

const helper = await read('../src/laneWatch.js')
assert.doesNotMatch(helper, /firebase/i, 'No LaneWatch sign-in happens in this app any more.')

const callback = await read('../src/pages/LaneWatchCallback.jsx')
assert.match(callback, /api\.finishLaneWatchConnect\(answer\)/)
assert.match(callback, /history\.replaceState/, 'The one-time code is taken out of the address bar.')
const app = await read('../src/App.jsx')
assert.match(app, /<Route path="\/lanewatch\/callback" element={<LaneWatchCallback \/>} \/>/,
  'The return page works without being signed in here (a phone may open it in a separate view).')

const panel = await read('../src/components/LaneWatchPanel.jsx')
assert.match(panel, /api\.startLaneWatchConnect\(callbackAddress\(window\.location\.origin\)\)/)
assert.match(panel, /window\.location\.assign\(url\)/)
assert.doesNotMatch(panel, /password/i, 'No LaneWatch password is ever typed into this app.')
assert.match(panel, /api\.disconnectLaneWatch\(\)/)
assert.match(panel, /revoked_at_lanewatch/, 'The coach is told if LaneWatch could not be told.')
const settings = await read('../src/pages/Settings.jsx')
assert.match(settings, /<LaneWatchPanel \/>/)

console.log('LaneWatch checks passed')

// --- races are matched to the official swims ------------------------------------
const panelNow = await read('../src/components/LaneWatchPanel.jsx')
assert.match(panelNow, /api\.pairLaneWatchRaces\(\)/)
assert.match(panelNow, /api\.chooseLaneWatchRace\(swimTimeId, choice\.race\.lanewatch_log_id\)/,
  'When two swims are too close to call, the coach chooses.')
assert.match(await read('../src/pages/SwimmerDetail.jsx'), /t\.lanewatch_log_id &&/, 'A matched swim is marked.')
assert.match(await read('../src/pages/MeetDetail.jsx'), /row\.lanewatch_log_id &&/)
console.log('LaneWatch race matching checks passed')
