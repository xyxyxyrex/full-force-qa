import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_TRACKER } from '../../shared/trackerFormat'
import { QuotaError, type AgentEvent, type AgentProvider, type ProviderResult, type ProviderRun } from './agents/types'
import { runQaBatch } from './batch'
import { CHAT_TOOLS, MAX_CHAT_TURNS, runChatTurn } from './chat'
import { LITE_LIMITS, LITE_NOTE, liteBreakpoints } from './lite'
import { runQa } from './runner'
import { bands, createFakeBrowser, createFakeContext, PAGE_DESIGN_KEY, type FakeContext } from './testSupport'

// A free tier allows few requests, so a "lite" agent does less: one breakpoint unless more are named,
// shorter conversations, and a batch that hands over what it found when the day's allowance runs out.

let root: string
let fake: FakeContext
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'parity-lite-')); fake = createFakeContext(root, { trackerFormat: () => STANDARD_TRACKER }) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const scripted = (lite: boolean, script: (run: ProviderRun) => Promise<ProviderResult> | ProviderResult) => {
  const runs: ProviderRun[] = []
  const provider: AgentProvider = { id: 'fake', label: 'Fake', lite, run: async (run) => { runs.push(run); return script(run) } }
  return { provider, runs }
}
const runIdOf = (task: string) => /Run id: (\S+)\./.exec(task)![1]
const breakpointOf = (task: string) => /(?:Check|Review) the (\w+) breakpoint/.exec(task)?.[1] as 'desktop' | 'tablet' | 'mobile' | undefined
const saveOne = async (run: ProviderRun, remarks: string): Promise<ProviderResult> => {
  const breakpoint = breakpointOf(run.task)
  if (breakpoint) await run.call('save_draft', { runId: runIdOf(run.task), breakpoint, rows: [{ cells: { Section: 'Hero', Remarks: remarks } }] })
  return { stopped: 'finished', text: 'ok' }
}

describe('liteBreakpoints', () => {
  it('prefers desktop, else the first available', () => {
    expect(liteBreakpoints(['desktop', 'tablet', 'mobile'])).toEqual(['desktop'])
    expect(liteBreakpoints(['tablet', 'mobile'])).toEqual(['tablet'])
    expect(liteBreakpoints([])).toEqual(['desktop'])
  })
})

describe('a review on a free tier', () => {
  const addDesigns = async () => {
    for (const [bp, width] of [['desktop', 2880], ['tablet', 1668], ['mobile', 780]] as const) await fake.designs.put(PAGE_DESIGN_KEY, await bands(width, 4000), { target: bp })
  }

  it('checks one breakpoint with a shorter conversation, and says why', async () => {
    await addDesigns()
    const { provider, runs } = scripted(true, (run) => saveOne(run, 'wrong image'))
    const events: AgentEvent[] = []
    const summary = await runQa({ context: fake.context, provider }, { signal: new AbortController().signal, emit: (e) => events.push(e) })
    expect(summary.breakpoints).toEqual(['desktop'])
    expect(runs).toHaveLength(1)
    expect(runs[0].maxTurns).toBe(LITE_LIMITS.breakpointTurns)
    expect(events).toContainEqual({ type: 'status', message: LITE_NOTE })
  })

  it('still checks every breakpoint the person named', async () => {
    await addDesigns()
    const { provider, runs } = scripted(true, (run) => saveOne(run, 'wrong image'))
    await runQa({ context: fake.context, provider }, { breakpoints: ['desktop', 'mobile'], signal: new AbortController().signal, emit: () => {} })
    expect(runs.map((run) => breakpointOf(run.task))).toEqual(['desktop', 'mobile', undefined])
  })

  it('keeps a paid agent on every stored breakpoint with the full step limit', async () => {
    await addDesigns()
    const { provider, runs } = scripted(false, (run) => saveOne(run, 'wrong image'))
    await runQa({ context: fake.context, provider }, { signal: new AbortController().signal, emit: () => {} })
    expect(runs.filter((run) => breakpointOf(run.task)).map((run) => run.maxTurns)).toEqual([80, 80, 80])
  })

  it('reviews a page with no design on desktop only, and tests it with a shorter conversation when asked', async () => {
    fake.context.browser = await createFakeBrowser()
    const { provider, runs } = scripted(true, (run) => saveOne(run, 'typo'))
    await runQa({ context: fake.context, provider }, { functional: true, signal: new AbortController().signal, emit: () => {} })
    expect(runs.map((run) => breakpointOf(run.task) ?? 'functional')).toEqual(['desktop', 'functional'])
    expect(runs.map((run) => run.maxTurns)).toEqual([LITE_LIMITS.breakpointTurns, LITE_LIMITS.functionalTurns])
  })
})

describe('a chat on a free tier', () => {
  it('gets fewer steps per message, and is told how to ask when it runs out', async () => {
    const { provider, runs } = scripted(true, () => ({ stopped: 'max-turns', text: '' }))
    const events: AgentEvent[] = []
    await runChatTurn({ context: fake.context, provider }, { message: 'QA everything', history: [], signal: new AbortController().signal, emit: (e) => events.push(e) })
    expect(runs[0]).toMatchObject({ maxTurns: LITE_LIMITS.chatTurns, tools: CHAT_TOOLS })
    expect(events).toContainEqual({ type: 'status', message: expect.stringContaining('Ask for one thing at a time') })
    const paid = scripted(false, () => ({ stopped: 'finished', text: 'ok' }))
    await runChatTurn({ context: fake.context, provider: paid.provider }, { message: 'hi', history: [], signal: new AbortController().signal, emit: () => {} })
    expect(paid.runs[0].maxTurns).toBe(MAX_CHAT_TURNS)
  })
})

describe('a batch when the free requests run out', () => {
  it('stops at once and hands over what was found on the pages before', async () => {
    let calls = 0
    const { provider, runs } = scripted(true, async (run) => {
      if (++calls > 1) throw new QuotaError('Today\'s free requests on OpenRouter are used up.')
      return saveOne(run, 'wrong image')
    })
    const events: AgentEvent[] = []
    const pages = [1, 2, 3].map((n) => ({ url: `https://svenson.test/page-${n}/`, name: `Page ${n}` }))
    const summary = await runQaBatch({ context: fake.context, provider }, { pages, signal: new AbortController().signal, emit: (e) => events.push(e) })
    expect(runs).toHaveLength(2)
    expect(fake.approvals).toHaveLength(1)
    expect(fake.approvals[0].rows).toHaveLength(1)
    expect(summary.stopped).toBe('completed')
    expect(events).toContainEqual({ type: 'status', message: expect.stringContaining('The free requests ran out. Handing over what was found so far (2 of 3 pages)') })
    expect(events).toContainEqual({ type: 'status', message: expect.stringContaining('may run out partway') })
  })

  it('fails with the quota message when nothing was found before it ran out', async () => {
    const { provider } = scripted(true, async () => { throw new QuotaError('Today\'s free requests on Gemini are used up.') })
    const summary = await runQaBatch({ context: fake.context, provider }, { pages: [{ url: 'https://svenson.test/a/', name: 'A' }], signal: new AbortController().signal, emit: () => {} })
    expect(summary).toMatchObject({ stopped: 'failed', message: 'Today\'s free requests on Gemini are used up.' })
    expect(fake.approvals).toHaveLength(0)
  })
})
