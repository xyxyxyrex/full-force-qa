import { useEffect, useRef, useState } from 'react'
import type { InspectorDeclaration, InspectorDomNode, InspectorRule, InspectorSessionSnapshot, InspectorStylesSnapshot } from '../../../shared/inspector'

interface Props {
  session: InspectorSessionSnapshot | null
  selected: InspectorDomNode | null
  snapshot: InspectorStylesSnapshot | null
  loading: boolean
  error?: string
  onSnapshot: (snapshot: InspectorStylesSnapshot) => void
  onNode: (node: InspectorDomNode) => void
  onError: (message: string) => void
}

function sourceLabel(rule: InspectorRule) {
  if (rule.kind === 'inline') return 'element.style'
  const url = rule.source?.url || ''
  const name = url ? decodeURIComponent(url.split('/').pop() || url) : rule.origin
  return `${name}:${rule.source?.line || 1}`
}

function stepCssValue(value: string, direction: number, large: boolean, fine: boolean) {
  const match = value.match(/(-?\d*\.?\d+)([a-z%]*)/i)
  if (!match || match.index == null) return value
  const step = fine ? .1 : large ? 10 : 1
  const number = Number(match[1]) + direction * step
  const precision = fine || match[1].includes('.') ? 1 : 0
  return `${value.slice(0, match.index)}${number.toFixed(precision)}${match[2]}${value.slice(match.index + match[0].length)}`
}

function DeclarationRow({ rule, declaration, node, revision, onSnapshot, onError }: { rule: InspectorRule; declaration: InspectorDeclaration; node: InspectorDomNode; revision: number; onSnapshot: (snapshot: InspectorStylesSnapshot) => void; onError: (message: string) => void }) {
  const [name, setName] = useState(declaration.name)
  const [value, setValue] = useState(declaration.value)
  const [invalid, setInvalid] = useState('')
  const draftId = useRef(`declaration-${node.ref.sessionId}-${declaration.id}-${Math.random().toString(36).slice(2)}`)
  const draftOpen = useRef(false)
  const invalidRef = useRef('')
  const previewTimer = useRef<number | undefined>(undefined)
  const operation = useRef<Promise<void>>(Promise.resolve())
  const setDraftError = (message: string) => { invalidRef.current = message; setInvalid(message) }
  useEffect(() => {
    setName(declaration.name); setValue(declaration.value); setDraftError('')
  }, [declaration.id, declaration.name, declaration.value])
  useEffect(() => () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    if (draftOpen.current) void window.electronAPI.inspectorEditDeclaration({
      sessionId: node.ref.sessionId,
      generation: node.ref.generation,
      nodeId: node.ref.nodeId,
      ruleId: rule.id,
      declarationId: declaration.id,
      name: declaration.name,
      value: declaration.value,
      draftId: draftId.current,
      phase: 'cancel',
    }).catch(() => undefined)
  }, [])
  const request = (nextName: string, nextValue: string, phase?: 'preview' | 'commit' | 'cancel', overrides: Partial<{ disabled: boolean; remove: boolean }> = {}) => window.electronAPI.inspectorEditDeclaration({
    sessionId: node.ref.sessionId,
    generation: node.ref.generation,
    nodeId: node.ref.nodeId,
    ruleId: rule.id,
    declarationId: declaration.id,
    name: nextName.trim(),
    value: nextValue.trim(),
    important: declaration.important,
    disabled: overrides.disabled ?? declaration.state === 'disabled',
    remove: overrides.remove,
    revision,
    draftId: phase ? draftId.current : undefined,
    phase,
  })
  const cancelDraft = async () => {
    if (!draftOpen.current) return
    const snapshot = await request(name, value, 'cancel')
    draftOpen.current = false
    onSnapshot(snapshot)
  }
  const schedulePreview = (nextName: string, nextValue: string) => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    setDraftError('')
    previewTimer.current = window.setTimeout(() => {
      operation.current = operation.current.then(async () => {
        try {
          await request(nextName, nextValue, 'preview')
          draftOpen.current = true
          setDraftError('')
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Invalid CSS declaration.'
          try { await cancelDraft() } catch { /* A concurrent source change is reported by the original error. */ }
          setDraftError(message)
        }
      })
    }, 160)
  }
  const commitDraft = () => {
    if (previewTimer.current) { window.clearTimeout(previewTimer.current); previewTimer.current = undefined }
    operation.current = operation.current.then(async () => {
      if (invalidRef.current) return
      try {
        const snapshot = draftOpen.current
          ? await request(name, value, 'commit')
          : await request(name, value)
        draftOpen.current = false
        setDraftError('')
        onSnapshot(snapshot)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Invalid CSS declaration.'
        setDraftError(message); onError(message)
      }
    })
  }
  const restore = () => {
    if (previewTimer.current) { window.clearTimeout(previewTimer.current); previewTimer.current = undefined }
    operation.current = operation.current.then(async () => {
      try { await cancelDraft() } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to restore the declaration.') }
      setName(declaration.name); setValue(declaration.value); setDraftError('')
    })
  }
  const save = async (overrides: Partial<{ disabled: boolean; value: string; remove: boolean }> = {}) => {
    if (rule.readOnly) return
    try {
      if (previewTimer.current) { window.clearTimeout(previewTimer.current); previewTimer.current = undefined }
      await operation.current
      const cancelledDraft = draftOpen.current
      await cancelDraft()
      const next = await window.electronAPI.inspectorEditDeclaration({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, ruleId: rule.id, declarationId: declaration.id, name: name.trim(), value: (overrides.value ?? value).trim(), important: declaration.important, disabled: overrides.disabled ?? declaration.state === 'disabled', remove: overrides.remove, revision: cancelledDraft ? undefined : revision })
      setDraftError(''); onSnapshot(next)
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'Invalid CSS declaration.'; setDraftError(message); onError(message) }
  }
  const hex = value.trim().match(/^#([\da-f]{6})$/i)?.[0]
  return <div className={`inspector-declaration ${declaration.state} ${invalid ? 'has-error' : ''}`} title={invalid || declaration.reason || declaration.state}>
    <input className="inspector-declaration-toggle" type="checkbox" checked={declaration.state !== 'disabled'} disabled={rule.readOnly} onChange={event => void save({ disabled: !event.target.checked })} aria-label={`Toggle ${declaration.name}`} />
    <input className="inspector-css-name" list="inspector-css-properties" value={name} readOnly={rule.readOnly} onChange={event => { setName(event.target.value); schedulePreview(event.target.value, value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitDraft() } else if (event.key === 'Escape') restore() }} onBlur={() => { if (name !== declaration.name || value !== declaration.value) commitDraft() }} />
    <span>:</span>
    {hex && <input className="inspector-color-swatch" type="color" value={hex} disabled={rule.readOnly} onChange={event => { setValue(event.target.value); void save({ value: event.target.value }) }} />}
    <input className="inspector-css-value" list="inspector-css-values" value={value} title={declaration.resolvedValue ? `Resolved: ${declaration.resolvedValue}` : undefined} readOnly={rule.readOnly} onChange={event => { setValue(event.target.value); schedulePreview(name, event.target.value) }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); commitDraft() }
      else if (event.key === 'Escape') restore()
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const next = stepCssValue(value, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey, event.altKey); setValue(next); schedulePreview(name, next) }
    }} onBlur={() => { if (name !== declaration.name || value !== declaration.value) commitDraft() }} />
    {declaration.important && <b className="inspector-important">!important</b>}<span>;</span>
    {!rule.readOnly && <button className="inspector-remove-declaration" onClick={() => void save({ remove: true })} title="Remove declaration">×</button>}
  </div>
}

function RuleBlock({ rule, node, revision, filter, onSnapshot, onError, onOpenSource }: { rule: InspectorRule; node: InspectorDomNode; revision: number; filter: string; onSnapshot: (snapshot: InspectorStylesSnapshot) => void; onError: (message: string) => void; onOpenSource: (rule: InspectorRule) => void }) {
  const [selector, setSelector] = useState(rule.selectorText)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  useEffect(() => setSelector(rule.selectorText), [rule.id, rule.selectorText])
  const declarations = rule.declarations.filter(declaration => !filter || `${declaration.name} ${declaration.value}`.toLowerCase().includes(filter.toLowerCase()))
  const saveSelector = async () => {
    if (rule.readOnly || selector === rule.selectorText) return
    try { onSnapshot(await window.electronAPI.inspectorEditSelector({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, ruleId: rule.id, selector, revision })) }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to edit selector.'); setSelector(rule.selectorText) }
  }
  const add = async () => {
    if (!newName.trim()) return
    try {
      onSnapshot(await window.electronAPI.inspectorEditDeclaration({ sessionId: node.ref.sessionId, generation: node.ref.generation, nodeId: node.ref.nodeId, ruleId: rule.id, name: newName.trim(), value: newValue.trim(), revision }))
      setAdding(false); setNewName(''); setNewValue('')
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to add declaration.') }
  }
  return <article id={`inspector-rule-${rule.id}`} className={`inspector-rule ${rule.kind} ${!rule.conditionActive ? 'inactive' : ''}`}>
    {rule.inheritedFrom && <div className="inspector-rule-group">Inherited from {rule.inheritedFrom.label}</div>}
    {rule.pseudoType && <div className="inspector-rule-group">Pseudo-element ::{rule.pseudoType}</div>}
    {rule.origin === 'user-agent' && <div className="inspector-rule-group">Browser defaults · read only</div>}
    {rule.contexts.map(context => <div key={context} className="inspector-rule-context">{context}</div>)}
    <header>
      {rule.kind === 'inline' ? <strong>element.style</strong> : <input value={selector} readOnly={rule.readOnly} onChange={event => setSelector(event.target.value)} onBlur={() => void saveSelector()} onKeyDown={event => { if (event.key === 'Enter') void saveSelector(); if (event.key === 'Escape') setSelector(rule.selectorText) }} title={rule.selectors.map(item => `${item.matches ? '✓' : '○'} ${item.text}`).join('\n')} />}
      <button className="inspector-source-link" onClick={() => onOpenSource(rule)} disabled={!rule.styleSheetId}>{sourceLabel(rule)}</button>
    </header>
    {rule.selectors.length > 1 && <div className="inspector-selector-list">{rule.selectors.map((item, index) => <span key={`${item.text}-${index}`} className={item.matches ? 'matches' : ''}>{item.text}</span>)}</div>}
    <div className="inspector-declarations">
      {declarations.map(declaration => <DeclarationRow key={declaration.id} rule={rule} declaration={declaration} node={node} revision={revision} onSnapshot={onSnapshot} onError={onError} />)}
      {!rule.readOnly && (adding ? <div className="inspector-new-declaration"><input autoFocus list="inspector-css-properties" value={newName} onChange={event => setNewName(event.target.value)} placeholder="property" /><span>:</span><input list="inspector-css-values" value={newValue} onChange={event => setNewValue(event.target.value)} placeholder="value" onKeyDown={event => { if (event.key === 'Enter') void add(); if (event.key === 'Escape') setAdding(false) }} /><button onClick={() => void add()}>Add</button></div> : <button className="inspector-add-declaration" onClick={() => setAdding(true)}>+ declaration</button>)}
    </div>
    {rule.kind !== 'inline' && !rule.readOnly && <footer>Affects matching elements in this preview</footer>}
    {rule.parityInjected && <footer>Parity inspector stylesheet</footer>}
  </article>
}

function numeric(value: string | undefined) { const parsed = Number.parseFloat(value || '0'); return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : 0 }

function SourceViewer({ source, onClose }: { source: { title: string; text: string; line: number }; onClose: () => void }) {
  const activeRef = useRef<HTMLSpanElement>(null)
  useEffect(() => activeRef.current?.scrollIntoView({ block: 'center' }), [source.line, source.text])
  return <div className="inspector-source-modal" onClick={onClose}><div onClick={event => event.stopPropagation()}><header><strong>{source.title}</strong><span>Line {source.line}</span><button onClick={onClose}>×</button></header><pre>{source.text.split('\n').map((line, index) => <span ref={index + 1 === source.line ? activeRef : undefined} className={index + 1 === source.line ? 'active' : ''} key={index}><i>{index + 1}</i>{line || ' '}</span>)}</pre></div></div>
}

export default function InspectorStyles({ session, selected, snapshot, loading, error, onSnapshot, onNode, onError }: Props) {
  const [tab, setTab] = useState<'rules' | 'computed' | 'layout'>('rules')
  const [filter, setFilter] = useState('')
  const [showAllComputed, setShowAllComputed] = useState(false)
  const [expandedComputed, setExpandedComputed] = useState<Set<string>>(new Set())
  const [newClass, setNewClass] = useState('')
  const [source, setSource] = useState<{ title: string; text: string; line: number } | null>(null)
  if (!session || !selected) return <div className="inspector-empty">Select an element on the page or in Layers.</div>
  if (loading && !snapshot) return <div className="inspector-empty">Reading Chromium styles…</div>
  if (!snapshot) return <div className="inspector-empty">Styles are unavailable for this node.</div>

  const inline = snapshot.rules.find(rule => rule.kind === 'inline')
  const updateClasses = async (classes: string[]) => {
    try {
      const node = await window.electronAPI.inspectorEditDom({ sessionId: selected.ref.sessionId, generation: selected.ref.generation, nodeId: selected.ref.nodeId, kind: 'set-attribute', name: 'class', value: [...new Set(classes)].join(' ') })
      if (node) onNode(node)
    } catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to update classes.') }
  }
  const addClass = () => { const value = newClass.trim(); if (!value) return; void updateClasses([...snapshot.classes, value]); setNewClass('') }
  const togglePseudo = async (state: string) => {
    const states = snapshot.forcedPseudoStates.includes(state) ? snapshot.forcedPseudoStates.filter(item => item !== state) : [...snapshot.forcedPseudoStates, state]
    try { onSnapshot(await window.electronAPI.inspectorForcePseudo(selected.ref, states)) }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to force element state.') }
  }
  const addRule = async () => {
    const initial = await window.electronAPI.inspectorSelectorPath(selected.ref).catch(() => selected.localName || '*')
    const selector = window.prompt('New rule selector', initial); if (!selector?.trim()) return
    try { onSnapshot(await window.electronAPI.inspectorAddRule(selected.ref, selector.trim())) }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to add CSS rule.') }
  }
  const openSource = async (rule: InspectorRule) => {
    if (!rule.styleSheetId) return
    try { const result = await window.electronAPI.inspectorStyleSheetText(session.sessionId, rule.styleSheetId); setSource({ title: result.url || 'Constructed stylesheet', text: result.text, line: rule.source?.line || 1 }) }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Unable to open stylesheet.') }
  }
  const setInline = async (name: string, value: string) => {
    if (!inline) { onError('Chromium did not expose an editable inline style for this element.'); return }
    try { onSnapshot(await window.electronAPI.inspectorEditDeclaration({ sessionId: selected.ref.sessionId, generation: selected.ref.generation, nodeId: selected.ref.nodeId, ruleId: inline.id, name, value, revision: snapshot.revision })) }
    catch (cause) { onError(cause instanceof Error ? cause.message : `Unable to edit ${name}.`) }
  }
  const addElementOverride = async () => {
    const name = window.prompt('Inline property name')?.trim()
    if (!name) return
    const value = window.prompt(`Value for ${name}`, computedMap.get(name) || '')
    if (value == null) return
    await setInline(name, value)
  }
  const computed = snapshot.computed.filter(property => showAllComputed || property.contributors.length || property.name.startsWith('--')).filter(property => !filter || `${property.name} ${property.value}`.toLowerCase().includes(filter.toLowerCase()))
  const computedMap = new Map(snapshot.computed.map(property => [property.name, property.value]))
  const boxGroups = [
    { label: 'Margin', names: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] },
    { label: 'Border', names: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'] },
    { label: 'Padding', names: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] },
  ]

  return <div className="inspector-styles">
    <datalist id="inspector-css-properties">{['color','background','background-color','display','position','top','right','bottom','left','width','height','margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','border','border-radius','font','font-family','font-size','font-weight','line-height','letter-spacing','text-align','opacity','overflow','transform','transition','animation','grid-template-columns','gap','align-items','justify-content','flex','flex-direction','box-shadow','z-index'].map(value => <option key={value} value={value} />)}</datalist>
    <datalist id="inspector-css-values">{['auto','none','block','inline','inline-block','flex','grid','relative','absolute','fixed','sticky','inherit','initial','unset','revert','transparent','currentColor'].map(value => <option key={value} value={value} />)}</datalist>
    <div className="inspector-style-tabs">{(['rules', 'computed', 'layout'] as const).map(value => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
    <div className="inspector-style-toolbar"><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={`Filter ${tab}`} />{tab === 'rules' && <><button onClick={() => void addElementOverride()} title="Add an inline declaration to this element">Element override</button><button onClick={() => void addRule()} title="Add rule">＋</button></>}</div>
    {error && <div className="inspector-inline-error">{error}</div>}
    {tab === 'rules' && <div className="inspector-rules-view">
      <div className="inspector-state-row"><span>Classes</span><div className="inspector-class-list">{snapshot.classes.map(value => <button key={value} onClick={() => void updateClasses(snapshot.classes.filter(item => item !== value))} title="Remove class">.{value} ×</button>)}<input value={newClass} onChange={event => setNewClass(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addClass() }} placeholder="+ class" /></div></div>
      <div className="inspector-state-row"><span>Force state</span><div className="inspector-pseudo-list">{['hover', 'active', 'focus', 'focus-visible', 'focus-within'].map(value => <button key={value} className={snapshot.forcedPseudoStates.includes(value) ? 'active' : ''} onClick={() => void togglePseudo(value)}>:{value}</button>)}</div></div>
      <div className="inspector-temporary-note">Temporary edits · reset on reload</div>
      {snapshot.rules.filter(rule => !filter || rule.selectorText.toLowerCase().includes(filter.toLowerCase()) || rule.declarations.some(declaration => `${declaration.name} ${declaration.value}`.toLowerCase().includes(filter.toLowerCase()))).map(rule => <RuleBlock key={rule.id} rule={rule} node={selected} revision={snapshot.revision} filter={filter} onSnapshot={onSnapshot} onError={onError} onOpenSource={openSource} />)}
      {!snapshot.rules.length && <div className="inspector-empty">No matched rules.</div>}
    </div>}
    {tab === 'computed' && <div className="inspector-computed-view">
      <label><input type="checkbox" checked={showAllComputed} onChange={event => setShowAllComputed(event.target.checked)} /> Show all</label>
      {computed.map(property => <div key={property.name} className="inspector-computed-row">
        <button onClick={() => setExpandedComputed(current => { const next = new Set(current); next.has(property.name) ? next.delete(property.name) : next.add(property.name); return next })}>{property.contributors.length ? expandedComputed.has(property.name) ? '⌄' : '›' : '·'}</button><b>{property.name}</b><span>{property.value}</span>{property.inherited && <em>inherited</em>}{property.influence && <em>{property.influence}</em>}
        {expandedComputed.has(property.name) && <div className="inspector-computed-sources">{property.contributors.map(contributor => { const rule = snapshot.rules.find(item => item.id === contributor.ruleId); return <button key={`${contributor.ruleId}:${contributor.declarationId}`} onClick={() => { setTab('rules'); requestAnimationFrame(() => document.getElementById(`inspector-rule-${contributor.ruleId}`)?.scrollIntoView({ block: 'center' })) }}>{rule?.selectorText || 'element.style'} · {rule ? sourceLabel(rule) : ''}</button> })}</div>}
      </div>)}
    </div>}
    {tab === 'layout' && <div className="inspector-layout-view">
      <div className="inspector-layout-summary"><span>{snapshot.layout.display || 'inline'}</span><span>{snapshot.layout.position || 'static'}</span>{snapshot.layout.isFlex && <button onClick={() => void window.electronAPI.inspectorSetLayoutOverlay(selected.ref, 'flex')}>Flex overlay</button>}{snapshot.layout.isGrid && <button onClick={() => void window.electronAPI.inspectorSetLayoutOverlay(selected.ref, 'grid')}>Grid overlay</button>}<button onClick={() => void window.electronAPI.inspectorSetLayoutOverlay(selected.ref, 'none')}>Hide overlay</button></div>
      <div className="inspector-box-model">
        <div className="margin-box">margin<div className="border-box">border<div className="padding-box">padding<div className="content-box">{snapshot.boxModel?.width || numeric(computedMap.get('width'))} × {snapshot.boxModel?.height || numeric(computedMap.get('height'))}</div></div></div></div>
      </div>
      {boxGroups.map(group => <section key={group.label} className="inspector-box-inputs"><h4>{group.label}</h4>{group.names.map(name => <label key={name}><span>{name.split('-').at(-1)}</span><input defaultValue={computedMap.get(name) || '0px'} onBlur={event => void setInline(name, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur() } }} /></label>)}</section>)}
    </div>}
    {source && <SourceViewer source={source} onClose={() => setSource(null)} />}
  </div>
}
