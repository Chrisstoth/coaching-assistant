import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const {
  isWorking, statusLine, pendingByLine, pendingCount, changeLabel, changedLineIds, offeredLesson, DECIDED_LABEL,
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
// Writing with the staff now happens inside the Session Builder: Jess drafts, the staff comment on lines.
const builderPage = await read('../src/pages/SessionBuilder.jsx')
assert.match(builderPage, /Draft with Jess/)
assert.match(builderPage, /api\.draftBuilderSession\(/)
assert.match(builderPage, /api\.reviewBuilderSession\(/)
const builderUi = await read('../src/notation/builderUi.js')
assert.match(builderUi, /data-cmt="accept">Accept<\/button>/)

// --- talking back, and remembering how the coach works -------------------------
assert.equal(offeredLesson({ lesson: 'Mixed sets', lesson_saved: false }), 'Mixed sets')
assert.equal(offeredLesson({ lesson: 'Mixed sets', lesson_saved: true }), '', 'Once kept, it is not offered again.')
assert.equal(offeredLesson({}), '')
assert.equal(DECIDED_LABEL.withdrawn, 'Withdrawn after your reply')
assert.match(api, /replyToWorkshopSuggestion/)
assert.match(api, /getCoachGuidance: \(\) => request\('GET', '\/coach-guidance'\)/)
assert.match(builderPage, /will remember this and stop raising it/, 'A dismissed preference, with a reason, is remembered.')
const settings = await read('../src/pages/Settings.jsx')
assert.match(settings, /<CoachGuidancePanel \/>/, 'The coach can see and change what the staff remember.')

console.log('Session workshop checks passed')
