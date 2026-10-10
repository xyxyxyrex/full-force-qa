import { useSyncExternalStore } from 'react'
import type { ChatAgentSelection, QaExecutionSnapshot, QaRunEvent, QaStoredChat } from '../../../shared/qaAgent'
import type { WorkspaceProposal, WorkspaceRecord } from '../../../shared/parityWorkspace'
import type { ChatImage } from '../../../shared/chatImages'
import { agentSelection } from '../../../shared/qaAgentSelection'
import type { QaChatWindowAction } from '../../../shared/qaChatWindow'

// The QA chat's transcript and token counts live here, outside React, so they survive the chat
// panel being closed or the editor being reopened. Main keeps what the agent remembers; this is
// only what is shown.

export type ChatMessage = { executionId?: string; attemptId?: string; timestamp?: number; messageId?: string; receivedAt?: number } & (
  | { id: number; kind: 'workspace-proposal'; proposal: WorkspaceProposal }
  | { id: number; kind: 'workspace-result'; records: WorkspaceRecord[]; nextOffset: number | null; warning?: string; dateLabel?: string }
  | { id: number; kind: 'user'; text: string; attachments?: ChatImage[] }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'tool'; name: string; args: unknown; pending: boolean; isError?: boolean; result?: string; images?: number; callId?: string; retryId?: string; resultId?: string; cancelled?: boolean; finishedAt?: number }
  | { id: number; kind: 'status' | 'error' | 'usage'; text: string; retryId?: string; retryBlocked?: string; detail?: string; localCommand?: string }
  | { id: number; kind: 'findings'; runId: string; pageUrl: string; breakpoint: string; area: string; rows: Array<{ cells: Record<string, string>; evidence?: unknown }> }
)

export interface TokenCounts {
  input: number
  output: number
  /** Requests sent to the model (each one re-sends the conversation, so input grows quickly). */
  requests: number
}

export interface ChatState {
  configVersion?: number
  selection?: ChatAgentSelection | null
  switching?: boolean
  draft: { input: string; tab: 'chat' | 'findings'; attachments?: ChatImage[] }
  execution: QaExecutionSnapshot | null
  messages: ChatMessage[]
  running: boolean
  /** A reply is currently streaming; show real text instead of a response placeholder. */
  responding: boolean
  agentLabel: string
  selectedAgentLabel: string
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
const initial = (): ChatState => ({ draft: { input: '', tab: 'chat' }, execution: null, messages: [], running: false, responding: false, agentLabel: '', selectedAgentLabel: '', session: zero(), turn: zero(), context: 0, budgetTokens: 0, usageReported: false, chatId: null, title: '' })
const newChatId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const KINDS = new Set(['user', 'assistant', 'tool', 'status', 'error', 'usage', 'findings','workspace-proposal','workspace-result'])

let state: ChatState = initial()
let nextId = 1
let streaming = false
let subscribed = false
let selectionVersion = 0
let accountVersion=0
const detached = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('qaChat') === '1'
const relay = (action: QaChatWindowAction) => { if (!detached) return false; window.electronAPI.qaWindowAction(action); return true }
let pendingDraft: ChatState['draft'] | null = null
const listeners = new Set<() => void>()

const publish = (next: ChatState) => { state = next; listeners.forEach((listener) => listener()) }
const cap = (messages: ChatMessage[]) => (messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages)

// The chat is saved (what it shows and its token counts) shortly after each message and each answer.
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  const version = accountVersion
  const ownerKey = typeof window === 'undefined' ? null : window.localStorage?.getItem('parity_account_owner_key') ?? null
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (version !== accountVersion) return
    const { chatId, title, agentLabel, messages, session } = state
    if (!chatId || !messages.length || typeof window === 'undefined' || !window.electronAPI?.qaChatsSave) return
    void window.electronAPI.qaChatsSave({ id: chatId, title, agentLabel, messages: messages.map(({ receivedAt: _presentation, ...message }) => message), session, ownerKey }).catch(() => { /* saving is a convenience */ })
  }, 400)
}

function append(message: DistributiveOmit<ChatMessage, 'id'>): void {
  streaming = false
  publish({ ...state, responding: false, messages: cap([...state.messages, { ...message, id: nextId++ } as ChatMessage]) })
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
    case 'agents-config-changed':publish({...state,configVersion:(state.configVersion||0)+1});break
    case 'account-reset':
      if(saveTimer)clearTimeout(saveTimer);saveTimer=null;pendingDraft=null;selectionVersion++;accountVersion++;streaming=false;publish(initial());break
    case 'chat-selection':
      publish({...state,chatId:event.chatId||state.chatId,selection:event.selection,selectedAgentLabel:event.label,agentLabel:state.running?state.agentLabel:event.label,switching:event.switching});break
    case 'workspace-proposal': {
      const index=state.messages.findIndex(m=>m.kind==='workspace-proposal'&&m.proposal.id===event.proposal.id)
      if(index<0)append({kind:'workspace-proposal',proposal:event.proposal})
      else{const messages=state.messages.slice();messages[index]={...messages[index],kind:'workspace-proposal',proposal:event.proposal};publish({...state,messages})}
      scheduleSave();break
    }
    case 'workspace-result': append({...event,kind:'workspace-result'});scheduleSave();break
    case 'agent-selected':
      selectionVersion++
      publish({ ...state, selectedAgentLabel: event.label, agentLabel: state.running ? state.agentLabel : event.label })
      break
    case 'execution': publish({ ...state, execution: event.snapshot, running: event.snapshot.running, responding: event.snapshot.running && event.snapshot.attemptId === state.execution?.attemptId ? state.responding : false }); break
    case 'activity': publish({ ...state, responding: false, execution: state.execution ? { ...state.execution, phase: event.phase, phaseStartedAt: event.startedAt, retryAt: event.retryAt } : null }); break
    case 'findings': {
      const index = state.messages.findIndex(message => message.kind === 'findings' && message.runId === event.runId && message.breakpoint === event.breakpoint && message.area === event.area)
      if (index < 0) append({ ...event, kind: 'findings' })
      else { const messages = state.messages.slice(); messages[index] = { ...event, kind: 'findings', id: messages[index].id }; publish({ ...state, messages }) }
      break
    }
    case 'started':
      streaming = false
      publish({ ...state, switching:false, running: true, responding: false, agentLabel: event.label, turn: zero(), budgetTokens: event.budgetTokens ?? 0 })
      break
    case 'status': append({ kind: 'status', text: event.message }); break
    case 'text': {
      const last = state.messages[state.messages.length - 1]
      let messages: ChatMessage[]
      if (event.delta && streaming && last?.kind === 'assistant' && (!event.messageId || !last.messageId || event.messageId === last.messageId)) {
        messages = [...state.messages.slice(0, -1), { ...last, text: last.text + event.text }]
      } else {
        if (!event.delta && streaming && last?.kind === 'assistant' && event.text.startsWith(last.text)) messages = [...state.messages.slice(0, -1), { ...last, text: event.text }]
        else messages = cap([...state.messages, { id: nextId++, kind: 'assistant', text: event.text, receivedAt: Date.now(), executionId: event.executionId, attemptId: event.attemptId, timestamp: event.timestamp, messageId: event.messageId }])
      }
      streaming = !!event.delta
      publish({ ...state, messages, responding: streaming })
      break
    }
    case 'tool': append({ kind: 'tool', name: event.name, args: event.args, pending: true, callId: event.callId, executionId: event.executionId, attemptId: event.attemptId, timestamp: event.timestamp }); break
    case 'tool-result': {
      streaming = false
      let index = -1
      // Results come back in the order the calls were made, so the oldest waiting card is theirs.
      for (let i = 0; i < state.messages.length; i++) {
        const message = state.messages[i]
        if (message.kind === 'tool' && message.pending && (event.callId ? message.callId === event.callId && (!event.attemptId || message.attemptId === event.attemptId) : message.name === event.name)) { index = i; break }
      }
      if (index < 0) { append({ kind: 'tool', name: event.name, args: undefined, pending: false, isError: event.isError, result: event.text, images: event.images, callId: event.callId, retryId: event.retryId, resultId: event.resultId, executionId: event.executionId, cancelled: event.cancelled, finishedAt: event.timestamp }); break }
      const messages = state.messages.slice()
      messages[index] = { ...(messages[index] as Extract<ChatMessage, { kind: 'tool' }>), pending: false, isError: event.isError, result: event.text, images: event.images, callId: event.callId, retryId: event.retryId, resultId: event.resultId, executionId: event.executionId, cancelled: event.cancelled, finishedAt: event.timestamp }
      publish({ ...state, responding: false, messages })
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
    case 'error': append({ kind: 'error', text: event.message, retryId: event.retryId, retryBlocked: event.retryBlocked, detail: event.detail, executionId: event.executionId, attemptId: event.attemptId }); break
    case 'done': append({ kind: 'status', text: event.message }); break
    case 'finished': {
      const turn = state.turn
      const messages = state.messages.map((message) => (message.kind === 'tool' && message.pending ? { ...message, pending: false, cancelled: true } : message))
      publish({ ...state, running: false, responding: false, messages, agentLabel: state.selectedAgentLabel || state.agentLabel })
      if (turn.requests) append({ kind: 'usage', text: `${tokenTotal(turn).toLocaleString()} tokens · ${turn.input.toLocaleString()} in, ${turn.output.toLocaleString()} out · ${turn.requests} request${turn.requests === 1 ? '' : 's'}` })
      scheduleSave()
      break
    }
  }
}

function ensureSubscribed(): void {
  if (detached) return
  if (subscribed || typeof window === 'undefined' || !window.electronAPI?.onQaRunEvent) return
  subscribed = true
  const version = selectionVersion
  const scope=accountVersion
  void window.electronAPI.qaAgentsSettings?.().then(settings => {
    if (settings && version === selectionVersion) onEvent({ type: 'agent-selected', ...agentSelection(settings) })
  }).catch(() => {})
  void window.electronAPI.qaExecutionStatus?.().then(execution => { if (scope===accountVersion&&execution) publish({ ...state, execution, running: execution.running }) }).catch(() => {})
  void window.electronAPI.qaRunActive?.().then((running) => { if (scope===accountVersion&&running) publish({ ...state, running: true }) }).catch(() => {})
  window.electronAPI.onQaRunEvent(onEvent)
}

export const qaChat = {
  /** Local command reports must not split or reset an in-progress streamed answer. */
  addInfo(command: string, text: string) {
    if (relay({ type: 'info', command, text })) return
    const messages = state.messages.slice()
    const index = streaming && messages.at(-1)?.kind === 'assistant' ? messages.length - 1 : messages.length
    messages.splice(index, 0, { id: nextId++, kind: 'user', text: command }, { id: nextId++, kind: 'status', text, localCommand: command })
    publish({ ...state, chatId: state.chatId || newChatId(), title: state.title || command, messages: cap(messages) })
    scheduleSave()
  },
  ensureChat(id?:string) {const chatId=state.chatId||id||newChatId();if(!state.chatId){publish({...state,chatId});relay({type:'ensure-chat',chatId})}return chatId},
  getState: () => state,
  subscribe(listener: () => void) {
    ensureSubscribed()
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** Adds what the person said. The first message starts a saved chat, named after it. */
  addUserMessage(text: string, attachments?: ChatImage[]) {
    if (relay({ type: 'user', text, attachments })) return
    if (!state.chatId) publish({ ...state, chatId: newChatId(), title: text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat' })
    else if(!state.title)publish({...state,title:text.replace(/\s+/g,' ').trim().slice(0,80)||'Chat'})
    append({ kind: 'user', text, ...(attachments?.length ? { attachments } : {}) })
    scheduleSave()
  },
  /** Shows a saved chat again, to read or carry on. */
  restore(chat: QaStoredChat) {
    streaming = false
    const messages = chat.messages.filter((message): message is ChatMessage => !!message && typeof message === 'object' && KINDS.has(String((message as { kind?: unknown }).kind))).map(({ receivedAt: _presentation, ...message }) => message)
    nextId = Math.max(1, ...messages.map((message) => Number(message.id) || 0)) + 1
    const session = chat.session ?? zero()
    publish({ ...initial(), selection:chat.selection||null,chatId: chat.id, title: chat.title, selectedAgentLabel: chat.selection?chat.agentLabel||'':state.selectedAgentLabel, agentLabel: chat.selection?chat.agentLabel||'':state.selectedAgentLabel||chat.agentLabel||'', messages: messages.map((message) => (message.kind === 'tool' ? { ...message, pending: false, cancelled: true } : message)), session, usageReported: session.requests > 0 })
  },
  addError: (text: string) => { if (!relay({ type: 'error', text })) append({ kind: 'error', text }) },
  addStatus: (text: string) => { if (!relay({ type: 'status', text })) append({ kind: 'status', text }) },
  setDraft(input: string, tab: 'chat' | 'findings', attachments = state.draft.attachments) {
    const draft = { input, tab, ...(attachments ? { attachments } : {}) }
    if (detached) pendingDraft = draft
    publish({ ...state, draft })
    relay({ type: 'draft', ...draft })
  },
  mirror(next: ChatState) {
    if (pendingDraft && next.draft.input === pendingDraft.input && next.draft.tab === pendingDraft.tab && JSON.stringify(next.draft.attachments || []) === JSON.stringify(pendingDraft.attachments || [])) pendingDraft = null
    publish(pendingDraft ? { ...next, draft: pendingDraft } : next)
  },
  /** Clears the transcript and the counts. Main forgets the conversation separately. */
  clear() { if (relay({ type: 'clear' })) return; streaming = false; publish({ ...initial(), agentLabel: state.selectedAgentLabel || state.agentLabel, selectedAgentLabel: state.selectedAgentLabel, budgetTokens: state.budgetTokens }) },
  /** For tests. */
  handle: (event: QaRunEvent) => { if (!relay({ type: 'event', event })) onEvent(event) },
  reset() {if(saveTimer)clearTimeout(saveTimer);saveTimer=null;pendingDraft=null;accountVersion++;selectionVersion++;streaming = false; nextId = 1; publish(initial()) },
}

export function useQaChat(): ChatState {
  return useSyncExternalStore(qaChat.subscribe, qaChat.getState)
}
