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
