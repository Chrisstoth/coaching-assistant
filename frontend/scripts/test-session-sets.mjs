import assert from 'node:assert/strict'
import { parseSetLine, rowFromItem, setRows, rowsTotalMetres, normaliseClock } from '../src/sessionSets.js'

const zones = [
  { label: 'Recovery', colour: '#16a34a', canonical_zone: 'recovery' },
  { label: 'Aerobic', colour: '#2563eb', canonical_zone: 'aerobic' },
  { label: 'Threshold', colour: '#d97706', canonical_zone: 'threshold' },
  { label: 'Race pace', colour: '#7c3aed', canonical_zone: 'race_pace' },
  { label: 'Red', colour: '#dc2626', canonical_zone: 'vo2' },
]

const parse = line => parseSetLine(line, zones)

// The dose is read off the left of the row, whatever shorthand the coach used.
assert.deepEqual(
  (({ dose, repetitions, distance }) => ({ dose, repetitions, distance }))(parse('8 x 100 free @ 1:30')),
  { dose: '8 × 100', repetitions: 8, distance: 100 },
)
assert.equal(parse('400 easy').dose, '400')
assert.equal(parse('8x50m fly').dose, '8 × 50')

// A send-off and a prescribed rest share the right-hand column but stay distinct.
assert.deepEqual(parse('8 x 100 free @ 1:30').interval, { kind: 'send-off', value: '1:30', label: '@ 1:30' })
assert.equal(parse('6 x 50 Red off 1:10').interval.kind, 'send-off')
assert.deepEqual(parse('6 x 50 kick with 20s rest').interval, { kind: 'rest', value: '20s', label: 'rest 20s' })
assert.equal(parse('10 x 25 fast r15').interval.kind, 'rest')
assert.equal(parse('200 IM drill, 20 seconds rest').interval.value, '20s')
assert.equal(parse('5 x 200 RPE 7 rest 0:30').interval.value, '30s')
assert.equal(parse('16 x 50 @ 45-50').interval.value, '45s–50s')
assert.equal(parse('400 steady').interval, null, 'a set may prescribe no clock at all')

// Bare seconds are a clock; 90 seconds reads back as 1:30.
assert.equal(normaliseClock('90'), '1:30')
assert.equal(normaliseClock('0:20'), '20s')
assert.equal(parse('2 x 400 pull @ 90').interval.kind, 'rest',
  'no 400 goes on a 90-second send-off, so that clock is rest written in send-off shorthand')
assert.equal(parse('8 x 50 @ 45').interval.kind, 'send-off')

// Effort is isolated into its own field, out of the wording, however it is written.
assert.equal(parse('8 x 100 free @ 1:30 Threshold').effort.zone, 'threshold')
assert.equal(parse('8 x 100 free @ 1:30 Threshold').description, 'free')
assert.equal(parse('3 x 800 aerobic').effort.label, 'Aerobic')
assert.equal(parse('3 x 800 aerobic').description, '', 'a trailing zone word moves out of the wording')
assert.equal(parse('8x50 @ race pace 1:00').description, '')
assert.equal(parse('4 x 200 build to threshold @ 3:00').description, 'build to threshold')
assert.equal(parse('8 x 100 | effort 14/20').effort.value, 14)
assert.equal(parse('8 x 100 | effort 14/20').effort.scale, 20)
assert.equal(parse('5 x 200 RPE 7 rest 0:30').effort.label, 'RPE 7')
assert.equal(parse('4 x 100 IM 85% effort').effort.value, 85)
assert.equal(parse('4 x 100 IM 85% effort').description, 'IM')
assert.equal(parse('400 easy').effort, null)

// A zone named "Recovery" is never mistaken for a rest instruction.
const coolDown = parse('Cool down 200 Recovery')
assert.equal(coolDown.interval, null)
assert.equal(coolDown.effort.zone, 'recovery')
assert.equal(coolDown.dose, '200')
assert.equal(coolDown.label, 'Cool down')

// Headings, repeat blocks and unmeasured notes each keep their own shape.
assert.equal(parse('Main set:').kind, 'heading')
assert.equal(parse('3x:').kind, 'repeat')
assert.equal(parse('3x:').repetitions, 3)
assert.equal(parse('TBC').kind, 'note')
assert.equal(parse('Descend 1-4').kind, 'note', 'a rep range is not a distance')
assert.equal(parse('   '), null)

// Metres: reps × distance, plus any second leg swum inside the rep.
assert.equal(parse('8 x 100 free').totalMetres, 800)
assert.equal(parse('4 x 25 fast + 25 easy').totalMetres, 200)
assert.equal(parse('6 x 50 build | 300m').totalMetres, 300, 'a stated total wins over the derived one')

// An imported row needs no guessing — its columns are already separate.
const imported = rowFromItem({
  type: 'set', repetitions: 8, distance: 100, stroke: 'free',
  description: 'build to threshold', sendoff: '1:30', effort: '14', total_metres: 800,
}, zones)
assert.equal(imported.dose, '8 × 100')
assert.equal(imported.description, 'free build to threshold',
  'a zone named mid-sentence stays in the wording even though the effort column now carries it')
assert.equal(imported.effort.label, '14/20')
assert.equal(imported.effort.zone, 'threshold')
assert.deepEqual(imported.interval, { kind: 'send-off', value: '1:30', label: '@ 1:30' })
assert.equal(imported.totalMetres, 800)

const restOnly = rowFromItem({ type: 'set', repetitions: 6, distance: 50, description: 'kick', rest: '20' }, zones)
assert.deepEqual(restOnly.interval, { kind: 'rest', value: '20s', label: 'rest 20s' })

// Sets reach us as import items, as an array of lines, or as one text block.
const fromItems = setRows({ items: [{ type: 'repeat', repetitions: 3 }, { type: 'set', repetitions: 4, distance: 100 }] }, zones)
assert.deepEqual(fromItems.map(row => row.kind), ['repeat', 'set'])
assert.equal(setRows(['400 easy', '8 x 50 @ 1:00'], zones).length, 2)
assert.equal(setRows({ raw: '400 easy\n8 x 50 @ 1:00' }, zones).length, 2)
assert.equal(setRows('400 easy\n\n8 x 50 @ 1:00', zones).length, 2, 'blank lines are dropped')
assert.deepEqual(setRows(null, zones), [])

// A repeat block multiplies the rows indented beneath it.
const block = setRows({ raw: ['400 choice', '3x:', '  4 x 100 free', '  200 easy', '200 easy'].join('\n') }, zones)
assert.equal(rowsTotalMetres(block), 400 + 3 * (400 + 200) + 200)

console.log('session set checks passed')
