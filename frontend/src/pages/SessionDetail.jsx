import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api'

export default function SessionDetail() {
  const { id } = useParams()
  const [session, setSession] = useState(null)
  const [recommending, setRecommending] = useState(false)
  const [recommendations, setRecommendations] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    if (id !== 'new') api.getSession(id).then(setSession)
  }, [id])

  const printSheet = () => {
    if (!session) return
    const groupColours = { 1: '#ea580c', 2: '#d97706', 3: '#65a30d' }

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
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', Arial, sans-serif; background: #fff; color: #111; font-size: 13px; padding: 24px 28px; max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #ea580c; padding-bottom: 14px; margin-bottom: 18px; }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .logo { height: 52px; width: auto; }
    .session-title { font-size: 20px; font-weight: 700; color: #111; line-height: 1.2; }
    .session-meta { font-size: 12px; color: #555; margin-top: 4px; display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #fff7ed; color: #ea580c; border: 1px solid #fdba74; }
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
    .coaching-note { background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 10px 14px; font-size: 12px; line-height: 1.6; color: #444; }
    .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e5e5e5; display: flex; justify-content: space-between; font-size: 10px; color: #aaa; }
    @media print { body { padding: 12px 16px; } @page { margin: 12mm; } }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-left">
      <img src="/logo.png" class="logo" alt="Club logo" onerror="this.style.display='none'" />
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
    <span>Generated by Deckxtra</span>
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

      {/* Groups */}
      {session.groups?.map((g) => (
        <div key={g.group_number} className="bg-pool-800 rounded-xl p-4">
          <h3 className="font-semibold text-sm text-accent-400 mb-2">Group {g.group_number}</h3>
          {g.description && <p className="text-sm text-pool-200 whitespace-pre-wrap">{g.description}</p>}
          {g.sets?.raw && g.sets.raw !== g.description && (
            <pre className="text-xs text-pool-400 mt-2 whitespace-pre-wrap font-mono">{g.sets.raw}</pre>
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
          title="Print session sheet"
        >
          🖨
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
