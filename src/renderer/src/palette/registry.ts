import { useEffect, useRef } from 'react'

export type PaletteGroup = 'Commands' | 'Page' | 'Files' | 'Projects' | 'Folders' | 'Tickets' | 'Notes' | 'Annotations' | 'Tabs'
export interface PaletteItem {
  id: string
  title: string
  description?: string
  keywords?: string
  group: PaletteGroup
  shortcut?: string
  disabled?: string
  run: () => void | Promise<void>
}
export interface PaletteBatch { items: PaletteItem[]; total?: number; warning?: string }
export interface PaletteSearchOptions { limit: number; group: PaletteGroup | 'All' }
export interface PaletteProvider {
  id: string
  label: string
  commands?: () => PaletteItem[]
  search?: (query: string, signal: AbortSignal, options: PaletteSearchOptions) => Promise<PaletteBatch>
  release?: () => void
}

const providers = new Map<string, () => PaletteProvider>()
export function registerPaletteProvider(id: string, getter: () => PaletteProvider): () => void {
  providers.set(id, getter)
  return () => { if (providers.get(id) === getter) providers.delete(id) }
}
export function paletteProviders(): PaletteProvider[] { return [...providers.values()].map(getter => getter()) }
export function usePaletteProvider(provider: PaletteProvider): void {
  const latest = useRef(provider)
  latest.current = provider
  useEffect(() => registerPaletteProvider(provider.id, () => latest.current), [provider.id])
}

export const normalizeSearch = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
export function searchTerms(query: string): string[] {
  return (query.match(/"[^"]+"|\S+/g) || []).map(term => normalizeSearch(term.replace(/^"|"$/g, ''))).filter(Boolean)
}
const searchableText = new WeakMap<PaletteItem, { title: string; haystack: string }>()
function indexedText(item: PaletteItem) {
  let entry = searchableText.get(item)
  if (!entry) {
    entry = { title: normalizeSearch(item.title), haystack: normalizeSearch(`${item.title} ${item.description || ''} ${item.keywords || ''} ${item.group}`) }
    searchableText.set(item, entry)
  }
  return entry
}
function displayItem(item: PaletteItem, terms: string[]): PaletteItem {
  if (!item.description || item.description.length <= 280) return item
  const normalized = normalizeSearch(item.description)
  const position = Math.max(0, Math.min(...terms.map(term => normalized.indexOf(term)).filter(index => index >= 0)) - 65)
  const start = Number.isFinite(position) ? position : 0
  return { ...item, description: `${start ? '…' : ''}${item.description.slice(start, start + 280)}…` }
}
export function rankItems(items: PaletteItem[], query: string, limit = 80, snippets = true): PaletteBatch {
  const terms = searchTerms(query)
  const matches = items.map((item, index) => {
    const { title, haystack } = indexedText(item)
    const score = terms.every(term => haystack.includes(term))
      ? terms.reduce((sum, term) => sum + (title === term ? 100 : title.startsWith(term) ? 30 : title.includes(term) ? 15 : 1), 0)
      : -1
    return { item, score, index }
  }).filter(match => match.score >= 0).sort((a, b) => b.score - a.score || a.index - b.index)
  return { items: matches.slice(0, limit).map(match => snippets ? displayItem(match.item, terms) : match.item), total: matches.length }
}

export async function rankItemsAsync(items: PaletteItem[], query: string, signal: AbortSignal, limit = 80): Promise<PaletteBatch> {
  const matches: PaletteItem[] = []
  let total = 0
  for (let offset = 0; offset < items.length; offset += 400) {
    if (signal.aborted) return { items: [] }
    const batch = rankItems(items.slice(offset, offset + 400), query, limit, false)
    total += batch.total || 0
    matches.push(...batch.items)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { ...rankItems(matches, query, limit), total }
}

/** Reuse the actual mounted control handlers for contextual operations. */
export function contextualCommands(doc: Document): PaletteItem[] {
  const modal = [...doc.querySelectorAll<HTMLElement>('[role="dialog"], .settings-modal-overlay, .capture-modal-overlay')].find(el => el.getClientRects().length && !el.closest('.command-palette-overlay'))
  const root = modal || doc.querySelector('.app-workspace-host') || doc.body
  const commands: PaletteItem[] = []
  const seen = new Set<string>()
  for (const element of root.querySelectorAll<HTMLElement>('button, [role="button"], input:not([type="hidden"]), select, textarea')) {
    if (element.closest('.command-palette-overlay, .inspector-tree-viewport, .gjs-cv-canvas')) continue
    if (!element.getClientRects().length || element.closest('[hidden], [inert]')) continue
    if (getComputedStyle(element).visibility === 'hidden') continue
    const field = element.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), select, textarea')
    const labels = (element as HTMLInputElement).labels
    const label = (element.getAttribute('aria-label') || element.title || (labels?.length ? labels[0].textContent : '') || element.getAttribute('placeholder') || (field ? '' : element.textContent) || '').replace(/\s+/g, ' ').trim()
    if (label.length < 3 || label.length > 160) continue
    const section = element.closest('section, aside, [role="toolbar"], .seo-audit-right-panel, .notes-workspace')
    const context = section?.getAttribute('aria-label') || section?.querySelector('h2, h3, .edit-beta-section-heading')?.textContent?.trim() || 'Current view'
    const key = `${context}:${label}`
    if (seen.has(key)) continue
    seen.add(key)
    const disabled = element.matches(':disabled, [aria-disabled="true"]')
    commands.push({ id: `control:${commands.length}:${key}`, group: 'Commands', title: field ? `Edit ${label}` : label, description: context,
      disabled: disabled ? 'Unavailable in the current state' : undefined,
      run: () => {
        if (!element.isConnected || element.matches(':disabled, [aria-disabled="true"]')) throw new Error('This control is no longer available. Open the palette again.')
        if (field) requestAnimationFrame(() => { if (element.isConnected) element.focus() })
        else element.click()
      },
    })
  }
  return commands
}
