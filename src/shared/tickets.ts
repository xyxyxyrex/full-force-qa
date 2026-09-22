import type { Project, Ticket, TicketSourceRef, TicketResources, TicketProvider } from './types'

export const TICKET_PROVIDERS: Record<TicketProvider, { label: string; fetch: boolean; manual: boolean }> = {
  monday: { label: 'Monday.com', fetch: true, manual: false },
  opsmosis: { label: 'Opsmosis', fetch: false, manual: true },
  manual: { label: 'Manual', fetch: false, manual: true },
}
export const QA_STATUSES = ['To review', 'In review', 'Needs fixes', 'Verified'] as const
export const ticketKey = (source: TicketSourceRef) => [source.provider, source.connectionId, source.externalId].map(encodeURIComponent).join(':')
export function sameTicket(left?: TicketSourceRef, right?: TicketSourceRef): boolean {
  if (!left || !right || left.provider !== right.provider || left.connectionId !== right.connectionId) return false
  const ids = new Set([left.externalId, ...(left.aliases || [])])
  return [right.externalId, ...(right.aliases || [])].some(id => ids.has(id))
}
export function projectTicketRef(project: Project, mondayConnectionId?: string): TicketSourceRef | undefined {
  if (project.ticketRef) return project.ticketRef
  const id = project.mondayTicketId || (project.id.startsWith('monday-') ? project.id.slice(7) : '')
  return id && mondayConnectionId ? { provider: 'monday', connectionId: mondayConnectionId, externalId: id } : undefined
}
export function linkProject(project: Project, ticket: Ticket): Project {
  return { ...project, ticketRef: ticket.source, mondayTicketId: ticket.source.provider === 'monday' ? ticket.source.externalId : undefined }
}
export function validateTicket(ticket: Ticket): void {
  if (!ticket || !ticket.source || !TICKET_PROVIDERS[ticket.source.provider]) throw new Error('Choose a supported ticket source.')
  if (typeof ticket.id !== 'string' || !ticket.id || ticket.id.length > 500 || !ticket.source.connectionId || !ticket.source.externalId) throw new Error('Ticket identity is missing.')
  if (typeof ticket.title !== 'string' || !ticket.title.trim() || ticket.title.length > 500) throw new Error('Enter a title of at most 500 characters.')
  if (typeof ticket.description !== 'string' || typeof ticket.sourceStatus !== 'string' || typeof ticket.sourceGroup !== 'string') throw new Error('Invalid ticket details.')
  if (!ticket.resources || !Array.isArray(ticket.resources.otherLinks) || !Array.isArray(ticket.assignees)) throw new Error('Invalid ticket resources.')
  if (!ticket.progress || !QA_STATUSES.includes(ticket.progress.qaStatus) || typeof ticket.progress.active !== 'boolean') throw new Error('Invalid QA progress.')
  if (typeof ticket.archived !== 'boolean' || !Number.isFinite(ticket.createdAt) || !Number.isFinite(ticket.updatedAt)) throw new Error('Invalid ticket metadata.')
  const urls = [ticket.source.url, ticket.resources.stagingUrl, ticket.resources.adminUrl, ticket.resources.figmaUrl, ticket.resources.googleSheetUrl, ...ticket.resources.otherLinks.map(link => link.url)]
  for (const url of urls.filter(Boolean)) {
    try { if (!['https:', 'http:'].includes(new URL(url!).protocol)) throw new Error() }
    catch { throw new Error('Resource links must be valid HTTP or HTTPS URLs.') }
  }
  if (JSON.stringify(ticket).length > 200_000) throw new Error('Ticket details are too large.')
}
export function extractTicketResources(text: string): TicketResources {
  const result: TicketResources = { stagingUrl: '', adminUrl: '', otherLinks: [] }
  const seen = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = match[0].replace(/[),.;\]]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      if ((host === 'figma.com' || host.endsWith('.figma.com')) && !result.figmaUrl) result.figmaUrl = url
      else if (host === 'docs.google.com' && parsed.pathname.startsWith('/spreadsheets/') && !result.googleSheetUrl) result.googleSheetUrl = url
      else if (/\/wp-admin(?:\/|$)/i.test(parsed.pathname) && !result.adminUrl) result.adminUrl = url
      else if (!result.stagingUrl && !/monday\.com$/.test(host)) result.stagingUrl = url
      else result.otherLinks.push({ url, label: host })
    } catch { /* malformed pasted URL */ }
  }
  return result
}

/** Shared shape for existing compact resource pickers. */
export interface IntakeTicket extends TicketResources {
  id: string; name: string; boardName: string; status: string; updatedAt: string
  source: TicketSourceRef; providerLabel: string
}
export function toIntakeTicket(ticket: Ticket): IntakeTicket {
  return { ...ticket.resources, id: ticket.id, name: ticket.title, boardName: `${TICKET_PROVIDERS[ticket.source.provider].label} · ${ticket.sourceGroup || 'Tickets'}`, status: ticket.sourceStatus, updatedAt: ticket.sourceUpdatedAt || new Date(ticket.updatedAt).toISOString(), source: ticket.source, providerLabel: TICKET_PROVIDERS[ticket.source.provider].label }
}
