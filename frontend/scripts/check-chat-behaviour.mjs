import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const coachAI = await readFile(new URL('../src/pages/CoachAI.jsx', import.meta.url), 'utf8')
const dashboard = await readFile(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8')
const register = await readFile(new URL('../src/pages/Register.jsx', import.meta.url), 'utf8')
const todaySession = await readFile(new URL('../src/pages/TodaySession.jsx', import.meta.url), 'utf8')
const profileWizard = await readFile(new URL('../src/pages/ProfileWizard.jsx', import.meta.url), 'utf8')
const sessionLog = await readFile(new URL('../src/pages/Sessions.jsx', import.meta.url), 'utf8')
const sessionDetail = await readFile(new URL('../src/pages/SessionDetail.jsx', import.meta.url), 'utf8')
const cancellationDialog = await readFile(new URL('../src/components/SessionCancellationDialog.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')

assert.match(
  coachAI,
  /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/,
  'Chat Return must insert a newline; only Ctrl/Cmd+Enter should send.',
)
assert.match(coachAI, /recoverSavedReply/, 'Chat should recover replies saved after a dropped request.')
assert.match(coachAI, /athlete_profile_update/, 'Chat should offer a confirmed athlete profile update.')
assert.match(api, /updateAthleteProfileFromChat/, 'The athlete profile update API must be wired.')
assert.match(coachAI, /formal_target_capture/, 'Chat should recognise an explicit formal target request.')
assert.match(coachAI, /function TargetDraftCard/, 'Formal targets should be shown in an editable review card.')
assert.match(coachAI, /Save formal target/, 'Formal targets must require an explicit save confirmation.')
assert.match(api, /previewTargetFromChat/, 'Chat target extraction must use the preview-only endpoint.')
assert.match(api, /previewFoundationFromEvidence/, 'Foundation carry-over must use a preview endpoint.')
assert.match(profileWizard, /Draft from existing evidence/, 'Existing profile evidence should be offered before a new foundation interview.')
assert.match(profileWizard, /Confirm and save reviewed fields/, 'Foundation carry-over must require coach confirmation.')
assert.match(profileWizard, /Drafting does not change/, 'The preview-only behaviour should be clear to the coach.')
assert.match(coachAI, /res\.cancellation_data/, 'Chat should open the confirmed session cancellation workflow.')
assert.match(dashboard, /SessionCancellationDialog/, 'The home session desk should expose session cancellation.')
assert.match(dashboard, /function CoachingWatchpoints/, 'Home should group coaching watchpoints into one compact panel.')
assert.match(dashboard, /const \[open, setOpen\] = useState\(false\)/, 'Home coaching watchpoints should start collapsed.')
assert.match(dashboard, /% after 4/, 'Squad Pulse should plainly explain when attendance percentages appear.')
assert.doesNotMatch(register, /getExpectedAttendance/, 'The register must not be filtered through usual attendance.')
assert.match(register, /SessionWatchpoints/, 'Relevant coaching watchpoints should be available inside the register.')
assert.match(register, />Watch<\/span>/, 'Swimmers with a relevant watchpoint should be marked in the register.')
assert.match(register, /How many different programmes are being done\?/, 'The register should ask for the session group structure when it is unknown.')
assert.match(register, /groupCount > 1/, 'Per-swimmer group controls should only appear for multi-group sessions.')
assert.match(coachAI, /How many different programmes were done\?/, 'The chat register should use the same group setup workflow.')
assert.match(todaySession, /Session watchpoints & individual notes/, 'The session dashboard should identify coaching notes as actionable watchpoints.')
assert.match(cancellationDialog, /recurring timetable slot will stay in place/, 'Cancellation must explain that only one occurrence is affected.')
assert.match(sessionLog, /Cancelled sessions/, 'Cancelled occurrences should be separated from sessions that happened.')
assert.match(sessionLog, /these were not completed sessions/, 'The cancellation audit record should be explained in the Session Log.')
assert.match(sessionDetail, /navigate\(-1\)/, 'The session screen back button should follow browser and Android history.')
assert.match(register, /navigate\(-1\)/, 'The register back button should follow browser and Android history.')

console.log('Chat behaviour checks passed')
