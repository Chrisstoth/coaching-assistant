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
  const end = lines.findIndex(l => l.startsWith('/* ---------- intensity notation'))
  const body = lines.slice(start, end).join('\n') + '\n' + lines.find(l => l.startsWith('const planned='))
  return new Function('document', body + '\nreturn { S, TL, inval };')({ createElementNS(){ return {} } })
}

export function buildCases(){
  const M = plannerModel()
  M.S.plan = JSON.parse(readFileSync(join(dir, 'sample-plan.json'), 'utf8'))
  M.S.roster = JSON.parse(readFileSync(join(dir, 'sample-roster.json'), 'utf8'))
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
}
