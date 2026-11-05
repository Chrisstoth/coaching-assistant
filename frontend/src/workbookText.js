// Small helpers for showing workbook pages: the page header, a safe markdown
// display, and a line-by-line comparison of two versions.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// The header between --- lines (title, kind, swimmers…) and the body under it.
export function splitHeader(content) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content || '')
  if (!m) return { meta: {}, body: content || '' }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: (content || '').slice(m[0].length) }
}

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

// Markdown as HTML: headings, bullet and numbered lists, bold, italic, code and
// paragraphs. Everything is escaped first, so a page can't inject markup.
export function markdownToHtml(md) {
  const out = []
  let list = null
  const close = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd()
    let m
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { close(); const n = Math.min(6, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul' } out.push(`<li>${inline(m[1])}</li>`); continue }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol' } out.push(`<li>${inline(m[1])}</li>`); continue }
    close()
    if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  close()
  return out.join('\n')
}

// Line diff (longest common subsequence): [{ type: 'same' | 'add' | 'del', text }].
export function lineDiff(before, after) {
  const a = String(before || '').split('\n'), b = String(after || '').split('\n')
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: a[i++] })
    else out.push({ type: 'add', text: b[j++] })
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

// Headings in a page body, for choosing which sections to lock.
export const headingsOf = body => [...String(body || '').matchAll(/^#{1,6}\s+(.*?)\s*$/gm)].map(m => m[1])

export const AUTHOR_LABEL = { coach: 'You', app: 'Starter page' }
