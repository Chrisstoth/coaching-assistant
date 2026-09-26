import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const {
  threadNotes, mergeConversation, draftTopic, staffStyle, STAFF_ORDER, STAFF_STYLES,
  decisionSummary, sessionTopic, workInText,
} = await import('../src/staffRoom.js')

// --- threads: a reply sits under what it answers, however deep -------------
const notes = [
  { id: 1, role: 'physiologist', parent_id: null, created_at: '2026-09-26T10:00:05' },
  { id: 2, role: 'manager', parent_id: 1, created_at: '2026-09-26T10:00:06' },     // consulted
  { id: 3, role: 'analyst', parent_id: null, created_at: '2026-09-26T10:00:05' },
  { id: 4, role: 'manager', parent_id: 2, created_at: '2026-09-26T10:05:00' },     // reply to the consult
  { id: 5, role: 'planner', parent_id: 99, created_at: '2026-09-26T10:06:00' },    // parent not loaded
]
const threads = threadNotes(notes)
assert.deepEqual(threads.map(t => t.note.id), [1, 3, 5])
assert.deepEqual(threads[0].replies.map(n => n.id), [2, 4], 'Replies of replies stay in the thread.')
assert.deepEqual(threads[2].replies, [], 'A note whose parent is missing stands alone rather than vanishing.')
assert.deepEqual(threadNotes([]), [])

// A parent loop in bad data must not hang the page.
assert.equal(threadNotes([{ id: 7, parent_id: 8 }, { id: 8, parent_id: 7 }]).length > 0, true)

// --- one conversation: staff speak straight after the exchange that prompted them
const messages = [
  { id: 'a', role: 'user', message: 'Put Ruby on full load', created_at: '2026-09-26T10:00:00' },
  { id: 'b', role: 'assistant', message: 'Done', created_at: '2026-09-26T10:00:04' },
  { id: 'c', role: 'user', message: 'Next', created_at: '2026-09-26T10:10:00' },
  { id: 'local-1', role: 'user', message: 'just sent' },
]
const merged = mergeConversation(messages, notes.slice(0, 3))
assert.deepEqual(
  merged.map(i => (i.type === 'message' ? i.message.id : `staff-${i.thread.note.id}`)),
  ['a', 'b', 'staff-1', 'staff-3', 'c', 'local-1'],
  'Staff points follow the reply they respond to; an unsaved message goes last.',
)
const tie = mergeConversation(
  [{ id: 'm', role: 'assistant', message: 'x', created_at: '2026-09-26T10:00:05' }],
  [{ id: 9, role: 'analyst', created_at: '2026-09-26T10:00:05' }],
)
assert.equal(tie[0].type, 'message', 'On a tie the lead assistant speaks before the staff.')

// --- what the staff are told about a draft ---------------------------------
const topic = draftTopic({
  heading: 'Proposed blocks for this macrocycle', title: 'Autumn', note: 'Aerobic first.',
  items: [{ title: 'Base', detail: 'base · 6w', body: 'Volume' }, { title: 'Build', detail: null, body: null }],
})
assert.match(topic, /^Proposed blocks for this macrocycle: Autumn/)
assert.match(topic, /- Base \(base · 6w\): Volume/)
assert.match(topic, /- Build$/m)
assert.equal(draftTopic(null), '')

// --- identity is never colour alone ----------------------------------------
assert.deepEqual(STAFF_ORDER, ['physiologist', 'analyst', 'planner', 'manager', 'meets', 'sessions'])
for (const role of STAFF_ORDER) {
  assert.ok(STAFF_STYLES[role].title && STAFF_STYLES[role].initials, `${role} needs a title and initials.`)
}
assert.equal(new Set(STAFF_ORDER.map(r => STAFF_STYLES[r].colour)).size, STAFF_ORDER.length, 'Each role has its own colour.')
assert.ok(!STAFF_ORDER.includes('chair'), 'Nobody can be asked to speak as the chair.')
assert.equal(staffStyle('chair').title, 'Your call')
assert.equal(staffStyle('unknown').title, 'unknown', 'An unfamiliar role still renders.')

// --- wiring ----------------------------------------------------------------
const api = await read('../src/api.js')
for (const method of ['getStaffRoster', 'conveneStaff', 'getStaffNotes', 'replyToStaffNote', 'updateStaffNote',
  'applyStaffAction', 'declineStaffAction']) {
  assert.match(api, new RegExp(`${method}:`), `api.${method} must exist.`)
}

const workspace = await read('../src/pages/PlanningWorkspace.jsx')
assert.match(workspace, /api\.conveneStaff\(/, 'The planning chat convenes the staff after each exchange.')
assert.match(workspace, /mergeConversation\(messages, staffNotes\)/, 'Staff voices appear in the conversation.')
assert.match(workspace, /<StaffNotesPanel/, 'Staff points are also pinned beside the plan.')
assert.match(workspace, /trigger: drafted \? 'plan_draft' : 'coach_message'/,
  'The staff are told when they are reviewing a proposed plan.')

const timeline = await read('../src/components/SeasonTimeline.jsx')
assert.match(timeline, /staff_notes/, 'Weeks the staff raised something about are marked on the timeline.')

const swimmer = await read('../src/pages/SwimmerDetail.jsx')
assert.match(swimmer, /'Staff'/, 'The swimmer page has a Staff tab.')
assert.match(swimmer, /<AskTheStaff[\s\S]*?swimmer_ids: \[swimmer\.id\]/, 'The staff are asked about this swimmer.')

console.log('Staff room checks passed')

// --- acting: every change waits for approval ---------------------------------
const voices = await read('../src/components/StaffVoices.jsx')
assert.match(voices, /api\.applyStaffAction\(note\.id\)/, 'Approving runs the proposed change.')
assert.match(voices, /api\.declineStaffAction\(note\.id\)/, 'The coach can turn a proposal down.')
assert.match(voices, /status === 'proposed' &&/, 'Buttons only show while a proposal is waiting.')
assert.match(voices, /action\.summary/, 'The coach sees exactly what will change before approving.')

const meet = await read('../src/pages/MeetDetail.jsx')
assert.match(meet, /<AskTheStaff[\s\S]*?meet_id: meet\.id[\s\S]*?roles=\{\['meets'\]\}/,
  'The meet page puts questions to the meet manager first.')
assert.match(meet, /onActed=\{load\}/, 'The meet page reloads after an approved change.')

console.log('Staff action checks passed')

// --- your call: disagreements are the coach's to settle ---------------------
const waiting = { kind: 'decision', decision: null, options: [
  { role: 'physiologist', title: 'Physiologist' }, { role: 'planner', title: 'Periodisation Planner' }] }
assert.equal(decisionSummary(waiting), 'Waiting for you: Physiologist or Periodisation Planner')
assert.equal(decisionSummary({ ...waiting, decision: 'Rest Ruby' }), 'Your call: Rest Ruby')
assert.equal(decisionSummary({ kind: 'concern' }), '')
assert.match(voices, /note\.kind === 'decision' \?/, 'A disagreement renders as a decision card.')
assert.match(voices, /api\.decideStaffNote\(note\.id/, 'The coach settles it from the card.')
assert.match(voices, /Something else/, 'The coach can decide something neither side proposed.')
assert.match(api, /decideStaffNote:/)

console.log('Decision checks passed')

// --- session writer: the staff chip in on a draft session -------------------
const draft = {
  parsed: {
    title: 'Threshold Tuesday', energy_focus: 'threshold', total_volume_m: '4200m', warm_up: '400 easy',
    groups: { 1: { label: 'Fast lane', sets: ['4x400 @5:20', '8x50 kick'] }, 2: { sets: '3x400 @6:00' } },
    cool_down: '200 easy',
  },
  plan_alignment: 'Week 3 of base.',
  per_swimmer: [{ name: 'Ruby', suggested_group: 1, note: 'hold 1:18s' }, { name: 'Leo' }],
}
const sessionText = sessionTopic(draft, 'threshold main set')
assert.match(sessionText, /^Session draft: Threshold Tuesday, threshold focus, 4200m/)
assert.match(sessionText, /The coach asked for: threshold main set/)
assert.match(sessionText, /Group 1 \(Fast lane\): 4x400 @5:20; 8x50 kick/)
assert.match(sessionText, /Group 2: 3x400 @6:00/, 'A group whose sets are one string still reads.')
assert.match(sessionText, /Per swimmer: Ruby \(G1\): hold 1:18s$/m, 'Swimmers without a note are left out.')
assert.equal(sessionTopic(null), '')
assert.equal(workInText({ role: 'physiologist', message: 'Leo needs an easier main set.' }),
  'The Physiologist says: Leo needs an easier main set. Work this into the session.')
assert.equal(workInText({ kind: 'decision', decision: 'Rest Leo' }), "I've decided: Rest Leo. Work this into the session.")

const planner = await read('../src/pages/SessionPlanner.jsx')
assert.match(planner, /trigger: 'session_draft'/, 'The staff are told they are reviewing a session draft.')
assert.match(planner, /attendee_ids:/, 'They know who is expected at the session.')
assert.match(planner, /onWorkIn=\{/, 'A staff point can be worked straight into the draft.')
assert.match(planner, /seq !== draftSeq\.current/, 'Late staff notes never land on a different session.')
assert.match(voices, /Work this in/)

console.log('Session writer checks passed')
