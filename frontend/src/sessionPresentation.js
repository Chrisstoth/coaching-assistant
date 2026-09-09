import { setRows, rowsTotalMetres } from './sessionSets.js'

export const CANONICAL_ZONES = [
  'recovery', 'aerobic', 'threshold', 'vo2', 'race_pace',
  'lact_tol', 'short_race_pace', 'sprint', 'kicking', 'mixed',
]

export const CANONICAL_LABELS = {
  recovery: 'Recovery', aerobic: 'Aerobic', threshold: 'Threshold', vo2: 'VO2',
  race_pace: 'Race pace', lact_tol: 'Lactate tolerance', short_race_pace: 'Short race pace',
  sprint: 'Sprint', kicking: 'Kicking', mixed: 'Mixed',
}

const ZONE_ALIASES = { speed: 'sprint', vo2max: 'vo2', lactate_tolerance: 'lact_tol' }

export const DEFAULT_PRESENTATION = {
  club_name: '',
  logo_data_url: null,
  terminology_name: 'LaneWatch energy zones',
  terminology_levels: [
    { id: 'recovery', label: 'Recovery', description: 'Easy restorative swimming with low physiological cost.', colour: '#16a34a', canonical_zone: 'recovery' },
    { id: 'aerobic', label: 'Aerobic', description: 'Sustainable aerobic work with repeatable technique.', colour: '#2563eb', canonical_zone: 'aerobic' },
    { id: 'threshold', label: 'Threshold', description: 'Controlled hard work around sustainable threshold pace.', colour: '#d97706', canonical_zone: 'threshold' },
    { id: 'vo2', label: 'VO2', description: 'High aerobic power work with purposeful recovery.', colour: '#dc2626', canonical_zone: 'vo2' },
    { id: 'race_pace', label: 'Race pace', description: 'Competition-pace work for a named event or distance.', colour: '#7c3aed', canonical_zone: 'race_pace' },
    { id: 'lact_tol', label: 'Lactate tolerance', description: 'Very hard repeated work targeting glycolytic tolerance.', colour: '#db2777', canonical_zone: 'lact_tol' },
    { id: 'sprint', label: 'Sprint', description: 'Maximal short-duration speed and power work.', colour: '#ea580c', canonical_zone: 'sprint' },
  ],
}

const GROUP_COLOURS = ['#2563eb', '#d97706', '#16a34a', '#7c3aed', '#db2777', '#0891b2']

// Easy through maximal, for shading a numeric effort that carries no zone name.
const EFFORT_RAMP = ['#16a34a', '#2563eb', '#d97706', '#dc2626']

export function normalisePresentation(value) {
  const levels = Array.isArray(value?.terminology_levels) && value.terminology_levels.length
    ? value.terminology_levels
    : DEFAULT_PRESENTATION.terminology_levels
  return { ...DEFAULT_PRESENTATION, ...(value || {}), terminology_levels: levels }
}

/** The club's own effort vocabulary, in the shape the set parser recognises. */
export function presentationZones(settings) {
  return normalisePresentation(settings).terminology_levels.map(level => ({
    label: level.label,
    colour: /^#[0-9a-f]{6}$/i.test(level.colour || '') ? level.colour : '#2563eb',
    canonical_zone: level.canonical_zone || null,
  }))
}

export function energyPresentation(zone, settings) {
  const rawKey = String(zone || '').trim().toLowerCase()
  const key = ZONE_ALIASES[rawKey] || rawKey
  const presentation = normalisePresentation(settings)
  const match = presentation.terminology_levels.find(level => level.canonical_zone === key)
    || presentation.terminology_levels.find(level => String(level.label).toLowerCase() === key)
  return {
    label: match?.label || CANONICAL_LABELS[key] || String(zone || ''),
    colour: /^#[0-9a-f]{6}$/i.test(match?.colour || '') ? match.colour : '#2563eb',
    description: match?.description || '',
  }
}

export function groupColour(groupNumber) {
  const index = Math.max(0, Number(groupNumber || 1) - 1) % GROUP_COLOURS.length
  return GROUP_COLOURS[index]
}

export function groupList(groups) {
  const rows = (Array.isArray(groups) ? [...groups] : Object.entries(groups || {}).map(([key, value]) => ({
      ...(value || {}),
      group_number: value?.group_number ?? key,
      description: value?.description || value?.label || '',
    })))
    .sort((a, b) => Number(a.group_number) - Number(b.group_number))
  const meaningful = rows.filter(group => {
    const volumes = Object.values(group?.volume_breakdown || {}).some(value => Number(value) > 0)
    return Boolean(
      String(group?.description || '').trim()
      || groupSets(group).length
      || (Array.isArray(group?.sub_groups) && group.sub_groups.length)
      || volumes
    )
  })
  return meaningful.length ? meaningful : rows.slice(0, 1)
}

export function groupSets(group) {
  if (Array.isArray(group?.sets)) return group.sets.filter(Boolean)
  if (typeof group?.sets === 'string') return group.sets.split('\n').filter(line => line.trim())
  if (Array.isArray(group?.sets?.raw)) return group.sets.raw.filter(Boolean)
  if (typeof group?.sets?.raw === 'string') return group.sets.raw.split('\n').filter(line => line.trim())
  return []
}

/** The parsed, column-ready rows for a group or sub-group. */
export function groupRows(group, settings) {
  return setRows(group?.sets, presentationZones(settings))
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function formatSetHtml(value, settings) {
  const raw = String(value || '').trim().replace(/^[•›-]\s*/, '')
  if (!raw) return ''
  let html = escapeHtml(raw)

  // Make the measurable prescription scannable without changing the coach's wording.
  html = html.replace(/^(\s*(?:\d+\s*[x×]\s*)?\d+\s*m?\b(?:\s+(?:choice|free|back|breast|fly|kick|pull|IM))?)/i, '<strong class="set-dose">$1</strong>')
  html = html.replace(/(@\s*\d+(?::\d{1,2})?(?:\s*[-–]\s*\d+(?::\d{1,2})?)?|\boff\s+\d+(?::\d{1,2})?)/gi, '<u class="set-sendoff">$1</u>')
  html = html.replace(/\(([^()]{2,80})\)/g, '<em>($1)</em>')

  const labels = normalisePresentation(settings).terminology_levels
    .filter(level => level.label && level.label.length > 1)
    .sort((a, b) => b.label.length - a.label.length)
  for (const level of labels) {
    const safeLabel = escapeHtml(level.label)
    const colour = /^#[0-9a-f]{6}$/i.test(level.colour || '') ? level.colour : '#2563eb'
    html = html.replace(new RegExp(`\\b(${escapeRegExp(safeLabel)})\\b`, 'gi'), `<mark class="set-energy" style="--energy:${colour}">$1</mark>`)
  }
  return html
}

/** The effort cell — its own column, so a row's load can be read at a glance. */
function effortHtml(effort) {
  if (!effort) return '<span class="col-effort empty"></span>'
  const ratio = effort.scale && effort.value !== null ? Math.min(1, effort.value / effort.scale) : null
  const colour = effort.colour
    || (ratio === null ? '#64748b' : EFFORT_RAMP[Math.min(EFFORT_RAMP.length - 1, Math.floor(ratio * EFFORT_RAMP.length))])
  return `<span class="col-effort" style="--energy:${colour}">${escapeHtml(effort.label)}</span>`
}

/** The clock cell — a send-off and a prescribed rest read differently. */
function intervalHtml(interval) {
  if (!interval) return '<span class="col-clock empty"></span>'
  if (interval.kind === 'rest') {
    return `<span class="col-clock is-rest"><i>rest</i> ${escapeHtml(interval.value)}</span>`
  }
  return `<span class="col-clock is-sendoff">@ ${escapeHtml(interval.value)}</span>`
}

function rowHtml(row) {
  const indent = row.depth ? ' is-nested' : ''
  if (row.kind === 'heading') {
    return `<li class="set-row is-heading${indent}">${escapeHtml(row.description)}</li>`
  }
  if (row.kind === 'repeat') {
    return `<li class="set-row is-repeat${indent}"><b>${escapeHtml(row.dose)}</b><span>rounds of</span></li>`
  }
  if (row.kind === 'note') {
    return `<li class="set-row is-note${indent}"><span class="col-what">${escapeHtml(row.description)}</span>${effortHtml(row.effort)}${intervalHtml(row.interval)}</li>`
  }
  const what = [
    row.label ? `<b class="what-label">${escapeHtml(row.label)}</b>` : '',
    escapeHtml(row.description),
  ].filter(Boolean).join(' ')
  return `<li class="set-row${indent}">`
    + `<b class="col-dose">${escapeHtml(row.dose)}</b>`
    + `<span class="col-what">${what}</span>`
    + effortHtml(row.effort)
    + intervalHtml(row.interval)
    + '</li>'
}

/**
 * A group's sets as aligned columns: dose on the left, what to swim in the
 * middle, effort and the clock on the right — the order a coach scans them in.
 */
function setTableHtml(sets, settings) {
  const rows = setRows(sets, presentationZones(settings))
  if (!rows.length) return ''
  return '<ul class="set-list">'
    + '<li class="set-row is-columns"><span>Reps × dist</span><span>Set</span><span>Effort</span><span>Clock</span></li>'
    + rows.map(rowHtml).join('')
    + '</ul>'
}

function dateLabel(value) {
  if (!value) return ''
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function volumeHtml(group, settings) {
  const breakdown = group?.volume_breakdown || {}
  const rows = Object.entries(breakdown).filter(([, metres]) => Number(metres) > 0)
  if (!rows.length) return ''
  return `<div class="volume-chips">${rows.map(([zone, metres]) => {
    const display = energyPresentation(zone, settings)
    return `<span style="--energy:${display.colour}">${escapeHtml(display.label)} <b>${Number(metres).toLocaleString('en-GB')}m</b></span>`
  }).join('')}</div>`
}

function groupHtml(group, index, total, settings) {
  const colour = groupColour(group.group_number || index + 1)
  const wholeSquad = total === 1
  const title = wholeSquad ? 'Whole squad' : `Group ${escapeHtml(group.group_number || index + 1)}`
  const table = setTableHtml(group.sets, settings)
  const subGroups = Array.isArray(group.sub_groups) ? group.sub_groups : []
  const emptyNotice = !table && !subGroups.length ? '<ul class="set-list"><li class="set-row is-note empty">No sets recorded</li></ul>' : ''
  const subGroupRows = subGroups.map(sub => `
    <div class="sub-group">
      <div class="sub-group-title"><strong>${escapeHtml(sub.label || 'Sub-group')}</strong>${sub.aim ? `<em>${escapeHtml(sub.aim)}</em>` : ''}</div>
      ${setTableHtml(sub.sets, settings)}
      ${volumeHtml(sub, settings)}
    </div>`).join('')
  // Fall back to the metres the rows themselves add up to when none was recorded.
  const metres = Number(group.total_metres) || rowsTotalMetres(setRows(group.sets, presentationZones(settings)))
  return `<article class="group-card" style="--group:${colour}">
    <header class="group-header">
      <div><h2>${title}</h2>${group.description ? `<p>${escapeHtml(group.description)}</p>` : ''}</div>
      ${metres ? `<b class="group-total">${Number(metres).toLocaleString('en-GB')}m</b>` : ''}
    </header>
    ${table}${emptyNotice}
    ${subGroupRows}
    ${volumeHtml(group, settings)}
  </article>`
}

export function buildSessionPrintHtml({ session, settings, recommendations = [], autoPrint = true }) {
  const presentation = normalisePresentation(settings)
  const groups = groupList(session.groups)
  const energy = energyPresentation(session.energy_system_focus || session.energy_focus, presentation)
  const title = session.title || 'Training session'
  const meta = [dateLabel(session.date), session.start_time && `${session.start_time}${session.end_time ? `–${session.end_time}` : ''}`, session.squad, session.course].filter(Boolean)
  const logo = presentation.logo_data_url
    ? `<img class="club-logo" src="${escapeHtml(presentation.logo_data_url)}" alt="${escapeHtml(presentation.club_name || 'Club')} logo">`
    : '<img class="lane-logo" src="/lanewatch-mark-ink.png" alt="LaneWatch">'
  const rows = (recommendations || []).map(row => `<tr><td>${escapeHtml(row.name)}</td><td>Group ${escapeHtml(row.group || row.suggested_group || '')}</td><td>${escapeHtml(row.reason || row.note || '')}</td></tr>`).join('')
  const warmCool = session.warm_up || session.cool_down ? `<section class="warm-cool">
    ${session.warm_up ? `<div><h3>Warm up</h3>${setTableHtml(session.warm_up, presentation) || `<p>${formatSetHtml(session.warm_up, presentation)}</p>`}</div>` : '<div></div>'}
    ${session.cool_down ? `<div><h3>Cool down</h3>${setTableHtml(session.cool_down, presentation) || `<p>${formatSetHtml(session.cool_down, presentation)}</p>`}</div>` : '<div></div>'}
  </section>` : ''

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} — session sheet</title><style>
  @font-face{font-family:Oxanium;src:url('/fonts/Oxanium-Regular.ttf')}@font-face{font-family:Oxanium;src:url('/fonts/Oxanium-SemiBold.ttf');font-weight:600}@font-face{font-family:Oxanium;src:url('/fonts/Oxanium-Bold.ttf');font-weight:700}
  *{box-sizing:border-box}html{background:#eef1f4}body{width:210mm;min-height:297mm;margin:12px auto;padding:12mm 13mm;background:#fff;color:#17202a;font:12px/1.38 Oxanium,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet-header{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:18px;align-items:center;border-bottom:3px solid #2563eb;padding-bottom:10px;margin-bottom:13px}.brand{display:flex;align-items:center;gap:9px}.club-logo{display:block;max-width:38mm;max-height:17mm;object-fit:contain}.lane-logo{width:35px;height:35px;object-fit:contain}.club-name{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#475569}.heading{text-align:right}.heading h1{margin:0;font-size:22px;line-height:1.12}.meta{display:flex;flex-wrap:wrap;gap:4px 11px;justify-content:flex-end;margin-top:5px;color:#52606d}.energy-badge{display:inline-flex;align-items:center;border:1px solid color-mix(in srgb,var(--energy),#fff 58%);border-radius:999px;padding:2px 8px;background:color-mix(in srgb,var(--energy),#fff 88%);color:var(--energy);font-weight:700}
  .intent{margin:0 0 12px;padding:9px 11px;border-left:4px solid #2563eb;background:#f4f7fb}.intent h3,.warm-cool h3,.section-label{margin:0 0 3px;font-size:9px;letter-spacing:.11em;text-transform:uppercase;color:#64748b}.intent p,.warm-cool p{margin:0}.warm-cool{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:12px}.warm-cool>div{padding:8px 10px;border:1px solid #dce3ea;border-radius:6px;background:#fafbfc}.warm-cool .set-list{padding:0}
  .section-label{padding-bottom:4px;border-bottom:1px solid #cbd5e1;margin-bottom:8px}.groups-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:start}.groups-grid.count-1{grid-template-columns:1fr}.groups-grid.count-3{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.group-card{border:1px solid #cfd8e3;border-top:4px solid var(--group);border-radius:6px;overflow:hidden;break-inside:avoid}.group-header{display:flex;justify-content:space-between;gap:8px;padding:7px 9px;background:#f5f7f9;border-bottom:1px solid #dce3ea}.group-header h2{margin:0;font-size:14px}.group-header p{margin:1px 0 0;color:#52606d;font-size:10px}.group-total{white-space:nowrap}
  /* Every set reads as four columns: dose, what to swim, effort, clock. */
  .set-list{list-style:none;margin:0;padding:3px 9px}
  .set-row{display:grid;grid-template-columns:minmax(3.4em,auto) minmax(0,1fr) auto auto;gap:0 7px;align-items:baseline;padding:4px 0;border-bottom:1px solid #edf0f3}
  .set-row:last-child{border-bottom:0}
  .set-row.is-columns{padding:0 0 3px;border-bottom:1px solid #cbd5e1;font-size:7.5px;letter-spacing:.07em;text-transform:uppercase;color:#94a3b8}
  .set-row.is-columns span:nth-child(3),.set-row.is-columns span:nth-child(4){text-align:right}
  .col-dose{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
  .col-what{min-width:0;overflow-wrap:anywhere}.what-label{color:#475569}
  .col-effort{justify-self:end;border-radius:3px;padding:0 4px;background:color-mix(in srgb,var(--energy),#fff 84%);color:color-mix(in srgb,var(--energy),#17202a 45%);font-size:9.5px;font-weight:700;white-space:nowrap}
  .col-clock{justify-self:end;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
  .col-clock.is-sendoff{text-decoration:underline;text-decoration-color:#94a3b8;text-underline-offset:2px}
  .col-clock.is-rest{font-weight:600;color:#52606d}.col-clock.is-rest i{font-style:normal;font-size:8px;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8}
  .col-effort.empty,.col-clock.empty{padding:0;background:none}
  .set-row.is-note,.set-row.is-heading,.set-row.is-repeat{grid-template-columns:minmax(0,1fr) auto auto}
  .set-row.is-heading{grid-template-columns:1fr;margin-top:2px;font-size:8.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--group,#475569)}
  .set-row.is-repeat{grid-template-columns:auto minmax(0,1fr);color:#475569;font-size:10px}.set-row.is-repeat b{font-weight:700}
  .set-row.is-nested{padding-left:9px;border-left:2px solid #e2e8f0}
  .set-row.is-note.empty{color:#94a3b8;font-style:italic}
  .set-dose{font-weight:700}.set-sendoff{text-decoration-color:#64748b;text-decoration-thickness:1px;text-underline-offset:2px}.set-energy{border:0;border-radius:3px;padding:0 3px;background:color-mix(in srgb,var(--energy),#fff 84%);color:#17202a;font-weight:700}
  .count-3 .set-list{padding:3px 6px;font-size:10.5px}.count-3 .set-row{grid-template-columns:minmax(3em,auto) minmax(0,1fr) auto auto;gap:0 4px}.count-3 .col-effort{font-size:8.5px;padding:0 3px}
  .sub-group{margin:6px 8px 8px;border-left:3px solid #cbd5e1}.sub-group-title{display:flex;gap:8px;padding:3px 8px;color:#475569}.sub-group-title em{font-size:10px}.volume-chips{display:flex;flex-wrap:wrap;gap:4px;padding:5px 9px 8px}.volume-chips span{border-left:3px solid var(--energy);padding:2px 5px;background:#f1f5f9;font-size:9px}
  .swimmers{margin-top:12px}.swimmers table{width:100%;border-collapse:collapse}.swimmers th,.swimmers td{padding:4px 6px;border-bottom:1px solid #e2e8f0;text-align:left}.swimmers th{font-size:9px;text-transform:uppercase;color:#64748b;background:#f8fafc}.notes{height:20mm;margin-top:13px;border:1px solid #dce3ea;border-radius:5px;background:repeating-linear-gradient(#fff,#fff 7mm,#e9eef3 7.2mm)}.notes-label{margin-top:12px}.footer{display:flex;justify-content:space-between;margin-top:9px;padding-top:6px;border-top:1px solid #dce3ea;color:#94a3b8;font-size:8px}.screen-actions{position:fixed;right:20px;bottom:20px;display:flex;gap:8px}.screen-actions button{border:0;border-radius:7px;padding:10px 14px;background:#111827;color:#fff;font:600 12px Oxanium;cursor:pointer}
  @media print{@page{size:A4 portrait;margin:9mm}html,body{background:#fff}body{width:auto;min-height:0;margin:0;padding:0}.screen-actions{display:none}.group-card{break-inside:avoid}.set-row{break-inside:avoid}.notes{height:16mm}}
  </style></head><body>
  <header class="sheet-header"><div class="brand">${logo}${presentation.club_name ? `<span class="club-name">${escapeHtml(presentation.club_name)}</span>` : ''}</div><div class="heading"><h1>${escapeHtml(title)}</h1><div class="meta">${meta.map(item => `<span>${escapeHtml(item)}</span>`).join('')}${energy.label ? `<span class="energy-badge" style="--energy:${energy.colour}">${escapeHtml(energy.label)}</span>` : ''}${session.cycle_code ? `<span>Cycle ${escapeHtml(session.cycle_code)}</span>` : ''}</div></div></header>
  ${session.coach_intent ? `<section class="intent"><h3>Session intent</h3><p>${escapeHtml(session.coach_intent)}</p></section>` : ''}${warmCool}
  <main><h2 class="section-label">Session programme</h2><div class="groups-grid count-${Math.min(groups.length || 1, 3)}">${groups.map((group, index) => groupHtml(group, index, groups.length, presentation)).join('') || '<p>No programme recorded.</p>'}</div></main>
  ${rows ? `<section class="swimmers"><h2 class="section-label">Swimmer groups</h2><table><thead><tr><th>Swimmer</th><th>Group</th><th>Coach note</th></tr></thead><tbody>${rows}</tbody></table></section>` : ''}
  <h2 class="section-label notes-label">Poolside notes</h2><div class="notes"></div><footer class="footer"><span>LaneWatch AI · ${escapeHtml(presentation.terminology_name)}</span><span>${new Date().toLocaleDateString('en-GB')}</span></footer>
  <div class="screen-actions"><button type="button" onclick="window.print()">Print / save PDF</button><button type="button" onclick="window.close()">Close</button></div>${autoPrint ? '<script>window.addEventListener(\'load\',()=>window.print())</script>' : ''}</body></html>`
}

export function openSessionPrint(options) {
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('Your browser blocked the print window. Allow popups and try again.')
  popup.document.open()
  popup.document.write(buildSessionPrintHtml(options))
  popup.document.close()
}
