import { imagePlaceholder, isAbortError, KEEP_IMAGE_TURNS, summarize, toolSchemas } from './common'
import { AgentError, type AgentProvider, type ProviderResult, type ProviderRun } from './types'

// Any server that speaks the Chat Completions API: OpenAI itself, and local servers such as
// Ollama or LM Studio. Chat Completions cannot carry pictures inside a tool result, so the
// pictures a tool returns arrive in a user message right after the tool results.

export interface OpenAiCompatibleConfig {
  id: string
  label: string
  /** For example https://api.openai.com/v1 or http://localhost:11434/v1 */
  baseUrl: string
  apiKey?: string
  model: string
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Part[]; carriesImages?: boolean }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string | Record<string, unknown> } }

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export function trimCarriedImages(messages: Message[], keepTurns = KEEP_IMAGE_TURNS): void {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' || !message.carriesImages || !Array.isArray(message.content)) continue
    seen++
    if (seen <= keepTurns) continue
    message.content = message.content.map((part) => (part.type === 'image_url' ? { type: 'text' as const, text: imagePlaceholder({ caption: 'earlier picture' }) } : part))
  }
}

function describeFailure(config: OpenAiCompatibleConfig, status: number, body: string): AgentError {
  let detail = ''
  try { const parsed = JSON.parse(body); detail = parsed?.error?.message || parsed?.message || '' } catch { detail = body.slice(0, 200) }
  if (status === 401 || status === 403) return new AgentError(`${config.label} rejected the API key. Check it in Settings → AI Agents.`)
  if (status === 404) return new AgentError(`${config.label} does not know the model "${config.model}"${detail ? ` (${detail})` : ''}. Pick another in Settings → AI Agents.`)
  if (status === 429) return new AgentError(`${config.label} is rate limiting this key. Wait a minute and run again.`)
  if (/tool/i.test(detail) && /support/i.test(detail)) return new AgentError(`The model "${config.model}" does not support tool calling, which the QA review needs. Pick another model.`)
  if (/image|vision|multimodal/i.test(detail)) return new AgentError(`The model "${config.model}" cannot read pictures, which the QA review needs. Pick a vision model.`)
  return new AgentError(`${config.label} returned an error (${status})${detail ? `: ${detail}` : '.'}`)
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): AgentProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    id: config.id,
    label: config.label,
    async run(run: ProviderRun): Promise<ProviderResult> {
      const tools = toolSchemas(run.tools).map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.schema } }))
      const messages: Message[] = [{ role: 'system', content: run.system }, ...(run.history ?? []).map((turn): Message => (turn.role === 'user' ? { role: 'user', content: turn.text } : { role: 'assistant', content: turn.text })), { role: 'user', content: run.task }]
      let lastText = ''

      for (let turn = 0; turn < run.maxTurns; turn++) {
        if (run.signal.aborted) return { stopped: 'aborted', text: lastText }
        trimCarriedImages(messages)
        let body: any
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: JSON.stringify({ model: config.model, messages: messages.map((message) => { const { carriesImages: _carries, ...wire } = message as Message & { carriesImages?: boolean }; return wire }), tools, tool_choice: 'auto' }),
            signal: AbortSignal.any([run.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          })
          const text = await response.text()
          if (!response.ok) throw describeFailure(config, response.status, text)
          body = JSON.parse(text)
        } catch (error: any) {
          if (error instanceof AgentError) throw error
          if (run.signal.aborted || isAbortError(error)) {
            if (run.signal.aborted) return { stopped: 'aborted', text: lastText }
            throw new AgentError(`${config.label} did not answer within 5 minutes.`)
          }
          if (error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message || '')) throw new AgentError(`Could not reach ${config.label} at ${config.baseUrl}. Is it running?`)
          throw new AgentError(error?.message || `${config.label} did not return a usable answer.`)
        }

        if (body.usage) run.emit({ type: 'usage', inputTokens: Number(body.usage.prompt_tokens) || 0, outputTokens: Number(body.usage.completion_tokens) || 0 })
        const choice = body.choices?.[0]
        const message = choice?.message
        if (!message) throw new AgentError(`${config.label} returned no answer.`)
        const text = typeof message.content === 'string' ? message.content.trim() : ''
        if (text) { lastText = text; run.emit({ type: 'text', text }) }
        const calls: ToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : []

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
        for (const call of calls) {
          const name = call.function?.name
          let args: unknown
          let parseProblem = ''
          try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments ?? {} } catch { parseProblem = 'The arguments were not valid JSON. Send a JSON object that matches the tool\'s input schema.' }
          run.emit({ type: 'tool', name, args })
          const result = parseProblem ? { text: parseProblem, isError: true } : await run.call(name, args)
          const images = 'images' in result && result.images ? result.images : []
          run.emit({ type: 'tool-result', name, isError: !!result.isError, text: summarize(result.text), images: images.length })
          messages.push({ role: 'tool', tool_call_id: call.id, content: images.length ? `${result.text}\n(${images.length} picture(s) follow in the next message.)` : result.text })
          for (const image of images) {
            carried.push({ type: 'text', text: `${name}: ${image.caption}` }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data.toString('base64')}` } })
          }
        }
        if (carried.length) messages.push({ role: 'user', content: carried, carriesImages: true })
      }
      return { stopped: 'max-turns', text: lastText }
    },
  }
}
