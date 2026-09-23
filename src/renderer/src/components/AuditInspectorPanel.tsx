import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import './AuditInspectorPanel.css'

interface Props {
  doc: Document | null
  selected: HTMLElement | null
  revision: number
  annotations: Array<{ id: string; title?: string; badgeNumber?: number; notes?: string; viewportWidth?: number; viewportHeight?: number }>
  activeViewport: { width: number; height: number }
  onSelect: (element: HTMLElement) => void
  onSelectAnnotation: (id: string) => void
  onChange: (description: string) => void
}

type Rule = { selector: string; style: CSSStyleDeclaration; source: string; context: string; owner?: CSSStyleRule }
type Row = { node: Node; depth: number }
const ROW_HEIGHT = 23
const PSEUDO_STATES = ['hover', 'active', 'focus', 'focus-visible', 'focus-within'] as const
const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE
const isHtmlElement = (node: Node): node is HTMLElement => isElement(node) && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
const isShadowRoot = (node: Node): node is ShadowRoot => node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in node

function childrenOf(node: Node, showInternals: boolean, showWhitespace: boolean): Node[] {
  const children: Node[] = [...node.childNodes]
  if (isElement(node) && node.shadowRoot) children.push(node.shadowRoot)
  return children.filter((child) => {
    if (child.nodeType === Node.TEXT_NODE && !showWhitespace && !child.textContent?.trim()) return false
    if (showInternals || !isElement(child)) return true
    return !child.matches('#live-mini-toolbar-host, #__audit-overlay-container, #live-editor-overlay-style, #live-editor-anim-reveal-style, #parity-audit-forced-pseudo, #__fi-styles, #__bd-styles, #seo-audit-canvas-styles, [data-parity-internal]')
  })
}

function label(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) return '#document'
  if (node.nodeType === Node.DOCUMENT_TYPE_NODE) return `<!DOCTYPE ${node.nodeName}>`
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return '#shadow-root'
  if (node.nodeType === Node.TEXT_NODE) return `#text “${(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)}”`
  if (node.nodeType === Node.COMMENT_NODE) return `<!-- ${(node.textContent || '').slice(0, 100)} -->`
  if (!isElement(node)) return node.nodeName
  const attrs = [...node.attributes]
    .filter((attr) => !attr.name.startsWith('data-live-') && attr.name !== 'data-npath' && attr.name !== 'contenteditable')
    .map((attr) => ` ${attr.name}="${attr.value}"`).join('')
  return `<${node.localName || node.tagName.toLowerCase()}${attrs}>${node.tagName === 'IFRAME' ? '  iframe document' : ''}`
}

function selectorFor(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && parts.length < 12) {
    if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break }
    const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.localName === current!.localName) : []
    parts.unshift(`${current.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`)
    current = current.parentElement
  }
  return parts.join(' > ')
}

function matchingRules(element: HTMLElement): { rules: Rule[]; blocked: number } {
  const doc = element.ownerDocument
  const rules: Rule[] = [{ selector: 'element.style', style: element.style, source: 'inline', context: '' }]
  let blocked = 0
  const visit = (list: CSSRuleList, source: string, context: string) => {
    for (const rule of Array.from(list)) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule
        try { if (element.matches(styleRule.selectorText)) rules.push({ selector: styleRule.selectorText, style: styleRule.style, source, context, owner: styleRule }) } catch { /* Unsupported selector. */ }
      } else if ('cssRules' in rule) {
        try {
          const group = rule as CSSGroupingRule
          const condition = rule.type === CSSRule.MEDIA_RULE ? `@media ${(rule as CSSMediaRule).conditionText}` : rule.type === CSSRule.SUPPORTS_RULE ? `@supports ${(rule as CSSSupportsRule).conditionText}` : rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()
          if (rule.type === CSSRule.MEDIA_RULE && !doc.defaultView?.matchMedia((rule as CSSMediaRule).conditionText).matches) continue
          if (rule.type === CSSRule.SUPPORTS_RULE && !CSS.supports((rule as CSSSupportsRule).conditionText)) continue
          visit(group.cssRules, source, [context, condition].filter(Boolean).join(' · '))
        } catch { blocked++ }
      }
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode
    if (owner && isElement(owner) && [
      'live-editor-overlay-style', 'live-editor-anim-reveal-style',
      'parity-audit-forced-pseudo', 'seo-audit-canvas-styles',
    ].includes(owner.id)) continue
    try { visit(sheet.cssRules, sheet.href || 'inline stylesheet', '') } catch { blocked++ }
  }
  return { rules, blocked }
}

export default function AuditInspectorPanel({ doc, selected, revision, annotations, activeViewport, onSelect, onSelectAnnotation, onChange }: Props) {
  const [sections, setSections] = useState({ annotations: true, layers: true, styles: true })
  const [expanded, setExpanded] = useState<Set<Node>>(new Set())
  const [showInternals, setShowInternals] = useState(false)
  const [showWhitespace, setShowWhitespace] = useState(false)
  const [domRevision, setDomRevision] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'css' | 'text' | 'xpath'>('css')
  const [matches, setMatches] = useState<Node[]>([])
  const [matchIndex, setMatchIndex] = useState(0)
  const [searchError, setSearchError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node } | null>(null)
  const [sourceView, setSourceView] = useState<{ title: string; css: string } | null>(null)
  const [tab, setTab] = useState<'rules' | 'computed' | 'layout'>('rules')
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [expandedComputed, setExpandedComputed] = useState<Set<string>>(new Set())
  const [forced, setForced] = useState<Set<string>>(new Set())
  const [layersHeight, setLayersHeight] = useState(330)
  const [annotationHeight, setAnnotationHeight] = useState(150)
  const viewport = useRef<HTMLDivElement>(null)
  const previousDoc = useRef<Document | null>(null)
  const annotationGroups = useMemo(() => {
    const groups = new Map<string, typeof annotations>()
    for (const annotation of annotations) {
      const width = Math.round(annotation.viewportWidth || activeViewport.width)
      const height = Math.round(annotation.viewportHeight || activeViewport.height)
      const key = `${width} × ${height}`
      groups.set(key, [...(groups.get(key) || []), annotation])
    }
    const currentKey = `${activeViewport.width} × ${activeViewport.height}`
    if (!groups.has(currentKey)) groups.set(currentKey, [])
    return [...groups].sort(([left], [right]) => left === currentKey ? -1 : right === currentKey ? 1 : left.localeCompare(right))
  }, [annotations, activeViewport.width, activeViewport.height])

  useEffect(() => {
    if (!doc) return
    const previous = previousDoc.current
    setExpanded((old) => {
      const next = new Set<Node>([doc, doc.documentElement, doc.head, doc.body].filter(Boolean) as Node[])
      if (previous && previous !== doc) for (const node of old) {
        if (!isElement(node) || node.ownerDocument !== previous) continue
        try { const replacement = doc.querySelector(selectorFor(node)); if (replacement) next.add(replacement) } catch { /* Removed or invalid selector. */ }
      }
      return next
    })
    if (!previous) setScrollTop(0)
    previousDoc.current = doc
    let frame = 0
    const observer = new MutationObserver((records) => {
      if (records.every((record) => record.type === 'attributes' && ['data-live-hover', 'data-live-selected', 'contenteditable', 'data-npath'].includes(record.attributeName || ''))) return
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setDomRevision((value) => value + 1) })
    })
    observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true })
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame) }
  }, [doc])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close) }
  }, [menu])

  useEffect(() => {
    if (!sourceView) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setSourceView(null) } }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [sourceView])

  useEffect(() => { setForced(new Set()) }, [selected])

  useEffect(() => {
    if (!doc || !selected || !forced.size) return
    const selector = /:(hover|active|focus-visible|focus-within|focus)(?![\w-])/g
    const css: string[] = []
    const visit = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule.type === CSSRule.STYLE_RULE) {
          const styleRule = rule as CSSStyleRule
          if (!selector.test(styleRule.selectorText)) continue
          selector.lastIndex = 0
          const rewritten = styleRule.selectorText.replace(selector, (match, state: string) => forced.has(state) ? `[data-audit-force-${state}]` : match)
          css.push(`${rewritten} { ${styleRule.style.cssText} }`)
        } else if ('cssRules' in rule) {
          try { visit((rule as CSSGroupingRule).cssRules) } catch { /* Restricted stylesheet. */ }
        }
      }
    }
    for (const sheet of Array.from(doc.styleSheets)) {
      try { visit(sheet.cssRules) } catch { /* Restricted stylesheet. */ }
    }
    const style = doc.createElement('style')
    style.id = 'parity-audit-forced-pseudo'
    style.textContent = css.join('\n')
    doc.head.append(style)
    forced.forEach((state) => selected.setAttribute(`data-audit-force-${state}`, ''))
    return () => { style.remove(); forced.forEach((state) => selected.removeAttribute(`data-audit-force-${state}`)) }
  }, [doc, selected, forced])

  useEffect(() => {
    if (!selected) return
    setExpanded((old) => {
      const next = new Set(old)
      let ancestor: Node | null = selected
      while (ancestor) { next.add(ancestor); ancestor = ancestor.parentNode || (isShadowRoot(ancestor) ? ancestor.host : null) }
      return next
    })
  }, [selected])

  const rows = useMemo(() => {
    if (!doc) return [] as Row[]
    const result: Row[] = []
    const visit = (node: Node, depth: number) => {
      result.push({ node, depth })
      if (expanded.has(node)) childrenOf(node, showInternals, showWhitespace).forEach((child) => visit(child, depth + 1))
    }
    visit(doc, 0)
    return result
  }, [doc, expanded, showInternals, showWhitespace, domRevision])

  useEffect(() => {
    if (!selected || !sections.layers) return
    const index = rows.findIndex((row) => row.node === selected)
    if (index < 0 || !viewport.current) return
    const view = viewport.current
    const top = index * ROW_HEIGHT
    if (top < view.scrollTop || top + ROW_HEIGHT > view.scrollTop + view.clientHeight) view.scrollTop = Math.max(0, top - view.clientHeight / 2)
  }, [selected, rows, sections.layers])

  useEffect(() => {
    if (!doc || !search.trim()) { setMatches([]); setSearchError(''); return }
    const timer = window.setTimeout(() => {
      try {
        let found: Node[] = []
        if (searchMode === 'css') found = [...doc.querySelectorAll(search)]
        else if (searchMode === 'xpath') {
          const result = doc.evaluate(search, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
          found = Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index)).filter((node): node is Node => !!node)
        } else {
          const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode
            if (node.nodeType === Node.TEXT_NODE && node.textContent?.toLowerCase().includes(search.toLowerCase())) found.push(node)
          }
        }
        setMatches(found); setMatchIndex(0); setSearchError('')
      } catch (error) { setMatches([]); setSearchError(error instanceof Error ? error.message : 'Invalid search') }
    }, 150)
    return () => window.clearTimeout(timer)
  }, [doc, search, searchMode, domRevision])

  const selectNode = (node: Node) => {
    let current: Node | null = node
    while (current && !isHtmlElement(current)) current = current.parentNode || (isShadowRoot(current) ? current.host : null)
    if (current && isHtmlElement(current)) { onSelect(current); current.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
  }
  const navigateMatch = (next: number) => {
    if (!matches.length) return
    const index = (next + matches.length) % matches.length
    setMatchIndex(index); selectNode(matches[index])
  }
  const toggle = (name: keyof typeof sections) => setSections((old) => ({ ...old, [name]: !old[name] }))
  const resize = (kind: 'annotations' | 'layers', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const initial = kind === 'annotations' ? annotationHeight : layersHeight
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => (kind === 'annotations' ? setAnnotationHeight : setLayersHeight)(Math.max(80, Math.min(700, initial + next.clientY - startY)))
    const stop = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', stop); target.removeEventListener('pointercancel', stop) }
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', stop); target.addEventListener('pointercancel', stop)
  }
  const editNode = (action: 'attribute' | 'text' | 'html' | 'duplicate' | 'delete') => {
    const node = menu?.node
    setMenu(null)
    if (!node || !isElement(node)) return
    if (action === 'attribute') {
      const raw = window.prompt('Attribute name and value (name=value)', 'class=' + (node.getAttribute('class') || ''))
      if (!raw) return
      const separator = raw.indexOf('=')
      const name = raw.slice(0, separator).trim()
      if (separator < 1 || !/^[^\s<>="']+$/.test(name)) return
      node.setAttribute(name, raw.slice(separator + 1))
    } else if (action === 'text') {
      const text = window.prompt('Edit text', node.textContent || '')
      if (text === null) return
      node.textContent = text
    } else if (action === 'html') {
      const html = window.prompt('Edit outer HTML', node.outerHTML)
      if (html === null) return
      const template = node.ownerDocument.createElement('template')
      template.innerHTML = html
      const replacement = template.content.firstElementChild
      if (!replacement) return
      node.replaceWith(replacement); if (isHtmlElement(replacement)) onSelect(replacement)
    } else if (action === 'duplicate') {
      node.after(node.cloneNode(true));
    } else {
      node.remove()
    }
    onChange(`${action} ${node.localName}`)
  }

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8)
  const visibleEnd = Math.min(rows.length, visibleStart + Math.ceil((layersHeight + 120) / ROW_HEIGHT) + 16)
  const styleData = useMemo(() => selected ? matchingRules(selected) : { rules: [] as Rule[], blocked: 0 }, [selected, revision, domRevision])
  const computed = selected?.ownerDocument.defaultView?.getComputedStyle(selected)
  const computedNames = computed ? Array.from(computed).filter((name) => (showAll || !name.startsWith('-webkit-')) && (!filter || name.includes(filter.toLowerCase()) || computed.getPropertyValue(name).toLowerCase().includes(filter.toLowerCase()))) : []
  const box = selected?.getBoundingClientRect()
  const persistRule = (style: CSSStyleDeclaration, property?: string) => {
    const rule = style.parentRule as CSSStyleRule | null
    const sheet = rule?.parentStyleSheet
    const owner = sheet?.ownerNode
    if (!rule || !sheet || !owner || !isElement(owner)) return
    if (owner.tagName.toLowerCase() === 'style') {
      owner.textContent = Array.from(sheet.cssRules).map((item) => item.cssText).join('\n')
    } else if (property) {
      // The captured page cannot rewrite a linked stylesheet file. Keep the
      // edited declaration in the saved snapshot as a later matching rule.
      let override = selected?.ownerDocument.querySelector('style[data-parity-audit-overrides]')
      if (!override) {
        override = selected!.ownerDocument.createElement('style')
        override.setAttribute('data-parity-audit-overrides', '')
        selected!.ownerDocument.head.append(override)
      }
      const value = style.getPropertyValue(property) || selected?.ownerDocument.defaultView?.getComputedStyle(selected).getPropertyValue(property) || 'initial'
      override.textContent += `\n${rule.selectorText} { ${property}: ${value}${style.getPropertyPriority(property) ? ' !important' : ''}; }`
    }
  }
  const changeStyle = (style: CSSStyleDeclaration, name: string, value: string, description: string) => {
    const important = /\s*!important\s*$/i.test(value)
    style.setProperty(name, value.replace(/\s*!important\s*$/i, '').trim(), important ? 'important' : style.getPropertyPriority(name))
    persistRule(style, name)
    onChange(description)
  }
  const openSource = (rule: Rule) => {
    const sheet = rule.owner?.parentStyleSheet
    if (!sheet) return
    try { setSourceView({ title: rule.source, css: Array.from(sheet.cssRules).map((item) => item.cssText).join('\n\n') }) }
    catch { setSourceView({ title: rule.source, css: 'The stylesheet source is unavailable in this capture.' }) }
  }

  return <div className="audit-inspector">
    <section className="audit-inspector-section" style={{ flex: sections.annotations ? `0 0 ${annotationHeight}px` : '0 0 auto' }}>
      <button className="audit-inspector-heading" onClick={() => toggle('annotations')}><span>{sections.annotations ? '⌄' : '›'} Annotations</span><small>{annotations.length}</small></button>
      {sections.annotations && <div className="audit-inspector-annotations">{annotationGroups.map(([size, items]) => <div className="audit-inspector-annotation-group" key={size}><header><b>{size}</b><small>{size === `${activeViewport.width} × ${activeViewport.height}` ? 'Viewing' : items.length}</small></header>{items.length ? items.map((item) => <button key={item.id} onClick={() => onSelectAnnotation(item.id)}><b>#{item.badgeNumber || '·'} {item.title || 'Annotation'}</b><small>{item.notes?.replace(/<[^>]*>/g, ' ').slice(0, 90) || 'No notes'}</small></button>) : <p>No annotations at this size</p>}</div>)}</div>}
    </section>
    <div className="audit-inspector-resizer" onPointerDown={(event) => resize('annotations', event)} aria-label="Resize Annotations and Layers" />
    <section className="audit-inspector-section" style={{ flex: sections.layers ? `0 0 ${layersHeight}px` : '0 0 auto' }}>
      <button className="audit-inspector-heading" onClick={() => toggle('layers')}><span>{sections.layers ? '⌄' : '›'} Layers</span><small>DOM</small></button>
      {sections.layers && <div className="audit-inspector-layers">
        <div className="audit-inspector-toolbar"><select aria-label="Search mode" value={searchMode} onChange={(event) => setSearchMode(event.target.value as typeof searchMode)}><option value="css">CSS</option><option value="text">Text</option><option value="xpath">XPath</option></select><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') navigateMatch(matchIndex + 1) }} placeholder="Search DOM" aria-label="Search DOM" /><button onClick={() => navigateMatch(matchIndex)} aria-label="Go to match">⌕</button></div>
        {search && <div className="audit-inspector-search-status">{searchError || `${matches.length ? matchIndex + 1 : 0} of ${matches.length}`}<button onClick={() => navigateMatch(matchIndex - 1)} aria-label="Previous match">↑</button><button onClick={() => navigateMatch(matchIndex + 1)} aria-label="Next match">↓</button></div>}
        <div className="audit-inspector-tree" ref={viewport} tabIndex={0} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onKeyDown={(event) => {
          const index = rows.findIndex((row) => row.node === selected)
          if (event.key === 'ArrowDown' && rows[index + 1]) { event.preventDefault(); selectNode(rows[index + 1].node) }
          if (event.key === 'ArrowUp' && rows[index - 1]) { event.preventDefault(); selectNode(rows[index - 1].node) }
          if (event.key === 'ArrowRight' && rows[index]) { event.preventDefault(); setExpanded((old) => new Set(old).add(rows[index].node)) }
          if (event.key === 'ArrowLeft' && rows[index]) { event.preventDefault(); setExpanded((old) => { const next = new Set(old); next.delete(rows[index].node); return next }) }
        }}><div style={{ height: rows.length * ROW_HEIGHT, position: 'relative', minWidth: '100%' }}>{rows.slice(visibleStart, visibleEnd).map(({ node, depth }, offset) => {
          const children = childrenOf(node, showInternals, showWhitespace)
          return <div key={visibleStart + offset} className={`audit-inspector-row ${node === selected ? 'selected' : ''} ${matches.includes(node) ? 'match' : ''}`} style={{ top: (visibleStart + offset) * ROW_HEIGHT, paddingLeft: 4 + depth * 12 }} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, node }) }} onMouseEnter={() => { if (isElement(node)) node.setAttribute('data-live-hover', 'true') }} onMouseLeave={() => { if (isElement(node)) node.removeAttribute('data-live-hover') }}><button className="audit-inspector-chevron" onClick={() => setExpanded((old) => { const next = new Set(old); next.has(node) ? next.delete(node) : next.add(node); return next })} disabled={!children.length}>{children.length ? expanded.has(node) ? '⌄' : '›' : ''}</button><button className="audit-inspector-node" onClick={() => selectNode(node)} title={label(node)}>{label(node)}</button></div>
        })}</div></div>
        <div className="audit-inspector-options"><label><input type="checkbox" checked={showWhitespace} onChange={(event) => setShowWhitespace(event.target.checked)} /> Show whitespace</label><label><input type="checkbox" checked={showInternals} onChange={(event) => setShowInternals(event.target.checked)} /> Show Parity internals</label></div>
      </div>}
    </section>
    <div className="audit-inspector-resizer" onPointerDown={(event) => resize('layers', event)} aria-label="Resize Layers and Styles" />
    <section className="audit-inspector-section audit-inspector-styles-section">
      <button className="audit-inspector-heading" onClick={() => toggle('styles')}><span>{sections.styles ? '⌄' : '›'} Styles</span></button>
      {sections.styles && <div className="audit-inspector-styles"><div className="audit-inspector-tabs">{(['rules', 'computed', 'layout'] as const).map((name) => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
        {selected ? <><div className="audit-inspector-toolbar"><input placeholder={`Filter ${tab}`} value={filter} onChange={(event) => setFilter(event.target.value)} />{tab === 'rules' && <button onClick={() => { const selector = window.prompt('New CSS selector', selectorFor(selected)); if (!selector) return; try { let owner = selected.ownerDocument.querySelector('style[data-parity-audit-overrides]'); if (!owner) { owner = selected.ownerDocument.createElement('style'); owner.setAttribute('data-parity-audit-overrides', ''); selected.ownerDocument.head.append(owner) }; const sheet = (owner as HTMLStyleElement).sheet!; sheet.insertRule(`${selector} {}`, sheet.cssRules.length); owner.textContent = Array.from(sheet.cssRules).map((item) => item.cssText).join('\n'); onChange(`Add rule ${selector}`) } catch (error) { window.alert(error instanceof Error ? error.message : 'Cannot add CSS rule') } }} title="Add stylesheet rule">+ rule</button>}<button onClick={() => { const name = window.prompt('Property name'); if (!name) return; const value = window.prompt('Value'); if (value === null) return; changeStyle(selected.style, name, value, `Set ${name}`) }} title="Add element override">+</button></div>
          {tab === 'rules' && <div className="audit-inspector-style-scroll"><div className="audit-inspector-force"><span>Force state</span>{PSEUDO_STATES.map((state) => <button key={state} className={forced.has(state) ? 'active' : ''} onClick={() => setForced((old) => { const next = new Set(old); next.has(state) ? next.delete(state) : next.add(state); return next })}>:{state}</button>)}</div><div className="audit-inspector-classes">Classes {[...selected.classList].map((name) => <label key={name}><input type="checkbox" checked={selected.classList.contains(name)} onChange={(event) => { selected.classList.toggle(name, event.target.checked); onChange(`Toggle .${name}`) }} />.{name}</label>)}<button onClick={() => { const name = window.prompt('Add class'); if (name?.trim()) { selected.classList.add(name.trim()); onChange(`Add .${name.trim()}`) } }}>+ class</button></div>{styleData.blocked > 0 && <p className="audit-inspector-warning">{styleData.blocked} stylesheet{styleData.blocked === 1 ? '' : 's'} cannot be read. Computed values remain available.</p>}{styleData.rules.map((rule, index) => <div className="audit-inspector-rule" key={`${rule.source}:${index}`}><header>{rule.owner ? <input className="audit-inspector-selector" key={`${revision}:${rule.selector}`} defaultValue={rule.selector} onBlur={(event) => { const value = event.currentTarget.value.trim(); if (value && value !== rule.owner?.selectorText) { try { rule.owner!.selectorText = value; persistRule(rule.style); onChange(`Edit selector ${rule.selector}`) } catch (error) { window.alert(error instanceof Error ? error.message : 'Invalid selector') } } }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = rule.selector; event.currentTarget.blur() } }} aria-label="Rule selector" /> : <b>{rule.selector}</b>}<button className="audit-inspector-source" title={`Open captured CSS: ${rule.source}`} disabled={!rule.owner} onClick={() => openSource(rule)}>{rule.source.split('/').pop()}</button></header>{rule.context && <small>{rule.context}</small>}{Array.from(rule.style).filter((name) => !filter || name.includes(filter.toLowerCase()) || rule.style.getPropertyValue(name).toLowerCase().includes(filter.toLowerCase())).map((name) => <div className="audit-inspector-declaration" key={name}><span>{name}</span><input key={`${revision}:${name}`} defaultValue={rule.style.getPropertyValue(name).trim()} onBlur={(event) => { const value = event.currentTarget.value.trim(); if (value !== rule.style.getPropertyValue(name).trim()) changeStyle(rule.style, name, value, `Edit ${rule.selector} ${name}`) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = rule.style.getPropertyValue(name).trim(); event.currentTarget.blur() } }} aria-label={`${rule.selector} ${name}`} /><button title={`Remove ${name}`} onClick={() => { rule.style.removeProperty(name); persistRule(rule.style, name); onChange(`Remove ${name}`) }}>×</button></div>)}<button className="audit-inspector-add" onClick={() => { const name = window.prompt('Property name'); if (!name) return; const value = window.prompt('Value'); if (value === null) return; changeStyle(rule.style, name, value, `Add ${name}`) }}>+ declaration</button></div>)}</div>}
          {tab === 'computed' && <div className="audit-inspector-style-scroll">
            <label className="audit-inspector-show-all"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show all</label>
            {computedNames.map((name) => <div className="audit-inspector-computed-item" key={name}>
              <button className="audit-inspector-computed" aria-expanded={expandedComputed.has(name)} onClick={() => setExpandedComputed((old) => { const next = new Set(old); next.has(name) ? next.delete(name) : next.add(name); return next })}><b>{expandedComputed.has(name) ? '⌄' : '›'} {name}</b><span>{computed?.getPropertyValue(name)}</span></button>
              {expandedComputed.has(name) && <div className="audit-inspector-contributors">{styleData.rules.filter((rule) => rule.style.getPropertyValue(name)).map((rule, index) => <div key={`${rule.selector}:${index}`}><b>{rule.selector}</b><span>{rule.style.getPropertyValue(name)}{rule.style.getPropertyPriority(name) ? ' !important' : ''}</span></div>)}{!styleData.rules.some((rule) => rule.style.getPropertyValue(name)) && <small>No matching declaration in the readable stylesheets; this value may be inherited or browser-derived.</small>}</div>}
            </div>)}
          </div>}
          {tab === 'layout' && <div className="audit-inspector-style-scroll"><div className="audit-inspector-dimensions">{Math.round(box?.width || 0)} × {Math.round(box?.height || 0)} · {computed?.display}</div>{(['margin', 'border-width', 'padding'] as const).map((name) => <div className="audit-inspector-box" key={name}><b>{name}</b>{(['top', 'right', 'bottom', 'left'] as const).map((side) => { const property = name === 'border-width' ? `border-${side}-width` : `${name}-${side}`; return <label key={side}>{side}<input key={`${revision}:${property}`} defaultValue={computed?.getPropertyValue(property).trim()} onBlur={(event) => { const value = event.currentTarget.value.trim(); if (value) changeStyle(selected.style, property, value, `Set ${property}`) }} aria-label={property} /></label> })}</div>)}</div>}
        </> : <div className="audit-inspector-empty">Select an element to inspect its rules, computed styles, and layout.</div>}
      </div>}
    </section>
    {menu && <div className="audit-inspector-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 250) }} onClick={(event) => event.stopPropagation()}><button onClick={() => { selectNode(menu.node.parentNode || menu.node); setMenu(null) }}>Inspect parent</button><button onClick={() => { if (isElement(menu.node)) void navigator.clipboard.writeText(selectorFor(menu.node)); setMenu(null) }}>Copy selector</button><button onClick={() => { if (isElement(menu.node)) void navigator.clipboard.writeText(menu.node.outerHTML); setMenu(null) }}>Copy HTML</button><button onClick={() => editNode('attribute')}>Edit attribute</button><button onClick={() => editNode('text')}>Edit text</button><button onClick={() => editNode('html')}>Edit outer HTML</button><button onClick={() => editNode('duplicate')}>Duplicate</button><button onClick={() => editNode('delete')}>Delete</button></div>}
    {sourceView && <div className="audit-inspector-source-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSourceView(null) }}><div className="audit-inspector-source-viewer" role="dialog" aria-label="Captured stylesheet source"><header><b>{sourceView.title}</b><button onClick={() => setSourceView(null)} aria-label="Close source viewer">×</button></header><pre>{sourceView.css}</pre></div></div>}
  </div>
}
