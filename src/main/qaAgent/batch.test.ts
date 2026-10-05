import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Breakpoint } from '../../shared/designScale'
import { STANDARD_TRACKER } from '../../shared/trackerFormat'
import type { AgentEvent, AgentProvider, ProviderResult, ProviderRun } from './agents/types'
import { finishPageRows, isReviewablePageUrl, MAX_BATCH_PAGES, runQaBatch } from './batch'
import { QA_RUBRIC_STANDALONE } from './prompt'
import { createFakeContext, type FakeContext } from './testSupport'
import type { DraftRow } from './tools'

let root: string
let fake: FakeContext
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'parity-batch-'))
  fake = createFakeContext(root, { trackerFormat: () => STANDARD_TRACKER })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const row = (section: string, remarks: string, extra: Record<string, string> = {}): DraftRow => ({ cells: { Section: section, Remarks: remarks, 'Priority (QA/PM)': 'Medium', ...extra } })
const cell = (r: DraftRow, column: string) => r.cells[column]

describe('finishPageRows', () => {
  const page = { url: 'https://svenson.test/alopecia-page/' }

  it('sets Display from the breakpoint a finding came from, whatever the model wrote, and fills the page link', () => {
    const rows = finishPageRows(STANDARD_TRACKER, page, { desktop: [row('Hero', 'wrong image', { Display: 'Mobile' })] })
    expect(rows).toHaveLength(1)
    expect(cell(rows[0], 'Display')).toBe('Desktop')
    expect(cell(rows[0], 'Page Link')).toBe('https://svenson.test/alopecia-page/')
  })

  it('keeps a link the model already wrote', () => {
    const rows = finishPageRows(STANDARD_TRACKER, page, { mobile: [row('Hero', 'wrong image', { 'Page Link': 'https://x.test/own' })] })
    expect(cell(rows[0], 'Page Link')).toBe('https://x.test/own')
  })

  it('makes one row of the same finding on two breakpoints, with the matching combined value', () => {
    const same = (text = 'Wrong IMAGE ') => row('Hero', text)
    expect(cell(finishPageRows(STANDARD_TRACKER, page, { desktop: [same('wrong image')], mobile: [same()] })[0], 'Display')).toBe('Desktop and Mobile')
    expect(cell(finishPageRows(STANDARD_TRACKER, page, { desktop: [same('wrong image')], tablet: [same()] })[0], 'Display')).toBe('Desktop and Tablet')
    expect(cell(finishPageRows(STANDARD_TRACKER, page, { tablet: [same('wrong image')], mobile: [same()] })[0], 'Display')).toBe('Mobile & Tablet')
    expect(finishPageRows(STANDARD_TRACKER, page, { desktop: [same('wrong image')], mobile: [same()] })).toHaveLength(1)
  })

  it('keeps a finding on all three breakpoints as three rows, since no combined value covers it', () => {
    const rows = finishPageRows(STANDARD_TRACKER, page, { desktop: [row('Footer', 'logo too small')], tablet: [row('Footer', 'logo too small')], mobile: [row('Footer', 'logo too small')] })
    expect(rows.map((r) => cell(r, 'Display'))).toEqual(['Desktop', 'Tablet', 'Mobile'])
  })

  it('does not merge findings that differ, and drops a repeat on the same breakpoint', () => {
    const rows = finishPageRows(STANDARD_TRACKER, page, {
      desktop: [row('Hero', 'wrong image'), row('Hero', 'wrong image'), row('Hero', 'h1 title should be 2 lines')],
      mobile: [row('Footer', 'wrong image')],
    })
    expect(rows.map((r) => `${cell(r, 'Section')}|${cell(r, 'Remarks')}|${cell(r, 'Display')}`)).toEqual([
      'Hero|wrong image|Desktop', 'Hero|h1 title should be 2 lines|Desktop', 'Footer|wrong image|Mobile',
    ])
  })

  it('does not change what was passed in', () => {
    const original = row('Hero', 'wrong image')
    finishPageRows(STANDARD_TRACKER, page, { desktop: [original] })
    expect(original.cells.Display).toBeUndefined()
    expect(original.cells['Page Link']).toBeUndefined()
  })

  it('leaves a tracker without Display or page link columns alone', () => {
    const custom = { version: 1 as const, columns: ['Where', 'Issue'], examples: [] }
    const rows = finishPageRows(custom, page, { desktop: [{ cells: { Where: 'Hero', Issue: 'wrong image' } }], mobile: [{ cells: { Where: 'Hero', Issue: 'wrong image' } }] })
    expect(rows).toHaveLength(2)
    expect(rows[0].cells).toEqual({ Where: 'Hero', Issue: 'wrong image' })
  })
})

describe('isReviewablePageUrl', () => {
  it('accepts web pages and refuses admin, login and other schemes', () => {
    expect(isReviewablePageUrl('https://svenson.test/alopecia-page/')).toBe(true)
    expect(isReviewablePageUrl('http://localhost:8080/')).toBe(true)
    expect(isReviewablePageUrl('https://svenson.test/wp-admin/')).toBe(false)
    expect(isReviewablePageUrl('https://svenson.test/wp-admin/post.php?post=1')).toBe(false)
    expect(isReviewablePageUrl('https://svenson.test/wp-login.php')).toBe(false)
    expect(isReviewablePageUrl('https://svenson.test/?action=delete')).toBe(false)
    expect(isReviewablePageUrl('file:///etc/hosts')).toBe(false)
    expect(isReviewablePageUrl('javascript:alert(1)')).toBe(false)
    expect(isReviewablePageUrl('not a url')).toBe(false)
  })
})

// A stand-in agent: captures the page it is asked about and writes the findings the test gives it.
type Script = (info: { run: ProviderRun; runId: string; breakpoint: Breakpoint; url: string }) => Promise<ProviderResult | void> | ProviderResult | void
const fakeProvider = (script: Script) => {
  const runs: ProviderRun[] = []
  const provider: AgentProvider = {
    id: 'fake', label: 'Fake',
    run: async (run) => {
      runs.push(run)
      const runId = /Run id: (\S+)\./.exec(run.task)![1]
      const breakpoint = /Review the (\w+) breakpoint/.exec(run.task)![1] as Breakpoint
      const url = /\((https?:\/\/[^)]+)\)/.exec(run.task)![1]
      return (await script({ run, runId, breakpoint, url })) ?? { stopped: 'finished', text: 'ok' }
    },
  }
  return { provider, runs }
}
const saveRows = (rows: DraftRow[]) => async ({ run, runId, breakpoint }: { run: ProviderRun; runId: string; breakpoint: Breakpoint }) => {
  const captured = await run.call('capture_live', { breakpoint, runId })
  expect(captured.isError).toBeFalsy()
  const saved = await run.call('save_draft', { runId, breakpoint, rows: rows.map((r) => ({ ...r, evidence: { breakpoint, section: 'S2' } })) })
  expect(saved.isError).toBeFalsy()
}
const pages = [
  { url: 'https://svenson.test/alopecia-page/', name: 'Alopecia' },
  { url: 'https://svenson.test/contact/', name: 'Contact' },
]
const start = (p: AgentProvider, over: Partial<Parameters<typeof runQaBatch>[1]> = {}) => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const promise = runQaBatch({ context: fake.context, provider: p }, { pages, breakpoints: ['desktop', 'mobile'], signal: controller.signal, emit: (e) => events.push(e), ...over })
  return { promise, events, controller }
}

describe('runQaBatch', () => {
  it('reviews every page on its own, then hands everything over for one approval', async () => {
    const { provider, runs } = fakeProvider(async (info) => {
      // Alopecia: the same finding on both breakpoints, plus one on desktop. Contact: one on mobile only.
      const rows: Record<string, DraftRow[]> = {
        'Alopecia|desktop': [row('Hero', 'wrong image'), row('Footer', 'font size should be 13px')],
        'Alopecia|mobile': [row('Hero', 'wrong image')],
        'Contact|desktop': [],
        'Contact|mobile': [row('Contact form', 'button should be round')],
      }
      const name = info.url.includes('contact') ? 'Contact' : 'Alopecia'
      await saveRows(rows[`${name}|${info.breakpoint}`])(info)
    })
    const { promise, events } = start(provider)
    const summary = await promise

    expect(runs).toHaveLength(4) // 2 pages × 2 breakpoints
    expect(runs.every((r) => r.system.includes(QA_RUBRIC_STANDALONE.slice(0, 100)))).toBe(true)
    expect(runs.every((r) => r.tools.join() === 'get_context,capture_live,get_overview,get_section,save_draft')).toBe(true)

    // One approval, with every page's findings in order, grouped by page.
    expect(fake.approvals).toHaveLength(1)
    const approval = fake.approvals[0]
    expect(approval.projectName).toBe('2 pages')
    const remarksIndex = approval.columns.indexOf('Remarks')
    const displayIndex = approval.columns.indexOf('Display')
    const linkIndex = approval.columns.indexOf('Page Link')
    expect(approval.rows.map((r) => [r[linkIndex], r[remarksIndex], r[displayIndex]])).toEqual([
      ['https://svenson.test/alopecia-page/', 'wrong image', 'Desktop and Mobile'],
      ['https://svenson.test/alopecia-page/', 'font size should be 13px', 'Desktop'],
      ['https://svenson.test/contact/', 'button should be round', 'Mobile'],
    ])
    expect(approval.rowPages?.map((p) => p.name)).toEqual(['Alopecia', 'Alopecia', 'Contact'])
    expect(approval.evidence).toHaveLength(3)

    expect(fake.clipboard).toHaveLength(1)
    expect(fake.clipboard[0].text.split('\n')).toHaveLength(3)
    expect(summary).toMatchObject({ finalized: true, stopped: 'completed', rowsDrafted: 3 })
    expect(summary.message).toContain('https://svenson.test/alopecia-page/: 2 findings')
    expect(summary.message).toContain('https://svenson.test/contact/: 1 finding')
    expect(events.filter((e) => e.type === 'status').map((e) => (e as { message: string }).message)).toEqual(expect.arrayContaining(['Page 1 of 2: https://svenson.test/alopecia-page/', 'Page 2 of 2: https://svenson.test/contact/']))
  })

  it('shows each page to the tools as the open page, so only listed pages can be captured', async () => {
    const seen: string[] = []
    const { provider } = fakeProvider(async ({ run, runId, breakpoint, url }) => {
      const context = JSON.parse((await run.call('get_context', {})).text)
      seen.push(`${url} -> ${context.openPage.url}`)
      await run.call('capture_live', { breakpoint, runId })
      await run.call('save_draft', { runId, breakpoint, rows: [] })
    })
    await start(provider, { breakpoints: ['desktop'] }).promise
    expect(seen).toEqual(['https://svenson.test/alopecia-page/ -> https://svenson.test/alopecia-page/', 'https://svenson.test/contact/ -> https://svenson.test/contact/'])
  })

  it('also shows each page as the open one to tools reached over the bridge, and clears it afterwards', async () => {
    // Agent CLIs call the tools through the bridge, which reads the app's own context rather than the one given to a conversation.
    const bridgeSaw: string[] = []
    const { provider } = fakeProvider(async ({ runId, breakpoint, url }) => {
      bridgeSaw.push(`${url} -> ${fake.context.reportedContext()?.pageUrl}`)
      expect(fake.context.reportedContext()?.project.name).toBe(url.includes('contact') ? 'Contact' : 'Alopecia')
      void runId; void breakpoint
    })
    await start(provider, { breakpoints: ['desktop'] }).promise
    expect(bridgeSaw).toEqual(['https://svenson.test/alopecia-page/ -> https://svenson.test/alopecia-page/', 'https://svenson.test/contact/ -> https://svenson.test/contact/'])
    expect(fake.context.reportedContext()?.project.name).toBe('[Svenson] Alopecia') // back to the open page
  })

  it('clears the page it was reviewing even when it fails or is stopped', async () => {
    const { provider } = fakeProvider(() => { throw new Error('boom') })
    await start(provider, { breakpoints: ['desktop'] }).promise
    expect(fake.context.reportedContext()?.project.name).toBe('[Svenson] Alopecia')
    const stop = fakeProvider(async () => { controller.abort() })
    const { promise, controller } = start(stop.provider)
    await promise
    expect(fake.context.reportedContext()?.project.name).toBe('[Svenson] Alopecia')
  })

  it('does not let a conversation use tools outside its step, finalize_rows included', async () => {
    let refused = ''
    const { provider } = fakeProvider(async ({ run, runId }) => {
      refused = (await run.call('finalize_rows', { runId, rows: [{ cells: { Remarks: 'x' } }] })).text
    })
    await start(provider, { pages: [pages[0]], breakpoints: ['desktop'] }).promise
    expect(refused).toMatch(/not available in this step/)
    expect(fake.approvals).toHaveLength(0)
  })

  it('says so, and hands nothing over, when no page has problems', async () => {
    const { provider } = fakeProvider(saveRows([]))
    const summary = await start(provider).promise
    expect(summary).toMatchObject({ stopped: 'completed', finalized: false, message: expect.stringContaining('No problems found on 2 pages') })
    expect(fake.approvals).toHaveLength(0)
  })

  it('copies nothing when the person rejects, and says so', async () => {
    fake.setDecision({ approved: false, note: 'too noisy' })
    const { provider } = fakeProvider(saveRows([row('Hero', 'wrong image')]))
    const summary = await start(provider, { pages: [pages[0]], breakpoints: ['desktop'] }).promise
    expect(summary).toMatchObject({ finalized: false, message: expect.stringContaining('The rows were not copied') })
    expect(summary.message).toContain('too noisy')
    expect(fake.clipboard).toHaveLength(0)
  })

  it('carries on with the other pages when one page fails, and reports it', async () => {
    const { provider } = fakeProvider(async (info) => {
      if (info.url.includes('alopecia')) throw new Error('The page could not be captured')
      await saveRows([row('Hero', 'wrong image')])(info)
    })
    const { promise, events } = start(provider, { breakpoints: ['desktop'] })
    const summary = await promise
    expect(summary).toMatchObject({ finalized: true, rowsDrafted: 1 })
    expect(summary.message).toContain('https://svenson.test/alopecia-page/: not reviewed')
    expect(events.some((e) => e.type === 'status' && /desktop review of https:\/\/svenson\.test\/alopecia-page\/ failed: The page could not be captured/.test(e.message))).toBe(true)
  })

  it('stops when the same failure happens three times in a row', async () => {
    const { provider, runs } = fakeProvider(() => { throw new Error('Anthropic rejected the API key.') })
    const many = Array.from({ length: 6 }, (_, i) => ({ url: `https://svenson.test/p${i}/`, name: `P${i}` }))
    const summary = await start(provider, { pages: many, breakpoints: ['desktop'] }).promise
    expect(summary).toMatchObject({ stopped: 'failed', message: expect.stringContaining('Anthropic rejected the API key.') })
    expect(runs).toHaveLength(3)
  })

  it('stops when told to and hands nothing over', async () => {
    const { provider, runs } = fakeProvider(async (info) => {
      await saveRows([row('Hero', 'wrong image')])(info)
      controller.abort()
    })
    const { promise, controller } = start(provider)
    expect(await promise).toMatchObject({ stopped: 'aborted' })
    expect(runs).toHaveLength(1)
    expect(fake.approvals).toHaveLength(0)
  })

  it('hands over what it found when the token limit is reached partway', async () => {
    const { provider, runs } = fakeProvider(async (info) => {
      await saveRows([row('Hero', 'wrong image')])(info)
      info.run.emit({ type: 'usage', inputTokens: 900, outputTokens: 200 })
    })
    const { promise, events } = start(provider, { budgetTokens: 1000 })
    const summary = await promise
    expect(runs).toHaveLength(1) // the second breakpoint and the second page were never started
    expect(fake.approvals).toHaveLength(1)
    expect(fake.approvals[0].rows).toHaveLength(1)
    expect(summary).toMatchObject({ stopped: 'completed', finalized: true })
    expect(events.some((e) => e.type === 'status' && /token limit \(1,000\) was reached/.test(e.message))).toBe(true)
  })

  it('needs a tracker format and at least one page', async () => {
    const { provider } = fakeProvider(() => undefined)
    fake.context.trackerFormat = () => null
    expect(await start(provider).promise).toMatchObject({ stopped: 'failed', message: expect.stringContaining('tracker format') })
    fake.context.trackerFormat = () => STANDARD_TRACKER
    expect(await start(provider, { pages: [] }).promise).toMatchObject({ stopped: 'nothing-to-do' })
  })

  it('reviews at most as many pages as a batch can hold', async () => {
    const { provider, runs } = fakeProvider(async ({ run, runId, breakpoint }) => { await run.call('save_draft', { runId, breakpoint, rows: [] }) })
    const many = Array.from({ length: MAX_BATCH_PAGES + 5 }, (_, i) => ({ url: `https://svenson.test/p${i}/`, name: `P${i}` }))
    const { promise, events } = start(provider, { pages: many, breakpoints: ['desktop'] })
    await promise
    expect(runs).toHaveLength(MAX_BATCH_PAGES)
    expect(events.some((e) => e.type === 'status' && e.message.includes(`Only the first ${MAX_BATCH_PAGES} of ${MAX_BATCH_PAGES + 5}`))).toBe(true)
  })
})
