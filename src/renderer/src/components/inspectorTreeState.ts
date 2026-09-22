import type { InspectorDomNode } from '../../../shared/inspector'

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
