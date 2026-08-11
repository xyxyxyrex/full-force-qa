import { app, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve } from 'path'
import sharp from 'sharp'
import type { NoteAttachment } from '../shared/types'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const SAFE_FILE_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/zip',
  'text/csv',
  'text/markdown',
  'text/plain',
])

const SAFE_FILE_EXTENSIONS: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/zip': '.zip',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt',
}

function ownerDirectoryName(ownerKey: string): string {
  return createHash('sha256').update(ownerKey).digest('hex').slice(0, 24)
}

function attachmentsRoot(): string {
  return join(app.getPath('userData'), 'notes', 'attachments')
}

function ownerDirectory(ownerKey: string): string {
  return join(attachmentsRoot(), ownerDirectoryName(ownerKey))
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:([^;,]+);base64,([a-z\d+/=\s]+)$/i.exec(dataUrl)
  if (!match) throw new Error('The selected attachment could not be read.')
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachments must be between 1 byte and 25 MB.')
  return { mimeType: match[1].toLowerCase(), bytes }
}

export async function saveLocalNoteAttachment(
  ownerKey: string,
  input: { dataUrl: string; name: string },
): Promise<NoteAttachment> {
  if (!/^monday:[0-9]+$/.test(ownerKey)) throw new Error('Connect Monday.com before attaching files.')
  const { mimeType, bytes } = decodeDataUrl(input.dataUrl)
  const id = randomUUID()
  const directory = ownerDirectory(ownerKey)
  mkdirSync(directory, { recursive: true })

  let output = bytes
  let storedMimeType = mimeType
  let extension = '.bin'
  let kind: NoteAttachment['kind'] = 'file'

  if (mimeType.startsWith('image/')) {
    output = await sharp(bytes, { limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer()
    storedMimeType = 'image/webp'
    extension = '.webp'
    kind = 'image'
  } else if (!SAFE_FILE_MIME_TYPES.has(mimeType)) {
    throw new Error('This file type is not supported. Attach a document, spreadsheet, archive, PDF, or text file.')
  } else {
    extension = SAFE_FILE_EXTENSIONS[mimeType]
  }

  const fileName = `${id}${extension}`
  const filePath = join(directory, fileName)
  writeFileSync(filePath, output)
  return {
    id,
    name: String(input.name || 'Attachment').slice(0, 240),
    mimeType: storedMimeType,
    sizeBytes: output.length,
    uri: `parity-note://attachment/${ownerDirectoryName(ownerKey)}/${fileName}`,
    kind,
  }
}

function resolveAttachmentUri(uri: string): string | null {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== 'parity-note:' || parsed.hostname !== 'attachment') return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || !/^[a-f0-9]{24}$/.test(parts[0]) || !/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/.test(parts[1])) return null
    const root = resolve(attachmentsRoot())
    const target = resolve(root, parts[0], parts[1])
    const relativePath = relative(root, target)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null
    return target
  } catch {
    return null
  }
}

export function loadLocalNoteAttachment(uri: string): { bytes: Buffer; mimeType: string } | null {
  const filePath = resolveAttachmentUri(uri)
  if (!filePath || !existsSync(filePath)) return null
  const extension = extname(filePath).toLowerCase()
  const mimeType = extension === '.webp' ? 'image/webp'
    : extension === '.png' ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.pdf' ? 'application/pdf'
          : extension === '.txt' || extension === '.md' ? 'text/plain'
            : 'application/octet-stream'
  return { bytes: readFileSync(filePath), mimeType }
}

export async function openLocalNoteAttachment(uri: string): Promise<void> {
  const filePath = resolveAttachmentUri(uri)
  if (!filePath || !existsSync(filePath)) throw new Error('This attachment is not available on this device.')
  const error = await shell.openPath(filePath)
  if (error) throw new Error(error)
}

export function deleteLocalNoteAttachments(ownerKey: string, attachmentIds: string[]): void {
  const directory = ownerDirectory(ownerKey)
  if (!existsSync(directory)) return
  for (const id of attachmentIds) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) continue
    for (const extension of ['.webp', '.pdf', '.txt', '.md', '.csv', '.json', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.bin']) {
      const target = join(directory, `${id}${extension}`)
      if (existsSync(target)) rmSync(target, { force: true })
    }
  }
}
