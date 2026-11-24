// Builds shared/planner/cases.json: every week of every group and swimmer in the
// made-up sample plan, worked out by the Season Planner's own code. The Python
// twin (backend/services/season_planner.py) is tested against it.
//
//   node scripts/build-planner-cases.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '..', 'shared', 'planner')

export function plannerModel(){
  const lines = readFileSync(join(here, '..', 'src', 'planner', 'plannerApp.js'), 'utf8').split('\n')
  const start = lines.findIndex(l => l.startsWith('const DAY=864e5'))
  const end = lines.findIndex(l => l.startsWith('/* ---------- intensity'))
  const body = lines.slice(start, end).join('\n') + '\n' + lines.find(l => l.startsWith('const planned='))
  return new Function('document', body + '\nreturn { S, TL, inval };')({ createElementNS(){ return {} } })
}

// The sample plan with a short-term group added (shared/planner/short-group.json).
export function withShortGroup(plan, roster){
  const extra = JSON.parse(readFileSync(join(dir, 'short-group.json'), 'utf8'))
  plan.branches.push(extra.branch)
  roster.swimmers.push(...extra.swimmers)
  return { plan, roster }
}

// Micros of uneven lengths (8, 8, 6, 4, 16 days, then the rest of the season), so a session comes round twice.
export const MICROS = ['2026-09-01', '2026-09-09', '2026-09-15', '2026-09-19', '2026-10-05']

export function buildCases(short = false, micros = null){
  const M = plannerModel()
  M.S.plan = JSON.parse(readFileSync(join(dir, 'sample-plan.json'), 'utf8'))
  M.S.roster = JSON.parse(readFileSync(join(dir, 'sample-roster.json'), 'utf8'))
  if (short) withShortGroup(M.S.plan, M.S.roster)
  if (micros) M.S.plan.settings.micros = micros
  M.inval()
  const out = {}
  const ids = M.S.plan.branches.map(b => b.id).concat(M.S.roster.swimmers.filter(s => s.branch).map(s => 'sw:' + s.id))
  for (const id of ids) out[id] = M.TL(id).map(w => ({ i: w.i, p: w.p, code: w.code, load: w.load, comps: w.c, camp: w.camp, group: w.g ?? null, away: !!w.away }))
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cases = buildCases()
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases, null, 1) + '\n')
  console.log(`Wrote ${Object.keys(cases).length} planner timelines to shared/planner/cases.json`)
  const short = buildCases(true)
  writeFileSync(join(dir, 'cases-short-group.json'), JSON.stringify(short, null, 1) + '\n')
  console.log(`Wrote ${Object.keys(short).length} planner timelines to shared/planner/cases-short-group.json`)
  const micro = buildCases(false, MICROS)
  writeFileSync(join(dir, 'cases-micros.json'), JSON.stringify(micro, null, 1) + '\n')
  console.log(`Wrote ${Object.keys(micro).length} planner timelines to shared/planner/cases-micros.json`)
}
