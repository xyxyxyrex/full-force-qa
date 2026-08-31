import { describe, expect, it } from 'vitest'
import type { ProjectFolder } from '../../../shared/types'
import {
  canMoveFolder,
  countDirectFolderItems,
  getChildFolders,
  getFolderBreadcrumbs,
  getFolderDisplayPath,
} from './projectFolders'

const folders: ProjectFolder[] = [
  { id: 'root-b', name: 'Zeta', createdAt: 1 },
  { id: 'root-a', name: 'Alpha', createdAt: 2 },
  { id: 'child', name: 'Child', parentId: 'root-a', createdAt: 3 },
  { id: 'grandchild', name: 'Grandchild', parentId: 'child', createdAt: 4 },
]

describe('project folder hierarchy', () => {
  it('returns only direct children in name order', () => {
    expect(getChildFolders(folders).map((folder) => folder.id)).toEqual(['root-a', 'root-b'])
    expect(getChildFolders(folders, 'root-a').map((folder) => folder.id)).toEqual(['child'])
  })

  it('builds breadcrumbs and display paths for nested folders', () => {
    expect(getFolderBreadcrumbs(folders, 'grandchild').map((folder) => folder.id)).toEqual([
      'root-a',
      'child',
      'grandchild',
    ])
    expect(getFolderDisplayPath(folders, 'grandchild')).toBe('Alpha / Child / Grandchild')
  })

  it('stops safely when malformed folder data contains a cycle', () => {
    const cyclic: ProjectFolder[] = [
      { id: 'one', name: 'One', parentId: 'two', createdAt: 1 },
      { id: 'two', name: 'Two', parentId: 'one', createdAt: 2 },
    ]
    expect(getFolderBreadcrumbs(cyclic, 'one')).toHaveLength(2)
  })

  it('counts direct subfolders and projects as folder items', () => {
    expect(countDirectFolderItems(folders, [{ folderId: 'root-a' }, { folderId: 'child' }], 'root-a')).toBe(2)
  })

  it('prevents folders from being moved into themselves or their descendants', () => {
    expect(canMoveFolder(folders, 'root-a', 'root-a')).toBe(false)
    expect(canMoveFolder(folders, 'root-a', 'grandchild')).toBe(false)
    expect(canMoveFolder(folders, 'child', 'root-b')).toBe(true)
    expect(canMoveFolder(folders, 'child', null)).toBe(true)
  })
})
