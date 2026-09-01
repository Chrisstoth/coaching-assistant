import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sessionImport = await readFile(new URL('../src/pages/Import.jsx', import.meta.url), 'utf8')
const sessionHub = await readFile(new URL('../src/pages/SessionDetail.jsx', import.meta.url), 'utf8')
const calendar = await readFile(new URL('../src/pages/Calendar.jsx', import.meta.url), 'utf8')
const cancellationDialog = await readFile(new URL('../src/components/SessionCancellationDialog.jsx', import.meta.url), 'utf8')

assert.match(sessionImport, /Choose the date and session/, 'Standalone Excel imports should expose a date/session chooser.')
assert.match(sessionImport, /api\.getCalendar\(localDateIso\(mondayFor\(selectedDate\)\)\)/, 'The chooser should load the timetable week containing the selected date.')
assert.match(sessionImport, /New standalone session/, 'A coach should be able to import without linking a timetable occurrence.')
assert.match(sessionImport, /targetLocked && preview\.context_match === false/, 'Dashboard-launched imports should retain strict target matching.')
assert.match(sessionImport, /pool_slot_id: poolSlotId/, 'Selecting a timetable occurrence should link its pool slot into the reviewed draft.')
assert.match(sessionHub, /No session plan attached yet/, 'An unplanned session hub should expose a clear import route.')
assert.match(sessionHub, /session: String\(session\.id\)/, 'The hub import route should target the current session.')
assert.match(calendar, /z-\[70\].*flex items-end/, 'The calendar cancellation sheet should sit above the bottom toolbar.')
assert.match(cancellationDialog, /z-\[70\]/, 'Shared cancellation dialogs should sit above the bottom toolbar.')

console.log('Session import checks passed')
