const values = new Map()
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
globalThis.CustomEvent = class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail } }
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

const {
  queueRegisterSave, getOfflineSaveCount, flushOfflineSaves,
  queueSessionNote, queuedSessionNotes, dropQueuedSessionNote,
} = await import('../src/offlineQueue.js')

queueRegisterSave(42, { entries: [{ swimmer_id: 1, attended: false }] })
queueRegisterSave(42, { entries: [{ swimmer_id: 1, attended: true }] })
if (getOfflineSaveCount() !== 1) throw new Error('Repeated saves for one register must coalesce')

let sent
const result = await flushOfflineSaves(async (method, path, body) => { sent = { method, path, body } })
if (result.synced !== 1 || result.pending_count !== 0) throw new Error('Queued save did not flush')
if (sent.method !== 'PUT' || sent.path !== '/sessions/42/register' || !sent.body.entries[0].attended) {
  throw new Error('Flush did not send the latest register state')
}

queueRegisterSave(42, { entries: [{ swimmer_id: 1, attended: true, coach_observation: 'first' }] })
await flushOfflineSaves(async () => {
  queueRegisterSave(42, { entries: [{ swimmer_id: 1, attended: true, coach_observation: 'newer' }] })
})
if (getOfflineSaveCount() !== 1) throw new Error('A newer edit was removed by an older in-flight sync')
await flushOfflineSaves(async () => {})

// Notes taken with no signal wait on the phone, each one kept (unlike register saves).
queueSessionNote(7, { client_id: 'a', text: 'Amy breathing left' })
queueSessionNote(7, { client_id: 'b', text: 'Main set cut to 3 rounds' })
queueSessionNote(8, { client_id: 'c', text: 'Another session' })
queueSessionNote(7, { client_id: 'a', text: 'Amy breathing left on the kick' })
const waiting = queuedSessionNotes(7)
if (waiting.length !== 2 || !waiting.some(n => n.text === 'Amy breathing left on the kick')) {
  throw new Error('Each note waits once, with its latest wording, under its own session')
}
dropQueuedSessionNote('b')
if (queuedSessionNotes(7).length !== 1) throw new Error('A note deleted before it synced must not be sent')
const notesSent = []
await flushOfflineSaves(async (method, path, body) => { notesSent.push({ method, path, body }) })
if (notesSent.length !== 2 || notesSent.some(n => n.method !== 'POST') || getOfflineSaveCount() !== 0) {
  throw new Error('Queued notes did not sync')
}
if (!notesSent.some(n => n.path === '/sessions/8/notes' && n.body.client_id === 'c')) {
  throw new Error('A queued note went to the wrong session')
}

console.log('Offline queue check passed')
