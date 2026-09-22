import { describe, expect, it } from 'vitest'
import { buildAuditCaptureContext } from './auditCaptureContext'

describe('audit capture context', () => {
  it('preserves resources and structured data before snapshot scripts are stripped', () => {
    const context = buildAuditCaptureContext(`
      <html><head>
        <link rel="stylesheet" href="/theme.css">
        <script src="/app.js"></script>
        <script type="application/ld+json">{"@type":"WebPage","name":"Audit me"}</script>
        <style>.hero { background-image: url('/hero.webp') }</style>
      </head><body><img src="images/photo.jpg"><img src="images/photo.jpg"></body></html>
    `, 'https://example.com/path/page', 123)

    expect(context.capturedAt).toBe(123)
    expect(context.complete).toBe(true)
    expect(context.structuredData).toEqual([{ '@type': 'WebPage', name: 'Audit me' }])
    expect(context.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://example.com/app.js', kind: 'script' }),
      expect.objectContaining({ url: 'https://example.com/theme.css', kind: 'stylesheet' }),
      expect.objectContaining({ url: 'https://example.com/path/images/photo.jpg', kind: 'image' }),
      expect.objectContaining({ url: 'https://example.com/hero.webp', kind: 'image' })
    ]))
    expect(context.resources.filter((item) => item.url.endsWith('/photo.jpg'))).toHaveLength(1)
  })

  it('does not duplicate large data URLs in the persisted sidecar', () => {
    const context = buildAuditCaptureContext('<img src="data:image/png;base64,AAAA">', 'https://example.com/')
    expect(context.resources).toEqual([])
  })
})
