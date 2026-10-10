import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import sharp, { type OutputInfo } from 'sharp'
import { CHAT_ID_PATTERN } from './chats'
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, type ChatImage, type ChatImageUpload } from '../../shared/chatImages'
import type { ToolImage } from './toolBasics'

const IMAGE_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
export function createChatImageStore(root: string) {
  const directory = (owner: string, chatId: string) => {
    if (!owner || !CHAT_ID_PATTERN.test(chatId)) throw new Error('Choose a chat before adding images.')
    return join(root, createHash('sha256').update(owner).digest('hex'), chatId)
  }
  const paths = (owner: string, chatId: string, id: string) => {
    if (!IMAGE_ID.test(id)) throw new Error('Invalid image reference.')
    const dir = directory(owner, chatId)
    return { meta: join(dir, `${id}.json`), image: join(dir, `${id}.webp`), original: join(dir, `${id}.source`), thumb: join(dir, `${id}.thumb.webp`) }
  }
  const reference = (owner: string, chatId: string, id: string): ChatImage => {
    try {
      const value = JSON.parse(readFileSync(paths(owner, chatId, id).meta, 'utf8')) as ChatImage
      if (value.id !== id || value.mimeType !== 'image/webp') throw new Error()
      return value
    } catch { throw new Error('This image is unavailable in the current chat or account.') }
  }
  return {
    references(owner: string, chatId: string, ids: unknown): ChatImage[] {
      if (!Array.isArray(ids) || ids.length > MAX_CHAT_IMAGES || ids.some(id => typeof id !== 'string')) throw new Error(`Attach up to ${MAX_CHAT_IMAGES} images per message.`)
      return [...new Set(ids as string[])].map(id => reference(owner, chatId, id))
    },
    async add(owner: string, chatId: string, uploads: ChatImageUpload[], assert: () => void): Promise<ChatImage[]> {
      directory(owner, chatId); assert()
      if (!Array.isArray(uploads) || !uploads.length || uploads.length > MAX_CHAT_IMAGES) throw new Error(`Attach up to ${MAX_CHAT_IMAGES} images per message.`)
      const prepared: Array<{ meta: ChatImage & { originalMime: string }; data: Buffer; original: Buffer; thumb: Buffer }> = []
      for (const upload of uploads) {
        if (!upload || !(upload.bytes instanceof Uint8Array) || !upload.bytes.length || upload.bytes.byteLength > MAX_CHAT_IMAGE_BYTES) throw new Error('Each image must be smaller than 10 MB.')
        const bytes = Buffer.from(upload.bytes)
        // Validate the decoder format, not a supplied filename or MIME type. Never decode SVG.
        const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        const gif = /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
        if (!png && !jpeg && !webp && !gif) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.')
        let encoded: { data: Buffer; info: OutputInfo }
        try {
          encoded = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).webp({ quality: 95 }).toBuffer({ resolveWithObject: true })
        } catch { throw new Error('This image could not be read. Try a smaller PNG or JPEG.') }
        assert()
        const thumb = await sharp(encoded.data).resize({ width: 240, height: 160, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
        assert()
        prepared.push({ data: encoded.data, original: bytes, thumb, meta: { id: randomUUID(), name: String(upload.name || 'Image').replace(/[\x00-\x1f]/g, '').slice(0, 160), mimeType: 'image/webp', width: encoded.info.width, height: encoded.info.height, bytes: encoded.data.length, originalMime: png ? 'image/png' : jpeg ? 'image/jpeg' : gif ? 'image/gif' : 'image/webp' } })
      }
      assert(); mkdirSync(directory(owner, chatId), { recursive: true })
      for (const { meta, data, original, thumb } of prepared) {
        const files = paths(owner, chatId, meta.id)
        writeFileSync(files.image, data)
        writeFileSync(files.original, original)
        writeFileSync(files.thumb, thumb)
        writeFileSync(files.meta + '.tmp', JSON.stringify(meta))
        renameSync(files.meta + '.tmp', files.meta)
      }
      return prepared.map(image => image.meta)
    },
    picture(owner: string, chatId: string, id: string, full = false) {
      const meta = reference(owner, chatId, id) as ChatImage & { originalMime?: string }, files = paths(owner, chatId, id)
      const original = full && existsSync(files.original) && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(meta.originalMime || '')
      const file = original ? files.original : !full && existsSync(files.thumb) ? files.thumb : files.image
      return { src: `data:${original ? meta.originalMime : 'image/webp'};base64,${readFileSync(file).toString('base64')}`, caption: meta.name }
    },
    images(owner: string, chatId: string, ids: string[]): ToolImage[] {
      return ids.map(id => { const meta = reference(owner, chatId, id), file = paths(owner, chatId, id).image; return { data: readFileSync(file), mimeType: 'image/webp', caption: `${meta.name} · attachment ${meta.id}`, file } })
    },
    removeChat(owner: string, chatId: string) { rmSync(directory(owner, chatId), { recursive: true, force: true }) },
  }
}
