// A web page copied in a browser arrives on the clipboard as HTML full of
// inline computed styles — easily megabytes for a big entries table. Keep only
// the structure the entries reader needs (headings, list items, table cells,
// line breaks) and each cell's background colour, which marks withdrawn and
// refunded entries.

const KEEP = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'P'])
const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE', 'NOSCRIPT', 'IMG', 'SVG'])

function cellBackground(el) {
  const colour = (el.style?.backgroundColor || el.getAttribute('bgcolor') || '').trim()
  if (!colour || colour === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(colour)) return ''
  return colour
}

function slim(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child.textContent.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE || DROP.has(child.tagName)) continue
    if (!KEEP.has(child.tagName)) {
      slim(child, out)
      continue
    }
    const tag = child.tagName.toLowerCase()
    if (tag === 'br') {
      out.push('<br>')
      continue
    }
    const background = (tag === 'td' || tag === 'th') ? cellBackground(child) : ''
    out.push(background ? `<${tag} style="background-color: ${background}">` : `<${tag}>`)
    slim(child, out)
    out.push(`</${tag}>`)
  }
}

export function slimPastedHtml(html) {
  if (!html) return null
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const out = []
    slim(doc.body, out)
    return out.join('')
  } catch (_) {
    return html
  }
}
