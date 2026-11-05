import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { splitHeader, markdownToHtml, lineDiff, headingsOf } from '../src/workbookText.js'

const page = '---\ntitle: Ruby W\nkind: case\nconfidence: hypothesis\n---\n\n## Recovery\n- Flat on **7 Oct**\n- <script>x</script>\n'
const { meta, body } = splitHeader(page)
assert.deepEqual(meta, { title: 'Ruby W', kind: 'case', confidence: 'hypothesis' })
assert.match(body, /^\n?## Recovery/)
assert.deepEqual(headingsOf(body), ['Recovery'])

const html = markdownToHtml(body)
assert.match(html, /<h3>Recovery<\/h3>/)
assert.match(html, /<li>Flat on <b>7 Oct<\/b><\/li>/)
assert.doesNotMatch(html, /<script>/, 'page text is escaped, never run')

const d = lineDiff('a\nb\nc', 'a\nc\nd')
assert.deepEqual(d, [{ type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' }])
assert.equal(lineDiff('same', 'same').every(x => x.type === 'same'), true)

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
assert.match(app, /path="\/workbooks"/)
assert.match(app, /path="\/workbooks\/:role"/)
const settings = await readFile(new URL('../src/pages/Settings.jsx', import.meta.url), 'utf8')
assert.match(settings, /to: '\/workbooks'/, 'Settings links to the staff workbooks')

const hist = await readFile(new URL('../src/pages/HistoryImport.jsx', import.meta.url), 'utf8')
assert.match(hist, /api\.answerHistoryImportQuestion\(/, "Maggie's questions can be answered")
assert.match(hist, /Moved on/)
assert.match(app, /path="\/history-import"/)
assert.match(settings, /to: '\/history-import'/)

const wbPage = await readFile(new URL('../src/pages/Workbooks.jsx', import.meta.url), 'utf8')
assert.match(wbPage, /<ThisWeek \/>/, 'the weekly list sits at the top of the workbooks')
assert.match(wbPage, /api\.tickWorkbookPage\(/)
assert.match(wbPage, /Track record/)

console.log('Workbook checks passed')
