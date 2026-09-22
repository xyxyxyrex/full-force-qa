export type InspectorSessionStatus = 'ready' | 'detached' | 'navigated' | 'closed'

export interface InspectorNodeRef {
  sessionId: string
  generation: number
  nodeId: number
  backendNodeId: number
}

export interface InspectorAttribute { name: string; value: string }

export interface InspectorDomNode {
  ref: InspectorNodeRef
  parentId?: number
  nodeType: number
  nodeName: string
  localName: string
  nodeValue: string
  attributes: InspectorAttribute[]
  childNodeCount: number
  children?: InspectorDomNode[]
  shadowRoots?: InspectorDomNode[]
  pseudoElements?: InspectorDomNode[]
  ancestors?: InspectorDomNode[]
  shadowRootType?: string
  pseudoType?: string
  frameId?: string
  isFrameBoundary?: boolean
  isParityInternal?: boolean
  slotName?: string
}

export interface InspectorSourceLocation {
  url: string
  line: number
  column: number
}

export interface InspectorSourceRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export type InspectorDeclarationState = 'active' | 'overridden' | 'disabled' | 'invalid' | 'inactive'

export interface InspectorDeclaration {
  id: string
  name: string
  value: string
  important: boolean
  implicit: boolean
  text?: string
  range?: InspectorSourceRange
  state: InspectorDeclarationState
  reason?: string
  resolvedValue?: string
  longhandNames?: string[]
}

export interface InspectorSelector {
  text: string
  matches: boolean
  specificity?: { a: number; b: number; c: number }
}

export interface InspectorRule {
  id: string
  kind: 'inline' | 'rule' | 'inherited' | 'pseudo' | 'attributes'
  selectorText: string
  selectors: InspectorSelector[]
  declarations: InspectorDeclaration[]
  origin: string
  styleSheetId?: string
  styleRange?: InspectorSourceRange
  selectorRange?: InspectorSourceRange
  source?: InspectorSourceLocation
  contexts: string[]
  inheritedFrom?: { nodeId: number; label: string }
  pseudoType?: string
  readOnly: boolean
  parityInjected: boolean
  conditionActive: boolean
}

export interface InspectorComputedProperty {
  name: string
  value: string
  inherited: boolean
  standard: boolean
  contributors: Array<{ ruleId: string; declarationId: string }>
  influence?: 'animation' | 'transition'
}

export interface InspectorBoxModel {
  content: number[]
  padding: number[]
  border: number[]
  margin: number[]
  width: number
  height: number
  shapeOutside?: { bounds: number[]; shape: unknown; marginShape: unknown }
}

export interface InspectorStylesSnapshot {
  node: InspectorDomNode
  rules: InspectorRule[]
  computed: InspectorComputedProperty[]
  boxModel?: InspectorBoxModel
  classes: string[]
  forcedPseudoStates: string[]
  layout: { display: string; position: string; isFlex: boolean; isGrid: boolean }
  revision: number
}

export interface InspectorSessionSnapshot {
  sessionId: string
  previewId: string
  generation: number
  status: InspectorSessionStatus
  root: InspectorDomNode
}

export interface InspectorSearchResult {
  searchId: string
  count: number
  nodes: InspectorDomNode[]
}

export interface InspectorHistorySnapshot {
  entries: Array<{ id: string; label: string; applied: boolean }>
  index: number
}

export interface InspectorEvent {
  sessionId: string
  generation: number
  type: 'document-updated' | 'dom-updated' | 'styles-updated' | 'selection-invalidated' | 'status' | 'history'
  status?: InspectorSessionStatus
  nodeId?: number
  history?: InspectorHistorySnapshot
}

export interface InspectorDeclarationEdit {
  sessionId: string
  generation: number
  nodeId: number
  ruleId: string
  declarationId?: string
  name: string
  value: string
  important?: boolean
  disabled?: boolean
  remove?: boolean
  revision?: number
  draftId?: string
  phase?: 'preview' | 'commit' | 'cancel'
}

export interface InspectorSelectorEdit {
  sessionId: string
  generation: number
  nodeId: number
  ruleId: string
  selector: string
  revision?: number
}

export interface InspectorDomEdit {
  sessionId: string
  generation: number
  nodeId: number
  kind: 'set-attribute' | 'remove-attribute' | 'set-node-value' | 'set-outer-html' | 'remove-node' | 'duplicate-node'
  name?: string
  value?: string
}

export interface InspectorApi {
  inspectorStart: (input: { webContentsId: number; previewId: string; projectId?: string }) => Promise<InspectorSessionSnapshot>
  inspectorStop: (sessionId: string) => Promise<void>
  inspectorReconnect: (sessionId: string) => Promise<InspectorSessionSnapshot>
  inspectorChildren: (ref: InspectorNodeRef) => Promise<InspectorDomNode[]>
  inspectorResolveSelector: (sessionId: string, generation: number, selector: string) => Promise<InspectorDomNode | null>
  inspectorGetNode: (ref: InspectorNodeRef) => Promise<InspectorDomNode>
  inspectorStyles: (ref: InspectorNodeRef) => Promise<InspectorStylesSnapshot>
  inspectorHighlight: (ref: InspectorNodeRef | null, mode?: 'all' | 'content' | 'padding' | 'border' | 'margin') => Promise<void>
  inspectorScrollIntoView: (ref: InspectorNodeRef) => Promise<void>
  inspectorSearch: (sessionId: string, generation: number, query: string, mode: 'text' | 'selector' | 'xpath', fromIndex?: number) => Promise<InspectorSearchResult>
  inspectorDiscardSearch: (sessionId: string, searchId: string) => Promise<void>
  inspectorOuterHtml: (ref: InspectorNodeRef) => Promise<string>
  inspectorSelectorPath: (ref: InspectorNodeRef) => Promise<string>
  inspectorStyleSheetText: (sessionId: string, styleSheetId: string) => Promise<{ text: string; url: string }>
  inspectorEditDom: (edit: InspectorDomEdit) => Promise<InspectorDomNode | null>
  inspectorEditDeclaration: (edit: InspectorDeclarationEdit) => Promise<InspectorStylesSnapshot>
  inspectorEditSelector: (edit: InspectorSelectorEdit) => Promise<InspectorStylesSnapshot>
  inspectorAddRule: (ref: InspectorNodeRef, selector: string) => Promise<InspectorStylesSnapshot>
  inspectorForcePseudo: (ref: InspectorNodeRef, states: string[]) => Promise<InspectorStylesSnapshot>
  inspectorSetLayoutOverlay: (ref: InspectorNodeRef, kind: 'flex' | 'grid' | 'none') => Promise<void>
  inspectorUndo: (sessionId: string) => Promise<InspectorHistorySnapshot>
  inspectorRedo: (sessionId: string) => Promise<InspectorHistorySnapshot>
  inspectorHistory: (sessionId: string) => Promise<InspectorHistorySnapshot>
  inspectorPatches: (sessionId: string) => Promise<unknown[]>
  onInspectorEvent: (callback: (event: InspectorEvent) => void) => () => void
}
