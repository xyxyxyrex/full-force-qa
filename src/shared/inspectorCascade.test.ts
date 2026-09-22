import { describe, expect, it } from 'vitest'
import type { InspectorRule } from './inspector'
import { analyzeInspectorCascade } from './inspectorCascade'

function rule(id: string, selector: string, property: string, value: string, options: Partial<InspectorRule> & { specificity?: [number, number, number]; important?: boolean; longhands?: string[] } = {}): InspectorRule {
  const specificity = options.specificity || [0, 0, 1]
  return {
    id,
    kind: options.kind || 'rule',
    selectorText: selector,
    selectors: [{ text: selector, matches: true, specificity: { a: specificity[0], b: specificity[1], c: specificity[2] } }],
    declarations: [{ id: `${id}:value`, name: property, value, important: Boolean(options.important), implicit: false, state: 'active', longhandNames: options.longhands }],
    origin: options.origin || 'regular',
    contexts: options.contexts || [],
    inheritedFrom: options.inheritedFrom,
    readOnly: false,
    parityInjected: false,
    conditionActive: true,
  }
}

describe('Chromium inspector cascade analysis', () => {
  it('shows an ancestor selector as the winner for a classless heading', () => {
    const generic = rule('generic', 'h1', 'font-size', '40px', { specificity: [0, 0, 1] })
    const hero = rule('hero', '.cs-hero h1', 'font-size', '60px', { specificity: [0, 1, 1] })
    analyzeInspectorCascade([generic, hero])
    expect(generic.declarations[0].state).toBe('overridden')
    expect(generic.declarations[0].reason).toContain('.cs-hero h1')
    expect(hero.declarations[0].state).toBe('active')
  })

  it('handles important origins, duplicate declarations, and shorthand expansion', () => {
    const margin = rule('shorthand', '.card', 'margin', '10px', { specificity: [0, 1, 0], longhands: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] })
    const top = rule('longhand', '.card', 'margin-top', '4px', { specificity: [0, 1, 0] })
    const important = rule('important', 'div', 'margin-left', '2px', { important: true })
    analyzeInspectorCascade([margin, top, important])
    expect(top.declarations[0].state).toBe('active')
    expect(important.declarations[0].state).toBe('active')
    // The shorthand remains active because its right and bottom longhands win,
    // while the explicit top and important left declarations also contribute.
    expect(margin.declarations[0].state).toBe('active')
  })

  it('uses inherited values only when the element has no direct declaration', () => {
    const ancestor = rule('ancestor', '.parent', 'color', 'red', { kind: 'inherited', inheritedFrom: { nodeId: 12, label: '.parent' }, specificity: [0, 1, 0] })
    const direct = rule('direct', 'h1', 'color', 'blue')
    const nonInherited = rule('layout', '.parent', 'margin-top', '12px', { kind: 'inherited', inheritedFrom: { nodeId: 12, label: '.parent' } })
    analyzeInspectorCascade([ancestor, direct, nonInherited])
    expect(direct.declarations[0].state).toBe('active')
    expect(ancestor.declarations[0].state).toBe('overridden')
    expect(nonInherited.declarations[0].state).toBe('overridden')
  })

  it('applies normal and important cascade-layer order', () => {
    const first = rule('first', '.x', 'color', 'red', { contexts: ['@layer reset'] })
    const second = rule('second', '.x', 'color', 'blue', { contexts: ['@layer theme'] })
    analyzeInspectorCascade([first, second])
    expect(second.declarations[0].state).toBe('active')

    first.declarations[0].important = true
    second.declarations[0].important = true
    first.declarations[0].state = second.declarations[0].state = 'active'
    analyzeInspectorCascade([first, second])
    expect(first.declarations[0].state).toBe('active')
  })
})
