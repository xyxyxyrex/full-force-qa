export interface MondayLink {
  url: string
  label: string
}

export interface MondayTicket {
  id: string
  name: string
  boardName: string
  status: 'In Progress' | 'Requested' | 'Re-testing' | 'QA Passed' | 'Approved' | string
  stagingUrl: string
  adminUrl: string
  figmaUrl?: string
  googleSheetUrl?: string
  otherLinks: MondayLink[]
  updatedAt: string
}

const KEY_BOARDS = ['Web Development Board', 'QA Schedule']
const NOISE_DOMAINS = ['monday.com', 'gravatar.com', 'google.com/url', 'googleapis.com']

// Helper: extract all URLs (with labels) from a single HTML body
const extractLinksFromBody = (body: string, links: MondayLink[], seenUrls: Set<string>): void => {
  const anchorRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a>/gs
  let match
  while ((match = anchorRegex.exec(body)) !== null) {
    const url = match[1]
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    const label = match[2].replace(/<[^>]+>/g, '').trim()
    links.push({ url, label: label || '' })
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

// Helper: extract URLs from updates AND their replies
const extractLinksFromUpdates = (updates: any[]): MondayLink[] => {
  const links: MondayLink[] = []
  const seenUrls = new Set<string>()
  for (const update of updates || []) {
    if (update.body) extractLinksFromBody(update.body, links, seenUrls)
    for (const reply of update.replies || []) {
      if (reply.body) extractLinksFromBody(reply.body, links, seenUrls)
    }
  }
  return links
}

// Helper: classify a URL into a link category
const classifyUrl = (url: string, label?: string): 'googleSheet' | 'figma' | 'admin' | 'other' | null => {
  const lowerUrl = url.toLowerCase()
  const lowerLabel = (label || '').toLowerCase()

  if (
    lowerUrl.includes('docs.google.com/spreadsheets') ||
    lowerUrl.includes('sheets.google.com') ||
    lowerUrl.includes('google.com/sheets') ||
    (lowerUrl.includes('google.com') && (lowerLabel.includes('sheet') || lowerLabel.includes('tracker') || lowerLabel.includes('qa')))
  ) {
    return 'googleSheet'
  }
  if (lowerUrl.includes('figma.com')) return 'figma'
  if (lowerUrl.includes('/wp-admin') || lowerUrl.includes('wp-admin')) return 'admin'
  if (NOISE_DOMAINS.some(d => lowerUrl.includes(d))) return null
  if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) return 'other'
  return null
}

// Helper: generate a short display label for a URL
const labelForUrl = (link: MondayLink): string => {
  if (link.label && link.label.length > 2 && !link.label.startsWith('http')) return link.label
  try {
    const u = new URL(link.url)
    return u.hostname.replace('www.', '')
  } catch {
    return 'Link'
  }
}

// Helper: safely fetch Monday API with 503 / non-JSON handling
const safeFetchMonday = async (token: string, query: string, variables?: any): Promise<any> => {
  try {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'API-Version': '2024-10'
      },
      body: JSON.stringify({ query, variables })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[Monday] Server returned HTTP ${res.status}:`, text.slice(0, 150))
      return null
    }
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      console.warn('[Monday] Response was not valid JSON:', text.slice(0, 150))
      return null
    }
  } catch (err) {
    console.warn('[Monday] Network error:', err)
    return null
  }
}

export async function fetchMondayTicketsApi(token: string): Promise<MondayTicket[]> {
  try {
    // Step 1: Get current user ID
    const meJson = await safeFetchMonday(token, `{ me { id name } }`)
    if (!meJson || meJson.errors) {
      if (meJson?.errors) console.error('[Monday] API errors:', meJson.errors)
      return []
    }

    const myId = meJson.data?.me?.id
    if (!myId) {
      console.error('[Monday] Could not get user ID')
      return []
    }

    // Step 2: Get board IDs for the key boards + other boards
    const boardListJson = await safeFetchMonday(token, `query { boards(limit: 200, order_by: used_at) { id name } }`)
    const allBoards: { id: string; name: string }[] = boardListJson?.data?.boards || []

    const keyBoardIds = allBoards.filter(b => KEY_BOARDS.includes(b.name)).map(b => b.id)
    const otherBoardIds = allBoards
      .filter(b => !KEY_BOARDS.includes(b.name))
      .slice(0, 30)
      .map(b => b.id)

    const fetchBoardItems = async (boardIds: string[], itemLimit: number, includeUpdates: boolean): Promise<any[]> => {
      if (boardIds.length === 0) return []
      const updatesField = includeUpdates ? 'updates(limit: 15) { body replies { body } }' : ''
      const query = `query($ids: [ID!]) {
        boards(ids: $ids) {
          id
          name
          items_page(limit: ${itemLimit}) {
            items {
              id
              name
              updated_at
              creator { id }
              subscribers { id }
              ${updatesField}
              column_values {
                id
                text
                value
                type
                column { title }
              }
            }
          }
        }
      }`
      const json = await safeFetchMonday(token, query, { ids: boardIds })
      return json?.data?.boards || []
    }

    const [keyBoards, otherBoards] = await Promise.all([
      fetchBoardItems(keyBoardIds, 200, true),
      fetchBoardItems(otherBoardIds, 50, false)
    ])
    const json = { data: { boards: [...(keyBoards || []), ...(otherBoards || [])] } }

    if (json.data && json.data.boards) {
      const itemMap = new Map<string, MondayTicket>()

      json.data.boards.forEach((board: any) => {
        board.items_page?.items?.forEach((item: any) => {
          const myIdStr = String(myId)

          const isSubscriber = item.subscribers?.some(
            (sub: any) => String(sub.id) === myIdStr
          )
          const isCreator = String(item.creator?.id) === myIdStr

          let isAssigned = false
          const personCols = item.column_values?.filter(
            (cv: any) => cv.type === 'people' || cv.type === 'person' ||
                         cv.type === 'multiple-person' || cv.type === 'multiple_person'
          ) || []
          for (const col of personCols) {
            if (col.value) {
              try {
                const parsed = JSON.parse(col.value)
                const ids = parsed.personsAndTeams?.map((p: any) => String(p.id)) || []
                if (ids.includes(myIdStr)) { isAssigned = true; break }
              } catch { /* skip */ }
            }
          }

          if (!isSubscriber && !isCreator && !isAssigned) return

          const allLinks: MondayLink[] = []

          item.column_values?.forEach((cv: any) => {
            const text = (cv.text || '').trim()
            let urlFromValue = ''
            if (cv.value) {
              try {
                const parsed = JSON.parse(cv.value)
                urlFromValue = (parsed.url || parsed.text || '').trim()
              } catch {
                if (typeof cv.value === 'string') urlFromValue = cv.value.trim()
              }
            }

            // Extract real HTTP URL properly!
            let targetUrl = ''
            if (urlFromValue.startsWith('http://') || urlFromValue.startsWith('https://')) {
              targetUrl = urlFromValue
            } else if (text.startsWith('http://') || text.startsWith('https://')) {
              targetUrl = text
            } else {
              const combo = urlFromValue + ' ' + text
              const match = combo.match(/https?:\/\/[^\s"'<>]+/i)
              if (match) targetUrl = match[0]
            }

            if (targetUrl) {
              const title = cv.column?.title || (text && !text.startsWith('http') ? text : '') || 'Link'
              allLinks.push({ url: targetUrl, label: title })
            }
          })

          const updateLinks = extractLinksFromUpdates(item.updates)
          allLinks.push(...updateLinks)

          let stagingUrl = ''
          let adminUrl = ''
          let figmaUrl = ''
          let googleSheetUrl = ''
          const otherLinks: MondayLink[] = []
          const seen = new Set<string>()

          for (const link of allLinks) {
            if (seen.has(link.url)) continue
            seen.add(link.url)
            const type = classifyUrl(link.url, link.label)
            if (type === 'googleSheet') {
              if (!googleSheetUrl) googleSheetUrl = link.url
              otherLinks.push({ url: link.url, label: link.label || 'QA Sheet' })
            } else if (type === 'figma') {
              if (!figmaUrl) figmaUrl = link.url
              otherLinks.push({ url: link.url, label: link.label || 'Figma' })
            } else if (type === 'admin') {
              if (!adminUrl) adminUrl = link.url
              otherLinks.push({ url: link.url, label: link.label || 'WP Admin' })
            } else if (type === 'other') {
              otherLinks.push({ url: link.url, label: labelForUrl(link) })
            }
          }

          let statusStr = 'Requested'
          item.column_values?.forEach((cv: any) => {
            if (cv.column?.title?.toLowerCase().includes('status')) {
              statusStr = cv.text || 'In Progress'
            }
          })

          const prefixMatch = item.name.match(/^\[([^\]]+)\]/)
          const mergeKey = prefixMatch ? prefixMatch[1].toLowerCase() : null
          const isKeyBoard = KEY_BOARDS.includes(board.name)
          const isWebDevBoard = board.name.toLowerCase().includes('web development')

          let existing: MondayTicket | undefined
          if (mergeKey && isKeyBoard) {
            for (const [, ticket] of itemMap) {
              const existingPrefix = ticket.name.match(/^\[([^\]]+)\]/)
              if (existingPrefix && existingPrefix[1].toLowerCase() === mergeKey) {
                existing = ticket
                break
              }
            }
          }

          if (existing) {
            if (!existing.stagingUrl && stagingUrl) existing.stagingUrl = stagingUrl
            if (!existing.adminUrl && adminUrl) existing.adminUrl = adminUrl
            if (!existing.figmaUrl && figmaUrl) existing.figmaUrl = figmaUrl
            if (!existing.googleSheetUrl && googleSheetUrl) existing.googleSheetUrl = googleSheetUrl
            const existingUrls = new Set(existing.otherLinks.map(l => l.url))
            for (const link of otherLinks) {
              if (!existingUrls.has(link.url)) {
                existing.otherLinks.push(link)
                existingUrls.add(link.url)
              }
            }
            if (isWebDevBoard) {
              existing.status = statusStr
              existing.name = item.name
            }
            if (item.updated_at > (existing.updatedAt || '')) {
              existing.updatedAt = item.updated_at
            }
            existing.boardName = existing.boardName.includes(board.name)
              ? existing.boardName
              : `${existing.boardName} + ${board.name}`
          } else if (isKeyBoard) {
            itemMap.set(item.name, {
              id: item.id,
              name: item.name,
              boardName: board.name,
              status: statusStr,
              stagingUrl,
              adminUrl,
              figmaUrl,
              googleSheetUrl,
              otherLinks,
              updatedAt: item.updated_at || 'Recently'
            })
          }
        })
      })

      const fetched = Array.from(itemMap.values())
      localStorage.setItem('monday_tickets', JSON.stringify(fetched))
      return fetched
    }
    return []
  } catch (err) {
    console.error('[Monday] Fetch error:', err)
    return []
  }
}
