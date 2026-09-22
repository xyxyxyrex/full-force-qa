import type { AuditCaptureContext, AuditCaptureResource, AuditResourceKind } from '../shared/auditExport'

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
}

export function resolveResourceUrl(value: string, sourceUrl: string): string {
  const decoded = decodeHtmlAttribute(value.trim())
  if (!decoded || decoded.startsWith('data:') || decoded.startsWith('blob:')) return decoded
  try { return new URL(decoded, sourceUrl).href } catch { return decoded }
}

export function kindFromUrl(url: string, fallback: AuditResourceKind = 'other'): AuditResourceKind {
  const path = url.split(/[?#]/)[0].toLowerCase()
  if (/\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/.test(path)) return 'image'
  if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return 'font'
  if (/\.css$/.test(path)) return 'stylesheet'
  if (/\.(m?js|cjs)$/.test(path)) return 'script'
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return 'video'
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path)) return 'audio'
  return fallback
}

function collectAttributeResources(html: string, sourceUrl: string): AuditCaptureResource[] {
  const resources: AuditCaptureResource[] = []
  const add = (url: string, kind: AuditResourceKind, source: string) => {
    const resolved = resolveResourceUrl(url, sourceUrl)
    if (resolved && !resolved.startsWith('data:')) resources.push({ url: resolved, kind: kindFromUrl(resolved, kind), source })
  }
  const patterns: Array<{ re: RegExp; kind: AuditResourceKind; source: string }> = [
    { re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, kind: 'script', source: 'script[src] before freeze' },
    { re: /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, kind: 'stylesheet', source: 'link[rel=stylesheet] before freeze' },
    { re: /<(?:img|source)\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi, kind: 'image', source: 'image source before freeze' },
    { re: /<(?:video|audio|source|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, kind: 'other', source: 'media source before freeze' }
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.re.exec(html))) add(match[1], pattern.kind, pattern.source)
  }
  const cssUrl = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = cssUrl.exec(html))) if (match[2] && !match[2].startsWith('#')) add(match[2], kindFromUrl(match[2]), 'CSS url() before freeze')
  return resources
}

export function buildAuditCaptureContext(rawHtml: string, sourceUrl: string, capturedAt = Date.now()): AuditCaptureContext {
  const structuredData: unknown[] = []
  const jsonLd = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi
  let match: RegExpExecArray | null
  while ((match = jsonLd.exec(rawHtml))) {
    const value = match[1].trim()
    if (!value) continue
    try { structuredData.push(JSON.parse(value)) } catch { structuredData.push(value) }
  }
  const seen = new Set<string>()
  return {
    version: 1,
    capturedAt,
    sourceUrl,
    resources: collectAttributeResources(rawHtml, sourceUrl).filter((resource) => {
      const key = `${resource.kind}\u0000${resource.url}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    structuredData,
    complete: true
  }
}
