import { useRef } from 'react'

export default function useLongPress(onLongPress, onTap, delay = 500) {
  const timer = useRef(null)
  const fired = useRef(false)
  const moved = useRef(false)
  const startX = useRef(0)
  const startY = useRef(0)

  const start = (e) => {
    fired.current = false
    moved.current = false
    if (e?.touches) {
      startX.current = e.touches[0].clientX
      startY.current = e.touches[0].clientY
    }
    timer.current = setTimeout(() => {
      if (!moved.current) {
        fired.current = true
        onLongPress()
      }
    }, delay)
  }

  const move = (e) => {
    if (e?.touches) {
      const dx = Math.abs(e.touches[0].clientX - startX.current)
      const dy = Math.abs(e.touches[0].clientY - startY.current)
      if (dx > 8 || dy > 8) {
        moved.current = true
        if (timer.current) clearTimeout(timer.current)
      }
    }
  }

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
  }

  const end = () => {
    cancel()
    if (!fired.current && !moved.current) onTap()
  }

  return {
    onTouchStart: start,
    onTouchEnd: end,
    onTouchMove: move,
    onMouseDown: start,
    onMouseUp: end,
    onMouseLeave: cancel,
  }
}
