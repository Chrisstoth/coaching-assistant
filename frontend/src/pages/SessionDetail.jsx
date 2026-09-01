import { useEffect, useState } from 'react'
import { useParams, Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { DEFAULT_PRESENTATION, energyPresentation, openSessionPrint } from '../sessionPresentation'
import { useSessionPresentation } from '../components/SessionPresentationProvider'

const VOL_KEYS = ['aerobic', 'threshold', 'vo2', 'race_pace', 'lact_tol', 'short_race_pace', 'kicking', 'sprint']
const VOL_LABELS = { aerobic: 'Aerobic', threshold: 'Threshold', vo2: 'VO2', race_pace: 'Race Pace', lact_tol: 'Lact Tol', short_race_pace: 'Short Race', kicking: 'Kicking', sprint: 'Sprint' }
const VOL_COLOURS = { aerobic: '#3b82f6', threshold: '#f59e0b', vo2: '#ef4444', race_pace: '#8b5cf6', lact_tol: '#ec4899', short_race_pace: '#06b6d4', kicking: '#10b981', sprint: '#f97316' }

function VolumeEditor({ value = {}, onChange, presentation = DEFAULT_PRESENTATION }) {
  const total = VOL_KEYS.reduce((s, k) => s + (Number(value[k]) || 0), 0)
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {VOL_KEYS.map(k => (
          <div key={k} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: VOL_COLOURS[k] }} />
            <label className="text-xs text-pool-400 w-20 flex-shrink-0">{energyPresentation(k, presentation).label || VOL_LABELS[k]}</label>
            <input
              type="number"
              min="0"
              step="50"
              value={value[k] || ''}
              onChange={e => onChange({ ...value, [k]: e.target.value === '' ? 0 : Number(e.target.value) })}
              placeholder="0"
              className="w-full bg-pool-600 rounded px-2 py-1 text-xs border border-pool-500 focus:border-accent-500 focus:outline-none text-right"
            />
            <span className="text-xs text-pool-500 w-5">m</span>
          </div>
        ))}
      </div>
      {total > 0 && (
        <p className="text-xs text-pool-400 text-right pt-1">Total: <span className="text-white font-semibold">{(total / 1000).toFixed(2)}km</span></p>
      )}
    </div>
  )
}

function VolumeDisplay({ breakdown, presentation = DEFAULT_PRESENTATION }) {
  if (!breakdown) return null
  const entries = VOL_KEYS.map(k => [k, breakdown[k] || 0]).filter(([, v]) => v > 0)
  if (!entries.length) return null
  const total = entries.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="mt-2 pt-2 border-t border-pool-700">
      <p className="text-xs text-pool-500 mb-1.5">Volume breakdown</p>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span key={k} className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: VOL_COLOURS[k] + '33', color: VOL_COLOURS[k], border: `1px solid ${VOL_COLOURS[k]}55` }}>
            {energyPresentation(k, presentation).label || VOL_LABELS[k]} {(v / 1000).toFixed(2)}km
          </span>
        ))}
      </div>
      <p className="text-xs text-pool-500 mt-1">Total: <span className="text-pool-300">{(total / 1000).toFixed(2)}km</span></p>
    </div>
  )
}

export default function SessionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [session, setSession] = useState(null)
  const [recommending, setRecommending] = useState(false)
  const [recommendations, setRecommendations] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [editingVolGroup, setEditingVolGroup] = useState(null)
  const [volDraft, setVolDraft] = useState({})
  const [savingVol, setSavingVol] = useState(false)
  const [generatingIntelligence, setGeneratingIntelligence] = useState(false)
  const [presentation, setPresentation] = useState(DEFAULT_PRESENTATION)

  useEffect(() => {
    if (id !== 'new') api.getSession(id).then(setSession)
  }, [id])

  useEffect(() => {
    api.getSessionPresentation().then(setPresentation).catch(() => {})
  }, [])

  const startEditVol = (g) => {
    setEditingVolGroup(g.group_number)
    setVolDraft(g.volume_breakdown || {})
  }

  const saveVol = async (groupNumber) => {
    setSavingVol(true)
    try {
      const updated = await api.updateSession(id, { groups: { [groupNumber]: { volume_breakdown: volDraft } } })
      setSession(updated)
      setEditingVolGroup(null)
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setSavingVol(false)
  }

  const generateIntelligence = async () => {
    setGeneratingIntelligence(true)
    try {
      const result = await api.generateSessionIntelligence(id, { refresh_energy: Boolean(session.energy_analysis) })
      setSession(result.session)
    } catch (error) {
      alert(`Could not analyse session: ${error.message}`)
    } finally {
      setGeneratingIntelligence(false)
    }
  }

  const printSheet = () => {
    if (!session) return
    try {
      openSessionPrint({ session, settings: presentation, recommendations })
    } catch (error) {
      alert(error.message)
    }
  }

  const getRecommendations = async () => {
    setRecommending(true)
    try {
      const res = await api.recommendGroups(id)
      setRecommendations(res)
    } catch (e) {
      alert(`Error: ${e.message}`)
    }
    setRecommending(false)
  }

  const deleteSession = async () => {
    setDeleting(true)
    try {
      await api.deleteSession(id)
      navigate(location.state?.backTo || '/sessions', { replace: true })
    } catch (e) {
      alert(`Error: ${e.message}`)
      setDeleting(false)
    }
  }

  if (id === 'new') return <NewSession />
  if (!session) return <div className="p-4 text-pool-400">Loading...</div>

  const hasPlan = Boolean(
    session.coach_intent
    || session.planned_content
    || session.groups?.some(group => (
      group?.description
      || group?.sets?.raw
      || group?.sets?.items?.length
      || Object.values(group?.volume_breakdown || {}).some(value => Number(value) > 0)
    )),
  )
  const importTarget = new URLSearchParams({
    tab: 'excel',
    date: session.date,
    session: String(session.id),
  })
  if (session.pool_slot_id) importTarget.set('slot', String(session.pool_slot_id))

  const goBack = () => {
    if (location.key && location.key !== 'default') navigate(-1)
    else navigate(location.state?.backTo || '/sessions', { replace: true })
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 pt-2">
        <button type="button" onClick={goBack} aria-label="Go back" className="text-pool-400 text-2xl">‹</button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold">{session.title || 'Session'}</h1>
            {session.cycle_code && <span className="text-[10px] font-semibold text-teal-300 bg-teal-900/35 border border-teal-700/40 rounded px-1.5 py-0.5">{session.cycle_code}</span>}
          </div>
          <p className="text-pool-400 text-xs">
            {session.date}
            {(session.start_time || session.end_time) && (
              <span> · {session.start_time}{session.end_time ? `–${session.end_time}` : ''}</span>
            )}
            {session.squad && ` · ${session.squad}`}
            {session.course && ` · ${session.course}`}
          </p>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="text-pool-600 hover:text-red-400 text-sm transition-colors ml-auto"
        >
          Delete
        </button>
      </div>

      {session.cycle_context && (
        <div className="bg-teal-900/15 border border-teal-700/35 rounded-xl p-3">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-teal-300">Cycle position · {session.cycle_code}</p>
          <p className="text-xs text-pool-300 mt-1">
            {[session.cycle_context.macrocycle_name, session.cycle_context.mesocycle_name, session.cycle_context.microcycle_label].filter(Boolean).join(' · ')}
          </p>
        </div>
      )}

      {!hasPlan && (
        <div className="bg-accent-600/10 border border-accent-500/40 rounded-xl p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-pool-100">No session plan attached yet</p>
            <p className="text-xs text-pool-400 mt-1">Import the workbook into this calendar session before opening the register.</p>
          </div>
          <Link
            to={`/import?${importTarget.toString()}`}
            className="shrink-0 bg-accent-600 hover:bg-accent-500 text-white rounded-lg px-3 py-2 text-xs font-semibold"
          >
            Import plan
          </Link>
        </div>
      )}

      <div className="bg-pool-800 rounded-xl p-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-pool-200">Session intelligence</p>
          <p className="text-[11px] text-pool-500 mt-0.5">
            {session.energy_analysis
              ? `${session.energy_analysis.primary_emphasis || energyPresentation(session.energy_system_focus, presentation).label} · ${session.energy_analysis.density || 'unclear'} density`
              : 'Estimate the prescribed dose and prepare personalised register questions.'}
          </p>
        </div>
        <button onClick={generateIntelligence} disabled={generatingIntelligence || !session.groups?.length}
          className="shrink-0 text-xs font-semibold text-teal-300 bg-teal-900/30 border border-teal-700/40 rounded-lg px-3 py-2 disabled:opacity-40">
          {generatingIntelligence ? 'Analysing…' : session.energy_analysis ? 'Refresh AI' : 'Analyse'}
        </button>
      </div>

      {showDeleteConfirm && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 space-y-3">
          <p className="text-sm text-red-300">Delete this session and all its register data? This cannot be undone.</p>
          <div className="flex gap-2">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="flex-1 bg-pool-700 rounded-lg py-2 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={deleteSession}
              disabled={deleting}
              className="flex-1 bg-red-900 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold text-red-100"
            >
              {deleting ? 'Deleting...' : 'Delete Session'}
            </button>
          </div>
        </div>
      )}

      {session.coach_intent && (
        <div className="bg-pool-800 rounded-xl p-4">
          <p className="text-xs text-pool-400 mb-1">Coach Intent</p>
          <p className="text-sm">{session.coach_intent}</p>
        </div>
      )}

      {session.individual_mods && Object.keys(session.individual_mods).length > 0 && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-4 space-y-2">
          <p className="text-xs font-semibold text-amber-300 uppercase tracking-wide">Individual Modifications</p>
          {Object.entries(session.individual_mods).map(([name, note]) => (
            <div key={name} className="flex gap-2 items-start">
              <span className="text-xs font-medium text-amber-200 shrink-0 w-24">{name}</span>
              <span className="text-xs text-pool-300 leading-relaxed">{note}</span>
            </div>
          ))}
        </div>
      )}

      {/* Groups */}
      {session.groups?.map((g) => (
        <div key={g.group_number} className="bg-pool-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm text-accent-400">Group {g.group_number}</h3>
            {editingVolGroup === g.group_number ? (
              <div className="flex gap-2">
                <button onClick={() => setEditingVolGroup(null)} className="text-xs text-pool-400">Cancel</button>
                <button onClick={() => saveVol(g.group_number)} disabled={savingVol} className="text-xs text-accent-400 font-semibold disabled:opacity-40">
                  {savingVol ? 'Saving...' : 'Save'}
                </button>
              </div>
            ) : (
              <button onClick={() => startEditVol(g)} className="text-xs text-pool-400 hover:text-pool-200">
                {g.volume_breakdown ? 'Edit volume' : '+ Add volume'}
              </button>
            )}
          </div>
          {g.description && <p className="text-sm text-pool-200 whitespace-pre-wrap">{g.description}</p>}
          {g.sets?.raw && g.sets.raw !== g.description && (
            <pre className="text-xs text-pool-400 mt-2 whitespace-pre-wrap font-mono">{g.sets.raw}</pre>
          )}
          {editingVolGroup === g.group_number ? (
            <div className="mt-3 pt-3 border-t border-pool-700">
              <p className="text-xs text-pool-400 mb-2">Volume breakdown (metres per zone)</p>
              <VolumeEditor value={volDraft} onChange={setVolDraft} presentation={presentation} />
            </div>
          ) : (
            <VolumeDisplay breakdown={g.volume_breakdown} presentation={presentation} />
          )}
        </div>
      ))}

      {/* Actions */}
      <div className="flex gap-3">
        <Link
          to={`/sessions/${id}/register`}
          className="flex-1 bg-accent-600 text-white text-center rounded-xl py-3 font-semibold text-sm"
        >
          Open Register
        </Link>
        <button
          onClick={getRecommendations}
          disabled={recommending}
          className="flex-1 bg-pool-700 rounded-xl py-3 font-semibold text-sm disabled:opacity-40"
        >
          {recommending ? 'Thinking...' : 'Suggest Groups'}
        </button>
        <button
          onClick={printSheet}
          className="bg-pool-700 hover:bg-pool-600 border border-pool-600 rounded-xl px-4 py-3 text-sm transition-colors"
          title="Quick print (popup)"
        >
          🖨
        </button>
        <button
          onClick={() => navigate(`/sessions/${id}/print`)}
          className="bg-pool-700 hover:bg-pool-600 border border-pool-600 rounded-xl px-4 py-3 text-xs font-medium transition-colors text-pool-300"
          title="Session sheet with sub-groups"
        >
          Sheet
        </button>
      </div>

      {/* Group recommendations */}
      {recommendations && (
        <div className="bg-pool-800 rounded-xl p-4 space-y-2">
          <h3 className="font-semibold text-sm text-accent-400">Group Recommendations</h3>
          {recommendations.map((r) => (
            <div key={r.swimmer_id} className="flex justify-between items-start py-1 border-b border-pool-700 last:border-0">
              <div>
                <p className="text-sm font-medium">{r.name}</p>
                <p className="text-xs text-pool-400">{r.reason}</p>
              </div>
              <span className="bg-accent-600 text-white text-xs rounded-full px-2 py-0.5 ml-2 flex-shrink-0">
                G{r.group}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


function GroupVolumeToggle({ value, onChange, presentation }) {
  const [open, setOpen] = useState(false)
  const total = VOL_KEYS.reduce((s, k) => s + (Number(value[k]) || 0), 0)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-xs text-pool-400 hover:text-pool-200 flex items-center gap-1"
      >
        {open ? '▾' : '▸'} {total > 0 ? `Volume: ${(total/1000).toFixed(2)}km` : 'Add volume breakdown'}
      </button>
      {open && (
        <div className="mt-2">
          <VolumeEditor value={value} onChange={onChange} presentation={presentation} />
        </div>
      )}
    </div>
  )
}

function NewSession() {
  const { settings: presentation } = useSessionPresentation()
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    start_time: '',
    end_time: '',
    course: 'SCM',
    title: '',
    squad: '',
    coach_intent: '',
    energy_system_focus: '',
    groups: {},
  })
  const [saving, setSaving] = useState(false)

  const setGroup = (num, field, value) => {
    setForm((f) => ({
      ...f,
      groups: {
        ...f.groups,
        [num]: { ...(f.groups[num] || {}), [field]: value },
      },
    }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await api.createSession(form)
      window.location.href = `/sessions/${res.id}`
    } catch (e) {
      alert(`Error: ${e.message}`)
      setSaving(false)
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 pt-2">
        <Link to="/sessions" className="text-pool-400 text-2xl">‹</Link>
        <h1 className="text-lg font-bold">New Session</h1>
      </div>

      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="flex-1 bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
          />
          <input
            type="time"
            value={form.start_time}
            onChange={(e) => setForm({ ...form, start_time: e.target.value })}
            className="w-28 bg-pool-800 rounded-xl px-3 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
            placeholder="Start"
          />
          <input
            type="time"
            value={form.end_time}
            onChange={(e) => setForm({ ...form, end_time: e.target.value })}
            className="w-28 bg-pool-800 rounded-xl px-3 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
            placeholder="End"
          />
        </div>
        <div className="flex rounded-xl overflow-hidden border border-pool-700 text-sm font-semibold">
          {['SCM', 'LCM'].map(c => (
            <button
              key={c}
              onClick={() => setForm({ ...form, course: c })}
              className={`flex-1 py-3 transition-colors ${form.course === c ? 'bg-accent-600 text-white' : 'bg-pool-800 text-pool-400'}`}
            >
              {c === 'SCM' ? 'SC (25m)' : 'LC (50m)'}
            </button>
          ))}
        </div>
        <input
          placeholder="Session title (optional)"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
        />
        <textarea
          placeholder="Coach intent — why are you running this session?"
          value={form.coach_intent}
          onChange={(e) => setForm({ ...form, coach_intent: e.target.value })}
          rows={2}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none resize-none"
        />
        <select
          value={form.energy_system_focus}
          onChange={(e) => setForm({ ...form, energy_system_focus: e.target.value })}
          className="w-full bg-pool-800 rounded-xl px-4 py-3 text-sm border border-pool-700 focus:border-accent-500 focus:outline-none"
        >
          <option value="">{presentation.terminology_name || 'Energy system'} (optional)</option>
          {presentation.terminology_levels.map(level => (
            <option key={level.id} value={level.canonical_zone}>{level.label}</option>
          ))}
          <option value="mixed">Mixed</option>
        </select>

        {[1, 2, 3].map((n) => (
          <div key={n} className="bg-pool-800 rounded-xl p-4 space-y-2">
            <p className="font-semibold text-sm text-accent-400">Group {n}</p>
            <textarea
              placeholder={`Group ${n} sets...`}
              value={form.groups[n]?.sets || ''}
              onChange={(e) => setGroup(n, 'sets', e.target.value)}
              rows={3}
              className="w-full bg-pool-700 rounded-lg px-3 py-2 text-sm border border-pool-600 focus:border-accent-500 focus:outline-none resize-none"
            />
            <GroupVolumeToggle
              value={form.groups[n]?.volume_breakdown || {}}
              onChange={(v) => setGroup(n, 'volume_breakdown', v)}
              presentation={presentation}
            />
          </div>
        ))}
      </div>

      <button
        onClick={save}
        disabled={saving || !form.date}
        className="w-full bg-accent-600 disabled:opacity-40 rounded-xl py-3 font-semibold"
      >
        {saving ? 'Saving...' : 'Create Session'}
      </button>
    </div>
  )
}
