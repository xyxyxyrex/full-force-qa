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
