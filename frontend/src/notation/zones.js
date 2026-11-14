/* Training zones: how much of a session falls in each kind of work.

   The builder's intensity is one number on the common scale (Effort /20,
   6–21). The staff and the load counter think in zones (aerobic, threshold,
   VO2 …), so each set's metres and time are shared out into zones here, in
   code, rather than estimated by the AI.

   The default bands follow Sweetenham's (British Swimming) zones on the
   common scale. They are a starting point: a club can replace them.

   Rules:
   - one intensity ([16]) puts the whole set in that zone
   - a mix or a build ([14-16], [12->18]) shares the set equally between the
     values given
   - a set with "kick" in its description counts as kicking, whatever its
     intensity, because the load counter tracks kick separately
   - a set with no intensity counts as "unspecified", never guessed
   Mirrored in backend/services/session_notation.py.
*/
import { nodeStats, parseEffort, appliesTo, sessionGroups } from './core.js'

export const DEFAULT_ZONE_BANDS = [
  { zone: 'recovery', below: 9.5 },
  { zone: 'aerobic', below: 16.5 },    // A1–A3
  { zone: 'threshold', below: 17.5 },  // AT
  { zone: 'vo2', below: 18.5 },        // MVO2
  { zone: 'lact_tol', below: 19.25 },  // LT
  { zone: 'race_pace', below: 20.5 },  // LP
  { zone: 'sprint', below: Infinity }, // Speed / HVO
]

export const ZONE_KEYS = ['recovery', 'aerobic', 'threshold', 'vo2', 'lact_tol', 'race_pace', 'sprint', 'kicking', 'unspecified']

const KICK = /\bkick/i

export function zoneOfValue(v, bands = DEFAULT_ZONE_BANDS){
  for (const b of bands) if (v < b.below) return b.zone
  return bands[bands.length - 1].zone
}

function emptyZones(){
  const o = {}
  ZONE_KEYS.forEach(k => { o[k] = { dist: 0, time: 0 } })
  return o
}

function addLine(acc, n, k, bands){
  // the coach talking isn't training: it has no zone
  if (n.talk != null) return
  const st = nodeStats(n)
  const dist = st.dist * k, time = st.time * k
  if (!dist && !time) return
  if (KICK.test(String(n.desc || ''))) { acc.kicking.dist += dist; acc.kicking.time += time; return }
  const e = parseEffort(n.eff)
  if (!e) { acc.unspecified.dist += dist; acc.unspecified.time += time; return }
  const nums = (String(n.eff).match(/\d+(?:\.\d+)?/g) || []).map(Number)
  const share = 1 / nums.length
  nums.forEach(v => { const z = zoneOfValue(v, bands); acc[z].dist += dist * share; acc[z].time += time * share })
}

function walkItems(acc, items, k, bands){
  for (const n of items || []) {
    if (n.t === 'round') walkItems(acc, n.items, k * (n.times || 0), bands)
    else addLine(acc, n, k, bands)
  }
}

// Zones for a list of items (a block, or a round's contents).
export function itemZones(items, bands = DEFAULT_ZONE_BANDS){
  const acc = emptyZones()
  walkItems(acc, items, 1, bands)
  return acc
}

// Zones for each group in a session: the shared blocks plus the group's own.
export function sessionZones(s, bands = DEFAULT_ZONE_BANDS){
  return sessionGroups(s).map(({ id: gid, name: g }) => {
    const acc = emptyZones()
    for (const b of s.blocks || []) if (b.kind !== 'notes' && appliesTo(b, gid)) walkItems(acc, b.items, 1, bands)
    return { g, gid, zones: acc }
  })
}
