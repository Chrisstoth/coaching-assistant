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
