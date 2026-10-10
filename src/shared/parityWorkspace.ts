import type { Project, ProjectFolder } from './types'

export const WORKSPACE_KINDS = ['project', 'folder', 'capture', 'finding', 'note', 'ticket'] as const
export type WorkspaceKind = typeof WORKSPACE_KINDS[number]
export interface WorkspaceQuery { query?: string; kinds?: WorkspaceKind[]; date?: string; dateField?: 'created' | 'captured' | 'opened'; from?: number; to?: number; includeTrash?: boolean; offset?: number; limit?: number }
export interface WorkspaceRecord {
  href?: string
  kind: WorkspaceKind; id: string; title: string; breadcrumb: string; projectId?: string; url?: string; excerpt?: string
  createdAt?: number; capturedAt?: number; openedAt?: number; updatedAt?: number; inTrash?: boolean; source: 'cloud' | 'cached' | 'local'
}
export function workspaceRecordLink(record: Pick<WorkspaceRecord,'kind'|'id'|'projectId'>):string {return `parity://record/${record.kind}/${encodeURIComponent(record.id)}${record.projectId?`?project=${encodeURIComponent(record.projectId)}`:''}`}
export function parseWorkspaceLink(href:string):WorkspaceNavigation|null {try{const url=new URL(href);if(url.protocol!=='parity:'||url.host!=='record'||url.username||url.password)return null;const parts=url.pathname.split('/').filter(Boolean);if(parts.length!==2||!WORKSPACE_KINDS.includes(parts[0] as WorkspaceKind))return null;const id=decodeURIComponent(parts[1]);if(!id||id.length>200||/[\u0000-\u001f]/.test(id))return null;return{kind:parts[0] as WorkspaceKind,id,projectId:url.searchParams.get('project')||undefined}}catch{return null}}
export interface WorkspaceSearch { records: WorkspaceRecord[]; nextOffset: number | null; source: 'cloud' | 'cached'; warning?: string; dateLabel?: string }
export interface CaptureActivity { id: string; projectId: string; url: string; engine: string; completedAt: number }
export interface WorkspaceSnapshot { projects: Project[]; folders: ProjectFolder[]; revision: number }
export type WorkspaceOperation =
  | { type: 'create-project'; id: string; url: string; name?: string; folderId?: string; keepDuplicate?: boolean }
  | { type: 'create-folder'; id: string; name: string; parentId?: string }
  | { type: 'rename'; kind: 'project' | 'folder'; id: string; name: string }
  | { type: 'move'; kind: 'project' | 'folder'; id: string; folderId?: string }
  | { type: 'trash' | 'restore'; id: string }
  | { type: 'delete-folder'; id: string }
export interface WorkspaceChange { label: string; before?: string; after: string }
export interface WorkspaceProposal { id: string; title: string; changes: WorkspaceChange[]; status: 'pending' | 'applying' | 'applied' | 'cancelled' | 'failed' | 'uncertain'; error?: string; revision: number; createdAt: number }
export interface WorkspaceApplyResult { success: boolean; proposal: WorkspaceProposal; snapshot?: WorkspaceSnapshot }
export interface WorkspaceNavigation { kind: WorkspaceKind; id: string; projectId?: string; capture?: boolean }

export function folderBreadcrumb(folders: ProjectFolder[], id?: string): string {
  const names: string[] = []; const seen = new Set<string>()
  while (id) { if (seen.has(id)) throw new Error('The folder hierarchy contains a cycle.'); seen.add(id); const folder = folders.find(f => f.id === id); if (!folder) throw new Error('The destination folder no longer exists.'); names.unshift(folder.name); id = folder.parentId }
  return ['Home', ...names].join(' / ')
}
export function workspaceDateRange(input: string) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(input.trim())
  if (!match) throw new Error('Use MM/DD/YY or MM/DD/YYYY for dates.')
  const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0)
  const start = new Date(year, month - 1, day)
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) throw new Error('That calendar date is not valid.')
  const end = new Date(year, month - 1, day + 1)
  return { from: start.getTime(), to: end.getTime(), dateLabel: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` }
}
export function projectRecord(project: Project, folders: ProjectFolder[], source: WorkspaceRecord['source']): WorkspaceRecord {
  let breadcrumb = 'Home'; try { breadcrumb = folderBreadcrumb(folders, project.folderId) } catch { breadcrumb = 'Missing folder' }
  let url = project.stagingUrl
  try { const safe = new URL(url); safe.username = ''; safe.password = ''; url = safe.href } catch { url = undefined as unknown as string }
  return { kind: 'project', id: project.id, projectId: project.id, title: project.name, breadcrumb, url, createdAt: project.createdAt, openedAt: project.lastOpenedAt, updatedAt: project.updatedAt, inTrash: !!project.inTrash, source }
}
export function selectWorkspaceRecords(records: WorkspaceRecord[], query: WorkspaceQuery): WorkspaceSearch {
  const tokens = (query.query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const key = query.dateField === 'opened' ? 'openedAt' : query.dateField === 'captured' ? 'capturedAt' : 'createdAt'
  const result = records.filter(r => (!query.kinds?.length || query.kinds.includes(r.kind)) && (query.includeTrash || !r.inTrash)
    && tokens.every(t => `${r.id} ${r.title} ${r.breadcrumb} ${r.url || ''} ${r.excerpt || ''}`.toLocaleLowerCase().includes(t))
    && (query.from === undefined || typeof r[key] === 'number' && r[key]! >= query.from)
    && (query.to === undefined || typeof r[key] === 'number' && r[key]! < query.to))
    .sort((a,b) => (b[key] || b.updatedAt || 0) - (a[key] || a.updatedAt || 0) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  const offset = Math.max(0, Math.floor(query.offset || 0)), limit = Math.max(1, Math.min(50, Math.floor(query.limit || 20)))
  return { records: result.slice(offset, offset + limit), nextOffset: offset + limit < result.length ? offset + limit : null, source: 'cached' }
}
export function matchesWorkspaceRecord(record:WorkspaceRecord,query:WorkspaceQuery):boolean {
  return selectWorkspaceRecords([record],{...query,offset:0,limit:1}).records.length>0
}
const text = (value: unknown, label: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new Error(`Enter a valid ${label}.`); return value.trim() }

/** Pure mutation planner, shared by main and the authenticated account function. No model-supplied owner or filesystem paths. */
export function planWorkspaceChanges(snapshot: WorkspaceSnapshot, operations: WorkspaceOperation[], now: number): { snapshot: WorkspaceSnapshot; changes: WorkspaceChange[]; projects: Project[] } {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new Error('Choose between 1 and 100 changes.')
  const projects = structuredClone(snapshot.projects), folders = structuredClone(snapshot.folders), changes: WorkspaceChange[] = [], changed = new Set<string>()
  const folder = (id?: string) => { if (id && !folders.some(f => f.id === id)) throw new Error('The destination folder no longer exists.'); return id || undefined }
  const touch = (p: Project) => { p.updatedAt = now; changed.add(p.id) }
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid workspace operation.')
    const op = raw as WorkspaceOperation; const id = text(op.id, 'item ID')
    if (op.type === 'create-project') {
      if (projects.some(p => p.id === id)) throw new Error('A project already uses this ID.')
      const destination = folder(op.folderId), url = new URL(op.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP/HTTPS link without embedded login credentials.')
      const normalized = url.href
      if (!op.keepDuplicate && projects.some(p => !p.inTrash && (p.folderId || undefined) === destination && p.stagingUrl === normalized)) { changes.push({ label: normalized, after: 'Skipped duplicate in destination' }); continue }
      const name = text(op.name || url.hostname, 'project name')
      const p: Project = { id, name, stagingUrl: normalized, adminUrl: '', createdAt: now, lastOpenedAt: 0, folderId: destination, updatedAt: now }
      projects.push(p); touch(p); changes.push({ label: name, after: `Create project in ${folderBreadcrumb(folders, destination)} · capture when opened` }); continue
    }
    if (op.type === 'create-folder') {
      if (folders.some(f => f.id === id)) throw new Error('A folder already uses this ID.')
      const parentId = folder(op.parentId), name = text(op.name, 'folder name'); folders.push({ id, name, parentId, createdAt: now })
      changes.push({ label: name, after: `Create folder in ${folderBreadcrumb(folders, parentId)}` }); continue
    }
    if (op.type === 'delete-folder') {
      const f = folders.find(f => f.id === id); if (!f) throw new Error('The folder no longer exists.')
      const destination = folder(f.parentId); const children = folders.filter(c => c.parentId === id), contents = projects.filter(p => p.folderId === id)
      changes.push({ label: f.name, before: folderBreadcrumb(folders,id), after: `Delete folder; move ${contents.length} projects and ${children.length} subfolders to ${folderBreadcrumb(folders,destination)}` })
      contents.forEach(p => { p.folderId = destination; touch(p) }); children.forEach(c => { c.parentId = destination }); folders.splice(folders.indexOf(f),1); continue
    }
    if (op.type === 'trash' || op.type === 'restore') {
      const p = projects.find(p => p.id === id); if (!p) throw new Error('The project no longer exists.')
      if (op.type === 'restore') folder(p.folderId)
      p.inTrash = op.type === 'trash'; p.deletedAt = p.inTrash ? now : undefined; touch(p)
      changes.push({ label: p.name, after: p.inTrash ? 'Move project to Trash' : `Restore to ${folderBreadcrumb(folders,p.folderId)}` }); continue
    }
    if (op.type !== 'rename' && op.type !== 'move') throw new Error('That operation is not supported.')
    if (op.kind !== 'project' && op.kind !== 'folder') throw new Error('Choose a project or folder.')
    const target = op.kind === 'project' ? projects.find(p => p.id === id) : folders.find(f => f.id === id)
    if (!target) throw new Error('The item no longer exists.')
    if (op.type === 'rename') { const name = text(op.name, 'name'); changes.push({ label: target.name, before: target.name, after: name }); target.name = name }
    else {
      const destination = folder(op.folderId)
      if (op.kind === 'folder') { let ancestor = destination; const seen = new Set<string>(); while (ancestor) { if (ancestor === id || seen.has(ancestor)) throw new Error('A folder cannot be moved into itself or its descendants.'); seen.add(ancestor); ancestor = folders.find(f => f.id === ancestor)?.parentId } }
      const prior = op.kind === 'project' ? (target as Project).folderId : (target as ProjectFolder).parentId
      changes.push({ label: target.name, before: folderBreadcrumb(folders,prior), after: folderBreadcrumb(folders,destination) })
      if (op.kind === 'project') (target as Project).folderId = destination; else (target as ProjectFolder).parentId = destination
    }
    if (op.kind === 'project') touch(target as Project)
  }
  return { snapshot: { projects, folders, revision: snapshot.revision }, changes, projects: projects.filter(p => changed.has(p.id)) }
}
