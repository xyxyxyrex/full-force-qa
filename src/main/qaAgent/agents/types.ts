import type { ToolResult } from '../tools'

// What an AI backend has to be able to do. Every backend (an API, an agent CLI such as
// Codex or Claude Code, or a local model) is one adapter behind this interface.

export type AgentEvent =
  | { type: 'status'; message: string }
  /** `delta` marks a small piece of a message that is still streaming, to be joined with the previous piece. */
  | { type: 'text'; text: string; delta?: boolean }
  | { type: 'tool'; name: string; args: unknown }
  | { type: 'tool-result'; name: string; isError: boolean; text: string; images: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }

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
  call(name: string, args: unknown): Promise<ToolResult>
  emit(event: AgentEvent): void
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
  run(run: ProviderRun): Promise<ProviderResult>
}

export class AgentError extends Error {}
