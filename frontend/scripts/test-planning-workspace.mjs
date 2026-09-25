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
assert.match(workspace, /hidden lg:flex/, 'Wide screens show chat beside the plan.')
assert.match(workspace, /lg:hidden/, 'Phones switch between chat and plan.')
assert.match(workspace, /<SeasonTimeline/, 'The workspace shows the timeline.')
assert.match(workspace, /<PathwayBoard/, 'The workspace shows the pathways.')
// The planning chat must reuse the season-plan thread, not start a rival history.
assert.match(workspace, /getOrCreateSeasonPlanThread/, 'Chat must reuse the season plan thread.')
assert.match(workspace, /dx_plan_handoff/, 'An agreed plan must ride the existing approval rail.')
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
