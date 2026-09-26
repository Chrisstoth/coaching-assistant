import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const {
  isWorking, statusLine, pendingByLine, pendingCount, changeLabel, changedLineIds,
} = await import('../src/sessionWorkshop.js')

// --- what the coach is told while it happens ---------------------------------
assert.equal(isWorking('drafting'), true)
assert.equal(isWorking('ready'), false)
assert.match(statusLine({ status: 'drafting' }), /drafting from your brief and the plan/)
assert.match(statusLine({ status: 'reviewing', voices: [{ status: 'thinking' }, { status: 'done' }] }), /1 still looking/)
const suggestions = [
  { id: 'a', line_id: 'L1', status: 'pending', change: 'replace', text: '6x100' },
  { id: 'b', line_id: 'L1', status: 'pending', change: 'replace', text: '8x100 at 1:12' },
  { id: 'c', line_id: 'L2', status: 'accepted', change: 'remove', text: '' },
]
assert.equal(statusLine({ status: 'ready', suggestions }), '2 suggestions waiting for you. Nothing changes until you accept.')
assert.equal(statusLine({ status: 'failed', error: 'The draft could not be written: timeout' }),
  'The draft could not be written: timeout')

// --- suggestions sit on their line; two on one line is the coach's call --------
assert.deepEqual(Object.keys(pendingByLine(suggestions)), ['L1'])
assert.equal(pendingByLine(suggestions).L1.length, 2)
assert.equal(pendingCount(suggestions), 2)
assert.equal(changeLabel({ change: 'remove' }), 'Take this line out')
assert.equal(changeLabel({ change: 'add_after', text: '4x25 fast' }), 'Add after: 4x25 fast')

// --- an accepted change is highlighted -----------------------------------------
const before = { sections: [{ lines: [{ id: 'L1', text: '8x100' }, { id: 'L2', text: 'kick' }] }] }
const after = { sections: [{ lines: [{ id: 'L1', text: '6x100' }, { id: 'L2', text: 'kick' }, { id: 'L3', text: 'new' }] }] }
assert.deepEqual(changedLineIds(before, after), ['L1', 'L3'])
assert.deepEqual(changedLineIds(null, after), [], 'Nothing flashes on first load.')

// --- wiring -------------------------------------------------------------------
const api = await read('../src/api.js')
assert.match(api, /startSessionWorkshop: \(data\) => request\('POST', '\/session-workshops', data\)/)
assert.match(api, /decideWorkshopSuggestion/)
const planner = await read('../src/pages/SessionPlanner.jsx')
assert.match(planner, /Write it with the staff \(live\)/)
assert.match(planner, /<LiveSessionWorkshop workshopId=\{workshopId\} onUse=\{useWorkshop\}/)
const live = await read('../src/components/LiveSessionWorkshop.jsx')
assert.match(live, /Accept<\/button>/)
assert.match(live, /Reject/)
assert.match(live, /finishSessionWorkshop/, 'The finished session goes to the planner to save.')

console.log('Session workshop checks passed')
