import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const meets = await readFile(new URL('../src/pages/Meets.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')

assert.match(meets, /Import Excel/, 'The Meets screen should expose the gala workbook importer.')
assert.match(meets, /Nothing is saved until you review and confirm/, 'The importer should explain its review-first behaviour.')
assert.match(meets, /row\.can_import/, 'Invalid and duplicate workbook rows should not be selectable.')
assert.match(meets, /confirmMeetExcelImport/, 'The reviewed gala rows should use the confirmed import endpoint.')
assert.match(api, /previewMeetExcelImport/, 'The gala workbook preview API must be wired.')
assert.match(api, /\/meets\/import\/excel\/confirm/, 'The gala workbook confirmation API must be wired.')

console.log('Meet import checks passed')
