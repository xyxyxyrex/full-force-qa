import { describe, expect, it } from 'vitest'
import type { AuditExportResource } from '../../../shared/auditExport'
import { collectAuditMedia, filterAuditMedia, inlineMediaPreviewUrl } from './auditMediaGallery'

const image = (url: string, source: string, selector?: string): AuditExportResource => ({ url, kind: 'image', source, selector })

describe('captured media gallery', () => {
  it('groups repeated URLs but keeps their distinct capture locations', () => {
    const resources: AuditExportResource[] = [
      image('https://example.com/hero.png', 'img[src]', 'main img'),
      image('https://example.com/hero.png', 'CSS url()', '.hero'),
      image('https://example.com/favicon.ico', 'link[rel="icon"]', 'head link'),
      image('inline-svg:1', 'inline svg', 'main svg'),
      { url: 'https://example.com/demo.mp4', kind: 'video', source: 'video source', selector: 'video' },
      { url: 'https://example.com/song.mp3', kind: 'audio', source: 'audio source', selector: 'audio' },
      { url: 'https://example.com/site.css', kind: 'stylesheet', source: 'stylesheet' }
    ]
    const items = collectAuditMedia(resources)

    expect(items.map(item => item.category)).toEqual(['image', 'icon', 'svg', 'video', 'audio'])
    expect(items[0].usages).toEqual([
      { source: 'img[src]', selector: 'main img', descriptor: undefined },
      { source: 'CSS url()', selector: '.hero', descriptor: undefined }
    ])
    expect(filterAuditMedia(items, 'all', 'CSS url()')).toEqual([items[0]])
    expect(filterAuditMedia(items, 'video', '')).toEqual([items[3]])
    expect(resources).toHaveLength(7)
  })

  it('offers an inert image URL for serialized SVG without treating canvas pixels as available', () => {
    const svg = { ...image('inline-svg:1', 'inline svg'), inlineContent: '<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>', mimeType: 'image/svg+xml' }
    expect(inlineMediaPreviewUrl(svg)).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(inlineMediaPreviewUrl(image('canvas:1', 'canvas pixels are not serialized'))).toBeNull()
  })
})
