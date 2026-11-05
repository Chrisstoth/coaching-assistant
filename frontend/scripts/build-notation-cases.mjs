// Builds shared/notation/cases.json: the reference answers for the session
// notation, produced by src/notation (the Session Builder's own logic).
// Both the frontend and the backend (Python) are tested against this file.
//
//   node scripts/build-notation-cases.mjs
//
// Only regenerate when the notation is meant to change, then make the Python
// twin (backend/services/session_notation.py) match.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as N from '../src/notation/core.js'
import { sessionZones, itemZones, DEFAULT_ZONE_BANDS } from '../src/notation/zones.js'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '..', 'shared', 'notation')

export function buildCases(){
  const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'))
  const clean = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'id' ? undefined : v)))
  N.setEffSys('effort20')

  const lines = inputs.lines.map(s => {
    const nodes = N.parseLineNodes(s)
    return { in: s, nodes: clean(nodes), text: N.itemsToText(nodes), stats: N.statsOf(nodes), zones: itemZones(nodes) }
  })

  const descs = inputs.descs.map(d => {
    const line = N.newLine({ reps: 4, dist: 100, desc: d, int: 100 })
    return {
      in: d,
      parts: N.descParts(d, 1, true), parts2: N.descParts(d), plain: N.plainDesc(d),
      timings: clean(N.partTimings(line)), stats: N.nodeStats(line), note: N.isNoteLine(N.newLine({ desc: d })),
      parsed: clean(N.parseLineNodes('4x100 ' + d)),
    }
  })

  const texts = inputs.texts.map(t => {
    const nodes = N.parseText(t)
    return { in: t, nodes: clean(nodes), text: N.itemsToText(nodes), stats: N.statsOf(nodes) }
  })

  const parts = inputs.parts.map(([first, ...rest]) => {
    const line = N.parseLineNodes(first)[0]
    rest.forEach(p => N.addPart(line, p))
    return { in: [first, ...rest], line: clean(line), stats: N.nodeStats(line), text: N.lineText(line) }
  })

  const dictation = inputs.dictation.map(([raw, speech]) => ({ in: raw, speech, out: N.normalizeDictation(raw, speech), spoken: N.looksSpoken(raw) }))

  const effort = {
    toCanon: inputs.effort.toCanon.map(([t, sys]) => ({ in: t, sys, out: N.effToCanon(t, sys) })),
    fromCanon: inputs.effort.fromCanon.map(([t, sys]) => ({ in: t, sys, out: N.effFromCanon(t, sys) })),
    parse: [...inputs.effort.toCanon.map(([t, sys]) => N.effToCanon(t, sys))].map(c => ({ in: c, out: N.parseEffort(c) })),
  }

  const times = inputs.times.map(t => ({ in: t, parse: N.parseTime(t), cell: N.parseTimingCell(t), fmt: N.fmtTime(N.parseTime(t)), extract: N.extractTiming(t) }))

  const sessions = readdirSync(join(dir, 'sessions')).filter(f => f.endsWith('.json')).sort().map(f => {
    const { id, session } = JSON.parse(readFileSync(join(dir, 'sessions', f), 'utf8'))
    const s = N.normalizeSession(JSON.parse(JSON.stringify(session)))
    const gname = gid => (gid == null ? null : N.groupName(s, gid))
    const starts = N.blockStarts(s)
    const text = {}
    for (const sys of ['effort20', 'bpsc', 'sweetenham']) { N.setEffSys(sys); text[sys] = N.sessionText(s) }
    N.setEffSys('effort20')
    return {
      id,
      title: N.displayTitle(s),
      slot: N.slotSeconds(s),
      groups: (s.groups || []).map(g => g.name),
      blocks: s.blocks.map(b => ({ name: b.name, groups: (b.groups || []).map(gname), stats: N.statsOf(b.items), starts: starts.get(b.id) || null })),
      totals: N.totalsFor(s).map(t => ({ ...t, gid: gname(t.gid) })),
      zones: sessionZones(s).map(z => ({ ...z, gid: gname(z.gid) })),
      perGroup: (s.groups || []).map(g => ({ group: g.name, blocks: N.sessionForGroup(s, g.id).blocks.map(b => b.name) })),
      text,
    }
  })

  const scales = { systems: N.EFF_SYSTEMS, order: N.EFF_ORDER, bands: DEFAULT_ZONE_BANDS.map(b => ({ zone: b.zone, below: Number.isFinite(b.below) ? b.below : null })) }

  return { scales, lines, descs, texts, parts, dictation, effort, times, sessions }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cases = buildCases()
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases, null, 1) + '\n')
  const count = v => (Array.isArray(v) ? v.length : 0)
  const n = ['lines', 'descs', 'texts', 'parts', 'dictation', 'times', 'sessions'].reduce((a, k) => a + count(cases[k]), 0)
    + Object.values(cases.effort).reduce((a, v) => a + v.length, 0)
  console.log(`Wrote ${n} notation cases to shared/notation/cases.json`)
}
