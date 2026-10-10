import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as z from 'zod'
import type { QaExecutionSnapshot, QaRunEvent } from '../../shared/qaAgent'
import type { AgentProvider, ProviderResult } from './agents/types'
import { defineTool, type ToolResult } from './toolBasics'
import type { QaContext } from './tools'

const hash = (value: unknown) => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const IMMUTABLE = new Set(['get_overview', 'get_section', 'read_result', 'read_chat_images'])
const EFFECTS = new Set(['save_draft', 'finalize_rows', 'set_design','workspace_propose'])
const ACTIONS = new Set(['browser_click', 'browser_type', 'browser_select', 'browser_press', 'http_request'])
const PAGE_SIZE = 16_000
export function failureCategory(text: string) {
  return /budget|token limit|token budget/i.test(text) ? 'budget' : /quota|daily|requests.*used up/i.test(text) ? 'quota'
    : /key|signed.?in|sign.?in|authenticat|permission/i.test(text) ? 'account' : /refus|declin/i.test(text) ? 'refused'
    : /invalid input|unknown option|not available|different project|changed|missing/i.test(text) ? 'input' : 'transient'
}

export class ToolScheduler {
  private queue: Array<{ read: boolean; work: () => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void; signal: AbortSignal }> = []
  private readers = 0
  private exclusive = false
  run<T>(read: boolean, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const item = { read, work: async () => { signal.removeEventListener('abort', cancel); return work() }, resolve, reject, signal }
      const cancel = () => { const index = this.queue.indexOf(item); if (index >= 0) { this.queue.splice(index, 1); reject(new Error('Stopped.')) } }
      this.queue.push(item); signal.addEventListener('abort', cancel, { once: true }); this.pump()
    })
  }
  private pump() {
    if (this.exclusive) return
    while (this.queue.length) {
      const item = this.queue[0]
      if (item.signal.aborted) { this.queue.shift(); item.reject(new Error('Stopped.')); continue }
      if (item.read ? this.readers >= 3 : this.readers > 0) return
      this.queue.shift()
      if (item.read) this.readers++; else this.exclusive = true
      Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => { if (item.read) this.readers--; else this.exclusive = false; this.pump() })
      if (!item.read) return
    }
  }
}

interface Stage { checkpoint?: unknown; result?: ProviderResult; browser: boolean; browserStamp?: string; effects?: boolean; providerKey?: string }
interface RecordState {
  id: string; fingerprint: string; request: unknown; snapshot: QaExecutionSnapshot
  stages: Record<string, Stage>; runs: Record<string, string>; receipts: Record<string, ToolResult>
  calls: Record<string, { name: string; args: unknown; failed: boolean; fingerprint: string; browser: boolean }>
  uncertainEffect?: boolean; activeStage?: string
  approvedRows?: string[]
}
const encode = (value: unknown) => JSON.stringify(value)
const decode = (text: string) => JSON.parse(text, (_key, value) => value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value)

/** Local checkpoints and retry targets are owned by main, never supplied by the renderer. */
export class QaExecution {
  readonly state: RecordState
  private scheduler = new ToolScheduler()
  private cache = new Map<string, Promise<ToolResult>>()
  private signal = new AbortController().signal
  private emitRaw: (event: QaRunEvent) => void = () => {}
  private claims: Array<{ name: string; args: unknown; id: string }> = []
  private runOccurrences = new Map<string, number>()
  private context!: QaContext
  private activeTools = 0
  private partialFailures = false
  private receiptPending = new Map<string, Promise<unknown>>()
  private pendingApproved: string[] = []
  private errors = new Set<string>()
  private messageId: string | null = null
  private completedCalls = new Set<string>()
  private browserRevision = 0
  private browserStamp() { return hash({ run: this.context.browser?.runId, breakpoint: this.context.browser?.breakpoint, revision: this.browserRevision }) }
  constructor(readonly folder: string, fingerprint: string, request: unknown, restored?: RecordState) {
    const id = randomUUID()
    this.state = restored || { id, fingerprint, request, stages: {}, runs: {}, receipts: {}, calls: {}, snapshot: { executionId: id, attemptId: randomUUID(), attempt: 0, startedAt: 0, phase: 'idle', phaseStartedAt: 0, running: false, tokens: 0 } }
  }
  static load(folder: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null
    try {
      const value = decode(readFileSync(join(folder, id, 'execution.json'), 'utf8')) as RecordState
      if (value.snapshot?.running) { value.snapshot.running = false; value.snapshot.retryId = value.id; value.snapshot.phase = 'idle' }
      return value.id === id ? new QaExecution(folder, value.fingerprint, value.request, value) : null
    } catch { return null }
  }
  persist() {
    const folder = join(this.folder, this.state.id); mkdirSync(folder, { recursive: true })
    const target = join(folder, 'execution.json'); writeFileSync(target + '.tmp', encode(this.state)); renameSync(target + '.tmp', target)
  }
  snapshot() { return { ...this.state.snapshot } }
  emit(event: QaRunEvent) {
    const meta = { executionId: this.state.id, attemptId: this.state.snapshot.attemptId, timestamp: Date.now() }
    if (event.type === 'text') {
      this.messageId ||= randomUUID()
      event = { ...event, messageId: event.messageId || this.messageId }
      if (!event.delta) this.messageId = null
    }
    if (event.type === 'usage') this.state.snapshot.tokens += event.inputTokens + event.outputTokens
    if (event.type === 'error') {
      this.partialFailures = true
      const key = event.message.replace(/^The review failed:\s*/, '')
      if (this.errors.has(key)) return
      this.errors.add(key)
      const category = event.category || failureCategory(event.message)
      event = { ...event, category, retryId: this.state.id, retryBlocked: this.state.uncertainEffect ? 'Check result before retrying: a site action may already have been submitted.' : undefined }
    }
    if (event.type === 'tool' || (event.type === 'activity' && event.phase === 'waiting')) this.messageId = null
    if (event.type === 'activity') Object.assign(this.state.snapshot, { phase: event.phase, phaseStartedAt: event.startedAt, retryAt: event.retryAt })
    this.emitRaw({ ...event, ...meta })
  }
  phase(phase: QaExecutionSnapshot['phase'], retryAt?: number) { this.emit({ type: 'activity', phase, startedAt: Date.now(), retryAt }) }
  begin(context: QaContext, signal: AbortSignal, emit: (event: QaRunEvent) => void) {
    this.signal = signal; this.emitRaw = emit; this.context = context; this.claims = []; this.completedCalls.clear(); this.runOccurrences.clear(); this.partialFailures = false; this.errors.clear()
    Object.assign(this.state.snapshot, { running: true, attempt: this.state.snapshot.attempt + 1, attemptId: randomUUID(), startedAt: Date.now(), retryId: undefined, retryBlocked: undefined })
    this.phase('waiting'); this.persist(); this.emitRaw({ type: 'execution', snapshot: this.snapshot() })
  }
  finish() {
    Object.assign(this.state.snapshot, { running: false, phase: 'idle', retryId: this.partialFailures ? this.state.id : undefined, retryBlocked: this.state.uncertainEffect ? 'Check result before retrying: a site action may already have been submitted.' : undefined })
    this.cache.clear()
    this.persist(); this.emitRaw({ type: 'execution', snapshot: this.snapshot() })
  }
  validate(fingerprint: string) {
    if (fingerprint !== this.state.fingerprint) return 'The page, designs, or review settings changed. Start a fresh review.'
    if (this.state.uncertainEffect) return 'Check result before retrying: a site action may already have been submitted.'
    return null
  }
  wrapContext(original: QaContext): QaContext {
    const receipt = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
      if (this.state.receipts[key]) return this.state.receipts[key] as T
      if (this.receiptPending.has(key)) return this.receiptPending.get(key) as Promise<T>
      const task = work().then(value => { if (!this.signal.aborted) { this.state.receipts[key] = value as ToolResult; this.persist() } return value }).finally(() => this.receiptPending.delete(key))
      this.receiptPending.set(key, task); return task
    }
    return { ...original,
      dispatchTool: (name, args, work) => this.dispatch(name, args, work),
      runs: { ...original.runs, create: input => {
        const identity = hash(input); const occurrence = this.runOccurrences.get(identity) || 0; this.runOccurrences.set(identity, occurrence + 1)
        const key = identity + ':' + occurrence
        const existing = this.state.runs[key]
        if (existing) { const meta = original.runs.get(existing); if (!meta) throw new Error('Saved review captures are missing. Start a fresh review.'); return meta }
        const run = original.runs.create(input); this.state.runs[key] = run.id; this.persist(); return run
      } },
      approve: async request => {
        this.phase('approval')
        const rowKeys = request.rows.map((row, index) => hash({ row, columns: request.columns, page: request.rowPages?.[index]?.url || request.pageUrl }))
        const finalDecision = await receipt('approve:' + hash({ rows: request.rows, project: request.projectName, page: request.pageUrl }), async () => {
          const kept = rowKeys.flatMap((key, index) => this.state.approvedRows?.includes(key) ? [] : [index])
          const old = rowKeys.flatMap((key, index) => this.state.approvedRows?.includes(key) ? [index] : [])
          if (!kept.length) return { approved: true, excludedRows: old }
          const decision = await original.approve({ ...request, rows: kept.map(index => request.rows[index]), rowPages: request.rowPages ? kept.map(index => request.rowPages![index]) : undefined,
            evidence: request.evidence.filter(item => kept.includes(item.rowIndex)).map(item => ({ ...item, rowIndex: kept.indexOf(item.rowIndex) })),
            warnings: old.length ? [...request.warnings, `${old.length} previously copied findings are retained in History and excluded from this retry.`] : request.warnings,
          })
          const excluded = [...old, ...(decision.excludedRows || []).map(index => kept[index])]
          return { ...decision, excludedRows: excluded }
        })
        if (finalDecision.approved) this.pendingApproved = rowKeys.filter((_key, index) => !finalDecision.excludedRows?.includes(index))
        return finalDecision
      },
      copyToClipboard: (text, html) => { const key = 'clipboard:' + hash(text); if (!this.state.receipts[key]) { original.copyToClipboard(text, html); this.state.receipts[key] = { text: 'Copied' }; this.state.approvedRows = [...new Set([...(this.state.approvedRows || []), ...this.pendingApproved])]; this.persist() } },
      evidence: original.evidence ? { ...original.evidence, upload: async items => {
        const results: Array<{ url?: string; error?: string }> = []
        for (const item of items) {
          const key = 'upload:' + hash({ data: hash(item.data), label: item.label })
          const previous = this.state.receipts[key] as unknown as { url?: string } | undefined
          if (previous?.url) { results.push(previous); continue }
          const [value] = await original.evidence!.upload([item])
          results.push(value || { error: 'Evidence upload did not return a result.' })
          if (value?.url) { this.state.receipts[key] = value as unknown as ToolResult; this.persist() }
        }
        return results
      } } : undefined,
    }
  }
  wrapProvider(provider: AgentProvider, configurationKey = ''): AgentProvider {
    return { ...provider, run: async run => {
      const key = hash({ system: run.system, task: run.task, tools: run.tools })
      const previous = this.state.stages[key]
      if (previous?.result?.stopped === 'finished') { this.emit({ type: 'status', message: 'Keeping a completed review check.' }); return previous.result }
      const stage: Stage = previous || { browser: false }
      const providerKey = provider.id + ':' + provider.label + ':' + configurationKey
      if (stage.providerKey && stage.providerKey !== providerKey) stage.checkpoint = undefined
      stage.providerKey = providerKey
      this.state.stages[key] = stage; this.state.activeStage = key
      this.persist(); this.phase('waiting')
      try {
        const result = await provider.run({ ...run,
          task: provider.needsBridge && this.state.snapshot.attempt > 1 ? run.task + '\nThis is a retry of this unfinished check. The original run and completed captures/drafts are retained; inspect those artifacts and complete only the unfinished work. Never repeat completed submissions.' : run.task,
          resume: !stage.browser || stage.browserStamp === this.browserStamp() ? stage.checkpoint : undefined,
          checkpoint: checkpoint => { stage.checkpoint = checkpoint; stage.browserStamp = this.browserStamp(); this.persist() },
          emit: event => {
            if (event.type === 'tool') { this.claims.push({ name: event.name, args: event.args, id: event.callId || randomUUID() }); return }
            if (event.type === 'tool-result') {
              if (event.callId && this.completedCalls.has(event.callId)) return
              const index = this.claims.findIndex(claim => event.callId ? claim.id === event.callId : claim.name === event.name)
              if (index >= 0) {
                const claim = this.claims.splice(index, 1)[0]
                this.emit({ type: 'tool', name: claim.name, args: claim.args, callId: claim.id })
                this.emit({ ...event, name: claim.name, callId: claim.id })
              }
              return
            }
            this.emit(event)
          },
        })
        stage.result = result
        if (result.stopped === 'finished') stage.checkpoint = undefined
        if (result.stopped === 'finished' && stage.effects) this.state.uncertainEffect = false
        if (result.stopped === 'failed' || result.stopped === 'refused' || result.stopped === 'max-turns') this.emit({ type: 'error', message: result.stopped === 'max-turns' ? 'The agent reached its step limit. Retry to continue this check.' : 'This check ended before it finished.' })
        this.persist(); return result
      } catch (error) { this.partialFailures = true; if (!this.signal.aborted) this.emit({ type: 'error', message: error instanceof Error ? error.message : 'This check could not finish. Retry the failed check.', detail: error instanceof Error ? error.stack : undefined }); this.persist(); throw error }
    } }
  }
  async dispatch(name: string, args: unknown, work: () => Promise<ToolResult>): Promise<ToolResult> {
    let index = this.claims.findIndex(claim => claim.name === name && hash(claim.args ?? {}) === hash(args))
    if (index < 0) index = this.claims.findIndex(claim => claim.name === name)
    const claim = index >= 0 ? this.claims.splice(index, 1)[0] : null
    const callId = claim?.id || randomUUID()
    const fingerprint = this.state.fingerprint
    this.state.calls[callId] = { name, args, failed: false, fingerprint, browser: name.startsWith('browser_') }
    this.activeTools++; this.phase(name === 'finalize_rows' ? 'approval' : 'tools')
    this.emit({ type: 'tool', name, args, callId })
    const key = hash({ name, args, page: this.context.reportedContext()?.pageUrl })
    const effect = EFFECTS.has(name) || name === 'capture_live'
    let result: ToolResult
    try {
      const perform = () => this.scheduler.run(IMMUTABLE.has(name), async () => {
        if (effect && this.state.receipts[key]) return this.state.receipts[key]
        if (ACTIONS.has(name) && this.context.allowSend?.() && (name !== 'http_request' || !['GET', 'HEAD', 'OPTIONS'].includes(String((args as any)?.method || 'GET').toUpperCase()))) {
          this.state.uncertainEffect = true
          if (this.state.activeStage) this.state.stages[this.state.activeStage].effects = true
          this.persist()
        }
        if (this.state.activeStage && (name.startsWith('browser_') || ['inspect_element', 'check_contrast', 'check_layout', 'check_text', 'style_summary', 'seo_check', 'page_audit', 'http_request'].includes(name))) this.state.stages[this.state.activeStage].browser = true
        if (['browser_open', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_back', 'browser_scroll'].includes(name)) this.browserRevision++
        const value = await work()
        if (!value.isError && effect && !this.signal.aborted) { this.state.receipts[key] = value; this.persist() }
        if (name === 'save_draft' && !value.isError) {
          const input = args as any
          this.emit({ type: 'findings', runId: input.runId, pageUrl: this.context.reportedContext()?.pageUrl || '', breakpoint: input.breakpoint, area: input.area || 'visual', rows: input.rows })
        }
        return value
      }, this.signal)
      if (IMMUTABLE.has(name)) {
        if (!this.cache.has(key)) this.cache.set(key, perform())
        result = await this.cache.get(key)!
        if (result.isError) this.cache.delete(key)
      } else result = await perform()
    } catch (error) { result = { text: error instanceof Error ? error.message : 'The tool could not finish.', isError: true } }
    const resultId = this.saveResult(result.text)
    this.state.calls[callId].failed = !!result.isError
    this.completedCalls.add(callId)
    this.emit({ type: 'tool-result', name, callId, isError: !!result.isError, cancelled: this.signal.aborted, text: result.text.slice(0, PAGE_SIZE), images: result.images?.length || 0, resultId, retryId: result.isError && IMMUTABLE.has(name) ? `${this.state.id}/${callId}` : undefined })
    if (--this.activeTools === 0) this.phase('waiting')
    this.persist()
    return name !== 'read_result' && result.text.length > PAGE_SIZE ? { ...result, text: result.text.slice(0, PAGE_SIZE) + `\n[More output: read_result with resultId "${this.state.id}/${resultId}", offset ${PAGE_SIZE}. Total ${result.text.length} characters.]` } : result
  }
  saveResult(text: string) {
    const id = randomUUID(); const folder = join(this.folder, this.state.id, 'results'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, id + '.txt'), text); return id
  }
  readResult(id: string, offset = 0) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('That result is not available.')
    const text = readFileSync(join(this.folder, this.state.id, 'results', id + '.txt'), 'utf8')
    const start = Math.max(0, Math.floor(offset)); return { text: text.slice(start, start + PAGE_SIZE), total: text.length, nextOffset: start + PAGE_SIZE < text.length ? start + PAGE_SIZE : null }
  }
  async retryTool(callId: string, context: QaContext) {
    const call = this.state.calls[callId]
    if (!call?.failed || !IMMUTABLE.has(call.name)) throw new Error('This tool cannot be retried separately. Retry the unfinished check.')
    const { callTool } = await import('./tools')
    return callTool(call.name, call.args, context)
  }
}

export const readResultTool = defineTool({
  name: 'read_result', title: 'Read more tool output', description: 'Read the next 16000 characters of saved tool output. Follow nextOffset until all relevant findings have been read.',
  input: z.object({ resultId: z.string().regex(/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/), offset: z.number().int().min(0).default(0) }),
  readOnly: true, agentAllowed: true,
  async run(args, context) { return context.readResult ? { text: JSON.stringify(context.readResult(args.resultId, args.offset)) } : { text: 'This saved output is not available in the current execution.', isError: true } },
})
