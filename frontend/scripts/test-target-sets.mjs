import assert from 'node:assert/strict'

const {
  parseOffsets, offsetsToText, draftFromSet, payloadFromDraft, toggleStroke, filterSwimmers, countTimes, DEFAULT_DRAFT,
} = await import('../src/targetSets.js')

// The coach's recipe: PB pace, +0.5 and +1.0.
assert.deepEqual(parseOffsets('0, 0.5, 1.0'), { offsets: [0, 0.5, 1], error: null })
assert.deepEqual(parseOffsets('PB +0.5 +1').offsets, [0, 0.5, 1])
assert.deepEqual(parseOffsets('0, 0, 1').offsets, [0, 1], 'Repeats are dropped.')
assert.equal(parseOffsets('0, fast').error, '"fast" isn\'t a number of seconds')
assert.ok(parseOffsets('').error)
assert.ok(parseOffsets('0 1 2 3 4 5 6').error, 'Seven times is too many.')
assert.equal(offsetsToText([0, 0.5, 1]), '0, 0.5, 1.0')
assert.equal(offsetsToText([-0.5, 0.25]), '-0.5, 0.25')

const { payload, error } = payloadFromDraft(DEFAULT_DRAFT)
assert.equal(error, null)
assert.deepEqual(payload, {
  name: '', squad: null, base_distance: 100, rep_distance: 25, offsets: [0, 0.5, 1], course: 'SCM', strokes: null, decimals: 1,
})

const saved = { name: 'Back 25s', squad: 'Silver 1', base_distance: null, rep_distance: 50, offsets: [0, 1], course: 'LCM', strokes: ['Backstroke'], decimals: 2 }
const round = payloadFromDraft(draftFromSet(saved)).payload
assert.deepEqual(round, saved, 'A saved set comes back unchanged through the form.')

assert.deepEqual(toggleStroke(null, 'Butterfly'), ['Butterfly'])
assert.deepEqual(toggleStroke(['Butterfly'], 'Freestyle'), ['Freestyle', 'Butterfly'], 'Strokes keep pool order.')
assert.equal(toggleStroke(['Butterfly'], 'Butterfly'), null, 'None picked means their target events.')

const swimmers = [
  { id: 1, name: 'Mia Cole', rows: [{ times: [{}] }, { times: [] }] },
  { id: 2, name: 'Sam Ode', rows: [] },
]
assert.deepEqual(filterSwimmers(swimmers, 'mia').map(s => s.id), [1])
assert.equal(filterSwimmers(swimmers, '').length, 2)
assert.equal(countTimes(swimmers), 1)

console.log('Target set checks passed')

const { addSessionTarget, removeSessionTarget, swimmersFromLabel, sessionLabel } = await import('../src/targetSets.js')
const links = [{ target_set_id: 1, note: null }]
assert.deepEqual(addSessionTarget(links, 2, ' Main set 16 x 25 '), { targets: [
  { target_set_id: 1, note: null }, { target_set_id: 2, note: 'Main set 16 x 25' }] })
assert.deepEqual(addSessionTarget(links, 1, 'Kick').targets, [{ target_set_id: 1, note: 'Kick' }], 'Adding again updates the note.')
assert.deepEqual(removeSessionTarget(links, 1), { targets: [] })
assert.equal(swimmersFromLabel('register'), 'Swimmers on the register')
assert.equal(sessionLabel({ date: '2026-11-12', start_time: '06:00', title: 'Speed' }), 'Thu 12 Nov · 06:00 · Speed')
console.log('Session target checks passed')
