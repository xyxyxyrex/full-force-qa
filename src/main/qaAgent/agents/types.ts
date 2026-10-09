import type { ToolResult } from '../tools'
import type { QaRunEvent } from '../../../shared/qaAgent'

// What an AI backend has to be able to do. Every backend (an API, an agent CLI such as
// Codex or Claude Code, or a local model) is one adapter behind this interface.

export type AgentEvent = Exclude<QaRunEvent, { type: 'started' | 'finished' }>

/** One earlier message of a chat. Only text is kept: pictures are fetched again with the tools. */
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ProviderRun {
  system: string
  task: string
  /** Earlier messages of this chat, oldest first. The task is the newest message. */
  history?: ChatTurn[]
  /** The tool names this conversation may use. */
  tools: string[]
  maxTurns: number
  signal: AbortSignal
  /** Runs one of the allowed tools; used by API adapters (agent CLIs reach the tools over the bridge). */
  call(name: string, args: unknown, callId?: string): Promise<ToolResult>
  emit(event: AgentEvent): void
  /** Complete provider requests only; partial streams never become a checkpoint. */
  resume?: unknown
  checkpoint?(state: unknown): void
}

export type StopReason = 'finished' | 'max-turns' | 'refused' | 'aborted' | 'failed'

export interface ProviderResult {
  stopped: StopReason
  /** The model's last text, for summaries. */
  text: string
}

export interface AgentProvider {
  id: string
  label: string
  /** True when tools reach the agent over the local bridge, which must be running. */
  needsBridge?: boolean
  /** A free tier with few requests a minute and a day: reviews and chats are kept short (see lite.ts). */
  lite?: boolean
  run(run: ProviderRun): Promise<ProviderResult>
}

export class AgentError extends Error {}

/** The allowance for the day (a free tier) is used up: nothing more can run today, so a batch stops at once. */
export class QuotaError extends AgentError {}
