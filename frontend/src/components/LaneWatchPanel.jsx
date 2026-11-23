import { useEffect, useState } from 'react'
import { api } from '../api'
import { callbackAddress, defaultSelection, pairsToSave } from '../laneWatch'

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

const timeText = (seconds) => {
  if (typeof seconds !== 'number') return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = (seconds - minutes * 60).toFixed(2)
  return minutes ? `${minutes}:${rest.padStart(5, '0')}` : rest
}

// Pair LaneWatch races with the official swims in each swimmer's times, so the
// analyst reads the official time and splits next to LaneWatch's analysis.
// It also runs by itself after each results import.
function RaceMatching() {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      setResult(await api.pairLaneWatchRaces())
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  const choose = async (choice, swimTimeId) => {
    setError('')
    try {
      await api.chooseLaneWatchRace(swimTimeId, choice.race.lanewatch_log_id)
      setResult(previous => ({
        ...previous,
        paired: previous.paired + 1,
        choices: previous.choices.filter(item => item !== choice),
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="space-y-2 border-t border-pool-700 pt-3">
      <p className="text-[11px] uppercase tracking-wide text-pool-500">Races</p>
      <p className="text-xs text-pool-400 leading-relaxed">
        Matches each LaneWatch race to the official swim in the results here, so the official time and splits sit
        next to the race analysis. This also happens by itself after each results import.
      </p>
      <button onClick={run} disabled={busy}
        className="w-full py-2 text-sm font-semibold bg-pool-700 border border-pool-600 rounded-xl disabled:opacity-40">
        {busy ? 'Matching races…' : 'Match LaneWatch races to results'}
      </button>

      {result && (
        <div className="space-y-2">
          <p className="text-xs text-pool-300">
            {result.paired} race{result.paired === 1 ? '' : 's'} matched
            {result.already_paired > 0 && ` · ${result.already_paired} already matched`}
            {result.choices.length > 0 && ` · ${result.choices.length} for you to choose`}
          </p>

          {result.choices.map((choice, index) => (
            <div key={`${choice.race.lanewatch_log_id}-${index}`} className="rounded-lg border border-pool-700 p-2.5 space-y-1.5">
              <p className="text-xs text-pool-200">
                {choice.swimmer}: LaneWatch {choice.race.event} on {choice.race.date}, {timeText(choice.race.time_seconds)}
                {choice.race.round ? ` (${choice.race.round})` : ''}. Which swim is it?
              </p>
              {choice.options.map(option => (
                <button key={option.swim_time_id} onClick={() => choose(choice, option.swim_time_id)}
                  className="w-full text-left text-xs px-2.5 py-1.5 rounded-lg bg-pool-700 border border-pool-600">
                  {timeText(option.time_seconds)} · {option.date}{option.round ? ` · ${option.round}` : ''}
                  {option.meet ? ` · ${option.meet}` : ''}
                </button>
              ))}
            </div>
          ))}

          {result.unmatched > 0 && (
            <details className="text-xs text-pool-400">
              <summary className="cursor-pointer">
                {result.unmatched} LaneWatch race{result.unmatched === 1 ? ' has' : 's have'} no result here yet
              </summary>
              <p className="text-[11px] text-pool-500 mt-1">
                Time trials and training swims stay like this. For a gala, add its results and they match up.
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.unmatched_races.map(race => (
                  <li key={race.lanewatch_log_id}>
                    {race.swimmer} · {race.event} · {race.date} · {timeText(race.time_seconds)}
                    {race.meet ? ` · ${race.meet}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {result.unreadable.length > 0 && (
            <p className="text-[11px] text-pool-500">
              Couldn&apos;t read: {result.unreadable.map(item => `${item.swimmer} (${item.reason})`).join('; ')}
            </p>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  )
}

export default function LaneWatchPanel() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => api.getLaneWatchStatus().then(setStatus).catch(e => setError(e.message))
  useEffect(() => { load() }, [])

  // Off to LaneWatch to sign in and approve; it sends the coach back to
  // /lanewatch/callback, which finishes the connection.
  const connect = async () => {
    setBusy(true)
    setError('')
    try {
      const { url } = await api.startLaneWatchConnect(callbackAddress(window.location.origin))
      window.location.assign(url)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
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
            {status.linked > 0 && <RaceMatching />}
          </>
        )}

        {status && !status.connected && (
          <div className="space-y-2">
            <button onClick={connect} disabled={busy}
              className="w-full py-2.5 text-sm font-semibold bg-accent-600 rounded-xl disabled:opacity-40">
              {busy ? 'Opening LaneWatch…' : 'Connect with LaneWatch'}
            </button>
            <p className="text-[11px] text-pool-500">
              You sign in on LaneWatch&apos;s own site with your coach account and approve there. This app never
              sees your LaneWatch sign-in.
            </p>
          </div>
        )}

        {error && <p className="text-xs text-red-300">{error}</p>}
      </div>
    </section>
  )
}
