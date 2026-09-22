import { app, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { accountContext, accountRequest, assertAccountOwner } from './account'
import { TicketRepository } from './ticketRepository'
import type { Ticket, TicketStoreSnapshot } from '../shared/types'
const repositories = new Map<string, TicketRepository>()
function repository(expectedOwner?: string) {
  if (expectedOwner !== undefined) assertAccountOwner(expectedOwner)
  const context = accountContext(), ownerKey = context.ownerKey
  if (!ownerKey) throw new Error('Sign in to Parity to use Tickets.')
  // Rebuild context on every lookup; a previous account epoch must stay invalid.
  const key = ownerKey
  const previous = repositories.get(key)
  if (previous) { try { previous.list(); return previous } catch { repositories.delete(key) } }
  const file = join(app.getPath('userData'), `tickets-${createHash('sha256').update(ownerKey).digest('hex').slice(0, 24)}.json`)
  const result = new TicketRepository({
    read: () => {
      if (!existsSync(file)) return { ownerKey, records: [] }
      const data = JSON.parse(readFileSync(file, 'utf8')) as TicketStoreSnapshot
      if (data.ownerKey !== ownerKey || !Array.isArray(data.records)) throw new Error('Ticket storage could not be read. The original file has been preserved.')
      return data
    },
    write: data => { context.assert(); writeFileSync(`${file}.tmp`, JSON.stringify(data), 'utf8'); renameSync(`${file}.tmp`, file) },
    request: (action, payload) => { context.assert(); return accountRequest(action, payload) },
    assertOwner: context.assert,
  })
  repositories.set(key, result); return result
}
export function registerTicketHandlers() {
  ipcMain.handle('tickets:list', () => repository().list())
  ipcMain.handle('tickets:save', (_event, ticket: Ticket, owner: string) => { assertAccountOwner(owner); return repository(owner).save(ticket) })
  ipcMain.handle('tickets:sync', () => repository().sync())
  ipcMain.handle('tickets:import-monday', (_event, tickets: Ticket[], connectionId: string, owner: string) => { assertAccountOwner(owner); return repository(owner).importMonday(tickets, connectionId) })
  ipcMain.handle('tickets:resolve', (_event, id: string, choice: 'local' | 'remote', owner: string) => { assertAccountOwner(owner); return repository(owner).resolve(id, choice) })
  ipcMain.handle('tickets:refresh-failed', (_event, message: string, ownerKey: string) => {
    assertAccountOwner(ownerKey)
    const repo = repository(ownerKey), state = repo.list()
    // Refresh errors are separate from sync errors and do not replace cached tickets.
    const owner = state.ownerKey
    const file = join(app.getPath('userData'), `tickets-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}.json`)
    state.refreshError = String(message).slice(0, 1000)
    writeFileSync(`${file}.tmp`, JSON.stringify(state), 'utf8'); renameSync(`${file}.tmp`, file)
  })
}
