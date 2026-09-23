export type ComparisonEngine = 'firefox' | 'webkit'

export interface ComparisonAnnotation {
  id: string
  x: number
  y: number
  width: number
  height: number
  note: string
}

export interface BrowserComparison {
  id: string
  projectId: string
  engine: ComparisonEngine
  browserVersion: string
  url: string
  finalUrl: string
  capturedAt: string
  width: number
  height: number
  /** Older records without this flag contain viewport-only images. */
  fullPage?: boolean
  imageHeight?: number
  chromiumImageHeight?: number
  /** Height of a full-width fixed/sticky header, in source CSS pixels. */
  pinnedHeaderHeight?: number
  scrollY: number
  actualScrollY: number
  chromiumEdited: boolean
  chromiumDocumentWidth?: number
  engineDocumentWidth?: number
  warning?: string
  annotations: ComparisonAnnotation[]
}

export interface BrowserComparisonImage {
  record: BrowserComparison
  image: string
  chromiumImage: string
}

export interface BrowserComparisonCapture {
  projectId: string
  engine: ComparisonEngine
  url: string
  width: number
  height: number
  scrollY: number
  chromiumImage: string
  chromiumDocumentWidth?: number
  chromiumEdited?: boolean
}

export interface BrowserComparisonProgress {
  engine: ComparisonEngine
  phase: 'installing' | 'preparing' | 'launching' | 'loading' | 'capturing' | 'ready'
  message: string
}
