import { readCompletionStream } from './stream'
import { imagePlaceholder, executeToolCalls, isAbortError, KEEP_IMAGE_TURNS, summarize, toolSchemas } from './common'
import { AgentError, QuotaError, type AgentProvider, type ProviderResult, type ProviderRun } from './types'

// Any server that speaks the Chat Completions API: OpenAI itself, Gemini, OpenRouter, and local
// servers such as Ollama or LM Studio. Chat Completions cannot carry pictures inside a tool result,
// so the pictures a tool returns arrive in a user message right after the tool results.
//
// Free tiers allow a few requests a minute, so a rate limit is waited out (as long as the server
// asks, up to about a minute) instead of ending the run; a used-up daily allowance ends it with a
// message that says so.

export interface OpenAiCompatibleConfig {
  id: string
  label: string
  /** For example https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: string
  apiKey?: string
  model: string
  /** Sent with every request, for example OpenRouter's app name. */
  headers?: Record<string, string>
  /** A free tier: runs are kept short and fewer pictures stay in the conversation. */
  lite?: boolean
  /** What to tell the person when today's free requests are used up. */
  dailyLimitHint?: string
  /** The longest wait for a rate limit to pass. Tests shorten it. */
  maxWaitMs?: number
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Part[]; carriesImages?: boolean }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string | Record<string, unknown> } }

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const MAX_RETRIES = 3
const DEFAULT_MAX_WAIT_MS = 65_000
/** Waits when the server does not say how long: free tiers count per minute. */
const BACKOFF_MS = [10_000, 25_000, 60_000]
/** Fewer pictures for a free tier: its per-minute token allowance is small. */
const LITE_KEEP_IMAGE_TURNS = 2

/** The error object of a failed response. Gemini wraps it in a list. */
function errorOf(body: string): { message: string; code?: number } {
  try {
    const parsed = JSON.parse(body)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const error = first?.error ?? first
    // OpenRouter puts the provider's own message under metadata.raw.
    const raw = typeof error?.metadata?.raw === 'string' ? error.metadata.raw : ''
    return { message: String(error?.message || first?.message || raw || ''), code: Number(error?.code) || undefined }
  } catch { return { message: body.slice(0, 200) } }
}

/** A quota for the day, not the minute: waiting a minute will not help. A per-minute marker wins, as a minute's limit may still mention the daily one. */
export const isDailyLimit = (body: string) => !/per[\s_-]?min|PerMinute/i.test(body) && /per[\s_-]?day|PerDay|daily (limit|quota)/i.test(body)

/** How long the server asked to wait, from Retry-After, an X-RateLimit-Reset time, or Gemini's retryDelay. */
export function retryDelayMs(headers: Headers, body: string, now = Date.now()): number | null {
  const after = headers.get('retry-after')
  if (after) {
    const seconds = Number(after)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(after)
    if (!Number.isNaN(date)) return Math.max(0, date - now)
  }
  // OpenRouter sends the reset time in ms since 1970; others send seconds.
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset > 1e12 ? reset - now : reset > 1e9 ? reset * 1000 - now : reset * 1000)
  const asked = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body) ?? /retry (?:in|after) (\d+(?:\.\d+)?)\s*s/i.exec(body)
  return asked ? Math.round(Number(asked[1]) * 1000) : null
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done)
})

export function trimCarriedImages(messages: Message[], keepTurns = KEEP_IMAGE_TURNS): void {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' || !message.carriesImages || !Array.isArray(message.content) || !message.content.some(part => part.type === 'image_url')) continue
    seen++
    if (seen <= keepTurns) continue
    message.content = message.content.map((part) => (part.type === 'image_url' ? { type: 'text' as const, text: imagePlaceholder({ caption: 'earlier picture' }) } : part))
  }
}

function dailyLimitError(config: OpenAiCompatibleConfig): AgentError {
  return new QuotaError(`Today's free requests on ${config.label} are used up. ${config.dailyLimitHint ?? 'They come back tomorrow; until then, pick another model or agent in Settings → AI Agents.'}`)
}

function describeFailure(config: OpenAiCompatibleConfig, status: number, body: string): AgentError {
  const detail = errorOf(body).message
  if (status === 401 || status === 403) return new AgentError(`${config.label} rejected the API key. Check it in Settings → AI Agents.`)
  if (status === 404) return new AgentError(`${config.label} does not know the model "${config.model}"${detail ? ` (${detail})` : ''}. Pick another in Settings → AI Agents.`)
  if (status === 429) return new AgentError(`${config.label} is still rate limiting this key${config.lite ? ' (free tier)' : ''}. Wait a few minutes and run again${config.lite ? ', or pick another free model' : ''}.`)
  if (status === 502 || status === 503 || status === 529) return new AgentError(`${config.label} is overloaded right now${detail ? ` (${detail.slice(0, 160)})` : ''}. Try again in a few minutes${config.lite ? ', or pick another free model' : ''}.`)
  if (/tool/i.test(detail) && /support/i.test(detail)) return new AgentError(`The model "${config.model}" does not support tool calling, which the QA review needs. Pick another model.`)
  if (/image|vision|multimodal/i.test(detail)) return new AgentError(`The model "${config.model}" cannot read pictures, which the QA review needs. Pick a vision model.`)
  return new AgentError(`${config.label} returned an error (${status})${detail ? `: ${detail}` : '.'}`)
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): AgentProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const maxWait = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  return {
    id: config.id,
    label: config.label,
    lite: !!config.lite,
    async run(run: ProviderRun): Promise<ProviderResult> {
      const tools = toolSchemas(run.tools).map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.schema } }))
      const messages: Message[] = (run.resume as { messages?: Message[] } | undefined)?.messages || [{ role: 'system', content: run.system }, ...(run.history ?? []).map((turn): Message => (turn.role === 'user' ? { role: 'user', content: turn.text } : { role: 'assistant', content: turn.text })), { role: 'user', content: run.task }]
      let lastText = (run.resume as { lastText?: string } | undefined)?.lastText || ''
      let streaming = true

      /** One completion, waiting out rate limits. Null when the person stopped the run. */
      const complete = async (): Promise<any | null> => {
        run.emit({ type: 'activity', phase: 'waiting', startedAt: Date.now() })
        for (let attempt = 0; ; attempt++) {
        const payload = JSON.stringify({ model: config.model, messages: messages.map((message) => { const { carriesImages: _carries, ...wire } = message as Message & { carriesImages?: boolean }; return wire }), tools, tool_choice: 'auto', ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}) })
          let response: Response
          let text: string
          try {
            response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...config.headers, ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
              body: payload,
              signal: AbortSignal.any([run.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            })
            if (response.ok && /text\/event-stream/i.test(response.headers.get('content-type') || '')) return await readCompletionStream(response, text => run.emit({ type: 'text', text, delta: true }))
            text = await response.text()
          } catch (error: any) {
            if (run.signal.aborted) return null
            if (error?.status && error?.body) { if (error.status === 429 && isDailyLimit(error.body)) throw dailyLimitError(config); throw describeFailure(config, error.status, error.body) }
            if (isAbortError(error) || error?.name === 'TimeoutError') throw new AgentError(`${config.label} did not answer within 5 minutes.`)
            if (error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message || '')) throw new AgentError(`Could not reach ${config.label} at ${config.baseUrl}. Is it running?`)
            throw new AgentError(error?.message || `${config.label} did not return a usable answer.`)
          }
          let body: any = null
          try { body = JSON.parse(text) } catch { /* handled below */ }
          // OpenRouter can answer 200 with the provider's error in the body.
          const status = response.ok && body?.error && !body.choices ? Number(body.error.code) || 502 : response.status
          if (status >= 200 && status < 300) {
            if (!body) throw new AgentError(`${config.label} did not return a usable answer.`)
            return body
          }
          if (streaming && [400, 422, 501].includes(status) && /stream/i.test(text) && /unsupported|not support|not allowed|unknown|unrecognized/i.test(text)) { streaming = false; attempt--; continue }
          if (status === 429 && isDailyLimit(text)) throw dailyLimitError(config)
          if (![429, 502, 503, 529].includes(status) || attempt >= MAX_RETRIES) throw describeFailure(config, status, text)
          const asked = retryDelayMs(response.headers, text)
          // A wait of many minutes is a limit for the hour or the day, not a busy moment.
          if (asked !== null && asked > maxWait) throw status === 429 ? new AgentError(`${config.label} asks to wait about ${Math.ceil(asked / 60_000)} minute(s) before the next request${config.lite ? ' (free tier limit)' : ''}. Try again later, or pick another agent in Settings → AI Agents.`) : describeFailure(config, status, text)
          const wait = Math.min(asked ?? BACKOFF_MS[attempt], maxWait)
          run.emit({ type: 'status', message: `${config.label} is ${status === 429 ? `rate limiting${config.lite ? ' (free tier)' : ''}` : 'busy'}. Waiting ${Math.max(1, Math.round(wait / 1000))}s, then trying again (${attempt + 1} of ${MAX_RETRIES})…` })
          run.emit({ type: 'activity', phase: 'retrying', startedAt: Date.now(), retryAt: Date.now() + wait })
          await pause(wait, run.signal)
          run.emit({ type: 'activity', phase: 'waiting', startedAt: Date.now() })
          if (run.signal.aborted) return null
        }
      }

      for (let turn = 0; turn < run.maxTurns; turn++) {
        if (run.signal.aborted) return { stopped: 'aborted', text: lastText }
        trimCarriedImages(messages, config.lite ? LITE_KEEP_IMAGE_TURNS : KEEP_IMAGE_TURNS)
        run.checkpoint?.({ messages: structuredClone(messages), lastText, turn })
        const body = await complete()
        if (!body) return { stopped: 'aborted', text: lastText }

        if (body.usage) run.emit({ type: 'usage', inputTokens: Number(body.usage.prompt_tokens) || 0, outputTokens: Number(body.usage.completion_tokens) || 0 })
        const choice = body.choices?.[0]
        const message = choice?.message
        if (!message) throw new AgentError(`${config.label} returned no answer.`)
        const text = typeof message.content === 'string' ? message.content.trim() : ''
        if (text) { lastText = text; if (!body.streamed) run.emit({ type: 'text', text }) }
        const calls: ToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : []
        if (calls.some(call => !call || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name)) throw new AgentError('The provider returned an incomplete tool call. Retry this message.')

        if (choice.finish_reason === 'content_filter') {
          run.emit({ type: 'error', message: `${config.label} declined this request. Try a different model in Settings → AI Agents.` })
          return { stopped: 'refused', text: lastText }
        }
        if (!calls.length) {
          if (choice.finish_reason === 'length') {
            run.emit({ type: 'error', message: 'The model ran out of room for its answer. Run again, or pick a different model.' })
            return { stopped: 'failed', text: lastText }
          }
          return { stopped: 'finished', text: lastText }
        }

        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls })
        const carried: Part[] = []
        const outputs = new Map<string, { text: string; images: Part[] }>()
        const activeImages = new Set(messages.flatMap(m => m.role === 'user' && Array.isArray(m.content) ? m.content.flatMap(p => p.type === 'image_url' ? [p.image_url.url] : []) : []))
        await executeToolCalls(calls, call => call.function?.name, async call => {
          if (run.signal.aborted) return
          const name = call.function?.name
          let args: unknown
          let parseProblem = ''
          try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments ?? {} } catch { parseProblem = "The arguments were not valid JSON. Send a JSON object matching the tool schema." }
          run.emit({ type: 'tool', name, args, callId: call.id })
          const result = parseProblem ? { text: parseProblem, isError: true } : await run.call(name, args, call.id)
          const images = 'images' in result && result.images ? result.images : []
          run.emit({ type: 'tool-result', name, callId: call.id, isError: !!result.isError, text: summarize(result.text), images: images.length })
          const parts: Part[] = []
          for (const image of images) {
            const url = `data:${image.mimeType};base64,${image.data.toString('base64')}`
            if (activeImages.has(url)) parts.push({ type: 'text', text: `${name}: ${image.caption} (identical image already attached above)` })
            else { activeImages.add(url); parts.push({ type: 'text', text: `${name}: ${image.caption}` }, { type: 'image_url', image_url: { url } }) }
          }
          outputs.set(call.id, { text: images.length ? `${result.text}\n(${images.length} picture(s) follow or are already attached above.)` : result.text, images: parts })
        })
        for (const call of calls) {
          const output = outputs.get(call.id)
          if (!output) return { stopped: 'aborted', text: lastText }
          messages.push({ role: 'tool', tool_call_id: call.id, content: output.text })
          carried.push(...output.images)
        }
        if (carried.length) messages.push({ role: 'user', content: carried, carriesImages: true })
      }
      return { stopped: 'max-turns', text: lastText }
    },
  }
}
