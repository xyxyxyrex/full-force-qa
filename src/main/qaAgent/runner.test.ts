import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentProvider, ProviderResult, ProviderRun } from './agents/types'
import { QA_RUBRIC } from './prompt'
import { runQa } from './runner'
import { bands, createFakeContext, PAGE_DESIGN_KEY, reportedContext, type FakeContext } from './testSupport'

let root: string
let fake: FakeContext
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'parity-runner-')); fake = createFakeContext(root) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const addDesigns = async (...bps: Array<'desktop' | 'tablet' | 'mobile'>) => {
  const widths = { desktop: 2880, tablet: 1668, mobile: 780 }
  for (const bp of bps) await fake.designs.put(PAGE_DESIGN_KEY, await bands(widths[bp], 4000), { target: bp })
}
const rowFor = (issue: string) => ({ cells: { Page: 'Home', Issue: issue, Severity: 'High' } })
const runIdOf = (task: string) => /Run id: (\S+)\./.exec(task)![1]
const breakpointOf = (run: ProviderRun) => /Check the (\w+) breakpoint/.exec(run.task)?.[1] as 'desktop' | 'tablet' | 'mobile'

interface Calls { runs: ProviderRun[] }
const provider = (script: (run: ProviderRun, calls: Calls) => Promise<ProviderResult> | ProviderResult): { provider: AgentProvider; calls: Calls } => {
  const calls: Calls = { runs: [] }
  return { calls, provider: { id: 'fake', label: 'Fake', run: async (run) => { calls.runs.push(run); return script(run, calls) } } }
}
const finished = (text = 'ok'): ProviderResult => ({ stopped: 'finished', text })
const start = (p: AgentProvider, over: Partial<Parameters<typeof runQa>[1]> = {}) => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const promise = runQa({ context: fake.context, provider: p }, { signal: controller.signal, emit: (e) => events.push(e), ...over })
  return { events, controller, promise }
}

describe('runQa preconditions', () => {
  it('needs an open project, a tracker format and designs', async () => {
    const { provider: p, calls } = provider(() => finished())
    fake.context.reportedContext = () => null
    expect((await start(p).promise)).toMatchObject({ stopped: 'failed', message: expect.stringContaining('No project is open') })
    fake.context.reportedContext = () => reportedContext()
    fake.context.trackerFormat = () => null
    expect((await start(p).promise)).toMatchObject({ stopped: 'failed', message: expect.stringContaining('tracker format') })
    fake.context.trackerFormat = createFakeContext(root).context.trackerFormat
    expect((await start(p).promise)).toMatchObject({ stopped: 'nothing-to-do', message: expect.stringContaining('No design images') })
    expect(calls.runs).toHaveLength(0)
  })
})

describe('runQa with one breakpoint', () => {
  it('runs a focused conversation, then hands the drafted rows over for approval', async () => {
    await addDesigns('desktop')
    const { provider: p, calls } = provider(async (run) => {
      const runId = runIdOf(run.task)
      await run.call('capture_live', { breakpoint: 'desktop', runId })
      await run.call('save_draft', { runId, breakpoint: 'desktop', rows: [rowFor('Heading is smaller than the design')] })
      return finished()
    })
    const { promise, events } = start(p)
    const summary = await promise
    expect(summary).toMatchObject({ stopped: 'completed', finalized: true, rowsDrafted: 1, breakpoints: ['desktop'] })
    expect(calls.runs).toHaveLength(1)
    const run = calls.runs[0]
    expect(run.system).toContain(QA_RUBRIC.slice(0, 80))
    expect(run.system).toContain('only the desktop breakpoint')
    expect(run.tools).toEqual(['get_context', 'capture_live', 'get_overview', 'get_section', 'save_draft'])
    expect(fake.approvals).toHaveLength(1)
    expect(fake.clipboard[0].text).toBe('Home\tHeading is smaller than the design\t\t\tHigh')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does not let a conversation call tools outside its step', async () => {
    await addDesigns('desktop')
    let refused = ''
    const { provider: p } = provider(async (run) => {
      refused = (await run.call('finalize_rows', { runId: runIdOf(run.task), rows: [rowFor('x')] })).text
      return finished()
    })
    await start(p).promise
    expect(refused).toContain('not available in this step')
    expect(fake.approvals).toHaveLength(0)
  })

  it('reports no differences without bothering the person', async () => {
    await addDesigns('desktop')
    const { provider: p } = provider(async (run) => {
      await run.call('save_draft', { runId: runIdOf(run.task), breakpoint: 'desktop', rows: [] })
      return finished()
    })
    const summary = await start(p).promise
    expect(summary).toMatchObject({ stopped: 'completed', finalized: false, rowsDrafted: 0 })
    expect(summary.message).toContain('No differences')
    expect(fake.approvals).toHaveLength(0)
  })

  it('says so when the person rejects the rows', async () => {
    await addDesigns('desktop')
    fake.setDecision({ approved: false, note: 'Not an issue' })
    const { provider: p } = provider(async (run) => {
      await run.call('save_draft', { runId: runIdOf(run.task), breakpoint: 'desktop', rows: [rowFor('x')] })
      return finished()
    })
    const summary = await start(p).promise
    expect(summary.finalized).toBe(false)
    expect(summary.message).toContain('not copied')
    expect(fake.clipboard).toHaveLength(0)
  })

  it('warns when a conversation forgets to save a draft', async () => {
    await addDesigns('desktop')
    const { provider: p } = provider(() => finished())
    const { promise, events } = start(p)
    await promise
    expect(events.some((e) => e.type === 'status' && e.message.includes('No draft rows were saved for desktop'))).toBe(true)
  })
})

describe('runQa with several breakpoints', () => {
  it('reviews each breakpoint in its own conversation, then merges and finalizes', async () => {
    await addDesigns('desktop', 'tablet')
    const { provider: p, calls } = provider(async (run) => {
      const runId = runIdOf(run.task)
      if (run.tools.includes('finalize_rows')) {
        const rows = JSON.parse(run.task.split('Drafted rows (JSON):\n')[1].split('\n\nMerge them')[0])
        await run.call('finalize_rows', { runId, rows: rows.slice(0, 2) })
        return finished('Merged 3 rows into 2.')
      }
      const bp = breakpointOf(run)
      await run.call('save_draft', { runId, breakpoint: bp, rows: bp === 'desktop' ? [rowFor('A'), rowFor('B')] : [rowFor('A')] })
      return finished()
    })
    const summary = await start(p).promise
    expect(summary).toMatchObject({ stopped: 'completed', finalized: true, rowsDrafted: 3, breakpoints: ['desktop', 'tablet'] })
    expect(calls.runs).toHaveLength(3)
    expect(calls.runs[0].task).toContain('desktop breakpoint')
    expect(calls.runs[1].task).toContain('tablet breakpoint')
    expect(calls.runs[2].tools).toEqual(['get_context', 'finalize_rows'])
    expect(calls.runs[2].system).toContain('Tracker columns: Page | Issue | Expected | Screenshot | Severity')
    expect(fake.clipboard[0].text.split('\n')).toHaveLength(2)
  })

  it('hands over the unmerged rows if the merge step does not finalize', async () => {
    await addDesigns('desktop', 'mobile')
    const { provider: p } = provider(async (run) => {
      if (run.tools.includes('finalize_rows')) return { stopped: 'failed', text: '' }
      await run.call('save_draft', { runId: runIdOf(run.task), breakpoint: breakpointOf(run), rows: [rowFor(`issue on ${breakpointOf(run)}`)] })
      return finished()
    })
    const { promise, events } = start(p)
    const summary = await promise
    expect(summary).toMatchObject({ finalized: true, rowsDrafted: 2 })
    expect(events.some((e) => e.type === 'status' && e.message.includes('did not hand the rows over'))).toBe(true)
    expect(fake.clipboard[0].text.split('\n')).toHaveLength(2)
  })

  it('checks only the breakpoints it is asked to', async () => {
    await addDesigns('desktop', 'tablet', 'mobile')
    const { provider: p, calls } = provider(() => finished())
    await start(p, { breakpoints: ['mobile'] }).promise
    expect(calls.runs).toHaveLength(1)
    expect(calls.runs[0].task).toContain('mobile breakpoint')
  })
})

describe('runQa stopping', () => {
  it('stops when aborted, keeping drafts saved so far', async () => {
    await addDesigns('desktop', 'tablet')
    const { provider: p, calls } = provider(async (run) => {
      await run.call('save_draft', { runId: runIdOf(run.task), breakpoint: breakpointOf(run), rows: [rowFor('kept')] })
      current.controller.abort()
      return { stopped: 'aborted', text: '' }
    })
    const current = start(p)
    const summary = await current.promise
    expect(summary.stopped).toBe('aborted')
    expect(calls.runs).toHaveLength(1)
    expect(fake.approvals).toHaveLength(0)
    expect(fake.context.runs.readDrafts(summary.runId!).desktop).toHaveLength(1)
  })

  it('stops at the token budget', async () => {
    await addDesigns('desktop')
    const { provider: p } = provider(async (run) => {
      run.emit({ type: 'usage', inputTokens: 80_000, outputTokens: 30_000 })
      return run.signal.aborted ? { stopped: 'aborted', text: '' } : finished()
    })
    const summary = await start(p, { budgetTokens: 100_000 }).promise
    expect(summary.stopped).toBe('budget')
    expect(summary.message).toContain('100,000 tokens')
    expect(fake.approvals).toHaveLength(0)
  })

  it('reports a provider that throws', async () => {
    await addDesigns('desktop')
    const { provider: p } = provider(() => { throw new Error('API key rejected') })
    const { promise, events } = start(p)
    const summary = await promise
    expect(summary).toMatchObject({ stopped: 'failed', message: expect.stringContaining('API key rejected') })
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })
})
