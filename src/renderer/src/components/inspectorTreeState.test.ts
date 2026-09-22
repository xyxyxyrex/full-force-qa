import { describe, expect, it } from 'vitest'
import type { InspectorDomNode } from '../../../shared/inspector'
import { mergeInspectorTreeNode } from './inspectorTreeState'

function node(id: number, name: string, children?: InspectorDomNode[]): InspectorDomNode {
  return {
    ref: { sessionId: 'session', generation: 1, nodeId: id, backendNodeId: id },
    nodeType: name === '#document' ? 9 : 1,
    nodeName: name.toUpperCase(),
    localName: name === '#document' ? '' : name,
    nodeValue: '',
    attributes: [],
    childNodeCount: children?.length || 0,
    ...(children === undefined ? {} : { children }),
  }
}

describe('inspector DOM tree merging', () => {
  it('preserves loaded descendants when a shallow refresh omits them', () => {
    const heading = node(5, 'h1', [])
    const section = node(4, 'section', [heading])
    const body = node(3, 'body', [section])
    const html = node(2, 'html', [body])
    const root = node(1, '#document', [html])
    const nodes = new Map<number, InspectorDomNode>()
    mergeInspectorTreeNode(nodes, root)

    const shallowBody = node(3, 'body')
    shallowBody.attributes = [{ name: 'class', value: 'updated' }]
    mergeInspectorTreeNode(nodes, node(1, '#document', [node(2, 'html', [shallowBody])]))

    expect(nodes.get(3)?.attributes).toEqual([{ name: 'class', value: 'updated' }])
    expect(nodes.get(3)?.children?.[0].ref.nodeId).toBe(4)
    expect(nodes.get(4)?.children?.[0].ref.nodeId).toBe(5)
  })

  it('removes stale children when Chromium supplies an explicit empty list', () => {
    const nodes = new Map<number, InspectorDomNode>()
    mergeInspectorTreeNode(nodes, node(3, 'body', [node(4, 'section', [])]))

    mergeInspectorTreeNode(nodes, node(3, 'body', []))

    expect(nodes.get(3)?.children).toEqual([])
  })
})
