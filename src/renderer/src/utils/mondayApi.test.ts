import { afterEach, expect, it, vi } from 'vitest'
import { fetchMondayTicketsApi } from './mondayApi'
import { fromMonday } from '../services/ticketProviders'
afterEach(() => vi.unstubAllGlobals())
it('retains board and assignee filtering, pagination, classified links and Monday aliases', async () => {
  const item = (id: string, person: string) => ({ id, name: 'Page ' + id, updated_at: '2026-09-21', column_values: [{ type: 'people', value: JSON.stringify({ personsAndTeams: [{ id: person }] }) }, { type: 'status', text: 'Dev Complete' }] })
  const request = vi.fn(async (query: string, variables: any) => {
    if (query.includes('ParityMondaySources')) return { data: { me: { id: '7', name: 'Me' }, users: [{ id: '7', name: 'Me' }], boards: [{ id: 'b1', name: 'Selected' }, { id: 'b2', name: 'Other' }] } }
    if (query.includes('ParityBoardItems')) { expect(variables.ids).toEqual(['b1']); return { data: { boards: [{ items_page: { cursor: 'next', items: [item('42', '7'), item('43', '8')] } }] } } }
    if (query.includes('ParityNextBoardItems')) return { data: { next_items_page: { cursor: null, items: [item('44', '7')] } } }
    if (query.includes('ParityItemUpdates')) return { data: { items: variables.ids.map((id: string) => ({ id, updates: [{ body: 'https://stage.test https://stage.test/wp-admin/ https://figma.com/design/a https://docs.google.com/spreadsheets/d/q' }] })) } }
    throw Error('Unexpected query')
  })
  vi.stubGlobal('window', { electronAPI: { mondayGraphQL: request } })
  const tickets = await fetchMondayTicketsApi({ boardIds: ['b1'], assignmentMode: 'me', userIds: [] })
  expect(tickets.map(ticket => ticket.id)).toEqual(['42', '44'])
  const normalized = fromMonday(tickets[0], 'monday:7')
  expect(normalized.resources).toMatchObject({ stagingUrl: 'https://stage.test', adminUrl: 'https://stage.test/wp-admin/', figmaUrl: 'https://figma.com/design/a', googleSheetUrl: 'https://docs.google.com/spreadsheets/d/q' })
  expect(normalized.source.aliases).toEqual(['42'])
  expect(normalized.sourceStatus).toBe('Dev Complete')
  expect(normalized.progress.qaStatus).toBe('To review')
})
it('propagates provider failures instead of reporting an empty queue', async () => {
  vi.stubGlobal('window', { electronAPI: { mondayGraphQL: async () => { throw Error('Rate limited') } } })
  await expect(fetchMondayTicketsApi({ boardIds: ['b1'], assignmentMode: 'all', userIds: [] })).rejects.toThrow('Rate limited')
})
