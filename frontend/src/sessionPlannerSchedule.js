export function localIsoDate(value) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function atLocalTime(date, time = '00:00') {
  const [hours, minutes] = String(time).split(':').map(Number)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
  )
}

export function buildSessionOccurrences(slots, now = new Date(), daysBefore = 56, daysAfter = 182) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBefore)
  const occurrences = []

  for (let offset = 0; offset <= daysBefore + daysAfter; offset += 1) {
    const occurrenceDate = new Date(start)
    occurrenceDate.setDate(start.getDate() + offset)
    const dayOfWeek = (occurrenceDate.getDay() + 6) % 7
    for (const slot of slots) {
      if (slot.day_of_week !== dayOfWeek) continue
      const date = localIsoDate(occurrenceDate)
      occurrences.push({
        ...slot,
        date,
        key: `${date}-${slot.id}`,
        startsAt: atLocalTime(occurrenceDate, slot.time),
      })
    }
  }

  return occurrences.sort((left, right) => left.startsAt - right.startsAt)
}

export function nextSessionIndex(occurrences, now = new Date()) {
  const next = occurrences.findIndex(occurrence => occurrence.startsAt >= now)
  return next >= 0 ? next : Math.max(0, occurrences.length - 1)
}
