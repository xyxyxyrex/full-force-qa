import type { Breakpoint, DesignScaleDetection } from './designScale'

export type { Breakpoint } from './designScale'

/** One stored Figma export. `frameWidth` is in CSS px (pixelWidth / scale). */
export interface DesignSlotMeta {
  breakpoint: Breakpoint
  fileName?: string
  /** Path of the page the design was loaded for, e.g. `/alopecia-page/`. */
  pagePath?: string
  pixelWidth: number
  pixelHeight: number
  scale: number
  frameWidth: number
  frameHeight: number
  detection: DesignScaleDetection | 'manual'
  confidence: 'high' | 'low'
  sha256: string
  addedAt: number
}

export type DesignSlots = Partial<Record<Breakpoint, DesignSlotMeta>>

export interface DesignListResult {
  slots: DesignSlots
  /** Small JPEG data URLs for the slot tiles. */
  thumbnails: Partial<Record<Breakpoint, string>>
}

export interface DesignPutOptions {
  fileName?: string
  pagePath?: string
  /** `auto` assigns by detected width. */
  target?: Breakpoint | 'auto'
}

export type DesignPutResponse =
  | { success: true; assigned: Breakpoint; unchanged: boolean; slots: DesignSlots }
  | { success: false; error: string }

export interface DesignUpdateOptions {
  /** Moves the image into another slot, swapping when that slot is occupied. */
  moveTo?: Breakpoint
  /** Overrides the export scale (design px per CSS px). */
  scale?: number
}

export type DesignUpdateResponse = { success: true; slots: DesignSlots } | { success: false; error: string }

/** What the open Parity window reports about itself, so tools know which page to look at. */
export interface ReportedContext {
  projectKey: string
  project: { id: string; name: string; stagingUrl: string }
  pageUrl: string
  workspaceTab: string
  breakpoint: Breakpoint | null
  viewport: { width: number; height: number }
  reportedAt: number
}

export interface ApprovalEvidence {
  rowIndex: number
  /** Small JPEG data URL shown on the approval card. */
  thumbnail: string
  caption: string
}

/** Rows an agent wants to hand over; the person sees them and approves or rejects. */
export interface ApprovalRequest {
  id: string
  runId: string
  projectName: string
  pageUrl: string
  columns: string[]
  rows: string[][]
  severityCounts: Record<string, number>
  evidence: ApprovalEvidence[]
  warnings: string[]
  /** Whether images will be uploaded and linked, or only the rows copied. */
  uploadsEvidence: boolean
}

export interface ApprovalDecision {
  approved: boolean
  note?: string
}

/** A tool result as the app window receives it: images as data URLs. */
export interface QaToolCallResult {
  text: string
  isError: boolean
  images: Array<{ dataUrl: string; caption: string; file?: string }>
}

export interface BridgeRequestEntry {
  at: number
  method: string
  path: string
  status: number
  ms: number
  tool?: string
}

export interface QaBridgeStatus {
  enabled: boolean
  running: boolean
  port: number
  /** Why the bridge could not start, or empty. */
  error: string
  /** Last four characters of the key, never the key. */
  keyHint: string
  mcpUrl: string
  /** Where the key is stored on this computer, for tools that read it from disk. */
  keyFile: string
  lastRequestAt: number | null
  recent: BridgeRequestEntry[]
}

// ── Agent choice and settings ─────────────────────────────────────────────────────────

export const AGENT_IDS = ['claude-code', 'codex', 'antigravity', 'anthropic-api', 'openai-api', 'gemini-api', 'local'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export const isAgentId = (value: unknown): value is AgentId => typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)

export type AgentEffort = 'low' | 'medium' | 'high'

export interface AgentSettings {
  defaultAgent: AgentId
  /** Model per agent. Empty means the agent's own default (agent CLIs) or "choose one" (APIs). */
  models: Record<AgentId, string>
  effort: AgentEffort
  /** Address of a local Chat Completions server such as Ollama or LM Studio. */
  localBaseUrl: string
  /** Stops a review after this many tokens. 0 means no limit. */
  budgetTokens: number
  /** Upload evidence images and put their links in the tracker's screenshot column. */
  evidenceUploads: boolean
  /** How long evidence links keep working. */
  evidenceDays: number
}

export interface AgentInfo {
  id: AgentId
  label: string
  kind: 'subscription' | 'api' | 'local'
  /** Can be used right now. */
  ready: boolean
  /** One line for the person: version and sign-in, or what is missing. */
  detail: string
  model: string
  needsKey: boolean
  hasKey: boolean
}

export interface AgentsOverview {
  settings: AgentSettings
  agents: AgentInfo[]
  /** How API keys are kept on this computer. */
  keyStorage: 'secure' | 'weak' | 'unavailable'
}

export interface QaRunStartOptions {
  agent?: AgentId
  breakpoints?: Breakpoint[]
}

export type QaRunStartResult = { started: true } | { started: false; error: string }

export interface QaChatSendOptions {
  agent?: AgentId
}

export type QaRunEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string; delta?: boolean }
  | { type: 'tool'; name: string; args: unknown }
  | { type: 'tool-result'; name: string; isError: boolean; text: string; images: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }
  | { type: 'started'; agent: string; label: string; budgetTokens?: number }
  | { type: 'finished' }
