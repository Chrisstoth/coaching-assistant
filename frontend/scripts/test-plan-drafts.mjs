import assert from 'node:assert/strict'

const {
  draftFromResult, describeDraft, saveDraft, stashDraft, takeStashedDraft, DRAFT_KINDS,
} = await import('../src/planDrafts.js')

function fakeApi() {
  const calls = []
  let nextId = 100
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args])
    return typeof result === 'function' ? result(...args) : result
  }
  return {
    calls,
    createMacro: record('createMacro', () => ({ id: nextId++ })),
    createSeasonBlock: record('createSeasonBlock', () => ({ id: nextId++ })),
    updateMacro: record('updateMacro', {}),
    createMicrocycle: record('createMicrocycle', {}),
    createPlanningPathway: record('createPlanningPathway', () => ({ id: nextId++ })),
    setPlanningPathwayMembers: record('setPlanningPathwayMembers', {}),
  }
}

function fakeStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: k => map.delete(k),
  }
}

// --- recognising what the chat returned -----------------------------------
assert.equal(draftFromResult(null), null)
assert.equal(draftFromResult({}), null)
assert.equal(draftFromResult({ skill_result: { type: 'race_analysis', draft: {} } }), null,
  'A skill the workspace cannot review must be ignored, not mistaken for a draft.')
assert.equal(draftFromResult({ skill_result: { type: 'macro_plan', draft: null } }), null,
  'A clarifying question comes back with no draft and must not open an empty card.')
assert.deepEqual(
  draftFromResult({ skill_result: { type: 'season_macros', draft: { macros: [] } } }),
  { kind: 'season_macros', draft: { macros: [] } },
)
for (const kind of Object.keys(DRAFT_KINDS)) {
  assert.ok(draftFromResult({ skill_result: { type: kind, draft: {} } }), `${kind} must be reviewable.`)
}

// --- describing each kind for review ---------------------------------------
const yearView = describeDraft('season_macros', {
  name: '2026/27',
  macros: [
    { name: 'Autumn', date_from: '2026-09-01', date_to: '2026-11-30', weeks: 13, primary_meet: 'Regionals', focus: 'Base.' },
    { name: 'Winter', date_from: '2026-12-01', date_to: '2027-03-01', weeks: 13 },
  ],
  warnings: ['overlap'],
})
assert.equal(yearView.items.length, 2)
assert.match(yearView.items[0].detail, /target Regionals/)
assert.doesNotMatch(yearView.items[1].detail, /target/, 'A macro with no target meet must not claim one.')
assert.deepEqual(yearView.warnings, ['overlap'])

assert.match(describeDraft('macro_plan', { macro_id: 4, phases: [] }).saveLabel, /Add these blocks/,
  'A plan for an existing macro adds to it rather than creating one.')
assert.match(describeDraft('macro_plan', { phases: [] }).saveLabel, /Save this season plan/)

// --- saving the year: macros created in date order, none pre-filled --------
{
  const api = fakeApi()
  const result = await saveDraft('season_macros', {
    macros: [
      { name: 'A', date_from: '2026-09-01', date_to: '2026-11-30', primary_meet_id: 3, focus: 'Base' },
      { name: 'B', date_from: '2026-12-01', date_to: '2027-03-01', primary_meet_id: null },
    ],
  }, { api })
  const created = api.calls.filter(c => c[0] === 'createMacro')
  assert.equal(created.length, 2)
  assert.deepEqual(created.map(c => c[1].name), ['A', 'B'], 'Macro numbers are handed out in creation order.')
  assert.deepEqual(created[0][1].mesos, [], 'The year defines macrocycles only; their blocks come later.')
  assert.equal(created[0][1].primary_meet_id, 3)
  assert.equal(result.macroId, 100, 'Focus moves to the first macro just created.')
}

// --- planning inside one macro: blocks join it, no second macro appears -----
{
  const api = fakeApi()
  const macros = [{ id: 7, group_definitions: {} }]
  const result = await saveDraft('macro_plan', {
    macro_id: 7,
    group_definitions: { Senior: { description: 'x' } },
    phases: [
      { name: 'Base', phase_type: 'base', date_from: '2026-09-01', date_to: '2026-10-11', focus: 'Aerobic' },
      { name: 'Build', phase_type: 'build', date_from: '2026-10-12', date_to: '2026-11-08' },
    ],
  }, { api, macros })
  assert.equal(api.calls.filter(c => c[0] === 'createMacro').length, 0,
    'Planning an existing macro must never create another macro.')
  const blocks = api.calls.filter(c => c[0] === 'createSeasonBlock')
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every(c => c[1].macro_id === 7), 'Every block must belong to the macro that was asked about.')
  assert.equal(api.calls.filter(c => c[0] === 'updateMacro').length, 1, 'Missing group definitions are filled in.')
  assert.equal(result.macroId, 7)
}

// Groups the coach already defined are not overwritten by a fresh proposal.
{
  const api = fakeApi()
  await saveDraft('macro_plan', {
    macro_id: 7, group_definitions: { Senior: { description: 'new' } }, phases: [],
  }, { api, macros: [{ id: 7, group_definitions: { Senior: { description: 'mine' } } }] })
  assert.equal(api.calls.filter(c => c[0] === 'updateMacro').length, 0)
}

// Without a macro in the draft it still behaves as the original whole-season plan.
{
  const api = fakeApi()
  await saveDraft('macro_plan', {
    name: 'Season', date_from: '2026-09-01', date_to: '2027-07-31',
    phases: [{ name: 'Base', phase_type: 'base', date_from: '2026-09-01', date_to: '2026-10-11' }],
  }, { api })
  const created = api.calls.filter(c => c[0] === 'createMacro')
  assert.equal(created.length, 1)
  assert.equal(created[0][1].mesos.length, 1)
}

// --- a block lands in the macro that contains it, preferring the one in focus
{
  const api = fakeApi()
  const macros = [
    { id: 1, date_from: '2026-08-01', date_to: '2026-12-31', is_current: true },
    { id: 2, date_from: '2026-09-01', date_to: '2026-11-30' },
  ]
  await saveDraft('meso_plan', { name: 'Base', date_from: '2026-09-07', date_to: '2026-10-04' },
    { api, macros, macroId: 2 })
  assert.equal(api.calls.find(c => c[0] === 'createSeasonBlock')[1].macro_id, 2,
    'When two macros contain the dates, the one the coach is looking at wins.')
}

// --- weeks find their block ------------------------------------------------
{
  const api = fakeApi()
  const macros = [{ id: 5, mesos: [{ id: 9, macro_id: 5, squad: 'Silver 1', date_from: '2026-09-01', date_to: '2026-10-11' }] }]
  await saveDraft('micro_plan', { week_of: '2026-09-14', week_label: 'W3', sessions: [] }, { api, macros })
  const week = api.calls.find(c => c[0] === 'createMicrocycle')[1]
  assert.equal(week.block_id, 9)
  assert.equal(week.macro_id, 5)
}

// --- pathways --------------------------------------------------------------
{
  const api = fakeApi()
  await assert.rejects(
    saveDraft('pathway_plan', { pathways: [] }, { api, macroId: null }),
    /no macrocycle/i,
    'Pathways need a macrocycle to attach to and must say so rather than fail silently.',
  )
  await saveDraft('pathway_plan', {
    macro_id: 5,
    pathways: [{ name: 'Qualifiers', primary_meet_id: 3, fallback_meet_id: 4,
      swimmers: [{ swimmer_id: 12, qualification_status: 'qualified', reason: 'Has the time' }] }],
  }, { api })
  const members = api.calls.find(c => c[0] === 'setPlanningPathwayMembers')
  assert.equal(members[2][0].swimmer_id, 12)
  assert.equal(members[2][0].qualification_status, 'qualified')
}

// --- handing a draft between pages -----------------------------------------
{
  const storage = fakeStorage()
  stashDraft('pathway_plan', { pathways: [] }, storage)
  assert.deepEqual(takeStashedDraft(storage), { kind: 'pathway_plan', draft: { pathways: [] } })
  assert.equal(takeStashedDraft(storage), null, 'A draft is reviewed once, not re-offered on every visit.')
  storage.setItem('dx_plan_draft', JSON.stringify({ kind: 'nonsense', draft: {} }))
  assert.equal(takeStashedDraft(storage), null, 'An unrecognised stash is discarded.')
  storage.setItem('dx_plan_draft', '{not json')
  assert.equal(takeStashedDraft(storage), null, 'A corrupt stash must not throw.')
}

console.log('Plan draft checks passed')
