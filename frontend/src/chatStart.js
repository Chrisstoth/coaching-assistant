// What the chat offers when it opens, and how its conversations are listed.
// Kept free of React so it can be tested on its own.
import { calendarSessions, isSessionNear, localDateKey, sessionEnded } from './sessionProximity.js'

// ---- Conversations ----

const NAME_LENGTH = 48

// Same rule as the server (thread_name_from in ai_chat.py), so a new
// conversation shows its name straight away.
export function conversationName(text) {
  const name = String(text || '').replace(/^\[Photo[^\]]*\]\s*/, '').split(/\s+/).filter(Boolean).join(' ')
  if (!name) return 'Photo'
  if (name.length <= NAME_LENGTH) return name
  const clipped = name.slice(0, NAME_LENGTH)
  const cut = clipped.includes(' ') ? clipped.slice(0, clipped.lastIndexOf(' ')) : clipped
  return `${cut.replace(/[,.;:-]+$/, '')}…`
}

export const PLANNING_THREADS = {
  season_plan: 'Season planning',
  athlete_planning: 'Athlete planning',
}

export function conversationTitle(thread) {
  if (!thread) return 'New conversation'
  return thread.name || PLANNING_THREADS[thread.thread_type] || 'Conversation'
}

function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  // The server sends UTC, sometimes without saying so.
  const text = String(value)
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

// "Just now", "20 min ago", "3h ago", "Yesterday", "Tue", "12 Nov".
export function relativeTime(value, now = new Date()) {
  const date = toDate(value)
  if (!date) return ''
  const minutes = Math.round((now - date) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const today = localDateKey(now)
  if (localDateKey(date) === today) return `${Math.round(minutes / 60)}h ago`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (localDateKey(date) === localDateKey(yesterday)) return 'Yesterday'
  if (now - date < 6 * 24 * 3600 * 1000) return date.toLocaleDateString('en-GB', { weekday: 'short' })
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// Conversations worth showing: ones something was said in, newest first.
// Planning conversations are reached from their own buttons.
export function recentConversations(threads, { limit = Infinity, includePlanning = false } = {}) {
  return (threads || [])
    .filter(t => includePlanning || !PLANNING_THREADS[t.thread_type])
    .filter(t => t.message_count === undefined || t.message_count > 0)
    .slice()
    .sort((a, b) => (toDate(b.last_message_at || b.created_at) || 0) - (toDate(a.last_message_at || a.created_at) || 0))
    .slice(0, limit)
}

// ---- What to offer when the chat opens ----

const OFF = ['cancelled', 'dismissed']

function minutes(time) {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : 24 * 60
}

function sessionName(session) {
  return session.title || session.label || 'the session'
}

function startTime(session) {
  return String(session.time || session.start_time || '').slice(0, 5)
}

// "today's 17:30", "tomorrow's 06:00", "Thursday's 17:30".
export function sessionWhen(session, now = new Date()) {
  const today = localDateKey(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const day = session.date === today ? "today's"
    : session.date === localDateKey(tomorrow) ? "tomorrow's"
      : `${new Date(`${session.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' })}'s`
  const time = startTime(session)
  return time ? `${day} ${time}` : `${day} session`
}

// The sentence the Calendar's "Plan with AI" uses, so both start alike.
export function planMessage(session) {
  const dayLabel = new Date(`${session.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  const slot = session.label ? ` (${session.label})` : ''
  return `Plan a session for ${dayLabel}${slot}`
}

/**
 * Up to `limit` things the coach probably wants right now, most pressing first:
 * the session that's on (open it, take the register), one waiting for its
 * debrief, and the next session not marked Ready.
 *
 * Each: { kind: 'open' | 'register' | 'debrief' | 'plan', title, detail, session?, sessionId?, message? }
 */
export function startSuggestions({ calendar = [], awaitingDebrief = [], now = new Date(), limit = 3 } = {}) {
  const today = localDateKey(now)
  const sessions = calendarSessions(calendar)
    .filter(s => !OFF.includes(s.status) && !s.taken_by_other)
    .sort((a, b) => a.date.localeCompare(b.date) || minutes(startTime(a)) - minutes(startTime(b)))
  const out = []

  const current = sessions.find(s => isSessionNear(s, now))
  if (current) {
    const ended = sessionEnded(current, now)
    if (!ended) {
      out.push({ kind: 'open', title: `Open ${sessionName(current)}`, detail: `On now · ${sessionWhen(current, now)}`, session: current })
    }
    if (!current.registered) {
      out.push({ kind: 'register', title: 'Take the register', detail: sessionName(current), session: current })
    }
  }

  const debrief = (awaitingDebrief || [])[0]
  if (debrief) {
    const when = debrief.days_since === 0 ? 'Today' : debrief.days_since === 1 ? 'Yesterday' : `${debrief.days_since} days ago`
    out.push({ kind: 'debrief', title: `Debrief ${debrief.title || 'the session'}`, detail: when, sessionId: debrief.session_id })
  }

  const next = sessions.find(s => s !== current && s.date >= today && !sessionEnded(s, now)
    && !s.plan_ready && s.status !== 'completed')
  if (next) {
    out.push({ kind: 'plan', title: `Plan ${sessionWhen(next, now)}`, detail: sessionName(next), session: next, message: planMessage(next) })
  }

  return out.slice(0, limit)
}

// Things the chat handles well, to show what can be asked. Sent as they are.
export const TRY_ASKING = [
  'How is the block going?',
  'What should I focus on this week?',
]

// ---- The card under a reply that offers to do something ----

const OPENS = new Set([
  'view_meet', 'view_swimmer', 'view_season_plan', 'view_planning',
  'open_season_plan_thread', 'open_athlete_plan_thread',
])
const PROFILE_SUMMARIES = new Set(['biological_profile', 'race_profile', 'training_profile', 'performance_analysis'])

// What the card's button says, what it says while working, the line above it,
// and what it says once done.
export function actionCopy(action) {
  if (!action) return null
  const { type, swimmer_name: name, new_status: status } = action
  if (OPENS.has(type)) {
    const draft = type === 'view_season_plan' && action.plan_type
    return {
      button: 'Open',
      busy: 'Opening…',
      detail: draft || type === 'view_planning' ? 'The draft opens ready to check. Nothing is saved until you save it there.' : '',
      done: '',
    }
  }
  if (type === 'status_change') {
    return {
      button: 'Yes, change it',
      busy: 'Changing…',
      detail: name && status ? `${name} will be marked ${status}.` : '',
      done: name && status ? `Done. ${name} is marked ${status}.` : 'Done.',
    }
  }
  if (type === 'session_writing') {
    return {
      button: 'Draft the session',
      busy: 'Drafting…',
      detail: "I'll turn this into a session draft for you to check. Nothing is saved until you create it.",
      done: '',
    }
  }
  if (type === 'meet_creation') {
    return {
      button: 'Create the meet',
      busy: 'Creating…',
      detail: "I'll take the meet details and entries from this conversation and create it. You can check it and add targets on the meet page.",
      done: '',
    }
  }
  if (type === 'session_plan' || type === 'meet_prep') {
    return {
      button: 'Pin to sessions',
      busy: 'Summarising…',
      detail: "Keep this plan in mind when planning sessions. You'll check the wording and dates first.",
      done: 'Pinned.',
    }
  }
  if (type === 'athlete_profile_update') {
    return {
      button: 'Update profile',
      busy: 'Updating…',
      detail: `Update ${name || 'the swimmer'}'s physical and psychological coaching profile with what's new in this conversation.`,
      done: `Saved to ${name || 'the swimmer'}'s profile.`,
    }
  }
  if (PROFILE_SUMMARIES.has(type) || type === 'coaching_intent' || type === 'benchmark_capture') {
    return {
      button: 'Save to profile',
      busy: 'Saving…',
      detail: name ? `Save what was said here to ${name}'s profile, for the staff to use from now on.` : 'Save what was said here, for the staff to use from now on.',
      done: name ? `Saved to ${name}'s profile.` : 'Saved.',
    }
  }
  return {
    button: 'Yes, save it',
    busy: 'Saving…',
    detail: "Ready to save this. It'll be used in future planning.",
    done: 'Saved.',
  }
}
