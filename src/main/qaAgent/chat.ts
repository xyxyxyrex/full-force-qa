import { BROWSER_TOOL_NAMES } from './browserTools'
import { LITE_LIMITS } from './lite'
import { QA_AGENT_PROMPT } from './prompt'
import type { AgentEvent, AgentProvider, ChatTurn } from './agents/types'
import { callTool, type QaContext } from './tools'

// One message of the chat: the agent gets the earlier conversation (text only), may use the
// tools, and answers. Like a review, it only drafts; rows are approved by the person in Parity.

// Every tool except the one that changes which designs are stored: looking, testing in the agent's
// own browser, and writing rows.
export const CHAT_TOOLS = ['get_context', 'capture_live', 'get_overview', 'get_section', ...BROWSER_TOOL_NAMES, 'save_draft', 'finalize_rows']
export const MAX_CHAT_TURNS = 60
export const MAX_CHAT_HISTORY = 40

export interface ChatTurnOptions {
  message: string
  history: ChatTurn[]
  signal: AbortSignal
  emit(event: AgentEvent): void
  /** Stops the message once this many tokens (input + output) were used. 0 or undefined means no limit. */
  budgetTokens?: number
}

export interface ChatTurnResult {
  /** The conversation to remember, including this message. */
  history: ChatTurn[]
  stopped: 'finished' | 'aborted' | 'failed' | 'budget' | string
}

export async function runChatTurn(deps: { context: QaContext; provider: AgentProvider }, options: ChatTurnOptions): Promise<ChatTurnResult> {
  const { context, provider } = deps
  const { message, history, emit } = options
  const controller = new AbortController()
  const stop = () => controller.abort()
  options.signal.addEventListener('abort', stop)
  if (options.signal.aborted) controller.abort()
  let tokens = 0
  let overBudget = false
  try {
    const result = await provider.run({
      system: QA_AGENT_PROMPT,
      task: message,
      history,
      tools: CHAT_TOOLS,
      maxTurns: provider.lite ? LITE_LIMITS.chatTurns : MAX_CHAT_TURNS,
      signal: controller.signal,
      call: (name, args) => (CHAT_TOOLS.includes(name) ? callTool(name, args, context) : Promise.resolve({ text: `The tool "${name}" is not available in this chat.`, isError: true })),
      emit: (event) => {
        if (event.type === 'usage') {
          tokens += event.inputTokens + event.outputTokens
          if (options.budgetTokens && tokens > options.budgetTokens && !overBudget) { overBudget = true; controller.abort() }
        }
        emit(event)
      },
    })
    if (overBudget) emit({ type: 'error', message: `Stopped: this message used more than ${options.budgetTokens?.toLocaleString()} tokens (the limit in Settings → AI Agents).` })
    else if (result.stopped === 'max-turns' && provider.lite) emit({ type: 'status', message: `The free model used its ${LITE_LIMITS.chatTurns} steps for one message. Ask for one thing at a time ("check the contrast", "any broken links?"), or use /review.` })
    const answer = result.text || (result.stopped === 'finished' ? '(no reply)' : '(stopped before answering)')
    return { history: [...history, { role: 'user' as const, text: message }, { role: 'assistant' as const, text: answer }].slice(-MAX_CHAT_HISTORY), stopped: overBudget ? 'budget' : result.stopped }
  } finally {
    options.signal.removeEventListener('abort', stop)
  }
}
