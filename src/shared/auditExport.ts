export type AuditExportKind = 'images' | 'text' | 'links' | 'seo-data' | 'assets' | 'bundle'

export type AuditResourceKind =
  | 'image'
  | 'stylesheet'
  | 'script'
  | 'font'
  | 'video'
  | 'audio'
  | 'other'

export interface AuditCaptureResource {
  url: string
  kind: AuditResourceKind
  source: string
}

export interface AuditCaptureContext {
  version: 1
  capturedAt: number
  sourceUrl: string
  resources: AuditCaptureResource[]
  structuredData: unknown[]
  complete: boolean
}

export interface AuditExportResource {
  url: string
  kind: AuditResourceKind
  source: string
  selector?: string
  descriptor?: string
  inlineContent?: string
  mimeType?: string
}

export interface AuditTextRecord {
  text: string
  visible: boolean
  tag: string
  headingLevel?: number
  selector: string
  linkUrl?: string
}

export interface AuditLinkRecord {
  originalUrl: string
  resolvedUrl: string
  anchorText: string
  selector: string
  rel: string
  target: string
  external: boolean
}

export interface AuditSeoData {
  title: string
  description: string
  canonical: string
  robots: string
  meta: Record<string, string>
  headings: Array<{ level: number; text: string; selector: string }>
  hreflang: Array<{ language: string; url: string }>
  openGraph: Record<string, string>
  twitter: Record<string, string>
  structuredData: unknown[]
}

export interface AuditExportPayload {
  html: string
  sourceUrl: string
  report: unknown
  captureContext?: AuditCaptureContext | null
  resources: AuditExportResource[]
  text: AuditTextRecord[]
  visibleText: string
  markdown: string
  links: AuditLinkRecord[]
  seo: AuditSeoData
}

export interface AuditExportScanRequest {
  kind: AuditExportKind
  payload: AuditExportPayload
}

export interface AuditExportScanResult {
  planId: string
  kind: AuditExportKind
  fileCount: number
  knownBytes: number
  unknownSizeCount: number
  reviewRequired: boolean
  coverage: 'complete' | 'partial'
  warnings: string[]
}

export interface AuditExportFailure {
  url?: string
  source?: string
  message: string
}

export interface AuditExportProgress {
  jobId: string
  kind: AuditExportKind
  phase: 'preparing' | 'downloading' | 'writing' | 'complete' | 'cancelled'
  completed: number
  total: number
  current?: string
}

export interface AuditExportResult {
  success: boolean
  cancelled?: boolean
  jobId?: string
  folderPath?: string
  downloaded: number
  skipped: number
  failed: AuditExportFailure[]
  error?: string
}
