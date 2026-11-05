// The Season Planner runs in the app: its week logic still gives the reference
// answers, and its screen mounts with the app's storage and unmounts cleanly.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'
import { buildCases } from './build-planner-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '..', 'shared', 'planner')
assert.deepEqual(JSON.parse(JSON.stringify(buildCases())), JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')), 'planner week logic changed')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'getComputedStyle', 'localStorage', 'SVGElement']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : dom.window[k], configurable: true, writable: true })
}
dom.window.scrollTo = () => {}
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0)
globalThis.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} }
dom.window.ResizeObserver = globalThis.ResizeObserver

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
assert.equal(root.querySelector('.title h1').textContent, 'Test Squad Season Planner')
assert.match(root.textContent, /Regionals/, 'the plan arrived from the app and was drawn')
assert.match(root.textContent, /Nationals/)
app.destroy()
assert.equal(root.innerHTML, '')
console.log('Season planner checks passed')
process.exit(0)
