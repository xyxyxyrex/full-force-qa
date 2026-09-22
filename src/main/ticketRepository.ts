import type { Ticket, TicketRecord, TicketStoreSnapshot } from '../shared/types'
import { sameTicket, validateTicket } from '../shared/tickets'

export interface TicketRepositoryIO {
  read: () => TicketStoreSnapshot
  write: (data: TicketStoreSnapshot) => void
  request: (action: string, payload?: Record<string, unknown>) => Promise<any>
  assertOwner: () => void
}
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export class TicketRepository {
  private syncing?: Promise<TicketStoreSnapshot>
  constructor(private io: TicketRepositoryIO) {}
  list() { this.io.assertOwner(); return this.io.read() }
  save(ticket: Ticket) {
    this.io.assertOwner(); validateTicket(ticket)
    const state = this.io.read()
    const existing = state.records.find(record => record.ticket.id === ticket.id)
    if (state.records.some(record => record.ticket.id !== ticket.id && sameTicket(record.ticket.source, ticket.source))) throw new Error('This source ticket already exists. Edit the existing ticket instead.')
    const record = { ...existing, ticket, revision: existing?.revision || 0, pending: true }
    state.records = [...state.records.filter(item => item.ticket.id !== ticket.id), record]
    this.io.write(state)
    return state
  }
  importMonday(tickets: Ticket[], connectionId: string) {
    this.io.assertOwner()
    for (const incoming of tickets) {
      if (incoming.source.provider !== 'monday' || incoming.source.connectionId !== connectionId) throw new Error('Monday connection identity does not match.')
      const previous = this.io.read().records.find(record => sameTicket(record.ticket.source, incoming.source))
      const ticket = previous ? { ...incoming, source: { ...incoming.source, aliases: [...new Set([incoming.source.externalId, ...(incoming.source.aliases || []), previous.ticket.source.externalId, ...(previous.ticket.source.aliases || [])])] }, id: previous.ticket.id, createdAt: previous.ticket.createdAt, progress: previous.ticket.progress, archived: previous.ticket.archived } : incoming
      // Do not create a new revision when a refresh contains the same source data.
      if (previous && equal({ ...ticket, updatedAt: 0 }, { ...previous.ticket, updatedAt: 0 })) continue
      this.save(ticket)
    }
    const state = this.io.read(); state.lastRefreshAt = Date.now(); delete state.refreshError; this.io.write(state)
    return state
  }
  resolve(id: string, choice: 'local' | 'remote') {
    this.io.assertOwner()
    const state = this.io.read(), record = state.records.find(item => item.ticket.id === id)
    if (!record?.conflict) throw new Error('This ticket no longer has a conflict.')
    if (choice === 'remote') { record.ticket = record.conflict.ticket; record.pending = false }
    else if (choice === 'local') record.pending = true
    else throw new Error('Choose which ticket version to keep.')
    record.revision = record.conflict.revision; delete record.conflict
    this.io.write(state)
    return state
  }
  sync(): Promise<TicketStoreSnapshot> {
    if (!this.syncing) this.syncing = this.performSync().finally(() => { this.syncing = undefined })
    return this.syncing
  }
  private async performSync() {
    this.io.assertOwner()
    try {
      for (const sent of this.io.read().records.filter(record => record.pending && !record.conflict)) {
        this.io.assertOwner()
        const result = await this.io.request('save_ticket', { ticket: sent.ticket, revision: sent.revision })
        this.io.assertOwner()
        const state = this.io.read(), current = state.records.find(record => record.ticket.id === sent.ticket.id)
        if (!current) continue
        if (result.conflict) {
          if (equal(current.ticket, result.ticket)) { current.revision = result.revision; current.pending = false; delete current.conflict }
          else current.conflict = { ticket: result.ticket, revision: result.revision }
        } else {
          current.revision = result.revision
          current.pending = !equal(current.ticket, sent.ticket)
        }
        this.io.write(state)
      }
      const remote = await this.io.request('list_tickets')
      this.io.assertOwner()
      const state = this.io.read()
      for (const incoming of remote.records as TicketRecord[]) {
        validateTicket(incoming.ticket)
        const local = state.records.find(record => record.ticket.id === incoming.ticket.id)
        if (!local) state.records.push({ ...incoming, pending: false })
        else if (!local.pending) Object.assign(local, incoming, { pending: false, conflict: undefined })
        else if (local.revision !== incoming.revision) {
          if (equal(local.ticket, incoming.ticket)) Object.assign(local, incoming, { pending: false, conflict: undefined })
          else local.conflict = { ticket: incoming.ticket, revision: incoming.revision }
        }
      }
      delete state.syncError; this.io.write(state)
    } catch (error) {
      this.io.assertOwner()
      const state = this.io.read(); state.syncError = error instanceof Error ? error.message : 'Ticket sync failed.'; this.io.write(state)
    }
    return this.list()
  }
}
