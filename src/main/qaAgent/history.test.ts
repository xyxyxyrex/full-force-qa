import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_TRACKER } from '../../shared/trackerFormat'
import { createRunHistory } from './history'
import { createRunStore } from './runStore'
import { createFakeContext, type FakeContext } from './testSupport'
import { callTool } from './tools'

let root: string
let fake: FakeContext
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'parity-history-'))
  fake = createFakeContext(root, { trackerFormat: () => STANDARD_TRACKER })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const history = () => createRunHistory({ runs: fake.context.runs, trackerFormat: () => STANDARD_TRACKER })
const capture = async () => /Run (\S+) ·/.exec((await callTool('capture_live', { breakpoint: 'desktop' }, fake.context)).text)![1]
const row = (section: string, remarks: string, withPicture = true) => ({ cells: { Section: section, Remarks: remarks, Display: 'Desktop' }, ...(withPicture ? { evidence: { breakpoint: 'desktop' as const, section: 'S1' } } : {}) })

describe('Past reviews', () => {
  it('lists runs newest first with what they captured, drafted and handed over', async () => {
    const first = await capture()
    await callTool('save_draft', { runId: first, breakpoint: 'desktop', rows: [row('Hero', 'wrong image'), row('Footer', 'font size should be 13px', false)] }, fake.context)
    fake.setDecision({ approved: true, excludedRows: [1] })
    await callTool('finalize_rows', { runId: first, rows: [row('Hero', 'wrong image'), row('Footer', 'font size should be 13px', false)] }, fake.context)
    const second = await capture()
    const list = history().list()
    expect(list.map((run) => run.id)).toEqual([second, first])
    expect(list[1]).toMatchObject({ id: first, projectName: '[Svenson] Alopecia', breakpoints: ['desktop'], drafted: 2, pinned: false })
    expect(list[1].handovers).toEqual([{ stamp: expect.stringMatching(/^\d+$/), status: 'approved', rows: 2, copied: 1 }])
    expect(list[0]).toMatchObject({ drafted: 0, handovers: [] })
  })

  it('shows a run\'s hand-overs and drafts in tracker order, with their pictures on demand', async () => {
    const runId = await capture()
    await callTool('save_draft', { runId, breakpoint: 'desktop', rows: [row('Hero', 'wrong image'), row('Footer', 'x', false)] }, fake.context)
    fake.setDecision({ approved: false, note: 'not now' })
    await callTool('finalize_rows', { runId, rows: [row('Hero', 'wrong image')] }, fake.context)
    const detail = history().detail(runId)!
    expect(detail.columns).toEqual(STANDARD_TRACKER.columns)
    expect(detail.handovers).toHaveLength(1)
    expect(detail.handovers[0]).toMatchObject({ status: 'rejected', note: 'not now' })
    expect(detail.drafts).toEqual([{ breakpoint: 'desktop', rows: [
      { cells: expect.arrayContaining(['Hero', 'wrong image', 'Desktop']), hasPicture: true },
      { cells: expect.arrayContaining(['Footer', 'x']), hasPicture: false },
    ] }])
    expect(detail.drafts[0].rows[0].cells[STANDARD_TRACKER.columns.indexOf('Remarks')]).toBe('wrong image')

    const handoverPicture = await history().picture(runId, { kind: 'handover', file: detail.handovers[0].evidence[0].file })
    expect(handoverPicture).toMatch(/^data:image\/jpeg;base64,/)
    expect(await history().picture(runId, { kind: 'draft', breakpoint: 'desktop', index: 0 })).toMatch(/^data:image\/jpeg;base64,/)
    expect(await history().picture(runId, { kind: 'draft', breakpoint: 'desktop', index: 1 })).toBeNull() // no evidence was given
    expect(await history().picture(runId, { kind: 'draft', breakpoint: 'mobile', index: 0 })).toBeNull()
  })

  it('refuses pictures outside the run\'s evidence files', async () => {
    const runId = await capture()
    for (const file of ['../run.json', 'desktop/live.png', '/etc/passwd', 'evidence-1-row-01.webp.exe']) {
      expect(await history().picture(runId, { kind: 'handover', file })).toBeNull()
    }
    expect(await history().picture('not-a-run', { kind: 'handover', file: 'evidence-1-row-01.webp' })).toBeNull()
  })

  it('rebuilds hand-overs from before records existed, from the copied rows and saved pictures', async () => {
    const runId = await capture()
    const output = fake.context.runs.outputDir(runId)
    const columns = STANDARD_TRACKER.columns
    const pasted = [
      columns.map((name) => ({ 'Page Link': 'https://svenson.test/a', Section: 'Hero', Remarks: "'- stray dash", Screenshot: 'https://parity-gfx.pages.dev/?evidence=AbCdEfGhIjKlMnOpQrStUv', Display: 'Desktop' } as Record<string, string>)[name] ?? ''),
      columns.map((name) => ({ Section: 'Footer', Remarks: 'wrong image' } as Record<string, string>)[name] ?? ''),
    ]
    writeFileSync(join(output, 'rows-1791174398615.tsv'), pasted.map((row) => row.join('\t')).join('\n'))
    writeFileSync(join(output, 'evidence-1791174398615-row-01.webp'), await sharp({ create: { width: 40, height: 20, channels: 3, background: '#a00' } }).webp().toBuffer())
    const record = history().detail(runId)!.handovers[0]
    expect(record).toMatchObject({ stamp: '1791174398615', status: 'approved', createdAt: 1791174398615, copiedRows: 2, columns })
    expect(record.rows[0][columns.indexOf('Remarks')]).toBe('- stray dash') // shown without the apostrophe that kept it from being a formula
    expect(record.evidence).toEqual([{ rowIndex: 0, file: 'evidence-1791174398615-row-01.webp', caption: '' }])
    expect(record.links).toEqual({ 0: 'https://parity-gfx.pages.dev/?evidence=AbCdEfGhIjKlMnOpQrStUv' })
    expect(await history().picture(runId, { kind: 'handover', file: 'evidence-1791174398615-row-01.webp' })).toMatch(/^data:image\/jpeg/)
    const copied = history().copiedRows(runId, '1791174398615')!
    expect(copied.count).toBe(2)
    expect(copied.text.split('\n')[0]).toContain("'- stray dash") // copied again exactly as first pasted
  })

  it('skips a damaged record and copies nothing for an unknown hand-over', async () => {
    const runId = await capture()
    const output = fake.context.runs.outputDir(runId)
    writeFileSync(join(output, 'handover-123.json'), '{not json')
    expect(history().detail(runId)!.handovers).toEqual([])
    expect(history().copiedRows(runId, '999')).toBeNull()
    expect(history().copiedRows(runId, '../x')).toBeNull()
    expect(history().detail('20990101-000000-nope-0000')).toBeNull()
  })
})

describe('keeping runs', () => {
  it('never removes a kept run in the automatic clean-up, and removes a run on request', () => {
    const store = createRunStore(join(root, 'runs2'), () => Date.now() + 100 * 86_400_000)
    const kept = store.create({ projectKey: 'p', projectName: 'Kept', pageUrl: 'https://x.test/' })
    const old = store.create({ projectKey: 'p', projectName: 'Old', pageUrl: 'https://x.test/' })
    store.setPinned(kept.id, true)
    const later = createRunStore(join(root, 'runs2'), () => Date.now() + 400 * 86_400_000)
    expect(later.prune({ maxAgeDays: 14 })).toEqual([old.id])
    expect(later.list().map((run) => run.id)).toEqual([kept.id])
    expect(later.get(kept.id)?.pinned).toBe(true)
    expect(later.remove(kept.id)).toBe(true)
    expect(later.list()).toEqual([])
    mkdirSync(join(root, 'runs2'), { recursive: true })
    expect(later.remove('20990101-000000-nope-0000')).toBe(false)
  })
})
