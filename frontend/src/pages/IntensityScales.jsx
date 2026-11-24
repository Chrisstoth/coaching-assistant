import { useEffect, useRef, useState } from 'react'
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

/* The zone editor: one bar along the Effort /20 line. The coach picks how many
   zones, drags the edge between two zones, and names each one. A zone ends where
   the next starts, so there are no gaps or overlaps. "Sits at" follows the middle
   of the zone until the coach sets it. */
const BAR_LO = 6, BAR_HI = 22, MIN_W = 0.5
const snap = v => Math.round(v * 4) / 4
const zStart = (zs, i) => (i === 0 ? BAR_LO : +zs[i].lo)
const zEnd = (zs, i) => (i < zs.length - 1 ? +zs[i + 1].lo : BAR_HI)
const zMid = (zs, i) => { const a = zStart(zs, i), b = Math.min(zEnd(zs, i), 21.5); return snap((a + Math.max(a + 0.25, b)) / 2) }
const pctOf = v => ((Math.min(BAR_HI, Math.max(BAR_LO, v)) - BAR_LO) / (BAR_HI - BAR_LO)) * 100
// a zone's stored value stays inside it; an automatic one sits in the middle
const settle = zs => zs.map((z, i) => {
  const a = i === 0 ? 0 : +z.lo, b = i < zs.length - 1 ? +zs[i + 1].lo : 99
  if (z.auto) return { ...z, c: zMid(zs, i) }
  const c = Math.min(Math.max(+z.c, a), b - 0.25)
  return c === +z.c ? z : { ...z, c: snap(c) }
})

function ZoneBar({ zones, onEdge }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const valueAt = clientX => {
    const r = ref.current.getBoundingClientRect()
    return snap(BAR_LO + ((clientX - r.left) / r.width) * (BAR_HI - BAR_LO))
  }
  const down = k => e => { e.preventDefault(); drag.current = k; e.currentTarget.setPointerCapture?.(e.pointerId) }
  const move = e => { if (drag.current != null) onEdge(drag.current, valueAt(e.clientX)) }
  const up = () => { drag.current = null }
  const ticks = []
  for (let v = 6; v <= 22; v += 2) ticks.push(v)
  return (
    <div className="select-none">
      <div ref={ref} className="relative h-11 rounded-lg overflow-hidden border border-pool-600 touch-none" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {zones.map((z, i) => {
          const a = pctOf(zStart(zones, i)), b = pctOf(zEnd(zones, i))
          return (
            <div key={i} className="absolute inset-y-0 flex flex-col items-center justify-center overflow-hidden"
              style={{ left: `${a}%`, width: `${b - a}%`, background: z.color || (i % 2 ? '#2F3B4A' : '#263240') }}>
              <span className="text-[11px] font-semibold text-white [text-shadow:0_0_3px_#000] truncate max-w-full px-0.5">{z.label || `Zone ${i + 1}`}</span>
              <span className="text-[9px] text-white/80 [text-shadow:0_0_3px_#000]">{+z.c}</span>
            </div>
          )
        })}
        {zones.slice(1).map((z, j) => {
          const k = j + 1
          return (
            <button key={k} type="button" onPointerDown={down(k)}
              onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onEdge(k, +z.lo + (e.key === 'ArrowLeft' ? -0.25 : 0.25)) } }}
              role="slider" aria-label={`Edge between ${zones[k - 1].label || 'zone ' + k} and ${z.label || 'zone ' + (k + 1)}`}
              aria-valuemin={BAR_LO} aria-valuemax={BAR_HI} aria-valuenow={+z.lo}
              className="absolute inset-y-0 w-6 -ml-3 cursor-ew-resize flex justify-center focus:outline-none group" style={{ left: `${pctOf(+z.lo)}%`, minHeight: 0 }}>
              <span className="w-1 h-full bg-white/90 shadow group-focus:bg-accent-400" />
            </button>
          )
        })}
      </div>
      <div className="relative h-4 text-[10px] text-pool-500">
        {ticks.map(v => <span key={v} className="absolute -translate-x-1/2" style={{ left: `${pctOf(v)}%` }}>{v === 22 ? '' : v}</span>)}
      </div>
    </div>
  )
}

function Editor({ start, onCancel, onSave }) {
  const [s, setS] = useState(() => ({ ...start, zones: start.zones.map((z, i) => ({ ...z, auto: !!z.auto || Math.abs(+z.c - zMid(start.zones, i)) < 0.01 })) }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const coloured = s.zones.some(z => z.color)
  const set = (k, v) => setS(x => ({ ...x, [k]: v }))
  const setZones = fn => setS(x => ({ ...x, zones: settle(fn(x.zones)) }))
  const setZone = (i, k, v) => setZones(zs => zs.map((z, j) => (j === i ? { ...z, [k]: v } : z)))
  const toggleColours = () => setZones(zs => zs.map(z => ({ ...z, color: coloured ? '' : (z.color || '#888888') })))
  // move the edge where zone k starts (and zone k-1 ends)
  const setEdge = (k, v) => setZones(zs => {
    const lo = zStart(zs, k - 1) + MIN_W, hi = zEnd(zs, k) - MIN_W
    if (hi < lo || !isFinite(v)) return zs
    return zs.map((z, j) => (j === k ? { ...z, lo: snap(Math.min(hi, Math.max(lo, v))) } : z))
  })
  // more zones: split the widest in two; fewer: the top zone joins the one below
  const setCount = n => setZones(zs => {
    let out = [...zs]
    while (out.length < n && out.length < 12) {
      let w = -1, at = 0
      out.forEach((z, i) => { const d = zEnd(out, i) - zStart(out, i); if (d > w) { w = d; at = i } })
      if (w < 2 * MIN_W) break
      const mid = snap((zStart(out, at) + zEnd(out, at)) / 2)
      out.splice(at + 1, 0, { label: '', lo: mid, c: mid, color: coloured ? (out[at].color || '#888888') : '', note: '', auto: true })
    }
    while (out.length > n && out.length > 2) out = out.slice(0, -1)
    return out
  })
  const removeZone = i => setZones(zs => {
    if (zs.length <= 2) return zs
    if (i === 0) return zs.slice(1).map((z, j) => (j === 0 ? { ...z, lo: 0 } : z))
    return zs.filter((_, j) => j !== i)
  })
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await onSave({ ...s, zones: s.zones.map((z, i) => { const { auto, ...rest } = z; return { ...rest, lo: i === 0 ? 0 : +z.lo, c: +z.c } }) })
    } catch (e) { setErr(e.message || 'Could not save the scale.') }
    setBusy(false)
  }
  const field = 'bg-pool-700 border border-pool-600 rounded-lg px-2 py-1.5 text-sm text-pool-100 w-full'
  const n = s.zones.length
  return (
    <div className="bg-pool-800 border border-accent-600/50 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-pool-400">Name<input className={field} value={s.name} onChange={e => set('name', e.target.value)} placeholder="e.g. BPSC HR colours" /></label>
        <label className="text-xs text-pool-400">Short name (column heading)<input className={field} value={s.short || ''} onChange={e => set('short', e.target.value)} placeholder="e.g. HR colour" maxLength={14} /></label>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-pool-300">
          <span>Zones</span>
          <button type="button" onClick={() => setCount(n - 1)} disabled={n <= 2} aria-label="One zone fewer"
            className="w-8 h-8 rounded-lg border border-pool-600 text-pool-100 disabled:opacity-30" style={{ minHeight: 0 }}>−</button>
          <span className="w-5 text-center text-sm font-semibold text-pool-100" aria-live="polite">{n}</span>
          <button type="button" onClick={() => setCount(n + 1)} disabled={n >= 12} aria-label="One zone more"
            className="w-8 h-8 rounded-lg border border-pool-600 text-pool-100 disabled:opacity-30" style={{ minHeight: 0 }}>+</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-pool-300"><input type="checkbox" checked={coloured} onChange={toggleColours} /> Colour each zone</label>
      </div>
      <ZoneBar zones={s.zones} onEdge={setEdge} />
      <p className="text-[11px] text-pool-500 leading-relaxed">
        Drag the white edges to set where each zone starts and ends on the Effort /20 line (21 is speed / HVO). The small number in each zone is
        where it <b>sits</b>: the value stored when you type that zone in a set. It stays in the middle unless you change it.
      </p>
      <div className="space-y-2">
        {s.zones.map((z, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] gap-2 bg-pool-900/40 rounded-lg p-2" style={z.color ? { borderLeft: `4px solid ${z.color}` } : undefined}>
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
              <label className="text-[11px] text-pool-400 col-span-2 sm:col-span-2">Zone {i + 1}
                <input className={`${field} ${z.label && !LABEL_OK.test(z.label) ? 'border-red-500' : ''}`} value={z.label} onChange={e => setZone(i, 'label', e.target.value.trim())} placeholder="Red" />
              </label>
              <label className="text-[11px] text-pool-400">Starts
                {i === 0
                  ? <span className={`${field} block text-pool-500`}>bottom</span>
                  : <input className={field} type="number" step="0.25" value={z.lo} onChange={e => setEdge(i, +e.target.value)} />}
              </label>
              <label className="text-[11px] text-pool-400">Ends
                {i === n - 1
                  ? <span className={`${field} block text-pool-500`}>top</span>
                  : <input className={field} type="number" step="0.25" value={s.zones[i + 1].lo} onChange={e => setEdge(i + 1, +e.target.value)} />}
              </label>
              <label className="text-[11px] text-pool-400">Sits at{z.auto ? ' (middle)' : ''}
                <input className={field} type="number" step="0.25" value={z.c} onChange={e => { const v = e.target.value; setS(x => ({ ...x, zones: x.zones.map((q, j) => (j === i ? { ...q, c: v, auto: false } : q)) })) }} />
              </label>
              {coloured ? (
                <label className="text-[11px] text-pool-400">Colour
                  <input className="w-full h-[34px] bg-pool-700 border border-pool-600 rounded-lg" type="color" value={z.color || '#888888'} onChange={e => setZone(i, 'color', e.target.value)} />
                </label>
              ) : <span className="hidden sm:block" />}
              <label className="text-[11px] text-pool-400 col-span-2 sm:col-span-6">Note
                <input className={field} value={z.note || ''} onChange={e => setZone(i, 'note', e.target.value)} placeholder="HR 29–30" maxLength={60} />
              </label>
            </div>
            <div className="flex flex-col gap-1 self-start">
              <button type="button" onClick={() => removeZone(i)} disabled={n <= 2}
                className="text-pool-500 hover:text-red-400 disabled:opacity-30 px-1" aria-label={`Remove zone ${i + 1}`}>✕</button>
              {!z.auto && <button type="button" onClick={() => setZone(i, 'auto', true)} className="text-[10px] text-accent-400 px-1" title="Put the stored value back in the middle of the zone">mid</button>}
            </div>
          </div>
        ))}
      </div>
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
