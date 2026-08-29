import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { CANONICAL_LABELS, CANONICAL_ZONES, DEFAULT_PRESENTATION, normalisePresentation } from '../sessionPresentation'
import { useSessionPresentation } from '../components/SessionPresentationProvider'


function imageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      reject(new Error('Choose a PNG, JPEG or WebP image.'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read that image.'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('That image could not be opened.'))
      image.onload = () => {
        const scale = Math.min(1, 700 / image.width, 300 / image.height)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.88))
      }
      image.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

export default function SessionPresentationSettings() {
  const { refresh } = useSessionPresentation()
  const [form, setForm] = useState(DEFAULT_PRESENTATION)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [checks, setChecks] = useState({})
  const fileRef = useRef(null)

  useEffect(() => {
    api.getSessionPresentation()
      .then(value => setForm(normalisePresentation(value)))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const updateLevel = (index, field, value) => {
    setForm(current => ({
      ...current,
      terminology_levels: current.terminology_levels.map((level, levelIndex) => levelIndex === index ? { ...level, [field]: value } : level),
    }))
    setChecks({})
  }

  const addLevel = () => {
    setForm(current => ({
      ...current,
      terminology_levels: [...current.terminology_levels, {
        id: `level-${Date.now()}`,
        label: '',
        description: '',
        colour: '#2563eb',
        canonical_zone: 'mixed',
      }],
    }))
  }

  const removeLevel = index => {
    setForm(current => ({ ...current, terminology_levels: current.terminology_levels.filter((_, levelIndex) => levelIndex !== index) }))
    setChecks({})
  }

  const chooseLogo = async event => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    try {
      const logo_data_url = await imageDataUrl(file)
      setForm(current => ({ ...current, logo_data_url }))
    } catch (err) {
      setError(err.message)
    } finally {
      event.target.value = ''
    }
  }

  const checkEquivalencies = async () => {
    setChecking(true)
    setError('')
    setMessage('')
    try {
      const result = await api.checkEnergyEquivalencies(form)
      const byId = Object.fromEntries(result.mappings.map(row => [row.id, row]))
      setChecks(byId)
      setForm(current => ({
        ...current,
        terminology_levels: current.terminology_levels.map(level => ({
          ...level,
          canonical_zone: byId[level.id]?.canonical_zone || level.canonical_zone,
        })),
      }))
      setMessage('AI suggestions applied. Review the equivalencies, then save.')
    } catch (err) {
      setError(err.message)
    } finally {
      setChecking(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const saved = await api.updateSessionPresentation(form)
      setForm(normalisePresentation(saved))
      await refresh()
      setMessage('Session presentation settings saved.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-4 text-pool-400">Loading session presentation…</div>

  return (
    <div className="p-4 space-y-5 pb-10">
      <header className="flex items-center gap-3 pt-2">
        <Link to="/settings" aria-label="Back to settings" className="text-pool-400 text-2xl">‹</Link>
        <div>
          <h1 className="text-lg font-bold">Session print & terminology</h1>
          <p className="text-xs text-pool-400 mt-0.5">Brand the sheet and translate LaneWatch zones into your coaching language.</p>
        </div>
      </header>

      {(error || message) && (
        <div className={`rounded-xl border px-3 py-2 text-xs ${error ? 'bg-red-900/20 border-red-800/50 text-red-300' : 'bg-green-900/20 border-green-800/50 text-green-300'}`}>
          {error || message}
        </div>
      )}

      <section className="bg-pool-800 border border-pool-700 rounded-xl p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Club identity</h2>
          <p className="text-xs text-pool-400 mt-1">Shown in the top-left of printed and PDF session sheets.</p>
        </div>
        <label className="block">
          <span className="text-xs text-pool-400 block mb-1">Club or squad name</span>
          <input value={form.club_name || ''} onChange={event => setForm({ ...form, club_name: event.target.value })}
            placeholder="e.g. Borough Performance Swimming Club"
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none" />
        </label>
        <div>
          <span className="text-xs text-pool-400 block mb-2">Club logo</span>
          <div className="flex items-center gap-3">
            <div className="w-28 h-16 rounded-lg bg-white border border-pool-600 flex items-center justify-center overflow-hidden p-2">
              {form.logo_data_url
                ? <img src={form.logo_data_url} alt="Club logo preview" className="max-w-full max-h-full object-contain" />
                : <span className="text-[10px] text-gray-400 text-center">No club logo</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => fileRef.current?.click()} className="bg-pool-700 border border-pool-600 rounded-lg px-3 py-2 text-xs font-semibold">Choose image</button>
              {form.logo_data_url && <button type="button" onClick={() => setForm({ ...form, logo_data_url: null })} className="text-xs text-red-300 px-2">Remove</button>}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseLogo} className="hidden" />
          </div>
          <p className="text-[11px] text-pool-500 mt-2">Transparent PNG works best. The image is resized before it is saved.</p>
        </div>
      </section>

      <section className="bg-pool-800 border border-pool-700 rounded-xl p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Intensity / energy terminology</h2>
          <p className="text-xs text-pool-400 mt-1 leading-relaxed">Name the system you use, then define each level in your own words. LaneWatch keeps its internal analysis stable and prints your labels.</p>
        </div>
        <label className="block">
          <span className="text-xs text-pool-400 block mb-1">System or framework</span>
          <input list="terminology-systems" value={form.terminology_name || ''} onChange={event => setForm({ ...form, terminology_name: event.target.value })}
            placeholder="e.g. Club colour system, Maglischo, Olbrecht"
            className="w-full bg-pool-700 border border-pool-600 rounded-lg px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none" />
          <datalist id="terminology-systems"><option value="Club colour system" /><option value="RPE scale" /><option value="Maglischo" /><option value="Olbrecht" /><option value="Custom system" /></datalist>
        </label>

        <div className="space-y-3">
          {form.terminology_levels.map((level, index) => {
            const check = checks[level.id]
            return (
              <div key={level.id || index} className="bg-pool-700 border border-pool-600 rounded-xl p-3 space-y-2" style={{ borderLeftColor: level.colour, borderLeftWidth: 4 }}>
                <div className="grid grid-cols-[42px_1fr_auto] gap-2 items-center">
                  <input type="color" value={level.colour || '#2563eb'} onChange={event => updateLevel(index, 'colour', event.target.value)} aria-label={`${level.label || `Level ${index + 1}`} colour`} className="w-10 h-10 rounded bg-transparent border-0 p-0" />
                  <input value={level.label || ''} onChange={event => updateLevel(index, 'label', event.target.value)} placeholder={`Level ${index + 1} label`}
                    className="min-w-0 bg-pool-600 border border-pool-500 rounded-lg px-3 py-2 text-sm focus:border-accent-500 focus:outline-none" />
                  <button type="button" onClick={() => removeLevel(index)} aria-label={`Remove ${level.label || `level ${index + 1}`}`} className="text-pool-500 hover:text-red-300 px-2 text-lg">×</button>
                </div>
                <textarea value={level.description || ''} onChange={event => updateLevel(index, 'description', event.target.value)} rows={2}
                  placeholder="What does this level mean: pace, rest, feel, duration, purpose…"
                  className="w-full bg-pool-600 border border-pool-500 rounded-lg px-3 py-2 text-xs leading-relaxed resize-none focus:border-accent-500 focus:outline-none" />
                <label className="flex items-center gap-2">
                  <span className="text-[11px] text-pool-500 shrink-0">Tracking equivalent</span>
                  <select value={level.canonical_zone || 'mixed'} onChange={event => updateLevel(index, 'canonical_zone', event.target.value)}
                    className="flex-1 min-w-0 bg-pool-600 border border-pool-500 rounded-lg px-2 py-1.5 text-xs focus:outline-none">
                    {CANONICAL_ZONES.map(zone => <option key={zone} value={zone}>{CANONICAL_LABELS[zone]}</option>)}
                  </select>
                </label>
                {check && <p className="text-[11px] text-teal-300">AI check · {check.confidence} confidence — {check.reason}</p>}
              </div>
            )
          })}
        </div>

        <button type="button" onClick={addLevel} className="w-full border border-dashed border-pool-500 rounded-lg py-2 text-xs font-semibold text-pool-300">+ Add a level</button>
        <button type="button" onClick={checkEquivalencies} disabled={checking || !form.terminology_levels.length}
          className="w-full bg-teal-900/30 border border-teal-700/50 text-teal-300 rounded-lg py-2.5 text-xs font-semibold disabled:opacity-40">
          {checking ? 'Checking definitions…' : 'AI check tracking equivalencies'}
        </button>
        <p className="text-[11px] text-pool-500 leading-relaxed">The check is a suggestion, not a lock. You can change every equivalent before saving. “Mixed” is appropriate when one club level intentionally spans several internal zones.</p>
      </section>

      <button type="button" onClick={save} disabled={saving || form.terminology_levels.some(level => !level.label.trim())}
        className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold text-sm">
        {saving ? 'Saving…' : 'Save print & terminology settings'}
      </button>
    </div>
  )
}
