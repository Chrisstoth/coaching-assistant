import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  actionCopy, conversationName, conversationTitle, planMessage, recentConversations, relativeTime,
  sessionWhen, startSuggestions,
} from '../src/chatStart.js'

// ---- Conversation names (same rule as thread_name_from on the server) ----
assert.equal(conversationName('Cancel Thursday morning'), 'Cancel Thursday morning')
assert.equal(conversationName("  plan   tonight's\nsession "), "plan tonight's session")
const long = conversationName('Next week has to be lighter, half of them have mocks and the rest are tired')
assert.ok(long.endsWith('…'))
assert.ok(long.length <= 49)
assert.ok(!long.slice(0, -1).endsWith(' '))
assert.equal(conversationName("[Photo attached] Here's the gala timetable"), "Here's the gala timetable")
assert.equal(conversationName('[Photo: session whiteboard]'), 'Photo')

assert.equal(conversationTitle(null), 'New conversation')
assert.equal(conversationTitle({ name: null, thread_type: 'season_plan' }), 'Season planning')
assert.equal(conversationTitle({ name: 'Ben shoulder', thread_type: 'general' }), 'Ben shoulder')

// ---- Times ----
const now = new Date(2026, 10, 13, 19, 0) // Friday 13 Nov 2026, 19:00 local
assert.equal(relativeTime(new Date(2026, 10, 13, 18, 59, 40), now), 'Just now')
assert.equal(relativeTime(new Date(2026, 10, 13, 18, 40), now), '20 min ago')
assert.equal(relativeTime(new Date(2026, 10, 13, 16, 0), now), '3h ago')
assert.equal(relativeTime(new Date(2026, 10, 12, 22, 0), now), 'Yesterday')
assert.equal(relativeTime(new Date(2026, 10, 10, 12, 0), now), 'Tue')
assert.equal(relativeTime(new Date(2026, 9, 2, 12, 0), now), '2 Oct')
assert.equal(relativeTime(null, now), '')
// The server's UTC times without a zone are read as UTC.
assert.equal(relativeTime(new Date(now.getTime() - 5 * 60000).toISOString().replace('Z', ''), now), '5 min ago')

// ---- Recent conversations: newest first, empty and planning ones left out ----
const threads = [
  { id: 1, name: 'Old', thread_type: 'general', last_message_at: '2026-11-01T10:00:00Z', message_count: 4 },
  { id: 2, name: 'Empty', thread_type: 'general', last_message_at: '2026-11-13T10:00:00Z', message_count: 0 },
  { id: 3, name: 'Season Plan', thread_type: 'season_plan', last_message_at: '2026-11-13T11:00:00Z', message_count: 9 },
  { id: 4, name: 'Newest', thread_type: 'general', last_message_at: '2026-11-13T12:00:00Z', message_count: 2 },
]
assert.deepEqual(recentConversations(threads).map(t => t.id), [4, 1])
assert.deepEqual(recentConversations(threads, { limit: 1 }).map(t => t.id), [4])
assert.deepEqual(recentConversations(threads, { includePlanning: true }).map(t => t.id), [4, 3, 1])

// ---- Session wording ----
assert.equal(sessionWhen({ date: '2026-11-13', time: '20:30' }, now), "today's 20:30")
assert.equal(sessionWhen({ date: '2026-11-14', time: '06:00:00' }, now), "tomorrow's 06:00")
assert.equal(sessionWhen({ date: '2026-11-16', time: '17:30' }, now), "Monday's 17:30")
assert.equal(sessionWhen({ date: '2026-11-13' }, now), "today's session")
assert.equal(planMessage({ date: '2026-11-14', label: 'Sat AM' }), 'Plan a session for Saturday 14 November (Sat AM)')

// ---- What the chat offers when it opens ----
const calendar = [
  { date: '2026-11-13', items: [
    { session_id: 10, title: 'Silver 1 PM', time: '18:30', end_time: '20:00', status: 'planned', plan_ready: true },
    { slot_id: 2, label: 'Late lane', time: '20:30', status: 'cancelled' },
  ] },
  { date: '2026-11-14', items: [
    { slot_id: 3, label: 'Sat AM', time: '06:00', status: 'unlogged' },
  ] },
]
const debriefs = [{ session_id: 7, title: 'Wednesday PM', days_since: 2 }]
const offered = startSuggestions({ calendar, awaitingDebrief: debriefs, now })
assert.deepEqual(offered.map(s => s.kind), ['open', 'register', 'debrief'])
assert.equal(offered[0].title, 'Open Silver 1 PM')
assert.equal(offered[2].title, 'Debrief Wednesday PM')
assert.equal(offered[2].detail, '2 days ago')

// With room, the next session not marked Ready is offered for planning; the
// cancelled one never is.
const more = startSuggestions({ calendar, awaitingDebrief: debriefs, now, limit: 5 })
assert.equal(more[3].kind, 'plan')
assert.equal(more[3].title, "Plan tomorrow's 06:00")
assert.equal(more[3].message, 'Plan a session for Saturday 14 November (Sat AM)')

// After the session, with the register taken, only what's left is offered.
const later = new Date(2026, 10, 13, 21, 0)
const done = [{ ...calendar[0], items: [{ ...calendar[0].items[0], registered: true }] }, calendar[1]]
assert.deepEqual(startSuggestions({ calendar: done, now: later }).map(s => s.kind), ['plan'])

// Someone else took it: nothing to chase.
const covered = [{ date: '2026-11-13', items: [{ ...calendar[0].items[0], taken_by_other: true }] }]
assert.deepEqual(startSuggestions({ calendar: covered, now }), [])
assert.deepEqual(startSuggestions({}), [])

// ---- The action card says what its button does ----
assert.equal(actionCopy({ type: 'view_meet' }).button, 'Open')
assert.equal(actionCopy({ type: 'view_swimmer', swimmer_name: 'Amy' }).detail, '')
assert.equal(actionCopy({ type: 'status_change', swimmer_name: 'Ben', new_status: 'injured' }).detail, 'Ben will be marked injured.')
assert.equal(actionCopy({ type: 'session_writing' }).button, 'Draft the session')
assert.equal(actionCopy({ type: 'meet_creation' }).button, 'Create the meet')
assert.equal(actionCopy({ type: 'race_profile', swimmer_name: 'Amy' }).button, 'Save to profile')
assert.equal(actionCopy({ type: 'something_new' }).button, 'Yes, save it')
assert.equal(actionCopy(null), null)

// ---- The chat page keeps its agreed behaviour ----
const page = readFileSync(new URL('../src/pages/CoachAI.jsx', import.meta.url), 'utf8')
assert.match(page, /listenForPause/, 'A quick tap on the mic should listen hands-free until the coach pauses.')
assert.match(page, /wakeServer/, 'Opening the chat should wake the server.')
assert.match(page, /startSuggestions/, 'The chat should open with what is on now.')
assert.doesNotMatch(page, /speechSynthesis/, "Replies should be read in the staff's voice, not the phone's.")

console.log('Chat start checks passed')
