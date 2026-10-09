import type { Breakpoint } from './designScale'
export type FindingReview = 'draft' | 'accepted' | 'dismissed'
export interface FindingSource { runId: string; breakpoint: Breakpoint; area: 'visual' | 'functional' }
export interface AuditFinding {
  id: string; projectKey: string; pageUrl: string; projectName: string
  cells: Record<string, string>; sources: FindingSource[]; sourceKeys: string[]
  review: FindingReview; edited: string[]; createdAt: number; updatedAt: number
  evidence?: { file: string; caption: string }; mergedInto?: string
  evidenceSet?: Array<{ file: string; caption: string }>
}
export interface OrganizerSnapshot { projectKey: string; projectName: string; revision: number; columns: string[]; choices?: Record<string, string[]>; findings: AuditFinding[] }
export interface FindingUpdate { id: string; cells?: Record<string, string>; review?: FindingReview }
export type OrganizerResult = { success: true; snapshot: OrganizerSnapshot } | { success: false; error: string; snapshot?: OrganizerSnapshot }
