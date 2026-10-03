import { useEffect, useState } from 'react'

// The app keeps a copy of itself on the phone so it opens instantly and works
// at a poolside with no signal. When a new version is published, that copy is
// replaced in the background, but the screen already open is still the old
// one. This says so, and reloads into the new version on a tap - never by
// itself, so nothing half-typed is lost.
//
// A phone can keep the app open for days, so it also checks for a new version
// whenever the app comes back to the foreground.
export default function UpdateBanner() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    // The first install also changes controller; only a replacement is an update.
    const hadVersion = Boolean(navigator.serviceWorker.controller)
    const onChange = () => { if (hadVersion) setReady(true) }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      navigator.serviceWorker.getRegistration().then(reg => reg?.update()).catch(() => {})
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!ready) return null
  return (
    <div className="fixed top-2 inset-x-2 z-[100] max-w-lg mx-auto flex items-center gap-3 bg-accent-700 text-white rounded-xl px-4 py-2.5 shadow-lg">
      <p className="text-xs flex-1">A new version of LaneWatch is ready.</p>
      <button type="button" onClick={() => window.location.reload()}
        className="text-xs font-semibold bg-white/20 rounded-lg px-3 py-1.5">
        Update
      </button>
    </div>
  )
}
