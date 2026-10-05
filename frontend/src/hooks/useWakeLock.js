import { useEffect } from 'react'

/**
 * Keep the screen on while `active` - a voice conversation should not stop
 * because the phone went to sleep mid-answer.
 *
 * The phone drops the lock whenever the app goes to the background, so it is
 * asked for again each time the app comes back. Phones without the Screen
 * Wake Lock API simply behave as before.
 */
export default function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return undefined
    let lock = null
    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      try {
        lock = await navigator.wakeLock.request('screen')
        if (cancelled) lock.release().catch(() => {})
      } catch {
        // Refused (low battery, or not allowed here); the screen sleeps as normal.
      }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') acquire() }

    acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      lock?.release().catch(() => {})
    }
  }, [active])
}
