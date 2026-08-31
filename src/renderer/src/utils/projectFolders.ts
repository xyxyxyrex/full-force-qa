import type { Project, ProjectFolder } from '../../../shared/types'

export function getChildFolders(folders: ProjectFolder[], parentId?: string | null): ProjectFolder[] {
  const normalizedParentId = parentId || undefined
  return folders
    .filter((folder) => (folder.parentId || undefined) === normalizedParentId)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

export function getFolderBreadcrumbs(folders: ProjectFolder[], folderId?: string | null): ProjectFolder[] {
  if (!folderId) return []
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: ProjectFolder[] = []
  const visited = new Set<string>()
  let currentId: string | undefined = folderId

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const folder = byId.get(currentId)
    if (!folder) break
    path.unshift(folder)
    currentId = folder.parentId
  }

  return path
}

export function getFolderDisplayPath(folders: ProjectFolder[], folderId: string): string {
  const path = getFolderBreadcrumbs(folders, folderId)
  return path.length ? path.map((folder) => folder.name).join(' / ') : 'Unknown folder'
}

export function canMoveFolder(
  folders: ProjectFolder[],
  folderId: string,
  targetParentId?: string | null,
): boolean {
  if (!targetParentId) return true
  if (folderId === targetParentId) return false

  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const visited = new Set<string>()
  let currentId: string | undefined = targetParentId

  while (currentId && !visited.has(currentId)) {
    if (currentId === folderId) return false
    visited.add(currentId)
    currentId = byId.get(currentId)?.parentId
  }

  return true
}

export function countDirectFolderItems(
  folders: ProjectFolder[],
  projects: Pick<Project, 'folderId'>[],
  folderId: string,
): number {
  const childFolderCount = folders.filter((folder) => folder.parentId === folderId).length
  const projectCount = projects.filter((project) => project.folderId === folderId).length
  return childFolderCount + projectCount
}
