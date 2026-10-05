import { BREAKPOINTS, type Breakpoint } from '../../shared/designScale'
import { QA_BATCH_MAX_PAGES, type ReportedContext } from '../../shared/qaAgent'
import { matchChoice, type TrackerFormat } from '../../shared/trackerFormat'
import type { AgentEvent, AgentProvider } from './agents/types'
import { BROWSER_TOOL_NAMES } from './browserTools'
import { QA_FUNCTIONAL, QA_RUBRIC_STANDALONE } from './prompt'
import type { RunSummary } from './runner'
import { callTool, handOverRows, type DraftRow, type HandOverEntry, type QaContext, type ToolResult } from './tools'

// Reviews pages on their own, with no Figma design: one fresh conversation per page and
// breakpoint, one after another, then ONE hand-over for approval covering every page. The pages
// come from the person (a pasted list of links), never from the agent, so the agent still cannot
// make Parity load anything it chooses.

const BATCH_TOOLS = ['get_context', 'capture_live', 'get_overview', 'get_section', 'save_draft']
const MAX_TURNS_PER_BREAKPOINT = 80
// After the look, one conversation per page tests how it works in the agent's own browser.
export const FUNCTIONAL_TOOLS = ['get_context', ...BROWSER_TOOL_NAMES, 'save_draft']
export const MAX_TURNS_FUNCTIONAL = 70
export const MAX_BATCH_PAGES = QA_BATCH_MAX_PAGES
export const MAX_BATCH_ROWS = 400
/** After this many pages in a row fail the same way, the cause is not the page (a wrong key, no sign-in): stop. */
const MAX_CONSECUTIVE_FAILURES = 3

export { isReviewablePageUrl } from './qaBrowserPolicy'

const BREAKPOINT_LABEL: Record<Breakpoint, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' }

export interface BatchPage {
  url: string
  name: string
  /** Groups the page's capture runs; any stable id will do. */
  projectId?: string
}

export interface BatchOptions {
  pages: BatchPage[]
  breakpoints?: Breakpoint[]
  signal: AbortSignal
  emit(event: AgentEvent): void
  /** Stops the batch once this many tokens (input + output) were used. 0 or undefined means no limit. */
  budgetTokens?: number
  /** After the look, also test each page's links, buttons, menus and forms in the agent's browser. */
  functional?: boolean
}

// ── Testing how a page works ────────────────────────────────────────────────────────────

/** Where the functional test runs: desktop and mobile when they are reviewed, otherwise the first breakpoint reviewed. */
export function functionalBreakpoints(visual: Breakpoint[]): Breakpoint[] {
  const list = visual.length ? visual : [...BREAKPOINTS]
  const picked = list.filter((breakpoint) => breakpoint === 'desktop' || breakpoint === 'mobile')
  return picked.length ? picked : [list[0]]
}

/** The functional conversation for one page. Display is filled in afterwards when displaySetForYou is true. */
export function functionalConversation(runId: string, page: { name: string; url: string }, testAt: Breakpoint[], displaySetForYou: boolean): { system: string; task: string } {
  const where = testAt.join(', then ')
  return {
    system: `${QA_FUNCTIONAL}

# This conversation
You test the page of run ${runId}, at ${where}. Pass runId "${runId}" to browser_open and save_draft. Finish by calling save_draft with area "functional" for each breakpoint you tested, even with an empty list, then stop.`,
    task: `Run id: ${runId}. Test "${page.name}" (${page.url}) like a visitor now, at ${where}: browser_open it with this runId, work through what to test, then save_draft with area "functional".${displaySetForYou ? ' Display is set for you.' : ''}`,
  }
}

/** A page's drafts from looking (per breakpoint reviewed) and from testing (any breakpoint), together. */
export function pageDrafts(context: QaContext, runId: string, breakpoints: Breakpoint[]): Partial<Record<Breakpoint, DraftRow[]>> {
  const visual = context.runs.readDrafts(runId)
  const functional = context.runs.readDrafts(runId, 'functional')
  const byBreakpoint: Partial<Record<Breakpoint, DraftRow[]>> = {}
  for (const breakpoint of BREAKPOINTS) {
    const rows = [...(breakpoints.includes(breakpoint) ? (visual[breakpoint] ?? []) : []), ...(functional[breakpoint] ?? [])] as DraftRow[]
    if (rows.length) byBreakpoint[breakpoint] = rows
  }
  return byBreakpoint
}

// ── Putting one page's findings in order ────────────────────────────────────────────────

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
const lowerKey = (cells: Record<string, string>, column: string): string | undefined => Object.keys(cells).find((key) => key.trim().toLowerCase() === column.toLowerCase())
const read = (row: DraftRow, column: string | undefined): string => (column ? String(row.cells[lowerKey(row.cells, column) ?? column] ?? '') : '')
const write = (row: DraftRow, column: string, value: string): void => { row.cells[lowerKey(row.cells, column) ?? column] = value }
const clone = (row: DraftRow): DraftRow => ({ ...row, cells: { ...row.cells } })

/**
 * One page's findings from its breakpoints, ready for the tracker: Display is set from the
 * breakpoint the finding came from (never left to the model), the same finding on several
 * breakpoints becomes one row with the matching combined Display value, and the page's link is
 * filled in. Findings with no matching combined value (all three breakpoints) stay separate.
 */
export function finishPageRows(format: TrackerFormat, page: { url: string }, byBreakpoint: Partial<Record<Breakpoint, DraftRow[]>>): DraftRow[] {
  const displayColumn = format.columns.find((name) => /^display$/i.test(name))
  const options = displayColumn ? format.choices?.[displayColumn] : undefined
  const remarksColumn = format.columns.find((name) => /^(remarks|issue|description|finding|comment)s?$/i.test(name))
  const sectionColumn = format.columns.find((name) => /^section$/i.test(name))
  const linkColumn = format.columns.find((name) => /^page\b.*(link|url)|^url$|^link$/i.test(name))

  const items: Array<{ row: DraftRow; breakpoint: Breakpoint }> = []
  for (const breakpoint of BREAKPOINTS) for (const row of byBreakpoint[breakpoint] ?? []) items.push({ row: clone(row), breakpoint })

  const setDisplay = (row: DraftRow, label: string) => {
    if (!displayColumn) return
    const choice = options ? matchChoice(options, label) : label
    if (choice) write(row, displayColumn, choice)
  }

  const groups = new Map<string, typeof items>()
  items.forEach((item, index) => {
    // Without a remarks column there is nothing to compare, so every row stands alone.
    const key = remarksColumn ? `${normalize(read(item.row, sectionColumn))}|${normalize(read(item.row, remarksColumn))}` : `#${index}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  })

  const rows: DraftRow[] = []
  for (const group of groups.values()) {
    const breakpoints = BREAKPOINTS.filter((breakpoint) => group.some((item) => item.breakpoint === breakpoint))
    if (breakpoints.length > 1 && displayColumn && options) {
      const choice = matchChoice(options, breakpoints.map((breakpoint) => BREAKPOINT_LABEL[breakpoint]).join(' and '))
      if (choice) {
        write(group[0].row, displayColumn, choice)
        rows.push(group[0].row)
        continue
      }
    }
    // One row per breakpoint it was found on, each saying where; repeats on the same breakpoint are dropped.
    for (const breakpoint of breakpoints) {
      const first = group.find((item) => item.breakpoint === breakpoint)!
      setDisplay(first.row, BREAKPOINT_LABEL[breakpoint])
      rows.push(first.row)
    }
  }
  if (linkColumn) for (const row of rows) if (!read(row, linkColumn).trim()) write(row, linkColumn, page.url)
  return rows
}

// ── The run ─────────────────────────────────────────────────────────────────────────────

const reportedFor = (page: BatchPage, now: number): ReportedContext => ({
  projectKey: page.projectId || `batch-${page.url}`,
  project: { id: page.projectId || '', name: page.name, stagingUrl: page.url },
  pageUrl: page.url,
  workspaceTab: 'batch',
  breakpoint: null,
  viewport: { width: 0, height: 0 },
  reportedAt: now,
})

export async function runQaBatch(deps: { context: QaContext; provider: AgentProvider }, options: BatchOptions): Promise<RunSummary> {
  const { context, provider } = deps
  const { emit, signal } = options
  const breakpoints = options.breakpoints?.length ? options.breakpoints : [...BREAKPOINTS]
  const summary: RunSummary = { runId: null, breakpoints, rowsDrafted: 0, finalized: false, stopped: 'failed', message: '' }
  const finish = (stopped: RunSummary['stopped'], message: string): RunSummary => {
    summary.stopped = stopped
    summary.message = message
    emit(stopped === 'failed' || stopped === 'budget' ? { type: 'error', message } : { type: 'done', message })
    return summary
  }

  const format = context.trackerFormat()
  if (!format) return finish('failed', 'The tracker format is not set. In Settings → AI Agents, paste the tracker\'s header row and a few example rows.')
  if (!options.pages.length) return finish('nothing-to-do', 'There are no pages to review.')
  const pages = options.pages.slice(0, MAX_BATCH_PAGES)
  if (options.pages.length > pages.length) emit({ type: 'status', message: `Only the first ${MAX_BATCH_PAGES} of ${options.pages.length} pages are reviewed at once.` })
  emit({ type: 'status', message: `Reviewing ${pages.length} page${pages.length === 1 ? '' : 's'} on their own, with no design to compare: ${breakpoints.join(', ')}${options.functional && context.browser ? ', then links, buttons and forms' : ''}.` })

  let tokens = 0
  let overBudget = false
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort)
  if (signal.aborted) controller.abort()
  const tracked = (event: AgentEvent) => {
    if (event.type === 'usage') {
      tokens += event.inputTokens + event.outputTokens
      if (options.budgetTokens && tokens > options.budgetTokens && !overBudget) { overBudget = true; controller.abort() }
    }
    emit(event)
  }

  const entries: HandOverEntry[] = []
  const perPage: string[] = []
  let outputRunId: string | null = null
  let consecutiveFailures = 0
  let lastFailure = ''

  try {
    for (const [index, page] of pages.entries()) {
      if (controller.signal.aborted) break
      emit({ type: 'status', message: `Page ${index + 1} of ${pages.length}: ${page.url}` })
      const target = reportedFor(page, context.now())
      // Tools see this page as the open one, so they can only ever capture the page the person listed.
      const pageContext: QaContext = { ...context, reportedContext: () => target }
      context.setTarget?.(target) // agent CLIs call the tools through the bridge, which reads the real context
      const run = pageContext.runs.create({ projectKey: target.projectKey, projectName: page.name, pageUrl: page.url })
      outputRunId ??= run.id
      summary.runId ??= run.id

      const callWith = (tools: string[]) => async (name: string, args: unknown): Promise<ToolResult> => (tools.includes(name) ? callTool(name, args, pageContext) : { text: `The tool "${name}" is not available in this step.`, isError: true })
      let pageFailed = false
      // One conversation with the agent. Returns false when the same failure repeated too often to go on.
      const converse = async (label: string, work: () => Promise<unknown>): Promise<boolean> => {
        try {
          await work()
          consecutiveFailures = 0
        } catch (error: any) {
          if (controller.signal.aborted) return true
          pageFailed = true
          const message = error?.message || 'The agent failed.'
          consecutiveFailures = message === lastFailure ? consecutiveFailures + 1 : 1
          lastFailure = message
          emit({ type: 'status', message: `The ${label} of ${page.url} failed: ${message}` })
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
        }
        return true
      }
      const giveUp = () => finish('failed', `Stopped after the same failure ${MAX_CONSECUTIVE_FAILURES} times in a row: ${lastFailure}`)

      for (const breakpoint of breakpoints) {
        if (controller.signal.aborted) break
        emit({ type: 'status', message: `Reviewing ${breakpoint}…` })
        const going = await converse(`${breakpoint} review`, () => provider.run({
          system: `${QA_RUBRIC_STANDALONE}\n\n# This conversation\nYou review only the ${breakpoint} breakpoint of run ${run.id}. Finish by calling save_draft for ${breakpoint}, even with an empty list, then stop.`,
          task: `Run id: ${run.id}. Review the ${breakpoint} breakpoint of "${page.name}" (${page.url}) now: capture_live (with this runId), study the overview, look at every section with get_section, then save_draft your rows for ${breakpoint}. Display is set for you.`,
          tools: BATCH_TOOLS,
          maxTurns: MAX_TURNS_PER_BREAKPOINT,
          signal: controller.signal,
          call: callWith(BATCH_TOOLS),
          emit: tracked,
        }))
        if (!going) return giveUp()
        if (!pageContext.runs.readDrafts(run.id)[breakpoint]) emit({ type: 'status', message: `No draft rows were saved for ${breakpoint}.` })
      }

      if (options.functional && context.browser && !controller.signal.aborted) {
        const testAt = functionalBreakpoints(breakpoints)
        emit({ type: 'status', message: `Testing links, buttons and forms (${testAt.join(' and ')})…` })
        const conversation = functionalConversation(run.id, page, testAt, true)
        const going = await converse('functional test', () => provider.run({
          ...conversation,
          tools: FUNCTIONAL_TOOLS,
          maxTurns: MAX_TURNS_FUNCTIONAL,
          signal: controller.signal,
          call: callWith(FUNCTIONAL_TOOLS),
          emit: tracked,
        }))
        context.browser.close()
        if (!going) return giveUp()
        if (!Object.keys(pageContext.runs.readDrafts(run.id, 'functional')).length) emit({ type: 'status', message: 'No rows were saved from testing the page.' })
      }

      const byBreakpoint = pageDrafts(pageContext, run.id, breakpoints)
      const rows = finishPageRows(format, page, byBreakpoint)
      for (const row of rows) entries.push({ runId: run.id, row, page: { name: page.name, url: page.url } })
      summary.rowsDrafted += rows.length
      perPage.push(`${page.url}: ${pageFailed && !rows.length ? 'not reviewed' : `${rows.length} finding${rows.length === 1 ? '' : 's'}`}`)
      emit({ type: 'status', message: `Page ${index + 1}: ${rows.length} finding${rows.length === 1 ? '' : 's'}.` })
    }

    if (controller.signal.aborted && !overBudget) return finish('aborted', 'Stopped.')
    if (!entries.length) return finish(overBudget ? 'budget' : 'completed', overBudget ? `Stopped: the token limit was reached before any finding was written (${options.budgetTokens?.toLocaleString()} tokens).` : `No problems found on ${pages.length} page${pages.length === 1 ? '' : 's'}, so nothing was handed over.`)
    if (overBudget) emit({ type: 'status', message: `The token limit (${options.budgetTokens?.toLocaleString()}) was reached. Handing over what was found so far (${perPage.length} of ${pages.length} pages).` })

    emit({ type: 'status', message: `Handing over ${entries.length} finding${entries.length === 1 ? '' : 's'} from ${perPage.length} page${perPage.length === 1 ? '' : 's'} for approval…` })
    const result = await handOverRows(context, {
      projectName: pages.length === 1 ? pages[0].name : `${perPage.length} pages`,
      pageUrl: pages[0].url,
      outputRunId: outputRunId!,
      entries: entries.slice(0, MAX_BATCH_ROWS),
      maxRows: MAX_BATCH_ROWS,
    })
    emit({ type: 'tool-result', name: 'finalize_rows', isError: !!result.isError, text: result.text, images: 0 })
    summary.finalized = !result.isError && /^Approved\. Copied \d+ row/.test(result.text)
    const note = entries.length > MAX_BATCH_ROWS ? ` Only the first ${MAX_BATCH_ROWS} findings were handed over.` : ''
    // Rows handed over after the limit was reached are still a completed hand-over; the status line above said so.
    return finish('completed', summary.finalized ? `${result.text}${note}\n${perPage.join('\n')}` : `The rows were not copied. ${result.text}`)
  } catch (error: any) {
    return finish('failed', `The review failed: ${error?.message || 'unknown error'}`)
  } finally {
    context.setTarget?.(null)
    signal.removeEventListener('abort', onAbort)
  }
}
