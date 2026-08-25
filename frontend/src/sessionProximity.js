export function localDateKey(value = new Date()) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function minutesFromTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function sessionDaypart(session) {
  const start = minutesFromTime(session.time || session.start_time)
  if (start !== null) return start < 12 * 60 ? 'AM' : 'PM'

  const label = `${session.label || ''} ${session.title || ''}`.toLowerCase()
  if (/\b(am|morning)\b/.test(label)) return 'AM'
  if (/\b(pm|afternoon|evening)\b/.test(label)) return 'PM'
  return null
}

export function isSessionNear(session, now = new Date()) {
  if (!session || ['cancelled', 'completed', 'dismissed'].includes(session.status)) return false
  if (session.date !== localDateKey(now)) return false

  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const currentDaypart = currentMinutes < 12 * 60 ? 'AM' : 'PM'
  if (sessionDaypart(session) === currentDaypart) return true

  // Keep a session visible across the noon boundary when it is genuinely close.
  const start = minutesFromTime(session.time || session.start_time)
  if (start === null) return true
  let end = minutesFromTime(session.end_time)
  if (end === null || end < start) end = start + 120
  return currentMinutes >= start - 180 && currentMinutes <= end + 120
}

export function calendarSessions(calendar) {
  return (calendar || []).flatMap(day =>
    (day.items || []).map(item => ({ ...item, date: day.date, day_name: day.day_name }))
  )
}

export function weeklySessionQueue(calendar, now = new Date()) {
  const monday = new Date(now)
  const weekday = monday.getDay()
  monday.setDate(monday.getDate() + (weekday === 0 ? -6 : 1 - weekday))
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const from = localDateKey(monday)
  const to = localDateKey(sunday)
  return calendarSessions(calendar)
    .filter(item => item.date >= from && item.date <= to)
    .filter(item => !['cancelled', 'completed', 'dismissed'].includes(item.status))
    .sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (b.status === 'active' && a.status !== 'active') return 1
      return `${a.date}T${a.time || a.start_time || '23:59'}`.localeCompare(
        `${b.date}T${b.time || b.start_time || '23:59'}`
      )
    })
}

export function proximateSessions(calendar, now = new Date()) {
  return calendarSessions(calendar)
    .filter(item => isSessionNear(item, now))
    .sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (b.status === 'active' && a.status !== 'active') return 1
      const nowMinutes = now.getHours() * 60 + now.getMinutes()
      const aDistance = Math.abs((minutesFromTime(a.time || a.start_time) ?? nowMinutes) - nowMinutes)
      const bDistance = Math.abs((minutesFromTime(b.time || b.start_time) ?? nowMinutes) - nowMinutes)
      return aDistance - bDistance
    })
}

export function matchingWeeklySessions(microcycles, session, dateKey) {
  const dayName = new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase()
  const candidates = (microcycles || []).flatMap(micro =>
    (micro.sessions || []).map(planned => ({ ...planned, _microcycle: micro }))
  )

  const sameDay = candidates.filter(planned => {
    if (planned.date) return planned.date === dateKey
    const day = String(planned.day || '').toLowerCase()
    return day === dayName || day.startsWith(dayName.slice(0, 3))
  })
  if (sameDay.length <= 1) return sameDay

  const wantedPart = sessionDaypart(session)
  const matchingPart = sameDay.filter(planned => sessionDaypart({
    time: planned.time || planned.start_time,
    label: `${planned.slot_label || ''} ${planned.day || ''}`,
  }) === wantedPart)
  return matchingPart.length > 0 ? matchingPart : sameDay
}
