import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createDesignStore } from '../designStore'
import type { ApprovalDecision, ApprovalRequest, ReportedContext } from '../../shared/qaAgent'
import { designKeyOf } from '../../shared/designKey'
import { parseTrackerPaste, parseTsv, type TrackerFormat } from '../../shared/trackerFormat'
import type { LiveCaptureOptions, LiveCaptureResult, LiveNode } from './liveCapture'
import { createRunStore } from './runStore'
import { callTool, QA_TOOLS, type QaContext, type ToolResult } from './tools'

const bands = async (width: number, height: number) => {
  const colors = ['#cc3333', '#33cc33', '#3333cc']
  const h = Math.ceil(height / 3)
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(await Promise.all(colors.map(async (c, i) => ({ input: await sharp({ create: { width, height: Math.min(h, height - i * h), channels: 3, background: c } }).png().toBuffer(), top: i * h, left: 0 }))))
    .png().toBuffer()
}

const styles = { fontFamily: 'Arial, sans-serif', fontSize: '32px', fontWeight: '700', lineHeight: '38px', letterSpacing: 'normal', color: 'rgb(17, 17, 17)', textAlign: 'left', textTransform: 'none', textDecoration: 'none', display: 'block', position: 'static', opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', padding: '0', margin: '0', gap: 'normal', border: '0 none rgb(0, 0, 0)', borderRadius: '0px', shadow: 'none', flex: '' }
const node = (text: string, y: number, sectionId: string): LiveNode => ({ tag: 'h2', text, rect: { x: 40, y, width: 600, height: 40 }, path: 'p', styles, sectionId })

const fakeCapture = async (options: LiveCaptureOptions): Promise<LiveCaptureResult> => ({
  png: await bands(options.width, 3000),
  width: options.width, viewportHeight: 1024, documentHeight: 3000, capturedHeight: 3000, truncated: false, tiles: 3, mode: 'cdp',
  finalUrl: options.url, title: 'Fixture', warnings: ['Content overflows the page horizontally (1540px wide in a 1440px view).'],
  sections: [
    { id: 'S1', label: 'Hero', tag: 'section', selector: 'section.hero', top: 0, height: 1000 },
    { id: 'S2', label: 'Basics', tag: 'section', selector: 'section.basics', top: 1000, height: 1000 },
    { id: 'S3', label: 'Contact', tag: 'section', selector: 'section.contact', top: 2000, height: 1000, bgFixed: true },
  ],
  nodes: [node('Hero heading', 100, 'S1'), node('Basics heading', 1100, 'S2'), node('Contact heading', 2100, 'S3')],
  page: { lang: 'en', viewportMeta: 'width=device-width', fontsFailed: [], bodyClass: '' },
})

const tracker = (): TrackerFormat => {
  const parsed = parseTrackerPaste('Page\tIssue\tExpected\tScreenshot\tSeverity\nHome\tHeading too small\t32px\thttps://x.test/a\tHigh')
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.format
}

const reported = (over: Partial<ReportedContext> = {}): ReportedContext => ({ projectKey: 'proj-1', project: { id: 'proj-1', name: '[Svenson] Alopecia', stagingUrl: 'https://svenson.test/' }, pageUrl: 'https://svenson.test/alopecia-page/', workspaceTab: 'editBeta', breakpoint: 'desktop', viewport: { width: 1920, height: 1200 }, reportedAt: 1, ...over })

let root: string
let designStore: ReturnType<typeof createDesignStore>
let context: QaContext
let clipboard: Array<{ text: string; html: string }>
let approvals: ApprovalRequest[]
let decision: ApprovalDecision
let currentContext: ReportedContext | null
let format: TrackerFormat | null
let capture: Mock<(options: LiveCaptureOptions) => Promise<LiveCaptureResult>>
let tick = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'parity-tools-'))
  designStore = createDesignStore(join(root, 'designs'))
  clipboard = []; approvals = []; decision = { approved: true }; currentContext = reported(); format = tracker(); tick = 1_800_000_000_000
  capture = vi.fn(fakeCapture)
  context = {
    now: () => ++tick,
    reportedContext: () => currentContext,
    designs: {
      list: (key) => designStore.list(key),
      put: (key, bytes, options) => designStore.put(key, bytes, options),
      readNormalized: async (key, bp) => { const p = await designStore.normalizedPath(key, bp); return p ? readFileSync(p) : null },
    },
    runs: createRunStore(join(root, 'runs'), () => 1_800_000_000_000 + tick),
    capture: (options) => capture(options),
    trackerFormat: () => format,
    readLocalFile: async (path) => readFileSync(path),
    approve: async (request) => { approvals.push(request); return decision },
    copyToClipboard: (text, html) => { clipboard.push({ text, html }) },
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool(name, args, context)
const runIdOf = (result: ToolResult) => /Run (\S+) ·/.exec(result.text)![1]
// Designs are kept per page; this is the page the fixture has open.
const PAGE_KEY = designKeyOf('proj-1', reported().pageUrl)
const addDesign = async (bp: 'desktop' | 'tablet' | 'mobile' = 'desktop', width = 2880, height = 6000) => designStore.put(PAGE_KEY, await bands(width, height), { target: bp })

describe('tool registry', () => {
  it('lists the tools and marks only the ones with side effects', () => {
    expect(QA_TOOLS.map((tool) => tool.name)).toEqual(['get_context', 'set_design', 'capture_live', 'get_overview', 'get_section', 'save_draft', 'finalize_rows', 'read_result', 'read_chat_images', 'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_back', 'browser_events', 'check_links', 'page_audit', 'inspect_element', 'check_contrast', 'check_layout', 'style_summary', 'check_text', 'seo_check', 'http_request', 'parity_help', 'parity_context', 'workspace_search', 'workspace_detail', 'workspace_open', 'workspace_propose', 'workspace_action_status'])
    // The browser tools that click, type or send change the page; the browser's own rules keep them safe.
    expect(QA_TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name)).toEqual(['set_design', 'finalize_rows', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'http_request', 'workspace_open', 'workspace_propose'])
    expect(QA_TOOLS.filter((tool) => !tool.agentAllowed).map((tool) => tool.name)).toEqual(['set_design'])
  })

  it('rejects unknown tools and invalid input without running anything', async () => {
    expect(await call('delete_everything')).toMatchObject({ isError: true, text: expect.stringContaining('Unknown tool') })
    const bad = await call('get_section', { runId: 'x', breakpoint: 'phone', section: 'S1' })
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining('Invalid input for get_section') })
    expect(capture).not.toHaveBeenCalled()
  })

  it('turns a thrown error into an error result', async () => {
    context.trackerFormat = () => { throw new Error('boom') }
    expect(await call('get_context')).toMatchObject({ isError: true, text: expect.stringContaining('boom') })
  })
})

describe('get_context', () => {
  it('explains what is missing', async () => {
    currentContext = null; format = null
    const info = JSON.parse((await call('get_context')).text)
    expect(info.project).toBeNull()
    expect(info.notes.join(' ')).toMatch(/No project is open/)
    expect(info.notes.join(' ')).toMatch(/tracker format is not set/)
  })

  it('reports the open page\'s designs and the tracker', async () => {
    await designStore.put(PAGE_KEY, await bands(1440, 3000), { target: 'desktop', fileName: 'home.png', pagePath: '/alopecia-page' })
    const info = JSON.parse((await call('get_context')).text)
    expect(info.project).toEqual({ name: '[Svenson] Alopecia', stagingUrl: 'https://svenson.test/' })
    expect(info.designsAreFor).toBe('/alopecia-page')
    expect(info.designs.desktop).toMatchObject({ frameWidth: 1440, exportScale: 1, file: 'home.png', forPage: '/alopecia-page' })
    expect(info.designs.tablet).toBeNull()
    expect(info.tracker).toMatchObject({ columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'], screenshotColumn: 'Screenshot' })
    expect(info.evidenceUploads.available).toBe(false)
    expect(info.notes.join(' ')).not.toMatch(/No designs are stored/)
  })

  it('uses the designs of whichever page is open, and says when that page has none', async () => {
    await addDesign('desktop')
    const first = JSON.parse((await call('get_context')).text)
    expect(first.designs.desktop).not.toBeNull()

    currentContext = reported({ pageUrl: 'https://svenson.test/contact/' })
    const second = JSON.parse((await call('get_context')).text)
    expect(second.designsAreFor).toBe('/contact')
    expect(second.designs.desktop).toBeNull()
    expect(second.notes.join(' ')).toMatch(/No designs are stored for this page \(\/contact\), so review it on its own\. That is fine; do not ask for a design\./)

    // A design added now belongs to the contact page only.
    await designStore.put(designKeyOf('proj-1', 'https://svenson.test/contact/'), await bands(1440, 3000), { target: 'desktop', fileName: 'contact.png' })
    expect(JSON.parse((await call('get_context')).text).designs.desktop.file).toBe('contact.png')
    currentContext = reported()
    // Back on the first page: its own design (a 2x export), not the contact page's.
    expect(JSON.parse((await call('get_context')).text).designs.desktop).toMatchObject({ exportScale: 2, file: null })
  })
})

describe('capture_live', () => {
  it('needs an open project', async () => {
    currentContext = null
    expect(await call('capture_live', { breakpoint: 'desktop' })).toMatchObject({ isError: true })
  })

  it('captures at the design width, starts a run bound to the open page and returns an overview', async () => {
    await addDesign('desktop', 2880, 6000)
    const result = await call('capture_live', { breakpoint: 'desktop' })
    expect(result.isError).toBeUndefined()
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://svenson.test/alopecia-page/', breakpoint: 'desktop', width: 1440 }))
    expect(result.images).toHaveLength(1)
    expect(result.images![0].mimeType).toBe('image/jpeg')
    expect(result.text).toContain('Design: 1440px wide frame (2x export), 3000px tall in CSS px.')
    expect(result.text).toContain('S1 "Hero" y 0–1000')
    expect(result.text).toContain('S3 "Contact" y 2000–3000 (fixed background)')
    expect(result.text).toContain('design y ≈ 0–1000')
    expect(result.text).toContain('Content overflows the page horizontally')
  })

  it('falls back to a default width and says so when there is no design', async () => {
    const result = await call('capture_live', { breakpoint: 'mobile' })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ width: 390 }))
    expect(result.text).toContain('No mobile design is stored')
  })

  it('reuses a captured breakpoint unless refreshed, and keeps a run on its own page and project', async () => {
    const first = await call('capture_live', { breakpoint: 'desktop' })
    const runId = runIdOf(first)
    currentContext = reported({ pageUrl: 'https://svenson.test/another/' })
    const again = await call('capture_live', { breakpoint: 'desktop', runId })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(again.text).toContain('already captured')
    await call('capture_live', { breakpoint: 'desktop', runId, refresh: true })
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://svenson.test/alopecia-page/' }))
    await call('capture_live', { breakpoint: 'tablet', runId })
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://svenson.test/alopecia-page/', width: 834 }))
    currentContext = reported({ projectKey: 'other-project' })
    expect(await call('capture_live', { breakpoint: 'desktop', runId })).toMatchObject({ isError: true, text: expect.stringContaining('different project') })
    expect(await call('capture_live', { breakpoint: 'desktop', runId: '20990101-000000-nope-abcd' })).toMatchObject({ isError: true })
  })

  it('reports a failed capture as an error result', async () => {
    capture.mockRejectedValueOnce(new Error('The page redirected to the WordPress login.'))
    expect(await call('capture_live', { breakpoint: 'desktop' })).toMatchObject({ isError: true, text: expect.stringContaining('WordPress login') })
  })
})

describe('get_section', () => {
  let runId: string
  beforeEach(async () => { await addDesign('desktop', 2880, 6000); runId = runIdOf(await call('capture_live', { breakpoint: 'desktop' })) })

  it('returns the design and live crops with that section\'s computed values', async () => {
    const result = await call('get_section', { runId, breakpoint: 'desktop', section: 'S2', designTop: 900, designBottom: 1900 })
    expect(result.isError).toBeUndefined()
    expect(result.images).toHaveLength(2)
    // A 1000px section at 1440px wide needs two parts (798px per picture), so part 1 is the first half plus overlap.
    expect(result.images!.map((image) => image.caption)).toEqual(['Design, y 900–1424', 'Live, y 1000–1524'])
    expect(result.images!.every((image) => image.file && existsSync(image.file))).toBe(true)
    expect(result.text).toContain('Section S2 "Basics" · desktop · part 1 of 2')
    expect(result.text).toContain('#1 h2 "Basics heading" x40 y1100 w600 h40 | Arial 32/38 700 #111111')
    expect(result.text).not.toContain('Hero heading')
    expect(result.text).toContain('Image 1 is the design, image 2 is the live page')
  })

  it('remembers the design range and splits tall sections into parts', async () => {
    await call('get_section', { runId, breakpoint: 'desktop', section: 'S2', designTop: 900, designBottom: 1900 })
    const second = await call('get_section', { runId, breakpoint: 'desktop', section: 'S2', part: 2 })
    expect(second.text).toContain('part 2 of 2')
    expect(second.text).toContain('as chosen earlier')
    expect(await call('get_section', { runId, breakpoint: 'desktop', section: 'S2', part: 3 })).toMatchObject({ isError: true })
  })

  it('guesses a proportional design range when none is given', async () => {
    const result = await call('get_section', { runId, breakpoint: 'desktop', section: 'S1' })
    expect(result.text).toContain('proportional guess')
    expect(result.images).toHaveLength(2)
  })

  it('rejects unknown sections, bad ranges and missing captures', async () => {
    expect(await call('get_section', { runId, breakpoint: 'desktop', section: 'S9' })).toMatchObject({ isError: true, text: expect.stringContaining('S1, S2, S3') })
    expect(await call('get_section', { runId, breakpoint: 'desktop', section: 'S1', designTop: 500, designBottom: 400 })).toMatchObject({ isError: true })
    expect(await call('get_section', { runId, breakpoint: 'mobile', section: 'S1' })).toMatchObject({ isError: true, text: expect.stringContaining('capture_live') })
  })

  it('shows only the live page when there is no design', async () => {
    const id = runIdOf(await call('capture_live', { breakpoint: 'tablet' }))
    const result = await call('get_section', { runId: id, breakpoint: 'tablet', section: 'S1' })
    expect(result.images).toHaveLength(1)
    expect(result.text).toContain('no design for this breakpoint')
  })
})

describe('get_overview', () => {
  it('returns the overview again by part', async () => {
    const runId = runIdOf(await call('capture_live', { breakpoint: 'desktop' }))
    const result = await call('get_overview', { runId, breakpoint: 'desktop' })
    expect(result.images).toHaveLength(1)
    expect(await call('get_overview', { runId, breakpoint: 'desktop', part: 5 })).toMatchObject({ isError: true })
  })
})

describe('save_draft', () => {
  it('saves valid rows and refuses columns the tracker does not have', async () => {
    const runId = runIdOf(await call('capture_live', { breakpoint: 'desktop' }))
    expect(await call('save_draft', { runId, breakpoint: 'desktop', rows: [{ cells: { Page: 'Home', Issue: 'x' } }] })).toMatchObject({ text: expect.stringContaining('Saved 1 draft row') })
    expect(context.runs.readDrafts(runId).desktop).toHaveLength(1)
    expect(await call('save_draft', { runId, breakpoint: 'desktop', rows: [{ cells: { Colour: 'x' } }] })).toMatchObject({ isError: true, text: expect.stringContaining('Page, Issue') })
  })
})

describe('finalize_rows', () => {
  let runId: string
  const rows = [
    { cells: { Page: 'Home', Issue: 'Heading is 28px, expected 32px', Expected: '32px', Severity: 'High' }, evidence: { breakpoint: 'desktop' as const, section: 'S1', live: { x: 40, y: 100, width: 600, height: 40 }, caption: 'Hero heading too small' } },
    { cells: { Page: 'Home', Issue: '- Button label differs', Severity: 'Low' } },
    { cells: { Page: 'Home', Issue: '=IMAGE("https://evil.test/x")', Severity: 'High' } },
  ]
  beforeEach(async () => { await addDesign('desktop', 2880, 6000); runId = runIdOf(await call('capture_live', { breakpoint: 'desktop' })) })

  it('needs the tracker format', async () => {
    format = null
    expect(await call('finalize_rows', { runId, rows })).toMatchObject({ isError: true, text: expect.stringContaining('tracker format') })
    expect(approvals).toHaveLength(0)
  })

  it('asks for approval first, and copies nothing when the person rejects', async () => {
    decision = { approved: false, note: 'Heading size is correct on the design' }
    const result = await call('finalize_rows', { runId, rows })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ runId, projectName: '[Svenson] Alopecia', columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'], severityCounts: {}, uploadsEvidence: false })
    expect(approvals[0].rows[1][1]).toBe('- Button label differs') // shown as written, without the clipboard apostrophe
    expect(approvals[0].evidence).toHaveLength(1)
    expect(approvals[0].evidence[0].thumbnail).toMatch(/^data:image\/jpeg;base64,/)
    expect(result.text).toContain('did not approve')
    expect(result.text).toContain('Heading size is correct on the design')
    expect(clipboard).toHaveLength(0)
  })

  it('on approval copies rows in column order with formulas neutralised, and saves a copy', async () => {
    const result = await call('finalize_rows', { runId, rows })
    expect(result.isError).toBeUndefined()
    expect(clipboard).toHaveLength(1)
    const parsed = parseTsv(clipboard[0].text)
    expect(parsed[0]).toEqual(['Home', 'Heading is 28px, expected 32px', '32px', '', ''])
    expect(parsed[1]).toEqual(['Home', "'- Button label differs", '', '', ''])
    expect(parsed[2][1]).toBe('\'=IMAGE("https://evil.test/x")')
    expect(clipboard[0].html).toContain('<table>')
    expect(result.text).toContain('Copied 3 row(s) to the clipboard')
    expect(result.text).toContain('Evidence images were not uploaded: Evidence uploads are not set up yet.')
    expect(result.text).toContain('They were saved on this computer')
    const saved = /saved at (\S+\.tsv)/.exec(result.text)![1]
    expect(readFileSync(saved, 'utf8')).toBe(clipboard[0].text)
  })

  it('uploads evidence after approval and puts the links in the screenshot column', async () => {
    const upload = vi.fn(async (items: Array<{ name: string }>) => items.map((item) => ({ url: `https://evidence.test/${item.name}` })))
    context.evidence = { unavailableReason: () => null, upload }
    const result = await call('finalize_rows', { runId, rows })
    expect(approvals[0].uploadsEvidence).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toHaveLength(1)
    const cells = clipboard[0].text.split('\n')[0].split('\t')
    expect(cells[3]).toMatch(/^https:\/\/evidence\.test\/evidence-\d+-row-01\.webp$/)
    expect(result.text).toContain('Uploaded 1 of 1 evidence image(s)')
  })

  it('copies and uploads only the rows the person kept, and tells the agent which were left out', async () => {
    const upload = vi.fn(async (items: Array<{ name: string; label: string }>) => items.map((item) => ({ url: `https://evidence.test/${item.name}` })))
    context.evidence = { unavailableReason: () => null, upload }
    decision = { approved: true, excludedRows: [1] }
    const result = await call('finalize_rows', { runId, rows })
    const copied = parseTsv(clipboard[0].text)
    expect(copied.map((row) => row[1])).toEqual(['Heading is 28px, expected 32px', '\'=IMAGE("https://evil.test/x")'])
    expect(upload.mock.calls[0][0]).toHaveLength(1)
    expect(copied[0][3]).toMatch(/^https:\/\/evidence\.test\//)
    expect(result.text).toContain('Copied 2 row(s)')
    expect(result.text).toContain('The person left out 1 row(s): 2.')
  })

  it('uploads nothing for a left-out row with a picture', async () => {
    const upload = vi.fn(async () => [])
    context.evidence = { unavailableReason: () => null, upload }
    decision = { approved: true, excludedRows: [0] }
    await call('finalize_rows', { runId, rows })
    expect(upload).not.toHaveBeenCalled()
    expect(parseTsv(clipboard[0].text)).toHaveLength(2)
  })

  it('copies nothing when every row is left out', async () => {
    decision = { approved: true, excludedRows: [0, 1, 2] }
    const result = await call('finalize_rows', { runId, rows })
    expect(clipboard).toHaveLength(0)
    expect(result.text).toBe('The person approved but left out every row, so nothing was copied or uploaded.')
  })

  it('ignores left-out indexes that do not exist', async () => {
    decision = { approved: true, excludedRows: [-1, 7, 1.5] }
    await call('finalize_rows', { runId, rows })
    expect(parseTsv(clipboard[0].text)).toHaveLength(3)
  })

  it('keeps a record of every hand-over in the run, with the decision', async () => {
    const upload = vi.fn(async (items: Array<{ name: string }>) => items.map((item) => ({ url: `https://evidence.test/${item.name}` })))
    context.evidence = { unavailableReason: () => null, upload }
    decision = { approved: true, excludedRows: [2] }
    await call('finalize_rows', { runId, rows })
    decision = { approved: false, note: 'too many' }
    await call('finalize_rows', { runId, rows })
    const folder = context.runs.outputDir(runId)
    const records = readdirSync(folder).filter((name) => name.startsWith('handover-')).sort().map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')))
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ status: 'approved', excludedRows: [2], copiedRows: 2, columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'], projectName: '[Svenson] Alopecia' })
    expect(records[0].rows[2][1]).toBe('=IMAGE("https://evil.test/x")') // as shown, not as pasted
    expect(records[0].evidence).toEqual([{ rowIndex: 0, file: expect.stringMatching(/^evidence-\d+-row-01\.webp$/), caption: expect.any(String) }])
    expect(records[0].links['0']).toMatch(/^https:\/\/evidence\.test\//)
    expect(existsSync(join(folder, records[0].evidence[0].file))).toBe(true)
    expect(records[1]).toMatchObject({ status: 'rejected', note: 'too many' })
  })

  it('labels each uploaded picture with its finding, for the viewer page', async () => {
    const upload = vi.fn(async (items: Array<{ name: string; label: string }>) => items.map(() => ({ url: 'https://evidence.test/x' })))
    context.evidence = { unavailableReason: () => null, upload }
    await call('finalize_rows', { runId, rows })
    expect(upload.mock.calls[0][0][0].label).toBe('Heading is 28px, expected 32px')
  })

  it('does not upload when the person has not signed in, and says why', async () => {
    const upload = vi.fn()
    context.evidence = { unavailableReason: () => 'Sign in to Parity to upload evidence.', upload }
    const result = await call('finalize_rows', { runId, rows })
    expect(upload).not.toHaveBeenCalled()
    expect(clipboard).toHaveLength(1)
    expect(approvals[0].warnings.join(' ')).toContain('Sign in to Parity')
    expect(result.text).toContain('Copied 3 row(s)')
  })

  it('keeps going when an upload fails and says which row', async () => {
    context.evidence = { unavailableReason: () => null, upload: async (items) => items.map(() => ({ error: 'network down' })) }
    const result = await call('finalize_rows', { runId, rows })
    expect(clipboard[0].text.split('\n')[0].split('\t')[3]).toBe('')
    expect(result.text).toContain('Row 1: evidence not uploaded (network down).')
  })

  it('skips uploads when asked not to', async () => {
    const upload = vi.fn()
    context.evidence = { unavailableReason: () => null, upload }
    await call('finalize_rows', { runId, rows, uploadEvidence: false })
    expect(upload).not.toHaveBeenCalled()
    expect(approvals[0].uploadsEvidence).toBe(false)
  })

  it('refuses unknown columns before asking anyone', async () => {
    const result = await call('finalize_rows', { runId, rows: [{ cells: { Colour: 'red' } }] })
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('not in the tracker') })
    expect(approvals).toHaveLength(0)
  })

  it('refuses a run from another project', async () => {
    currentContext = reported({ projectKey: 'someone-else' })
    expect(await call('finalize_rows', { runId, rows })).toMatchObject({ isError: true })
    expect(approvals).toHaveLength(0)
  })
})

describe('set_design', () => {
  it('stores an image from disk for a breakpoint', async () => {
    const file = join(root, 'home-mobile@2x.png')
    writeFileSync(file, await bands(780, 3000))
    const result = await call('set_design', { path: file })
    expect(result.text).toContain('Stored as the mobile design: 390px wide frame, export scale 2x')
    expect(designStore.list(PAGE_KEY).mobile?.fileName).toBe('home-mobile@2x.png')
    expect(designStore.list(PAGE_KEY).mobile?.pagePath).toBe('/alopecia-page')
    expect((await call('set_design', { path: file })).text).toContain('Already stored')
  })

  it('refuses relative paths, non-images and unreadable files', async () => {
    expect(await call('set_design', { path: 'design.png' })).toMatchObject({ isError: true })
    const text = join(root, 'notes.txt'); writeFileSync(text, 'x')
    expect(await call('set_design', { path: text })).toMatchObject({ isError: true })
    expect(await call('set_design', { path: join(root, 'missing.png') })).toMatchObject({ isError: true })
    const fake = join(root, 'fake.png'); writeFileSync(fake, 'not an image')
    expect(await call('set_design', { path: fake })).toMatchObject({ isError: true })
  })
})
