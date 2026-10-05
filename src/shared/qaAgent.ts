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
  /** JPEG data URL of the evidence picture (design and live side by side), shown on the approval card. */
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
  /** The page each row is about, set when rows from several pages are handed over together. */
  rowPages?: Array<{ name: string; url: string }>
}

export interface ApprovalDecision {
  approved: boolean
  note?: string
  /** Rows (by index) the person left out: they are neither copied nor uploaded. */
  excludedRows?: number[]
}

/** A QA run as Past reviews lists it. */
export interface QaRunListItem {
  id: string
  projectName: string
  pageUrl: string
  createdAt: number
  pinned: boolean
  /** Breakpoints that were captured. */
  breakpoints: Breakpoint[]
  /** Findings the agent drafted (before any hand-over). */
  drafted: number
  handovers: Array<{ stamp: string; status: QaHandOverRecord['status']; rows: number; copied?: number }>
}

export interface QaRunDetail {
  run: QaRunListItem
  /** Newest first. */
  handovers: QaHandOverRecord[]
  /** The agent's drafts per breakpoint, as rows in the tracker's column order: from looking at the page, then from testing it ("functional"). */
  drafts: Array<{ breakpoint: Breakpoint; area?: 'functional'; rows: Array<{ cells: string[]; hasPicture: boolean }> }>
  columns: string[]
}

/** A picture Past reviews can ask for: a hand-over's evidence file, or a drafted finding's picture made on demand. */
export type QaHistoryPicture = { kind: 'handover'; file: string } | { kind: 'draft'; breakpoint: Breakpoint; index: number; area?: 'functional' }

/** A saved chat, as the chat history lists it. */
export interface QaChatListItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  tokens: number
}

/** A saved chat: what was shown, the token counts, and what the agent remembers. */
export interface QaStoredChat {
  version: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  agentLabel?: string
  messages: unknown[]
  session?: { input: number; output: number; requests: number }
}

/** One hand-over of rows for approval, kept in the run folder so it can be looked at again (Past reviews). */
export interface QaHandOverRecord {
  version: 1
  stamp: string
  createdAt: number
  decidedAt?: number
  status: 'pending' | 'approved' | 'rejected'
  note?: string
  projectName: string
  pageUrl: string
  columns: string[]
  /** As shown to the person, before any link was put in the screenshot column. */
  rows: string[][]
  rowPages?: Array<{ name: string; url: string }>
  /** Evidence pictures in the run's output folder, by row. */
  evidence: Array<{ rowIndex: number; file: string; caption: string }>
  excludedRows?: number[]
  /** Links put in the screenshot column, by row index. */
  links?: Record<string, string>
  copiedRows?: number
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
  /** Let the agent's browser submit forms and send POST/PUT/DELETE requests to the site under review. Off: it only fills forms in and reads. */
  allowSend: boolean
  /** After the visual check, reviews also test each page's links, buttons, menus and forms. */
  functionalChecks: boolean
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
  /** Review the page on its own, without comparing it to a design. */
  standalone?: boolean
  /** Also test links, buttons, menus and forms after the visual check. Defaults to the setting. */
  functional?: boolean
}

/** How many pages one batch review covers. */
export const QA_BATCH_MAX_PAGES = 50

/** A page to review in a batch, from a list the person pasted. */
export interface QaBatchPage {
  url: string
  name: string
  projectId?: string
}

export interface QaBatchStartOptions {
  pages: QaBatchPage[]
  breakpoints?: Breakpoint[]
  agent?: AgentId
  /** Also test links, buttons, menus and forms on each page. Defaults to the setting. */
  functional?: boolean
}

export type QaRunStartResult = { started: true } | { started: false; error: string }

/** What a review would use right now: the open page and the designs stored for that page. */
export interface QaTarget {
  projectName: string
  pageUrl: string
  /** The page's path (and query), the same identity its designs are stored under. */
  pageId: string
  slots: DesignSlots
  thumbnails: Partial<Record<Breakpoint, string>>
}

export interface QaChatSendOptions {
  agent?: AgentId
  /** The chat this message belongs to; the agent remembers that chat's earlier messages. */
  chatId?: string
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
