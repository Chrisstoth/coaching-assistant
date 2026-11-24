// The athlete plan as a printable document. Kept free of React so what goes
// into the shared document can be tested directly.

export const AUDIENCE_LABELS = {
  performance: 'Performance staff (e.g. British Swimming)',
  swimmer: 'The swimmer',
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function longDate(value) {
  if (!value) return ''
  const d = new Date(`${String(value).slice(0, 10)}T12:00:00`)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

// Sections that go in the document: switched on and with something written.
export function includedSections(plan) {
  return (plan?.sections || []).filter(s => s.included && String(s.content || '').trim())
}

// Anything the staff could not fill in, left for the coach.
export function gapsToFill(plan) {
  return includedSections(plan).flatMap(s =>
    [...String(s.content).matchAll(/\[to add:([^\]]*)\]/gi)].map(m => ({ section: s.title, what: m[1].trim() })))
}

// Paragraphs and "- " bullet lists, the only formatting the staff are asked for.
export function sectionHtml(text) {
  const blocks = []
  let list = []
  const flush = () => {
    if (list.length) blocks.push(`<ul>${list.map(item => `<li>${item}</li>`).join('')}</ul>`)
    list = []
  }
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { flush(); continue }
    const bullet = /^[-•*]\s+(.*)$/.exec(line)
    const safe = escapeHtml(bullet ? bullet[1] : line).replace(/\[to add:([^\]]*)\]/gi, '<mark>[to add:$1]</mark>')
    if (bullet) list.push(safe)
    else { flush(); blocks.push(`<p>${safe}</p>`) }
  }
  flush()
  return blocks.join('')
}

// The swimmer's goals as printed: the same list the plan shows, just before
// "What we're working towards".
export const GOALS_BEFORE = 'towards'

function shortDate(value) {
  return new Date(`${String(value).slice(0, 10)}T12:00:00`)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function goalsHtml(goals = []) {
  if (!goals.length) return ''
  const items = goals.map(g => {
    const detail = [
      g.race && g.race !== g.label ? g.race : '',
      g.meet_name ? `by ${g.meet_name}${g.meet_date ? ` (${shortDate(g.meet_date)})` : ''}` : g.deadline ? `by ${shortDate(g.deadline)}` : '',
      g.status || '',
    ].filter(Boolean).join(' · ')
    return `<li class="goal${g.achieved ? ' done' : ''}"><span class="box">${g.achieved ? '&#10003;' : ''}</span><div><b>${escapeHtml(g.label)}</b>`
      + (detail ? `<div class="gd">${escapeHtml(detail)}</div>` : '')
      + (g.description ? `<div class="gd">${escapeHtml(g.description)}</div>` : '')
      + '</div></li>'
  }).join('')
  return `<section><h2>Goals</h2><ul class="goals">${items}</ul></section>`
}

// Everything that prints, in order: the sections switched on, with the goals in their place.
export function planBody(plan) {
  const all = plan?.sections || []
  const included = new Set(includedSections(plan).map(s => s.key))
  const goals = goalsHtml(plan?.goals || [])
  const parts = all.some(s => s.key === GOALS_BEFORE) ? [] : [goals]
  for (const s of all) {
    if (s.key === GOALS_BEFORE) parts.push(goals)
    if (included.has(s.key)) parts.push(`<section><h2>${escapeHtml(s.title)}</h2>${sectionHtml(s.content)}</section>`)
  }
  return parts.filter(Boolean).join('\n')
}

export function buildPlanHtml(plan, { autoPrint = false } = {}) {
  const draft = plan.status !== 'final'
  const stamp = plan.status === 'final' && plan.finalised_at ? `Final, ${longDate(plan.finalised_at)}` : 'Draft'
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(plan.title)}</title>
<style>
  @page { size: A4 portrait; margin: 16mm 16mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111827; margin: 0; background: #fff; line-height: 1.5; font-size: 11pt; }
  .page { max-width: 760px; margin: 0 auto; padding: 32px 28px 48px; }
  .toolbar { position: sticky; top: 0; background: #f3f4f6; border-bottom: 1px solid #e5e7eb; padding: 8px 12px; text-align: right; font-family: system-ui, sans-serif; }
  .toolbar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #9ca3af; background: #fff; cursor: pointer; }
  header { border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 20pt; margin: 0 0 4px; line-height: 1.2; }
  .meta { font-family: system-ui, sans-serif; font-size: 9.5pt; color: #4b5563; }
  .stamp { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px; font-size: 8.5pt; border: 1px solid ${draft ? '#b45309' : '#047857'}; color: ${draft ? '#b45309' : '#047857'}; }
  h2 { font-size: 13pt; margin: 22px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d1d5db; break-after: avoid; }
  section { break-inside: auto; }
  p { margin: 0 0 8px; }
  ul { margin: 0 0 8px; padding-left: 20px; }
  li { margin: 0 0 4px; }
  mark { background: #fef3c7; }
  ul.goals { list-style: none; padding-left: 0; }
  li.goal { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 8px; break-inside: avoid; }
  li.goal .box { flex: none; width: 14px; height: 14px; margin-top: 4px; border: 1.5px solid #111827; border-radius: 3px; font: 10px/12px system-ui, sans-serif; text-align: center; }
  li.goal.done b { text-decoration: line-through; color: #6b7280; }
  .gd { font-family: system-ui, sans-serif; font-size: 9.5pt; color: #4b5563; }
  footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-family: system-ui, sans-serif; font-size: 8.5pt; color: #6b7280; }
  @media print { .toolbar { display: none; } .page { padding: 0; } }
</style></head>
<body>
<div class="toolbar"><button onclick="window.print()">Print or save as PDF</button></div>
<div class="page">
<header>
  <h1>${escapeHtml(plan.title)}</h1>
  <div class="meta">${escapeHtml(plan.swimmer_name || '')} &middot; ${escapeHtml(longDate(plan.period_from))} to ${escapeHtml(longDate(plan.period_to))}<span class="stamp">${escapeHtml(stamp)}</span></div>
</header>
${planBody(plan)}
<footer>Prepared by the coach${plan.status === 'final' && plan.finalised_at ? ` on ${escapeHtml(longDate(plan.finalised_at))}` : ''}.</footer>
</div>
${autoPrint ? '<script>window.addEventListener("load", () => window.print())</script>' : ''}
</body></html>`
}
