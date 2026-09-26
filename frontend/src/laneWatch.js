// Connecting LaneWatch Hub, where the detailed race analysis lives.
//
// The coach signs in to LaneWatch in a popup, with whichever sign-in they use
// there. The resulting token is handed to our server once, which swaps it for
// a read-only LaneWatch key; the sign-in itself is thrown away straight after
// and nothing of it is kept in this browser.
//
// The pairing rules below are kept free of React so they can be tested.

// Firebase is only loaded when the coach actually connects.
export async function signInToLaneWatch(config, method, { email, password } = {}) {
  const [{ initializeApp, deleteApp }, auth] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
  ])
  const app = initializeApp(config, `lanewatch-connect-${Date.now()}`)
  try {
    const session = auth.getAuth(app)
    await auth.setPersistence(session, auth.inMemoryPersistence)
    let credential
    if (method === 'google') {
      credential = await auth.signInWithPopup(session, new auth.GoogleAuthProvider())
    } else if (method === 'apple') {
      credential = await auth.signInWithPopup(session, new auth.OAuthProvider('apple.com'))
    } else {
      credential = await auth.signInWithEmailAndPassword(session, email, password)
    }
    const token = await credential.user.getIdToken()
    await auth.signOut(session)
    return token
  } finally {
    await deleteApp(app)
  }
}

const SIGN_IN_ERRORS = {
  'auth/popup-closed-by-user': 'Sign-in was closed before it finished.',
  'auth/cancelled-popup-request': 'Sign-in was closed before it finished.',
  'auth/popup-blocked': 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.',
  'auth/unauthorized-domain':
    "LaneWatch doesn't recognise this site yet. Add this site's address to the authorised domains in LaneWatch's Firebase settings.",
  'auth/invalid-credential': 'That email and password did not match a LaneWatch account.',
  'auth/wrong-password': 'That email and password did not match a LaneWatch account.',
  'auth/user-not-found': 'That email and password did not match a LaneWatch account.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'Could not reach LaneWatch. Check the connection and try again.',
}

export function signInErrorMessage(error) {
  if (!error) return ''
  return SIGN_IN_ERRORS[error.code] || error.message || 'Sign-in did not work.'
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
