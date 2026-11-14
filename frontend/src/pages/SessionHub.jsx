import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, whenAwake } from '../api'
import { sessionEnded } from '../sessionProximity'
import { blockGroupNames, fmtDist, groupColor, groupLabel, normalizeSession, statsOf, timeText, totalsFor } from '../notation/core.js'
import SessionNotesPanel from '../components/SessionNotes'
import SessionTargets from '../components/SessionTargets'
import SessionCancellationDialog from '../components/SessionCancellationDialog'
import { NewSession, SessionTools } from './SessionDetail'

/* One session, for running it: the poolside view, the register, notes as it
   happens, then the debrief. Opened from Home (or the calendar); ‹ goes back there. */

function dayLabel(iso) {
  if (!iso) return ''
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function StatusChip({ cancelled, done, ready, written }) {
  const [text, style] = cancelled ? ['Cancelled', 'text-red-300 bg-red-900/30 border-red-800/50']
    : done ? ['Done', 'text-emerald-300 bg-emerald-900/30 border-emerald-700/50']
      : ready ? ['Ready ✓', 'text-teal-200 bg-teal-900/40 border-teal-600/50']
        : written ? ['Written', 'text-pool-300 bg-pool-800 border-pool-600']
          : ['Not written yet', 'text-amber-300 bg-amber-900/25 border-amber-700/40']
  return <span className={`text-[11px] font-semibold rounded-full border px-2.5 py-1 shrink-0 ${style}`}>{text}</span>
}

// What's in the written session, at a glance: aims, each group's metres and time, the blocks.
function useSummary(built) {
  return useMemo(() => {
    if (!built || !Array.isArray(built.blocks)) return null
    const s = normalizeSession(JSON.parse(JSON.stringify(built)))
    const blocks = s.blocks.filter(b => b.kind !== 'notes' && (b.items || []).length)
    return {
      written: blocks.length > 0,
      aims: (s.aims || []).filter(a => a && a.trim()),
      groups: s.groups || [],
      totals: blocks.length ? totalsFor(s).filter(t => t.dist > 0 || t.time > 0).map(t => ({ ...t, color: t.gid ? groupColor(s, t.gid) : null })) : [],
      blocks: blocks.map(b => { const st = statsOf(b.items); return { id: b.id, name: b.name || 'Block', dist: st.dist, time: timeText(st), groups: blockGroupNames(s, b) } }),
    }
  }, [built])
}

export default function SessionHub() {
  const { id } = useParams()
  if (id === 'new') return <NewSession />
  return <Hub id={id} />
}

function Hub({ id }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [session, setSession] = useState(null)
  const [plan, setPlan] = useState(null)
  const [register, setRegister] = useState([])
  const [watch, setWatch] = useState([])
  const [loadState, setLoadState] = useState('loading')   // loading | waking | failed | missing | ready
  const [attempt, setAttempt] = useState(0)
  const [noteCount, setNoteCount] = useState(0)
  const [more, setMore] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [pdfPick, setPdfPick] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [readyBusy, setReadyBusy] = useState(false)

  useEffect(() => {
    let live = true
    setLoadState('loading')
    whenAwake(() => api.getSession(id), { onWaking: () => { if (live) setLoadState('waking') } })
      .then(async detail => {
        if (!live) return
        setSession(detail)
        setLoadState('ready')
        const [payload, rows, notes] = await Promise.all([
          api.getBuilderSession(id).catch(() => null),
          api.getRegister(id).catch(() => []),
          api.getCoachingNotes().catch(() => []),
        ])
        if (!live) return
        setPlan(payload)
        setRegister(rows || [])
        setWatch((notes || []).filter(n => n.date_from <= detail.date && n.date_to >= detail.date))
      })
      .catch(error => { if (live) setLoadState(error.status === 404 ? 'missing' : 'failed') })
    return () => { live = false }
  }, [id, attempt])

  const summary = useSummary(plan?.session)

  // ‹ goes back to wherever the session was opened from (Home or the calendar), or Home.
  const goBack = () => {
    if (location.state?.from && location.key !== 'default') navigate(-1)
    else navigate('/')
  }

  if (loadState !== 'ready' || !session) {
    return (
      <div className="p-4 space-y-3">
        <button type="button" onClick={goBack} aria-label="Back" className="text-pool-400 text-2xl">‹</button>
        {loadState === 'failed' ? (
          <>
            <p className="text-sm text-pool-200">Couldn't reach the server to open this session.</p>
            <button type="button" onClick={() => setAttempt(a => a + 1)} className="bg-accent-600 rounded-xl px-4 py-2.5 text-sm font-semibold">Try again</button>
          </>
        ) : loadState === 'missing' ? (
          <p className="text-sm text-pool-300">This session doesn't exist any more.</p>
        ) : (
          <p className="text-sm text-pool-400">{loadState === 'waking' ? 'Waking the server. This can take up to a minute…' : 'Opening the session…'}</p>
        )}
      </div>
    )
  }

  const cancelled = session.status === 'cancelled'
  const done = session.status === 'completed'
  const written = Boolean(summary?.written)
  const ready = Boolean(session.plan_ready)
  const ended = sessionEnded(session)

  const marked = register.filter(r => r.attended === true || r.attended === false)
  const taken = marked.length > 0
  const inCount = marked.filter(r => r.attended).length
  const expectedOf = r => Boolean(r.usual_for_slot || r.group_planned != null) && !r.exception_reason
  const expectedCount = register.filter(expectedOf).length
  const swimmers = register
    .map(r => ({ id: r.swimmer_id, name: r.swimmer_name || r.name || 'Swimmer', here: taken ? r.attended === true : expectedOf(r) }))
    .sort((a, b) => (b.here - a.here) || a.name.localeCompare(b.name))
  const away = register.filter(r => r.exception_reason)
  const mods = Object.entries(session.individual_mods || {})

  const title = session.title || plan?.session?.title || 'Session'
  const when = [dayLabel(session.date), session.start_time && `${session.start_time}${session.end_time ? `–${session.end_time}` : ''}`,
    session.squad, session.course, session.cycle_code && `Week ${session.cycle_code}`].filter(Boolean).join(' · ')

  const toggleReady = async () => {
    setReadyBusy(true)
    try {
      const res = await api.setSessionReady(id, !ready)
      setSession(s => ({ ...s, plan_ready: res.plan_ready }))
    } catch (e) {
      window.alert(e.message || 'Could not change that.')
    } finally {
      setReadyBusy(false)
    }
  }

  const pdfGroups = summary?.groups || []
  const openPdf = async (groupId = null) => {
    if (!plan) return
    setPdfBusy(true)
    try {
      const { openSessionPdf } = await import('../notation/sessionPdf.js')
      await openSessionPdf(plan, groupId)
      setPdfPick(false)
    } catch {
      window.alert('Could not make the PDF.')
    } finally {
      setPdfBusy(false)
    }
  }

  const importLink = `/import?${new URLSearchParams({ tab: 'excel', date: session.date, session: String(session.id), ...(session.pool_slot_id ? { slot: String(session.pool_slot_id) } : {}) })}`

  return (
    <div className="p-4 space-y-4">
      <header className="flex items-start gap-3 pt-1">
        <button type="button" onClick={goBack} aria-label="Back" className="text-pool-400 text-2xl leading-none mt-0.5">‹</button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold leading-tight">{title}</h1>
          <p className="text-xs text-pool-400 mt-1">{when}</p>
        </div>
        <StatusChip cancelled={cancelled} done={done} ready={ready} written={written} />
      </header>

      {cancelled && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl px-4 py-3">
          <p className="text-sm text-red-200">Cancelled{session.cancel_reason ? `: ${session.cancel_reason}` : ''}</p>
        </div>
      )}

      {!cancelled && (
        <section className="space-y-2">
          {written ? (
            <Link to={`/builder/${id}?view=pool`}
              className="flex items-center justify-between rounded-2xl bg-accent-600 px-4 py-4 active:opacity-80">
              <span>
                <span className="block text-base font-bold text-white">Poolside view</span>
                <span className="block text-xs text-white/80 mt-0.5">Big text, screen stays on. Tap a set to note something.</span>
              </span>
              <span className="text-2xl text-white/90" aria-hidden="true">›</span>
            </Link>
          ) : (
            <div className="rounded-2xl border border-amber-700/40 bg-amber-900/15 px-4 py-3.5">
              <p className="text-sm font-semibold text-amber-100">Not written yet</p>
              <div className="flex items-center gap-3 mt-2.5">
                <Link to={`/builder/${id}?view=edit`} className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-semibold text-white">Write it</Link>
                <Link to={importLink} className="text-xs text-accent-400">or import a workbook</Link>
              </div>
            </div>
          )}

          <Link to={`/sessions/${id}/register`} state={{ from: 'session' }}
            className={`flex items-center justify-between rounded-2xl border px-4 py-3.5 active:opacity-80 ${ended && !taken ? 'bg-amber-900/25 border-amber-600/60' : 'bg-pool-800 border-pool-700'}`}>
            <span>
              <span className="block text-sm font-semibold text-pool-100">Register</span>
              <span className={`block text-xs mt-0.5 ${ended && !taken ? 'text-amber-200' : 'text-pool-400'}`}>
                {taken ? `${inCount} in · ${marked.length - inCount} out`
                  : ended ? "Not taken yet. Take it while it's fresh."
                    : `Not taken yet${expectedCount ? ` · ${expectedCount} expected` : ''}`}
              </span>
            </span>
            <span className="text-xl text-pool-500" aria-hidden="true">›</span>
          </Link>

          {written && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => (pdfGroups.length > 1 ? setPdfPick(p => !p) : openPdf(pdfGroups[0]?.id ?? null))}
                disabled={pdfBusy || !plan}
                className="bg-pool-800 border border-pool-700 rounded-xl py-2.5 text-sm font-semibold text-pool-200 disabled:opacity-50">
                {pdfBusy ? 'Making the PDF…' : 'PDF'}
              </button>
              <Link to={`/builder/${id}?view=edit`} className="bg-pool-800 border border-pool-700 rounded-xl py-2.5 text-sm font-semibold text-pool-200 text-center">
                Edit the session
              </Link>
            </div>
          )}
          {pdfPick && (
            <div className="flex flex-wrap gap-2 bg-pool-800/70 border border-pool-700 rounded-xl p-2.5">
              <button type="button" onClick={() => openPdf(null)} disabled={pdfBusy} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold text-pool-100">Whole session</button>
              {pdfGroups.map(g => (
                <button key={g.id} type="button" onClick={() => openPdf(g.id)} disabled={pdfBusy} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold text-pool-100">{g.name}</button>
              ))}
            </div>
          )}

          {written && !ready && !done && (
            <p className="text-xs text-pool-400 px-0.5">
              Finished writing it?{' '}
              <button type="button" onClick={toggleReady} disabled={readyBusy} className="font-semibold text-teal-300 disabled:opacity-50">Mark it ready</button>
            </p>
          )}
        </section>
      )}

      {!cancelled && (ended || taken || done) && (
        <Link to={`/debrief?session=${id}`}
          className="flex items-center justify-between rounded-2xl border border-teal-700/50 bg-teal-950/35 px-4 py-3.5 active:opacity-80">
          <span>
            <span className="block text-sm font-semibold text-teal-100">Debrief</span>
            <span className="block text-xs text-teal-400/80 mt-0.5">
              Talk it through while it's fresh.{noteCount ? ` Your ${noteCount} note${noteCount === 1 ? ' is' : 's are'} already in.` : ''}
            </span>
          </span>
          <span className="text-xl shrink-0 ml-3" aria-hidden="true">🎤</span>
        </Link>
      )}

      {!cancelled && (
        <SessionNotesPanel sessionId={session.id} swimmers={swimmers} builderSession={plan?.session || null} onCount={setNoteCount} />
      )}

      {summary && written && (
        <section className="bg-pool-800 border border-pool-700 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">The session</p>
            {!cancelled && <Link to={`/builder/${id}?view=pool`} className="text-xs text-pool-400">Poolside ›</Link>}
          </div>
          {summary.aims.length > 0 && (
            <ul className="space-y-1">
              {summary.aims.map(a => <li key={a} className="text-sm text-pool-200">· {a}</li>)}
            </ul>
          )}
          {summary.totals.length > 0 && (
            <div className="space-y-1">
              {summary.totals.map(t => (
                <div key={t.gid || 'all'} className="flex items-center gap-2 text-sm">
                  {t.color && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.color }} />}
                  <span className="font-medium text-pool-100 flex-1 truncate">{groupLabel(t.g)}</span>
                  <span className="text-pool-300 tabular-nums">{fmtDist(t.dist)} m · {timeText(t)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-pool-700/70 pt-2 space-y-1">
            {summary.blocks.map(b => (
              <div key={b.id} className="flex items-baseline gap-2 text-xs">
                <span className="text-pool-200 font-medium truncate">{b.name}</span>
                {b.groups.length > 0 && <span className="text-pool-500 truncate">{b.groups.join(', ')}</span>}
                <span className="ml-auto text-pool-500 tabular-nums shrink-0">{fmtDist(b.dist)} m</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {!cancelled && <SessionTargets sessionId={session.id} />}

      {!cancelled && (mods.length > 0 || watch.length > 0 || away.length > 0) && (
        <section className="bg-amber-900/15 border border-amber-800/35 rounded-2xl px-4 py-3 space-y-2.5">
          <p className="text-xs font-semibold text-amber-300 uppercase tracking-wider">Watch today</p>
          {mods.map(([name, body]) => (
            <div key={`mod-${name}`}>
              <p className="text-xs font-semibold text-amber-200">{name}</p>
              <p className="text-xs text-pool-300 whitespace-pre-line">{body}</p>
            </div>
          ))}
          {watch.map(note => (
            <details key={`note-${note.id}`}>
              <summary className="text-xs font-semibold text-amber-200 cursor-pointer">{note.swimmer_names?.join(', ') || 'Squad'} · {note.title}</summary>
              <p className="text-xs text-pool-300 whitespace-pre-line mt-1">{note.body}</p>
            </details>
          ))}
          {away.map(row => (
            <p key={`away-${row.swimmer_id}`} className="text-xs text-amber-200">
              {row.swimmer_name} · {row.availability?.label || String(row.exception_reason).replaceAll('_', ' ')}
              {row.availability?.detail ? <span className="text-pool-400"> · {row.availability.detail}</span> : null}
            </p>
          ))}
        </section>
      )}

      <section>
        <button type="button" onClick={() => setMore(m => !m)} aria-expanded={more}
          className="w-full flex items-center justify-between text-xs text-pool-400 py-2">
          <span>More</span><span className={`transition-transform ${more ? 'rotate-180' : ''}`}>⌄</span>
        </button>
        {more && (
          <div className="space-y-3 pt-1">
            {!cancelled && (
              <div className="flex flex-wrap gap-2">
                {ready && (
                  <button type="button" onClick={toggleReady} disabled={readyBusy} className="rounded-lg bg-pool-800 border border-pool-700 px-3 py-2 text-xs text-pool-300">
                    Not ready after all
                  </button>
                )}
                <button type="button" onClick={() => setCancelling(true)} className="rounded-lg bg-red-900/25 border border-red-800/60 px-3 py-2 text-xs font-semibold text-red-300">
                  Cancel this session
                </button>
              </div>
            )}
            <SessionTools session={session} setSession={next => setSession(s => ({ ...s, ...next }))} onDeleted={() => navigate('/', { replace: true })} />
          </div>
        )}
      </section>

      <SessionCancellationDialog
        session={cancelling ? { ...session, session_id: session.id } : null}
        onClose={() => setCancelling(false)}
        onCancelled={result => { setCancelling(false); setSession(s => ({ ...s, status: 'cancelled', cancel_reason: result.cancel_reason })) }}
      />
    </div>
  )
}
