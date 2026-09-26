import { useEffect, useState } from 'react'
import { api } from '../api'
import { defaultSelection, pairsToSave, signInErrorMessage, signInToLaneWatch } from '../laneWatch'

// Connect LaneWatch Hub so the Performance Analyst can read race analysis
// (15m, underwater, stroke rate, back-half drop), then pair each LaneWatch
// swimmer with the swimmer here. Read-only, revocable, and only what the
// coach's own LaneWatch account can see.

function Pairing({ onSaved }) {
  const [data, setData] = useState(null)
  const [swimmers, setSwimmers] = useState([])
  const [selected, setSelected] = useState({})
  const [manual, setManual] = useState({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setError('')
    try {
      const [links, squad] = await Promise.all([api.getLaneWatchLinks(), api.getSwimmers()])
      setData(links)
      setSwimmers(Array.isArray(squad) ? squad : [])
      setSelected(defaultSelection(links.suggestions))
      setManual({})
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  if (error) return <p className="text-xs text-red-300">Could not read your LaneWatch roster: {error}</p>
  if (!data) return <p className="text-xs text-pool-500">Reading your LaneWatch roster…</p>

  const linkedIds = new Set(data.links.map(l => l.swimmer_id))
  const suggestedIds = new Set(data.suggestions.map(s => s.swimmer_id))
  const free = swimmers.filter(s => !linkedIds.has(s.id) && !suggestedIds.has(s.id))
  const pairs = pairsToSave(data.suggestions, selected, manual)

  const save = async () => {
    setSaving(true)
    try {
      await api.saveLaneWatchLinks(pairs)
      await load()
      if (onSaved) onSaved()
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  const unlink = async (swimmerId) => {
    try {
      await api.unlinkLaneWatch(swimmerId)
      await load()
      if (onSaved) onSaved()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="space-y-3">
      {data.links.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">Paired</p>
          {data.links.map(link => (
            <div key={link.swimmer_id} className="flex items-center gap-2 text-sm">
              <span className="text-pool-100 flex-1 min-w-0 truncate">
                {link.swimmer_name} <span className="text-pool-500">↔ {link.lanewatch_name}</span>
              </span>
              {!link.on_roster && <span className="text-[10px] text-amber-300">no longer on your roster</span>}
              {link.on_roster && !link.shares && <span className="text-[10px] text-pool-500">not sharing</span>}
              <button onClick={() => unlink(link.swimmer_id)} className="text-xs text-pool-400">Unpair</button>
            </div>
          ))}
        </div>
      )}

      {data.suggestions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">Suggested - tick the ones that are right</p>
          {data.suggestions.map(s => {
            const key = `${s.swimmer_id}:${s.lanewatch_swimmer_id}`
            return (
              <label key={key} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={Boolean(selected[key])}
                  onChange={e => setSelected(prev => ({ ...prev, [key]: e.target.checked }))} />
                <span className="flex-1 min-w-0">
                  <span className="text-pool-100">{s.swimmer_name}</span>
                  <span className="block text-[11px] text-pool-500">
                    Matched on {s.confidence}{s.shares ? '' : ' · not sharing with you yet'}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      )}

      {data.unmatched.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-pool-500">On LaneWatch, not paired</p>
          {data.unmatched.map(row => (
            <div key={row.lanewatch_swimmer_id} className="flex items-center gap-2">
              <span className="text-sm text-pool-200 flex-1 min-w-0 truncate">
                {row.lanewatch_name}{row.date_of_birth ? <span className="text-pool-500"> · {row.date_of_birth}</span> : null}
              </span>
              <select
                value={manual[row.lanewatch_swimmer_id] || ''}
                onChange={e => setManual(prev => ({ ...prev, [row.lanewatch_swimmer_id]: e.target.value }))}
                className="bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs text-pool-100 max-w-[45%]"
              >
                <option value="">Not in this squad</option>
                {free.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      {data.links.length === 0 && data.suggestions.length === 0 && data.unmatched.length === 0 && (
        <p className="text-xs text-pool-500">Nobody is on your LaneWatch roster yet.</p>
      )}

      {pairs.length > 0 && (
        <button onClick={save} disabled={saving}
          className="w-full py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
          {saving ? 'Saving…' : `Pair ${pairs.length} swimmer${pairs.length === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  )
}

export default function LaneWatchPanel() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [emailForm, setEmailForm] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const load = () => api.getLaneWatchStatus().then(setStatus).catch(e => setError(e.message))
  useEffect(() => { load() }, [])

  const connect = async (method) => {
    if (!status?.sign_in) return
    setBusy(true)
    setError('')
    try {
      const token = await signInToLaneWatch(status.sign_in, method, { email, password })
      setPassword('')
      await api.connectLaneWatch(token)
      setEmailForm(false)
      await load()
    } catch (e) {
      setError(e.code ? signInErrorMessage(e) : e.message)
    }
    setBusy(false)
  }

  const disconnect = async () => {
    if (!window.confirm('Disconnect LaneWatch? The Performance Analyst will stop seeing race analysis until you connect again. Your swimmer pairings are kept.')) return
    setBusy(true)
    try {
      const result = await api.disconnectLaneWatch()
      if (!result.revoked_at_lanewatch) {
        setError('Disconnected here, but LaneWatch could not be told. Remove "Coaching Assistant" from connected apps in LaneWatch to be sure.')
      }
      await load()
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">LaneWatch Hub race analysis</h2>
      <div className="bg-pool-800 border border-pool-700 rounded-xl p-4 space-y-3">
        <p className="text-xs text-pool-400 leading-relaxed">
          Lets the Performance Analyst read race analysis from LaneWatch Hub: 15m, underwater, breakouts, stroke rate
          and back-half drop. Read-only, and only what your LaneWatch account can already see - swimmers who share
          their swims with you. Nothing is copied here; it is read live and you can disconnect at any time.
        </p>

        {!status && !error && <p className="text-xs text-pool-500">Checking…</p>}

        {status && status.connected && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400" aria-hidden="true" />
              <p className="text-sm text-pool-100 flex-1">
                Connected{status.connected_as ? ` as ${status.connected_as}` : ''}
                <span className="text-pool-500"> · {status.linked} paired</span>
              </p>
              <button onClick={disconnect} disabled={busy} className="text-xs text-pool-400">Disconnect</button>
            </div>
            {status.last_error && <p className="text-xs text-amber-300">{status.last_error}</p>}
            <Pairing onSaved={load} />
          </>
        )}

        {status && !status.connected && (
          <div className="space-y-2">
            <p className="text-xs text-pool-500">Sign in with your LaneWatch coach account to connect.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => connect('google')} disabled={busy}
                className="px-3 py-2 text-xs font-semibold bg-pool-700 border border-pool-600 rounded-lg disabled:opacity-40">
                Sign in with Google
              </button>
              <button onClick={() => connect('apple')} disabled={busy}
                className="px-3 py-2 text-xs font-semibold bg-pool-700 border border-pool-600 rounded-lg disabled:opacity-40">
                Sign in with Apple
              </button>
              <button onClick={() => setEmailForm(v => !v)} disabled={busy}
                className="px-3 py-2 text-xs font-semibold bg-pool-700 border border-pool-600 rounded-lg disabled:opacity-40">
                Email and password
              </button>
            </div>
            {emailForm && (
              <form className="space-y-2" onSubmit={e => { e.preventDefault(); connect('email') }}>
                <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="LaneWatch email"
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100" />
                <input type="password" autoComplete="current-password" value={password}
                  onChange={e => setPassword(e.target.value)} placeholder="LaneWatch password"
                  className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2 text-sm text-pool-100" />
                <button type="submit" disabled={busy || !email || !password}
                  className="w-full py-2 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
                <p className="text-[11px] text-pool-500">
                  Your password goes to LaneWatch's sign-in only. This app never sees or keeps it.
                </p>
              </form>
            )}
            {busy && !emailForm && <p className="text-xs text-pool-500">Connecting…</p>}
          </div>
        )}

        {error && <p className="text-xs text-red-300">{error}</p>}
      </div>
    </section>
  )
}
