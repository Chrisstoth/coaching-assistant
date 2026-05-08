import { useState, useEffect } from 'react'
import { api } from '../api'

const ENERGY_COLOURS = {
  aerobic: 'bg-blue-900/40 text-blue-300 border-blue-800',
  threshold: 'bg-orange-900/40 text-orange-300 border-orange-800',
  speed: 'bg-red-900/40 text-red-300 border-red-800',
  recovery: 'bg-green-900/40 text-green-300 border-green-800',
  mixed: 'bg-purple-900/40 text-purple-300 border-purple-800',
}

export default function SessionPlanner() {
  const [text, setText] = useState('')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null)

  const analyse = async () => {
    if (!text.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSaved(null)
    try {
      const data = await api.planSession({ text, date })
      setResult(data)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const saveAsSession = async () => {
    if (!result) return
    setSaving(true)
    try {
      const parsed = result.parsed
      const session = await api.createSession({
        date,
        title: parsed.title,
        energy_system_focus: parsed.energy_focus,
        coach_intent: result.plan_alignment,
        groups: parsed.groups,
        status: 'planned',
      })
      setSaved(session)
    } catch (e) {
      alert('Error saving: ' + e.message)
    }
    setSaving(false)
  }

  const printSheet = () => {
    if (!result) return
    const { parsed, per_swimmer, expected_effects } = result

    const energyLabel = parsed.energy_focus
      ? parsed.energy_focus.charAt(0).toUpperCase() + parsed.energy_focus.slice(1)
      : ''

    const groupColours = {
      1: '#ea580c',
      2: '#d97706',
      3: '#65a30d',
    }

    const groupsHtml = Object.entries(parsed.groups || {}).map(([num, grp]) => `
      <div class="group-card">
        <div class="group-header" style="border-left: 4px solid ${groupColours[num] || '#888'}">
          <span class="group-num">Group ${num}</span>
          <span class="group-label">${grp.label || ''}</span>
        </div>
        <ul class="set-list">
          ${(grp.sets || []).map(s => `<li>${s}</li>`).join('')}
        </ul>
      </div>
    `).join('')

    const swimmerTableRows = (per_swimmer || []).map(sw => `
      <tr>
        <td>${sw.name}</td>
        <td class="group-cell" style="color: ${groupColours[sw.suggested_group] || '#888'}">Group ${sw.suggested_group}</td>
        <td class="note-cell">${sw.note || ''}</td>
      </tr>
    `).join('')

    const swimmerTable = per_swimmer && per_swimmer.length > 0 ? `
      <section class="section">
        <h2 class="section-title">Swimmer Groups</h2>
        <table class="swimmer-table">
          <thead>
            <tr><th>Swimmer</th><th>Group</th><th>Note</th></tr>
          </thead>
          <tbody>${swimmerTableRows}</tbody>
        </table>
      </section>
    ` : ''

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Session Sheet — ${parsed.title || 'Training Session'}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', Arial, sans-serif;
      background: #fff;
      color: #111;
      font-size: 13px;
      padding: 24px 28px;
      max-width: 800px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 3px solid #ea580c;
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .logo {
      height: 52px;
      width: auto;
    }
    .club-name {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #ea580c;
    }
    .header-right {
      text-align: right;
    }
    .session-title {
      font-size: 20px;
      font-weight: 700;
      color: #111;
      line-height: 1.2;
    }
    .session-meta {
      font-size: 12px;
      color: #555;
      margin-top: 4px;
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: #fff7ed;
      color: #ea580c;
      border: 1px solid #fdba74;
    }

    /* Sections */
    .section {
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #888;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e5e5e5;
    }

    /* Warm/cool */
    .warmcool-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .warmcool-card {
      background: #f9f9f9;
      border-radius: 8px;
      padding: 10px 12px;
      border: 1px solid #e5e5e5;
    }
    .warmcool-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin-bottom: 4px;
    }

    /* Groups */
    .groups-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .group-card {
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      overflow: hidden;
    }
    .group-header {
      padding: 8px 10px;
      background: #f5f5f5;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .group-num {
      font-size: 13px;
      font-weight: 700;
      color: #111;
    }
    .group-label {
      font-size: 11px;
      color: #666;
    }
    .set-list {
      list-style: none;
      padding: 8px 10px;
    }
    .set-list li {
      padding: 4px 0;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;
      line-height: 1.4;
    }
    .set-list li:last-child {
      border-bottom: none;
    }

    /* Swimmer table */
    .swimmer-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .swimmer-table th {
      text-align: left;
      padding: 6px 8px;
      background: #f5f5f5;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #666;
      border-bottom: 1px solid #e5e5e5;
    }
    .swimmer-table td {
      padding: 6px 8px;
      border-bottom: 1px solid #f0f0f0;
    }
    .group-cell {
      font-weight: 700;
      white-space: nowrap;
    }
    .note-cell {
      color: #444;
    }

    /* Coaching note */
    .coaching-note {
      background: #fff7ed;
      border: 1px solid #fdba74;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 12px;
      line-height: 1.6;
      color: #444;
    }

    /* Footer */
    .footer {
      margin-top: 20px;
      padding-top: 10px;
      border-top: 1px solid #e5e5e5;
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: #aaa;
    }

    @media print {
      body { padding: 12px 16px; }
      @page { margin: 12mm; }
    }
  </style>
</head>
<body>

  <header class="header">
    <div class="header-left">
      <img src="/logo.png" class="logo" alt="Club logo" onerror="this.style.display='none'" />
    </div>
    <div class="header-right">
      <div class="session-title">${parsed.title || 'Training Session'}</div>
      <div class="session-meta">
        ${date ? `<span>${new Date(date + 'T12:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>` : ''}
        ${parsed.total_volume_m ? `<span>${parsed.total_volume_m}</span>` : ''}
        ${energyLabel ? `<span class="badge">${energyLabel}</span>` : ''}
      </div>
    </div>
  </header>

  ${(parsed.warm_up || parsed.cool_down) ? `
  <section class="section">
    <div class="warmcool-row">
      ${parsed.warm_up ? `
      <div class="warmcool-card">
        <div class="warmcool-label">Warm Up</div>
        <div>${parsed.warm_up}</div>
      </div>` : '<div></div>'}
      ${parsed.cool_down ? `
      <div class="warmcool-card">
        <div class="warmcool-label">Cool Down</div>
        <div>${parsed.cool_down}</div>
      </div>` : '<div></div>'}
    </div>
  </section>
  ` : ''}

  <section class="section">
    <h2 class="section-title">Main Set</h2>
    <div class="groups-grid">
      ${groupsHtml}
    </div>
  </section>

  ${swimmerTable}

  ${expected_effects ? `
  <section class="section">
    <h2 class="section-title">Coach's Focus</h2>
    <div class="coaching-note">${expected_effects}</div>
  </section>
  ` : ''}

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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 shrink-0 border-b border-pool-600">
        <div className="flex items-center gap-2 mb-0.5">
          <div className="w-1.5 h-5 bg-accent-500 rounded-full" />
          <h1 className="text-lg font-bold tracking-tight">Session Planner</h1>
        </div>
        <p className="text-pool-400 text-xs pl-3.5">Write a session in plain text — get an AI preview and a printable sheet</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Input section */}
        <div className="px-4 pt-4 space-y-3">
          {/* Date row */}
          <div>
            <label className="text-xs text-pool-400 block mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none"
            />
          </div>

          {/* Session text */}
          <div>
            <label className="text-xs text-pool-400 block mb-1">Session</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Type your session here — as free or as structured as you like.&#10;&#10;e.g. Warm up 400 easy, 4x100 drill. Main set 6x400 on 5:30 threshold, 30s extra rest for anyone coming back from illness. Finish 8x50 sprint off 1:30. Cool down 200 easy."
              rows={7}
              className="w-full bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none resize-none leading-relaxed"
            />
          </div>

          <button
            onClick={analyse}
            disabled={loading || !text.trim()}
            className="w-full bg-accent-600 hover:bg-accent-500 active:bg-accent-700 disabled:opacity-40 rounded-xl py-3 text-sm font-semibold transition-colors"
          >
            {loading ? 'Analysing…' : 'Preview & Analyse'}
          </button>

          {error && (
            <p className="text-red-400 text-sm bg-red-900/20 rounded-xl px-3 py-2">{error}</p>
          )}
        </div>

        {/* Results */}
        {result && (
          <div className="px-4 pt-5 pb-6 space-y-4">
            {/* Session title + meta */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold text-base text-pool-200">{result.parsed?.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  {result.parsed?.energy_focus && (
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${ENERGY_COLOURS[result.parsed.energy_focus] || 'bg-pool-700 text-pool-400 border-pool-600'}`}>
                      {result.parsed.energy_focus}
                    </span>
                  )}
                  {result.parsed?.total_volume_m && (
                    <span className="text-xs text-pool-400">{result.parsed.total_volume_m}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={printSheet}
                  className="bg-pool-700 border border-pool-600 hover:border-accent-500 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
                >
                  Print sheet
                </button>
                {saved ? (
                  <span className="bg-green-900/40 border border-green-800 text-green-300 rounded-xl px-3 py-2 text-xs font-semibold">
                    Saved ✓
                  </span>
                ) : (
                  <button
                    onClick={saveAsSession}
                    disabled={saving}
                    className="bg-accent-600 hover:bg-accent-500 disabled:opacity-40 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save session'}
                  </button>
                )}
              </div>
            </div>

            {/* Warm up / cool down */}
            {(result.parsed?.warm_up || result.parsed?.cool_down) && (
              <div className="grid grid-cols-2 gap-2">
                {result.parsed.warm_up && (
                  <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                    <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Warm Up</p>
                    <p className="text-sm text-pool-200">{result.parsed.warm_up}</p>
                  </div>
                )}
                {result.parsed.cool_down && (
                  <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                    <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Cool Down</p>
                    <p className="text-sm text-pool-200">{result.parsed.cool_down}</p>
                  </div>
                )}
              </div>
            )}

            {/* Groups */}
            {result.parsed?.groups && (
              <div>
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">Main Set</p>
                <div className="space-y-2">
                  {Object.entries(result.parsed.groups).map(([num, grp]) => (
                    <div key={num} className="bg-pool-700 border border-pool-600 rounded-xl overflow-hidden">
                      <div className={`flex items-baseline gap-2 px-3 py-2 border-b border-pool-600 ${
                        num === '1' ? 'border-l-2 border-l-accent-600' :
                        num === '2' ? 'border-l-2 border-l-amber-600' :
                        'border-l-2 border-l-green-700'
                      }`}>
                        <span className="font-bold text-sm">Group {num}</span>
                        <span className="text-xs text-pool-400">{grp.label}</span>
                      </div>
                      <ul className="px-3 py-2 space-y-1.5">
                        {(grp.sets || []).map((s, i) => (
                          <li key={i} className="text-sm text-pool-200 flex gap-2">
                            <span className="text-pool-600 shrink-0">›</span>
                            <span>{s}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Plan alignment */}
            {result.plan_alignment && (
              <div className="bg-pool-700 border border-pool-600 rounded-xl p-3">
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-1.5">Plan Alignment</p>
                <p className="text-sm text-pool-200 leading-relaxed">{result.plan_alignment}</p>
              </div>
            )}

            {/* Per swimmer */}
            {result.per_swimmer && result.per_swimmer.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-pool-400 uppercase tracking-wide mb-2">
                  Swimmer Adaptations
                  <span className="ml-2 font-normal normal-case text-pool-400">({result.per_swimmer.length} swimmers)</span>
                </p>
                <div className="space-y-1.5">
                  {result.per_swimmer.map((sw, i) => (
                    <div key={i} className="bg-pool-700 border border-pool-600 rounded-xl px-3 py-2.5 flex items-start gap-3">
                      <div className={`shrink-0 mt-0.5 text-xs font-bold rounded-md px-1.5 py-0.5 ${
                        sw.suggested_group === 1 ? 'bg-accent-600/20 text-accent-400' :
                        sw.suggested_group === 2 ? 'bg-amber-900/30 text-amber-400' :
                        'bg-green-900/30 text-green-400'
                      }`}>G{sw.suggested_group}</div>
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm text-pool-200">{sw.name}</span>
                        {sw.note && <p className="text-xs text-pool-400 mt-0.5 leading-relaxed">{sw.note}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Expected effects */}
            {result.expected_effects && (
              <div className="bg-accent-600/10 border border-accent-600/30 rounded-xl p-3">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-1.5">Expected Effects</p>
                <p className="text-sm text-pool-200 leading-relaxed">{result.expected_effects}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
