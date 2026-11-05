import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { splitHeader, markdownToHtml, lineDiff, headingsOf, AUTHOR_LABEL } from '../workbookText'

const card = 'bg-pool-800 rounded-xl'
const md = '[&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:text-pool-100 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-2 [&_p]:text-sm [&_p]:text-pool-200 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:text-sm [&_li]:text-pool-200 [&_code]:text-accent-300'
const when = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const who = (author, staff) => AUTHOR_LABEL[author] || (staff && staff[author]) || author

function Back({ to, label }) {
  return <Link to={to} className="text-pool-400 text-sm">‹ {label}</Link>
}

/* The staff, each with their workbook; snapshots and search across all of them. */
function StaffList() {
  const [staff, setStaff] = useState(null)
  const [snaps, setSnaps] = useState([])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const [msg, setMsg] = useState('')

  const load = () => { api.getWorkbooks().then(setStaff); api.getWorkbookSnapshots().then(setSnaps) }
  useEffect(load, [])

  const find = async e => { e.preventDefault(); setHits(q.trim() ? await api.searchWorkbooks(q) : null) }
  const snap = async () => {
    const name = window.prompt('Name this snapshot (e.g. Start of macro 2)')
    if (!name) return
    await api.takeWorkbookSnapshot(name); setMsg(`Snapshot “${name}” saved`); load()
  }
  const restoreSnap = async s => {
    if (!window.confirm(`Put every workbook back to “${s.name}”? Newer versions stay in each page's history.`)) return
    const r = await api.restoreWorkbookSnapshot(s.id)
    setMsg(`Restored ${r.restored.length} page${r.restored.length === 1 ? '' : 's'}${r.set_aside.length ? `, set aside ${r.set_aside.length} newer` : ''}`)
  }

  if (!staff) return <p className="p-4 text-sm text-pool-400">Loading the workbooks…</p>
  return (
    <div className="p-4 space-y-5 pb-8">
      <header>
        <Back to="/settings" label="Settings" />
        <h1 className="text-xl font-bold mt-1">Staff workbooks</h1>
        <p className="text-pool-400 text-sm mt-0.5">What each member of staff has written down. Every change is kept; you can edit, compare and restore.</p>
      </header>
      <form onSubmit={find} className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search every workbook"
          className="flex-1 bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm" />
        <button className="bg-pool-700 rounded-lg px-3 text-sm">Search</button>
      </form>
      {hits && (
        <div className={`${card} divide-y divide-pool-700`}>
          {hits.length ? hits.map(h => (
            <Link key={h.role + h.path} to={`/workbooks/${h.role}/page?path=${encodeURIComponent(h.path)}`} className="block px-4 py-2.5">
              <span className="text-sm text-pool-100">{h.title}</span>
              <span className="block text-xs text-pool-400">{h.role} · {h.path}{h.summary ? ` · ${h.summary}` : ''}</span>
            </Link>
          )) : <p className="px-4 py-3 text-sm text-pool-400">Nothing matches.</p>}
        </div>
      )}
      <div className={`${card} divide-y divide-pool-700`}>
        {staff.map(w => (
          <Link key={w.role} to={`/workbooks/${w.role}`} className="flex items-center justify-between px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-pool-100">{w.name}, {w.title}</span>
              <span className="block text-xs text-pool-400">{w.pages} page{w.pages === 1 ? '' : 's'}{w.updated_at ? ` · last change ${when(w.updated_at)}` : ''}</span>
            </span>
            <span className="text-pool-500">›</span>
          </Link>
        ))}
      </div>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500">Snapshots</h2>
          <button onClick={snap} className="text-xs text-accent-400 font-semibold">Save a snapshot</button>
        </div>
        {snaps.length ? (
          <div className={`${card} divide-y divide-pool-700`}>
            {snaps.map(s => (
              <div key={s.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm text-pool-200">{s.name}<span className="block text-xs text-pool-500">{when(s.at)} · {s.pages} pages</span></span>
                <button onClick={() => restoreSnap(s)} className="text-xs text-pool-300 border border-pool-600 rounded-lg px-2 py-1">Restore</button>
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-pool-500">A snapshot saves every workbook as it is now, e.g. at the start of a macrocycle.</p>}
        {msg && <p className="text-xs text-green-400">{msg}</p>}
      </section>
    </div>
  )
}

/* One worker's workbook: their job page first, then their pages by folder. */
function WorkbookIndex({ role }) {
  const [wb, setWb] = useState(null)
  useEffect(() => { api.getWorkbook(role).then(setWb) }, [role])
  const folders = useMemo(() => {
    const out = {}
    for (const p of (wb?.pages || []).filter(p => p.path !== 'job.md')) {
      const f = p.path.includes('/') ? p.path.split('/')[0] : ''
      ;(out[f] = out[f] || []).push(p)
    }
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b))
  }, [wb])
  if (!wb) return <p className="p-4 text-sm text-pool-400">Loading…</p>
  const link = p => `/workbooks/${role}/page?path=${encodeURIComponent(p)}`
  return (
    <div className="p-4 space-y-4 pb-8">
      <header>
        <Back to="/workbooks" label="All staff" />
        <h1 className="text-xl font-bold mt-1">{wb.name}, {wb.title}</h1>
      </header>
      <Link to={link('job.md')} className={`${card} block px-4 py-3 border border-accent-600/40`}>
        <span className="block text-sm font-semibold text-pool-100">Job description</span>
        <span className="block text-xs text-pool-400">What {wb.name} does, and your direction for them</span>
      </Link>
      {folders.map(([folder, list]) => (
        <section key={folder || 'top'} className="space-y-1.5">
          {folder && <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">{folder}</h2>}
          <div className={`${card} divide-y divide-pool-700`}>
            {list.map(p => (
              <Link key={p.path} to={link(p.path)} className="block px-4 py-2.5">
                <span className="text-sm text-pool-100">{p.title}</span>
                {p.confidence && <span className="ml-2 text-[10px] uppercase tracking-wide bg-pool-700 text-pool-300 rounded px-1.5 py-0.5">{p.confidence}</span>}
                <span className="block text-xs text-pool-400">{p.summary || p.path} · v{p.version}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      {!folders.length && <p className="text-sm text-pool-400">{wb.name} hasn't written any pages yet.</p>}
    </div>
  )
}

/* One page: read, edit, history, compare, restore, lock sections. */
function PageView({ role }) {
  const [params] = useSearchParams()
  const path = params.get('path')
  const [page, setPage] = useState(null)
  const [staff, setStaff] = useState({})
  const [mode, setMode] = useState('read')          // read / edit / history
  const [draft, setDraft] = useState('')
  const [hist, setHist] = useState([])
  const [old, setOld] = useState(null)              // a revision being looked at
  const [error, setError] = useState('')

  const load = () => api.getWorkbookPage(role, path).then(p => { setPage(p); setDraft(p.content) }).catch(e => setError(e.message))
  useEffect(() => { load(); api.getWorkbooks().then(list => setStaff(Object.fromEntries(list.map(w => [w.role, w.name])))) }, [role, path]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setError('')
    try {
      const p = await api.saveWorkbookPage(role, { path, content: draft, base_version: page.version })
      setPage(p); setMode('read')
    } catch (e) { setError(e.message || 'Could not save') }
  }
  const showHistory = async () => { setHist(await api.getWorkbookHistory(role, path)); setOld(null); setMode('history') }
  const look = async v => setOld(await api.getWorkbookRevision(role, path, v))
  const restore = async v => {
    if (!window.confirm(`Bring version ${v} back as the newest version? Nothing is lost.`)) return
    const p = await api.restoreWorkbookPage(role, path, v); setPage(p); setDraft(p.content); setMode('read')
  }
  const toggleLock = async h => {
    const locked = page.locked.includes(h) ? page.locked.filter(x => x !== h) : [...page.locked, h]
    const r = await api.lockWorkbookSections(role, path, locked); setPage(p => ({ ...p, locked: r.locked }))
  }

  if (error && !page) return <p className="p-4 text-sm text-red-400">{error}</p>
  if (!page) return <p className="p-4 text-sm text-pool-400">Loading…</p>
  const { meta, body } = splitHeader(page.content)
  const isJob = path === 'job.md'
  return (
    <div className="p-4 space-y-4 pb-8">
      <header>
        <Back to={`/workbooks/${role}`} label={staff[role] || 'Workbook'} />
        <h1 className="text-lg font-bold mt-1">{isJob ? 'Job description' : page.title}</h1>
        <p className="text-xs text-pool-400">{[page.kind, meta.confidence, `version ${page.version}`, when(page.updated_at)].filter(Boolean).join(' · ')}</p>
      </header>
      <div className="flex gap-2">
        {['read', 'edit'].map(m => (
          <button key={m} onClick={() => { setMode(m); setDraft(page.content) }}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === m ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-300'}`}>{m === 'read' ? 'Read' : 'Edit'}</button>
        ))}
        <button onClick={showHistory} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${mode === 'history' ? 'bg-accent-600 text-white' : 'bg-pool-700 text-pool-300'}`}>History</button>
      </div>

      {isJob && mode !== 'history' && page.fixed && (
        <details className={`${card} px-4 py-3`}>
          <summary className="text-sm font-semibold text-pool-200 cursor-pointer">How {staff[role] || 'they'} work (set by the app)</summary>
          <div className={`mt-2 ${md}`} dangerouslySetInnerHTML={{ __html: markdownToHtml(page.fixed) }} />
        </details>
      )}

      {mode === 'read' && (
        <div className={`${card} px-4 py-3 ${md}`} dangerouslySetInnerHTML={{ __html: markdownToHtml(body) || '<p>(empty)</p>' }} />
      )}

      {mode === 'edit' && (
        <div className="space-y-2">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={18} spellCheck
            className="w-full bg-pool-800 border border-pool-600 rounded-xl px-3 py-2 text-sm font-mono text-pool-100" />
          {!isJob && headingsOf(splitHeader(draft).body).length > 0 && (
            <div className={`${card} px-4 py-3 space-y-1.5`}>
              <p className="text-xs text-pool-400">Lock a section so only you can change it ({staff[role] || 'the worker'} can only suggest changes):</p>
              {headingsOf(body).map(h => (
                <label key={h} className="flex items-center gap-2 text-sm text-pool-200">
                  <input type="checkbox" checked={page.locked.includes(h)} onChange={() => toggleLock(h)} /> {h}
                </label>
              ))}
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => setMode('read')} className="px-3 py-2 text-sm text-pool-400">Cancel</button>
            <button onClick={save} disabled={draft === page.content} className="px-4 py-2 rounded-lg bg-accent-600 text-white text-sm font-semibold disabled:opacity-40">Save</button>
          </div>
        </div>
      )}

      {mode === 'history' && (
        <div className="space-y-3">
          <div className={`${card} divide-y divide-pool-700`}>
            {hist.map(h => (
              <div key={h.version} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <button onClick={() => look(h.version)} className="text-left min-w-0">
                  <span className="block text-sm text-pool-100">v{h.version} · {who(h.author, staff)}{h.version === page.version ? ' · current' : ''}</span>
                  <span className="block text-xs text-pool-400 truncate">{[h.reason, h.trigger, when(h.at)].filter(Boolean).join(' · ')}</span>
                </button>
                {h.version !== page.version && (
                  <button onClick={() => restore(h.version)} className="shrink-0 text-xs text-pool-300 border border-pool-600 rounded-lg px-2 py-1">Restore</button>
                )}
              </div>
            ))}
          </div>
          {old && (
            <div className={`${card} px-4 py-3 space-y-1`}>
              <p className="text-xs font-semibold text-pool-300">What changed from version {old.version} to the current version</p>
              <pre className="text-xs whitespace-pre-wrap font-mono">
                {lineDiff(old.content, page.content).map((d, i) => (
                  <div key={i} className={d.type === 'add' ? 'bg-green-900/40 text-green-200' : d.type === 'del' ? 'bg-red-900/40 text-red-200 line-through' : 'text-pool-400'}>
                    {d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  '}{d.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Workbooks() {
  const { role } = useParams()
  const [params] = useSearchParams()
  if (role && params.get('path')) return <PageView role={role} />
  if (role) return <WorkbookIndex role={role} />
  return <StaffList />
}
