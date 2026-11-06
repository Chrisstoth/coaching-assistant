// The Session Builder screen works inside the app: it opens a saved session,
// takes typed sets, undoes, wraps rounds, switches groups and views, saves
// through the app, ignores the rest of the page and cleans up after itself.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const dom = new JSDOM('<!doctype html><html><body><div id="outside"><button data-act="add-block" id="stray">x</button></div><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'getComputedStyle', 'localStorage']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? window : window[k], configurable: true, writable: true })
}
window.scrollTo = () => {}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0)

const { mountBuilder } = await import('../src/notation/builderUi.js')
const { totalsFor, normalizeSession } = await import('../src/notation/core.js')

const sample = JSON.parse(readFileSync(join(here, '..', '..', 'shared', 'notation', 'sessions', 's-261005-am.json'), 'utf8')).session
const saves = []
const root = window.document.getElementById('root')
const decided = []
const api = mountBuilder(root, { id: 42, session: sample, effSys: 'effort20', brand: 'BPSC', save: async s => { saves.push(s); return { ok: true } },
  onComment: (c, action) => decided.push([c.id, action]) })
const $ = s => root.querySelector(s)
const $$ = s => [...root.querySelectorAll(s)]
const key = (el, k, extra = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }))
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

// opens the saved session with its blocks, groups and totals
assert.ok(root.classList.contains('sb'))
assert.equal($$('#blocks .block').length, sample.blocks.length)
assert.equal($('#brandName').textContent, 'BPSC')
assert.match($('#summary').textContent, /3,400/)
assert.equal($$('#gtabs button').length, 3, 'All groups + two group tabs')

// typing a set into a block's add box adds it and saves through the app
const firstBlock = api.getSession().blocks[0]
const q = () => $(`#q-${firstBlock.id}`)   // the add box is redrawn after every change
const type = text => { const el = q(); el.value = text; key(el, 'Enter') }
type('4x50 @1:00 [16]')
let s = api.getSession()
assert.equal(s.blocks[0].items.length, firstBlock.items.length + 1)
const added = s.blocks[0].items.at(-1)
assert.deepEqual([added.reps, added.dist, added.int, added.eff], [4, 50, 60, '16'])
await api.flush()
assert.equal(saves.length, 1)
assert.equal(totalsFor(normalizeSession(saves[0]))[0].dist, 3600)

// Ctrl+Z (with nothing being typed in) undoes it
key(window.document.body, 'z', { ctrlKey: true })
assert.equal(api.getSession().blocks[0].items.length, firstBlock.items.length)

// select two sets with their dots and press 2: they become a 2x round
type('100 easy')
type('50 fast')
s = api.getSession()
const [a, b] = s.blocks[0].items.slice(-2)
click(root.querySelector(`.node[data-id="${a.id}"] .grip`))
click(root.querySelector(`.node[data-id="${b.id}"] .grip`))
key(window.document.body, '2')
const last = api.getSession().blocks[0].items.at(-1)
assert.equal(last.t, 'round')
assert.equal(last.times, 2)
assert.deepEqual(last.items.map(n => n.dist), [100, 50])

// a group's tab shows only the blocks it swims
const tabs = $$('#gtabs button')
click(tabs[1])
assert.ok($$('#blocks .block').length < sample.blocks.length)
click(tabs[0])

// poolside view
click($('#vPool'))
assert.equal($('#pool').hidden, false)
assert.match($('#pool').textContent, /Warm Up/i)
click($('#vEdit'))

// the rest of the page can't trigger builder actions
const before = api.getSession().blocks.length
click(window.document.getElementById('stray'))
assert.equal(api.getSession().blocks.length, before)

// the staff's comments sit under the set they're about, and the buttons answer them
const target = api.getSession().blocks[1].items[0]
api.setComments([{ id: 7, name: 'Fiona', flag: 'safety', message: 'Third race-pace day in a row', line_id: target.id, status: 'open' },
                 { id: 8, name: 'Erin', flag: 'preference', message: 'Answered already', line_id: target.id, status: 'dismissed' }])
const pins = [...root.querySelectorAll('.sc-pin')]
assert.equal(pins.length, 1, 'only open comments show')
assert.ok(root.querySelector(`.node[data-id="${target.id}"] .sc-pin.safety`))
click(pins[0].querySelector('[data-cmt="dismiss"]'))
assert.deepEqual(decided, [[7, 'dismiss']])
assert.match(pins[0].textContent, /Acknowledge/, 'a safety flag is acknowledged, not dismissed')
q().focus(); type('100 easy')
assert.equal(root.querySelectorAll('.sc-pin').length, 1, 'comments stay pinned when the session redraws')

// Jess's draft goes in as new blocks, and Undo takes it out
const before2 = api.getSession().blocks.length
api.addBlocks([{ id: 'jb1', name: 'Kick', groups: [], items: [{ id: 'jl1', t: 'line', reps: 8, dist: 50, desc: 'Kick', int: 60, int2: null, rest: null, est: null, eff: '15' }] }], { title: 'Kick day' })
assert.equal(api.getSession().blocks.at(-1).name, 'Kick')
assert.equal(api.getSession().blocks.length, before2 + 1)
key(window.document.body, 'z', { ctrlKey: true })
assert.equal(api.getSession().blocks.length, before2)

// closing saves what's pending, then removes the builder and its listeners
type('200 swim down')
api.destroy()
await new Promise(r => setTimeout(r, 0))
assert.equal(root.innerHTML, '')
assert.ok(saves.length >= 2, 'pending changes were saved on close')
key(window.document.body, 'z', { ctrlKey: true })   // no builder listeners left to throw

// the poolside PDF builds, with the squad header and footer from the club's settings
const { jsPDF } = await import('jspdf')
const { buildSessionPdf } = await import('../src/notation/pdf.js')
const pdfText = buildSessionPdf(jsPDF, normalizeSession(JSON.parse(JSON.stringify(sample))), null, null, '5 Nov 2026',
  { header: 'Silver 1 · Session plan', footer: 'BPSC Session Builder' }).output()
assert.match(pdfText, /SILVER 1 · SESSION PLAN|SILVER 1 \267 SESSION PLAN|SILVER 1/)
assert.match(pdfText, /BPSC Session Builder/)
assert.match(pdfText, /WARM UP/)

// a club's own scale: listed in the picker beside the standard ones it hasn't hidden, and shown in its own words
const { EFF_SYSTEMS, effFromCanon, useScales } = await import('../src/notation/core.js')
const mine = { key: 'c-test', name: 'Silver 1 colours', short: 'Colour', colored: true,
  zones: EFF_SYSTEMS.bpsc.zones.map((z, i) => i === 3 ? { ...z, label: 'Crimson' } : z) }
const root2 = window.document.createElement('div'); window.document.body.appendChild(root2)
const b2 = mountBuilder(root2, { id: 43, session: { ...sample, effSys: 'c-test' }, effSys: 'effort20', save: async () => ({ ok: true }),
  scales: [{ key: 'effort20', name: 'Effort /20' }, { key: 'sweetenham', name: 'Sweetenham' }, { key: 'c-test', name: 'Silver 1 colours' }],
  customScales: [mine] })
assert.deepEqual([...root2.querySelectorAll('#m-effsys option')].map(o => o.value), ['effort20', 'sweetenham', 'c-test'])
assert.equal(effFromCanon('17', 'c-test'), 'Crimson')
assert.equal(EFF_SYSTEMS.bpsc.zones[3].label, 'Red', 'the standard scale is untouched')
assert.ok(root2.querySelector('#scaleChart').textContent.includes('Silver 1 colours'))
b2.destroy(); useScales([])

console.log('Session builder screen checks passed')
process.exit(0)
