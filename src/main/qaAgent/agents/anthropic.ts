import Anthropic from '@anthropic-ai/sdk'
import { summarize, imagePlaceholder, isAbortError, KEEP_IMAGE_TURNS, toolSchemas } from './common'
import { AgentError, type AgentProvider, type ProviderResult, type ProviderRun } from './types'

// Claude through the Anthropic API: a streaming tool loop (see the claude-api guide). The
// model draws conclusions from pictures; tools give it the pictures and values.

export interface AnthropicConfig {
  apiKey: string
  /** For example claude-opus-5-5. */
  model: string
  effort: 'low' | 'medium' | 'high'
  /** Overrides the API address (tests, proxies). */
  baseURL?: string
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5'
const MAX_OUTPUT_TOKENS = 32_000

// Haiku models do not take the effort setting.
const supportsEffort = (model: string) => !/haiku/i.test(model)

function friendly(error: unknown): AgentError {
  if (error instanceof Anthropic.AuthenticationError) return new AgentError('Anthropic rejected the API key. Check it in Settings → AI Agents.')
  if (error instanceof Anthropic.PermissionDeniedError) return new AgentError('This API key is not allowed to use that model.')
  if (error instanceof Anthropic.NotFoundError) return new AgentError('Anthropic does not know that model. Pick another in Settings → AI Agents.')
  if (error instanceof Anthropic.RateLimitError) return new AgentError('Anthropic is rate limiting this key. Wait a minute and run again.')
  if (error instanceof Anthropic.BadRequestError) return new AgentError(`Anthropic could not use the request: ${error.message}`)
  if (error instanceof Anthropic.APIConnectionError) return new AgentError('Could not reach Anthropic. Check the internet connection.')
  if (error instanceof Anthropic.APIError) return new AgentError(`Anthropic returned an error (${error.status}): ${error.message}`)
  return error instanceof Error ? new AgentError(error.message) : new AgentError('The request failed.')
}

/** Replaces pictures in all but the newest tool-result turns with a one-line note. */
export function trimOldImages(messages: Anthropic.MessageParam[], keepTurns = KEEP_IMAGE_TURNS): void {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const results = message.content.filter((block): block is Anthropic.ToolResultBlockParam => block.type === 'tool_result')
    if (!results.length) continue
    seen++
    if (seen <= keepTurns) continue
    for (const result of results) {
      if (!Array.isArray(result.content)) continue
      let captions = 0
      result.content = result.content.map((part) => {
        if (part.type !== 'image') return part
        captions++
        return { type: 'text' as const, text: imagePlaceholder({ caption: `picture ${captions}` }) }
      })
    }
  }
}

export function createAnthropicProvider(config: AnthropicConfig): AgentProvider {
  return {
    id: 'anthropic-api',
    label: `Claude API (${config.model})`,
    async run(run: ProviderRun): Promise<ProviderResult> {
      const client = new Anthropic({ apiKey: config.apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })
      const tools: Anthropic.Tool[] = toolSchemas(run.tools).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema as Anthropic.Tool.InputSchema }))
      const messages: Anthropic.MessageParam[] = [...(run.history ?? []).map((turn): Anthropic.MessageParam => ({ role: turn.role, content: turn.text })), { role: 'user', content: run.task }]
      let lastText = ''

      for (let turn = 0; turn < run.maxTurns; turn++) {
        if (run.signal.aborted) return { stopped: 'aborted', text: lastText }
        trimOldImages(messages)
        let message: Anthropic.Message
        try {
          const stream = client.messages.stream(
            {
              model: config.model,
              max_tokens: MAX_OUTPUT_TOKENS,
              system: run.system,
              tools,
              messages,
              ...(supportsEffort(config.model) ? { output_config: { effort: config.effort } } : {}),
            },
            { signal: run.signal },
          )
          stream.on('text', (delta) => run.emit({ type: 'text', text: delta, delta: true }))
          message = await stream.finalMessage()
        } catch (error) {
          if (isAbortError(error) || run.signal.aborted) return { stopped: 'aborted', text: lastText }
          throw friendly(error)
        }
        run.emit({ type: 'usage', inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens })

        const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map((block) => block.text).join('\n').trim()
        if (text) lastText = text

        if (message.stop_reason === 'refusal') {
          const category = message.stop_details?.category
          run.emit({ type: 'error', message: `The model declined this request${category ? ` (${category})` : ''}. Try a different model in Settings → AI Agents.` })
          return { stopped: 'refused', text: lastText }
        }
        if (message.stop_reason === 'max_tokens') {
          run.emit({ type: 'error', message: 'The model ran out of room for its answer. Run again, or pick a different model.' })
          return { stopped: 'failed', text: lastText }
        }
        messages.push({ role: 'assistant', content: message.content })
        if (message.stop_reason === 'pause_turn') continue
        if (message.stop_reason !== 'tool_use') return { stopped: 'finished', text: lastText }

        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of message.content) {
          if (block.type !== 'tool_use') continue
          run.emit({ type: 'tool', name: block.name, args: block.input })
          const result = await run.call(block.name, block.input)
          run.emit({ type: 'tool-result', name: block.name, isError: !!result.isError, text: summarize(result.text), images: result.images?.length ?? 0 })
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: !!result.isError,
            content: [
              { type: 'text', text: result.text },
              ...(result.images || []).flatMap((image): Anthropic.ImageBlockParam[] => (image.mimeType === 'image/webp' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/png'
                ? [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data.toString('base64') } }]
                : [])),
            ],
          })
        }
        messages.push({ role: 'user', content: results })
      }
      return { stopped: 'max-turns', text: lastText }
    },
  }
}
