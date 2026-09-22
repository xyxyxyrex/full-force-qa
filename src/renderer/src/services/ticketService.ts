import type { Ticket, TicketStoreSnapshot } from '../../../shared/types'
import { toIntakeTicket, projectTicketRef } from '../../../shared/tickets'
import { ticketProviders } from './ticketProviders'

export const ticketsChanged = () => window.dispatchEvent(new Event('parity:tickets-changed'))
export async function listIntakeTickets() {
  const data = await window.electronAPI.ticketsList()
  return data.records.filter(record => !record.ticket.archived).map(record => toIntakeTicket(record.ticket))
}
export async function saveTicket(ticket: Ticket, ownerKey: string) {
  const state = await window.electronAPI.ticketsSave(ticket, ownerKey)
  ticketsChanged()
  void syncTickets()
  return state
}
export async function syncTickets() {
  try { const state = await window.electronAPI.ticketsSync(); ticketsChanged(); return state }
  catch { return undefined }
}
let refreshPromise: Promise<TicketStoreSnapshot> | undefined
export function refreshMondayTickets() {
  if (!refreshPromise) refreshPromise = refreshMonday().finally(() => { refreshPromise = undefined })
  return refreshPromise
}
async function refreshMonday() {
  const before = await window.electronAPI.ticketsList()
  try {
    const { connectionId, tickets: fetched } = await ticketProviders.monday.fetch!()
    const legacyVerified = before.ownerKey === connectionId
    const migrationKey = `parity_ticket_migration:${before.ownerKey}`
    const migrate = legacyVerified && !localStorage.getItem(migrationKey)
    const activeIds: string[] = migrate ? JSON.parse(localStorage.getItem('active_monday_ticket_ids') || '[]') : []
    // Old caches lack reliable ownership metadata. Re-fetch through the verified
    // connector before importing; retain old caches until migration succeeds.
    if ((await window.electronAPI.ticketsList()).ownerKey !== before.ownerKey) throw new Error('Account changed during refresh.')
    const state = await window.electronAPI.ticketsImportMonday(fetched.map(ticket => ({ ...ticket, progress: { ...ticket.progress, active: activeIds.some(id => id === ticket.source.externalId || ticket.source.aliases?.includes(id)) } })), connectionId, before.ownerKey)
    if (migrate) {
      for (const project of await window.electronAPI.getProjects()) {
        const ref = projectTicketRef(project, connectionId)
        if (!project.ticketRef && ref) await window.electronAPI.saveProject({ ...project, ticketRef: ref }, before.ownerKey)
      }
      localStorage.setItem(migrationKey, '1')
    }
    ticketsChanged(); void syncTickets(); return state
  } catch (error) {
    try {
      if ((await window.electronAPI.ticketsList()).ownerKey === before.ownerKey) await window.electronAPI.ticketsRefreshFailed(error instanceof Error ? error.message : 'Monday refresh failed.', before.ownerKey)
    } catch {}
    ticketsChanged(); throw error
  }
}
