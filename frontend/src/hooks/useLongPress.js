import { useRef } from 'react'

export default function useLongPress(onLongPress, onTap, delay = 500) {
  const timer = useRef(null)
  const fired = useRef(false)

  const start = () => {
    fired.current = false
    timer.current = setTimeout(() => {
      fired.current = true
      onLongPress()
    }, delay)
  }

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
  }

  const end = () => {
    cancel()
    if (!fired.current) onTap()
  }

  return {
    onTouchStart: start,
    onTouchEnd: end,
    onTouchMove: cancel,
    onMouseDown: start,
    onMouseUp: end,
    onMouseLeave: cancel,
  }
}
