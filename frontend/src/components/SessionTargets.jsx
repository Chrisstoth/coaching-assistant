import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import TargetTable from './TargetTable'
import { addSessionTarget, removeSessionTarget, swimmersFromLabel } from '../targetSets'

// The target sets used in a session, with each swimmer's times from the PBs
// they had on the day. The staff read the same times when they analyse it.
export default function SessionTargets({ sessionId, readOnly = false }) {
  const [view, setView] = useState(null)
  const [sets, setSets] = useState([])
  const [open, setOpen] = useState({})
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!sessionId) return
    api.getSessionTargets(sessionId).then(setView).catch(e => setError(e.message))
    if (!readOnly) api.getTargetSets().then(r => setSets(r.sets)).catch(() => {})
  }, [sessionId, readOnly])

  const links = (view?.targets || []).map(t => ({ target_set_id: t.target_set_id, note: t.note }))

  async function save(next) {
    setBusy(true)
    setError('')
    try {
      setView(await api.setSessionTargets(sessionId, next))
      setAdding(false)
      setPick('')
      setNote('')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!view) return null
  if (readOnly && !view.targets.length) return null
  const available = sets.filter(s => !links.some(l => l.target_set_id === s.id))

  return (
    <section className="bg-pool-800 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm text-accent-400">Target times</h3>
          {view.targets.length > 0 && (
            <p className="text-[11px] text-pool-500 mt-0.5">{swimmersFromLabel(view.swimmers_from)} · PBs as they stood on the day</p>
          )}
        </div>
        {!readOnly && !adding && (
          <button onClick={() => setAdding(true)} className="text-xs text-accent-400 font-medium shrink-0">+ Add target set</button>
        )}
      </div>

      {!view.targets.length && !adding && (
        <p className="text-xs text-pool-500">
          None yet. Add the target set you're using (e.g. 100 PB pace for the 25s) so the staff know what the swimmers were aiming at when they look back at this session.
        </p>
      )}

      {adding && (
        <div className="bg-pool-700/50 rounded-xl p-3 space-y-2">
          {available.length === 0 ? (
            <p className="text-xs text-pool-400">
              {sets.length ? 'Every target set is already on this session.' : 'No target sets yet.'}{' '}
              <Link to="/swimmers?view=targets" className="text-accent-400">Make one on the Squad page ›</Link>
            </p>
          ) : (<>
            <select value={pick} onChange={e => setPick(e.target.value)}
              className="w-full bg-pool-700 rounded-lg px-2.5 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none">
              <option value="">Choose a target set…</option>
              {available.map(s => <option key={s.id} value={s.id}>{s.name}{s.squad ? ` (${s.squad})` : ''}</option>)}
            </select>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={200}
              placeholder="Which part? e.g. Main set 16 x 25"
              className="w-full bg-pool-700 rounded-lg px-2.5 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
          </>)}
          <div className="flex gap-2">
            {available.length > 0 && (
              <button disabled={!pick || busy} onClick={() => save(addSessionTarget(links, Number(pick), note))}
                className="flex-1 bg-accent-600 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-40">
                {busy ? 'Saving…' : 'Add to session'}
              </button>
            )}
            <button onClick={() => { setAdding(false); setError('') }} className="px-4 py-2 rounded-lg border border-pool-600 text-sm text-pool-300">Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {view.targets.map(t => {
        const shown = open[t.target_set_id] ?? readOnly
        return (
          <div key={t.target_set_id} className="border-t border-pool-700 pt-2 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <button onClick={() => setOpen(o => ({ ...o, [t.target_set_id]: !shown }))} className="text-left min-w-0">
                <p className="text-sm font-medium text-pool-100">
                  <span className={`inline-block text-pool-500 mr-1 transition-transform ${shown ? 'rotate-90' : ''}`}>›</span>
                  {t.name}{t.note && <span className="text-pool-400 font-normal"> · {t.note}</span>}
                </p>
                <p className="text-[11px] text-pool-500">{t.summary}</p>
              </button>
              {!readOnly && (
                <button onClick={() => save(removeSessionTarget(links, t.target_set_id))} disabled={busy}
                  className="text-[11px] text-pool-500 hover:text-red-400 shrink-0">Remove</button>
              )}
            </div>
            {shown && (t.swimmers.length
              ? <TargetTable columns={t.columns} swimmers={t.swimmers} />
              : <p className="text-xs text-pool-500">No swimmers on this session yet.</p>)}
          </div>
        )
      })}
    </section>
  )
}
