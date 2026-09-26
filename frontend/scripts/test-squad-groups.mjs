import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')
const {
  todayIso, currentGroupOf, everyone, nextMoveLabel, moveSummary, movePayload, reorder, groupNow, groupLine,
} = await import('../src/squadGroups.js')
const { cellMarks } = await import('../src/seasonGrid.js')
const { aimLabels, pathwayTag } = await import('../src/squadGroups.js')
const { membersPayload, memberLabel, memberEnded, withoutPathway } = await import('../src/pathwayMembers.js')
const { looksLikeSetNumber } = await import('../src/squadGroups.js')

const TODAY = '2026-09-26'
const data = {
  groups: [
    { id: 1, name: 'Senior', swimmers: [{ id: 7, name: 'Leo Park', since: '2026-09-07', next: null }] },
    { id: 2, name: 'Development', swimmers: [
      { id: 8, name: 'Ruby Wheeler', since: '2026-09-07', next: { group_id: 1, group_name: 'Senior', date_from: '2026-11-02' } },
    ] },
  ],
  ungrouped: [{ id: 9, name: 'Amy Stone', since: null, next: null }],
}

// --- reading the page's data ----------------------------------------------
assert.equal(todayIso(new Date(2026, 8, 26, 23, 30)), TODAY, 'Late evening is still today, locally.')
assert.equal(currentGroupOf(data, 8).name, 'Development')
assert.equal(currentGroupOf(data, 9), null)
assert.deepEqual(everyone(data).map(s => s.id), [7, 8, 9])
assert.equal(nextMoveLabel(data.groups[1].swimmers[0]), '→ Senior from 2 Nov')
assert.equal(nextMoveLabel(data.groups[0].swimmers[0]), '')

// --- a move says what it will do before it is saved -----------------------
assert.equal(
  moveSummary({ names: ['Ruby Wheeler'], fromName: 'Development', toName: 'Senior', dateFrom: '2026-11-02', today: TODAY }),
  'Ruby Wheeler moves into Senior from 2 Nov. Until then they stay in Development.')
assert.equal(
  moveSummary({ names: ['Amy Stone', 'Leo Park'], fromName: null, toName: 'Senior', dateFrom: TODAY, today: TODAY }),
  '2 swimmers move into Senior from today.')
assert.match(
  moveSummary({ names: ['Leo Park'], fromName: 'Senior', toName: null, dateFrom: '2026-09-14', today: TODAY }),
  /out of their group from 14 Sept?\. Weeks from 14 Sept? are counted as no group\./)
assert.deepEqual(movePayload(new Set([8]), undefined, '', '  '),
  { swimmer_ids: [8], group_id: null, date_from: null, note: null })

// --- running order ----------------------------------------------------------
assert.deepEqual(reorder(data.groups, 1, -1), [2, 1])
assert.deepEqual(reorder(data.groups, 0, -1), [1, 2], 'The first group cannot go higher.')

// --- a swimmer's own page -------------------------------------------------
const history = [
  { group_name: 'Development', date_from: '2026-09-07', date_to: '2026-11-01' },
  { group_name: 'Senior', date_from: '2026-11-02', date_to: null },
]
assert.equal(groupNow(history, TODAY).current.group_name, 'Development')
assert.equal(groupLine(history, TODAY), 'Development since 7 Sept · → Senior from 2 Nov'.replace('Sept', new Date('2026-09-07T00:00:00').toLocaleDateString('en-GB', { month: 'short' })))
assert.equal(groupLine([], TODAY), 'Not in a training group')

// --- the grid marks a move --------------------------------------------------
assert.deepEqual(cellMarks({ moves: ['Moves to Senior'] }).map(m => [m.symbol, m.label]), [['⇄', 'Moves to Senior']])

// --- block aims are written for the squad's real groups ---------------------
assert.deepEqual(aimLabels(['Senior', 'Development'], { G1: 'Old aim', G2: '' }), ['Senior', 'Development', 'G1'],
  'An aim already written under an old label is kept.')
assert.deepEqual(aimLabels([], {}), ['G1', 'G2', 'G3'])

// --- pathways: what each swimmer aims at, and from when ----------------------
assert.equal(pathwayTag({ name: 'Regional', next: { name: 'Winter Nationals', date_from: '2026-10-05' } }),
  'Regional → Winter Nationals from 5 Oct')
const existing = [{ swimmer_id: 1, swimmer: 'Ella Moss', date_from: '2026-09-07', date_to: '2026-10-04',
  qualification_status: 'close', notes: null, active: true }]
assert.deepEqual(membersPayload(existing, new Set([1, 2]), '2026-10-05'), [
  { swimmer_id: 1, date_from: '2026-09-07', date_to: '2026-10-04', qualification_status: 'close', notes: null, active: true },
  { swimmer_id: 2, date_from: '2026-10-05', date_to: null, qualification_status: 'unknown', notes: null, active: true },
], 'Saving keeps the dates already recorded; only a new swimmer takes the join date.')
assert.match(memberLabel({ swimmer: 'Nia Hart', date_from: '2026-10-05' }, TODAY), /^Nia Hart from 5 Oct$/)
assert.equal(memberEnded(existing[0], TODAY), false)
assert.equal(memberEnded(existing[0], '2026-10-10'), true)

// --- every swimmer has a pathway each macrocycle -----------------------------
const squad = [{ id: 1, name: 'Ella Moss', active: true, status: 'active' }, { id: 2, name: 'Nia Hart', active: true, status: 'active' },
  { id: 3, name: 'Isla Reed', active: true, status: 'injury' }]
assert.deepEqual(withoutPathway(squad, [{ members: existing }], '2026-09-20').map(s => s.name), ['Nia Hart'])
assert.deepEqual(withoutPathway(squad, [{ members: existing }], '2026-10-10').map(s => s.name), ['Ella Moss', 'Nia Hart'],
  'Someone whose pathway has ended needs a new one.')

// --- register sets are numbered; training groups get names -------------------
assert.equal(looksLikeSetNumber('Group 1'), true)
assert.equal(looksLikeSetNumber('G2'), true)
assert.equal(looksLikeSetNumber('Girls'), false)

// --- wiring -------------------------------------------------------------------
const api = await read('../src/api.js')
assert.match(api, /moveToGroup: \(data\) => request\('POST', '\/groups\/move', data\)/)
assert.match(api, /getGroupHistory: \(swimmerId\) => request\('GET', `\/groups\/history\/\$\{swimmerId\}`\)/)
const swimmers = await read('../src/pages/Swimmers.jsx')
assert.match(swimmers, /<SquadGroups \/>/, 'Groups live on the Swimmers page.')
assert.match(swimmers, /\['groups', 'Groups'\]/)
const groups = await read('../src/components/SquadGroups.jsx')
assert.match(groups, /roles: \['manager'\]/, 'The Swimmer Manager reviews the groups.')
assert.match(groups, /type="date"/, 'Every move has a date.')
assert.match(groups, /z-\[60\]/, 'The move panel sits above the bottom menu.')
assert.match(groups, /Tap swimmers below to add them to this group\./, 'Making a group, a tap adds the swimmer.')
assert.match(groups, /Save and add \$\{picked\}/)
assert.match(groups, /There are no groups to move them into yet/)
const grid = await read('../src/components/SeasonGrid.jsx')
assert.match(grid, /\/swimmers\?view=groups/, 'The grid leads to where groups are edited.')
const detail = await read('../src/pages/SwimmerDetail.jsx')
assert.match(detail, /groupLine\(groupHistory/)

const board = await read('../src/components/PathwayBoard.jsx')
assert.match(board, /membersPayload\(pathway\.members, chosen, joinFrom\)/, 'Pathway members are saved with their dates.')
assert.match(board, /Working towards/, 'A pathway holds the goals cohorts used to.')
assert.match(board, /Add a group:/, 'A whole training group can join a pathway at once.')
assert.match(board, /Not on a pathway yet/)
const season = await read('../src/pages/SeasonPlan.jsx')
assert.match(season, /aimLabels\(groupNames, form\.group_intents\)/)
assert.doesNotMatch(season, /\['G1', 'G2', 'G3'\]\.map/)
for (const page of ['../src/pages/Swimmers.jsx', '../src/pages/PlanHub.jsx']) {
  assert.doesNotMatch(await read(page), /[Cc]ohort/, `${page} no longer offers cohorts - pathways do that job.`)
}

console.log('Squad group checks passed')
