import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const importPage = await readFile(new URL('../src/pages/Import.jsx', import.meta.url), 'utf8')
const profileWizard = await readFile(new URL('../src/pages/ProfileWizard.jsx', import.meta.url), 'utf8')
const swimmerDetail = await readFile(new URL('../src/pages/SwimmerDetail.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')
const skill = await readFile(new URL('../../skills/lanewatch-profile-builder/SKILL.md', import.meta.url), 'utf8')
const schema = await readFile(new URL('../../skills/lanewatch-profile-builder/references/foundation-schema.md', import.meta.url), 'utf8')

assert.match(importPage, /id: 'profiles'/, 'Import Data should include the Profile Builder tab.')
assert.match(importPage, /existing confirmed information is never overwritten/, 'Profile imports should explain merge-only behavior.')
assert.match(importPage, /row\.can_import/, 'Only validated profile rows should be selectable.')
assert.match(api, /previewFoundationProfileImport/, 'The profile preview API must be wired.')
assert.match(api, /confirmFoundationProfileImport/, 'The profile confirmation API must be wired.')
assert.match(profileWizard, /live times, observations, completed foundation areas and living profiles/, 'The API interview should explain its swimmer-specific evidence.')
assert.match(profileWizard, /getProfileWizardDraft/, 'An unfinished interview should be restored when the screen is reopened.')
assert.match(profileWizard, /Interview draft saved automatically/, 'The coach should be told that interview progress is recoverable.')
assert.match(api, /discardProfileWizardDraft/, 'The coach should be able to explicitly discard a recovered draft.')
assert.match(swimmerDetail, /View confirmed foundation/, 'Imported foundation fields should be visible on the swimmer overview.')
assert.doesNotMatch(skill, /TODO/, 'The installed Profile Builder skill must not contain scaffold placeholders.')
assert.match(skill, /review_status/, 'The Profile Builder must require coach review state.')
assert.match(schema, /coach_confirmed/, 'The canonical JSON schema must define coach confirmation.')

console.log('Profile import checks passed')
