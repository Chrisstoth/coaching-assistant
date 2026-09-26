import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')

const app = await read('../src/App.jsx')
assert.match(app, /path="\/planning"/, 'The planning workspace needs a route.')
assert.match(app, /import PlanningWorkspace from '\.\/pages\/PlanningWorkspace'/)

const hub = await read('../src/pages/PlanHub.jsx')
assert.match(hub, /to="\/planning"/, 'Plan hub must lead to the planning workspace.')

const workspace = await read('../src/pages/PlanningWorkspace.jsx')
// The conversation and the picture must sit together on a wide screen, and the
// phone falls back to one at a time rather than cramming both in.
assert.match(workspace, /useIsWide/, 'Wide screens show chat beside the plan.')
assert.match(workspace, /\{!wide && \(/, 'Narrow screens switch between chat and plan.')
assert.match(workspace, /el\.clientWidth >= WIDE_PX/, 'Wide means the page has room, not the browser window.')
assert.match(workspace, /100dvh - 8rem - env\(safe-area-inset-bottom/, 'The chat box sits above the bottom menu.')
assert.doesNotMatch(workspace, /h-screen/, 'A full-screen page would run under the bottom menu.')
// Both layouts mounted at once would run two chat panels racing to open one thread.
assert.doesNotMatch(workspace, /hidden lg:flex/, 'Only the layout that applies may be mounted.')
assert.match(workspace, /<SeasonTimeline/, 'The workspace shows the timeline.')
assert.match(workspace, /<PathwayBoard/, 'The workspace shows the pathways.')
// The planning chat must reuse the season-plan thread, not start a rival history.
assert.match(workspace, /getOrCreateSeasonPlanThread\(\)/, 'One planning conversation covers the whole year.')
assert.match(workspace, /saveDraft/, 'Every proposal is approved in place before anything is written.')
assert.match(workspace, /takeStashedDraft/, 'A draft made on the AI page must arrive here for review.')
assert.match(workspace, /macro \? macro\.id : null/, 'The macrocycle in focus must travel with every message.')
assert.match(workspace, /selectedMacroId=\{macroId\}/, 'The timeline must show which macrocycle is in focus.')
assert.match(workspace, /onPlanChanged/, 'The picture must refresh when the conversation changes the plan.')

const board = await read('../src/components/PathwayBoard.jsx')
// The branching the coach described: a target meet, and somewhere else to go
// when the qualifying time does not come.
assert.match(board, /primary_meet_id/, 'A pathway must be assignable to a target meet.')
assert.match(board, /fallback_meet_id/, 'A pathway must carry a fallback meet.')
assert.match(board, /setPlanningPathwayMembers/, 'Swimmers must be assignable to a pathway.')
assert.match(board, /qualification_status/, 'Qualification status must be visible per swimmer.')

const api = await read('../src/api.js')
for (const method of [
  'getSeasonTimeline', 'putSeasonLoadProfile', 'putSeasonLoadWeek', 'getSeasonLoadEdits',
  'getPlanningPathways', 'createPlanningPathway', 'updatePlanningPathway', 'setPlanningPathwayMembers',
]) {
  assert.match(api, new RegExp(`${method}:`), `api.${method} must exist.`)
}

console.log('Planning workspace checks passed')

// --- export: the plan leaves the app as a spreadsheet to share ---------------
{
  const apiSource = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')
  assert.match(apiSource, /\/season\/export/, 'The export comes from the season export endpoint.')
  assert.match(apiSource, /content-disposition/, 'The file keeps the name the server gives it.')
  for (const page of ['PlanningWorkspace', 'SeasonPlan']) {
    const source = await readFile(new URL(`../src/pages/${page}.jsx`, import.meta.url), 'utf8')
    assert.match(source, /<ExportPlanButton/, `${page} offers the export.`)
  }
  console.log('Plan export checks passed')
}

// --- getting started: nobody faces a blank page --------------------------------
{
  const start = await import('../src/planningStart.js')
  assert.equal(start.planningStage([], null), 'outline')
  assert.equal(start.planningStage([{ id: 1, mesos: [] }], { id: 1, mesos: [] }), 'blocks')
  assert.equal(start.planningStage([{ id: 1 }], { id: 1, mesos: [{ id: 3 }] }), 'weeks')

  const meets = [
    { id: 1, name: 'Club Gala', date: '2026-10-10', level: 'club' },
    { id: 2, name: 'County Championships', date: '2027-02-06' },
    { id: 3, name: 'Regional Qualifier', date: '2026-12-05', level: 'regional' },
    { id: 4, name: 'Old meet', date: '2026-01-01' },
  ]
  const win = start.defaultSeasonWindow(new Date('2026-09-30T12:00:00'), meets)
  assert.deepEqual(win, { from: '2026-09-28', to: '2027-02-06' }, 'This week to the last meet ahead.')
  const empty = start.defaultSeasonWindow(new Date('2026-09-30T12:00:00'), [])
  assert.equal(empty.to, '2027-08-02', 'With no meets, a 44-week season.')

  const listed = start.seasonMeets(meets, win.from, win.to)
  assert.deepEqual(listed.map(m => m.id), [1, 3, 2], 'Meets in the season, in date order.')
  assert.deepEqual(listed.map(m => m.suggested), [false, true, true], 'Championship meets are suggested targets.')

  const schedule = start.weeklySchedule([
    { day_of_week: 2, time: '18:00', squad: 'Silver' },
    { day_of_week: 0, time: '06:00', squad: 'Silver' },
    { day_of_week: 0, time: '17:00', squad: 'Gold' },
    { day_of_week: 4, time: '06:00', squad: 'Silver', active: false },
  ], 'Silver')
  assert.deepEqual(schedule, { count: 2, label: 'Mon 06:00, Wed 18:00' })

  const request = start.outlineRequest({ from: win.from, to: win.to, squad: 'Silver',
    targets: [listed[1]], schedule })
  assert.match(request, /^Divide the season from 28 Sept 2026 to 6 Feb 2027 into macrocycles for Silver\./)
  assert.match(request, /target meets: Regional Qualifier \(5 Dec 2026\)/)
  assert.match(request, /We train 2 sessions a week\./)
  assert.match(start.outlineRequest({ from: win.from, to: win.to, targets: [] }), /suggest which meets/)

  assert.equal(start.nextStep('blocks', { name: 'Autumn' }).label, 'Plan Autumn')
  assert.match(start.nextStep('weeks', { name: 'Autumn' }).text, /next week/)
  assert.equal(start.nextStep('outline', null), null)

  const workspaceSource = await readFile(new URL('../src/pages/PlanningWorkspace.jsx', import.meta.url), 'utf8')
  assert.match(workspaceSource, /<SeasonStarter onAsk=\{ask\}/, 'An empty plan opens on the season set-up.')
  assert.match(workspaceSource, /<NextStepCard/, 'Once there is an outline, the next step is always shown.')
  const hub = await readFile(new URL('../src/pages/PlanHub.jsx', import.meta.url), 'utf8')
  assert.equal((hub.match(/to="\/planning"/g) || []).length, 1, 'One way in to season planning.')
  console.log('Planning start checks passed')
}
