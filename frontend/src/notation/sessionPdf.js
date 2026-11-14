/* The session plan PDF, made from a saved session without opening the builder.
   Same sheet as the builder's PDF button: the club's logo, fonts and scales. */
import { jsPDF } from 'jspdf'
import { normalizeSession, sessionForGroup, setEffSys, useScales } from './core.js'
import { buildSessionPdf, exportFileName } from './pdf.js'

let fontCache = null
function abToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// The PDF's fonts, bundled with the app. Throws if they can't be fetched.
export async function loadPdfFonts() {
  if (fontCache) return fontCache
  const names = { regular: 'Regular', semibold: 'SemiBold', bold: 'Bold', italic: 'Italic' }, out = {}
  await Promise.all(Object.entries(names).map(async ([k, n]) => {
    const res = await fetch(`/fonts/BarlowSemiCondensed-${n}.ttf`)
    if (!res.ok) throw new Error('font')
    out[k] = abToB64(await res.arrayBuffer())
  }))
  return (fontCache = out)
}

export const pdfFileName = (s, groupName) =>
  exportFileName(s).replace(/\.xlsx$/, '') + (groupName ? ` - ${groupName.replace(/[\/:*?"<>|]/g, '-')}` : '') + '.pdf'

/* payload: what GET /session-builder/sessions/:id returns. groupId: one group's
   sheet, or null for the whole session. */
export async function sessionPdf(payload, groupId = null) {
  useScales(payload.custom_scales)
  const s = normalizeSession(JSON.parse(JSON.stringify(payload.session)))
  setEffSys(s.effSys || payload.effort_scale || 'effort20')
  let fonts = null
  try { fonts = await loadPdfFonts() } catch { fonts = null }   // falls back to a standard font
  const one = sessionForGroup(s, groupId)
  const club = payload.club || {}
  const doc = buildSessionPdf(jsPDF, one, club.logo || null, fonts && fonts.regular ? fonts : null,
    new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    { header: `${payload.squad ? payload.squad + ' · ' : ''}Session plan`, footer: `${club.name ? club.name + ' ' : ''}Session Builder` })
  return { blob: doc.output('blob'), name: pdfFileName(s, one._group) }
}

/* Opens the PDF full screen, outside the app. On a computer it opens in a new tab;
   a phone is handed the file and shows it in its own viewer. */
export async function openSessionPdf(payload, groupId = null) {
  const { blob, name } = await sessionPdf(payload, groupId)
  const url = URL.createObjectURL(blob)
  setTimeout(() => URL.revokeObjectURL(url), 120000)
  const touch = window.matchMedia?.('(pointer: coarse)').matches
  // (no "noopener": with it window.open always answers null, so a blocked popup couldn't be told apart)
  if (!touch && window.open(url, '_blank')) return
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 1000)
}
