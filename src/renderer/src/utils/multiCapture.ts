import { normalizeWorkspaceUrl } from './workspaceUrl'

export interface ParsedMultiCaptureUrl {
  value: string
  error?: string
}

export interface MultiCaptureDuplicateInput {
  url: string
  folderId?: string
  inTrash?: boolean
}

const URL_START = /^(?:https?:\/\/|www\.|localhost(?::\d+)?(?=[\s/,]|$)|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?=[\s/,]|$)|[\p{L}\d](?:[\p{L}\d-]*[\p{L}\d])?(?:\.[\p{L}\d](?:[\p{L}\d-]*[\p{L}\d])?)+(?=[:/?#,\s]|$))/iu

function beginsUrl(value: string): boolean {
  return URL_START.test(value.trimStart())
}

function splitConcatenatedUrl(value: string): ParsedMultiCaptureUrl[] {
  const positions: number[] = []
  const matcher = /https?:\/\//gi
  let match: RegExpExecArray | null
  while ((match = matcher.exec(value))) positions.push(match.index)
  if (positions.length <= 1 || positions[0] !== 0) return [{ value }]

  const firstBoundary = positions[1]
  const first = value.slice(0, firstBoundary)
  try {
    const parsed = new URL(first)
    if (parsed.search || parsed.hash || parsed.pathname !== '/') {
      return [{ value, error: 'This may contain two joined URLs. Add a space or line break between them.' }]
    }
  } catch {
    return [{ value }]
  }

  const pieces = positions.map((position, index) => value.slice(position, positions[index + 1] ?? value.length))
  if (pieces.every(piece => normalizeWorkspaceUrl(piece))) return pieces.map(piece => ({ value: piece }))
  return [{ value, error: 'This may contain two joined URLs. Add a space or line break between them.' }]
}

/** Parse bulk input without altering URL punctuation or encoded characters. */
export function parseMultiCaptureInput(input: string): ParsedMultiCaptureUrl[] {
  const tokens: Array<{ value: string; quoted: boolean }> = []
  let buffer = ''
  let quoted = false
  let tokenWasQuoted = false

  const flush = () => {
    const value = buffer.trim()
    if (value) tokens.push({ value, quoted: tokenWasQuoted })
    buffer = ''
    tokenWasQuoted = false
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        buffer += '"'
        index += 1
      } else {
        quoted = !quoted
        tokenWasQuoted = true
      }
      continue
    }
    if (!quoted && /\s/.test(character)) {
      flush()
      continue
    }
    if (!quoted && character === ',') {
      const remainder = input.slice(index + 1)
      if (tokenWasQuoted || beginsUrl(remainder)) {
        flush()
        continue
      }
    }
    buffer += character
  }
  flush()

  return tokens.flatMap(token => token.quoted ? [{ value: token.value }] : splitConcatenatedUrl(token.value))
}

export function normalizeMultiCaptureUrl(value: string): { url: string | null; error?: string } {
  const trimmed = value.trim()
  if (!trimmed) return { url: null }
  const joined = splitConcatenatedUrl(trimmed)
  if (joined.length > 1 || joined[0]?.error) {
    return { url: null, error: joined[0]?.error || 'This contains multiple URLs. Paste it again to create separate rows.' }
  }
  const url = normalizeWorkspaceUrl(trimmed)
  return url ? { url } : { url: null, error: 'Enter a valid HTTP or HTTPS website address.' }
}

export function deriveMultiCaptureName(rawUrl: string): string {
  const normalized = normalizeWorkspaceUrl(rawUrl)
  if (!normalized) return 'Untitled Project'
  const url = new URL(normalized)
  const path = decodeURIComponent(url.pathname).split('/').filter(Boolean).pop()
  if (path) {
    const readable = path.replace(/\.[a-z\d]+$/i, '').replace(/[-_]+/g, ' ').trim()
    if (readable) return readable.replace(/\b\w/g, letter => letter.toUpperCase()).slice(0, 100)
  }
  return url.hostname.replace(/^www\./, '')
}

export function normalizedMultiCaptureKey(value: string): string | null {
  return normalizeWorkspaceUrl(value)
}

export function findMultiCaptureDuplicate(
  url: string,
  rowIndex: number,
  rowUrls: string[],
  existing: MultiCaptureDuplicateInput[],
  folderId?: string,
): 'batch' | 'folder' | null {
  const key = normalizedMultiCaptureKey(url)
  if (!key) return null
  if (rowUrls.slice(0, rowIndex).some(candidate => normalizedMultiCaptureKey(candidate) === key)) return 'batch'
  if (existing.some(project => !project.inTrash && (project.folderId || undefined) === folderId && normalizedMultiCaptureKey(project.url) === key)) return 'folder'
  return null
}

export async function runMultiCaptureQueue<T>(
  items: T[],
  task: (item: T) => Promise<void>,
  shouldStop: () => boolean,
  concurrency = 3,
): Promise<number> {
  let cursor = 0
  let started = 0
  const worker = async () => {
    while (!shouldStop()) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      started += 1
      await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker))
  return started
}
