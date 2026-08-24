const values = new Map()
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
globalThis.CustomEvent = class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail } }
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

const { queueRegisterSave, getOfflineSaveCount, flushOfflineSaves } = await import('../src/offlineQueue.js')

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

console.log('Offline queue check passed')
