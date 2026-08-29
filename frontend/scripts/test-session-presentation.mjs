import assert from 'node:assert/strict'
import {
  buildSessionPrintHtml,
  energyPresentation,
  formatSetHtml,
} from '../src/sessionPresentation.js'

const custom = {
  club_name: 'Test Club',
  logo_data_url: 'data:image/png;base64,abc',
  terminology_name: 'Colour system',
  terminology_levels: [
    { id: 'red', label: 'Red', description: 'Hard aerobic power', colour: '#dc2626', canonical_zone: 'vo2' },
  ],
}

assert.equal(energyPresentation('vo2', custom).label, 'Red')
assert.match(formatSetHtml('8 x 100 free @ 1:30 Red (hold form)', custom), /set-dose/)
assert.match(formatSetHtml('8 x 100 free @ 1:30 Red (hold form)', custom), /set-sendoff/)
assert.match(formatSetHtml('8 x 100 free @ 1:30 Red (hold form)', custom), /set-energy/)
assert.match(formatSetHtml('8 x 100 free @ 1:30 Red (hold form)', custom), /<em>/)

const oneGroup = buildSessionPrintHtml({
  session: {
    title: '<script>alert(1)</script>',
    date: '2026-08-27',
    energy_system_focus: 'vo2',
    groups: [{ group_number: 1, description: 'Everyone', sets: { raw: '8 x 100 @ 1:30 Red' } }],
  },
  settings: custom,
  autoPrint: false,
})
assert.match(oneGroup, /groups-grid count-1/)
assert.match(oneGroup, /Whole squad/)
assert.match(oneGroup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
assert.doesNotMatch(oneGroup, /<script>alert\(1\)<\/script>/)

const oneUsedOfThree = buildSessionPrintHtml({
  session: { groups: { 1: { sets: ['400 easy'] }, 2: { sets: '' }, 3: { sets: '' } } },
  settings: custom,
  autoPrint: false,
})
assert.match(oneUsedOfThree, /groups-grid count-1/)
assert.match(oneUsedOfThree, /Whole squad/)
assert.doesNotMatch(oneUsedOfThree, /Group 2/)

const threeGroups = buildSessionPrintHtml({
  session: { groups: { 1: { sets: ['A'] }, 2: { sets: ['B'] }, 3: { sets: ['C'] } } },
  settings: custom,
  autoPrint: false,
})
assert.match(threeGroups, /groups-grid count-3/)
assert.match(threeGroups, /Group 1/)

console.log('session presentation checks passed')
