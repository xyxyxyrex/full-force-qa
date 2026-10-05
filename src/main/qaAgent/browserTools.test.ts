import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_TRACKER } from '../../shared/trackerFormat'
import type { BrowserOpenInput, BrowserStep, QaBrowser } from './qaBrowserTypes'
import { createFakeContext, type FakeContext } from './testSupport'
import { callTool } from './tools'

let root: string
let fake: FakeContext
let opened: BrowserOpenInput[]
let browser: QaBrowser & { calls: string[] }
let allowSend: boolean
let jpeg: Buffer

const step = (over: Partial<BrowserStep> = {}): BrowserStep => ({
  snapshot: {
    url: 'https://svenson.test/alopecia-page/', title: 'Alopecia', headings: [{ level: 1, text: 'Alopecia treatment' }],
    elements: [
      { ref: 'e1', tag: 'a', role: 'link', name: 'Book an appointment', href: '/contact/', inViewport: true },
      { ref: 'e2', tag: 'input', role: 'textbox', type: 'email', name: 'Your email', value: '', required: true, inViewport: true, form: 'F1' },
      { ref: 'e3', tag: 'input', role: 'textbox', type: 'email', name: 'Confirm', value: 'nope', invalid: 'Please include an @', inViewport: false, form: 'F1' },
      { ref: 'e4', tag: 'button', role: 'button', name: 'Send', inViewport: true, form: 'F1' },
    ],
    totalElements: 40, forms: [{ id: 'F1', action: '/contact/', method: 'POST', fields: ['e2', 'e3'], submits: ['e4'] }], scrollY: 0, scrollHeight: 3000, viewport: { width: 1440, height: 1024 },
  },
  screenshot: jpeg, navigated: false, status: 200,
  events: { console: [], requests: [], blocked: [], dialogs: [], popups: [], downloads: [] },
  ...over,
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'parity-browser-tools-'))
  jpeg = await sharp({ create: { width: 1440, height: 1024, channels: 3, background: '#eee' } }).jpeg().toBuffer()
  opened = []
  allowSend = false
  let state: { runId: string; site: string; breakpoint: any } | null = null
  const calls: string[] = []
  browser = {
    calls,
    get runId() { return state?.runId ?? null },
    get site() { return state?.site ?? null },
    get breakpoint() { return state?.breakpoint ?? null },
    async open(input) { opened.push(input); state = { runId: input.runId, site: input.site, breakpoint: input.breakpoint }; return step() },
    async snapshot() { return step() },
    async click(ref) { calls.push(`click ${ref}`); return step({ navigated: true, note: undefined, events: { console: [{ level: 'error', message: 'Uncaught TypeError: x is undefined' }], requests: [{ method: 'GET', url: 'https://svenson.test/missing.png', status: 404, type: 'image' }], blocked: [{ kind: 'form', method: 'POST', url: 'https://svenson.test/contact/', reason: 'sending data is off (Settings → AI Agents)' }], dialogs: [{ type: 'alert', message: 'Thanks!' }], popups: [], downloads: [] } }) },
    async type(ref, text, options) { calls.push(`type ${ref} ${text} ${options.clear} ${options.enter}`); return step() },
    async select(ref, value) { calls.push(`select ${ref} ${value}`); return step() },
    async press(key) { calls.push(`press ${key}`); return step() },
    async scroll(to) { calls.push(`scroll ${to}`); return step() },
    async back() { calls.push('back'); return step() },
    allEvents: () => ({ console: [{ level: 'warning', message: 'jQuery migrate' }], requests: [], blocked: [], dialogs: [], popups: [], downloads: [] }),
    async links() { return [
      { url: 'https://svenson.test/contact/', text: 'Contact', plan: 'check', status: 200, count: 2 },
      { url: 'https://svenson.test/old/', text: 'Old page', plan: 'check', status: 404, count: 1 },
      { url: 'https://svenson.test/moved', text: 'Moved', plan: 'check', status: 200, finalUrl: 'https://svenson.test/new/', count: 1 },
      { url: 'https://svenson.test/#', text: 'Learn more', plan: 'placeholder', count: 1 },
      { url: 'mailto:hi@svenson.test', text: 'Email', plan: 'skip-scheme', count: 1 },
      { url: 'https://svenson.test/wp-login.php?action=logout', text: 'Log out', plan: 'skip-admin', count: 1 },
      { url: 'https://down.test/', text: 'Partner', plan: 'check', error: 'no answer within 10 seconds', count: 1 },
    ] },
    async audit() { return { title: 'Alopecia', description: '', canonical: '', robots: 'noindex, nofollow', lang: '', viewport: 'width=device-width', h1: ['A', 'B'], headingJumps: ['H1 → H3 "Why"'], ogTitle: '', ogImage: '', favicon: true, imagesWithoutAlt: ['https://svenson.test/hero.jpg'], brokenImages: [], unnamedLinks: 2, unnamedButtons: 1, unlabeledInputs: ['input[name=email] (placeholder "Email")'], duplicateIds: ['menu'], mixedContent: [], loadMs: 1800, requests: 64, transferKb: 2400, largeImages: [{ url: 'https://svenson.test/hero.jpg', kb: 900 }] } },
    async request(input) { calls.push(`request ${input.method} ${input.url}`); return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '[{"id":1,"slug":"alopecia-page"}]', truncated: false, ms: 42 } },
    close() { state = null },
  }
  fake = createFakeContext(root, { trackerFormat: () => STANDARD_TRACKER, browser, allowSend: () => allowSend })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const call = (name: string, args: unknown = {}) => callTool(name, args, fake.context)

describe('browser_open', () => {
  it('opens the page under review at a breakpoint, on its own site, and starts a run', async () => {
    const result = await call('browser_open', { breakpoint: 'mobile' })
    expect(result.isError).toBeFalsy()
    expect(opened).toEqual([{ url: 'https://svenson.test/alopecia-page/', site: 'https://svenson.test', breakpoint: 'mobile', width: 390, allowSend: false, runId: expect.stringMatching(/^\d{8}-\d{6}-/) }])
    expect(fake.context.runs.get(opened[0].runId)).toMatchObject({ projectKey: 'proj-1' })
    expect(result.text).toContain('Sending is off')
  })

  it('opens another page of the same site by path, and passes on whether sending is allowed', async () => {
    allowSend = true
    const result = await call('browser_open', { url: '/contact/' })
    expect(opened[0]).toMatchObject({ url: 'https://svenson.test/contact/', allowSend: true, breakpoint: 'desktop', width: 1440 })
    expect(result.text).toContain('Sending is on')
  })

  it('reuses the open run for the next page, and refuses a run from another project', async () => {
    await call('browser_open', {})
    await call('browser_open', { url: '/contact/' })
    expect(opened[1].runId).toBe(opened[0].runId)
    const other = fake.context.runs.create({ projectKey: 'other', projectName: 'Other', pageUrl: 'https://x.test/' })
    expect((await call('browser_open', { runId: other.id })).text).toMatch(/different project/)
  })

  it('needs an open project and the browser', async () => {
    fake.context.reportedContext = () => null
    expect((await call('browser_open', {})).text).toMatch(/No project is open/)
    fake.context.reportedContext = createFakeContext(root).context.reportedContext
    fake.context.browser = undefined
    expect((await call('browser_open', {})).text).toMatch(/browser is not available/)
  })
})

describe('using the page', () => {
  beforeEach(async () => { await call('browser_open', {}) })

  it('describes the page so the agent can act on it, and saves the screenshot for evidence', async () => {
    const result = await call('browser_snapshot')
    expect(result.text).toContain('Page: "Alopecia" — https://svenson.test/alopecia-page/ (HTTP 200)')
    expect(result.text).toContain('Headings: H1 "Alopecia treatment"')
    expect(result.text).toContain('Interactive elements (4 of 40, visible ones first):')
    expect(result.text).toContain('[e1] link "Book an appointment" → /contact/')
    expect(result.text).toContain('[e2] textbox email "Your email" (empty) required (F1)')
    expect(result.text).toContain('[e3] textbox email "Confirm" value "nope" INVALID: Please include an @ (F1) (off screen)')
    expect(result.text).toContain('F1 POST /contact/ · fields e2, e3 · submit e4')
    expect(result.text).toMatch(/Screenshot B2 is attached\. For a finding seen here, give evidence \{ breakpoint, screenshot: "B2"/)
    expect(result.images?.[0]).toMatchObject({ mimeType: 'image/jpeg' })
    expect(fake.context.runs.readBrowserShot(opened[0].runId, 'B2')).toBeTruthy() // B1 was the open
  })

  it('clicks, types, chooses, presses, scrolls and goes back by ref', async () => {
    await call('browser_click', { ref: 'e4' })
    await call('browser_type', { ref: 'e2', text: 'test@example.com', enter: true })
    await call('browser_type', { ref: 'e2', text: 'more', clear: false })
    await call('browser_select', { ref: 'e5', value: 'Alopecia' })
    await call('browser_press', { key: 'Escape' })
    await call('browser_scroll', { to: 'bottom' })
    await call('browser_scroll', { to: 1200 })
    await call('browser_back')
    expect(browser.calls).toEqual(['click e4', 'type e2 test@example.com true true', 'type e2 more false false', 'select e5 Alopecia', 'press Escape', 'scroll bottom', 'scroll 1200', 'back'])
  })

  it('reports what a step caused: errors, failed and blocked requests, dialogs', async () => {
    const result = await call('browser_click', { ref: 'e4' })
    expect(result.text).toContain('a new page opened')
    expect(result.text).toContain('1 console error(s): "Uncaught TypeError: x is undefined"')
    expect(result.text).toContain('1 failed request(s): 404 GET https://svenson.test/missing.png')
    expect(result.text).toContain('Parity blocked 1: form submission POST https://svenson.test/contact/ (sending data is off (Settings → AI Agents))')
    expect(result.text).toContain('Dialogs (answered OK): alert "Thanks!"')
  })

  it('refuses refs and keys that are not real', async () => {
    expect((await call('browser_click', { ref: 'button' })).isError).toBe(true)
    expect((await call('browser_press', { key: 'F12' })).isError).toBe(true)
  })

  it('lists everything since the page opened', async () => {
    expect((await call('browser_events')).text).toContain('1 console warning(s): "jQuery migrate"')
  })

  it('checks links and sorts them for the agent', async () => {
    const text = (await call('check_links')).text
    expect(text).toContain('Checked 4 link(s) of 7 unique on the page.')
    expect(text).toContain('Broken (2):')
    expect(text).toContain('- 404 "Old page" https://svenson.test/old/')
    expect(text).toContain('- no answer within 10 seconds "Partner" https://down.test/')
    expect(text).toContain('- "Moved" https://svenson.test/moved → https://svenson.test/new/')
    expect(text).toContain('Placeholder links that go nowhere (1):')
    expect(text).toContain('Admin, login or logout links, not requested (1).')
  })

  it('audits SEO and accessibility basics in plain words', async () => {
    const text = (await call('page_audit')).text
    expect(text).toContain('Meta description (0 chars): MISSING')
    expect(text).toContain('NOINDEX')
    expect(text).toContain('Language: NOT SET')
    expect(text).toContain('H1: "A", "B" (more than one)')
    expect(text).toContain('Skipped heading levels: H1 → H3 "Why"')
    expect(text).toContain('Images without alt (1): https://svenson.test/hero.jpg')
    expect(text).toContain('Large images (over 300 KB): 900 KB https://svenson.test/hero.jpg')
  })

  it('calls the site\'s API and shows JSON readably', async () => {
    const result = await call('http_request', { method: 'GET', url: '/wp-json/wp/v2/pages' })
    expect(browser.calls).toContain('request GET /wp-json/wp/v2/pages')
    expect(result.text).toContain('GET /wp-json/wp/v2/pages → 200 OK in 42 ms')
    expect(result.text).toContain('"slug": "alopecia-page"')
  })
})

describe('findings from testing', () => {
  it('get their browser screenshot as evidence on the approval card', async () => {
    const opened = await call('browser_open', {})
    const runId = /run (\S+)/.exec(opened.text)![1]
    const rows = [{ cells: { Section: 'Contact form', Remarks: 'form shows no error for an invalid email', Display: 'Desktop' }, evidence: { breakpoint: 'desktop' as const, screenshot: 'B1', live: { x: 100, y: 200, width: 300, height: 60 } } }]
    const result = await call('finalize_rows', { runId, rows })
    expect(result.text).toContain('Copied 1 row(s)')
    expect(fake.approvals[0].evidence).toHaveLength(1)
    expect(fake.approvals[0].evidence[0].thumbnail).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('refuses a screenshot name that is not one', async () => {
    const opened = await call('browser_open', {})
    const runId = /run (\S+)/.exec(opened.text)![1]
    expect((await call('save_draft', { runId, breakpoint: 'desktop', rows: [{ cells: { Remarks: 'x' }, evidence: { breakpoint: 'desktop', screenshot: '../../etc/passwd' } }] })).isError).toBe(true)
  })
})
