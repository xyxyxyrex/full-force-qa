import type { PaletteBatch } from './registry'

export interface PageMatch { id: number; title: string; snippet: string; kind: 'Page' | 'Files'; location: string }
export interface PageSearchResponse { token: string; matches: PageMatch[]; total: number; warning?: string }
export type PageSearchRequest = { action: 'search'; query: string; limit?: number; kind?: 'Page' | 'Files' } | { action: 'reveal'; token: string; id: number } | { action: 'release' }

/** Self-contained: also serialized into Chromium guests via executeJavaScript. */
export async function pageSearch(doc: Document, request: PageSearchRequest): Promise<PageSearchResponse | boolean> {
  type Entry = { id: number; element: Element; title: string; text: string; normalized: string; kind: 'Page' | 'Files' }
  type State = { token: string; version: number; sequence: number; dirty: boolean; entries: Entry[]; observer: MutationObserver; building?: Promise<void>; frames: number }
  const host = doc as Document & { __parityPageSearch?: State }
  const win = doc.defaultView!
  if (request.action === 'release') {
    if (host.__parityPageSearch) { host.__parityPageSearch.sequence++; host.__parityPageSearch.observer.disconnect(); delete host.__parityPageSearch }
    return true
  }
  const normalize = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const isInternal = (element: Element) => element.hasAttribute('data-fullforce-beta-ui') || /^__qa|^__fullforce|^gjs-/i.test(element.id)
  if (!host.__parityPageSearch) {
    const state = {} as State
    Object.assign(state, { token: `${Date.now()}:${Math.random()}`, version: 0, sequence: 0, dirty: true, entries: [], frames: 0 })
    state.observer = new MutationObserver(changes => {
      if (changes.some(change => {
        const el = change.target.nodeType === 1 ? change.target as Element : change.target.parentElement
        return el && !isInternal(el) && !el.closest('[data-fullforce-beta-ui]')
      })) { state.dirty = true; state.version++ }
    })
    state.observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true })
    host.__parityPageSearch = state
  }
  const state = host.__parityPageSearch
  if (request.action === 'reveal') {
    const entry = state.entries.find(item => item.id === request.id)
    if (request.token !== state.token || !entry?.element.isConnected) throw new Error('This result belongs to a page that changed. Search again.')
    const element = entry.element
    const path: string[] = []
    for (let current: Element | null = element; current; current = current.parentElement) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter(child => child.localName === current!.localName) : []
      path.unshift(`${CSS.escape(current.localName)}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`)
    }
    const bridge = (win as any).__fullForceEditBeta
    if (element.getRootNode() === doc && bridge?.selectPath) bridge.selectPath(path.join(' > '))
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    element.animate?.([{ outline: '3px solid #ff0055', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1800 })
    return true
  }
  const sequence = ++state.sequence
  const yieldTask = () => new Promise<void>(resolve => win.setTimeout(resolve, 0))
  if (state.dirty && !state.building) {
    const version = state.version
    state.building = (async () => {
      const entries: Entry[] = []
      const stack: Node[] = [doc.documentElement]
      let visited = 0
      let frames = 0
      const add = (element: Element, title: string, text: string, kind: 'Page' | 'Files') => {
        if (!text.trim()) return
        entries.push({ id: entries.length, element, title, text, normalized: normalize(`${title} ${text}`), kind })
      }
      while (stack.length) {
        if (host.__parityPageSearch !== state) return
        const node = stack.pop()!
        if (node.nodeType === 1) {
          const element = node as Element
          if (isInternal(element) || element.localName === 'template') continue
          if (element.localName === 'iframe') frames++
          const label = `<${element.localName}${element.id ? `#${element.id}` : ''}>`
          const attributes = [...element.attributes].filter(attr => !/^on/i.test(attr.name) && !/password|token|secret/i.test(attr.name) && attr.name !== 'value')
          const metadata = attributes.map(attr => {
            if (/^(src|href|poster|data-src)$/.test(attr.name)) {
              try { return `${attr.name}="${attr.value}" ${new URL(attr.value, doc.baseURI).href}` } catch {}
            }
            return `${attr.name}="${attr.value}"`
          }).join(' ')
          add(element, label, metadata, /^(img|script|link|source|video|audio)$/.test(element.localName) ? 'Files' : 'Page')
          if (element.shadowRoot) {
            state.observer.observe(element.shadowRoot, { subtree: true, childList: true, characterData: true, attributes: true })
            stack.push(element.shadowRoot)
          }
        } else if (node.nodeType === 3 && node.parentElement) {
          const parent = node.parentElement
          const source = /^(style|script)$/.test(parent.localName)
          add(parent, source ? `Inline ${parent.localName}` : `<${parent.localName}> text`, node.nodeValue || '', source ? 'Files' : 'Page')
        }
        for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child)
        if (++visited % 250 === 0) await yieldTask()
      }
      if (host.__parityPageSearch !== state) return
      state.entries = entries
      state.frames = frames
      state.token = `${Date.now()}:${Math.random()}`
      state.dirty = state.version !== version
    })().finally(() => { state.building = undefined })
  }
  await state.building
  const terms = (request.query.match(/"[^"]+"|\S+/g) || []).map(term => normalize(term.replace(/^"|"$/g, '')))
  let total = 0
  const limit = Math.max(1, Math.min(request.limit || 80, 10000))
  const matches: PageMatch[] = []
  for (let index = 0; index < state.entries.length; index++) {
    if (sequence !== state.sequence || host.__parityPageSearch !== state) return { token: state.token, matches: [], total: 0 }
    const entry = state.entries[index]
    if ((!request.kind || request.kind === entry.kind) && terms.every(term => entry.normalized.includes(term))) {
      total++
      if (matches.length < limit) {
        const position = Math.max(0, normalize(entry.text).indexOf(terms[0] || '') - 65)
        matches.push({ id: entry.id, title: entry.title, snippet: `${position ? '…' : ''}${entry.text.slice(position, position + 240).replace(/\s+/g, ' ')}`, kind: entry.kind, location: doc.URL })
      }
    }
    if (index % 500 === 0) await yieldTask()
  }
  return { token: state.token, matches, total, warning: `Active document and open shadow roots. External file contents and iframe contents are not indexed.${state.frames ? ` ${state.frames} iframe boundary(s).` : ''}${state.dirty ? ' Page changed during indexing; type again to refresh.' : ''}` }
}

export function pageSearchExpression(request: PageSearchRequest): string {
  return `(${pageSearch.toString()})(document, ${JSON.stringify(request)})`
}

export function pageBatch(response: PageSearchResponse, reveal: (token: string, id: number) => Promise<unknown>): PaletteBatch {
  return { total: response.total, warning: response.warning, items: response.matches.map(match => ({
    id: `page:${response.token}:${match.id}`, title: match.title, description: match.snippet,
    group: match.kind, keywords: match.location,
    run: async () => { await reveal(response.token, match.id) },
  })) }
}
