import { mkdtempSync, existsSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDesignStore, MAX_DESIGN_BYTES } from './designStore'

const png = (width: number, height: number, color = '#336699') =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()

let root: string
let store: ReturnType<typeof createDesignStore>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'parity-designs-'))
  store = createDesignStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('designStore.put', () => {
  it('auto-assigns by detected width and records the scale', async () => {
    const result = await store.put('proj-1', await png(2880, 400), { fileName: 'home.png' })
    expect(result).toMatchObject({ success: true, assigned: 'desktop', unchanged: false })
    expect(store.list('proj-1').desktop).toMatchObject({ pixelWidth: 2880, scale: 2, frameWidth: 1440, frameHeight: 200, detection: 'dimensions' })
    const mobile = await store.put('proj-1', await png(780, 300, '#aa0000'), { fileName: 'home-m.png' })
    expect(mobile).toMatchObject({ success: true, assigned: 'mobile' })
    expect(store.list('proj-1').mobile).toMatchObject({ scale: 2, frameWidth: 390 })
  })

  it('honours an explicit slot and uses it to resolve ambiguous widths', async () => {
    const result = await store.put('proj-1', await png(1536, 300), { target: 'tablet' })
    expect(result).toMatchObject({ success: true, assigned: 'tablet' })
    expect(store.list('proj-1').tablet).toMatchObject({ scale: 2, frameWidth: 768, detection: 'slot' })
  })

  it('is idempotent for identical bytes and replaces a different image in the same slot', async () => {
    const bytes = await png(1440, 300)
    await store.put('proj-1', bytes)
    expect(await store.put('proj-1', bytes)).toMatchObject({ success: true, unchanged: true, assigned: 'desktop' })
    const replaced = await store.put('proj-1', await png(1440, 320, '#ffffff'))
    expect(replaced).toMatchObject({ success: true, unchanged: false, assigned: 'desktop' })
    expect(store.list('proj-1').desktop?.pixelHeight).toBe(320)
  })

  it('rejects non-images and oversized input without writing anything', async () => {
    expect(await store.put('proj-1', Buffer.from('not an image at all'))).toMatchObject({ success: false })
    expect(await store.put('proj-1', Buffer.alloc(MAX_DESIGN_BYTES + 1))).toMatchObject({ success: false })
    expect(await store.put('', await png(100, 100))).toMatchObject({ success: false })
    expect(store.list('proj-1')).toEqual({})
    expect(readdirSync(root)).toEqual([])
  })

  it('keeps projects separate', async () => {
    await store.put('proj-a', await png(1440, 200))
    expect(store.list('proj-b')).toEqual({})
  })

  it('converts non-PNG input to PNG', async () => {
    const jpeg = await sharp({ create: { width: 1440, height: 200, channels: 3, background: '#112233' } }).jpeg().toBuffer()
    await store.put('proj-1', jpeg)
    const original = store.readOriginal('proj-1', 'desktop')!
    expect((await sharp(original).metadata()).format).toBe('png')
  })
})

describe('designStore.update', () => {
  it('overrides the scale and rebuilds the normalized copy', async () => {
    await store.put('proj-1', await png(2000, 500), { target: 'desktop' })
    expect(store.list('proj-1').desktop?.scale).toBe(1)
    expect(store.update('proj-1', 'desktop', { scale: 2 })).toMatchObject({ success: true })
    expect(store.list('proj-1').desktop).toMatchObject({ scale: 2, frameWidth: 1000, frameHeight: 250, detection: 'manual' })
    const normalized = await store.normalizedPath('proj-1', 'desktop')
    expect(normalized).toContain('desktop@1x.png')
    expect((await sharp(normalized!).metadata()).width).toBe(1000)
    expect(store.update('proj-1', 'desktop', { scale: 7 })).toMatchObject({ success: false })
  })

  it('moves into an empty slot and swaps with an occupied one', async () => {
    await store.put('proj-1', await png(1440, 200, '#ff0000'))
    expect(store.update('proj-1', 'desktop', { moveTo: 'tablet' })).toMatchObject({ success: true })
    expect(Object.keys(store.list('proj-1'))).toEqual(['tablet'])
    expect(store.list('proj-1').tablet?.breakpoint).toBe('tablet')

    await store.put('proj-1', await png(390, 200, '#00ff00'))
    const before = { tablet: store.list('proj-1').tablet!.sha256, mobile: store.list('proj-1').mobile!.sha256 }
    expect(store.update('proj-1', 'tablet', { moveTo: 'mobile' })).toMatchObject({ success: true })
    const after = store.list('proj-1')
    expect(after.mobile).toMatchObject({ sha256: before.tablet, breakpoint: 'mobile' })
    expect(after.tablet).toMatchObject({ sha256: before.mobile, breakpoint: 'tablet' })
  })

  it('reports a missing slot', () => {
    expect(store.update('proj-1', 'mobile', { scale: 2 })).toMatchObject({ success: false })
  })
})

describe('designStore.remove', () => {
  it('removes a slot and cleans up the project folder when empty', async () => {
    await store.put('proj-1', await png(1440, 200))
    await store.put('proj-1', await png(390, 200, '#00ff00'))
    expect(Object.keys(store.remove('proj-1', 'desktop'))).toEqual(['mobile'])
    expect(readdirSync(root)).toHaveLength(1)
    store.remove('proj-1', 'mobile')
    expect(readdirSync(root)).toHaveLength(0)
  })

  it('removeProject deletes everything for that project only', async () => {
    await store.put('proj-1', await png(1440, 200))
    await store.put('proj-2', await png(1440, 200))
    store.removeProject('proj-1')
    expect(store.list('proj-1')).toEqual({})
    expect(Object.keys(store.list('proj-2'))).toEqual(['desktop'])
  })
})

describe('designStore misc', () => {
  it('lists thumbnails as small JPEG data URLs', async () => {
    await store.put('proj-1', await png(1440, 900))
    const result = await store.listWithThumbnails('proj-1')
    expect(result.thumbnails.desktop).toMatch(/^data:image\/jpeg;base64,/)
    expect(result.slots.desktop?.frameWidth).toBe(1440)
  })

  it('returns the original path as the normalized copy at 1x', async () => {
    await store.put('proj-1', await png(1440, 200))
    const path = await store.normalizedPath('proj-1', 'desktop')
    expect(path && existsSync(path)).toBe(true)
    expect(path).not.toContain('@1x')
    expect(await store.normalizedPath('proj-1', 'tablet')).toBeNull()
  })

  it('neutralizes unsafe project keys in folder names', async () => {
    await store.put('../../etc/passwd', await png(1440, 100))
    const [dir] = readdirSync(root)
    expect(dir).not.toContain('..')
    expect(dir).not.toContain('/')
  })
})

describe('designs per page', () => {
  const about = 'proj-1#/about'
  const contact = 'proj-1#/contact'

  it('keeps each page\'s designs apart', async () => {
    await store.put(about, await png(1440, 300), { fileName: 'about.png', pagePath: '/about' })
    await store.put(contact, await png(1440, 300, '#aa0000'), { fileName: 'contact.png', pagePath: '/contact' })
    expect(store.list(about).desktop?.fileName).toBe('about.png')
    expect(store.list(contact).desktop?.fileName).toBe('contact.png')
    // Replacing one page's design leaves the other alone.
    await store.put(about, await png(1440, 320, '#00aa00'), { fileName: 'about-v2.png', pagePath: '/about' })
    expect(store.list(about).desktop?.fileName).toBe('about-v2.png')
    expect(store.list(contact).desktop?.fileName).toBe('contact.png')
    expect(store.list('proj-1#/pricing')).toEqual({})
  })

  it('removes every page of a project, and no other project', async () => {
    await store.put(about, await png(1440, 300), {})
    await store.put(contact, await png(1440, 300, '#aa0000'), {})
    await store.put('proj-1', await png(1440, 300, '#00aa00'), {})
    await store.put('proj-2#/about', await png(1440, 300, '#0000aa'), {})
    store.removeProject('proj-1')
    expect(store.list(about)).toEqual({})
    expect(store.list(contact)).toEqual({})
    expect(store.list('proj-1')).toEqual({})
    expect(store.list('proj-2#/about').desktop).toBeDefined()
  })

  describe('designs saved before pages had their own set', () => {
    it('move to the page they were added for, once', async () => {
      await store.put('proj-1', await png(1440, 300), { fileName: 'old.png', pagePath: '/about/' })
      expect(store.list(contact)).toEqual({}) // another page does not get them
      expect(store.list('proj-1').desktop?.fileName).toBe('old.png')
      expect(store.list(about).desktop?.fileName).toBe('old.png') // trailing slash does not matter
      expect(store.list('proj-1')).toEqual({}) // moved, not copied
      expect(store.list(contact)).toEqual({})
      expect((await store.normalizedPath(about, 'desktop'))).toBeTruthy()
    })

    it('stay put unless every one of them is known to be for that page', async () => {
      await store.put('proj-1', await png(1440, 300), { fileName: 'untagged.png' })
      expect(store.list(about)).toEqual({})
      expect(store.list('proj-1').desktop).toBeDefined()
      // One tagged for this page next to one of unknown origin: leave both.
      await store.put('proj-1', await png(780, 300, '#aa0000'), { fileName: 'm.png', pagePath: '/about' })
      expect(store.list(about).mobile).toBeUndefined()
      // Tagged for two different pages: leave them too.
      await store.put('proj-1', await png(1440, 300, '#00aa00'), { fileName: 'd.png', pagePath: '/contact' })
      expect(store.list(about)).toEqual({})
      expect(store.list(contact)).toEqual({})
    })

    it('never overwrite designs the page already has', async () => {
      await store.put(about, await png(1440, 300), { fileName: 'new.png', pagePath: '/about' })
      await store.put('proj-1', await png(1440, 300, '#aa0000'), { fileName: 'old.png', pagePath: '/about' })
      expect(store.list(about).desktop?.fileName).toBe('new.png')
      expect(store.list('proj-1').desktop?.fileName).toBe('old.png')
    })
  })
})
