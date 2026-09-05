/**
 * One vocabulary for session lifecycle states. The calendar, the planner and
 * anything else showing a saved occurrence read their wording from here, so the
 * same session is never called two different things on two screens.
 */
export const SESSION_STATUS_LABELS = {
  completed: 'Done',
  active: 'In progress',
  cancelled: 'Cancelled',
  dismissed: 'Hidden',
  planned: 'Planned',
  unlogged: 'Not logged',
}

export function sessionStatusLabel(status) {
  return SESSION_STATUS_LABELS[status] || SESSION_STATUS_LABELS.planned
}
