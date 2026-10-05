import { useSyncExternalStore } from 'react'
import type { QaRunEvent, QaStoredChat } from '../../../shared/qaAgent'

// The QA chat's transcript and token counts live here, outside React, so they survive the chat
// panel being closed or the editor being reopened. Main keeps what the agent remembers; this is
// only what is shown.

export type ChatMessage =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'tool'; name: string; args: unknown; pending: boolean; isError?: boolean; result?: string; images?: number }
  | { id: number; kind: 'status' | 'error' | 'usage'; text: string }

export interface TokenCounts {
  input: number
  output: number
  /** Requests sent to the model (each one re-sends the conversation, so input grows quickly). */
  requests: number
}

export interface ChatState {
  messages: ChatMessage[]
  running: boolean
  agentLabel: string
  /** Everything used since "New chat". */
  session: TokenCounts
  /** The current or last message. */
  turn: TokenCounts
  /** Size of the newest request's input: roughly how much the agent is holding in mind. */
  context: number
  budgetTokens: number
  /** False until the agent reports usage; some agent CLIs never do. */
  usageReported: boolean
  /** The saved chat this is, once something was said; null for a fresh chat. */
  chatId: string | null
  title: string
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

const MAX_MESSAGES = 400
const zero = (): TokenCounts => ({ input: 0, output: 0, requests: 0 })
const initial = (): ChatState => ({ messages: [], running: false, agentLabel: '', session: zero(), turn: zero(), context: 0, budgetTokens: 0, usageReported: false, chatId: null, title: '' })
const newChatId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const KINDS = new Set(['user', 'assistant', 'tool', 'status', 'error', 'usage'])

let state: ChatState = initial()
let nextId = 1
let streaming = false
let subscribed = false
const listeners = new Set<() => void>()

const publish = (next: ChatState) => { state = next; listeners.forEach((listener) => listener()) }
const cap = (messages: ChatMessage[]) => (messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages)

// The chat is saved (what it shows and its token counts) shortly after each message and each answer.
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const { chatId, title, agentLabel, messages, session } = state
    if (!chatId || !messages.length || typeof window === 'undefined' || !window.electronAPI?.qaChatsSave) return
    void window.electronAPI.qaChatsSave({ id: chatId, title, agentLabel, messages, session }).catch(() => { /* saving is a convenience */ })
  }, 400)
}

function append(message: DistributiveOmit<ChatMessage, 'id'>): void {
  streaming = false
  publish({ ...state, messages: cap([...state.messages, { ...message, id: nextId++ } as ChatMessage]) })
}

export const tokenTotal = (counts: TokenCounts) => counts.input + counts.output

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 100_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function onEvent(event: QaRunEvent): void {
  switch (event.type) {
    case 'started':
      streaming = false
      publish({ ...state, running: true, agentLabel: event.label, turn: zero(), budgetTokens: event.budgetTokens ?? 0 })
      break
    case 'status': append({ kind: 'status', text: event.message }); break
    case 'text': {
      const last = state.messages[state.messages.length - 1]
      if (event.delta && streaming && last?.kind === 'assistant') {
        publish({ ...state, messages: [...state.messages.slice(0, -1), { ...last, text: last.text + event.text }] })
      } else {
        append({ kind: 'assistant', text: event.text })
      }
      streaming = !!event.delta
      break
    }
    case 'tool': append({ kind: 'tool', name: event.name, args: event.args, pending: true }); break
    case 'tool-result': {
      streaming = false
      let index = -1
      // Results come back in the order the calls were made, so the oldest waiting card is theirs.
      for (let i = 0; i < state.messages.length; i++) {
        const message = state.messages[i]
        if (message.kind === 'tool' && message.pending && message.name === event.name) { index = i; break }
      }
      if (index < 0) { append({ kind: 'tool', name: event.name, args: undefined, pending: false, isError: event.isError, result: event.text, images: event.images }); break }
      const messages = state.messages.slice()
      messages[index] = { ...(messages[index] as Extract<ChatMessage, { kind: 'tool' }>), pending: false, isError: event.isError, result: event.text, images: event.images }
      publish({ ...state, messages })
      break
    }
    case 'usage':
      publish({
        ...state,
        usageReported: true,
        context: event.inputTokens,
        session: { input: state.session.input + event.inputTokens, output: state.session.output + event.outputTokens, requests: state.session.requests + 1 },
        turn: { input: state.turn.input + event.inputTokens, output: state.turn.output + event.outputTokens, requests: state.turn.requests + 1 },
      })
      break
    case 'error': append({ kind: 'error', text: event.message }); break
    case 'done': append({ kind: 'status', text: event.message }); break
    case 'finished': {
      const turn = state.turn
      const messages = state.messages.map((message) => (message.kind === 'tool' && message.pending ? { ...message, pending: false } : message))
      publish({ ...state, running: false, messages })
      if (turn.requests) append({ kind: 'usage', text: `${tokenTotal(turn).toLocaleString()} tokens · ${turn.input.toLocaleString()} in, ${turn.output.toLocaleString()} out · ${turn.requests} request${turn.requests === 1 ? '' : 's'}` })
      scheduleSave()
      break
    }
  }
}

function ensureSubscribed(): void {
  if (subscribed || typeof window === 'undefined' || !window.electronAPI?.onQaRunEvent) return
  subscribed = true
  void window.electronAPI.qaRunActive?.().then((running) => { if (running) publish({ ...state, running: true }) })
  window.electronAPI.onQaRunEvent(onEvent)
}

export const qaChat = {
  getState: () => state,
  subscribe(listener: () => void) {
    ensureSubscribed()
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** Adds what the person said. The first message starts a saved chat, named after it. */
  addUserMessage(text: string) {
    if (!state.chatId) publish({ ...state, chatId: newChatId(), title: text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat' })
    append({ kind: 'user', text })
    scheduleSave()
  },
  /** Shows a saved chat again, to read or carry on. */
  restore(chat: QaStoredChat) {
    streaming = false
    const messages = chat.messages.filter((message): message is ChatMessage => !!message && typeof message === 'object' && KINDS.has(String((message as { kind?: unknown }).kind)))
    nextId = Math.max(1, ...messages.map((message) => Number(message.id) || 0)) + 1
    const session = chat.session ?? zero()
    publish({ ...initial(), chatId: chat.id, title: chat.title, agentLabel: chat.agentLabel ?? '', messages: messages.map((message) => (message.kind === 'tool' ? { ...message, pending: false } : message)), session, usageReported: session.requests > 0 })
  },
  addError: (text: string) => append({ kind: 'error', text }),
  addStatus: (text: string) => append({ kind: 'status', text }),
  /** Clears the transcript and the counts. Main forgets the conversation separately. */
  clear() { streaming = false; publish({ ...initial(), agentLabel: state.agentLabel, budgetTokens: state.budgetTokens }) },
  /** For tests. */
  handle: onEvent,
  reset() { streaming = false; nextId = 1; publish(initial()) },
}

export function useQaChat(): ChatState {
  return useSyncExternalStore(qaChat.subscribe, qaChat.getState)
}
