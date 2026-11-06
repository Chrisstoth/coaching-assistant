import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import HelpLink from '../components/HelpLink'

// The coach's intensity scales. Every intensity is stored on one common line
// (Effort /20), so adding, changing or switching a scale never changes a
// session: only how it is shown and typed. Standard scales can't be edited;
// copy one to make your own version.

const LO = 6, HI = 22
const LABEL_OK = /^[A-Za-z][A-Za-z0-9]{0,13}$/
const newKey = () => 'c-' + Date.now().toString(36)
const numbersOnly = s => !s.zones || s.zones.some(z => !LABEL_OK.test(z.label))

function ScaleBar({ zones }) {
  if (!zones) {
    return <div className="h-5 rounded bg-gradient-to-r from-sky-800 via-amber-600 to-red-700 text-[10px] text-white flex items-center justify-between px-1.5"><span>6</span><span>Effort /20</span><span>20</span></div>
  }
  return (
    <div className="flex h-5 rounded overflow-hidden border border-pool-700" aria-hidden="true">
      {zones.map((z, i) => {
        const hi = i < zones.length - 1 ? zones[i + 1].lo : 99
        const w = Math.min(HI, hi) - Math.max(LO, z.lo)
        if (w <= 0) return null
        return (
          <span key={i} title={`${z.label}${z.note ? ' · ' + z.note : ''}`} style={{ flex: `${w} 0 0`, background: z.color || '#2A3442' }}
            className="text-[10px] leading-5 text-center truncate px-0.5 text-white [text-shadow:0_0_2px_#000]">{z.label}</span>
        )
      })}
    </div>
  )
}

function Editor({ start, onCancel, onSave }) {
  const [s, setS] = useState(start)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const coloured = s.zones.some(z => z.color)
  const set = (k, v) => setS(x => ({ ...x, [k]: v }))
  const setZone = (i, k, v) => setS(x => ({ ...x, zones: x.zones.map((z, j) => j === i ? { ...z, [k]: v } : z) }))
  const toggleColours = () => setS(x => ({ ...x, zones: x.zones.map(z => ({ ...z, color: coloured ? '' : (z.color || '#888888') })) }))
  const addLevel = () => setS(x => {
    const last = x.zones[x.zones.length - 1]
    const lo = Math.min(24, (+last?.c || 18) + 0.5)
    return { ...x, zones: [...x.zones, { label: '', lo, c: Math.min(25, lo + 0.5), color: coloured ? '#888888' : '', note: '' }] }
  })
  const removeLevel = i => setS(x => ({ ...x, zones: x.zones.filter((_, j) => j !== i) }))
  const save = async () => {
    setBusy(true); setErr('')
    try { await onSave(s) } catch (e) { setErr(e.message || 'Could not save the scale.') }
    setBusy(false)
  }
  const field = 'bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-sm text-pool-100 w-full'
  return (
    <div className="bg-pool-800 border border-accent-600/50 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-pool-400">Name<input className={field} value={s.name} onChange={e => set('name', e.target.value)} placeholder="e.g. BPSC HR colours" /></label>
        <label className="text-xs text-pool-400">Short name (column heading)<input className={field} value={s.short || ''} onChange={e => set('short', e.target.value)} placeholder="e.g. HR colour" maxLength={14} /></label>
      </div>
      <ScaleBar zones={s.zones} />
      <p className="text-[11px] text-pool-500 leading-relaxed">
        Each level is one word you can type in a set (Red, A3). <b>Starts at</b> is where it begins on the Effort /20 line, and it runs up to where the next level starts.
        <b> Sits at</b> is the value stored when you type it. The first level starts at 0 and the last runs to the top.
      </p>
      <label className="flex items-center gap-2 text-xs text-pool-300"><input type="checkbox" checked={coloured} onChange={toggleColours} /> Colour each level</label>
      <div className="space-y-2">
        {s.zones.map((z, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] gap-2 bg-pool-900/40 rounded-lg p-2">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
              <label className="text-[11px] text-pool-400 col-span-2 sm:col-span-1">Level {i + 1}
                <input className={`${field} ${z.label && !LABEL_OK.test(z.label) ? 'border-red-500' : ''}`} value={z.label} onChange={e => setZone(i, 'label', e.target.value.trim())} placeholder="Red" />
              </label>
              <label className="text-[11px] text-pool-400">Starts at
                <input className={field} type="number" step="0.25" value={i === 0 ? 0 : z.lo} disabled={i === 0} onChange={e => setZone(i, 'lo', e.target.value)} />
              </label>
              <label className="text-[11px] text-pool-400">Sits at
                <input className={field} type="number" step="0.25" value={z.c} onChange={e => setZone(i, 'c', e.target.value)} />
              </label>
              {coloured ? (
                <label className="text-[11px] text-pool-400">Colour
                  <input className="w-full h-[34px] bg-pool-700 border border-pool-600 rounded-lg" type="color" value={z.color || '#888888'} onChange={e => setZone(i, 'color', e.target.value)} />
                </label>
              ) : <span className="hidden sm:block" />}
              <label className="text-[11px] text-pool-400 col-span-2 sm:col-span-1">Note
                <input className={field} value={z.note || ''} onChange={e => setZone(i, 'note', e.target.value)} placeholder="HR 29–30" maxLength={60} />
              </label>
            </div>
            <button type="button" onClick={() => removeLevel(i)} disabled={s.zones.length <= 2}
              className="self-start text-pool-500 hover:text-red-400 disabled:opacity-30 px-1" aria-label={`Remove level ${i + 1}`}>✕</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={addLevel} disabled={s.zones.length >= 12} className="text-xs text-accent-400 disabled:opacity-40">+ Add a level</button>
      {err && <p className="text-xs text-red-300">{err}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-pool-300">Cancel</button>
        <button type="button" onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded-lg bg-accent-600 text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save scale'}</button>
      </div>
    </div>
  )
}

export default function IntensityScales() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)   // a scale being edited or made
  const load = () => api.getBuilderSettings().then(setData).catch(e => setError(e.message || 'Could not load the scales.'))
  useEffect(() => { load() }, [])

  const saveCustom = async (list) => setData(await api.saveIntensityScales({ custom_scales: list }))
  const saveOne = async (s) => {
    const list = data.custom.some(c => c.key === s.key) ? data.custom.map(c => c.key === s.key ? s : c) : [...data.custom, s]
    await saveCustom(list)
    setEditing(null)
  }
  const remove = async (s) => {
    if (!window.confirm(`Delete "${s.name}"? Sessions written in it keep their intensities and show them in another scale until you pick one.`)) return
    try { await saveCustom(data.custom.filter(c => c.key !== s.key)) } catch (e) { setError(e.message) }
  }
  const toggleHidden = async (k) => {
    const hidden = data.standard.filter(s => s.hidden).map(s => s.key)
    try { setData(await api.saveIntensityScales({ hidden_scales: hidden.includes(k) ? hidden.filter(x => x !== k) : [...hidden, k] })) } catch (e) { setError(e.message) }
  }
  const setUsual = async (k) => { try { setData(await api.saveIntensityScales({ effort_scale: k })) } catch (e) { setError(e.message) } }
  const copyOf = (s) => ({
    key: newKey(), name: `${s.name} (my version)`, short: s.short, based_on: s.key,
    zones: s.zones.map(z => ({ label: z.label, lo: z.lo, c: z.c, color: z.color || '', note: z.note || '' })),
  })
  const blank = () => ({ key: newKey(), name: '', short: '', zones: [
    { label: 'Easy', lo: 0, c: 10, color: '', note: '' }, { label: 'Steady', lo: 12.5, c: 14, color: '', note: '' },
    { label: 'Hard', lo: 16.5, c: 17, color: '', note: '' }, { label: 'Fast', lo: 18.5, c: 19.5, color: '', note: '' }] })

  if (error && !data) return <div className="p-4 text-sm text-red-400">{error}</div>
  if (!data) return <div className="p-4 text-sm text-pool-400">Loading…</div>
  const card = 'bg-pool-800 border border-pool-700 rounded-xl p-3 space-y-2'
  return (
    <div className="p-4 space-y-6 pb-10 max-w-2xl">
      <header className="pt-2 space-y-1">
        <Link to="/settings" className="text-xs text-accent-400">‹ Settings</Link>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Intensity scales</h1>
          <HelpLink topic="scales" />
        </div>
        <p className="text-pool-400 text-sm leading-relaxed">
          Every intensity is stored on one common line (Effort /20). Adding, changing or switching a scale never changes a session; only how it is shown and typed.
        </p>
      </header>
      {error && <p className="text-xs text-red-300">{error}</p>}

      <section className="space-y-2">
        <label className="block text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1" htmlFor="usual">Your usual scale</label>
        <select id="usual" value={data.effort_scale} onChange={e => setUsual(e.target.value)}
          className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-sm text-pool-100">
          {data.scales.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <p className="text-[11px] text-pool-500 pl-1">New sessions start in this one. A single session can still use another.</p>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between pl-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500">Your scales</h2>
          {!editing && <button type="button" onClick={() => setEditing(blank())} className="text-xs text-accent-400">+ New scale</button>}
        </div>
        {editing && !data.custom.some(c => c.key === editing.key) && (
          <Editor start={editing} onCancel={() => setEditing(null)} onSave={saveOne} />
        )}
        {data.custom.length === 0 && !editing && <p className="text-xs text-pool-500 pl-1">None yet. Make one, or copy a standard scale below and change it.</p>}
        {data.custom.map(s => editing && editing.key === s.key ? (
          <Editor key={s.key} start={{ ...s, zones: s.zones.map(z => ({ ...z, color: z.color || '', note: z.note || '' })) }} onCancel={() => setEditing(null)} onSave={saveOne} />
        ) : (
          <div key={s.key} className={card}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-pool-100 truncate">{s.name}</p>
              <div className="flex gap-3 text-xs shrink-0">
                <button type="button" onClick={() => setEditing(s)} className="text-accent-400">Edit</button>
                <button type="button" onClick={() => setEditing(copyOf(s))} className="text-pool-300">Copy</button>
                <button type="button" onClick={() => remove(s)} className="text-red-400">Delete</button>
              </div>
            </div>
            <ScaleBar zones={s.zones} />
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-pool-500 pl-1">Standard scales</h2>
        <p className="text-[11px] text-pool-500 pl-1">These stay as published. Copy one to make your own version, or hide the ones you don't use.</p>
        {data.standard.map(s => (
          <div key={s.key} className={`${card} ${s.hidden ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-pool-100 truncate">{s.name}</p>
              <div className="flex gap-3 text-xs shrink-0">
                {!numbersOnly(s) && <button type="button" onClick={() => setEditing(copyOf(s))} className="text-accent-400">Copy and change</button>}
                {s.key !== 'effort20' && <button type="button" onClick={() => toggleHidden(s.key)} className="text-pool-300">{s.hidden ? 'Show' : 'Hide'}</button>}
              </div>
            </div>
            <ScaleBar zones={s.zones} />
          </div>
        ))}
      </section>
    </div>
  )
}
