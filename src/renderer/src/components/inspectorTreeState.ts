import type { InspectorDomNode } from '../../../shared/inspector'

export function inspectorNodeChildren(node: InspectorDomNode): InspectorDomNode[] {
  return [...(node.children || []), ...(node.shadowRoots || []), ...(node.pseudoElements || [])]
}

/** Hide only HTML formatting whitespace, not non-breaking or other authored spaces. */
export function isFormattingWhitespaceNode(node: InspectorDomNode): boolean {
  return node.nodeType === 3 && /^[\t\n\f\r ]*$/.test(node.nodeValue)
}

export function visibleInspectorChildren(
  node: InspectorDomNode,
  showInternals: boolean,
  showWhitespace: boolean,
  selectedNodeId?: number,
): InspectorDomNode[] {
  return inspectorNodeChildren(node).filter(child =>
    (showInternals || !child.isParityInternal) &&
    (showWhitespace || !isFormattingWhitespaceNode(child) || child.ref.nodeId === selectedNodeId),
  )
}

/**
 * Merge a CDP node snapshot without throwing away branches that were loaded
 * separately. Chromium omits `children` when a describe depth is exhausted;
 * an omitted collection means "not included", while an empty collection means
 * the node was inspected and now has no children.
 */
export function mergeInspectorTreeNode(
  nodes: Map<number, InspectorDomNode>,
  incoming: InspectorDomNode,
): InspectorDomNode {
  for (const ancestor of incoming.ancestors || []) mergeInspectorTreeNode(nodes, ancestor)

  const previous = nodes.get(incoming.ref.nodeId)
  const merged: InspectorDomNode = { ...previous, ...incoming }

  merged.children = incoming.children === undefined
    ? previous?.children
    : incoming.children.map(child => mergeInspectorTreeNode(nodes, child))
  merged.shadowRoots = incoming.shadowRoots === undefined
    ? previous?.shadowRoots
    : incoming.shadowRoots.map(child => mergeInspectorTreeNode(nodes, child))
  merged.pseudoElements = incoming.pseudoElements === undefined
    ? previous?.pseudoElements
    : incoming.pseudoElements.map(child => mergeInspectorTreeNode(nodes, child))

  nodes.set(merged.ref.nodeId, merged)
  return merged
}
