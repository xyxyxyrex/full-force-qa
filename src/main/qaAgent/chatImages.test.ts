import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createChatImageStore } from './chatImages'
import { MAX_CHAT_IMAGE_BYTES } from '../../shared/chatImages'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'parity-chat-images-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const png = () => sharp({ create: { width: 40, height: 20, channels: 4, background: '#bbaaff' } }).png().toBuffer()
it('stores safe raster previews and retains images after reopening the chat', async () => {
  const store = createChatImageStore(root)
  const [image] = await store.add('account-A', 'chat-images', [{ name: 'Screenshot.png', bytes: await png() }], () => {})
  expect(image).toMatchObject({ name: 'Screenshot.png', mimeType: 'image/webp', width: 40, height: 20 })
  const reopened = createChatImageStore(root)
  expect(reopened.references('account-A', 'chat-images', [image.id])).toEqual([image])
  expect(reopened.picture('account-A', 'chat-images', image.id).src).toMatch(/^data:image\/webp;base64,/)
  expect(reopened.picture('account-A', 'chat-images', image.id, true).src).toMatch(/^data:image\/png;base64,/)
  expect((await sharp(reopened.images('account-A', 'chat-images', [image.id])[0].data).metadata()).format).toBe('webp')
  expect(() => reopened.references('account-B', 'chat-images', [image.id])).toThrow('unavailable')
  expect(() => reopened.references('account-A', 'other-chat', [image.id])).toThrow('unavailable')
  expect(() => reopened.picture('account-A', 'chat-images', '../secret')).toThrow('unavailable')
})
it('rejects SVG, disguised files, oversized batches and oversized images', async () => {
  const store = createChatImageStore(root)
  await expect(store.add('A', 'chat-images', [{ name: 'fake.png', bytes: Buffer.from('<svg><image href="file:///secret"/></svg>') }], () => {})).rejects.toThrow('PNG')
  await expect(store.add('A', 'chat-images', Array(5).fill({ name: 'x.png', bytes: Buffer.from('x') }), () => {})).rejects.toThrow('4 images')
  await expect(store.add('A', 'chat-images', [{ name: 'large.png', bytes: new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1) }], () => {})).rejects.toThrow('10 MB')
})
it('rejects late writes after an account switch and deletes only the selected owner’s chat assets', async () => {
  const store = createChatImageStore(root), data = await png()
  let checks = 0
  await expect(store.add('old-owner', 'chat-images', [{ name: 'x.png', bytes: data }], () => { if (++checks > 1) throw new Error('Account changed') })).rejects.toThrow('Account changed')
  expect(readdirSync(root)).toEqual([])
  const [a] = await store.add('A', 'chat-images', [{ name: 'a.png', bytes: data }], () => {})
  const [b] = await store.add('B', 'chat-images', [{ name: 'b.png', bytes: data }], () => {})
  store.removeChat('A', 'chat-images')
  expect(() => store.picture('A', 'chat-images', a.id)).toThrow('unavailable')
  expect(store.picture('B', 'chat-images', b.id).caption).toBe('b.png')
})
