import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { deskWeekStarts, isSessionNear, localDateKey, sessionEnded, weeklySessionQueue } from '../sessionProximity'
import SessionCancellationDialog from '../components/SessionCancellationDialog'
import HelpLink from '../components/HelpLink'

const DESK_ICON_PATHS = {
  open: <path d="M5 12h14M13 6l6 6-6 6" />,
  register: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12h6M9 16h4" /></>,
  done: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 14l2 2 4-4" /></>,
  pool: <path d="M3 9c2 0 2-1.5 4.5-1.5S10 9 12 9s2-1.5 4.5-1.5S19 9 21 9M3 15c2 0 2-1.5 4.5-1.5S10 15 12 15s2-1.5 4.5-1.5S19 15 21 15" />,
  write: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  cancel: <><circle cx="12" cy="12" r="8.5" /><path d="M6 6l12 12" /></>,
  hide: <path d="M6 6l12 12M18 6L6 18" />,
}

function DeskIcon({ name }) {
  const filled = name === 'more'
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {DESK_ICON_PATHS[name]}
    </svg>
  )
}

// The rarely-used card actions live behind one quiet ⋯ button. Both still ask before acting.
function DeskMenu({ name, onCancel, onDismiss }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (event) => { if (!ref.current?.contains(event.target)) setMenuOpen(false) }
    const escape = (event) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])
  const pick = (action) => () => { setMenuOpen(false); action() }
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" className="desk-more" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={`More for ${name}`} onClick={() => setMenuOpen(value => !value)}>
        <DeskIcon name="more" />
      </button>
      {menuOpen && (
        <div role="menu" className="desk-menu">
          <button role="menuitem" type="button" className="danger" onClick={pick(onCancel)}>
            <DeskIcon name="cancel" />Record as cancelled
          </button>
          <button role="menuitem" type="button" onClick={pick(onDismiss)}>
            <DeskIcon name="hide" />Dismiss from desk
          </button>
        </div>
      )}
    </div>
  )
}

function SessionDesk({ sessions, onOpen, onRegister, onDismiss, onCancel, busyKey, busyLabel = 'Opening…', error, onRetry }) {
  if (sessions.length === 0) {
    return (
      <section className="desk-card p-4">
        <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">Session desk</p>
        {error ? (
          <>
            <p className="text-sm text-red-300 mt-2">This week’s timetable did not load.</p>
            <p className="text-xs text-pool-500 mt-1">{error}</p>
            <button onClick={onRetry} className="mt-3 desk-btn desk-btn--teal desk-btn--sm">
              Try again
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-pool-300 mt-2">No outstanding sessions this week.</p>
            <p className="text-xs text-pool-500 mt-1">Completed, cancelled and dismissed sessions stay in the calendar.</p>
          </>
        )}
      </section>
    )
  }
  return (
    <section className="space-y-2.5">
      <div className="flex items-end justify-between px-0.5">
        <div>
          <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">Session desk</p>
          <p className="text-[11px] text-pool-500 mt-0.5">Everything still to handle this week and the next couple of days</p>
        </div>
        <span className="text-xs text-pool-500">{sessions.length} remaining</span>
      </div>
      <div className="space-y-2.5">
        {sessions.map(session => {
          const sessionDate = new Date(`${session.date}T12:00:00`)
          const day = sessionDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
          const current = isSessionNear(session)
          const key = `${session.date}-${session.session_id || `slot-${session.slot_id}`}`
          const groups = session.groups || []
          const mods = Object.entries(session.individual_mods || {})
          const written = Boolean(session.session_id && (groups.some(g => g.sets) || session.coach_intent))
          const ready = Boolean(session.plan_ready)
          const finished = sessionEnded(session)
          const covered = Boolean(session.taken_by_other)
          const chaseRegister = finished && !session.registered && !covered
          const busy = busyKey && busyKey.startsWith(`${key}:`)
          return (
            <article key={key} data-tone={current ? 'now' : chaseRegister ? 'chase' : ready ? 'ready' : undefined} className="desk-card p-4">
              <div className="flex items-start justify-between gap-3">
                <button type="button" onClick={() => onOpen(session)} disabled={busy} className="min-w-0 text-left flex-1">
                  <span className="flex items-center gap-2">
                    {current && <span className="w-2 h-2 rounded-full bg-accent-400 animate-pulse" />}
                    <span className="text-sm font-semibold text-pool-100 truncate">{session.title || session.label || 'Session'}</span>
                    {ready && <span className="text-[10px] font-semibold text-teal-200 bg-teal-900/45 border border-teal-700/50 rounded px-2 py-0.5 shrink-0">Ready ✓</span>}
                    {covered && <span className="text-[10px] font-semibold text-pool-300 bg-pool-700 border border-pool-600 rounded px-2 py-0.5 shrink-0 truncate max-w-[9rem]">{session.taken_by ? `Taken by ${session.taken_by}` : 'Someone else'}</span>}
                    {session.cycle_code && <span className="text-[10px] font-semibold text-teal-300 bg-teal-900/35 rounded px-1.5 py-0.5 shrink-0">{session.cycle_code}</span>}
                  </span>
                  <span className="block text-xs text-pool-400 mt-1">
                    {[day, session.time && `${session.time}${session.end_time ? `–${session.end_time}` : ''}`, session.squad].filter(Boolean).join(' · ')}
                  </span>
                </button>
                <DeskMenu
                  name={session.title || session.label || 'session'}
                  onCancel={() => onCancel(session)}
                  onDismiss={() => onDismiss(session)}
                />
              </div>

              {(session.coach_intent || session.coach_notes || groups.length > 0 || mods.length > 0) ? (
                <div className="mt-3 desk-rule pt-3 space-y-2">
                  {session.coach_intent && <p className="text-xs text-pool-300 whitespace-pre-line"><span className="text-pool-500">Aim · </span>{session.coach_intent}</p>}
                  {groups.map(group => (
                    <div key={group.group_number} className="text-xs">
                      <span className="font-semibold text-accent-300">G{group.group_number}</span>
                      {group.description && <span className="text-pool-300"> · {group.description}</span>}
                      {group.sets && <p className="text-pool-500 font-mono mt-0.5 line-clamp-2 whitespace-pre-line">{group.sets}</p>}
                    </div>
                  ))}
                  {session.coach_notes && <p className="text-xs text-amber-200/90 line-clamp-2 whitespace-pre-line">{session.coach_notes}</p>}
                  {mods.length > 0 && <p className="text-xs text-amber-300">{mods.length} individual note{mods.length === 1 ? '' : 's'} attached</p>}
                </div>
              ) : (
                <p className="text-xs text-pool-500 mt-3 desk-rule pt-3">No session plan attached yet.</p>
              )}

              {chaseRegister && (
                <p className="flex items-start gap-2 text-xs text-amber-200 mt-3">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  Finished. Take the register while it's fresh: it's what the staff learn from.
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 mt-3.5">
                <button onClick={() => onOpen(session)} disabled={busy} className="desk-btn desk-btn--primary">
                  {busyKey === `${key}:open` ? busyLabel : <><DeskIcon name="open" />Open</>}
                </button>
                <button onClick={() => onRegister(session)} disabled={busy}
                  className={`desk-btn ${chaseRegister ? 'desk-btn--warn' : session.registered ? 'desk-btn--done' : ''}`}>
                  {busyKey === `${key}:register` ? busyLabel : <><DeskIcon name={session.registered ? 'done' : 'register'} />Register</>}
                </button>
                {written ? (
                  <Link to={`/builder/${session.session_id}?view=pool`} className="desk-btn">
                    <DeskIcon name="pool" />Poolside
                  </Link>
                ) : (
                  <Link to={session.session_id ? `/builder/${session.session_id}` : `/builder/new?date=${session.date}&slot=${session.slot_id || ''}`}
                    className="desk-btn">
                    <DeskIcon name="write" />Write it
                  </Link>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

// What the staff need from the coach, in one list. Tap one to open it in place:
// what it's attached to, what started it, the whole of it, and what you can do about it.
const ASK_TONE = { safety: 'red', prediction: 'blue', review: 'blue', question: 'blue' }
const ASK_LABEL = { safety: 'Safety flag', prediction: 'Prediction to check', review: 'Workbooks changed', question: 'Questions' }
const shortDay = iso => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '')

function AskFact({ label, children }) {
  if (!children) return null
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-14 shrink-0 text-pool-500">{label}</span>
      <span className="min-w-0 text-pool-300">{children}</span>
    </div>
  )
}

function AskDetail({ ask, busy, onAct }) {
  const session = ask.session
  return (
    <div className="desk-rule px-4 pt-3 pb-3.5 space-y-3">
      <div className="space-y-1.5">
        {session && (
          <AskFact label="On">
            <Link to={`/builder/${session.id}`} className="text-accent-300">
              {[session.title || 'Session', shortDay(session.date), session.time, session.squad].filter(Boolean).join(' · ')}
            </Link>
          </AskFact>
        )}
        <AskFact label="Where">{ask.block}</AskFact>
        <AskFact label="About">{ask.swimmers?.length ? ask.swimmers.join(', ') : null}</AskFact>
        <AskFact label="From">{ask.trigger}</AskFact>
        <AskFact label="Raised">{ask.raised && shortDay(ask.raised)}</AskFact>
        <AskFact label="Due">{ask.due && shortDay(ask.due)}</AskFact>
      </div>

      {ask.question && <p className="text-xs text-pool-200 bg-white/[0.04] rounded px-3 py-2">{ask.question}</p>}

      {ask.kind === 'review' && (
        <ul className="desk-divide border-l border-white/10 pl-3">
          {ask.pages.map(page => {
            const key = `${page.role}:${page.path}`
            return (
              <li key={key} className="py-2 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-pool-100">{page.title || page.path}</p>
                  <p className="text-[11px] text-pool-500">{page.name}{page.reason ? ` · ${page.reason}` : ''}</p>
                  {page.summary && <p className="text-xs text-pool-400 mt-0.5 line-clamp-3">{page.summary}</p>}
                </div>
                <button type="button" disabled={Boolean(busy)} onClick={() => onAct('tick', page)} className="desk-btn desk-btn--sm">
                  {busy === `tick:${key}` ? '…' : 'Tick'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {ask.kind === 'question' && (
        <ul className="space-y-1">
          {ask.terms.map(t => (
            <li key={t.term} className="text-xs text-pool-300">
              <span className="font-mono text-pool-100">{t.term}</span>
              <span className="text-pool-500"> · in {t.files} file{t.files === 1 ? '' : 's'}, e.g. {t.example}</span>
            </li>
          ))}
        </ul>
      )}

      {ask.error && <p className="text-xs text-red-300">{ask.error}</p>}

      {ask.kind === 'safety' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => onAct('acknowledge')} className="desk-btn desk-btn--primary">
              {busy === 'acknowledge' ? 'Saving…' : 'Acknowledge'}
            </button>
            <Link to={ask.link} className="desk-btn">{session ? 'Open session' : 'Open workbooks'}</Link>
          </div>
          {ask.can_rate && (
            <div className="flex items-center gap-3 text-[11px] text-pool-500">
              <span>Was it useful?</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => onAct('useful', true)}
                className={`desk-quiet ${ask.useful === true ? 'text-teal-300' : ''}`}>Yes</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => onAct('useful', false)}
                className={`desk-quiet ${ask.useful === false ? 'text-amber-300' : ''}`}>No</button>
            </div>
          )}
          <p className="text-[11px] text-pool-500">Acknowledging tells the staff you've seen it. Safety flags are never switched off.</p>
        </>
      )}

      {ask.kind === 'prediction' && (
        <div className="grid grid-cols-3 gap-2">
          {[['right', 'It happened'], ['wrong', "It didn't"], ['no result', "Can't tell"]].map(([outcome, label]) => (
            <button key={outcome} type="button" disabled={Boolean(busy)} onClick={() => onAct('mark', outcome)}
              className={`desk-btn ${outcome === 'right' ? 'desk-btn--teal' : ''}`}>
              {busy === `mark:${outcome}` ? '…' : label}
            </button>
          ))}
        </div>
      )}

      {ask.kind === 'review' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={Boolean(busy)} onClick={() => onAct('tick-all')} className="desk-btn desk-btn--primary">
            {busy === 'tick-all' ? 'Ticking…' : 'Tick all as read'}
          </button>
          <Link to={ask.link} className="desk-btn">Open workbooks</Link>
        </div>
      )}

      {ask.kind === 'question' && (
        <Link to={ask.link} className="desk-btn desk-btn--primary w-full">Answer Maggie</Link>
      )}
    </div>
  )
}

function StaffAsksCard() {
  const [asks, setAsks] = useState(null)
  const [openKey, setOpenKey] = useState(null)
  const [busy, setBusy] = useState({ key: null, what: null })
  useEffect(() => { api.getStaffAsks().then(setAsks).catch(() => setAsks(null)) }, [])
  if (!asks || asks.items.length === 0) return null

  const patch = (key, change) => setAsks(prev => ({ ...prev, items: prev.items.map(a => (a.key === key ? { ...a, ...change } : a)) }))
  const drop = key => setAsks(prev => {
    const items = prev.items.filter(a => a.key !== key)
    return { ...prev, items, count: items.length }
  })

  const act = async (ask, what, value) => {
    const busyWhat = what === 'tick' ? `tick:${value.role}:${value.path}` : what === 'mark' ? `mark:${value}` : what
    setBusy({ key: ask.key, what: busyWhat })
    patch(ask.key, { error: '' })
    try {
      if (what === 'acknowledge') {
        await api.updateStaffNote(ask.note_id, 'dismissed')
        drop(ask.key)
      } else if (what === 'useful') {
        await api.decideBuilderComment(ask.note_id, { action: 'useful', useful: value })
        patch(ask.key, { useful: value })
      } else if (what === 'mark') {
        await api.markPrediction(ask.prediction_id, value)
        drop(ask.key)
      } else if (what === 'tick' || what === 'tick-all') {
        const pages = what === 'tick' ? [value] : ask.pages
        for (const page of pages) await api.tickWorkbookPage(page.role, page.path)
        const left = ask.pages.filter(p => !pages.includes(p))
        if (left.length) {
          patch(ask.key, { pages: left, text: `${left.length} workbook page${left.length === 1 ? '' : 's'} changed this week, to read and tick` })
        } else {
          drop(ask.key)
        }
      }
    } catch (error) {
      patch(ask.key, { error: `That didn't save: ${error.message}` })
    }
    setBusy({ key: null, what: null })
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">The staff need you</p>
        <span className="text-[11px] font-bold text-white bg-accent-600 rounded px-2 py-0.5 tabular-nums">{asks.items.length}</span>
      </div>
      {asks.items.slice(0, 6).map(a => {
        const open = openKey === a.key
        return (
          <article key={a.key} data-tone={ASK_TONE[a.kind] || 'blue'} className="desk-card">
            <button type="button" aria-expanded={open} onClick={() => setOpenKey(open ? null : a.key)}
              className="w-full flex items-start gap-3 px-4 py-3 text-left">
              <div className="min-w-0 flex-1">
                <p className={`text-[11px] ${a.kind === 'safety' ? 'text-red-300' : 'text-pool-400'}`}>
                  {ASK_LABEL[a.kind] || 'From the staff'} · {a.who}
                </p>
                <p className={`text-sm text-pool-200 mt-0.5 whitespace-pre-line ${open ? '' : 'line-clamp-2'}`}>
                  {a.kind === 'prediction' && open ? a.statement : a.text}
                </p>
              </div>
              <span className="mt-1"><Chevron open={open} /></span>
            </button>
            {open && (
              <AskDetail ask={a} busy={busy.key === a.key ? busy.what : null} onAct={(what, value) => act(a, what, value)} />
            )}
          </article>
        )
      })}
      {asks.items.length > 6 && <Link to="/workbooks" className="block text-xs text-accent-400 px-0.5">{asks.items.length - 6} more ›</Link>}
    </section>
  )
}

// Getting started: shown until every step is done, or the coach hides it.
function SetupChecklist() {
  const [list, setList] = useState(null)
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('setup.hidden') === '1' } catch { return false } })
  useEffect(() => { if (!hidden) api.getSetupChecklist().then(setList).catch(() => setList(null)) }, [hidden])
  if (hidden || !list || list.done === list.total) return null
  const hide = () => { setHidden(true); try { localStorage.setItem('setup.hidden', '1') } catch { /* fine */ } }
  const next = list.steps.find(s => !s.done)
  return (
    <section data-tone="blue" className="desk-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-accent-300 uppercase tracking-wider">Getting started</p>
          <p className="text-[11px] text-pool-500 mt-0.5">{list.done} of {list.total} done</p>
        </div>
        <button type="button" onClick={hide} className="desk-quiet">Hide</button>
      </div>
      <div className="h-1.5 bg-pool-700 rounded-full overflow-hidden"><div className="h-full bg-accent-500" style={{ width: `${(list.done / list.total) * 100}%` }} /></div>
      <ol className="space-y-1.5">
        {list.steps.map(s => (
          <li key={s.key}>
            <Link to={s.link} className={`flex items-start gap-2.5 rounded px-2 py-1.5 ${s === next ? 'bg-accent-600/15' : ''}`}>
              <span className={`mt-0.5 w-4 h-4 rounded-full border grid place-items-center text-[10px] shrink-0 ${s.done ? 'bg-teal-600 border-teal-500 text-white' : 'border-pool-500'}`}>{s.done ? '✓' : ''}</span>
              <span className="min-w-0">
                <span className={`block text-sm ${s.done ? 'text-pool-500 line-through' : 'text-pool-100'}`}>{s.label}</span>
                {s === next && <span className="block text-xs text-pool-400">{s.detail}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <Link to="/help" className="block text-xs text-accent-400">How the app works ›</Link>
    </section>
  )
}

// This week of the coach's season plan, group by group.
function PlanWeekCard({ squads }) {
  const [weeks, setWeeks] = useState([])
  useEffect(() => {
    Promise.all(squads.map(s => api.getPlanWeek(s).catch(() => null))).then(list => setWeeks(list.filter(Boolean)))
  }, [squads.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!weeks.length) return null
  return (
    <section className="space-y-2">
      {weeks.map(w => w.guide ? <PlanGuide key={w.squad} squad={w.squad} g={w.guide} /> : (
        <Link key={w.squad} to={`/season/${encodeURIComponent(w.squad)}`} data-tone="teal" className="desk-card block p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-teal-300 uppercase tracking-wider">{w.squad} · this week</p>
            <span className="text-xs text-pool-500">Season Planner ›</span>
          </div>
          {w.groups.map(g => (
            <div key={g.id} className="flex items-baseline gap-2 text-sm">
              <span className="font-medium text-pool-100 shrink-0">{g.name}</span>
              {g.code && <span className="text-[11px] font-semibold text-teal-300 shrink-0">{g.code}</span>}
              <span className="text-xs text-pool-400 truncate">{[g.phase, g.objective].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
          {w.away > 0 && <p className="text-xs text-amber-300">{w.away} swimmer{w.away === 1 ? '' : 's'} on camp or away</p>}
        </Link>
      ))}
    </section>
  )
}

const shortDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const guideKey = (squad, start) => `planGuide:${squad}:${start}`
function guideHidden(squad, start) {
  try { return window.localStorage.getItem(guideKey(squad, start)) === '1' } catch { return false }
}

/* The week (or micro) for the staff: the block, each group's sessions and versions, who isn't with their
   group, and what was cancelled last time. Each person hides it for themselves until the next one starts. */
function PlanGuide({ squad, g }) {
  const [hidden, setHidden] = useState(() => guideHidden(squad, g.week_start))
  const unit = g.micro ? 'micro' : 'week'
  const hide = value => {
    try { value ? window.localStorage.setItem(guideKey(squad, g.week_start), '1') : window.localStorage.removeItem(guideKey(squad, g.week_start)) } catch { /* a private window: hidden until reload */ }
    setHidden(value)
  }
  if (hidden) {
    return (
      <button type="button" onClick={() => hide(false)}
        className="w-full text-left text-sm text-pool-400 border border-dashed border-pool-700 rounded px-4 py-2.5">
        {squad} · this {unit}'s guide is hidden · <span className="text-accent-400 font-semibold">Show it</span>
      </button>
    )
  }
  const b = g.block
  const nw = g.not_with_group || []
  const last = g.last
  return (
    <div data-tone="teal" className="desk-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-teal-300 uppercase tracking-wider">{squad} · this {unit}</p>
          <h2 className="font-semibold text-pool-100 mt-0.5">
            {b ? `${b.name}, ${unit} ${b.n} of ${b.of}` : `This ${unit}`}
          </h2>
          <p className="text-xs text-pool-400">
            {shortDate(g.week_start)} – {shortDate(g.week_end)}{g.micro ? ` · ${g.days} days` : ''}
            {b?.next && b.n === b.of ? ` · then ${b.next}` : ''}
          </p>
          {b?.objective && <p className="text-xs text-pool-300 mt-1">{b.objective}</p>}
        </div>
        <button type="button" onClick={() => hide(true)} title={`Hide until next ${unit}'s guide`}
          className="shrink-0 text-xs font-semibold text-pool-300 border border-pool-600 rounded px-2.5 py-1" style={{ minHeight: 0 }}>
          Got it ✕
        </button>
      </div>

      {g.groups.map(gr => (
        <div key={gr.id} className="space-y-1">
          <p className="text-sm font-semibold text-pool-100">
            {gr.name} <span className="text-xs font-normal text-pool-400">· {Math.round((gr.load || 0) * 100)}% load</span>
          </p>
          {gr.same_as ? (
            <p className="text-xs text-pool-400">Same sessions as {gr.same_as}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1">
                {gr.sessions.map(s => (
                  <span key={s.label + s.date} title={s.notes || undefined}
                    className={`text-[11px] px-1.5 py-0.5 rounded bg-pool-700 ${s.cancelled ? 'line-through text-pool-500' : 'text-pool-300'}`}>
                    {s.label} · {s.versions.length ? s.versions.map(v => v.focus).join(' | ') : s.focus}
                  </span>
                ))}
              </div>
              {gr.sessions.filter(s => s.versions.length && !s.cancelled).map(s => (
                <p key={'v' + s.label + s.date} className="text-xs text-pool-400">
                  <span className="text-pool-100 font-semibold">{s.label}:</span>{' '}
                  {s.versions.map((v, n) => (
                    <span key={n}>{n > 0 && '; '}{v.focus} for {v.who}{v.names.length ? ` (${v.names.join(', ')})` : ''}</span>
                  ))}
                </p>
              ))}
            </>
          )}
        </div>
      ))}

      {nw.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-amber-300">Not with their group</p>
          <p className="text-xs text-pool-300">
            {nw.map((x, n) => <span key={x.name + n}>{n > 0 && ' · '}<span className="text-pool-100 font-semibold">{x.first}</span> {x.why.join(', ')}</span>)}
          </p>
        </div>
      )}

      {last && (last.cancelled.length > 0 || last.extra > 0) && (
        <p className="text-xs text-pool-400">
          <span className="font-semibold text-pool-300">Last {unit}:</span>{' '}
          {last.cancelled.map((c, n) => <span key={c.date + n}>{n > 0 && ', '}{c.label} cancelled{c.reason ? ` (${c.reason})` : ''}</span>)}
          {last.cancelled.length > 0 && last.extra > 0 && ' · '}
          {last.extra > 0 && `${last.extra} extra session${last.extra === 1 ? '' : 's'}`}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <Link to={`/season/${encodeURIComponent(squad)}?tab=weeks`} className="text-sm font-semibold text-accent-400">Open the {unit} ›</Link>
        <span className="text-[11px] text-pool-500">Hidden for you only, until the next {unit}</span>
      </div>
    </div>
  )
}

// Attendance bar — 5 segments, filled proportionally
function AttendanceBar({ attended, expected }) {
  const ratio = expected > 0 ? attended / expected : 0
  const filled = Math.round(ratio * 5)
  const colour = ratio >= 0.8 ? 'bg-emerald-500' : ratio >= 0.5 ? 'bg-amber-500' : 'bg-red-500/70'
  return (
    <div className="flex gap-0.5" title={`${attended}/${expected} sessions`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={`w-1.5 h-3 rounded-sm ${i < filled ? colour : 'bg-pool-700'}`} />
      ))}
    </div>
  )
}

function AttendanceStatus({ swimmer }) {
  if (swimmer.attendance_state === 'established') {
    return <AttendanceBar attended={swimmer.sessions_attended} expected={swimmer.sessions_expected} />
  }
  const label = swimmer.attendance_state === 'building_baseline'
    ? `${swimmer.sessions_recorded || 0} logged · % after 4`
    : 'Not baselined'
  return (
    <span
      title="Attendance percentage is calculated after 4 recorded sessions"
      className="text-[10px] text-teal-300 bg-teal-900/25 border border-teal-800/40 px-1.5 py-0.5 rounded-md whitespace-nowrap"
    >
      {label}
    </span>
  )
}

function TargetChip({ target }) {
  const { weeks_out, days_out, gap_seconds } = target
  const urgent = weeks_out <= 2
  const gapStr = gap_seconds !== null && gap_seconds !== undefined
    ? (gap_seconds > 0 ? `${gap_seconds.toFixed(1)}s off` : `on target`)
    : null

  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md whitespace-nowrap ${
      urgent
        ? 'bg-red-900/50 text-red-300 border border-red-800/50'
        : 'bg-pool-700 text-pool-400 border border-pool-600'
    }`}>
      {weeks_out <= 1 ? `${days_out}d` : `${weeks_out}w`}{gapStr ? ` · ${gapStr}` : ''}
    </span>
  )
}

function SwimmerPulseRow({ swimmer }) {
  const { id, name, approaching_target, last_observation, has_recent_skill_flag } = swimmer
  const noData = swimmer.sessions_recorded === 0 && !last_observation && !approaching_target && !swimmer.current_availability

  return (
    <Link to={`/swimmers/${id}`} className="block active:opacity-70 transition-opacity">
      <div className="py-2.5">
        <div className="flex items-center gap-2.5">
          {/* Name */}
          <span className="text-sm font-medium text-pool-200 w-28 shrink-0 truncate">{name}</span>

          {/* Attendance */}
          <AttendanceStatus swimmer={swimmer} />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Skill flag */}
          {has_recent_skill_flag && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" title="Recent AI review" />
          )}

          {/* Target chip */}
          {approaching_target && <TargetChip target={approaching_target} />}
        </div>

        {/* Observation snippet */}
        {last_observation && !noData && (
          <p className="text-[11px] text-pool-500 mt-1 ml-0 truncate leading-snug">
            <span className="text-pool-600">{last_observation.days_ago === 0 ? 'today' : last_observation.days_ago === 1 ? 'yesterday' : `${last_observation.days_ago}d ago`} · </span>
            {last_observation.snippet}
          </p>
        )}
        {swimmer.current_availability && (
          <p className="text-[11px] text-amber-400 mt-1 truncate">
            {swimmer.current_availability.label}
            {swimmer.current_availability.detail ? ` — ${swimmer.current_availability.detail}` : ''}
            {` · until ${swimmer.current_availability.date_to}`}
          </p>
        )}
        {noData && swimmer.attendance_state === 'established' && (
          <p className="text-[11px] text-pool-700 mt-1">No recent data</p>
        )}
      </div>
    </Link>
  )
}

function SquadPulse({ pulse }) {
  const [expanded, setExpanded] = useState(false)
  const PREVIEW = 6
  const visible = expanded ? pulse : pulse.slice(0, PREVIEW)
  const hasMore = pulse.length > PREVIEW

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wider">Squad Pulse</h2>
        <Link to="/swimmers" className="text-xs text-pool-500 hover:text-pool-300">Full squad →</Link>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mb-2 px-0.5">
        <span className="text-[10px] text-pool-600">Attendance % shown after 4 recorded sessions</span>
        <div className="flex gap-1 items-center">
          <div className="w-1.5 h-2.5 rounded-sm bg-emerald-500" />
          <span className="text-[10px] text-pool-600">≥80%</span>
        </div>
        <div className="flex gap-1 items-center">
          <div className="w-1.5 h-2.5 rounded-sm bg-amber-500" />
          <span className="text-[10px] text-pool-600">50–79%</span>
        </div>
        <div className="flex gap-1 items-center">
          <div className="w-1.5 h-2.5 rounded-sm bg-red-500/70" />
          <span className="text-[10px] text-pool-600">&lt;50%</span>
        </div>
      </div>

      <div className="desk-card desk-divide px-4 py-1">
        {visible.map(sw => (
          <SwimmerPulseRow key={sw.id} swimmer={sw} />
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full mt-1.5 text-xs text-pool-500 hover:text-pool-300 py-1.5 transition-colors"
        >
          {expanded ? '↑ Show less' : `↓ Show ${pulse.length - PREVIEW} more`}
        </button>
      )}
    </section>
  )
}

function SeasonStartCard({ onStarted }) {
  const now = new Date()
  const year = now.getFullYear()
  const seasonEndYear = now.getMonth() >= 6 ? year + 1 : year
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    name: `${seasonEndYear - 1}/${String(seasonEndYear).slice(-2)} Season`,
    squad: 'Silver 1',
    date_from: now.toISOString().slice(0, 10),
    date_to: `${seasonEndYear}-07-31`,
    narrative: '',
  })

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const season = await api.startPlanningSeason({ ...form, is_current: true })
      await onStarted(season, 'Season started and saved.')
    } catch (err) {
      // The server may have committed successfully even if the response was
      // interrupted. Read back the durable state before showing a failure.
      try {
        const current = await api.getCurrentPlanningSeason()
        const matches = current
          && current.name === form.name
          && current.date_from === form.date_from
          && current.date_to === form.date_to
        if (matches) {
          await onStarted(current, 'Season was saved successfully. The confirmation response was interrupted.')
          return
        }
      } catch {
        // Keep the original error below, with a safe retry instruction.
      }
      setError(`${err.message || 'Could not confirm the season save'}. Refresh before trying again; it may already have saved.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section data-tone="teal" className="desk-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-teal-300 uppercase tracking-wide">New season</p>
          <h2 className="font-semibold text-pool-100 mt-1">Start the current-season baseline</h2>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">
            This keeps every old time and coaching note, but stops last season's missing registers being treated as current concerns.
          </p>
        </div>
        {!expanded && (
          <button onClick={() => setExpanded(true)} className="desk-btn desk-btn--teal desk-btn--sm">
            Start
          </button>
        )}
      </div>
      {expanded && (
        <form onSubmit={submit} className="mt-4 space-y-3 desk-rule pt-4">
          <label className="block text-xs text-pool-400">
            Season name
            <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-3 py-2.5 text-sm text-pool-100" />
          </label>
          <label className="block text-xs text-pool-400">
            Squad
            <input value={form.squad} onChange={e => setForm({ ...form, squad: e.target.value })}
              className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-3 py-2.5 text-sm text-pool-100" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-pool-400">
              Starts
              <input required type="date" value={form.date_from} onChange={e => setForm({ ...form, date_from: e.target.value })}
                className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-2 py-2.5 text-sm text-pool-100" />
            </label>
            <label className="block text-xs text-pool-400">
              Ends
              <input required type="date" value={form.date_to} onChange={e => setForm({ ...form, date_to: e.target.value })}
                className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-2 py-2.5 text-sm text-pool-100" />
            </label>
          </div>
          <label className="block text-xs text-pool-400">
            Opening intent (optional)
            <textarea rows="2" value={form.narrative} onChange={e => setForm({ ...form, narrative: e.target.value })}
              placeholder="e.g. Re-establish routines, assess current capacity, then build towards winter meets"
              className="mt-1 w-full bg-pool-900 border border-pool-600 rounded-lg px-3 py-2.5 text-sm text-pool-100 resize-none" />
          </label>
          {error && <p className="text-xs text-red-300">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setExpanded(false)} className="flex-1 desk-btn">Cancel</button>
            <button disabled={saving} className="flex-1 desk-btn desk-btn--teal">
              {saving ? 'Starting...' : 'Start season'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

function CurrentSeasonCard({ season, pulse, notice }) {
  const established = pulse.filter(sw => sw.attendance_state === 'established').length
  const building = pulse.filter(sw => sw.attendance_state === 'building_baseline').length
  return (
    <section data-tone="teal" className="desk-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-teal-300 truncate">{season.name}</p>
          <p className="text-[11px] text-pool-500 mt-0.5">Current baseline starts {season.date_from}</p>
        </div>
        <span className="text-[11px] text-pool-400 shrink-0">
          {building > 0 ? `${established}/${pulse.length} established` : `${established} established`}
        </span>
      </div>
      {building > 0 && (
        <p className="text-[11px] text-pool-500 mt-2">Keep taking registers; attendance flags begin after 4 recorded opportunities per swimmer.</p>
      )}
      {notice && (
        <p className="text-[11px] text-emerald-300 mt-2">{notice}</p>
      )}
    </section>
  )
}

// Injuries and galas have their own cards at the top; this is everyone else away.
const OWN_CARD = new Set(['injury', 'competition'])

function AvailabilityCard({ report }) {
  const [expanded, setExpanded] = useState(false)
  const items = (report?.items || []).filter(item => !OWN_CARD.has(item.reason))
  if (items.length === 0) return null
  const visible = expanded ? items : items.slice(0, 5)
  const now = items.filter(item => item.is_current).length
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-pool-400 uppercase tracking-wider">Away</h2>
        <span className="text-[11px] text-pool-500">
          {now} away now · {items.length - now} upcoming
        </span>
      </div>
      <div className="desk-card desk-divide">
        {visible.map((item, index) => (
          <Link key={`${item.swimmer_id}-${item.date_from}-${item.reason}-${index}`} to={`/swimmers/${item.swimmer_id}`}
            className="flex items-center justify-between gap-3 px-4 py-3 active:bg-white/5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-pool-200 truncate">{item.swimmer_name}</p>
              <p className="text-xs text-pool-500 truncate">
                {item.detail || item.label} · {item.date_from === item.date_to ? item.date_from : `${item.date_from} → ${item.date_to}`}
              </p>
            </div>
            <span className={`text-[10px] px-2 py-1 rounded shrink-0 ${
              item.is_current ? 'bg-amber-900/50 text-amber-300' : 'bg-pool-700 text-pool-400'
            }`}>{item.is_current ? item.label : `in ${item.days_until}d`}</span>
          </Link>
        ))}
      </div>
      {items.length > 5 && (
        <button onClick={() => setExpanded(value => !value)} className="w-full text-xs text-pool-500 py-2">
          {expanded ? 'Show less' : `Show ${items.length - 5} more`}
        </button>
      )}
    </section>
  )
}

// How close a gala is: red inside a fortnight, amber inside six weeks.
function galaUrgency(days) {
  if (days <= 14) return { tone: 'red', accent: 'text-red-300', label: 'text-red-400/70', bar: 'bg-red-500' }
  if (days <= 42) return { tone: 'amber', accent: 'text-amber-300', label: 'text-amber-400/70', bar: 'bg-amber-500' }
  return { tone: 'teal', accent: 'text-teal-300', label: 'text-teal-400/70', bar: 'bg-teal-500' }
}

const PRIORITY_CHIP = {
  A: 'bg-red-900/50 text-red-200 border-red-700/60',
  B: 'bg-amber-900/40 text-amber-200 border-amber-700/50',
  C: 'bg-pool-700 text-pool-300 border-pool-600',
}

function PriorityChip({ priority }) {
  if (!priority) return <span className="text-[10px] text-pool-600 w-6 text-center shrink-0" title="No priority set">–</span>
  return (
    <span className={`text-[11px] font-bold w-6 text-center py-0.5 rounded border shrink-0 ${PRIORITY_CHIP[priority]}`}
      title={`${priority} meet for this swimmer`}>
      {priority}
    </span>
  )
}

const dayLabel = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const meetDates = m => (m.date_to && m.date_to !== m.date ? `${dayLabel(m.date)} – ${dayLabel(m.date_to)}` : dayLabel(m.date))
const countdown = m => (m.on_now ? 'on now' : m.days_out === 0 ? 'today' : m.days_out === 1 ? 'tomorrow' : `${m.days_out}d`)
const priorityMix = counts => ['A', 'B', 'C'].filter(p => counts?.[p]).map(p => `${counts[p]} ${p}`).join(' · ')

function readOpen(key) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}
function saveOpen(key, open) {
  try { localStorage.setItem(key, open ? '1' : '0') } catch { /* private window */ }
}

function Chevron({ open }) {
  return (
    <svg viewBox="0 0 12 12" className={`w-3 h-3 text-pool-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  )
}

/* One gala: when it is, how long until, and (opened) who's going with their priority. */
function GalaRow({ meet, open, onToggle, unwell }) {
  const u = galaUrgency(meet.days_out)
  const mix = priorityMix(meet.priority_counts)
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-white/5">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-pool-100 truncate">{meet.name}</p>
          <p className="text-[11px] text-pool-400 mt-0.5 truncate">
            {meetDates(meet)}
            {` · ${meet.swimmers.length} swimmer${meet.swimmers.length === 1 ? '' : 's'}`}
            {mix ? ` · ${mix}` : ''}
          </p>
          {meet.target_for.length > 0 && (
            <p className={`text-[10px] font-semibold uppercase tracking-wider mt-1 ${u.label}`}>
              Target meet · {meet.target_for.join(', ')}
            </p>
          )}
        </div>
        <span className={`text-sm font-bold tabular-nums shrink-0 ${u.accent}`}>{countdown(meet)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-3">
          {meet.swimmers.length === 0 ? (
            <p className="text-xs text-pool-500 py-1">No one entered yet.</p>
          ) : (
            <div className="desk-divide border-l border-white/10 pl-3">
              {meet.swimmers.map(s => (
                <Link key={s.swimmer_id} to={`/swimmers/${s.swimmer_id}`} className="flex items-center gap-2.5 py-2 active:opacity-70">
                  <PriorityChip priority={s.priority} />
                  <span className="text-sm text-pool-200 truncate">{s.name}</span>
                  {unwell.has(s.swimmer_id) && (
                    <span className={`text-[10px] font-semibold uppercase tracking-wider shrink-0 ${unwell.get(s.swimmer_id) === 'illness' ? 'text-amber-300' : 'text-red-300'}`}>
                      {unwell.get(s.swimmer_id) === 'illness' ? 'Ill' : 'Injury'}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="text-[11px] text-pool-500 shrink-0">
                    {s.events.length ? `${s.events.length} event${s.events.length === 1 ? '' : 's'}` : ''}
                  </span>
                </Link>
              ))}
            </div>
          )}
          <Link to={`/meets/${meet.meet_id}`} className="inline-block mt-2 text-xs text-accent-400 font-semibold">Open meet ›</Link>
        </div>
      )}
    </div>
  )
}

/* Galas coming up: the next one and its countdown at a glance; opened, every gala,
   each opening to who's going and how much it matters to them (A/B/C). */
function GalasCard({ data, unwell = [] }) {
  const meets = data?.meets || []
  const unwellKind = new Map(unwell.map(u => [u.swimmer_id, u.kind]))
  const [open, setOpen] = useState(() => readOpen('home.galas.open'))
  const [openMeet, setOpenMeet] = useState(null)
  if (!meets.length) return null
  const next = meets[0]
  const u = galaUrgency(next.days_out)
  const toggle = () => setOpen(value => { saveOpen('home.galas.open', !value); return !value })
  // 0% = 12+ weeks out, 100% = today
  const progress = Math.min(100, Math.max(4, Math.round((1 - next.days_out / 84) * 100)))
  const weeks = Math.ceil(next.days_out / 7)

  return (
    <section data-tone={u.tone} className="desk-card">
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full block px-4 py-3.5 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className={`text-[10px] font-semibold uppercase tracking-wider ${u.label}`}>
              Galas · {data.swimmer_count} swimmer{data.swimmer_count === 1 ? '' : 's'} · {meets.length} meet{meets.length === 1 ? '' : 's'}
            </p>
            <p className="font-semibold text-sm text-pool-100 mt-0.5 truncate">{next.name}</p>
            <p className="text-[11px] text-pool-400 mt-0.5 truncate">
              {next.target_for.length ? `${next.target_for.join(', ')} target · ` : ''}
              {next.swimmers.length} going{priorityMix(next.priority_counts) ? ` · ${priorityMix(next.priority_counts)}` : ''}
            </p>
          </div>
          <div className="text-right shrink-0">
            {next.on_now ? (
              <p className={`text-base font-bold leading-none ${u.accent}`}>On now</p>
            ) : (
              <>
                <p className={`text-2xl font-bold leading-none tabular-nums ${u.accent}`}>{next.days_out}</p>
                <p className={`text-[10px] mt-0.5 ${u.label}`}>{next.days_out === 1 ? 'day' : next.days_out < 14 ? 'days' : `days · ${weeks}w`}</p>
              </>
            )}
          </div>
          <span className="self-center"><Chevron open={open} /></span>
        </div>
        <div className="mt-2.5 h-1 rounded-full bg-white/[0.06]">
          <div className={`h-full rounded-full ${u.bar}`} style={{ width: `${progress}%` }} />
        </div>
      </button>
      {open && (
        <div className="desk-divide desk-rule">
          {meets.map(m => (
            <GalaRow key={m.meet_id} meet={m} open={openMeet === m.meet_id} unwell={unwellKind}
              onToggle={() => setOpenMeet(id => (id === m.meet_id ? null : m.meet_id))} />
          ))}
          <div className="px-4 py-2.5 flex justify-between text-xs">
            <span className="text-pool-500">A, B, C: how much each meet matters to the swimmer</span>
            <Link to="/meets" className="text-pool-400 shrink-0 ml-3">All meets ›</Link>
          </div>
        </div>
      )}
    </section>
  )
}

/* Who's injured or ill right now, at the top so it's seen before planning anything. */
function UnwellCard({ items }) {
  if (!items.length) return null
  const shortDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return (
    <section data-tone="red" className="desk-card">
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-red-300">Injured &amp; ill</p>
        <span className="text-[11px] text-pool-400">{items.length} swimmer{items.length === 1 ? '' : 's'}</span>
      </div>
      <div className="desk-divide desk-rule">
        {items.map(item => (
          <Link key={`${item.swimmer_id}-${item.source}`} to={`/swimmers/${item.swimmer_id}`}
            className="flex items-start gap-3 px-4 py-2.5 active:bg-white/5">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-pool-100 truncate">
                {item.name}
                <span className={`ml-2 text-[10px] font-semibold uppercase tracking-wider ${item.kind === 'illness' ? 'text-amber-300' : 'text-red-300'}`}>
                  {item.kind === 'illness' ? 'Ill' : 'Injury'}
                </span>
              </p>
              <p className="text-xs text-pool-400 truncate">
                {item.title}{item.impact ? ` · ${item.impact}` : ''}
              </p>
            </div>
            <span className="text-[11px] text-pool-500 shrink-0 mt-0.5">
              {item.until ? `until ${shortDate(item.until)}` : item.since ? `since ${shortDate(item.since)}` : ''}
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}

function AssistantInboxPreview({ inbox }) {
  const items = (inbox?.items || []).filter(item => item.status === 'open').slice(0, 3)
  const openCount = inbox?.counts?.open || 0
  const progressCount = inbox?.counts?.in_progress || 0
  if (openCount === 0 && progressCount === 0) return null

  return (
    <section data-tone="blue" className="desk-card">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-xs font-semibold text-accent-300 uppercase tracking-wide">Assistant coach</p>
          <p className="text-[11px] text-pool-500 mt-0.5">
            {openCount} need{openCount === 1 ? 's' : ''} a decision
            {progressCount > 0 ? ` · ${progressCount} in progress` : ''}
          </p>
        </div>
        <Link to="/assistant" className="text-xs text-accent-400 font-semibold">Open inbox →</Link>
      </div>
      {items.length > 0 && (
        <div className="desk-divide desk-rule">
          {items.map(item => (
            <Link key={item.id} to="/assistant" className="block px-4 py-3 active:bg-white/5">
              <div className="flex items-start gap-2.5">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${item.severity === 'warning' ? 'bg-amber-400' : 'bg-teal-400'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-pool-200">{item.title}</p>
                  <p className="text-xs text-pool-500 mt-0.5 line-clamp-2">{item.detail}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

function SessionDebriefPrompts({ items, onSkip, busyKey }) {
  if (!items.length) return null

  return (
    <section data-tone="teal" className="desk-card">
      <div className="px-4 pt-4 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-300">Session debrief</p>
        <p className="text-sm text-pool-200 mt-1">Talk it through while it&apos;s fresh.</p>
      </div>
      <div className="desk-divide desk-rule">
        {items.map(item => (
          <div key={item.session_id} className="px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-pool-100 truncate">{item.title}</p>
                <p className="text-xs text-pool-400 mt-0.5">
                  {item.days_since === 0 ? 'Today' : item.days_since === 1 ? 'Yesterday' : `${item.days_since} days ago`}
                  {` · ${item.attended} swimmer${item.attended === 1 ? '' : 's'}`}
                </p>
              </div>
              <Link
                to={`/debrief?session=${item.session_id}`}
                className="desk-btn desk-btn--teal desk-btn--sm"
              >
                Debrief
              </Link>
            </div>
            <button
              onClick={() => onSkip(item)}
              disabled={busyKey === item.session_id}
              className="desk-quiet mt-1 disabled:opacity-50"
            >
              {busyKey === item.session_id ? 'Skipping…' : 'Skip debrief'}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}


function MeetResultsPrompts({ items, onDismiss, busyKey }) {
  if (!items.length) return null

  const timing = (days) => (days === 1 ? 'Finished yesterday' : `Finished ${days} days ago`)

  return (
    <section data-tone="indigo" className="desk-card">
      <div className="px-4 pt-4 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Gala results</p>
        <p className="text-sm text-pool-200 mt-1">Add the times while they are still fresh.</p>
      </div>
      <div className="desk-divide desk-rule">
        {items.map(item => (
          <div key={item.meet_id} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-pool-100 truncate">{item.name}</p>
                <p className="text-xs text-pool-400 mt-0.5">
                  {timing(item.days_since)}
                  {item.location ? ` · ${item.location}` : ''}
                  {item.swimmer_count ? ` · ${item.swimmer_count} swimmer${item.swimmer_count === 1 ? '' : 's'}` : ''}
                </p>
              </div>
              <Link
                to={`/meets/${item.meet_id}`}
                className="desk-btn desk-btn--indigo desk-btn--sm"
              >
                Add results
              </Link>
            </div>
            <button
              onClick={() => onDismiss(item)}
              disabled={busyKey === item.meet_id}
              className="desk-quiet mt-1 disabled:opacity-50"
            >
              {busyKey === item.meet_id ? 'Dismissing…' : 'Not now'}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}


function CoachCheckInPrompts({ items, onStart, onSkip, busyKey }) {
  if (!items.length) return null

  const timing = (dueDate) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const due = new Date(`${dueDate}T00:00:00`)
    const days = Math.round((due - today) / 86400000)
    if (days === 0) return 'Due today'
    if (days === 1) return 'Due tomorrow'
    if (days > 1) return `Due in ${days} days`
    return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
  }

  return (
    <section data-tone="teal" className="desk-card">
      <div className="px-4 pt-4 pb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-300">Coaching check-in</p>
          <p className="text-sm text-pool-200 mt-1">A useful moment to step back and reflect.</p>
        </div>
        <Link to="/coach-checkins" className="text-xs text-teal-300 shrink-0">History</Link>
      </div>
      <div className="desk-divide desk-rule">
        {items.map(item => (
          <div key={item.milestone_key} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-pool-100">{item.title}</p>
                <p className="text-xs text-pool-400 mt-0.5">
                  {item.status === 'in_progress'
                    ? 'Started—ready to continue'
                    : item.checkin_type === 'monthly' ? 'This month’s reminder' : timing(item.due_date)}
                </p>
              </div>
              <button
                onClick={() => onStart(item)}
                disabled={busyKey === item.milestone_key}
                className="desk-btn desk-btn--teal desk-btn--sm"
              >
                {busyKey === item.milestone_key ? 'Opening…' : item.status === 'in_progress' ? 'Continue' : 'Check in'}
              </button>
            </div>
            <button onClick={() => onSkip(item)} className="desk-quiet mt-1">Not this time</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function CoachingWatchpoints({ notes, onDismiss }) {
  const [open, setOpen] = useState(false)
  const [openNoteId, setOpenNoteId] = useState(null)
  if (notes.length === 0) return null

  const swimmerNames = [...new Set(notes.flatMap(note => note.swimmer_names || []))]
  const scope = swimmerNames.length > 0
    ? `${swimmerNames.length} swimmer${swimmerNames.length === 1 ? '' : 's'}`
    : 'squad-wide'

  return (
    <section data-tone="amber" className="desk-card">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 mt-1.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-200">Coaching watchpoints</p>
            <p className="text-[11px] text-pool-500 mt-0.5">
              {notes.length} active · {scope} · used in planning and on deck
            </p>
          </div>
        </div>
        <span className={`text-pool-500 text-sm transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>

      {open && (
        <div className="desk-rule desk-divide">
          {notes.map(note => {
            const noteOpen = openNoteId === note.id
            return (
              <article key={note.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setOpenNoteId(noteOpen ? null : note.id)} className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-medium text-pool-200">{note.title}</p>
                    <p className="text-[11px] text-pool-500 mt-0.5">
                      {note.swimmer_names?.join(', ') || 'Squad'} · until {note.date_to}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss(note.id)}
                    className="text-[11px] text-pool-500 hover:text-red-300 shrink-0 py-1"
                    title="Stop using this watchpoint"
                  >
                    Dismiss
                  </button>
                </div>
                {noteOpen && (
                  <div className="mt-2">
                    <p className="text-xs text-pool-300 whitespace-pre-line leading-relaxed">{note.body}</p>
                    <p className="text-[10px] text-pool-600 mt-2">Active {note.date_from} → {note.date_to}</p>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [calendar, setCalendar] = useState([])
  const [pulse, setPulse] = useState([])
  const [plannerSquads, setPlannerSquads] = useState([])
  useEffect(() => { api.getPlannerSquads().then(l => setPlannerSquads(l || [])).catch(() => setPlannerSquads([])) }, [])
  const [loading, setLoading] = useState(true)
  const [coachingNotes, setCoachingNotes] = useState([])
  const [coachingProfile, setCoachingProfile] = useState(null)
  const [meetCountdowns, setMeetCountdowns] = useState({ group_targets: [], upcoming_meets: [], awaiting_results: [] })
  const [assistantInbox, setAssistantInbox] = useState({ items: [], counts: {} })
  const [currentSeason, setCurrentSeason] = useState(null)
  const [availability, setAvailability] = useState({ items: [], current_count: 0, upcoming_count: 0 })
  const [seasonNotice, setSeasonNotice] = useState('')
  const [busySessionKey, setBusySessionKey] = useState('')
  const [sessionWaking, setSessionWaking] = useState(false)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [dueCheckIns, setDueCheckIns] = useState([])
  const [busyCheckInKey, setBusyCheckInKey] = useState('')
  const [busyResultsMeetId, setBusyResultsMeetId] = useState('')
  const [awaitingDebrief, setAwaitingDebrief] = useState([])
  const [busyDebriefSessionId, setBusyDebriefSessionId] = useState('')
  const [galas, setGalas] = useState({ meets: [], swimmer_count: 0 })
  const [unwell, setUnwell] = useState([])
  const [calendarError, setCalendarError] = useState('')
  const [reload, setReload] = useState(0)
  const firstLoad = useRef(true)

  // The desk shows this week (plus the start of next week near the weekend),
  // so ask for each week by name: a cached reply from a previous week can then
  // never be served in its place.
  const deskWeeks = deskWeekStarts().join(',')

  // A phone left on the home screen keeps this component mounted for days.
  // Re-fetch whenever the coach comes back to it so the week stays current.
  useEffect(() => {
    let lastLoad = Date.now()
    let lastWeek = deskWeekStarts().join(',')
    const refresh = () => {
      if (document.hidden) return
      const week = deskWeekStarts().join(',')
      if (week === lastWeek && Date.now() - lastLoad < 60000) return
      lastWeek = week
      lastLoad = Date.now()
      setReload(value => value + 1)
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  useEffect(() => {
    if (firstLoad.current) setLoading(true)
    setCalendarError('')
    Promise.all([
      Promise.all(deskWeeks.split(',').map(week => api.getCalendar(week)))
        .then(weeks => weeks.flat())
        .catch(error => {
          setCalendarError(error.message || 'Could not reach the server.')
          return []
        }),
      api.getCoachingNotes().catch(() => []),
      api.getAIContextStatus().catch(() => null),
      api.getSquadPulse().catch(() => []),
      api.getMeetCountdowns().catch(() => ({ group_targets: [], upcoming_meets: [], awaiting_results: [] })),
      api.getAssistantInbox({ limit: 3 }).catch(() => ({ items: [], counts: {} })),
      api.getCurrentPlanningSeason().catch(() => null),
      api.getSquadAvailability().catch(() => ({ items: [], current_count: 0, upcoming_count: 0 })),
      api.getDueCoachCheckIns().catch(() => ({ items: [] })),
      api.getSessionsAwaitingDebrief().catch(() => ({ items: [] })),
      api.getUpcomingGalas().catch(() => ({ meets: [], swimmer_count: 0 })),
      api.getUnwellSwimmers().catch(() => ({ items: [] })),
    ]).then(([cal, notes, ctx, pulseData, countdowns, inbox, season, availabilityData, checkIns, debriefs, galaData, unwellData]) => {
      setGalas(galaData)
      setUnwell(unwellData.items || [])
      setCalendar(cal)
      setCoachingNotes(notes)
      setCoachingProfile(ctx)
      setPulse(pulseData)
      setMeetCountdowns(countdowns)
      setAssistantInbox(inbox)
      setCurrentSeason(season)
      setAvailability(availabilityData)
      setDueCheckIns(checkIns.items || [])
      setAwaitingDebrief(debriefs.items || [])
      firstLoad.current = false
      setLoading(false)
    })
  }, [deskWeeks, reload])

  const dismissResultsPrompt = async (item) => {
    setBusyResultsMeetId(item.meet_id)
    try {
      await api.dismissMeetResultsPrompt(item.meet_id)
      setMeetCountdowns(prev => ({
        ...prev,
        awaiting_results: (prev.awaiting_results || []).filter(row => row.meet_id !== item.meet_id),
      }))
    } catch (error) {
      alert(`Could not dismiss that prompt: ${error.message}`)
    }
    setBusyResultsMeetId('')
  }

  const skipDebrief = async (item) => {
    setBusyDebriefSessionId(item.session_id)
    try {
      await api.skipSessionDebrief(item.session_id)
      setAwaitingDebrief(prev => prev.filter(row => row.session_id !== item.session_id))
    } catch (error) {
      alert(`Could not skip that debrief: ${error.message}`)
    }
    setBusyDebriefSessionId('')
  }

  const dismissNote = async (id) => {
    await api.updateCoachingNote(id, { active: false })
    setCoachingNotes(prev => prev.filter(n => n.id !== id))
  }

  const openCoachCheckIn = async (item) => {
    setBusyCheckInKey(item.milestone_key)
    try {
      const row = item.id ? item : await api.startCoachCheckIn(item)
      navigate(`/coach-checkins/${row.id}`)
    } catch (error) {
      alert(`Could not open check-in: ${error.message}`)
      setBusyCheckInKey('')
    }
  }

  const skipCoachCheckIn = async (item) => {
    if (!window.confirm('Skip this check-in? It will stop appearing on Today.')) return
    setBusyCheckInKey(item.milestone_key)
    try {
      const row = item.id ? item : await api.startCoachCheckIn(item)
      await api.skipCoachCheckIn(row.id)
      setDueCheckIns(previous => previous.filter(candidate => candidate.milestone_key !== item.milestone_key))
    } catch (error) {
      alert(`Could not skip check-in: ${error.message}`)
    }
    setBusyCheckInKey('')
  }

  const today = new Date()
  const todayStr = localDateKey(today)
  const activeSeason = currentSeason && currentSeason.date_to >= todayStr ? currentSeason : null

  const sessionQueue = weeklySessionQueue(calendar, today)

  const handleSeasonStarted = async (season, notice = '') => {
    setCurrentSeason(season)
    setSeasonNotice(notice)
    const [pulseData, inbox] = await Promise.all([
      api.getSquadPulse().catch(() => []),
      api.getAssistantInbox({ limit: 3 }).catch(() => ({ items: [], counts: {} })),
    ])
    setPulse(pulseData)
    setAssistantInbox(inbox)
  }

  // A timetabled session with no record yet gets one the first time it's opened.
  const openSessionPage = async (item, page) => {
    const key = `${item.date}-${item.session_id || `slot-${item.slot_id}`}`
    const to = id => (page === 'register' ? `/sessions/${id}/register` : `/sessions/${id}`)
    const state = page === 'register' ? undefined : { from: 'home' }
    setBusySessionKey(`${key}:${page}`)
    setSessionWaking(false)
    try {
      if (item.session_id) {
        navigate(to(item.session_id), { state })
        return
      }
      const created = await api.startCalendarSession(
        { pool_slot_id: item.slot_id, date: item.date },
        { onWaking: () => setSessionWaking(true) },
      )
      navigate(to(created.id), { state })
    } catch (error) {
      alert(`Could not open ${page === 'register' ? 'the register' : 'the session'}: ${error.message}. Check you have signal and try again.`)
      setBusySessionKey('')
      setSessionWaking(false)
    }
  }
  const openRegister = item => openSessionPage(item, 'register')
  const openSession = item => openSessionPage(item, 'open')

  const dismissSession = async (item) => {
    if (!window.confirm(`Remove ${item.title || item.label || 'this session'} from the home session desk?`)) return
    try {
      await api.dismissCalendarSession({
        date: item.date,
        pool_slot_id: item.slot_id || null,
        session_id: item.session_id || null,
      })
      setCalendar(previous => previous.map(day => ({
        ...day,
        items: (day.items || []).map(row => {
          const sameSession = item.session_id && row.session_id === item.session_id
          const sameOccurrence = !item.session_id && day.date === item.date && row.slot_id === item.slot_id
          return sameSession || sameOccurrence ? { ...row, status: 'dismissed' } : row
        }),
      })))
    } catch (error) {
      alert(`Could not dismiss session: ${error.message}`)
    }
  }

  const sessionCancelled = (result) => {
    const item = cancelTarget
    setCalendar(previous => previous.map(day => ({
      ...day,
      items: (day.items || []).map(row => {
        const sameSession = row.session_id === result.session_id
        const sameOccurrence = item?.slot_id && day.date === item.date && row.slot_id === item.slot_id
        return sameSession || sameOccurrence
          ? { ...row, session_id: result.session_id, status: 'cancelled', cancel_reason: result.cancel_reason }
          : row
      }),
    })))
    setCancelTarget(null)
  }

  // Swimmers needing attention from pulse (approaching target in ≤2 weeks or very low attendance)
  const flaggedSwimmers = pulse.filter(sw =>
    (sw.approaching_target && sw.approaching_target.weeks_out <= 2) ||
    (sw.attendance_state === 'established' && sw.sessions_expected >= 4 &&
      sw.sessions_attended / sw.sessions_expected < 0.4)
  )

  return (
    <div className="p-4 space-y-5">

      {/* Date + greeting */}
      <div className="pt-1">
        <p className="text-pool-400 text-sm">
          {today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight mt-0.5">
            {today.getHours() < 12 ? 'Morning' : today.getHours() < 17 ? 'Afternoon' : 'Evening'}
          </h1>
          <HelpLink topic="loop" label="How the app works" />
        </div>
      </div>

      <SetupChecklist />

      {/* This week of the plan, then who can't train fully, then the galas */}
      {plannerSquads.length > 0 && <PlanWeekCard squads={plannerSquads} />}
      {!loading && <UnwellCard items={unwell} />}
      {!loading && <GalasCard data={galas} unwell={unwell} />}

      {!loading && (
        <SessionDesk
          sessions={sessionQueue}
          onOpen={openSession}
          onRegister={openRegister}
          onDismiss={dismissSession}
          onCancel={setCancelTarget}
          busyKey={busySessionKey}
          busyLabel={sessionWaking ? 'Waking server…' : 'Opening…'}
          error={calendarError}
          onRetry={() => setReload(value => value + 1)}
        />
      )}

      {!loading && (
        <SessionDebriefPrompts
          items={awaitingDebrief}
          onSkip={skipDebrief}
          busyKey={busyDebriefSessionId}
        />
      )}

      {!loading && (
        <MeetResultsPrompts
          items={meetCountdowns.awaiting_results || []}
          onDismiss={dismissResultsPrompt}
          busyKey={busyResultsMeetId}
        />
      )}

      {!loading && (
        <CoachCheckInPrompts
          items={dueCheckIns}
          onStart={openCoachCheckIn}
          onSkip={skipCoachCheckIn}
          busyKey={busyCheckInKey}
        />
      )}

      <StaffAsksCard />

      {!loading && !activeSeason && plannerSquads.length === 0 && <SeasonStartCard onStarted={handleSeasonStarted} />}
      {!loading && activeSeason && <CurrentSeasonCard season={activeSeason} pulse={pulse} notice={seasonNotice} />}

      {!loading && <AvailabilityCard report={availability} />}

      <AssistantInboxPreview inbox={assistantInbox} />

      <CoachingWatchpoints notes={coachingNotes} onDismiss={dismissNote} />

      {/* Attention flags from pulse — imminent targets or very low attendance */}
      {flaggedSwimmers.length > 0 && (
        <div data-tone="amber" className="desk-card px-4 py-3 space-y-1.5">
          <p className="text-xs font-semibold text-amber-300 uppercase tracking-wider">Needs your eye</p>
          {flaggedSwimmers.map(sw => (
            <Link key={sw.id} to={`/swimmers/${sw.id}`} className="flex items-center justify-between group">
              <span className="text-sm text-pool-200 group-hover:text-accent-400 transition-colors">{sw.name}</span>
              <span className="text-xs text-pool-400">
                {sw.approaching_target?.weeks_out <= 2
                  ? `Target in ${sw.approaching_target.days_out}d`
                  : `${sw.sessions_attended}/${sw.sessions_expected} sessions`}
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Squad Pulse */}
      {!loading && pulse.length > 0 && <SquadPulse pulse={pulse} />}

      {/* Squad flags (injury/sabbatical) */}
      {(() => {
        const issues = pulse.filter ? [] : [] // handled via swimmers endpoint if needed
        return null
      })()}

      {/* Coaching Profile card */}
      {(() => {
        const daysOld = coachingProfile?.created_at
          ? Math.floor((new Date() - new Date(coachingProfile.created_at)) / (1000 * 60 * 60 * 24))
          : null
        const stale = daysOld !== null && daysOld > 28
        return (
          <Link to="/context" data-tone={stale ? 'amber' : coachingProfile?.active ? undefined : 'dashed'} className="desk-card block px-4 py-3.5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-pool-200">Coaching Profile</p>
                <p className="text-xs text-pool-500 mt-0.5">
                  {!coachingProfile?.active
                    ? 'Not set up yet — tap to build'
                    : stale
                    ? `Last updated ${daysOld}d ago — worth refreshing`
                    : `${coachingProfile.title} · ${daysOld}d ago`}
                </p>
              </div>
              <span className={`text-lg ${stale ? 'text-amber-400' : 'text-pool-500'}`}>
                {!coachingProfile?.active ? '+' : stale ? '↻' : '›'}
              </span>
            </div>
          </Link>
        )
      })()}

      {/* Utility links */}
      <div className="grid grid-cols-2 gap-2 pb-2">
        <Link to="/import" className="desk-btn">
          Import
        </Link>
        <Link to="/schedule" className="desk-btn">
          Schedule
        </Link>
      </div>

      <SessionCancellationDialog
        session={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={sessionCancelled}
      />

    </div>
  )
}
