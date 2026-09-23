import type { AuditExportResource } from '../../../shared/auditExport'

export type AuditMediaCategory = 'image' | 'svg' | 'icon' | 'video' | 'audio'
export type AuditMediaFilter = 'all' | AuditMediaCategory

export interface AuditMediaItem {
  id: string
  resource: AuditExportResource
  category: AuditMediaCategory
  name: string
  usages: Array<{ source: string; selector?: string; descriptor?: string }>
}

export function mediaCategory(resource: AuditExportResource): AuditMediaCategory | null {
  if (resource.kind === 'video' || resource.kind === 'audio') return resource.kind
  if (resource.kind !== 'image') return null
  if (/icon|favicon/i.test(resource.source) || /(?:^|\/)favicon\b|\.ico(?:$|[?#])/i.test(resource.url)) return 'icon'
  if (resource.mimeType?.startsWith('image/svg') || resource.inlineContent != null || resource.url.startsWith('inline-svg:') || /\.svg(?:$|[?#])/i.test(resource.url)) return 'svg'
  return 'image'
}

export function mediaName(resource: AuditExportResource, category: AuditMediaCategory): string {
  if (resource.url.startsWith('inline-svg:')) return `Inline SVG ${resource.url.split(':')[1] || ''}`.trim()
  if (resource.url.startsWith('canvas:')) return `Canvas ${resource.url.split(':')[1] || ''}`.trim()
  if (resource.url.startsWith('data:')) return `Embedded ${category}`
  try {
    const pathname = new URL(resource.url).pathname
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || `${category} asset`)
  } catch { return resource.url.slice(0, 80) || `${category} asset` }
}

export function collectAuditMedia(resources: AuditExportResource[]): AuditMediaItem[] {
  const seen = new Map<string, AuditMediaItem>()
  for (const resource of resources) {
    const category = mediaCategory(resource)
    if (!category) continue
    const key = resource.inlineContent != null ? `inline:${resource.inlineContent}` : resource.url
    if (!key) continue
    const usage = { source: resource.source, selector: resource.selector, descriptor: resource.descriptor }
    const existing = seen.get(key)
    if (existing) {
      if (!existing.usages.some(item => item.source === usage.source && item.selector === usage.selector && item.descriptor === usage.descriptor)) existing.usages.push(usage)
      continue
    }
    seen.set(key, {
      id: `media-${seen.size + 1}`,
      resource,
      category,
      name: mediaName(resource, category),
      usages: [usage]
    })
  }
  return [...seen.values()]
}

export function filterAuditMedia(items: AuditMediaItem[], filter: AuditMediaFilter, query: string): AuditMediaItem[] {
  const normalized = query.trim().toLowerCase()
  return items.filter(item => {
    if (filter !== 'all' && item.category !== filter) return false
    if (!normalized) return true
    return [item.name, item.resource.url, item.category, ...item.usages.flatMap(usage => [usage.source, usage.selector || '', usage.descriptor || ''])]
      .some(value => value.toLowerCase().includes(normalized))
  })
}

export function inlineMediaPreviewUrl(resource: AuditExportResource): string | null {
  if (resource.inlineContent != null && resource.mimeType === 'image/svg+xml') return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(resource.inlineContent)}`
  if (resource.url.startsWith('data:')) return resource.url
  if (/^https?:\/\//i.test(resource.url)) return resource.url
  return null
}
