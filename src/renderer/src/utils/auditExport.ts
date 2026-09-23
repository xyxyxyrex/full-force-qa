import type {
  AuditCaptureContext,
  AuditExportPayload,
  AuditExportResource,
  AuditLinkRecord,
  AuditResourceKind,
  AuditSeoData,
  AuditTextRecord
} from '../../../shared/auditExport'

const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:$|[?#])/i
const FONT_EXTENSIONS = /\.(?:eot|otf|ttf|woff2?)(?:$|[?#])/i

function resolveUrl(value: string, baseUrl: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('#') || /^(?:mailto|tel|javascript):/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed
  try { return new URL(trimmed, baseUrl).href } catch { return trimmed }
}

function selectorFor(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && parts.length < 8) {
    let part = current.tagName.toLowerCase()
    if (current.id) {
      part += `#${CSS.escape(current.id)}`
      parts.unshift(part)
      break
    }
    const parent: Element | null = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    current = parent
  }
  return parts.join(' > ')
}

function hiddenByCapturedCss(doc: Document): Set<Element> {
  const hidden = new Set<Element>()
  doc.querySelectorAll('style').forEach((style) => {
    const css = style.textContent || ''
    const rule = /([^{}]+)\{([^{}]*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)[^{}]*)\}/gi
    let match: RegExpExecArray | null
    while ((match = rule.exec(css))) {
      const selectorText = match[1].replace(/@[^;{]+;?/g, '').trim()
      for (const selector of selectorText.split(',')) {
        try { doc.querySelectorAll(selector.trim()).forEach((element) => hidden.add(element)) } catch {}
      }
    }
  })
  return hidden
}

function isHidden(element: Element, hiddenElements: Set<Element>): boolean {
  let current: Element | null = element
  while (current) {
    if (hiddenElements.has(current) || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return true
    const style = (current.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '')
    if (style.includes('display:none') || style.includes('visibility:hidden') || style.includes('content-visibility:hidden')) return true
    current = current.parentElement
  }
  return false
}

function classifyCssUrl(url: string, propertyText: string): AuditResourceKind {
  if (/font|@font-face/i.test(propertyText) || FONT_EXTENSIONS.test(url)) return 'font'
  if (IMAGE_EXTENSIONS.test(url) || /background|mask|border-image|list-style|cursor|content/i.test(propertyText)) return 'image'
  return 'other'
}

function parseSrcset(value: string): Array<{ url: string; descriptor?: string }> {
  const result: Array<{ url: string; descriptor?: string }> = []
  let index = 0
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++
    if (index >= value.length) break
    const dataUrl = value.slice(index, index + 5).toLowerCase() === 'data:'
    const start = index
    while (index < value.length && !/\s/.test(value[index]) && (dataUrl || value[index] !== ',')) index++
    const rawUrl = value.slice(start, index)
    const url = rawUrl.replace(/,+$/, '')
    if (dataUrl && rawUrl.endsWith(',')) {
      if (url) result.push({ url })
      continue
    }
    while (index < value.length && /\s/.test(value[index])) index++
    const descriptorStart = index
    while (index < value.length && value[index] !== ',') index++
    const descriptor = value.slice(descriptorStart, index).trim()
    if (url) result.push({ url, descriptor: descriptor || undefined })
    if (index < value.length) index++
  }
  return result
}

function metadataMap(doc: Document, prefix: string): Record<string, string> {
  const result: Record<string, string> = {}
  doc.querySelectorAll(`meta[property^="${prefix}"], meta[name^="${prefix}"]`).forEach((node) => {
    const key = node.getAttribute('property') || node.getAttribute('name') || ''
    const value = node.getAttribute('content') || ''
    if (key && value) result[key] = value
  })
  return result
}

function buildMarkdown(records: AuditTextRecord[]): string {
  const lines: string[] = []
  for (const record of records.filter((item) => item.visible)) {
    const text = record.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (record.headingLevel) lines.push(`${'#'.repeat(record.headingLevel)} ${text}`)
    else if (record.tag === 'li') lines.push(`- ${text}`)
    else lines.push(text)
  }
  return lines.join('\n\n')
}

export function buildAuditExportPayload(
  html: string,
  sourceUrl: string,
  report: unknown,
  captureContext?: AuditCaptureContext | null
): AuditExportPayload {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const hiddenElements = hiddenByCapturedCss(doc)
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href') || sourceUrl
  const resources: AuditExportResource[] = []
  const addResource = (url: string | null | undefined, kind: AuditResourceKind, source: string, element?: Element, descriptor?: string) => {
    if (!url?.trim()) return
    resources.push({ url: resolveUrl(url, baseHref), kind, source, selector: element ? selectorFor(element) : undefined, descriptor })
  }

  doc.querySelectorAll('img').forEach((element) => {
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original']) addResource(element.getAttribute(attr), 'image', `img[${attr}]`, element)
    for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
      parseSrcset(element.getAttribute(attr) || '').forEach((item) => addResource(item.url, 'image', `img[${attr}]`, element, item.descriptor))
    }
  })
  doc.querySelectorAll('picture source, source[type^="image/"]').forEach((element) => {
    for (const attr of ['src', 'srcset', 'data-src', 'data-srcset']) {
      const value = element.getAttribute(attr) || ''
      const candidates = attr.includes('srcset') ? parseSrcset(value) : [{ url: value }]
      candidates.forEach((item) => addResource(item.url, 'image', `source[${attr}]`, element, item.descriptor))
    }
  })
  doc.querySelectorAll('video[poster]').forEach((element) => addResource(element.getAttribute('poster'), 'image', 'video[poster]', element))
  doc.querySelectorAll('link[rel]').forEach((element) => {
    const rel = (element.getAttribute('rel') || '').toLowerCase()
    const href = element.getAttribute('href')
    if (/icon/.test(rel)) addResource(href, 'image', `link[rel="${rel}"]`, element)
    else if (rel.includes('stylesheet')) addResource(href, 'stylesheet', 'link[rel="stylesheet"]', element)
    else if (rel.includes('preload')) {
      const as = (element.getAttribute('as') || '').toLowerCase()
      addResource(href, as === 'font' ? 'font' : as === 'image' ? 'image' : as === 'script' ? 'script' : 'other', `link[rel="${rel}"]`, element)
    }
  })
  doc.querySelectorAll('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]').forEach((element) => {
    addResource(element.getAttribute('content'), 'image', element.getAttribute('property') || element.getAttribute('name') || 'social-image', element)
  })
  doc.querySelectorAll('script[src]').forEach((element) => addResource(element.getAttribute('src'), 'script', 'script[src]', element))
  doc.querySelectorAll('video, video source').forEach((element) => {
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original']) addResource(element.getAttribute(attr), 'video', `${element.tagName.toLowerCase()}[${attr}]`, element)
  })
  doc.querySelectorAll('audio, audio source').forEach((element) => {
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original']) addResource(element.getAttribute(attr), 'audio', `${element.tagName.toLowerCase()}[${attr}]`, element)
  })
  doc.querySelectorAll('object[data], embed[src]').forEach((element) => addResource(element.getAttribute('data') || element.getAttribute('src'), 'other', element.tagName.toLowerCase(), element))

  doc.querySelectorAll('svg').forEach((element, index) => {
    const content = new XMLSerializer().serializeToString(element)
    resources.push({
      url: `inline-svg:${index + 1}`,
      kind: 'image',
      source: 'inline svg',
      selector: selectorFor(element),
      inlineContent: content,
      mimeType: 'image/svg+xml'
    })
  })
  doc.querySelectorAll('canvas').forEach((element, index) => {
    resources.push({
      url: `canvas:${index + 1}`,
      kind: 'image',
      source: 'canvas pixels are not serialized in captured HTML',
      selector: selectorFor(element)
    })
  })

  doc.querySelectorAll('style, [style]').forEach((element) => {
    const css = element.tagName === 'STYLE' ? element.textContent || '' : element.getAttribute('style') || ''
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(css))) {
      if (!match[2] || match[2].startsWith('#')) continue
      addResource(match[2], classifyCssUrl(match[2], css.slice(Math.max(0, match.index - 80), match.index + match[0].length)), 'CSS url()', element)
    }
    const imageSet = /(?:-webkit-)?image-set\(([^)]*)\)/gi
    while ((match = imageSet.exec(css))) {
      const quoted = /(['"])(.*?)\1\s*(?:\d+(?:\.\d+)?x|\d+w)?/gi
      let candidate: RegExpExecArray | null
      while ((candidate = quoted.exec(match[1]))) addResource(candidate[2], 'image', 'CSS image-set()', element)
    }
  })

  for (const resource of captureContext?.resources || []) {
    resources.push({ url: resolveUrl(resource.url, baseHref), kind: resource.kind, source: resource.source })
  }

  const text: AuditTextRecord[] = []
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    const value = (node.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (!parent || !value || SKIP_TEXT_TAGS.has(parent.tagName) || parent.closest('[data-parity-owned], .parity-overlay-root')) continue
    const headingMatch = parent.tagName.match(/^H([1-6])$/)
    text.push({
      text: value,
      visible: !isHidden(parent, hiddenElements),
      tag: parent.tagName.toLowerCase(),
      headingLevel: headingMatch ? Number(headingMatch[1]) : undefined,
      selector: selectorFor(parent),
      linkUrl: parent.closest('a[href]') ? resolveUrl(parent.closest('a[href]')!.getAttribute('href') || '', baseHref) : undefined
    })
  }

  const links: AuditLinkRecord[] = Array.from(doc.querySelectorAll('a[href]')).map((element) => {
    const originalUrl = element.getAttribute('href') || ''
    const resolvedUrl = resolveUrl(originalUrl, baseHref)
    let external = false
    try { external = new URL(resolvedUrl).origin !== new URL(sourceUrl).origin } catch {}
    return {
      originalUrl,
      resolvedUrl,
      anchorText: (element.textContent || '').replace(/\s+/g, ' ').trim(),
      selector: selectorFor(element),
      rel: element.getAttribute('rel') || '',
      target: element.getAttribute('target') || '',
      external
    }
  })

  const structuredData: unknown[] = [...(captureContext?.structuredData || [])]
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((element) => {
    try { structuredData.push(JSON.parse(element.textContent || 'null')) } catch { structuredData.push(element.textContent || '') }
  })
  doc.querySelectorAll('[itemscope]').forEach((element) => {
    const properties: Record<string, string | string[]> = {}
    element.querySelectorAll('[itemprop]').forEach((property) => {
      const name = property.getAttribute('itemprop') || ''
      if (!name) return
      const value = property.getAttribute('content') || property.getAttribute('href') || property.getAttribute('src') || (property.textContent || '').trim()
      const existing = properties[name]
      properties[name] = existing == null ? value : Array.isArray(existing) ? [...existing, value] : [existing, value]
    })
    structuredData.push({ format: 'microdata', type: element.getAttribute('itemtype') || '', id: element.getAttribute('itemid') || '', properties })
  })
  doc.querySelectorAll('[typeof]').forEach((element) => {
    const properties: Record<string, string> = {}
    element.querySelectorAll('[property]').forEach((property) => {
      const name = property.getAttribute('property') || ''
      if (name) properties[name] = property.getAttribute('content') || property.getAttribute('href') || (property.textContent || '').trim()
    })
    structuredData.push({ format: 'rdfa', type: element.getAttribute('typeof') || '', about: element.getAttribute('about') || '', properties })
  })
  const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((element) => ({
    level: Number(element.tagName.slice(1)),
    text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
    selector: selectorFor(element)
  }))
  const seo: AuditSeoData = {
    title: doc.title || '',
    description: doc.querySelector('meta[name="description"]')?.getAttribute('content') || '',
    canonical: resolveUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '', baseHref),
    robots: doc.querySelector('meta[name="robots"]')?.getAttribute('content') || '',
    meta: Object.fromEntries(
      Array.from(doc.querySelectorAll('meta[name], meta[property]'))
        .map((element) => [element.getAttribute('name') || element.getAttribute('property') || '', element.getAttribute('content') || ''])
        .filter(([key]) => key)
    ),
    headings,
    hreflang: Array.from(doc.querySelectorAll('link[rel="alternate"][hreflang]')).map((element) => ({
      language: element.getAttribute('hreflang') || '',
      url: resolveUrl(element.getAttribute('href') || '', baseHref)
    })),
    openGraph: metadataMap(doc, 'og:'),
    twitter: metadataMap(doc, 'twitter:'),
    structuredData
  }

  const visibleText = text.filter((item) => item.visible).map((item) => item.text).join('\n')
  return { html, sourceUrl, report, captureContext, resources, text, visibleText, markdown: buildMarkdown(text), links, seo }
}
