import type { Breakpoint } from '../../shared/designScale'
import { BREAKPOINTS } from '../../shared/designScale'
import { designKeyOf, pageIdOf } from '../../shared/designKey'
import { runQaBatch } from './batch'
import { QA_RUBRIC } from './prompt'
import type { AgentEvent, AgentProvider, ProviderResult } from './agents/types'
import { callTool, type QaContext, type ToolResult } from './tools'

// Runs a QA review: one fresh conversation per breakpoint (so pictures never pile up in one
// context), then one short text-only conversation that merges the drafts and hands the rows
// over for approval. The model only ever drafts; the person approves in Parity.

const BREAKPOINT_TOOLS = ['get_context', 'capture_live', 'get_overview', 'get_section', 'save_draft']
const MERGE_TOOLS = ['get_context', 'finalize_rows']
const MAX_TURNS_PER_BREAKPOINT = 80
const MAX_TURNS_MERGE = 8

export interface RunOptions {
  breakpoints?: Breakpoint[]
  signal: AbortSignal
  emit(event: AgentEvent): void
  /** Stops the run once this many tokens (input + output) were used. 0 or undefined means no limit. */
  budgetTokens?: number
  /** Review the page on its own, ignoring any stored designs. Also what happens when the page has none. */
  standalone?: boolean
}

export interface RunSummary {
  runId: string | null
  breakpoints: Breakpoint[]
  rowsDrafted: number
  finalized: boolean
  stopped: 'completed' | 'nothing-to-do' | 'aborted' | 'failed' | 'budget'
  message: string
}

const taskFor = (runId: string, breakpoint: Breakpoint) =>
  `Run id: ${runId}. Check the ${breakpoint} breakpoint now: capture_live (with this runId), study the overview, compare every section with get_section, then save_draft your rows for ${breakpoint}. Do not call finalize_rows; that happens afterwards.`

function mergeInstructions(columns: string[], examples: string[][]): string {
  return `${QA_RUBRIC}

# Your job now
The breakpoint reviews are finished. Below are the drafted rows. Merge them into the final list: remove exact duplicates, keep a row per breakpoint only when its fix differs, keep every row's evidence, and keep the wording and severity as written unless two rows contradict each other. Do not invent new issues. Then call finalize_rows once with the final rows.
Tracker columns: ${columns.join(' | ')}
${examples.length ? `Example rows for tone:\n${examples.map((row) => row.join(' | ')).join('\n')}` : ''}`
}

export async function runQa(deps: { context: QaContext; provider: AgentProvider }, options: RunOptions): Promise<RunSummary> {
  const { context, provider } = deps
  const { emit, signal } = options
  const summary: RunSummary = { runId: null, breakpoints: [], rowsDrafted: 0, finalized: false, stopped: 'failed', message: '' }
  const finish = (stopped: RunSummary['stopped'], message: string): RunSummary => {
    summary.stopped = stopped
    summary.message = message
    emit(stopped === 'failed' || stopped === 'budget' ? { type: 'error', message } : { type: 'done', message })
    return summary
  }

  const reported = context.reportedContext()
  if (!reported) return finish('failed', 'No project is open in Parity. Open the project and its staging page, then run again.')
  const format = context.trackerFormat()
  if (!format) return finish('failed', 'The tracker format is not set. In Settings → AI Agents, paste the tracker\'s header row and a few example rows.')

  const slots = context.designs.list(designKeyOf(reported.projectKey, reported.pageUrl))
  const stored = BREAKPOINTS.filter((bp) => slots[bp])
  // No Figma design (or asked to ignore it): the agent reviews the live page on its own.
  if (options.standalone || !stored.length) {
    if (!options.standalone) emit({ type: 'status', message: `No designs are stored for this page (${pageIdOf(reported.pageUrl) ?? reported.pageUrl}), so the agent reviews the page on its own.` })
    return runQaBatch(deps, { pages: [{ url: reported.pageUrl, name: reported.project.name, projectId: reported.projectKey }], breakpoints: options.breakpoints, signal, emit, budgetTokens: options.budgetTokens })
  }
  const breakpoints = options.breakpoints?.length ? options.breakpoints : stored
  if (!breakpoints.length) return finish('nothing-to-do', `No design images are stored for this page (${pageIdOf(reported.pageUrl) ?? reported.pageUrl}). Add the Figma PNGs for it in the Figma overlay panel, then run again.`)
  summary.breakpoints = breakpoints
  const missing = breakpoints.filter((bp) => !slots[bp])
  if (missing.length) emit({ type: 'status', message: `No design is stored for ${missing.join(', ')}; ${missing.length === 1 ? 'that breakpoint' : 'those breakpoints'} will be captured without a comparison.` })

  const run = context.runs.create({ projectKey: reported.projectKey, projectName: reported.project.name, pageUrl: reported.pageUrl })
  summary.runId = run.id
  const designList = breakpoints.map((bp) => (slots[bp] ? `${bp}: ${slots[bp]!.fileName ?? 'design'} (${slots[bp]!.frameWidth}px)` : `${bp}: no design`)).join(', ')
  emit({ type: 'status', message: `Run ${run.id} started on ${reported.pageUrl}. Designs for this page: ${designList}.` })

  let tokens = 0
  let overBudget = false
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort)
  const tracked = (event: AgentEvent) => {
    if (event.type === 'usage') {
      tokens += event.inputTokens + event.outputTokens
      if (options.budgetTokens && tokens > options.budgetTokens && !overBudget) {
        overBudget = true
        controller.abort()
      }
    }
    emit(event)
  }

  let finalizeCalled = false
  const finalize = async (args: unknown): Promise<ToolResult> => {
    finalizeCalled = true
    const result = await callTool('finalize_rows', args, context)
    if (!result.isError && /^Approved\. Copied \d+ row/.test(result.text)) summary.finalized = true
    return result
  }
  const makeCall = (allowed: string[]) => async (name: string, args: unknown): Promise<ToolResult> => {
    if (!allowed.includes(name)) return { text: `The tool "${name}" is not available in this step.`, isError: true }
    return name === 'finalize_rows' ? finalize(args) : callTool(name, args, context)
  }
  const conversation = (system: string, task: string, tools: string[], maxTurns: number): Promise<ProviderResult> =>
    provider.run({ system, task, tools, maxTurns, signal: controller.signal, call: makeCall(tools), emit: tracked })

  try {
    for (const breakpoint of breakpoints) {
      if (controller.signal.aborted) break
      emit({ type: 'status', message: `Reviewing ${breakpoint}…` })
      const result = await conversation(
        `${QA_RUBRIC}\n\n# This conversation\nYou review only the ${breakpoint} breakpoint of run ${run.id}. Finish by calling save_draft for ${breakpoint}, even if you found nothing (an empty list), then stop.`,
        taskFor(run.id, breakpoint),
        BREAKPOINT_TOOLS,
        MAX_TURNS_PER_BREAKPOINT,
      )
      if (result.stopped === 'failed' || result.stopped === 'refused') {
        emit({ type: 'status', message: `The ${breakpoint} review stopped early (${result.stopped}).` })
      }
      const draft = context.runs.readDrafts(run.id)[breakpoint]
      if (!draft) emit({ type: 'status', message: `No draft rows were saved for ${breakpoint}.` })
      else summary.rowsDrafted += draft.length
    }

    if (controller.signal.aborted) {
      return finish(overBudget ? 'budget' : 'aborted', overBudget ? `Stopped: the run used more than ${options.budgetTokens?.toLocaleString()} tokens. Drafts so far are saved in the run folder (${run.id}).` : 'Stopped.')
    }

    const drafts = context.runs.readDrafts(run.id)
    const rows = breakpoints.flatMap((bp) => (drafts[bp] ?? []) as Array<{ cells: Record<string, string>; evidence?: unknown }>)
    if (!rows.length) return finish('completed', 'No differences were found worth reporting, so nothing was handed over.')

    // With one breakpoint there is nothing to merge; hand the rows over directly.
    if (breakpoints.length === 1) {
      emit({ type: 'status', message: `Handing over ${rows.length} row(s) for approval…` })
      const result = await finalize({ runId: run.id, rows })
      emit({ type: 'tool-result', name: 'finalize_rows', isError: !!result.isError, text: result.text, images: 0 })
      return finish('completed', summary.finalized ? result.text : `The rows were not copied. ${result.text}`)
    }

    emit({ type: 'status', message: `Merging ${rows.length} drafted row(s) from ${breakpoints.length} breakpoints…` })
    const merged = await conversation(
      mergeInstructions(format.columns, format.examples),
      `Run id: ${run.id}.\nDrafted rows (JSON):\n${JSON.stringify(rows)}\n\nMerge them and call finalize_rows with runId "${run.id}".`,
      MERGE_TOOLS,
      MAX_TURNS_MERGE,
    )
    if (controller.signal.aborted) return finish(overBudget ? 'budget' : 'aborted', overBudget ? 'Stopped: the token budget was reached while merging. Drafts are saved in the run folder.' : 'Stopped.')
    if (!finalizeCalled) {
      emit({ type: 'status', message: `The merge step did not hand the rows over (${merged.stopped}); handing over the unmerged rows instead.` })
      const result = await finalize({ runId: run.id, rows })
      return finish('completed', result.text)
    }
    return finish('completed', summary.finalized ? (merged.text || 'The rows were copied.') : 'The rows were handed over but not approved, so nothing was copied.')
  } catch (error: any) {
    return finish('failed', `The review failed: ${error?.message || 'unknown error'}`)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

