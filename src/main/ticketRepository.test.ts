import { describe, it, expect } from 'vitest'
import { TicketRepository } from './ticketRepository'
import { extractTicketResources, linkProject, sameTicket, ticketKey, projectTicketRef } from '../shared/tickets'
import type { Ticket, TicketStoreSnapshot } from '../shared/types'

function ticket(provider: Ticket['source']['provider'] = 'opsmosis', id = '42'): Ticket {
  const source = { provider, connectionId: provider === 'monday' ? 'monday:7' : 'manual', externalId: id }
  return { id: ticketKey(source), source, title: 'Home page', description: '', sourceStatus: 'Done', sourceGroup: 'Web', assignees: [], resources: { stagingUrl: 'https://example.com', adminUrl: '', otherLinks: [] }, progress: { active: true, qaStatus: 'To review' }, archived: false, createdAt: 1, updatedAt: 1 }
}
function setup(request: (action: string, payload?: any) => Promise<any> = async () => { throw Error('offline') }) {
  let state: TicketStoreSnapshot = { ownerKey: 'monday:7', records: [] }, valid = true
  const io = { read: () => structuredClone(state), write: (next: TicketStoreSnapshot) => { state = structuredClone(next) }, request, assertOwner: () => { if (!valid) throw Error('account changed') } }
  return { repo: new TicketRepository(io), restart: () => new TicketRepository(io), switchAccount: () => { valid = false }, state: () => state }
}
describe('independent ticket intake', () => {
  it('keeps providers and connections distinct even with identical IDs, titles and URLs', () => {
    const { repo } = setup()
    repo.save(ticket()); repo.save(ticket('manual')); repo.save(ticket('monday'))
    expect(repo.list().records).toHaveLength(3)
    expect(sameTicket(ticket().source, ticket('manual').source)).toBe(false)
    expect(sameTicket(ticket().source, { ...ticket().source, connectionId: 'another' })).toBe(false)
  })
  it('retains offline edits and archive state across restart', async () => {
    const { repo, restart } = setup()
    repo.save({ ...ticket(), archived: true }); await repo.sync()
    expect(restart().list().records[0]).toMatchObject({ pending: true, revision: 0, ticket: { archived: true } })
    expect(restart().list().syncError).toBe('offline')
  })
  it('retains QA progress and stable IDs through repeated refresh and Monday aliases', () => {
    const { repo } = setup(); const original = ticket('monday')
    repo.importMonday([original], 'monday:7')
    repo.save({ ...original, progress: { active: false, qaStatus: 'Verified' } })
    const alias = { ...original, source: { ...original.source, externalId: '43', aliases: ['42'] }, title: 'Updated source' }
    repo.importMonday([alias], 'monday:7'); repo.importMonday([alias], 'monday:7')
    repo.importMonday([{ ...alias, source: { ...alias.source, aliases: ['43'] } }], 'monday:7')
    expect(repo.list().records[0].ticket.source.aliases).toContain('42')
    expect(repo.list().records).toHaveLength(1)
    expect(repo.list().records[0].ticket).toMatchObject({ id: original.id, progress: { active: false, qaStatus: 'Verified' }, title: 'Updated source' })
  })
  it('preserves local conflict until the user chooses, then retries with the remote revision', async () => {
    const remote = { ...ticket(), title: 'Other device' }; let revision = 2
    const { repo } = setup(async (action, payload) => action === 'list_tickets' ? { records: [{ ticket: remote, revision }] } : payload.revision === revision ? { revision: ++revision } : { conflict: true, ticket: remote, revision })
    repo.save(ticket()); await repo.sync()
    expect(repo.list().records[0]).toMatchObject({ ticket: { title: 'Home page' }, conflict: { ticket: { title: 'Other device' }, revision: 2 } })
    repo.resolve(ticket().id, 'local')
    expect(repo.list().records[0]).toMatchObject({ pending: true, revision: 2 })
    // A remote choice discards the preserved draft only after explicit resolution.
    const other = setup(async () => ({ conflict: true, ticket: remote, revision: 2 })).repo
    other.save(ticket()); await other.sync(); other.resolve(ticket().id, 'remote')
    expect(other.list().records[0]).toMatchObject({ pending: false, ticket: { title: 'Other device' } })
  })
  it('does not acknowledge edits made while a save is in flight', async () => {
    let release!: (value: unknown) => void
    const { repo } = setup(action => action === 'save_ticket' ? new Promise(resolve => { release = resolve }) : Promise.resolve({ records: [] }))
    repo.save(ticket()); const pending = repo.sync()
    repo.save({ ...ticket(), title: 'Edited during sync', updatedAt: 2 })
    release({ revision: 1 }); await pending
    expect(repo.list().records[0]).toMatchObject({ pending: true, revision: 1, ticket: { title: 'Edited during sync' } })
  })
  it('prevents in-flight writes after the active account changes', async () => {
    let release!: (value: unknown) => void
    const ctx = setup(() => new Promise(resolve => { release = resolve }))
    ctx.repo.save(ticket()); const pending = ctx.repo.sync(); ctx.switchAccount(); release({ revision: 1 })
    await expect(pending).rejects.toThrow('account changed')
    expect(ctx.state().records[0].revision).toBe(0)
  })
  it('handles a lost save response without producing a false conflict', async () => {
    const value = ticket()
    const { repo } = setup(async action => action === 'save_ticket' ? { conflict: true, ticket: value, revision: 1 } : { records: [{ ticket: value, revision: 1 }] })
    repo.save(value); await repo.sync()
    expect(repo.list().records[0]).toMatchObject({ pending: false, revision: 1 })
    expect(repo.list().records[0].conflict).toBeUndefined()
  })
  it('migrates project references repeatably and preserves multiple page IDs and edits', () => {
    const project = { id: 'monday-42', name: 'My edited page', stagingUrl: 'https://custom.test', adminUrl: '', createdAt: 1, lastOpenedAt: 1 }
    const ref = projectTicketRef(project, 'monday:7')
    expect(projectTicketRef({ ...project, ticketRef: ref }, 'monday:7')).toEqual(ref)
    expect(linkProject(project, ticket('monday'))).toMatchObject({ ...project, mondayTicketId: '42' })
    expect(linkProject({ ...project, id: 'page-2' }, ticket('monday')).id).toBe('page-2')
  })
  it('suggests deterministic links without accepting lookalike Figma hosts', () => {
    const links = extractTicketResources('https://figma.com/design/abc https://docs.google.com/spreadsheets/d/qa https://stage.test/wp-admin/ https://stage.test https://stage.test')
    expect(links).toMatchObject({ figmaUrl: 'https://figma.com/design/abc', googleSheetUrl: 'https://docs.google.com/spreadsheets/d/qa', stagingUrl: 'https://stage.test', adminUrl: 'https://stage.test/wp-admin/' })
    expect(extractTicketResources('https://figma.com.evil.test/design/abc').figmaUrl).toBeUndefined()
  })
})
