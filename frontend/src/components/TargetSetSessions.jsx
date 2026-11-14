import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { sessionLabel } from '../targetSets'

// Which sessions a target set is used in, and adding it to a nearby one.
export default function TargetSetSessions({ setId }) {
  const [data, setData] = useState(null)
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => api.getTargetSetSessions(setId).then(setData).catch(e => setError(e.message))
  useEffect(() => { setData(null); setPick(''); setNote(''); load() }, [setId])

  async function run(action) {
    setBusy(true)
    setError('')
    try {
      await action()
      setPick('')
      setNote('')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!data) return null
  const field = 'w-full bg-pool-700 rounded-lg px-2.5 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none'

  return (
    <div className="border-t border-pool-700 pt-3 space-y-2">
      <p className="text-xs font-semibold text-pool-200">Used in sessions</p>
      {data.used.length === 0
        ? <p className="text-xs text-pool-500">Not on any session yet. Add it to the sessions where you use it, so the staff know what the swimmers were aiming at.</p>
        : (
          <ul className="space-y-1">
            {data.used.map(s => (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                <Link to={`/sessions/${s.id}`} className="text-pool-300 min-w-0 truncate">
                  {sessionLabel(s)}{s.note && <span className="text-pool-500"> · {s.note}</span>}
                </Link>
                <button onClick={() => run(() => api.removeTargetSetFromSession(setId, s.id))} disabled={busy}
                  className="text-[11px] text-pool-500 hover:text-red-400 shrink-0">Remove</button>
              </li>
            ))}
          </ul>
        )}

      {data.candidates.length > 0 && (
        <div className="space-y-2 pt-1">
          <select value={pick} onChange={e => setPick(e.target.value)} className={field}>
            <option value="">Add to a session (last 2 weeks, next 4)…</option>
            {data.candidates.map(s => <option key={s.id} value={s.id}>{sessionLabel(s)}{s.squad ? ` (${s.squad})` : ''}</option>)}
          </select>
          {pick && (<>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={200}
              placeholder="Which part? e.g. Main set 16 x 25" className={field} />
            <button onClick={() => run(() => api.addTargetSetToSession(setId, Number(pick), { note }))} disabled={busy}
              className="w-full bg-accent-600 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-40">
              {busy ? 'Adding…' : 'Add to session'}
            </button>
          </>)}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
