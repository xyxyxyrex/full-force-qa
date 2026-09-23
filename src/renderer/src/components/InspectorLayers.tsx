import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { InspectorDomNode, InspectorSessionSnapshot } from '../../../shared/inspector'
import { inspectorNodeChildren, mergeInspectorTreeNode, visibleInspectorChildren } from './inspectorTreeState'

interface Props {
  session: InspectorSessionSnapshot | null
  selected: InspectorDomNode | null
  error?: string
  onSelect: (node: InspectorDomNode) => void
  onRefresh: () => void
  onReconnect: () => void
  onError: (message: string) => void
}

interface FlatRow { node: InspectorDomNode; depth: number }

interface CachedTreeState {
  nodes: Map<number, InspectorDomNode>
  expanded: Set<number>
  scrollTop: number
}

const treeStateCache = new Map<string, CachedTreeState>()

function treeCacheKey(session: InspectorSessionSnapshot | null): string {
  return session ? `${session.sessionId}:${session.generation}` : ''
}

function cachedTreeState(session: InspectorSessionSnapshot | null): CachedTreeState | undefined {
  return treeStateCache.get(treeCacheKey(session))
}

function mergeNode(map: Map<number, InspectorDomNode>, node: InspectorDomNode) {
  mergeInspectorTreeNode(map, node)
}

function attributeText(node: InspectorDomNode) {
  return node.attributes.map(attribute => ` ${attribute.name}="${attribute.value}"`).join('')
}

function NodeLabel({ node }: { node: InspectorDomNode }) {
  if (node.nodeType === 9) return <><b>#document</b></>
  if (node.nodeType === 11 || node.shadowRootType) return <><b>#shadow-root</b><span> ({node.shadowRootType || 'open'})</span></>
  if (node.pseudoType) return <><b>::{node.pseudoType}</b></>
  if (node.nodeType === 10) return <b>&lt;!DOCTYPE {node.nodeName}&gt;</b>
  if (node.nodeType === 7) return <><b>&lt;?{node.nodeName}</b><span> {node.nodeValue}</span><b>?&gt;</b></>
  if (node.nodeType === 4) return <><b>&lt;![CDATA[</b><span>{node.nodeValue.slice(0, 100)}</span><b>]]&gt;</b></>
  if (node.nodeType === 3) return <><b>#text</b><span> “{node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 100)}”</span></>
  if (node.nodeType === 8) return <><b>&lt;!--</b><span>{node.nodeValue.slice(0, 100)}</span><b>--&gt;</b></>
  if (node.nodeType !== 1) return <><b>#{node.nodeName.toLowerCase()}</b><span> {node.nodeValue.slice(0, 100)}</span></>
  const name = node.localName || node.nodeName.toLowerCase()
  return <><b>&lt;{name}</b><span>{attributeText(node)}</span><b>&gt;</b>{node.slotName && <em> slot {node.slotName}</em>}{node.isFrameBoundary && <em> iframe contents unavailable</em>}</>
}

export default function InspectorLayers({ session, selected, error, onSelect, onRefresh, onReconnect, onError }: Props) {
  const initialTreeState = useRef(cachedTreeState(session))
  const [nodes, setNodes] = useState<Map<number, InspectorDomNode>>(() => new Map(initialTreeState.current?.nodes || []))
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(initialTreeState.current?.expanded || []))
  const [loading, setLoading] = useState<Set<number>>(new Set())
  const [showInternals, setShowInternals] = useState(false)
  const [showWhitespace, setShowWhitespace] = useState(false)
  const [scrollTop, setScrollTop] = useState(initialTreeState.current?.scrollTop || 0)
  const [search, setSearch] = useState('')
  const [searchMode, setSearchMode] = useState<'text' | 'selector' | 'xpath'>('selector')
  const [searchResult, setSearchResult] = useState<{ count: number; nodes: InspectorDomNode[]; searchId?: string; start: number }>({ count: 0, nodes: [], start: 0 })
  const [searchIndex, setSearchIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; node: InspectorDomNode } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cacheKey = treeCacheKey(session)
    const cached = cacheKey ? treeStateCache.get(cacheKey) : undefined
    if (cached) {
      setNodes(new Map(cached.nodes))
      setExpanded(new Set(cached.expanded))
      setScrollTop(cached.scrollTop)
      requestAnimationFrame(() => {
        if (viewportRef.current) viewportRef.current.scrollTop = cached.scrollTop
      })
      setSearchResult({ count: 0, nodes: [], start: 0 })
      return
    }
    const next = new Map<number, InspectorDomNode>()
    if (session?.root) mergeNode(next, session.root)
    setNodes(next)
    const defaults = new Set<number>()
    if (session?.root) {
      defaults.add(session.root.ref.nodeId)
      for (const child of inspectorNodeChildren(session.root)) defaults.add(child.ref.nodeId)
    }
    setExpanded(defaults)
    setSearchResult({ count: 0, nodes: [], start: 0 })
  }, [session?.generation, session?.sessionId])

  useEffect(() => {
    const cacheKey = treeCacheKey(session)
    if (!cacheKey) return
    treeStateCache.set(cacheKey, {
      nodes: new Map(nodes),
      expanded: new Set(expanded),
      scrollTop
    })
    while (treeStateCache.size > 12) {
      const oldestKey = treeStateCache.keys().next().value
      if (typeof oldestKey !== 'string') break
      treeStateCache.delete(oldestKey)
    }
  }, [expanded, nodes, scrollTop, session?.generation, session?.sessionId])

  useEffect(() => {
    if (!session?.root) return
    setNodes(current => {
      const next = new Map(current)
      mergeNode(next, session.root)
      return next
    })
  }, [session?.root])

  useEffect(() => {
    if (!selected) return
    setNodes(current => {
      const next = new Map(current)
      mergeNode(next, selected)
      return next
    })
    setExpanded(current => {
      const next = new Set(current)
      for (const ancestor of selected.ancestors || []) next.add(ancestor.ref.nodeId)
      if (selected.parentId) next.add(selected.parentId)
      return next
    })
  }, [selected?.ref.generation, selected?.ref.nodeId])

  const rows = useMemo(() => {
    if (!session?.root) return []
    const result: FlatRow[] = []
    const visit = (node: InspectorDomNode, depth: number) => {
      if (!showInternals && node.isParityInternal) return
      result.push({ node, depth })
      if (!expanded.has(node.ref.nodeId)) return
      for (const child of visibleInspectorChildren(nodes.get(node.ref.nodeId) || node, showInternals, showWhitespace, selected?.ref.nodeId)) visit(child, depth + 1)
    }
    visit(nodes.get(session.root.ref.nodeId) || session.root, 0)
    return result
  }, [expanded, nodes, session?.root, selected?.ref.nodeId, showInternals, showWhitespace])

  const rowHeight = 24
  const viewportHeight = viewportRef.current?.clientHeight || 260
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 6)
  const visible = rows.slice(start, Math.min(rows.length, start + Math.ceil(viewportHeight / rowHeight) + 12))

  useEffect(() => {
    const index = rows.findIndex(row => row.node.ref.nodeId === selected?.ref.nodeId)
    if (index < 0 || !viewportRef.current) return
    const top = index * rowHeight
    const bottom = top + rowHeight
    if (top < viewportRef.current.scrollTop) viewportRef.current.scrollTop = top
    else if (bottom > viewportRef.current.scrollTop + viewportRef.current.clientHeight) viewportRef.current.scrollTop = bottom - viewportRef.current.clientHeight
  }, [rows, selected?.ref.nodeId])

  const loadChildren = async (node: InspectorDomNode) => {
    if (!session || node.isFrameBoundary) return
    const id = node.ref.nodeId
    if (expanded.has(id)) { setExpanded(current => { const next = new Set(current); next.delete(id); return next }); return }
    setExpanded(current => new Set(current).add(id))
    const currentNode = nodes.get(id) || node
    if (currentNode.childNodeCount === 0 || (currentNode.children && currentNode.children.length >= currentNode.childNodeCount)) return
    setLoading(current => new Set(current).add(id))
    try {
      const children = await window.electronAPI.inspectorChildren(node.ref)
      setNodes(current => {
        const next = new Map(current)
        const parent = next.get(id) || node
        parent.children = children.filter(child => !child.shadowRootType && !child.pseudoType)
        parent.shadowRoots = children.filter(child => !!child.shadowRootType)
        parent.pseudoElements = children.filter(child => !!child.pseudoType)
        next.set(id, { ...parent })
        children.forEach(child => mergeNode(next, child))
        return next
      })
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to load DOM children.') }
    finally { setLoading(current => { const next = new Set(current); next.delete(id); return next }) }
  }

  const runSearch = async () => {
    if (!session || !search.trim()) { setSearchResult({ count: 0, nodes: [], start: 0 }); return }
    try {
      if (searchResult.searchId) await window.electronAPI.inspectorDiscardSearch(session.sessionId, searchResult.searchId).catch(() => {})
      const result = await window.electronAPI.inspectorSearch(session.sessionId, session.generation, search.trim(), searchMode, 0)
      setSearchResult({ ...result, start: 0 }); setSearchIndex(0)
      if (result.nodes[0]) onSelect(result.nodes[0])
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'DOM search failed.') }
  }

  const selectSearch = async (offset: number) => {
    if (!session || !searchResult.count) return
    const next = (searchIndex + offset + searchResult.count) % searchResult.count
    if (next >= searchResult.start && next < searchResult.start + searchResult.nodes.length) {
      setSearchIndex(next); onSelect(searchResult.nodes[next - searchResult.start]); return
    }
    try {
      if (searchResult.searchId) await window.electronAPI.inspectorDiscardSearch(session.sessionId, searchResult.searchId).catch(() => {})
      const result = await window.electronAPI.inspectorSearch(session.sessionId, session.generation, search.trim(), searchMode, next)
      setSearchResult({ ...result, start: next }); setSearchIndex(next)
      if (result.nodes[0]) onSelect(result.nodes[0])
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'DOM search failed.') }
  }

  const editNode = async (node: InspectorDomNode, kind: 'attribute' | 'remove-attribute' | 'text' | 'outer' | 'delete' | 'duplicate') => {
    try {
      if (kind === 'attribute') {
        const name = window.prompt('Attribute name')?.trim(); if (!name) return
        const before = node.attributes.find(attribute => attribute.name === name)?.value || ''
        const value = window.prompt(`Value for ${name}`, before); if (value == null) return
        const updated = await window.electronAPI.inspectorEditDom({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, kind: 'set-attribute', name, value })
        if (updated) onSelect(updated)
      } else if (kind === 'remove-attribute') {
        const name = window.prompt('Attribute to remove', node.attributes[0]?.name || '')?.trim(); if (!name) return
        const updated = await window.electronAPI.inspectorEditDom({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, kind: 'remove-attribute', name })
        if (updated) onSelect(updated)
      } else if (kind === 'text') {
        const value = window.prompt('Text value', node.nodeValue); if (value == null) return
        const updated = await window.electronAPI.inspectorEditDom({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, kind: 'set-node-value', value })
        if (updated) onSelect(updated)
      } else if (kind === 'outer') {
        const before = await window.electronAPI.inspectorOuterHtml(node.ref)
        const value = window.prompt('Edit outer HTML', before); if (value == null || value === before) return
        const updated = await window.electronAPI.inspectorEditDom({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, kind: 'set-outer-html', value })
        if (updated) onSelect(updated)
        onRefresh()
      } else if (kind === 'delete') {
        if (!window.confirm(`Delete ${node.localName || node.nodeName}?`)) return
        await window.electronAPI.inspectorEditDom({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, kind: 'remove-node' })
        onRefresh()
      } else {
        const updated = await window.electronAPI.inspectorEditDom({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, kind: 'duplicate-node' })
        if (updated) onSelect(updated); onRefresh()
      }
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to edit DOM.') }
  }

  const copy = async (kind: 'selector' | 'html', node: InspectorDomNode) => {
    try {
      const value = kind === 'selector' ? await window.electronAPI.inspectorSelectorPath(node.ref) : await window.electronAPI.inspectorOuterHtml(node.ref)
      await navigator.clipboard.writeText(value)
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to copy.') }
  }

  const onTreeKeyDown = (event: React.KeyboardEvent) => {
    const index = rows.findIndex(row => row.node.ref.nodeId === selected?.ref.nodeId)
    if (event.key === 'ArrowDown' && rows[index + 1]) { event.preventDefault(); onSelect(rows[index + 1].node) }
    else if (event.key === 'ArrowUp' && rows[index - 1]) { event.preventDefault(); onSelect(rows[index - 1].node) }
    else if (event.key === 'ArrowRight' && selected) { event.preventDefault(); void loadChildren(selected) }
    else if (event.key === 'ArrowLeft' && selected) {
      event.preventDefault()
      if (expanded.has(selected.ref.nodeId)) setExpanded(current => { const next = new Set(current); next.delete(selected.ref.nodeId); return next })
      else if (selected.parentId && nodes.get(selected.parentId)) onSelect(nodes.get(selected.parentId)!)
    }
  }

  if (!session) return <div className="inspector-empty">{error || 'Waiting for the page inspector…'}</div>
  if (session.status === 'detached') return <div className="inspector-empty"><p>Chromium inspector disconnected.</p><button onClick={onReconnect}>Reconnect</button></div>

  return <div className="inspector-layers">
    <div className="inspector-dom-toolbar">
      <select value={searchMode} onChange={event => setSearchMode(event.target.value as typeof searchMode)} aria-label="DOM search mode"><option value="selector">CSS</option><option value="text">Text</option><option value="xpath">XPath</option></select>
      <input value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runSearch() }} placeholder="Search DOM" />
      <button onClick={() => void runSearch()} title="Search">⌕</button>
      <button onClick={onRefresh} title="Refresh DOM">↻</button>
    </div>
    {searchResult.count > 0 && <div className="inspector-search-status"><span>{Math.min(searchIndex + 1, searchResult.count)} / {searchResult.count}</span><button onClick={() => void selectSearch(-1)}>↑</button><button onClick={() => void selectSearch(1)}>↓</button></div>}
    {error && <div className="inspector-inline-error">{error}</div>}
    <div ref={viewportRef} className="inspector-tree-viewport" tabIndex={0} onKeyDown={onTreeKeyDown} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onClick={() => setMenu(null)}>
      <div className="inspector-tree-spacer" style={{ height: rows.length * rowHeight }}>
        {visible.map((row, visibleIndex) => {
          const index = start + visibleIndex
          const node = nodes.get(row.node.ref.nodeId) || row.node
          const hasChildren = visibleInspectorChildren(node, showInternals, showWhitespace, selected?.ref.nodeId).length > 0 || node.childNodeCount > (node.children?.length || 0)
          const isSelected = selected?.ref.nodeId === node.ref.nodeId
          const isSearch = searchResult.nodes.some(match => match.ref.nodeId === node.ref.nodeId)
          return <div key={`${node.ref.generation}:${node.ref.nodeId}`} className={`inspector-tree-row ${isSelected ? 'selected' : ''} ${isSearch ? 'search-match' : ''}`} style={{ top: index * rowHeight, paddingLeft: 4 + row.depth * 12 }} onMouseEnter={() => void window.electronAPI.inspectorHighlight(node.ref)} onMouseLeave={() => void window.electronAPI.inspectorHighlight(selected?.ref || null)} onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, node }) }}>
            {hasChildren && !node.isFrameBoundary ? <button className="inspector-tree-chevron" onClick={event => { event.stopPropagation(); void loadChildren(node) }}>{loading.has(node.ref.nodeId) ? '…' : expanded.has(node.ref.nodeId) ? '⌄' : '›'}</button> : <span className="inspector-tree-indent" />}
            <button className="inspector-tree-label" onClick={() => onSelect(node)} title={node.nodeType === 1 ? `<${node.localName || node.nodeName.toLowerCase()}${attributeText(node)}>` : node.nodeValue}><NodeLabel node={node} /></button>
          </div>
        })}
      </div>
    </div>
    <div className="inspector-tree-options">
      <label className="inspector-internals-toggle"><input type="checkbox" checked={showInternals} onChange={event => setShowInternals(event.target.checked)} /> Show Parity internals</label>
      <label className="inspector-internals-toggle"><input type="checkbox" checked={showWhitespace} onChange={event => setShowWhitespace(event.target.checked)} /> Show whitespace</label>
    </div>
    {menu && <div className="inspector-context-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
      {menu.node.parentId && nodes.get(menu.node.parentId) && <button onClick={() => { onSelect(nodes.get(menu.node.parentId!)!); setMenu(null) }}>Inspect parent</button>}
      <button onClick={() => { void window.electronAPI.inspectorScrollIntoView(menu.node.ref); setMenu(null) }}>Scroll into view</button>
      <button onClick={() => { void copy('selector', menu.node); setMenu(null) }}>Copy selector</button>
      <button onClick={() => { void copy('html', menu.node); setMenu(null) }}>Copy HTML</button>
      {menu.node.nodeType === 1 && <button onClick={() => { void editNode(menu.node, 'attribute'); setMenu(null) }}>Edit attribute…</button>}
      {menu.node.nodeType === 1 && menu.node.attributes.length > 0 && <button onClick={() => { void editNode(menu.node, 'remove-attribute'); setMenu(null) }}>Remove attribute…</button>}
      {menu.node.nodeType === 3 && <button onClick={() => { void editNode(menu.node, 'text'); setMenu(null) }}>Edit text…</button>}
      {menu.node.nodeType === 1 && <button onClick={() => { void editNode(menu.node, 'outer'); setMenu(null) }}>Edit outer HTML…</button>}
      {menu.node.nodeType === 1 && <button onClick={() => { void editNode(menu.node, 'duplicate'); setMenu(null) }}>Duplicate node</button>}
      {menu.node.nodeType !== 9 && <button className="danger" onClick={() => { void editNode(menu.node, 'delete'); setMenu(null) }}>Delete node</button>}
    </div>}
  </div>
}
