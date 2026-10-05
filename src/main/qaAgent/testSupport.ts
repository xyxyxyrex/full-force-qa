// Shared fixtures for tests that need a working QaContext without Electron.
import { readFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { createDesignStore } from '../designStore'
import { designKeyOf } from '../../shared/designKey'
import { parseTrackerPaste } from '../../shared/trackerFormat'
import type { ApprovalDecision, ApprovalRequest, ReportedContext } from '../../shared/qaAgent'
import type { LiveCaptureOptions, LiveCaptureResult } from './liveCapture'
import { createRunStore } from './runStore'
import type { QaContext } from './tools'

export const bands = async (width: number, height: number): Promise<Buffer> => {
  const colors = ['#cc3333', '#33cc33', '#3333cc']
  const h = Math.ceil(height / 3)
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(await Promise.all(colors.map(async (c, i) => ({ input: await sharp({ create: { width, height: Math.min(h, height - i * h), channels: 3, background: c } }).png().toBuffer(), top: i * h, left: 0 }))))
    .png().toBuffer()
}

export const fakeCapture = async (options: LiveCaptureOptions): Promise<LiveCaptureResult> => ({
  png: await bands(options.width, 3000),
  width: options.width, viewportHeight: 1024, documentHeight: 3000, capturedHeight: 3000, truncated: false, tiles: 3, mode: 'cdp',
  finalUrl: options.url, title: 'Fixture', warnings: [],
  sections: [
    { id: 'S1', label: 'Hero', tag: 'section', selector: 'section.hero', top: 0, height: 1000 },
    { id: 'S2', label: 'Basics', tag: 'section', selector: 'section.basics', top: 1000, height: 1000 },
    { id: 'S3', label: 'Contact', tag: 'section', selector: 'section.contact', top: 2000, height: 1000 },
  ],
  nodes: [],
  page: { lang: 'en', viewportMeta: 'width=device-width', fontsFailed: [], bodyClass: '' },
})

export const TRACKER_PASTE = 'Page\tIssue\tExpected\tScreenshot\tSeverity\nHome\tHeading too small\t32px\thttps://x.test/a\tHigh'

export const reportedContext = (over: Partial<ReportedContext> = {}): ReportedContext => ({
  projectKey: 'proj-1', project: { id: 'proj-1', name: '[Svenson] Alopecia', stagingUrl: 'https://svenson.test/' },
  pageUrl: 'https://svenson.test/alopecia-page/', workspaceTab: 'editBeta', breakpoint: 'desktop', viewport: { width: 1920, height: 1200 }, reportedAt: 1, ...over,
})

/** Where the designs of the fixture page are kept. */
export const PAGE_DESIGN_KEY = designKeyOf('proj-1', 'https://svenson.test/alopecia-page/')

export interface FakeContext {
  context: QaContext
  designs: ReturnType<typeof createDesignStore>
  clipboard: Array<{ text: string; html: string }>
  approvals: ApprovalRequest[]
  setDecision(decision: ApprovalDecision): void
}

export function createFakeContext(root: string, over: Partial<QaContext> = {}): FakeContext {
  const designs = createDesignStore(join(root, 'designs'))
  const clipboard: FakeContext['clipboard'] = []
  const approvals: ApprovalRequest[] = []
  let decision: ApprovalDecision = { approved: true }
  let tick = 1_800_000_000_000
  const parsed = parseTrackerPaste(TRACKER_PASTE)
  if (!parsed.ok) throw new Error('fixture tracker')
  let target: ReportedContext | null = null
  const context: QaContext = {
    now: () => ++tick,
    reportedContext: () => target ?? reportedContext(),
    setTarget: (next) => { target = next },
    designs: {
      list: (key) => designs.list(key),
      put: (key, bytes, options) => designs.put(key, bytes, options),
      readNormalized: async (key, bp) => { const p = await designs.normalizedPath(key, bp); return p ? readFileSync(p) : null },
    },
    runs: createRunStore(join(root, 'runs'), () => 1_800_000_000_000 + tick),
    capture: fakeCapture,
    trackerFormat: () => parsed.format,
    readLocalFile: async (path) => readFileSync(path),
    approve: async (request) => { approvals.push(request); return decision },
    copyToClipboard: (text, html) => { clipboard.push({ text, html }) },
    ...over,
  }
  return { context, designs, clipboard, approvals, setDecision: (next) => { decision = next } }
}
