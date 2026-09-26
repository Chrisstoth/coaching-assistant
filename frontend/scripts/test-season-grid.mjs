import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const { cellMarks, cellDetail, attendanceShare, initialOpenGroups } = await import('../src/seasonGrid.js')

// --- a cell shows what is different, most important first --------------------
const busy = {
  flags: ['Qualified for Regionals but not entered'],
  events: ['illness', 'illness'],
  away: ['exams'],
  meets: [{ name: 'County Champs', state: 'entered', events: ['100 Freestyle'] },
          { name: 'Regionals', state: 'planned', events: [] }],
}
assert.deepEqual(cellMarks(busy).map(m => m.symbol), ['⚑', '✚', '✕', '●', '◐'])
assert.equal(cellMarks(busy)[1].label, 'Ill', 'The same illness twice is one mark.')
assert.equal(cellMarks(busy)[2].label, 'Exams')
assert.equal(cellMarks(busy)[3].label, 'Entered: County Champs (100 Freestyle)')
assert.deepEqual(cellMarks(undefined), [], 'A quiet week has no marks.')

// --- what actually happened --------------------------------------------------
assert.equal(attendanceShare({ attendance: [2, 4] }), 0.5)
assert.equal(attendanceShare({}), null)
assert.deepEqual(cellDetail({ attendance: [3, 4], metres: 11500, hi_metres: 820 }),
  ['Trained 3 of 4 sessions', 'Swam 11.5km, 820m high intensity'])

// --- one group opens by itself; several start folded --------------------------
assert.deepEqual(initialOpenGroups([{ name: 'G1' }]), { G1: true })
assert.deepEqual(initialOpenGroups([{ name: 'G1' }, { name: 'G2' }]), {})

// --- wiring --------------------------------------------------------------------
const api = await read('../src/api.js')
assert.match(api, /getSeasonGrid: \(macroId\) => request\('GET', `\/season\/grid\?macro_id=/)
const workspace = await read('../src/pages/PlanningWorkspace.jsx')
assert.match(workspace, /<SeasonGrid /, 'The planning page offers the squad grid.')
assert.match(workspace, /'Squad & swimmers'/)
const grid = await read('../src/components/SeasonGrid.jsx')
assert.match(grid, /aria-expanded/, 'Groups open and close.')
assert.match(grid, /\/swimmers\/\$\{picked\.swimmer\.id\}/, 'A swimmer leads to their own page and plan.')

console.log('Season grid checks passed')
