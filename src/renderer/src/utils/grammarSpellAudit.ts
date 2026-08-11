export interface TextIssue {
  id: string
  type: 'spelling' | 'grammar'
  wordOrPhrase: string
  suggestion?: string
  suggestions?: string[]
  message: string
  elementTag: string
  elementSnippet: string
  elementIndex: number
  elementPath: string
  fullText: string
  start: number
  end: number
  category?: string
  ruleId?: string
  engine?: 'harper' | 'nspell'
}

export interface GrammarSpellReport {
  totalIssues: number
  spellingCount: number
  grammarCount: number
  issues: TextIssue[]
  scannedElements?: number
  engines?: {
    harper: boolean
    spellingFallback: boolean
    warnings: string[]
  }
}

export interface AuditableTextElement {
  element: HTMLElement
  id: string
  tag: string
  text: string
  index: number
  path: string
}

const PRIMARY_TEXT_SELECTOR = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'figcaption',
  'caption', 'td', 'th', 'label', 'button', 'option', 'legend', 'summary', '[role="heading"]'
].join(',')

const EXCLUDED_ANCESTOR_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'code', 'pre',
  'textarea', '[contenteditable="true"]', '[aria-hidden="true"]',
  '#__audit-overlay-container', '#live-mini-toolbar-host'
].join(',')

const emptyReport = (): GrammarSpellReport => ({
  totalIssues: 0,
  spellingCount: 0,
  grammarCount: 0,
  issues: [],
  scannedElements: 0,
  engines: { harper: false, spellingFallback: false, warnings: [] }
})

function isVisibleForAudit(element: HTMLElement): boolean {
  if (element.closest(EXCLUDED_ANCESTOR_SELECTOR)) return false
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  const view = element.ownerDocument.defaultView
  if (!view) return true
  try {
    const style = view.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0
  } catch {
    return true
  }
}

function auditText(element: Element): string {
  return (element.textContent || '').replace(/\u00a0/g, ' ').trim()
}

function elementPath(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && current.tagName.toLowerCase() !== 'html') {
    const tag = current.tagName.toLowerCase()
    if (tag === 'body') {
      parts.unshift('body')
      break
    }
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current!.tagName)
      : []
    const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
    parts.unshift(`${tag}${suffix}`)
    current = current.parentElement
  }
  return parts.join(' > ')
}

export function collectAuditableTextElements(doc: Document): AuditableTextElement[] {
  if (!doc.body) return []
  const selected = new Set<HTMLElement>()
  const add = (element: Element) => {
    if (element.nodeType !== Node.ELEMENT_NODE || element.ownerDocument !== doc) return
    const htmlElement = element as HTMLElement
    const text = auditText(htmlElement)
    if (text.length < 3 || text.length > 12000 || !isVisibleForAudit(htmlElement)) return
    selected.add(htmlElement)
  }

  doc.body.querySelectorAll(PRIMARY_TEXT_SELECTOR).forEach(add)
  doc.body.querySelectorAll('a').forEach((element) => {
    if (!element.closest(PRIMARY_TEXT_SELECTOR)) add(element)
  })
  doc.body.querySelectorAll('span').forEach((element) => {
    if (!element.closest(`${PRIMARY_TEXT_SELECTOR}, a`) && !element.querySelector('span')) add(element)
  })
  doc.body.querySelectorAll('div, section, article').forEach((element) => {
    if (!element.querySelector(`${PRIMARY_TEXT_SELECTOR}, a, span, div, section, article`)) add(element)
  })

  return Array.from(selected)
    .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    .map((element, index) => {
      const path = elementPath(element)
      return {
        element,
        id: path || `text-${index}`,
        tag: element.tagName.toLowerCase(),
        text: auditText(element),
        index,
        path
      }
    })
}

export function grammarAuditContentSignature(docOrHtml: Document | string): string {
  const doc = typeof docOrHtml === 'string'
    ? new DOMParser().parseFromString(docOrHtml, 'text/html')
    : docOrHtml
  const source = collectAuditableTextElements(doc).map((item) => `${item.path}\u0000${item.text}`).join('\u0001')
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${source.length}:${(hash >>> 0).toString(36)}`
}

export function locateIssueElement(doc: Document, issue: TextIssue): HTMLElement | null {
  if (issue.elementPath) {
    try {
      const exact = doc.querySelector(issue.elementPath)
      if (exact?.nodeType === Node.ELEMENT_NODE) return exact as HTMLElement
    } catch {}
  }
  const candidates = collectAuditableTextElements(doc)
  const indexed = candidates[issue.elementIndex]?.element
  if (indexed && auditText(indexed).includes(issue.wordOrPhrase)) return indexed
  return candidates.find((candidate) => auditText(candidate.element).includes(issue.wordOrPhrase))?.element || null
}

function textNodes(element: HTMLElement): Text[] {
  const result: Text[] = []
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(EXCLUDED_ANCESTOR_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    }
  })
  while (walker.nextNode()) result.push(walker.currentNode as Text)
  return result
}

export function issueDomRange(doc: Document, issue: TextIssue): Range | null {
  const element = locateIssueElement(doc, issue)
  if (!element) return null
  const rawText = (element.textContent || '').replace(/\u00a0/g, ' ')
  const fullTextStart = rawText.indexOf(issue.fullText)
  if (fullTextStart < 0) return null
  const start = fullTextStart + Math.max(0, issue.start)
  const end = fullTextStart + Math.max(issue.start, issue.end)
  if (rawText.slice(start, end) !== issue.wordOrPhrase) return null

  let offset = 0
  let startNode: Text | null = null
  let endNode: Text | null = null
  let startOffset = 0
  let endOffset = 0
  for (const node of textNodes(element)) {
    const next = offset + (node.nodeValue || '').length
    if (!startNode && start >= offset && start <= next) {
      startNode = node
      startOffset = start - offset
    }
    if (end >= offset && end <= next) {
      endNode = node
      endOffset = end - offset
      break
    }
    offset = next
  }
  if (!startNode || !endNode) return null
  const range = doc.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

export function applyIssueSuggestion(doc: Document, issue: TextIssue, replacement: string): boolean {
  const range = issueDomRange(doc, issue)
  if (!range || range.toString() !== issue.wordOrPhrase) return false
  range.deleteContents()
  if (replacement) range.insertNode(doc.createTextNode(replacement))
  return true
}

export async function runGrammarSpellAuditAsync(docOrHtml: Document | string): Promise<GrammarSpellReport> {
  const doc = typeof docOrHtml === 'string'
    ? new DOMParser().parseFromString(docOrHtml, 'text/html')
    : docOrHtml
  if (!doc?.body) return emptyReport()

  const elements = collectAuditableTextElements(doc)
  const payload = elements.map(({ id, tag, text, index, path }) => ({ id, tag, text, index, path }))
  try {
    if (typeof window.electronAPI?.runGrammarSpellAudit !== 'function') {
      return { ...emptyReport(), scannedElements: elements.length, engines: { harper:false, spellingFallback:false, warnings:['Grammar service is unavailable.'] } }
    }
    const report = await window.electronAPI.runGrammarSpellAudit(payload)
    if (report && Array.isArray(report.issues)) return report as GrammarSpellReport
  } catch (error) {
    console.warn('[GrammarSpellAudit] Main-process audit failed:', error)
    return { ...emptyReport(), scannedElements: elements.length, engines: { harper:false, spellingFallback:false, warnings:[error instanceof Error ? error.message : 'Grammar scan failed.'] } }
  }
  return emptyReport()
}

export function runGrammarSpellAudit(_docOrHtml: Document | string): GrammarSpellReport {
  return emptyReport()
}
