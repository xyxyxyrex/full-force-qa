export interface MondayLink {
  url: string
  label: string
}

export interface MondayBoard {
  id: string
  name: string
  kind?: string
  state?: string
}

export interface MondayUser {
  id: string
  name: string
  email?: string
  enabled?: boolean
  isGuest?: boolean
}

export type MondayAssignmentMode = 'all' | 'me' | 'users'

export interface MondaySyncPreferences {
  boardIds: string[]
  assignmentMode: MondayAssignmentMode
  userIds: string[]
}

export interface MondayMetadata {
  me: MondayUser
  boards: MondayBoard[]
  users: MondayUser[]
}

export interface MondayTicket {
  id: string
  sourceIds?: string[]
  name: string
  boardId?: string
  boardName: string
  status: 'In Progress' | 'Requested' | 'Re-testing' | 'QA Passed' | 'Approved' | string
  stagingUrl: string
  adminUrl: string
  figmaUrl?: string
  googleSheetUrl?: string
  otherLinks: MondayLink[]
  assigneeIds?: string[]
  assigneeNames?: string[]
  updatedAt: string
}

export const MONDAY_PREFERENCES_KEY = 'parity_monday_sync_preferences'
const NOISE_DOMAINS = ['monday.com', 'gravatar.com', 'google.com/url', 'googleapis.com']

export function loadMondayPreferences(): MondaySyncPreferences | null {
  try {
    const value = JSON.parse(localStorage.getItem(MONDAY_PREFERENCES_KEY) || 'null')
    if (!value || !Array.isArray(value.boardIds)) return null
    return {
      boardIds: value.boardIds.map(String),
      assignmentMode: ['all', 'me', 'users'].includes(value.assignmentMode) ? value.assignmentMode : 'me',
      userIds: Array.isArray(value.userIds) ? value.userIds.map(String) : [],
    }
  } catch { return null }
}

export function saveMondayPreferences(preferences: MondaySyncPreferences): void {
  localStorage.setItem(MONDAY_PREFERENCES_KEY, JSON.stringify(preferences))
}

async function mondayRequest(query: string, variables?: Record<string, unknown>): Promise<any> {
  if (!window.electronAPI?.mondayGraphQL) throw new Error('This Parity build does not include the secure Monday connector.')
  return window.electronAPI.mondayGraphQL(query, variables)
}

export async function fetchMondayMetadataApi(): Promise<MondayMetadata> {
  const result = await mondayRequest(`query ParityMondaySources {
    me { id name email }
    boards(limit: 200, order_by: used_at) { id name board_kind state }
    users(limit: 500) { id name email enabled is_guest }
  }`)
  const me = result?.data?.me
  if (!me?.id) throw new Error('Monday did not return the connected user. Ensure me:read is enabled for the app.')
  return {
    me: { id: String(me.id), name: me.name || 'Current user', email: me.email },
    boards: (result?.data?.boards || []).map((board: any) => ({ id: String(board.id), name: board.name, kind: board.board_kind, state: board.state })),
    users: (result?.data?.users || []).map((user: any) => ({ id: String(user.id), name: user.name, email: user.email, enabled: user.enabled, isGuest: user.is_guest })),
  }
}

const extractLinksFromBody = (body: string, links: MondayLink[], seenUrls: Set<string>): void => {
  const anchorRegex = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gis
  let match: RegExpExecArray | null
  while ((match = anchorRegex.exec(body)) !== null) {
    const url = match[1]
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    links.push({ url, label: match[2].replace(/<[^>]+>/g, '').trim() })
  }
  const textOnly = body.replace(/<[^>]+>/g, ' ')
  const bareUrlRegex = /(https?:\/\/[^\s<>"')\]]+)/g
  while ((match = bareUrlRegex.exec(textOnly)) !== null) {
    if (!seenUrls.has(match[1])) {
      seenUrls.add(match[1])
      links.push({ url: match[1], label: '' })
    }
  }
}

const classifyUrl = (url: string, label = ''): 'googleSheet' | 'figma' | 'admin' | 'site' | null => {
  const lowerUrl = url.toLowerCase()
  const lowerLabel = label.toLowerCase()
  if (lowerUrl.includes('docs.google.com/spreadsheets') || lowerUrl.includes('sheets.google.com') || (lowerUrl.includes('google.com') && /sheet|tracker|qa/.test(lowerLabel))) return 'googleSheet'
  if (lowerUrl.includes('figma.com')) return 'figma'
  if (lowerUrl.includes('/wp-admin')) return 'admin'
  if (NOISE_DOMAINS.some((domain) => lowerUrl.includes(domain))) return null
  return /^https?:\/\//i.test(url) ? 'site' : null
}

const displayLabel = (link: MondayLink): string => {
  if (link.label && link.label.length > 2 && !/^https?:/i.test(link.label)) return link.label
  try { return new URL(link.url).hostname.replace(/^www\./, '') } catch { return 'Link' }
}

function peopleIds(item: any): string[] {
  const ids = new Set<string>()
  for (const column of item.column_values || []) {
    if (!['people', 'person', 'multiple-person', 'multiple_person'].includes(column.type)) continue
    try {
      const value = typeof column.value === 'string' ? JSON.parse(column.value) : column.value
      for (const person of value?.personsAndTeams || []) if (person?.id != null) ids.add(String(person.id))
    } catch { /* ignore malformed empty values */ }
  }
  return [...ids]
}

function columnLinks(item: any): MondayLink[] {
  const links: MondayLink[] = []
  const seen = new Set<string>()
  for (const column of item.column_values || []) {
    const text = String(column.text || '').trim()
    let raw = ''
    try {
      const value = typeof column.value === 'string' ? JSON.parse(column.value) : column.value
      raw = String(value?.url || value?.text || '')
    } catch { raw = String(column.value || '') }
    const match = `${raw} ${text}`.match(/https?:\/\/[^\s"'<>]+/i)
    if (!match || seen.has(match[0])) continue
    seen.add(match[0])
    links.push({ url: match[0], label: column.column?.title || 'Link' })
  }
  return links
}

function ticketFromItem(board: MondayBoard, item: any, updates: any[], usersById: Map<string, MondayUser>): MondayTicket {
  const allLinks = columnLinks(item)
  const seen = new Set(allLinks.map((link) => link.url))
  for (const update of updates || []) {
    if (update.body) extractLinksFromBody(update.body, allLinks, seen)
    for (const reply of update.replies || []) if (reply.body) extractLinksFromBody(reply.body, allLinks, seen)
  }

  let stagingUrl = ''
  let adminUrl = ''
  let figmaUrl = ''
  let googleSheetUrl = ''
  const otherLinks: MondayLink[] = []
  for (const link of allLinks) {
    const type = classifyUrl(link.url, link.label)
    if (type === 'googleSheet' && !googleSheetUrl) googleSheetUrl = link.url
    else if (type === 'figma' && !figmaUrl) figmaUrl = link.url
    else if (type === 'admin' && !adminUrl) adminUrl = link.url
    else if (type === 'site' && !stagingUrl) stagingUrl = link.url
    else if (type) otherLinks.push({ url: link.url, label: displayLabel(link) })
  }

  const statusColumn = (item.column_values || []).find((column: any) => column.type === 'status' || /status/i.test(column.column?.title || ''))
  const assigneeIds = peopleIds(item)
  return {
    id: String(item.id),
    sourceIds: [String(item.id)],
    name: item.name || 'Untitled Monday item',
    boardId: board.id,
    boardName: board.name,
    status: statusColumn?.text || 'Requested',
    stagingUrl,
    adminUrl,
    figmaUrl: figmaUrl || undefined,
    googleSheetUrl: googleSheetUrl || undefined,
    otherLinks,
    assigneeIds,
    assigneeNames: assigneeIds.map((id) => usersById.get(id)?.name).filter(Boolean) as string[],
    updatedAt: item.updated_at || '',
  }
}

function mergeTickets(target: MondayTicket, source: MondayTicket): MondayTicket {
  const latest = source.updatedAt > target.updatedAt ? source : target
  const links = [...target.otherLinks, ...source.otherLinks]
  const seen = new Set<string>()
  return {
    ...target,
    name: latest.name,
    status: latest.status,
    sourceIds: [...new Set([...(target.sourceIds || [target.id]), ...(source.sourceIds || [source.id])])],
    boardName: [...new Set(`${target.boardName}|||${source.boardName}`.split('|||'))].join(' + '),
    stagingUrl: target.stagingUrl || source.stagingUrl,
    adminUrl: target.adminUrl || source.adminUrl,
    figmaUrl: target.figmaUrl || source.figmaUrl,
    googleSheetUrl: target.googleSheetUrl || source.googleSheetUrl,
    otherLinks: links.filter((link) => !seen.has(link.url.toLowerCase()) && !!seen.add(link.url.toLowerCase())),
    assigneeIds: [...new Set([...(target.assigneeIds || []), ...(source.assigneeIds || [])])],
    assigneeNames: [...new Set([...(target.assigneeNames || []), ...(source.assigneeNames || [])])],
    updatedAt: latest.updatedAt,
  }
}

export async function fetchMondayTicketsApi(preferencesOrLegacyToken?: MondaySyncPreferences | string): Promise<MondayTicket[]> {
  const metadata = await fetchMondayMetadataApi()
  // Older renderer bundles passed the API token here. Credentials now live in
  // Electron safeStorage and GraphQL calls go through IPC, so a legacy string
  // argument is intentionally ignored while remaining source-compatible.
  const saved = typeof preferencesOrLegacyToken === 'string'
    ? loadMondayPreferences()
    : preferencesOrLegacyToken || loadMondayPreferences()
  if (!saved?.boardIds.length) throw new Error('Choose at least one Monday board before syncing.')
  const selectedUsers = new Set(saved.assignmentMode === 'me' ? [metadata.me.id] : saved.userIds)
  const usersById = new Map(metadata.users.map((user) => [user.id, user]))
  const boardsById = new Map(metadata.boards.map((board) => [board.id, board]))
  const selectedBoards = saved.boardIds.map((id) => boardsById.get(id)).filter(Boolean) as MondayBoard[]
  if (!selectedBoards.length) throw new Error('The selected Monday boards are no longer accessible. Edit the integration sources.')

  const rawItems: Array<{ board: MondayBoard; item: any }> = []
  const itemFields = `id name updated_at column_values { id text value type column { title } }`
  for (const board of selectedBoards) {
    const first = await mondayRequest(`query ParityBoardItems($ids: [ID!]!) {
      boards(ids: $ids) { items_page(limit: 200) { cursor items { ${itemFields} } } }
    }`, { ids: [board.id] })
    let page = first?.data?.boards?.[0]?.items_page
    while (page) {
      for (const item of page.items || []) {
        const assigned = peopleIds(item)
        if (saved.assignmentMode === 'all' || assigned.some((id) => selectedUsers.has(id))) rawItems.push({ board, item })
      }
      if (!page.cursor) break
      const next = await mondayRequest(`query ParityNextBoardItems($cursor: String!) {
        next_items_page(limit: 200, cursor: $cursor) { cursor items { ${itemFields} } }
      }`, { cursor: page.cursor })
      page = next?.data?.next_items_page
    }
  }

  const updatesById = new Map<string, any[]>()
  for (let index = 0; index < rawItems.length; index += 100) {
    const ids = rawItems.slice(index, index + 100).map(({ item }) => String(item.id))
    const result = await mondayRequest(`query ParityItemUpdates($ids: [ID!]!) {
      items(ids: $ids) { id updates(limit: 15) { body replies { body } } }
    }`, { ids })
    for (const item of result?.data?.items || []) updatesById.set(String(item.id), item.updates || [])
  }

  const exact = new Map<string, MondayTicket>()
  for (const { board, item } of rawItems) {
    const ticket = ticketFromItem(board, item, updatesById.get(String(item.id)) || [], usersById)
    exact.set(ticket.id, exact.has(ticket.id) ? mergeTickets(exact.get(ticket.id)!, ticket) : ticket)
  }

  // Mirror/connect-board records often have different IDs. Merge only when the full
  // normalized title and at least one resource URL match, avoiding title-only collisions.
  const deduped: MondayTicket[] = []
  for (const ticket of exact.values()) {
    const normalizedName = ticket.name.trim().toLowerCase().replace(/\s+/g, ' ')
    const urls = new Set([ticket.stagingUrl, ticket.adminUrl, ticket.figmaUrl, ticket.googleSheetUrl, ...ticket.otherLinks.map((link) => link.url)].filter(Boolean).map((url) => String(url).toLowerCase()))
    const duplicateIndex = deduped.findIndex((candidate) => {
      if (candidate.name.trim().toLowerCase().replace(/\s+/g, ' ') !== normalizedName) return false
      const candidateUrls = [candidate.stagingUrl, candidate.adminUrl, candidate.figmaUrl, candidate.googleSheetUrl, ...candidate.otherLinks.map((link) => link.url)].filter(Boolean)
      return candidateUrls.some((url) => urls.has(String(url).toLowerCase()))
    })
    if (duplicateIndex >= 0) deduped[duplicateIndex] = mergeTickets(deduped[duplicateIndex], ticket)
    else deduped.push(ticket)
  }

  deduped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  localStorage.setItem('monday_tickets', JSON.stringify(deduped))
  localStorage.setItem('qa_cached_monday_tickets', JSON.stringify(deduped))
  return deduped
}
