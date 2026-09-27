import { useEffect, useState } from 'react'
import { api } from '../api'

// The coach's rules the staff follow - mostly remembered from replies to a
// specialist's suggestion. The Session Writer and every specialist read these
// before drafting or suggesting anything.

export default function CoachGuidancePanel() {
  const [rules, setRules] = useState(null)
  const [editing, setEditing] = useState(null)   // { id, text }
  const [adding, setAdding] = useState('')
  const [error, setError] = useState('')

  const load = () => api.getCoachGuidance().then(setRules).catch(e => setError(e.message))
  useEffect(() => { load() }, [])
  // Opened from "Your rules" on a session: come straight here.
  useEffect(() => {
    if (rules && window.location.hash === '#staff-rules') {
      document.getElementById('staff-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [rules])

  const act = async (fn) => {
    setError('')
    try {
      await fn()
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <section id="staff-rules" className="space-y-2 scroll-mt-16">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">How you coach - rules the staff follow</h2>
      <div className="bg-pool-800 rounded-xl p-3 space-y-2">
        <p className="text-xs text-pool-400 leading-relaxed">
          The Session Writer and every specialist read these before they write or suggest anything. Most come
          from replying to a suggestion and tapping Remember.
        </p>
        {rules === null ? <p className="text-xs text-pool-500">Loading…</p>
          : rules.length === 0 ? <p className="text-xs text-pool-500">None yet.</p> : (
            <ul className="space-y-1.5">
              {rules.map(rule => (
                <li key={rule.id} className={`rounded-lg border border-pool-700 px-2.5 py-2 ${rule.active ? '' : 'opacity-50'}`}>
                  {editing?.id === rule.id ? (
                    <div className="space-y-1.5">
                      <textarea value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} rows={2}
                        className="w-full bg-pool-900 rounded-lg px-2 py-1.5 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none" />
                      <div className="flex gap-2">
                        <button onClick={() => act(async () => { await api.updateCoachGuidance(rule.id, { text: editing.text }); setEditing(null) })}
                          className="text-xs font-semibold bg-accent-600 text-white rounded-lg px-3 py-1">Save</button>
                        <button onClick={() => setEditing(null)} className="text-xs text-pool-400">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-pool-100">{rule.text}</p>
                      <div className="flex flex-wrap items-center gap-3 mt-1 text-[11px]">
                        {rule.source && <span className="text-pool-500">{rule.source}</span>}
                        <button onClick={() => setEditing({ id: rule.id, text: rule.text })} className="text-accent-400">Edit</button>
                        <button onClick={() => act(() => api.updateCoachGuidance(rule.id, { active: !rule.active }))} className="text-pool-400">
                          {rule.active ? 'Pause' : 'Use again'}
                        </button>
                        <button onClick={() => act(() => api.deleteCoachGuidance(rule.id))} className="text-red-300">Delete</button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        <div className="flex gap-2 pt-1">
          <input value={adding} onChange={e => setAdding(e.target.value)} placeholder="Add one yourself, e.g. always include a skills set"
            className="flex-1 bg-pool-900 rounded-lg px-2.5 py-1.5 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none" />
          <button disabled={!adding.trim()} onClick={() => act(async () => { await api.addCoachGuidance({ text: adding }); setAdding('') })}
            className="text-xs font-semibold bg-accent-600 disabled:opacity-40 text-white rounded-lg px-3">Add</button>
        </div>
        {error && <p className="text-xs text-red-300">{error}</p>}
      </div>
    </section>
  )
}
