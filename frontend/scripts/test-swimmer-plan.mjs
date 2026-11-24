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

// --- goals: the same list as the swimmer's page and the planner, printed in place ---
const withGoals = buildPlanHtml({ ...plan, goals: [
  { id: 1, label: 'Sub 28.0 in 50 Fly', race: '50 Fly in 27.99 SC', meet_name: 'County Champs', meet_date: '2027-01-16',
    status: 'PB 28.40 · 0.41s (1.5%) to find', achieved: false },
  { id: 2, label: '10m underwater <every wall>', race: '', achieved: true, status: 'Achieved' },
] })
assert.match(withGoals, /<h2>Goals<\/h2>/, 'The goals print on the plan.')
assert.ok(withGoals.indexOf('<h2>Goals</h2>') < withGoals.indexOf("What we're working towards"),
  'The goals come just before what we are working towards.')
assert.match(withGoals, /50 Fly in 27.99 SC · by County Champs \(16 Jan 2027\) · PB 28.40/)
assert.match(withGoals, /class="goal done"><span class="box">&#10003;/, 'An achieved goal is ticked.')
assert.match(withGoals, /&lt;every wall&gt;/, 'Goal words are escaped.')
assert.doesNotMatch(html, /<h2>Goals<\/h2>/, 'No goals, no Goals heading.')
const offTowards = buildPlanHtml({ ...plan, sections: plan.sections.map(s => s.key === 'towards' ? { ...s, included: false } : s),
  goals: [{ id: 3, label: 'Make the final' }] })
assert.match(offTowards, /<h2>Goals<\/h2>/, 'The goals print even with that section switched off.')
assert.match(panel, /GoalsCard/, 'A draft plan edits the goals in place.')
for (const method of ['getGoals', 'createGoal', 'updateGoal', 'deleteGoal']) {
  assert.match(api, new RegExp(`${method}:`), `api.${method} must exist.`)
}
assert.match(detail, /<GoalsCard/, "The swimmer's page has the goals.")

console.log('Swimmer plan checks passed')
