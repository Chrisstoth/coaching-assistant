// Connecting LaneWatch Hub, where the detailed race analysis lives.
//
// "Connect with LaneWatch": the coach is sent to hub.lanewatch.app/connect,
// signs in THERE (this app never sees a LaneWatch sign-in) and approves, and
// LaneWatch sends them back to /lanewatch/callback with a one-time code. Our
// server started the attempt and holds its PKCE verifier, so it alone can swap
// the code for a read-only key.
//
// The rules below are kept free of React so they can be tested.

export const CALLBACK_PATH = '/lanewatch/callback'

// Where LaneWatch sends the coach back to (registered with LaneWatch).
export function callbackAddress(origin) {
  return `${origin}${CALLBACK_PATH}`
}

// What LaneWatch put on the return address.
export function readCallback(search) {
  const params = new URLSearchParams(search || '')
  return {
    state: params.get('state') || '',
    code: params.get('code') || null,
    error: params.get('error') || null,
  }
}

// Which suggested pairings start ticked: only those matched on name AND date
// of birth. A name-only match waits for the coach to tick it.
export function defaultSelection(suggestions) {
  return Object.fromEntries((suggestions || []).map(s => [
    `${s.swimmer_id}:${s.lanewatch_swimmer_id}`, s.confidence === 'name and date of birth',
  ]))
}

// The pairs to save: ticked suggestions plus manual picks, never two for one
// swimmer on either side.
export function pairsToSave(suggestions, selected, manual) {
  const pairs = []
  const usedLocal = new Set()
  const usedRemote = new Set()
  const add = (swimmerId, remoteId) => {
    const local = Number(swimmerId)
    if (!local || !remoteId || usedLocal.has(local) || usedRemote.has(remoteId)) return
    usedLocal.add(local)
    usedRemote.add(remoteId)
    pairs.push({ swimmer_id: local, lanewatch_swimmer_id: remoteId })
  }
  for (const s of suggestions || []) {
    if (selected[`${s.swimmer_id}:${s.lanewatch_swimmer_id}`]) add(s.swimmer_id, s.lanewatch_swimmer_id)
  }
  for (const [remoteId, swimmerId] of Object.entries(manual || {})) add(swimmerId, remoteId)
  return pairs
}
