import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sharedWarmCool, swimmerNotes, buildSessionPrintHtml } from '../src/sessionPresentation.js'
import { splitCompoundLine, setRows } from '../src/sessionSets.js'

// --- one line, two swims ------------------------------------------------------
assert.deepEqual(splitCompoundLine('Warm up: 400 easy choice, 4x100 IM drill/swim @1:50'),
  ['Warm up: 400 easy choice', '4x100 IM drill/swim @1:50'])
assert.deepEqual(splitCompoundLine('6x50 kick, 15m underwater off every wall'), ['6x50 kick, 15m underwater off every wall'],
  'A 15m instruction is not a swim of its own.')
assert.deepEqual(splitCompoundLine('8x200 free @2:50, hold 2:18-2:20'), ['8x200 free @2:50, hold 2:18-2:20'])
assert.deepEqual(splitCompoundLine('6x100 @1:30, 85% effort'), ['6x100 @1:30, 85% effort'])
const rows = setRows('Warm up: 400 easy choice, 4x100 IM drill/swim @1:50')
assert.deepEqual(rows.map(r => r.dose), ['400', '4 × 100'])
assert.equal(rows[1].interval?.value, '1:50')
assert.equal(setRows('8x200 free @2:50 threshold, hold 2:18-2:20')[0].description.includes(' ,'), false)

// --- the warm-up and cool-down print once, above the sets ------------------------
const newStyle = [
  { group_number: 1, sets: 'Warm up: 400 easy\n8x200 @2:50\nCool down: 200 easy' },
  { group_number: 2, sets: 'Warm up: 400 easy\n6x200 @3:10\nCool down: 200 easy' },
]
const lifted = sharedWarmCool(newStyle)
assert.deepEqual(lifted.warm, ['400 easy'])
assert.deepEqual(lifted.cool, ['200 easy'])
assert.deepEqual(lifted.groups.map(g => g.sets), ['8x200 @2:50', '6x200 @3:10'])

const oldStyle = [
  { group_number: 1, sets: 'Warm up: 400 easy\n8x200 @2:50' },
  { group_number: 2, sets: '6x200 @3:10\nCool down: 200 easy' },
]
const old = sharedWarmCool(oldStyle)
assert.deepEqual([old.warm, old.cool], [['400 easy'], ['200 easy']], 'Older saves put them in the first and last set.')

const different = [
  { group_number: 1, sets: 'Warm up: 400 easy\n8x200' },
  { group_number: 2, sets: 'Warm up: 200 easy\n6x200' },
]
assert.deepEqual(sharedWarmCool(different).warm, [], 'Different warm-ups stay with their set.')
assert.deepEqual(sharedWarmCool([newStyle[0]]).warm, [], 'One set: nothing to lift.')

// --- swimmer notes reach the sheet ------------------------------------------------
assert.deepEqual(swimmerNotes({ individual_mods: { 'Nia Hart': 'Taper', 'Leo Park': '  ' } }), [{ name: 'Nia Hart', note: 'Taper' }])
const html = buildSessionPrintHtml({
  session: { title: 'T', date: '2026-09-29', groups: { 1: newStyle[0], 2: newStyle[1] }, individual_mods: { 'Nia Hart': 'Taper: halve the main set' } },
  settings: {}, autoPrint: false,
})
assert.match(html, /Warm up · everyone/)
assert.match(html, /Swimmer notes/)
assert.match(html, /Taper: halve the main set/)
assert.equal((html.match(/400/g) || []).length, 1, 'The warm-up is printed once, not in every set.')

// --- each set's workload includes the warm-up and cool-down when saved --------------
const planner = await readFile(new URL('../src/pages/SessionPlanner.jsx', import.meta.url), 'utf8')
assert.match(planner, /if \(parsed\.warm_up\) lines\.push\(`Warm up: \$\{parsed\.warm_up\}`\)/)
assert.doesNotMatch(planner, /index === 0 && parsed\.warm_up/)

console.log('Session print checks passed')
