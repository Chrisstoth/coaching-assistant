// The Season Planner runs in the app: its week logic still gives the reference
// answers, and its screen mounts with the app's storage and unmounts cleanly.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'
import { buildCases, withShortGroup } from './build-planner-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '..', 'shared', 'planner')
assert.deepEqual(JSON.parse(JSON.stringify(buildCases())), JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')), 'planner week logic changed')
// A short-term group runs weeks 7-9 only; afterwards its swimmers are back where they came from.
const short = JSON.parse(JSON.stringify(buildCases(true)))
assert.deepEqual(short, JSON.parse(readFileSync(join(dir, 'cases-short-group.json'), 'utf8')), 'short-term group logic changed')
const groups = id => short[id].map(w => w.group).join(' ')
assert.equal(groups('sw:s5'), 'girls girls girls girls girls girls girls late late late girls girls', 'moved in before it starts: joins on its first week, back to Girls after')
assert.equal(groups('sw:s6'), 'core core core core core core core core late late core core', 'back to the group he came from, not the one it follows')
assert.equal(short['sw:s5'][10].load, short.girls[10].load, "after it ends the swimmer has their own group's plan")

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'getComputedStyle', 'localStorage', 'SVGElement']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : dom.window[k], configurable: true, writable: true })
}
dom.window.scrollTo = () => {}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0)
globalThis.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} }
dom.window.ResizeObserver = globalThis.ResizeObserver
globalThis.matchMedia = dom.window.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })
dom.window.HTMLElement.prototype.scrollIntoView = function () {}

const { mountPlanner } = await import('../src/planner/plannerApp.js')
const plan = JSON.parse(readFileSync(join(dir, 'sample-plan.json'), 'utf8'))
const roster = JSON.parse(readFileSync(join(dir, 'sample-roster.json'), 'utf8'))
const saved = []
const store = {
  getDocs: async () => ({ plan: { data: plan }, roster: { data: roster } }),
  putDoc: async (key, data) => { saved.push([key, data]); return { revision: saved.length } },
  listVersions: async () => [], getVersion: async () => { throw new Error('none') }, deleteVersion: async () => {}, addVersion: async () => ({ id: '1' }),
}
const root = dom.window.document.getElementById('root')
let app
try { app = mountPlanner(root, { store, squad: 'Test Squad', mark: 'BPSC' }) } catch (e) { console.error(e); throw e }
await new Promise(r => setTimeout(r, 50))
assert.ok(root.classList.contains('sp'))
assert.equal(root.querySelector('.title h1').textContent, 'Season plan')
assert.match(root.textContent, /Regionals/, 'the plan arrived from the app and was drawn')
assert.match(root.textContent, /Nationals/)
// On a narrow page the names take a slim strip so the chart gets the width; a tap widens them.
const timeline = root.querySelector('#timeline')
assert.ok(timeline.classList.contains('slim'), 'names start narrow on a narrow page')
root.querySelector('.namesbtn').click()
assert.ok(!root.querySelector('#timeline').classList.contains('slim'), 'the names button shows full names')
assert.equal(root.querySelector('#undoBtn').getAttribute('aria-label'), 'Undo', 'icon buttons keep a name')
const css = readFileSync(new URL('../src/planner/planner.css', import.meta.url), 'utf8')
assert.match(css, /#tl\{[^}]*touch-action:pan-x pan-y pinch-zoom/, 'a finger on the chart can still scroll the page, and two can zoom it')
assert.ok(root.querySelector('#lockBtn').hidden, 'no padlock without a touch screen')
assert.match(css, /\.sp button\{min-height:0;min-width:0\}/, "the app's 44px button minimum must not stretch the planner's rows")
const src = readFileSync(new URL('../src/planner/plannerApp.js', import.meta.url), 'utf8')
assert.match(src, /if\(!S\.ro&&\(a==='bnd'\|\|a==='paint'\)&&!touchEdit\)p\.timer=setTimeout\(\(\)=>\{if\(press!==p\)return;press=null;\s*showTip/, 'a finger on a locked chart only gets a hint, never a change')
assert.match(src, /if\(lastPtr!=='mouse'&&!touchEdit\)\{e\.preventDefault\(\);return;\}/, "a finger can't drag a swimmer to another group while locked")
assert.match(src, /if\(e\.pointerType==='mouse'\)\{if\(tapAct\(t\)\)return;/, 'only a mouse opens things on press; a finger opens them on a tap')
app.destroy()
assert.equal(root.innerHTML, '')

// A short-term group: its lane says when it runs, is blank outside those weeks, and its panel lets the coach set them.
const sp = withShortGroup(JSON.parse(JSON.stringify(plan)), JSON.parse(JSON.stringify(roster)))
sp.roster.qts.nats = {}   // the branch panel reads the Nationals times
const shortStore = { ...store, getDocs: async () => ({ plan: { data: sp.plan }, roster: { data: sp.roster } }) }
app = mountPlanner(root, { store: shortStore, squad: 'Test Squad', mark: 'BPSC' })
await new Promise(r => setTimeout(r, 50))
assert.match(root.textContent, /short-term · 12 Oct – 1 Nov/, 'the lane label gives its weeks')
assert.ok(root.querySelectorAll('#tl .offspan').length >= 1, 'weeks outside it are blanked')
;[...root.querySelectorAll('[data-cmd="selbranch"]')].find(b => b.textContent === 'Girls late meet').click()
await new Promise(r => setTimeout(r, 10))
const detail = root.querySelector('#detail').textContent
assert.match(detail, /Short-term group/)
assert.match(detail, /Runs from/)
assert.match(detail, /Who was in Girls late meet/, 'once its weeks are over it is a record of who was in it')
assert.ok([...root.querySelectorAll('#detail [data-k="brmember"]')].every(c => c.disabled), 'a finished group cannot take swimmers')
assert.ok(root.querySelector('#detail [data-cmd="addshort"]'), 'a short-term group can be made in one tap')
app.destroy()
// On a touch screen the chart starts locked; the padlock unlocks it and locks it again.
globalThis.matchMedia = dom.window.matchMedia = q => ({ matches: /coarse/.test(q), addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })
app = mountPlanner(root, { store, squad: 'Test Squad', mark: 'BPSC' })
await new Promise(r => setTimeout(r, 50))
const lock = () => root.querySelector('#lockBtn')
assert.ok(!lock().hidden, 'a touch screen shows the padlock')
assert.equal(lock().getAttribute('aria-pressed'), 'false', 'the chart starts locked')
assert.match(lock().textContent, /Locked/)
assert.match(root.querySelector('#hint').textContent, /pinch to zoom/)
lock().click()
assert.equal(lock().getAttribute('aria-pressed'), 'true', 'a tap unlocks it')
assert.match(lock().textContent, /Editing/)
lock().click()
assert.equal(lock().getAttribute('aria-pressed'), 'false', 'and a second tap locks it again')
app.destroy()
globalThis.matchMedia = dom.window.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })

// The Weeks tab (docs/design/season-planner-weeks.md): the app's scales, the timetable's slots,
// the Meets tab's meets and the sessions already written.
{
  const wp = JSON.parse(JSON.stringify(plan))
  wp.sessions[0].slot = 5                       // Mon AM is timetable slot 5
  wp.calendar[0].meet = 9                       // County Champs is meet 9 in the Meets tab
  const bpsc = { key: 'bpsc', name: 'BPSC HR colours', zones: [
    { label: 'White', lo: 0, c: 10, color: '#F1F2F4' }, { label: 'Yellow', lo: 12.5, c: 13.5, color: '#F4D03F' },
    { label: 'Pink', lo: 14.5, c: 15.5, color: '#F29AC2' }, { label: 'Red', lo: 16.5, c: 17, color: '#D62839' },
    { label: 'Purple', lo: 17.5, c: 18, color: '#7D3C98' }, { label: 'Blue', lo: 18.5, c: 19.5, color: '#1F6FD1' },
    { label: 'Gold', lo: 20.5, c: 21, color: '#C9A227' }] }
  const calls = { nav: [], meets: [] }
  const wSaved = []
  const wStore = { ...store, getDocs: async () => ({ plan: { data: wp }, roster: { data: roster } }), putDoc: async (key, data) => { wSaved.push([key, data]); return {} } }
  app = mountPlanner(root, {
    store: wStore, squad: 'Test Squad', mark: 'BPSC',
    scales: { usual: 'bpsc', standard: [{ key: 'effort20', name: 'Effort /20' }], custom: [bpsc] },
    navigate: to => calls.nav.push(to),
    api: {
      sessionsBetween: async () => [{ id: 77, date: '2026-08-24', pool_slot_id: 5, status: 'active' }],
      updateMeet: async (id, body) => { calls.meets.push([id, body]); return {} },
      createMeet: async () => ({ id: 10 }),
    },
  })
  await new Promise(r => setTimeout(r, 900))
  const savedPlan = wSaved.filter(([k]) => k === 'plan').pop()?.[1]
  assert.ok(savedPlan, 'a plan on the old line is saved once converted')
  assert.equal(savedPlan.line, 'common')
  assert.deepEqual(savedPlan.templates[0].f.monam, { a: 13.5, b: 15.5 }, 'old RPE 11 / 13 are Yellow / Pink on the common line')
  root.querySelector('[data-v="sessions"]').click()
  await new Promise(r => setTimeout(r, 20))
  const v = () => root.querySelector('#v-sessions')
  assert.equal(root.querySelector('[data-v="sessions"]').textContent, 'Weeks')
  assert.match(v().textContent, /Standard week/, 'each block shows its standard week')
  assert.ok(v().querySelector('.zbar'), 'the scale is shown as a bar of zones')
  assert.equal(v().querySelector('#scaleSel').value, 'bpsc', "the club's usual scale")
  ;(v().querySelector('[data-cmd="wkpast"]') || { click(){} }).click()
  await new Promise(r => setTimeout(r, 20))
  const row0 = v().querySelector('tr.wkrow[data-i="0"]')
  assert.ok(row0, 'earlier weeks can be shown')
  assert.match(row0.textContent, /Regionals/, "every group's code for the week")
  assert.match(row0.textContent, /County/, 'the meets ahead')
  assert.match(row0.textContent, /Yellow/, "the focus shows in the club's scale")
  const open = row0.querySelector('[data-cmd="goto"]')
  assert.equal(open && open.dataset.to, '/sessions/77', 'a written session links to it')
  open.click()
  assert.deepEqual(calls.nav, ['/sessions/77'])
  row0.click()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(v().querySelector('tr.wk-edit .wk-sess'), 'opening a week edits it in place')
  assert.ok(!v().querySelector('tr.wk-edit #weekBranch'), 'the plan line is the one picked at the top')
  v().querySelector('[data-cmd="stdopen"]').click()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(v().querySelector('.wkb-std [data-k="tf"]'), "a block's standard week opens for editing")
  root.querySelector('[data-v="calendar"]').click()
  await new Promise(r => setTimeout(r, 20))
  const nm = root.querySelector('#v-calendar input[data-k="meet"][data-f="name"]')
  nm.value = 'County Championships'
  nm.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.meets.length, 1, 'a meet changed in the plan is changed in the Meets tab')
  assert.deepEqual(calls.meets[0], [9, { name: 'County Championships', date: '2026-11-07', date_to: '2026-11-08', location: 'Test pool', course: 'SCM' }])
  assert.ok(root.querySelector('#v-calendar [data-to="/meets/9"]'), 'a Meets tab meet is deleted from the Meets tab, not here')
  app.destroy()
}
console.log('Season planner checks passed')
process.exit(0)
