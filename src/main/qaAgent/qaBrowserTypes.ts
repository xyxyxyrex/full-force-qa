import type { Breakpoint } from '../../shared/designScale'
import type { BlockedRequest } from './qaBrowserPolicy'

// The agent's own browser, as the tools see it. The Electron implementation is qaBrowser.ts; tests
// use a stand-in.

export interface BrowserElement {
  /** Stable for as long as the element is on the page: e1, e2, … */
  ref: string
  tag: string
  role: string
  name: string
  type?: string
  href?: string
  value?: string
  checked?: boolean
  required?: boolean
  disabled?: boolean
  /** The browser's own validation message, once the field was touched. */
  invalid?: string
  options?: string[]
  inViewport: boolean
  form?: string
}

export interface BrowserForm {
  id: string
  action: string
  method: string
  fields: string[]
  submits: string[]
}

export interface BrowserSnapshot {
  url: string
  title: string
  headings: Array<{ level: number; text: string }>
  elements: BrowserElement[]
  totalElements: number
  forms: BrowserForm[]
  scrollY: number
  scrollHeight: number
  viewport: { width: number; height: number }
}

export interface BrowserEvents {
  console: Array<{ level: 'error' | 'warning'; message: string; source?: string }>
  requests: Array<{ method: string; url: string; status?: number; error?: string; type: string }>
  blocked: BlockedRequest[]
  dialogs: Array<{ type: string; message: string }>
  popups: string[]
  downloads: string[]
}

export interface BrowserStep {
  snapshot: BrowserSnapshot
  /** The visible part of the page, as JPEG. */
  screenshot: Buffer
  navigated: boolean
  /** HTTP status of the page that is open. */
  status?: number
  /** What happened since the previous step. */
  events: BrowserEvents
  note?: string
}

export interface LinkResult {
  url: string
  text: string
  plan: 'check' | 'skip-admin' | 'skip-scheme' | 'placeholder'
  status?: number
  finalUrl?: string
  error?: string
  /** How many times the link appears. */
  count: number
}

export interface PageAudit {
  title: string
  description: string
  canonical: string
  robots: string
  lang: string
  viewport: string
  h1: string[]
  headingJumps: string[]
  ogTitle: string
  ogImage: string
  favicon: boolean
  imagesWithoutAlt: string[]
  brokenImages: string[]
  unnamedLinks: number
  unnamedButtons: number
  unlabeledInputs: string[]
  duplicateIds: string[]
  mixedContent: string[]
  loadMs: number | null
  requests: number
  transferKb: number
  largeImages: Array<{ url: string; kb: number }>
}

export interface HttpResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  truncated: boolean
  ms: number
}

export interface BrowserOpenInput {
  url: string
  /** Scheme and host of the site under review; the browser does not leave it. */
  site: string
  breakpoint: Breakpoint
  width: number
  allowSend: boolean
  runId: string
}

export interface QaBrowser {
  /** The run the open page belongs to, or null when nothing is open. */
  readonly runId: string | null
  readonly site: string | null
  readonly breakpoint: Breakpoint | null
  open(input: BrowserOpenInput): Promise<BrowserStep>
  snapshot(): Promise<BrowserStep>
  click(ref: string): Promise<BrowserStep>
  type(ref: string, text: string, options: { clear: boolean; enter: boolean }): Promise<BrowserStep>
  select(ref: string, value: string): Promise<BrowserStep>
  press(key: string): Promise<BrowserStep>
  scroll(to: 'top' | 'bottom' | 'up' | 'down' | number): Promise<BrowserStep>
  back(): Promise<BrowserStep>
  /** Everything since the page was opened. */
  allEvents(): BrowserEvents
  links(): Promise<LinkResult[]>
  audit(): Promise<PageAudit>
  request(input: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<HttpResult>
  close(): void
}

export const BROWSER_KEYS = ['Enter', 'Escape', 'Tab', 'Shift+Tab', 'Space', 'Backspace', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp'] as const
