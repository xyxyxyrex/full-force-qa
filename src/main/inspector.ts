import { ipcMain, webContents as electronWebContents, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { acquireDebugger, type DebuggerLease } from './debuggerConnection'
import { analyzeInspectorCascade } from '../shared/inspectorCascade'
import type {
  InspectorApi,
  InspectorDeclaration,
  InspectorDeclarationEdit,
  InspectorDomEdit,
  InspectorDomNode,
  InspectorEvent,
  InspectorHistorySnapshot,
  InspectorNodeRef,
  InspectorRule,
  InspectorSearchResult,
  InspectorSelectorEdit,
  InspectorSessionSnapshot,
  InspectorSourceRange,
  InspectorStylesSnapshot,
} from '../shared/inspector'

interface HistoryEntry {
  id: string
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
  patch: Record<string, unknown>
}

interface DeclarationDraft {
  id: string
  nodeId: number
  ruleId: string
  kind: 'inline' | 'stylesheet'
  styleSheetId?: string
  before: string
  expected: string
  label: string
  patch: Record<string, unknown>
}

interface InspectorSession {
  id: string
  senderId: number
  webContentsId: number
  previewId: string
  projectId?: string
  generation: number
  status: 'ready' | 'detached' | 'navigated' | 'closed'
  revision: number
  lease: DebuggerLease
  releaseMessage: () => void
  releaseDetach: () => void
  releaseResume: () => void
  styleSheets: Map<string, any>
  nodeParents: Map<number, number | undefined>
  rootNodeId?: number
  frameId?: string
  forcedStates: Map<number, string[]>
  history: HistoryEntry[]
  historyIndex: number
  declarationDrafts: Map<string, DeclarationDraft>
  previewMutation?: { nodeId: number; styleSheetId?: string }
  mutationChain: Promise<void>
  updateTimer?: NodeJS.Timeout
}

const sessions = new Map<string, InspectorSession>()

function assertText(value: unknown, name: string, limit = 20_000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`Invalid ${name}.`)
  return value
}

function sessionFor(event: IpcMainInvokeEvent, sessionId: string): InspectorSession {
  const session = sessions.get(assertText(sessionId, 'inspector session', 100))
  if (!session || session.status === 'closed') throw new Error('The inspector session is no longer available.')
  if (session.senderId !== event.sender.id) throw new Error('This inspector session belongs to another window.')
  return session
}

function refSession(event: IpcMainInvokeEvent, ref: InspectorNodeRef): InspectorSession {
  const session = sessionFor(event, ref.sessionId)
  if (session.status !== 'ready') throw new Error('Inspector is disconnected. Reconnect it and try again.')
  if (ref.generation !== session.generation) throw new Error('The page changed. Select the element again.')
  if (!Number.isSafeInteger(ref.nodeId) || ref.nodeId <= 0) throw new Error('Invalid inspected node.')
  return session
}

function emit(session: InspectorSession, event: Omit<InspectorEvent, 'sessionId' | 'generation'>) {
  const sender = electronWebContents.fromId(session.senderId)
  if (!sender || sender.isDestroyed()) return
  sender.send('inspector:event', { sessionId: session.id, generation: session.generation, ...event } satisfies InspectorEvent)
}

function historySnapshot(session: InspectorSession): InspectorHistorySnapshot {
  return {
    entries: session.history.map((entry, index) => ({ id: entry.id, label: entry.label, applied: index <= session.historyIndex })),
    index: session.historyIndex,
  }
}

function emitHistory(session: InspectorSession) {
  emit(session, { type: 'history', history: historySnapshot(session) })
}

function range(value: any): InspectorSourceRange | undefined {
  if (!value || !Number.isFinite(value.startLine) || !Number.isFinite(value.startColumn)) return undefined
  return { startLine: value.startLine, startColumn: value.startColumn, endLine: value.endLine, endColumn: value.endColumn }
}

function attrs(raw: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(raw)) return []
  const result: Array<{ name: string; value: string }> = []
  for (let index = 0; index + 1 < raw.length; index += 2) result.push({ name: String(raw[index]), value: String(raw[index + 1]) })
  return result
}

function mapNode(session: InspectorSession, raw: any, parentId?: number): InspectorDomNode {
  const nodeId = Number(raw.nodeId || 0)
  if (nodeId) session.nodeParents.set(nodeId, parentId)
  const attributes = attrs(raw.attributes)
  const isParityInternal = attributes.some(attribute =>
    attribute.name === 'data-fullforce-beta-ui' ||
    (attribute.name === 'id' && /^__qa|^__fullforce/i.test(attribute.value)),
  ) || String(raw.nodeValue || '').startsWith('__fullforce_history_')
  const mapped: InspectorDomNode = {
    ref: { sessionId: session.id, generation: session.generation, nodeId, backendNodeId: Number(raw.backendNodeId || 0) },
    parentId,
    nodeType: Number(raw.nodeType || 0),
    nodeName: String(raw.nodeName || ''),
    localName: String(raw.localName || ''),
    nodeValue: String(raw.nodeValue || ''),
    attributes,
    childNodeCount: Number(raw.childNodeCount || raw.children?.length || 0),
    shadowRootType: raw.shadowRootType,
    pseudoType: raw.pseudoType,
    frameId: raw.frameId,
    isFrameBoundary: String(raw.localName || '').toLowerCase() === 'iframe' || !!raw.contentDocument,
    isParityInternal,
    slotName: String(raw.localName || '').toLowerCase() === 'slot' ? (attributes.find(attribute => attribute.name === 'name')?.value || '(default)') : undefined,
  }
  if (Array.isArray(raw.children)) mapped.children = raw.children.map((child: any) => mapNode(session, child, nodeId))
  if (Array.isArray(raw.shadowRoots)) mapped.shadowRoots = raw.shadowRoots.map((child: any) => mapNode(session, child, nodeId))
  if (Array.isArray(raw.pseudoElements)) mapped.pseudoElements = raw.pseudoElements.map((child: any) => mapNode(session, child, nodeId))
  return mapped
}

async function describe(session: InspectorSession, nodeId: number, depth = 1): Promise<InspectorDomNode> {
  const generation = session.generation
  const result = await session.lease.send('DOM.describeNode', { nodeId, depth, pierce: true })
  if (generation !== session.generation) throw new Error('The page changed while Chromium was reading the node.')
  return mapNode(session, result.node, session.nodeParents.get(nodeId))
}

async function describeWithAncestors(session: InspectorSession, nodeId: number): Promise<InspectorDomNode> {
  const generation = session.generation
  const resolved = await session.lease.send('DOM.resolveNode', { nodeId })
  const ancestry = await session.lease.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    returnByValue: false,
    functionDeclaration: `function(){
      const result=[]; let node=this;
      while(node){ result.unshift(node); node=node.parentNode || (node.host || null); }
      return result;
    }`,
  })
  const properties = await session.lease.send('Runtime.getProperties', { objectId: ancestry.result.objectId, ownProperties: true })
  const ordered = (properties.result || [])
    .filter((property: any) => /^\d+$/.test(property.name) && property.value?.objectId)
    .sort((left: any, right: any) => Number(left.name) - Number(right.name))
  const ids: number[] = []
  for (const property of ordered) {
    const requested = await session.lease.send('DOM.requestNode', { objectId: property.value.objectId })
    if (requested.nodeId) ids.push(requested.nodeId)
  }
  if (generation !== session.generation) throw new Error('The page changed while Chromium was resolving the selection.')
  const nodes: InspectorDomNode[] = []
  for (let index = 0; index < ids.length; index++) {
    const parentId = index > 0 ? ids[index - 1] : undefined
    session.nodeParents.set(ids[index], parentId)
    nodes.push(await describe(session, ids[index], 1))
  }
  const selected = nodes[nodes.length - 1] || await describe(session, nodeId, 1)
  selected.ancestors = nodes.slice(0, -1)
  return selected
}

async function documentSnapshot(session: InspectorSession): Promise<InspectorSessionSnapshot> {
  session.nodeParents.clear()
  const result = await session.lease.send('DOM.getDocument', { depth: 2, pierce: true })
  session.rootNodeId = Number(result.root.nodeId || 0)
  session.frameId = String(result.root.frameId || '') || session.frameId
  return { sessionId: session.id, previewId: session.previewId, generation: session.generation, status: session.status, root: mapNode(session, result.root) }
}

async function refreshDocumentSnapshot(session: InspectorSession): Promise<InspectorSessionSnapshot> {
  // DOM.getDocument replaces Chromium's frontend node-ID map. Running it while
  // a click is resolving (especially a fast #id selector) can invalidate the
  // node returned by DOM.querySelector before DOM.describeNode reads it. Keep
  // the existing document identity for ordinary mutation refreshes and fetch a
  // fresh document only after navigation has explicitly cleared the root.
  if (!session.rootNodeId) return documentSnapshot(session)
  const root = await describe(session, session.rootNodeId, 2)
  return { sessionId: session.id, previewId: session.previewId, generation: session.generation, status: session.status, root }
}

async function inspectedFrameId(session: InspectorSession): Promise<string> {
  if (session.frameId) return session.frameId
  const frameTree = await session.lease.send('Page.getFrameTree')
  const frameId = String(frameTree?.frameTree?.frame?.id || '')
  if (!frameId) throw new Error('Chromium did not provide a frame for the inspected document.')
  session.frameId = frameId
  return frameId
}

function scheduleUpdate(session: InspectorSession, type: 'dom-updated' | 'styles-updated', nodeId?: number, bumpRevision = true) {
  if (bumpRevision) session.revision++
  if (session.updateTimer) clearTimeout(session.updateTimer)
  session.updateTimer = setTimeout(() => {
    session.updateTimer = undefined
    emit(session, { type, nodeId })
  }, 40)
}

function handleProtocolMessage(session: InspectorSession, method: string, params: any) {
  if (method === 'CSS.styleSheetAdded' && params?.header?.styleSheetId) session.styleSheets.set(params.header.styleSheetId, params.header)
  if (method === 'CSS.styleSheetRemoved') session.styleSheets.delete(params.styleSheetId)
  if (method === 'DOM.documentUpdated') {
    session.generation++
    session.revision++
    session.nodeParents.clear()
    session.rootNodeId = undefined
    session.frameId = undefined
    session.forcedStates.clear()
    session.declarationDrafts.clear()
    session.history = []
    session.historyIndex = -1
    emit(session, { type: 'document-updated', status: 'navigated' })
    emitHistory(session)
    return
  }
  const domMutations = new Set([
    'DOM.attributeModified', 'DOM.attributeRemoved', 'DOM.characterDataModified',
    'DOM.childNodeCountUpdated', 'DOM.childNodeInserted', 'DOM.childNodeRemoved',
    'DOM.inlineStyleInvalidated', 'DOM.shadowRootPushed', 'DOM.shadowRootPopped',
    'DOM.pseudoElementAdded', 'DOM.pseudoElementRemoved', 'DOM.topLayerElementsUpdated',
  ])
  const previewNodeMutation = session.previewMutation?.nodeId === Number(params?.nodeId || params?.parentNodeId || 0)
  if (domMutations.has(method) && !previewNodeMutation) scheduleUpdate(session, 'dom-updated', Number(params?.nodeId || params?.parentNodeId || 0) || undefined)
  const cssUpdates = new Set([
    'CSS.styleSheetAdded', 'CSS.styleSheetRemoved', 'CSS.styleSheetChanged',
    'CSS.mediaQueryResultChanged', 'CSS.computedStyleUpdated', 'CSS.localFontsUpdated',
  ])
  const previewStyleMutation = method === 'CSS.styleSheetChanged' && session.previewMutation?.styleSheetId === params?.styleSheetId
  if (cssUpdates.has(method) && !previewStyleMutation) scheduleUpdate(session, 'styles-updated')
}

async function enable(session: InspectorSession) {
  await session.lease.send('DOM.enable', { includeWhitespace: 'all' })
  await session.lease.send('CSS.enable')
  await session.lease.send('Overlay.enable')
  session.status = 'ready'
}

async function stop(session: InspectorSession) {
  if (session.status === 'closed') return
  session.status = 'closed'
  if (session.updateTimer) clearTimeout(session.updateTimer)
  session.releaseMessage()
  session.releaseDetach()
  session.releaseResume()
  session.lease.release()
  sessions.delete(session.id)
}

function ruleContext(rule: any): { contexts: string[]; active: boolean } {
  const contexts: string[] = []
  let active = true
  const add = (prefix: string, values: any[]) => {
    for (const value of values || []) {
      const text = value?.text || value?.name || value?.styleSheetId || ''
      if (text) contexts.push(`${prefix} ${text}`)
      if (value?.active === false || value?.mediaList?.some?.((query: any) => query.active === false)) active = false
    }
  }
  add('@media', rule.media)
  add('@container', rule.containerQueries)
  add('@supports', rule.supports)
  add('@layer', rule.layers)
  add('@scope', rule.scopes)
  return { contexts, active }
}

function styleDeclarations(style: any, ruleId: string, conditionActive: boolean): InspectorDeclaration[] {
  const properties = style?.cssProperties || []
  const explicitlyAuthored = properties.filter((property: any) => property.range || property.text || property.disabled)
  // Chromium appends synthesized longhands and duplicate computed entries to
  // CSSStyle.cssProperties. When authored ranges are available, render only
  // those source entries; shorthand expansion is tracked separately.
  const visibleProperties = explicitlyAuthored.length ? explicitlyAuthored : properties
  const declarations: InspectorDeclaration[] = visibleProperties.map((property: any, index: number) => ({
    id: `${ruleId}:declaration:${index}`,
    name: String(property.name || ''),
    value: Boolean(property.important)
      ? String(property.value || '').replace(/\s*!important\s*$/i, '').trimEnd()
      : String(property.value || ''),
    important: Boolean(property.important),
    implicit: Boolean(property.implicit),
    text: property.text,
    range: range(property.range),
    state: property.disabled ? 'disabled' : property.parsedOk === false ? 'invalid' : conditionActive ? 'active' : 'inactive',
    reason: property.disabled ? 'Declaration disabled' : property.parsedOk === false ? 'Invalid declaration' : conditionActive ? undefined : 'Condition is inactive',
  }))
  const disabledPattern = /\/\*\s*([\w-]+)\s*:\s*([^;]*?)(\s*!important)?\s*;\s*\*\//gi
  let match: RegExpExecArray | null
  let disabledIndex = 0
  while ((match = disabledPattern.exec(String(style?.cssText || '')))) {
    if (declarations.some(item => item.state === 'disabled' && item.name === match![1] && item.value === match![2].trim())) continue
    declarations.push({
      id: `${ruleId}:disabled:${disabledIndex++}`,
      name: match[1],
      value: match[2].trim(),
      important: Boolean(match[3]),
      implicit: false,
      text: match[0],
      state: 'disabled',
      reason: 'Declaration disabled',
    })
  }
  return declarations
}

function sourceFor(session: InspectorSession, styleSheetId: string | undefined, style: any) {
  if (!styleSheetId) return undefined
  const header = session.styleSheets.get(styleSheetId)
  const location = style?.range
  return { url: String(header?.sourceURL || header?.sourceMapURL || ''), line: Number(location?.startLine || 0) + 1, column: Number(location?.startColumn || 0) + 1 }
}

function selectorRange(selectorList: any): InspectorSourceRange | undefined {
  const direct = range(selectorList?.range)
  if (direct) return direct
  const ranged = (selectorList?.selectors || []).map((selector: any) => range(selector.range)).filter(Boolean) as InspectorSourceRange[]
  if (!ranged.length) return undefined
  return {
    startLine: ranged[0].startLine,
    startColumn: ranged[0].startColumn,
    endLine: ranged[ranged.length - 1].endLine,
    endColumn: ranged[ranged.length - 1].endColumn,
  }
}

function mapRule(session: InspectorSession, match: any, index: number, kind: InspectorRule['kind'], inheritedFrom?: { nodeId: number; label: string }, pseudoType?: string): InspectorRule {
  const raw = match.rule || match
  const styleSheetId = raw.styleSheetId || raw.style?.styleSheetId
  const styleRange = range(raw.style?.range)
  const ruleId = `${kind}:${styleSheetId || 'inline'}:${styleRange?.startLine ?? 0}:${styleRange?.startColumn ?? 0}:${index}`
  const matching = new Set<number>(match.matchingSelectors || [])
  const context = ruleContext(raw)
  const selectors = (raw.selectorList?.selectors || []).map((selector: any, selectorIndex: number) => ({
    text: String(selector.text || ''),
    matches: matching.has(selectorIndex),
    specificity: selector.specificity ? { a: Number(selector.specificity.a || 0), b: Number(selector.specificity.b || 0), c: Number(selector.specificity.c || 0) } : undefined,
  }))
  const origin = String(raw.origin || 'regular')
  return {
    id: ruleId,
    kind,
    selectorText: String(raw.selectorList?.text || (kind === 'inline' ? 'element.style' : '')),
    selectors,
    declarations: styleDeclarations(raw.style, ruleId, context.active),
    origin,
    styleSheetId,
    styleRange,
    selectorRange: selectorRange(raw.selectorList),
    source: sourceFor(session, styleSheetId, raw.style),
    contexts: context.contexts,
    inheritedFrom,
    pseudoType,
    readOnly: origin === 'user-agent' || (kind !== 'inline' && (!styleSheetId || !styleRange)) || (kind === 'inherited' && !styleSheetId),
    parityInjected: origin === 'inspector' || String(session.styleSheets.get(styleSheetId)?.sourceURL || '').includes('fullforce'),
    conditionActive: context.active,
  }
}

async function stylesFor(session: InspectorSession, nodeId: number): Promise<InspectorStylesSnapshot> {
  const generation = session.generation
  const [matched, computedResult, boxResult, node, animatedResult] = await Promise.all([
    session.lease.send('CSS.getMatchedStylesForNode', { nodeId }),
    session.lease.send('CSS.getComputedStyleForNode', { nodeId }),
    session.lease.send('DOM.getBoxModel', { nodeId }).catch(() => null),
    describe(session, nodeId, 0),
    session.lease.send('CSS.getAnimatedStylesForNode', { nodeId }).catch(() => null),
  ])
  if (generation !== session.generation) throw new Error('The page changed while Chromium was reading styles.')
  const rules: InspectorRule[] = []
  if (matched.inlineStyle) rules.push(mapRule(session, { style: matched.inlineStyle, origin: 'regular', selectorList: { text: 'element.style', selectors: [] } }, 0, 'inline'))
  if (matched.attributesStyle) rules.push(mapRule(session, { style: matched.attributesStyle, origin: 'regular', selectorList: { text: 'HTML attributes', selectors: [] } }, rules.length, 'attributes'))
  for (const [index, match] of (matched.matchedCSSRules || []).entries()) rules.push(mapRule(session, match, index, 'rule'))
  for (const [ancestorIndex, inherited] of (matched.inherited || []).entries()) {
    const ancestor = inherited.inlineStyle || inherited.matchedCSSRules?.[0]?.rule
    const inheritedNodeId = Number(inherited.nodeId || 0) || -(ancestorIndex + 1)
    const inheritedFrom = { nodeId: inheritedNodeId, label: String(ancestor?.selectorList?.text || 'ancestor') }
    if (inherited.inlineStyle) rules.push(mapRule(session, { style: inherited.inlineStyle, origin: 'regular', selectorList: { text: 'element.style', selectors: [] } }, rules.length, 'inherited', inheritedFrom))
    if (inherited.attributesStyle) rules.push(mapRule(session, { style: inherited.attributesStyle, origin: 'regular', selectorList: { text: 'HTML attributes', selectors: [] } }, rules.length, 'inherited', inheritedFrom))
    for (const match of inherited.matchedCSSRules || []) rules.push(mapRule(session, match, rules.length, 'inherited', inheritedFrom))
  }
  for (const pseudo of matched.pseudoElements || []) {
    for (const match of pseudo.matches || []) rules.push(mapRule(session, match, rules.length, 'pseudo', undefined, pseudo.pseudoType))
  }
  const expansionCache = new Map<string, string[]>()
  await Promise.all(rules.flatMap(rule => rule.declarations.map(async declaration => {
    if (!declaration.name || declaration.name.startsWith('--')) return
    const key = `${declaration.name}\u0000${declaration.value}\u0000${declaration.important}`
    if (expansionCache.has(key)) {
      declaration.longhandNames = expansionCache.get(key)
      return
    }
    try {
      const result = await session.lease.send('CSS.getLonghandProperties', {
        shorthandEntry: {
          name: declaration.name,
          value: declaration.value,
          important: declaration.important,
          implicit: declaration.implicit,
        },
      })
      const names = (result.longhandProperties || []).map((item: any) => String(item.name || '')).filter(Boolean)
      expansionCache.set(key, names)
      declaration.longhandNames = names
    } catch {
      expansionCache.set(key, [])
      declaration.longhandNames = []
    }
  })))
  if (generation !== session.generation) throw new Error('The page changed while Chromium was analyzing styles.')
  analyzeInspectorCascade(rules)
  const contributorMap = new Map<string, Array<{ ruleId: string; declarationId: string }>>()
  for (const rule of rules) for (const declaration of rule.declarations) if (declaration.state === 'active') {
    for (const name of [declaration.name, ...(declaration.longhandNames || [])]) {
      const contributors = contributorMap.get(name) || []
      contributors.push({ ruleId: rule.id, declarationId: declaration.id })
      contributorMap.set(name, contributors)
    }
  }
  const animatedNames = new Set<string>((animatedResult?.animationStyles || []).flatMap((animation: any) => (animation.style?.cssProperties || animation.cssProperties || []).map((property: any) => String(property.name || ''))))
  const transitionedNames = new Set<string>((animatedResult?.transitionsStyle?.cssProperties || []).map((property: any) => String(property.name || '')))
  const computed = (computedResult.computedStyle || []).map((property: any) => ({
    name: String(property.name || ''), value: String(property.value || ''), inherited: rules.some(rule => rule.kind === 'inherited' && rule.declarations.some(item => item.name === property.name && item.state === 'active')),
    standard: !String(property.name || '').startsWith('--'), contributors: contributorMap.get(property.name) || [],
    influence: transitionedNames.has(property.name) ? 'transition' as const : animatedNames.has(property.name) ? 'animation' as const : undefined,
  }))
  const computedMap = new Map(computed.map((property: any) => [property.name, property.value]))
  for (const rule of rules) for (const declaration of rule.declarations) {
    if (declaration.value.includes('var(')) declaration.resolvedValue = String(computedMap.get(declaration.name) || '') || undefined
  }
  const classAttribute = node.attributes.find(attribute => attribute.name === 'class')?.value || ''
  return {
    node,
    rules,
    computed,
    boxModel: boxResult?.model ? { content: boxResult.model.content, padding: boxResult.model.padding, border: boxResult.model.border, margin: boxResult.model.margin, width: boxResult.model.width, height: boxResult.model.height, shapeOutside: boxResult.model.shapeOutside } : undefined,
    classes: classAttribute.split(/\s+/).filter(Boolean),
    forcedPseudoStates: session.forcedStates.get(nodeId) || [],
    layout: { display: String(computedMap.get('display') || ''), position: String(computedMap.get('position') || ''), isFlex: String(computedMap.get('display') || '').includes('flex'), isGrid: String(computedMap.get('display') || '').includes('grid') },
    revision: session.revision,
  }
}

async function getStyleSheetText(session: InspectorSession, styleSheetId: string): Promise<string> {
  return String((await session.lease.send('CSS.getStyleSheetText', { styleSheetId })).text || '')
}

async function commit(session: InspectorSession, entry: Omit<HistoryEntry, 'id'>) {
  session.history.splice(session.historyIndex + 1)
  session.history.push({ ...entry, id: randomUUID() })
  session.historyIndex = session.history.length - 1
  emitHistory(session)
}

function serializeStyle(declarations: InspectorDeclaration[]): string {
  return declarations.map(declaration => {
    const text = `${declaration.name}: ${declaration.value}${declaration.important ? ' !important' : ''};`
    return declaration.state === 'disabled'
      ? (declaration.text?.trim().startsWith('/*') ? declaration.text.trim() : `/* ${text} */`)
      : text
  }).join('\n')
}

function editedDeclarations(rule: InspectorRule, edit: InspectorDeclarationEdit): InspectorDeclaration[] {
  const next = rule.declarations.map(item => ({ ...item }))
  const existingIndex = edit.declarationId ? next.findIndex(item => item.id === edit.declarationId) : -1
  if (existingIndex >= 0) {
    if (edit.remove) next.splice(existingIndex, 1)
    else {
      next[existingIndex].name = assertText(edit.name, 'property name', 300).trim()
      next[existingIndex].value = assertText(edit.value, 'property value', 10_000).trim()
      next[existingIndex].important = Boolean(edit.important)
      next[existingIndex].state = edit.disabled ? 'disabled' : 'active'
    }
  } else next.push({ id: 'new', name: assertText(edit.name, 'property name', 300).trim(), value: assertText(edit.value, 'property value', 10_000).trim(), important: Boolean(edit.important), implicit: false, state: 'active' })
  return next
}

async function draftText(session: InspectorSession, draft: DeclarationDraft): Promise<string> {
  if (draft.kind === 'stylesheet') return getStyleSheetText(session, draft.styleSheetId!)
  const node = await describe(session, draft.nodeId, 0)
  return node.attributes.find(attribute => attribute.name === 'style')?.value || ''
}

async function writeDraftText(session: InspectorSession, draft: Pick<DeclarationDraft, 'kind' | 'nodeId' | 'styleSheetId'>, text: string) {
  session.previewMutation = { nodeId: draft.nodeId, styleSheetId: draft.styleSheetId }
  try {
    if (draft.kind === 'stylesheet') await session.lease.send('CSS.setStyleSheetText', { styleSheetId: draft.styleSheetId, text })
    else await session.lease.send('DOM.setAttributeValue', { nodeId: draft.nodeId, name: 'style', value: text })
  } finally { session.previewMutation = undefined }
}

async function assertValidDeclaration(session: InspectorSession, edit: InspectorDeclarationEdit) {
  if (edit.remove || edit.disabled) return
  const name = assertText(edit.name, 'property name', 300).trim()
  const value = assertText(edit.value, 'property value', 10_000).trim()
  if (!name || !value) throw new Error('Enter a CSS property and value.')
  const result = await session.lease.send('Runtime.evaluate', {
    expression: `CSS.supports(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
    returnByValue: true,
  })
  if (result?.result?.value !== true) throw new Error(`“${name}: ${value}” is not a valid CSS declaration.`)
}

async function mutateStyleSheet(session: InspectorSession, styleSheetId: string, label: string, mutation: () => Promise<void>, patch: Record<string, unknown>) {
  const before = await getStyleSheetText(session, styleSheetId)
  await mutation()
  const after = await getStyleSheetText(session, styleSheetId)
  if (before === after) return
  await commit(session, {
    label,
    undo: async () => { await session.lease.send('CSS.setStyleSheetText', { styleSheetId, text: before }) },
    redo: async () => { await session.lease.send('CSS.setStyleSheetText', { styleSheetId, text: after }) },
    patch,
  })
}

async function queueMutation<T>(session: InspectorSession, operation: () => Promise<T>): Promise<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const result = new Promise<T>((next, fail) => { resolve = next; reject = fail })
  session.mutationChain = session.mutationChain.then(async () => {
    try { resolve(await operation()) } catch (error) { reject(error) }
  }, async () => {
    try { resolve(await operation()) } catch (error) { reject(error) }
  })
  return result
}

async function requestNodeFromRemote(session: InspectorSession, result: any): Promise<InspectorDomNode | null> {
  const objectId = result?.result?.objectId
  if (!objectId || result?.result?.subtype === 'null') return null
  const requested = await session.lease.send('DOM.requestNode', { objectId })
  return requested.nodeId ? describe(session, requested.nodeId, 0) : null
}

async function anchorNode(session: InspectorSession, nodeId: number, html: string, action: 'replace' | 'remove' | 'duplicate') {
  const marker = `__fullforce_history_${randomUUID()}`
  const resolved = await session.lease.send('DOM.resolveNode', { nodeId })
  const result = await session.lease.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    returnByValue: false,
    arguments: [{ value: marker }, { value: html }, { value: action }],
    functionDeclaration: `function(marker, html, action) {
      const start = document.createComment(marker + ':start');
      const end = document.createComment(marker + ':end');
      if (action === 'duplicate') {
        const clone = this.cloneNode(true);
        this.after(start, clone, end);
        return clone;
      }
      this.before(start);
      this.after(end);
      if (action === 'remove') { this.remove(); return null; }
      this.outerHTML = html;
      return start.nextSibling === end ? null : start.nextSibling;
    }`,
  })
  return { marker, node: await requestNodeFromRemote(session, result) }
}

async function replaceAnchored(session: InspectorSession, marker: string, html: string): Promise<InspectorDomNode | null> {
  if (!session.rootNodeId) await documentSnapshot(session)
  const resolved = await session.lease.send('DOM.resolveNode', { nodeId: session.rootNodeId })
  const result = await session.lease.send('Runtime.callFunctionOn', {
    objectId: resolved.object.objectId,
    returnByValue: false,
    arguments: [{ value: marker }, { value: html }],
    functionDeclaration: `function(marker, html) {
      const walker = this.createTreeWalker(this, NodeFilter.SHOW_COMMENT);
      let start = null, end = null, node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue === marker + ':start') start = node;
        if (node.nodeValue === marker + ':end') { end = node; break; }
      }
      if (!start || !end || start.parentNode !== end.parentNode) throw new Error('The edited DOM location no longer exists.');
      while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
      if (html) {
        const range = this.createRange();
        range.setStartAfter(start); range.setEndBefore(end);
        end.before(range.createContextualFragment(html));
      }
      return start.nextSibling === end ? null : start.nextSibling;
    }`,
  })
  return requestNodeFromRemote(session, result)
}

async function startSession(event: IpcMainInvokeEvent, input: { webContentsId: number; previewId: string; projectId?: string }): Promise<InspectorSessionSnapshot> {
  const webContentsId = Number(input.webContentsId)
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) throw new Error('Invalid inspected page.')
  const previewId = assertText(input.previewId, 'preview ID', 200)
  const target = electronWebContents.fromId(webContentsId)
  if (!target || target.isDestroyed()) throw new Error('The inspected page is no longer available.')
  const hostId = Number((target as any).hostWebContents?.id || 0)
  if (target.id !== event.sender.id && hostId !== event.sender.id) throw new Error('The inspected page belongs to another window.')
  for (const existing of sessions.values()) if (existing.senderId === event.sender.id && existing.previewId === previewId) await stop(existing)
  const id = randomUUID()
  const lease = acquireDebugger(webContentsId, `inspector:${id}`)
  const session: InspectorSession = {
    id, senderId: event.sender.id, webContentsId, previewId, projectId: input.projectId, generation: 1, status: 'ready', revision: 0, lease,
    releaseMessage: () => {}, releaseDetach: () => {}, releaseResume: () => {}, styleSheets: new Map(), nodeParents: new Map(), forcedStates: new Map(), history: [], historyIndex: -1, declarationDrafts: new Map(), mutationChain: Promise.resolve(),
  }
  session.releaseMessage = lease.onMessage((method, params) => handleProtocolMessage(session, method, params))
  session.releaseDetach = lease.onDetach(reason => { session.status = 'detached'; emit(session, { type: 'status', status: 'detached' }); console.warn('[Inspector] Chromium debugger detached:', reason) })
  session.releaseResume = lease.onResume(() => {
    if (session.status !== 'ready') return
    session.revision++
    emit(session, { type: 'dom-updated' })
    emit(session, { type: 'styles-updated' })
  })
  sessions.set(id, session)
  event.sender.once('destroyed', () => {
    const owned = [...sessions.values()].filter(candidate => candidate.senderId === session.senderId)
    owned.forEach(candidate => { void stop(candidate) })
  })
  try { await enable(session); return await documentSnapshot(session) }
  catch (error) { await stop(session); throw error }
}

export function registerInspectorHandlers() {
  ipcMain.handle('inspector:start', startSession)
  ipcMain.handle('inspector:stop', async (event, sessionId: string) => { await stop(sessionFor(event, sessionId)) })
  ipcMain.handle('inspector:reconnect', async (event, sessionId: string) => {
    const session = sessionFor(event, sessionId)
    if (session.status === 'ready') return refreshDocumentSnapshot(session)
    session.lease = acquireDebugger(session.webContentsId, `inspector:${session.id}`)
    session.releaseMessage = session.lease.onMessage((method, params) => handleProtocolMessage(session, method, params))
    session.releaseDetach = session.lease.onDetach(() => { session.status = 'detached'; emit(session, { type: 'status', status: 'detached' }) })
    session.releaseResume = session.lease.onResume(() => {
      if (session.status !== 'ready') return
      session.revision++
      emit(session, { type: 'dom-updated' })
      emit(session, { type: 'styles-updated' })
    })
    session.generation++
    await enable(session)
    return documentSnapshot(session)
  })
  ipcMain.handle('inspector:children', async (event, ref: InspectorNodeRef) => {
    const session = refSession(event, ref)
    await session.lease.send('DOM.requestChildNodes', { nodeId: ref.nodeId, depth: 1, pierce: true })
    const node = await describe(session, ref.nodeId, 1)
    return [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]
  })
  ipcMain.handle('inspector:resolve-selector', async (event, sessionId: string, generation: number, selector: string) => {
    const session = sessionFor(event, sessionId)
    if (generation !== session.generation) throw new Error('The page changed. Select the element again.')
    if (!session.rootNodeId) await documentSnapshot(session)
    const result = await session.lease.send('DOM.querySelector', { nodeId: session.rootNodeId, selector: assertText(selector, 'selector', 10_000) })
    return result.nodeId ? describeWithAncestors(session, result.nodeId) : null
  })
  ipcMain.handle('inspector:get-node', (event, ref: InspectorNodeRef) => describe(refSession(event, ref), ref.nodeId, 1))
  ipcMain.handle('inspector:styles', (event, ref: InspectorNodeRef) => stylesFor(refSession(event, ref), ref.nodeId))
  ipcMain.handle('inspector:highlight', async (event, ref: InspectorNodeRef | null, mode = 'all') => {
    if (!ref) {
      const owned = [...sessions.values()].filter(session => session.senderId === event.sender.id && session.status === 'ready')
      await Promise.all(owned.map(session => session.lease.send('Overlay.hideHighlight').catch(() => undefined)))
      return
    }
    const session = refSession(event, ref)
    const transparent = { r: 0, g: 0, b: 0, a: 0 }
    const config: any = { showInfo: true, showStyles: false, showRulers: false, contentColor: { r: 59, g: 130, b: 246, a: mode === 'all' || mode === 'content' ? .25 : 0 }, paddingColor: mode === 'all' || mode === 'padding' ? { r: 74, g: 222, b: 128, a: .22 } : transparent, borderColor: mode === 'all' || mode === 'border' ? { r: 250, g: 204, b: 21, a: .32 } : transparent, marginColor: mode === 'all' || mode === 'margin' ? { r: 251, g: 146, b: 60, a: .24 } : transparent }
    await session.lease.send('Overlay.highlightNode', { nodeId: ref.nodeId, highlightConfig: config })
  })
  ipcMain.handle('inspector:scroll-into-view', async (event, ref: InspectorNodeRef) => { await refSession(event, ref).lease.send('DOM.scrollIntoViewIfNeeded', { nodeId: ref.nodeId }) })
  ipcMain.handle('inspector:search', async (event, sessionId: string, generation: number, query: string, mode: string, fromIndex = 0): Promise<InspectorSearchResult> => {
    const session = sessionFor(event, sessionId)
    if (generation !== session.generation) throw new Error('The page changed. Search again.')
    const raw = assertText(query, 'search query', 5_000).trim()
    const resolved = mode === 'text' ? raw : raw
    const search = await session.lease.send('DOM.performSearch', { query: resolved, includeUserAgentShadowDOM: false })
    const start = Math.max(0, Math.min(Number(fromIndex) || 0, Math.max(0, search.resultCount - 1)))
    const end = Math.min(search.resultCount, start + 50)
    const found = end > start ? await session.lease.send('DOM.getSearchResults', { searchId: search.searchId, fromIndex: start, toIndex: end }) : { nodeIds: [] }
    if (generation !== session.generation) throw new Error('The page changed while Chromium was searching.')
    const nodes = await Promise.all((found.nodeIds || []).map((nodeId: number) => describe(session, nodeId, 0)))
    return { searchId: search.searchId, count: search.resultCount, nodes }
  })
  ipcMain.handle('inspector:discard-search', async (event, sessionId: string, searchId: string) => { await sessionFor(event, sessionId).lease.send('DOM.discardSearchResults', { searchId }) })
  ipcMain.handle('inspector:outer-html', async (event, ref: InspectorNodeRef) => String((await refSession(event, ref).lease.send('DOM.getOuterHTML', { nodeId: ref.nodeId })).outerHTML || ''))
  ipcMain.handle('inspector:selector-path', async (event, ref: InspectorNodeRef) => {
    const session = refSession(event, ref)
    const resolved = await session.lease.send('DOM.resolveNode', { nodeId: ref.nodeId })
    const result = await session.lease.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      returnByValue: true,
      functionDeclaration: `function(){
        if (this === document.documentElement) return 'html';
        const escape = value => CSS.escape(String(value));
        if (this.id && document.querySelectorAll('#' + escape(this.id)).length === 1) return '#' + escape(this.id);
        const parts=[]; let node=this;
        while(node && node.nodeType===1 && node!==document.documentElement){
          let part=node.localName;
          if(node.id){ part+='#'+escape(node.id); parts.unshift(part); break; }
          const classes=Array.from(node.classList||[]).slice(0,3); if(classes.length) part+='.'+classes.map(escape).join('.');
          const parent=node.parentElement;
          if(parent){ const peers=Array.from(parent.children).filter(child=>child.localName===node.localName); if(peers.length>1) part+=':nth-of-type('+(peers.indexOf(node)+1)+')'; }
          parts.unshift(part); node=parent;
        }
        return parts.join(' > ');
      }`,
    })
    return String(result.result?.value || '')
  })
  ipcMain.handle('inspector:stylesheet-text', async (event, sessionId: string, styleSheetId: string) => {
    const session = sessionFor(event, sessionId)
    return { text: await getStyleSheetText(session, styleSheetId), url: String(session.styleSheets.get(styleSheetId)?.sourceURL || '') }
  })
  ipcMain.handle('inspector:edit-declaration', async (event, edit: InspectorDeclarationEdit) => {
    const session = refSession(event, { sessionId: edit.sessionId, generation: edit.generation, nodeId: edit.nodeId, backendNodeId: 0 })
    return queueMutation(session, async () => {
      if (edit.phase && !new Set(['preview', 'commit', 'cancel']).has(edit.phase)) throw new Error('Invalid CSS draft phase.')
      const draftId = edit.draftId ? assertText(edit.draftId, 'draft ID', 200) : undefined
      if (edit.phase === 'preview' && !draftId) throw new Error('A CSS preview requires a draft ID.')
      const existingDraft = draftId ? session.declarationDrafts.get(draftId) : undefined
      if (existingDraft && (existingDraft.nodeId !== edit.nodeId || existingDraft.ruleId !== edit.ruleId)) throw new Error('This CSS draft belongs to another declaration.')

      if (edit.phase === 'cancel') {
        if (!existingDraft) return stylesFor(session, edit.nodeId)
        const current = await draftText(session, existingDraft)
        if (current !== existingDraft.expected) {
          session.declarationDrafts.delete(existingDraft.id)
          throw new Error('The stylesheet changed while you were editing. Your draft was not applied over the newer source.')
        }
        await writeDraftText(session, existingDraft, existingDraft.before)
        session.declarationDrafts.delete(existingDraft.id)
        session.revision++
        return stylesFor(session, edit.nodeId)
      }

      if (edit.phase === 'commit' && existingDraft) {
        const after = await draftText(session, existingDraft)
        if (after !== existingDraft.expected) {
          session.declarationDrafts.delete(existingDraft.id)
          throw new Error('The stylesheet changed while you were editing. Resolve the newer source before retrying.')
        }
        await commit(session, {
          label: existingDraft.label,
          undo: async () => { await writeDraftText(session, existingDraft, existingDraft.before) },
          redo: async () => { await writeDraftText(session, existingDraft, after) },
          patch: existingDraft.patch,
        })
        session.declarationDrafts.delete(existingDraft.id)
        session.revision++
        return stylesFor(session, edit.nodeId)
      }

      if (!existingDraft && edit.revision != null && edit.revision !== session.revision) throw new Error('The stylesheet changed. Refresh Styles and retry this edit.')
      if (edit.phase === 'preview') await assertValidDeclaration(session, edit)

      if (existingDraft) {
        const current = await draftText(session, existingDraft)
        if (current !== existingDraft.expected) {
          session.declarationDrafts.delete(existingDraft.id)
          throw new Error('The stylesheet changed while you were editing. Your draft was preserved for review.')
        }
        await writeDraftText(session, existingDraft, existingDraft.before)
      }
      const snapshot = await stylesFor(session, edit.nodeId)
      const rule = snapshot.rules.find(item => item.id === edit.ruleId)
      if (!rule) throw new Error('The CSS rule changed. Refresh Styles and try again.')
      const next = editedDeclarations(rule, edit)
      const label = `${rule.kind === 'inline' ? 'Style' : 'Rule'} · ${edit.name}`
      const patch = { type: 'inspectorDeclaration', nodeId: edit.nodeId, ruleId: rule.id, name: edit.name, value: edit.value }
      if (rule.kind === 'inline' && (!rule.styleSheetId || !rule.styleRange)) {
        const before = snapshot.node.attributes.find(attribute => attribute.name === 'style')?.value || ''
        const after = serializeStyle(next)
        const target = { kind: 'inline' as const, nodeId: edit.nodeId }
        await writeDraftText(session, target, after)
        if (edit.phase === 'preview' && draftId) session.declarationDrafts.set(draftId, { id: draftId, nodeId: edit.nodeId, ruleId: rule.id, kind: 'inline', before: existingDraft?.before ?? before, expected: after, label, patch })
        else await commit(session, { label, undo: async () => { await writeDraftText(session, target, before) }, redo: async () => { await writeDraftText(session, target, after) }, patch })
      } else {
        if (!rule.styleSheetId || !rule.styleRange || rule.readOnly) throw new Error('This browser or generated rule is read-only.')
        const before = await getStyleSheetText(session, rule.styleSheetId)
        session.previewMutation = { nodeId: edit.nodeId, styleSheetId: rule.styleSheetId }
        try { await session.lease.send('CSS.setStyleTexts', { edits: [{ styleSheetId: rule.styleSheetId, range: rule.styleRange, text: serializeStyle(next) }] }) }
        finally { session.previewMutation = undefined }
        const after = await getStyleSheetText(session, rule.styleSheetId)
        const target = { kind: 'stylesheet' as const, nodeId: edit.nodeId, styleSheetId: rule.styleSheetId }
        if (edit.phase === 'preview' && draftId) session.declarationDrafts.set(draftId, { id: draftId, nodeId: edit.nodeId, ruleId: rule.id, kind: 'stylesheet', styleSheetId: rule.styleSheetId, before: existingDraft?.before ?? before, expected: after, label, patch })
        else await commit(session, { label, undo: async () => { await writeDraftText(session, target, before) }, redo: async () => { await writeDraftText(session, target, after) }, patch })
      }
      if (edit.phase !== 'preview') session.revision++
      return stylesFor(session, edit.nodeId)
    })
  })
  ipcMain.handle('inspector:edit-selector', async (event, edit: InspectorSelectorEdit) => {
    const session = refSession(event, { sessionId: edit.sessionId, generation: edit.generation, nodeId: edit.nodeId, backendNodeId: 0 })
    return queueMutation(session, async () => {
      if (edit.revision != null && edit.revision !== session.revision) throw new Error('The stylesheet changed. Refresh Styles and retry this edit.')
      const snapshot = await stylesFor(session, edit.nodeId)
      const rule = snapshot.rules.find(item => item.id === edit.ruleId)
      if (!rule?.styleSheetId || !rule.selectorRange || rule.readOnly) throw new Error('This selector cannot be edited.')
      const selector = assertText(edit.selector, 'selector', 10_000).trim()
      await mutateStyleSheet(session, rule.styleSheetId, 'Edit selector', async () => { await session.lease.send('CSS.setRuleSelector', { styleSheetId: rule.styleSheetId, range: rule.selectorRange, selector }) }, { type: 'inspectorSelector', ruleId: rule.id, selector })
      session.revision++
      return stylesFor(session, edit.nodeId)
    })
  })
  ipcMain.handle('inspector:add-rule', async (event, ref: InspectorNodeRef, selector: string) => {
    const session = refSession(event, ref)
    return queueMutation(session, async () => {
      const frameId = await inspectedFrameId(session)
      let created: any
      try { created = await session.lease.send('CSS.createStyleSheet', { frameId }) }
      catch (error) { throw new Error(`Unable to create an inspector stylesheet: ${error instanceof Error ? error.message : String(error)}`) }
      const styleSheetId = created.styleSheetId
      const ruleText = `${assertText(selector, 'selector', 10_000).trim()} {\n  \n}`
      // A stylesheet created through CSS.createStyleSheet is empty. Chromium's
      // CSS.addRule rejects an insertion range until that sheet has a source
      // range, so seed it through the stylesheet-text API. Subsequent rule
      // edits still use their precise CDP source ranges.
      await mutateStyleSheet(session, styleSheetId, 'Add CSS rule', async () => {
        try { await session.lease.send('CSS.setStyleSheetText', { styleSheetId, text: ruleText }) }
        catch (error) { throw new Error(`Unable to write the inspector stylesheet: ${error instanceof Error ? error.message : String(error)}`) }
      }, { type: 'inspectorAddRule', selector })
      session.revision++
      return stylesFor(session, ref.nodeId)
    })
  })
  ipcMain.handle('inspector:force-pseudo', async (event, ref: InspectorNodeRef, states: string[]) => {
    const session = refSession(event, ref)
    const allowed = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within'])
    const forcedPseudoClasses = [...new Set((states || []).filter(state => allowed.has(state)))]
    const before = session.forcedStates.get(ref.nodeId) || []
    await session.lease.send('CSS.forcePseudoState', { nodeId: ref.nodeId, forcedPseudoClasses })
    session.forcedStates.set(ref.nodeId, forcedPseudoClasses)
    await commit(session, {
      label: `Force state · ${forcedPseudoClasses.length ? forcedPseudoClasses.map(value => `:${value}`).join(' ') : 'none'}`,
      undo: async () => { await session.lease.send('CSS.forcePseudoState', { nodeId: ref.nodeId, forcedPseudoClasses: before }); session.forcedStates.set(ref.nodeId, before) },
      redo: async () => { await session.lease.send('CSS.forcePseudoState', { nodeId: ref.nodeId, forcedPseudoClasses }); session.forcedStates.set(ref.nodeId, forcedPseudoClasses) },
      patch: { type: 'inspectorForcePseudo', nodeId: ref.nodeId, states: forcedPseudoClasses },
    })
    session.revision++
    return stylesFor(session, ref.nodeId)
  })
  ipcMain.handle('inspector:layout-overlay', async (event, ref: InspectorNodeRef, kind: string) => {
    const session = refSession(event, ref)
    await session.lease.send('Overlay.setShowFlexOverlays', { flexNodeHighlightConfigs: kind === 'flex' ? [{ nodeId: ref.nodeId, flexContainerHighlightConfig: { containerBorder: { color: { r: 59, g: 130, b: 246, a: .9 }, pattern: 'dashed' }, itemSeparator: { color: { r: 244, g: 114, b: 182, a: .8 }, pattern: 'dotted' } } }] : [] })
    await session.lease.send('Overlay.setShowGridOverlays', { gridNodeHighlightConfigs: kind === 'grid' ? [{ nodeId: ref.nodeId, gridHighlightConfig: { showGridExtensionLines: true, showPositiveLineNumbers: true, rowLineColor: { r: 59, g: 130, b: 246, a: .7 }, columnLineColor: { r: 244, g: 114, b: 182, a: .7 } } }] : [] })
  })
  ipcMain.handle('inspector:edit-dom', async (event, edit: InspectorDomEdit) => {
    const session = refSession(event, { sessionId: edit.sessionId, generation: edit.generation, nodeId: edit.nodeId, backendNodeId: 0 })
    return queueMutation(session, async () => {
      const beforeNode = await describe(session, edit.nodeId, 0)
      if (edit.kind === 'set-attribute') {
        const name = assertText(edit.name, 'attribute name', 500).trim(); const value = assertText(edit.value, 'attribute value', 20_000)
        const before = beforeNode.attributes.find(attribute => attribute.name === name)
        await session.lease.send('DOM.setAttributeValue', { nodeId: edit.nodeId, name, value })
        await commit(session, { label: `Attribute · ${name}`, undo: async () => { if (before) await session.lease.send('DOM.setAttributeValue', { nodeId: edit.nodeId, name, value: before.value }); else await session.lease.send('DOM.removeAttribute', { nodeId: edit.nodeId, name }) }, redo: async () => { await session.lease.send('DOM.setAttributeValue', { nodeId: edit.nodeId, name, value }) }, patch: { type: 'inspectorAttribute', nodeId: edit.nodeId, name, value } })
      } else if (edit.kind === 'remove-attribute') {
        const name = assertText(edit.name, 'attribute name', 500).trim(); const before = beforeNode.attributes.find(attribute => attribute.name === name)
        await session.lease.send('DOM.removeAttribute', { nodeId: edit.nodeId, name })
        if (before) await commit(session, { label: `Remove attribute · ${name}`, undo: async () => { await session.lease.send('DOM.setAttributeValue', { nodeId: edit.nodeId, name, value: before.value }) }, redo: async () => { await session.lease.send('DOM.removeAttribute', { nodeId: edit.nodeId, name }) }, patch: { type: 'inspectorRemoveAttribute', nodeId: edit.nodeId, name } })
      } else if (edit.kind === 'set-node-value') {
        const value = assertText(edit.value, 'node value', 200_000); const before = beforeNode.nodeValue
        await session.lease.send('DOM.setNodeValue', { nodeId: edit.nodeId, value })
        await commit(session, { label: 'Edit text', undo: async () => { await session.lease.send('DOM.setNodeValue', { nodeId: edit.nodeId, value: before }) }, redo: async () => { await session.lease.send('DOM.setNodeValue', { nodeId: edit.nodeId, value }) }, patch: { type: 'inspectorNodeValue', nodeId: edit.nodeId, value } })
      } else if (edit.kind === 'set-outer-html') {
        const value = assertText(edit.value, 'outer HTML', 1_000_000); const before = String((await session.lease.send('DOM.getOuterHTML', { nodeId: edit.nodeId })).outerHTML || '')
        const replacement = await anchorNode(session, edit.nodeId, value, 'replace')
        await commit(session, { label: 'Edit outer HTML', undo: async () => { await replaceAnchored(session, replacement.marker, before) }, redo: async () => { await replaceAnchored(session, replacement.marker, value) }, patch: { type: 'inspectorOuterHtml', before, value } })
        emit(session, { type: 'selection-invalidated', nodeId: edit.nodeId })
        return replacement.node
      } else if (edit.kind === 'remove-node') {
        const before = String((await session.lease.send('DOM.getOuterHTML', { nodeId: edit.nodeId })).outerHTML || '')
        const removal = await anchorNode(session, edit.nodeId, before, 'remove')
        await commit(session, { label: 'Delete element', undo: async () => { await replaceAnchored(session, removal.marker, before) }, redo: async () => { await replaceAnchored(session, removal.marker, '') }, patch: { type: 'inspectorRemoveNode', before } })
        emit(session, { type: 'selection-invalidated', nodeId: edit.nodeId })
        return null
      } else if (edit.kind === 'duplicate-node') {
        const html = String((await session.lease.send('DOM.getOuterHTML', { nodeId: edit.nodeId })).outerHTML || '')
        const duplicate = await anchorNode(session, edit.nodeId, html, 'duplicate')
        await commit(session, { label: 'Duplicate element', undo: async () => { await replaceAnchored(session, duplicate.marker, '') }, redo: async () => { await replaceAnchored(session, duplicate.marker, html) }, patch: { type: 'inspectorDuplicateNode', html } })
        scheduleUpdate(session, 'dom-updated', duplicate.node?.ref.nodeId)
        return duplicate.node
      }
      scheduleUpdate(session, 'dom-updated', edit.nodeId)
      return describe(session, edit.nodeId, 0)
    })
  })
  ipcMain.handle('inspector:undo', async (event, sessionId: string) => {
    const session = sessionFor(event, sessionId)
    if (session.historyIndex < 0) return historySnapshot(session)
    await queueMutation(session, async () => { await session.history[session.historyIndex].undo(); session.historyIndex--; emitHistory(session) })
    return historySnapshot(session)
  })
  ipcMain.handle('inspector:redo', async (event, sessionId: string) => {
    const session = sessionFor(event, sessionId)
    if (session.historyIndex + 1 >= session.history.length) return historySnapshot(session)
    await queueMutation(session, async () => { session.historyIndex++; await session.history[session.historyIndex].redo(); emitHistory(session) })
    return historySnapshot(session)
  })
  ipcMain.handle('inspector:history', (event, sessionId: string) => historySnapshot(sessionFor(event, sessionId)))
  ipcMain.handle('inspector:patches', (event, sessionId: string) => {
    const session = sessionFor(event, sessionId)
    return session.history.slice(0, session.historyIndex + 1).map(entry => entry.patch)
  })
}

export type { InspectorApi }
