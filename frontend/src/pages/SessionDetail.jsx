import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

const VOL_KEYS = ['aerobic', 'threshold', 'vo2', 'race_pace', 'lact_tol', 'short_race_pace', 'kicking', 'sprint']
const VOL_LABELS = { aerobic: 'Aerobic', threshold: 'Threshold', vo2: 'VO2', race_pace: 'Race Pace', lact_tol: 'Lact Tol', short_race_pace: 'Short Race', kicking: 'Kicking', sprint: 'Sprint' }
const VOL_COLOURS = { aerobic: '#3b82f6', threshold: '#f59e0b', vo2: '#ef4444', race_pace: '#8b5cf6', lact_tol: '#ec4899', short_race_pace: '#06b6d4', kicking: '#10b981', sprint: '#f97316' }

function VolumeEditor({ value = {}, onChange }) {
  const total = VOL_KEYS.reduce((s, k) => s + (Number(value[k]) || 0), 0)
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {VOL_KEYS.map(k => (
          <div key={k} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: VOL_COLOURS[k] }} />
            <label className="text-xs text-pool-400 w-20 flex-shrink-0">{VOL_LABELS[k]}</label>
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

function VolumeDisplay({ breakdown }) {
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
            {VOL_LABELS[k]} {(v / 1000).toFixed(2)}km
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
  const [session, setSession] = useState(null)
  const [recommending, setRecommending] = useState(false)
  const [recommendations, setRecommendations] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [editingVolGroup, setEditingVolGroup] = useState(null)
  const [volDraft, setVolDraft] = useState({})
  const [savingVol, setSavingVol] = useState(false)

  useEffect(() => {
    if (id !== 'new') api.getSession(id).then(setSession)
  }, [id])

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

  const printSheet = () => {
    if (!session) return
    const groupColours = { 1: '#2196f3', 2: '#d97706', 3: '#65a30d' }

    const getSets = (g) => {
      if (Array.isArray(g.sets)) return g.sets
      if (g.sets?.raw) return g.sets.raw.split('\n').filter(Boolean)
      if (typeof g.sets === 'string') return g.sets.split('\n').filter(Boolean)
      return []
    }

    const groupsHtml = (session.groups || []).map(g => `
      <div class="group-card">
        <div class="group-header" style="border-left: 4px solid ${groupColours[g.group_number] || '#888'}">
          <span class="group-num">Group ${g.group_number}</span>
          ${g.description ? `<span class="group-label">${g.description}</span>` : ''}
        </div>
        <ul class="set-list">
          ${getSets(g).map(s => `<li>${s}</li>`).join('') || '<li style="color:#aaa">No sets recorded</li>'}
        </ul>
      </div>
    `).join('')

    const swimmerRows = recommendations
      ? recommendations.map(r => `
          <tr>
            <td>${r.name}</td>
            <td class="group-cell" style="color:${groupColours[r.group] || '#888'}">Group ${r.group}</td>
            <td class="note-cell">${r.reason || ''}</td>
          </tr>`).join('')
      : ''

    const swimmerTable = swimmerRows ? `
      <section class="section">
        <h2 class="section-title">Swimmer Groups</h2>
        <table class="swimmer-table">
          <thead><tr><th>Swimmer</th><th>Group</th><th>Note</th></tr></thead>
          <tbody>${swimmerRows}</tbody>
        </table>
      </section>` : ''

    const energyLabel = session.energy_system_focus
      ? session.energy_system_focus.charAt(0).toUpperCase() + session.energy_system_focus.slice(1)
      : ''

    const dateStr = session.date
      ? new Date(session.date + 'T12:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : ''

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Session Sheet — ${session.title || 'Training Session'}</title>
  <style>
    @font-face { font-family: 'Oxanium'; src: url('/fonts/Oxanium-Regular.ttf') format('truetype'); font-weight: 400; }
    @font-face { font-family: 'Oxanium'; src: url('/fonts/Oxanium-SemiBold.ttf') format('truetype'); font-weight: 600; }
    @font-face { font-family: 'Oxanium'; src: url('/fonts/Oxanium-Bold.ttf') format('truetype'); font-weight: 700; }
    @font-face { font-family: 'Orbitron'; src: url('/fonts/Orbitron-Bold.ttf') format('truetype'); font-weight: 700; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Oxanium', Arial, sans-serif; background: #fff; color: #111; font-size: 13px; padding: 24px 28px; max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2196f3; padding-bottom: 14px; margin-bottom: 18px; }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .brand-lockup { display: flex; align-items: center; color: #15171a; }
    .brand-mark { height: 42px; width: auto; margin-right: 10px; }
    .brand-name { font-family: 'Orbitron', sans-serif; font-size: 13px; font-weight: 700; font-style: italic; letter-spacing: .13em; }
    .brand-ai { align-self: flex-start; margin: -3px 0 0 5px; padding: 2px 5px; border-radius: 999px; background: #15171a; color: #fff; font-family: 'Orbitron', sans-serif; font-size: 7px; font-weight: 700; transform: skewX(-12.5deg); }
    .session-title { font-size: 20px; font-weight: 700; color: #111; line-height: 1.2; }
    .session-meta { font-size: 12px; color: #555; margin-top: 4px; display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #e3f2fd; color: #1565c0; border: 1px solid #90caf9; }
    .section { margin-bottom: 16px; }
    .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #888; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e5e5; }
    .groups-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .group-card { border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }
    .group-header { padding: 8px 10px; background: #f5f5f5; display: flex; align-items: baseline; gap: 8px; }
    .group-num { font-size: 13px; font-weight: 700; color: #111; }
    .group-label { font-size: 11px; color: #666; }
    .set-list { list-style: none; padding: 8px 10px; }
    .set-list li { padding: 4px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; line-height: 1.4; }
    .set-list li:last-child { border-bottom: none; }
    .swimmer-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .swimmer-table th { text-align: left; padding: 6px 8px; background: #f5f5f5; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #666; border-bottom: 1px solid #e5e5e5; }
    .swimmer-table td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; }
    .group-cell { font-weight: 700; white-space: nowrap; }
    .note-cell { color: #444; }
    .coaching-note { background: #e3f2fd; border: 1px solid #90caf9; border-radius: 8px; padding: 10px 14px; font-size: 12px; line-height: 1.6; color: #34404a; }
    .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e5e5e5; display: flex; justify-content: space-between; font-size: 10px; color: #aaa; }
    @media print { body { padding: 12px 16px; } @page { margin: 12mm; } }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-left">
      <div class="brand-lockup">
        <img src="/lanewatch-mark-ink.png" class="brand-mark" alt="" />
        <span class="brand-name">LANEWATCH</span><span class="brand-ai">AI</span>
      </div>
    </div>
    <div style="text-align:right">
      <div class="session-title">${session.title || 'Training Session'}</div>
      <div class="session-meta">
        ${dateStr ? `<span>${dateStr}</span>` : ''}
        ${session.squad ? `<span>${session.squad}</span>` : ''}
        ${energyLabel ? `<span class="badge">${energyLabel}</span>` : ''}
      </div>
    </div>
  </header>

  ${session.coach_intent ? `
  <section class="section">
    <h2 class="section-title">Coach Intent</h2>
    <div class="coaching-note">${session.coach_intent}</div>
  </section>` : ''}

  <section class="section">
    <h2 class="section-title">Main Set</h2>
    <div class="groups-grid">${groupsHtml}</div>
  </section>

  ${swimmerTable}

  <footer class="footer">
    <span>Generated by LaneWatch AI</span>
    <span>${new Date().toLocaleDateString('en-GB')}</span>
  </footer>
  <script>window.onload = () => window.print()</script>
</body>
</html>`

    const win = window.open('', '_blank')
    win.document.write(html)
    win.document.close()
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
      window.location.href = '/calendar'
    } catch (e) {
      alert(`Error: ${e.message}`)
      setDeleting(false)
    }
  }

  if (id === 'new') return <NewSession />
  if (!session) return <div className="p-4 text-pool-400">Loading...</div>

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 pt-2">
        <Link to="/calendar" className="text-pool-400 text-2xl">‹</Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold">{session.title || 'Session'}</h1>
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
              <VolumeEditor value={volDraft} onChange={setVolDraft} />
            </div>
          ) : (
            <VolumeDisplay breakdown={g.volume_breakdown} />
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


function GroupVolumeToggle({ value, onChange }) {
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
          <VolumeEditor value={value} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

function NewSession() {
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
          <option value="">Energy system (optional)</option>
          <option value="aerobic">Aerobic</option>
          <option value="threshold">Threshold</option>
          <option value="speed">Speed</option>
          <option value="recovery">Recovery</option>
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
