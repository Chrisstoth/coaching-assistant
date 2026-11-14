// Notes during a session: a note can be about a set (any set, including one inside
// a round), dictating a swimmer's name tags them, and notes waiting for signal
// show beside the saved ones without doubling up.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mergeNotes, noteClock, noteSetOptions, setRefFor, setValueFor, swimmersNamed } from '../src/sessionNotes.js'

const here = dirname(fileURLToPath(import.meta.url))
const sample = JSON.parse(readFileSync(join(here, '..', '..', 'shared', 'notation', 'sessions', 's-261005-am.json'), 'utf8')).session

// Sets to pick from
const groups = noteSetOptions(sample)
assert.ok(groups.length > 0, 'the sample session has blocks to note against')
for (const g of groups) {
  assert.equal(g.options[0].value, `block:${g.block_id}`, 'each block can be noted as a whole')
  assert.ok(g.options.length > 1, `${g.block} lists its sets`)
}
const nested = groups.flatMap(g => g.options).find(o => o.depth > 1)
const round = sample.blocks.flatMap(b => b.items).find(n => n.t === 'round')
if (round) assert.ok(nested, 'sets inside a round are listed, so a tap in the poolside view finds them')
const someLine = groups[0].options[1]
const ref = setRefFor(groups, someLine.value)
assert.equal(ref.line_id, someLine.line_id)
assert.ok(ref.label.startsWith(groups[0].block), 'the stored label says which block it was in')
assert.equal(setValueFor(ref), someLine.value, 'a saved note finds its option again')
assert.equal(setRefFor(groups, ''), null)
assert.deepEqual(noteSetOptions(null), [])
assert.equal(JSON.stringify(sample), JSON.stringify(JSON.parse(readFileSync(join(here, '..', '..', 'shared', 'notation', 'sessions', 's-261005-am.json'), 'utf8')).session),
  'reading the sets never changes the session')

// Names in what was typed or said
const squad = [
  { id: 1, name: 'Amy Clarke' }, { id: 2, name: 'Ben Ward' }, { id: 3, name: 'Sam Jones' },
  { id: 4, name: 'Sam Patel' }, { id: 5, name: "Zoë O'Neill" }, { id: 6, name: 'Al Fox' },
]
assert.deepEqual(swimmersNamed('Amy breathing to the left again', squad), [1])
assert.deepEqual(swimmersNamed('amy and ben both held 1:20', squad), [1, 2], 'any case, several names')
assert.deepEqual(swimmersNamed('Sam was late', squad), [], 'two Sams: not guessed')
assert.deepEqual(swimmersNamed('Sam Patel was late', squad), [4], 'the full name settles it')
assert.deepEqual(swimmersNamed('Zoë flat today', squad), [5], 'accented names')
assert.deepEqual(swimmersNamed('Bench press', squad), [], 'part of a word is not a name')
assert.deepEqual(swimmersNamed('Amy’s turns were good', squad), [1], "a name followed by 's")
assert.deepEqual(swimmersNamed('', squad), [])

// Times and merging
assert.match(noteClock('2026-11-13T20:42:00Z'), /^\d\d:\d\d$/)
assert.equal(noteClock('nonsense'), '')
const saved = [{ id: 1, client_id: 'a', text: 'first', noted_at: '2026-11-13T20:40:00' }]
const waiting = [
  { client_id: 'a', text: 'first', noted_at: '2026-11-13T20:40:00.000Z' },
  { client_id: 'b', text: 'second', noted_at: '2026-11-13T20:45:00.000Z' },
]
const merged = mergeNotes(saved, waiting)
assert.deepEqual(merged.map(n => n.text), ['second', 'first'], 'newest first, a synced note shown once')
assert.equal(merged[0].pending, true)
assert.equal(merged[1].pending, undefined)

console.log('Session notes check passed')
