const STORAGE_KEY = 'dx_offline_saves_v1'
const CHANGE_EVENT = 'dx-offline-queue-changed'
let activeFlush = null

function readQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(queue) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue))
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { count: queue.length } }))
}

export function getOfflineSaveCount() {
  return readQueue().length
}

export function subscribeToOfflineQueue(handler) {
  window.addEventListener(CHANGE_EVENT, handler)
  return () => window.removeEventListener(CHANGE_EVENT, handler)
}

export function queueRegisterSave(sessionId, body) {
  const id = `session-register:${sessionId}`
  const queue = readQueue().filter(item => item.id !== id)
  queue.push({
    id,
    method: 'PUT',
    path: `/sessions/${sessionId}/register`,
    body,
    created_at: new Date().toISOString(),
    revision: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    attempts: 0,
  })
  writeQueue(queue)
  return { queued: true, pending_count: queue.length }
}

// A note made during a session with no signal. The note carries the phone's own
// id, so sending it twice (a retry after a lost reply) still stores it once.
export function queueSessionNote(sessionId, note) {
  const id = `session-note:${note.client_id}`
  const queue = readQueue().filter(item => item.id !== id)
  queue.push({
    id,
    method: 'POST',
    path: `/sessions/${sessionId}/notes`,
    body: note,
    created_at: new Date().toISOString(),
    revision: note.client_id,
    attempts: 0,
  })
  writeQueue(queue)
  return { queued: true, pending_count: queue.length }
}

// Notes for this session still waiting on the phone, oldest first.
export function queuedSessionNotes(sessionId) {
  const path = `/sessions/${sessionId}/notes`
  return readQueue().filter(item => item.method === 'POST' && item.path === path).map(item => item.body)
}

export function dropQueuedSessionNote(clientId) {
  const id = `session-note:${clientId}`
  const queue = readQueue()
  if (queue.some(item => item.id === id)) writeQueue(queue.filter(item => item.id !== id))
}

async function runFlush(sendRequest) {
  if (!navigator.onLine) {
    return { synced: 0, pending_count: getOfflineSaveCount(), offline: true }
  }

  const queue = readQueue()
  let synced = 0

  for (const item of queue) {
    try {
      await sendRequest(item.method, item.path, item.body)
      // A coach may edit the same register while an older revision is syncing.
      // Remove only the revision we actually sent, never a newer local save.
      const remaining = readQueue().filter(candidate =>
        candidate.id !== item.id
        || (candidate.revision || candidate.created_at) !== (item.revision || item.created_at)
      )
      writeQueue(remaining)
      synced += 1
    } catch (error) {
      const latest = readQueue().map(candidate => candidate.id === item.id
        ? { ...candidate, attempts: (candidate.attempts || 0) + 1, last_error: error.message }
        : candidate)
      writeQueue(latest)
      break
    }
  }

  return { synced, pending_count: getOfflineSaveCount(), offline: false }
}

export function flushOfflineSaves(sendRequest) {
  if (activeFlush) return activeFlush
  activeFlush = runFlush(sendRequest).finally(() => { activeFlush = null })
  return activeFlush
}
