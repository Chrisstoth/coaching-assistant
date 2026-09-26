import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const { buildPlanHtml, gapsToFill, includedSections, sectionHtml } = await import('../src/swimmerPlan.js')

const plan = {
  id: 7, title: 'Ruby Wheeler: athlete plan', swimmer_name: 'Ruby Wheeler', audience: 'performance',
  period_from: '2026-09-28', period_to: '2027-03-31', status: 'draft', finalised_at: null,
  sections: [
    { key: 'towards', title: "What we're working towards", content: 'Para Nationals in March.\n- 100 Free under 1:03\n- Final at <County>', included: true },
    { key: 'review', title: 'Reviewing progress', content: 'After each block.', included: false },
    { key: 'how', title: 'How we plan to do it', content: 'Three blocks. [to add: typical week]', included: true },
    { key: 'coach_note', title: "Coach's note", content: '   ', included: true },
  ],
}

// --- what goes in: switched on and written -----------------------------------
assert.deepEqual(includedSections(plan).map(s => s.key), ['towards', 'how'],
  'Switched-off and empty sections are left out.')
assert.deepEqual(gapsToFill(plan), [{ section: 'How we plan to do it', what: 'typical week' }])

// --- formatting: paragraphs and bullets, nothing the drafter could inject -----
assert.equal(sectionHtml('One.\n- a\n- b\n\nTwo.'), '<p>One.</p><ul><li>a</li><li>b</li></ul><p>Two.</p>')
assert.match(sectionHtml('<script>x</script>'), /&lt;script&gt;/, 'Text is escaped, never run.')

const html = buildPlanHtml(plan)
assert.match(html, /<h1>Ruby Wheeler: athlete plan<\/h1>/)
assert.match(html, /28 September 2026 to 31 March 2027/)
assert.match(html, /class="stamp">Draft</, 'A draft says so on the page.')
assert.match(html, /Final at &lt;County&gt;/)
assert.match(html, /<mark>\[to add: typical week\]<\/mark>/, 'Gaps stand out on a draft.')
assert.doesNotMatch(html, /Reviewing progress/)
assert.match(html, /@page \{ size: A4 portrait/)

const final = buildPlanHtml({ ...plan, status: 'final', finalised_at: '2026-10-02T09:00:00Z' })
assert.match(final, /class="stamp">Final, 2 October 2026</)

// --- wiring --------------------------------------------------------------------
const api = await read('../src/api.js')
for (const method of ['getSwimmerPlans', 'createSwimmerPlan', 'updateSwimmerPlan', 'redraftPlanSection',
  'finaliseSwimmerPlan', 'copySwimmerPlan']) {
  assert.match(api, new RegExp(`${method}:`), `api.${method} must exist.`)
}
const detail = await read('../src/pages/SwimmerDetail.jsx')
assert.match(detail, /'Plan'/, 'The swimmer page has a Plan tab.')
assert.match(detail, /para_class/, 'Para classes are edited on the swimmer.')
const app = await read('../src/App.jsx')
assert.match(app, /\/swimmer-plans\/:planId\/print/)
const panel = await read('../src/components/SwimmerPlanPanel.jsx')
assert.match(panel, /Mark final/)
assert.match(panel, /Make a new version/, 'A final plan is changed by starting a new version.')

console.log('Swimmer plan checks passed')
