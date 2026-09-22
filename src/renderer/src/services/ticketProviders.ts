import type { Ticket, TicketProvider } from '../../../shared/types'
import { TICKET_PROVIDERS, ticketKey } from '../../../shared/tickets'
import { fetchMondayMetadataApi, fetchMondayTicketsApi, type MondayTicket } from '../utils/mondayApi'

export interface TicketProviderAdapter {
  id: TicketProvider
  capabilities: { fetch: boolean; manual: boolean }
  connectionStatus(): Promise<{ connected: boolean; error?: string }>
  configure(): void
  fetch?: () => Promise<{ connectionId: string; tickets: Ticket[] }>
}
export function fromMonday(ticket: MondayTicket, connectionId: string, active = false): Ticket {
  const source = { provider: 'monday' as const, connectionId, externalId: ticket.id, aliases: ticket.sourceIds, url: ticket.boardId ? `https://monday.com/boards/${encodeURIComponent(ticket.boardId)}/pulses/${encodeURIComponent(ticket.id)}` : undefined }
  return { id: ticketKey(source), source, title: ticket.name, description: '', sourceStatus: ticket.status, sourceGroup: ticket.boardName,
    assignees: (ticket.assigneeIds || []).map((id, index) => ({ id, name: ticket.assigneeNames?.[index] || id })),
    resources: { stagingUrl: ticket.stagingUrl, adminUrl: ticket.adminUrl, figmaUrl: ticket.figmaUrl, googleSheetUrl: ticket.googleSheetUrl, otherLinks: ticket.otherLinks || [] },
    progress: { active, qaStatus: 'To review' }, archived: false, createdAt: Date.now(), updatedAt: Date.now(), sourceUpdatedAt: ticket.updatedAt }
}
const configure = () => { window.dispatchEvent(new Event('parity:open-integrations')) }
const manual = (id: 'opsmosis' | 'manual'): TicketProviderAdapter => ({
  id, capabilities: TICKET_PROVIDERS[id],
  connectionStatus: async () => ({ connected: true }), configure,
})
export const ticketProviders: Record<TicketProvider, TicketProviderAdapter> = {
  monday: {
    id: 'monday', capabilities: TICKET_PROVIDERS.monday,
    connectionStatus: () => window.electronAPI.mondayStatus(), configure,
    fetch: async () => {
      const metadata = await fetchMondayMetadataApi()
      const connectionId = 'monday:' + metadata.me.id
      const tickets = await fetchMondayTicketsApi()
      const status = await window.electronAPI.mondayStatus()
      if (!status.connected || String(status.user?.id) !== metadata.me.id) throw new Error('The Monday connection changed during refresh. Try again.')
      return { connectionId, tickets: tickets.map(ticket => fromMonday(ticket, connectionId)) }
    },
  },
  opsmosis: manual('opsmosis'),
  manual: manual('manual'),
}
