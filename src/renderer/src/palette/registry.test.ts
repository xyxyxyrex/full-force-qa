import { describe, expect, it } from 'vitest'
import { paletteProviders, rankItems, rankItemsAsync, registerPaletteProvider, type PaletteItem } from './registry'
import { getPaletteNotes, setPaletteNotes, workspaceItems } from './workspaceSearch'
import type { NoteDocument, ProjectFolder } from '../../../shared/types'

const item = (id: string, title: string, description = ''): PaletteItem => ({ id, title, description, group: 'Commands', run: () => {} })
describe('palette search', () => {
  it('ranks exact command names first and matches multiple words without regex interpretation', () => {
    expect(rankItems([item('a', 'Other', 'zoom'), item('b', 'Zoom in'), item('c', 'Zoom')], 'zoom').items.map(i => i.id)).toEqual(['c', 'b', 'a'])
    expect(rankItems([item('a', 'Café card', 'a.b [link]')], 'cafe "a.b" [link]').total).toBe(1)
    expect(rankItems([item('a', 'Café', 'axb')], 'a.b').total).toBe(0)
  })
  it('reports complete counts while limiting result rendering and shows matching context', async () => {
    const items = Array.from({ length: 1250 }, (_, index) => item(String(index), `File ${index}`, `${'x'.repeat(500)} needle ${'x'.repeat(500)} endterm`))
    const result = await rankItemsAsync(items, 'needle endterm', new AbortController().signal)
    expect(result.total).toBe(1250)
    expect(result.items).toHaveLength(80)
    expect(result.items[0].description).toContain('needle')
    expect(result.items[0].description!.length).toBeLessThan(300)
  })
  it('abandons cancelled searches and unregisters only the correct provider instance', async () => {
    const abort = new AbortController(); abort.abort()
    expect((await rankItemsAsync([item('a', 'test')], 'test', abort.signal)).items).toEqual([])
    const old = registerPaletteProvider('test', () => ({ id: 'test', label: 'old' }))
    const latest = registerPaletteProvider('test', () => ({ id: 'test', label: 'new' }))
    old(); expect(paletteProviders().find(p => p.id === 'test')?.label).toBe('new')
    latest(); expect(paletteProviders().find(p => p.id === 'test')).toBeUndefined()
  })
  it('indexes nested folder paths and isolates private note caches by owner', () => {
    const note = { id: 'n', title: 'Private', plainText: 'secret', tags: [], attachments: [] } as unknown as NoteDocument
    setPaletteNotes('owner-a', [note])
    expect(getPaletteNotes('owner-a')).toEqual([note])
    expect(getPaletteNotes('owner-b')).toEqual([])
    expect(getPaletteNotes(null)).toEqual([])
    const folders: ProjectFolder[] = [{ id: 'a', name: 'Parent', createdAt: 0 }, { id: 'b', name: 'Child', parentId: 'a', createdAt: 0 }]
    const result = workspaceItems({ projects: [], tickets: [], notes: [], folders }, { project() {}, ticket() {}, note() {}, folder() {} })
    expect(rankItems(result, 'parent child').items[0].title).toBe('Child')
    setPaletteNotes(null, [])
    expect(getPaletteNotes('owner-a')).toEqual([])
  })
})
