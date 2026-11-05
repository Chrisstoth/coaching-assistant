import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

const card = 'bg-pool-800 rounded-xl'
const h2 = 'text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1'
const STATUS = [['imported', 'In the app'], ['pending', 'Waiting for you'], ['new', 'Not read yet'], ['duplicate', 'Already in the app'], ['skipped', 'Skipped'], ['failed', "Couldn't read"]]

/* Maggie's desk: your old sessions into the app, her questions, and the style review. */
export default function HistoryImport() {
  const navigate = useNavigate()
  const [ov, setOv] = useState(null)
  const [roots, setRoots] = useState('')
  const [msg, setMsg] = useState('')
  const [items, setItems] = useState([])
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [statements, setStatements] = useState(null)
  const [busy, setBusy] = useState('')
  const poll = useRef(null)

  const load = async () => {
    const o = await api.getHistoryImport()
    setOv(o); setRoots(r => r || (o.roots || []).join('\n'))
    setItems(await api.getHistoryImportItems('pending'))
    setQuestions(await api.getHistoryImportQuestions())
    return o
  }
  useEffect(() => { load(); return () => clearInterval(poll.current) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveRoots = async () => { await api.setHistoryImportRoots(roots.split('\n')); setMsg('Folders saved') }
  const scan = async () => {
    setBusy('scan'); setMsg('')
    try { const r = await api.scanHistoryImport(); setMsg(`Found ${r.found} session files; ${r.added} new to the queue.`); await load() }
    catch (e) { setMsg(e.message) } finally { setBusy('') }
  }
  const run = async () => {
    setBusy('run'); setMsg('Maggie is reading the next 50 files. This page updates as she goes.')
    await api.runHistoryImport({ limit: 50 })
    clearInterval(poll.current)
    let quiet = 0, last = ''
    poll.current = setInterval(async () => {
      const o = await load()
      const key = JSON.stringify(o.periods)
      quiet = key === last ? quiet + 1 : 0; last = key
      if (quiet >= 6) { clearInterval(poll.current); setBusy(''); setMsg('Done for now.') }
    }, 5000)
  }
  const decide = async (it, action) => {
    const r = await api.decideHistoryImportItem(it.id, action)
    if (action === 'open' && r.session_id) return navigate(`/builder/${r.session_id}`)
    load()
  }
  const answer = async q => {
    const meaning = (answers[q.term] || '').trim(); if (!meaning) return
    const r = await api.answerHistoryImportQuestion(q.term, meaning)
    setMsg(`Added “${q.term}” to the glossary; ${r.to_read_again} file${r.to_read_again === 1 ? '' : 's'} will be read again.`)
    load()
  }
  const compare = async () => {
    setBusy('style')
    try { setStatements((await api.getStyleCandidates()).statements) } finally { setBusy('') }
  }
  const style = async (st, choice) => {
    const reason = choice === 'moved_on' ? window.prompt('Why did you move on from it? (optional, Jess will remember)', '') : ''
    if (reason === null) return
    await api.answerStyle(st.statement, choice, reason || '')
    setStatements(list => list.filter(x => x !== st))
  }

  if (!ov) return <p className="p-4 text-sm text-pool-400">Opening Maggie's desk…</p>
  const periods = Object.entries(ov.periods || {})
  return (
    <div className="p-4 space-y-6 pb-10">
      <header>
        <Link to="/settings" className="text-pool-400 text-sm">‹ Settings</Link>
        <h1 className="text-xl font-bold mt-1">Your old sessions</h1>
        <p className="text-pool-400 text-sm mt-0.5">Maggie, the Records Officer, reads your session files into the app. Clean ones go straight in; anything she's unsure of waits here for you. Your files are only ever read.</p>
      </header>

      <section className="space-y-2">
        <h2 className={h2}>Your session folders</h2>
        <div className={`${card} p-3 space-y-2`}>
          <textarea value={roots} onChange={e => setRoots(e.target.value)} rows={4} placeholder={'One folder per line, e.g.\nC:\\Users\\you\\Dropbox\\BPSC 2025-2026\\Silver 1'}
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-xs font-mono text-pool-100" />
          <div className="flex gap-2 flex-wrap">
            <button onClick={saveRoots} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold">Save folders</button>
            <button onClick={scan} disabled={!!busy} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy === 'scan' ? 'Looking…' : 'Find session files'}</button>
            <button onClick={run} disabled={!!busy} className="rounded-lg bg-accent-600 text-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy === 'run' ? 'Reading…' : 'Read the next 50'}</button>
          </div>
          <p className="text-[11px] text-pool-500">Files that are online-only in Dropbox or OneDrive need "Make available offline" first.</p>
        </div>
        {msg && <p className="text-xs text-green-400">{msg}</p>}
      </section>

      {periods.length > 0 && (
        <section className="space-y-2">
          <h2 className={h2}>By season</h2>
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full text-xs">
              <thead><tr className="text-pool-500"><th className="text-left px-3 py-2">Season</th>{STATUS.map(([k, l]) => <th key={k} className="px-2 py-2 text-right font-medium">{l}</th>)}</tr></thead>
              <tbody>{periods.map(([p, c]) => (
                <tr key={p} className="border-t border-pool-700"><td className="px-3 py-1.5 text-pool-200">{p}</td>{STATUS.map(([k]) => <td key={k} className="px-2 py-1.5 text-right text-pool-300">{c[k] || ''}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {questions.length > 0 && (
        <section className="space-y-2">
          <h2 className={h2}>Maggie's questions</h2>
          <div className={`${card} divide-y divide-pool-700`}>
            {questions.map(q => (
              <div key={q.term} className="px-3 py-2.5 space-y-1.5">
                <p className="text-sm text-pool-100">What does <b>“{q.term}”</b> mean? <span className="text-xs text-pool-500">{q.files} file{q.files === 1 ? '' : 's'}, e.g. {q.example}</span></p>
                <div className="flex gap-2">
                  <input value={answers[q.term] || ''} onChange={e => setAnswers(a => ({ ...a, [q.term]: e.target.value }))} placeholder="e.g. backstroke kick"
                    className="flex-1 bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-xs" />
                  <button onClick={() => answer(q)} className="rounded-lg bg-pool-700 px-3 text-xs font-semibold">Tell Maggie</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className={h2}>Waiting for you ({items.length})</h2>
        {items.length === 0 && <p className="text-xs text-pool-500 pl-1">Nothing waiting.</p>}
        {items.map(it => (
          <div key={it.id} className={`${card} p-3 space-y-2`}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-pool-100 truncate">{it.file}</p>
              <span className="text-[11px] text-pool-500 shrink-0">{it.period}{it.camp ? ` · ${it.camp}` : ''} · {it.method === 'ai' ? 'read by Maggie' : 'read from the sheet'}</span>
            </div>
            {it.notes.length > 0 && <ul className="text-xs text-amber-300 list-disc pl-4">{it.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            {it.flagged.length > 0 && <p className="text-xs text-amber-300">Lines to check: {it.flagged.join(' · ')}</p>}
            <details><summary className="text-xs text-pool-400 cursor-pointer">The session as Maggie read it</summary>
              <pre className="mt-1 text-[11px] whitespace-pre-wrap font-mono text-pool-300">{it.preview}</pre></details>
            <div className="flex gap-2">
              <button onClick={() => decide(it, 'import')} className="rounded-lg bg-accent-600 text-white px-3 py-1.5 text-xs font-semibold">Looks right, import</button>
              <button onClick={() => decide(it, 'open')} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold">Import and fix it</button>
              <button onClick={() => decide(it, 'skip')} className="rounded-lg px-3 py-1.5 text-xs text-pool-400">Skip</button>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className={h2}>How your sessions have changed</h2>
        <div className={`${card} p-3 space-y-2`}>
          <p className="text-xs text-pool-400">Jess compares your seasons and asks what's still how you coach. Your answers fill her style pages, so she never brings back what you've moved on from.</p>
          <button onClick={compare} disabled={!!busy} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy === 'style' ? 'Jess is comparing…' : 'Compare my seasons'}</button>
          {statements && statements.length === 0 && <p className="text-xs text-pool-500">Nothing to ask yet; import a few seasons first.</p>}
          {(statements || []).map((st, i) => (
            <div key={i} className="border-t border-pool-700 pt-2 space-y-1.5">
              <p className="text-sm text-pool-100">{st.statement}</p>
              <div className="flex gap-2">
                {[['moved_on', 'Moved on'], ['still_do', 'Still do'], ['sometimes', 'Sometimes']].map(([k, l]) => (
                  <button key={k} onClick={() => style(st, k)} className="rounded-lg bg-pool-700 px-3 py-1.5 text-xs font-semibold">{l}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
