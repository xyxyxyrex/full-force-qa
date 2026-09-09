export type ResultState = 'pass' | 'fail' | 'visual' | 'ambiguous' | 'ignored' | 'unavailable'
export type EvidenceStrength = 'deterministic' | 'strong' | 'visual' | 'ambiguous' | 'unverified'
export interface Bounds { x: number; y: number; width: number; height: number }
export interface ImageSize { width: number; height: number }
export interface Difference {
  x?: number; y?: number; width?: number; height?: number; value?: number
  pixels?: number; percent?: number; fontSize?: number
  properties?: Record<string, number | string>
}
export interface ComparedRegion { rect: Bounds; pageWidth: number; pageHeight: number; label: string }
export interface TokenAssertion { name: string; passed: boolean; figma: string; css: string; difference?: number | string; isExtended?: boolean; unresolved?: boolean }
export interface FindingComparison { design?: ComparedRegion; live?: ComparedRegion; delta?: Difference }
export interface AutomationFinding {
  id: string
  state: ResultState
  evidenceStrength: EvidenceStrength
  category: 'position' | 'size' | 'spacing' | 'typography' | 'color' | 'border' | 'image' | 'content' | 'visual' | 'page-dimension'
  // Keep existing severity identifiers for annotation/history compatibility.
  severity: 'high' | 'medium' | 'low' | 'pass'
  title: string
  detail: string
  expected?: unknown
  actual?: unknown
  difference?: Difference
  matchQuality?: { quality: 'strong' | 'ambiguous'; reciprocal: boolean; reason: string }
  sourceNodeId?: string
  targetNodeId?: string
  comparison?: FindingComparison
  tokens?: TokenAssertion[]
}
export interface DiffRegion extends Bounds { pixels: number; percent: number }
export interface PixelComparison {
  schemaVersion: 2
  engine: 'pixelmatch'
  design: ImageSize
  live: ImageSize
  overlap: ImageSize
  dimensions: { widthDelta: number; heightDelta: number }
  changedPixels: number
  changedPercent: number
  comparedPixels: number
  excludedPixels: { design: number; live: number }
  regions: DiffRegion[]
  options: { pixelThreshold: number; includeAA: boolean }
  diffDataUrl: string
}
export type PixelComparisonResponse = { success: true; result: PixelComparison } | { success: false; error: string }
export interface SemanticCoverage {
  designTextNodes: number
  processedTextNodes: number
  matchedTextNodes: number
  ambiguousTextNodes: number
  liveTextNodes: number
  designImageNodes: number
  imageValidation: 'unavailable'
}
