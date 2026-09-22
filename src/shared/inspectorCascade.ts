import type { InspectorDeclaration, InspectorRule } from './inspector'

// Cascade ordering is a clean-room, typed adaptation of the model used by
// Chromium DevTools CSSMatchedStyles at revision
// b6d368aed663d21958621a76edddb7e8996858ee. See
// docs/inspector-cascade-attribution.md for the pinned source and BSD notice.

const INHERITED_PROPERTIES = new Set([
  'azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'color', 'cursor',
  'direction', 'empty-cells', 'font', 'font-family', 'font-feature-settings',
  'font-kerning', 'font-language-override', 'font-optical-sizing', 'font-size',
  'font-size-adjust', 'font-stretch', 'font-style', 'font-synthesis', 'font-variant',
  'font-variation-settings', 'font-weight', 'hyphens', 'image-rendering', 'letter-spacing',
  'line-height', 'list-style', 'list-style-image', 'list-style-position', 'list-style-type',
  'orphans', 'overflow-wrap', 'paint-order', 'pointer-events', 'quotes', 'ruby-align',
  'ruby-position', 'speak', 'tab-size', 'text-align', 'text-align-last', 'text-combine-upright',
  'text-indent', 'text-justify', 'text-orientation', 'text-rendering', 'text-shadow',
  'text-transform', 'visibility', 'white-space', 'widows', 'word-break', 'word-spacing',
  'word-wrap', 'writing-mode', '-webkit-font-smoothing', '-webkit-text-fill-color',
  '-webkit-text-stroke', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
])

interface Candidate {
  declaration: InspectorDeclaration
  rule: InspectorRule
  order: number
  specificity: number
  origin: number
  layer: number
}

function selectorWeight(rule: InspectorRule): number {
  if (rule.kind === 'inline') return 1_000_000_000
  return rule.selectors.filter(selector => selector.matches).reduce((highest, selector) => {
    const value = selector.specificity
    return Math.max(highest, value ? value.a * 1_000_000 + value.b * 1_000 + value.c : 0)
  }, 0)
}

function originWeight(origin: string, important: boolean): number {
  if (origin === 'transition') return 8
  if (important) {
    if (origin === 'user-agent') return 7
    if (origin === 'user') return 6
    return 5
  }
  if (origin === 'animation') return 4
  if (origin === 'regular' || origin === 'injected' || origin === 'inspector') return 3
  if (origin === 'user') return 2
  return 1
}

function declarationNames(declaration: InspectorDeclaration, allNames: string[]): string[] {
  if (declaration.name === 'all') return allNames
  if (declaration.name.startsWith('--')) return [declaration.name]
  return [declaration.name.toLowerCase(), ...(declaration.longhandNames || []).map(name => name.toLowerCase())]
}

function compare(left: Candidate, right: Candidate): number {
  return right.origin - left.origin || right.layer - left.layer || right.specificity - left.specificity || right.order - left.order
}

function markGroup(rules: InspectorRule[], allNames: string[], layerRanks: Map<string, number>) {
  const byProperty = new Map<string, Candidate[]>()
  let order = 0
  for (const rule of rules) {
    const layerName = rule.contexts.find(context => context.startsWith('@layer ')) || ''
    for (const declaration of rule.declarations) {
      order++
      if (declaration.state === 'disabled' || declaration.state === 'invalid' || declaration.state === 'inactive') continue
      const important = declaration.important
      const layerIndex = layerName ? (layerRanks.get(layerName) || 0) : -1
      // Normal unlayered declarations outrank layered declarations. For
      // important declarations the layer order is reversed, as required by CSS Cascade.
      const layer = important
        ? (layerName ? 1_000_000 - layerIndex : 0)
        : (layerName ? layerIndex : 1_000_000)
      const candidate: Candidate = {
        declaration,
        rule,
        order,
        specificity: selectorWeight(rule),
        origin: originWeight(rule.origin, important),
        layer,
      }
      for (const name of declarationNames(declaration, allNames)) {
        const values = byProperty.get(name) || []
        values.push(candidate)
        byProperty.set(name, values)
      }
    }
  }
  const winners = new Map<string, Candidate>()
  for (const [name, values] of byProperty) {
    values.sort(compare)
    winners.set(name, values[0])
  }
  return winners
}

export function analyzeInspectorCascade(rules: InspectorRule[]) {
  const editable = rules.flatMap(rule => rule.declarations).filter(declaration => !['disabled', 'invalid', 'inactive'].includes(declaration.state))
  for (const declaration of editable) {
    declaration.state = 'overridden'
    declaration.reason = 'Overridden in the cascade'
  }
  const allNames = [...new Set(editable.flatMap(declaration => declaration.name === 'all' ? [] : declarationNames(declaration, [])))]
  const layerRanks = new Map<string, number>()
  for (const rule of rules) for (const context of rule.contexts) if (context.startsWith('@layer ') && !layerRanks.has(context)) layerRanks.set(context, layerRanks.size + 1)

  const direct = rules.filter(rule => rule.kind !== 'inherited' && rule.kind !== 'pseudo')
  const directWinners = markGroup(direct, allNames, layerRanks)
  for (const winner of directWinners.values()) {
    winner.declaration.state = 'active'
    winner.declaration.reason = undefined
  }

  const inheritedGroups = new Map<number, InspectorRule[]>()
  for (const rule of rules.filter(item => item.kind === 'inherited')) {
    const key = rule.inheritedFrom?.nodeId || -(inheritedGroups.size + 1)
    const group = inheritedGroups.get(key) || []
    group.push(rule)
    inheritedGroups.set(key, group)
  }
  const claimedInherited = new Set<string>()
  for (const group of inheritedGroups.values()) {
    const winners = markGroup(group, allNames, layerRanks)
    for (const [name, winner] of winners) {
      const canInherit = name.startsWith('--') || INHERITED_PROPERTIES.has(name)
      if (!canInherit || directWinners.has(name) || claimedInherited.has(name)) continue
      winner.declaration.state = 'active'
      winner.declaration.reason = undefined
      claimedInherited.add(name)
    }
  }

  const pseudoGroups = new Map<string, InspectorRule[]>()
  for (const rule of rules.filter(item => item.kind === 'pseudo')) {
    const group = pseudoGroups.get(rule.pseudoType || '') || []
    group.push(rule)
    pseudoGroups.set(rule.pseudoType || '', group)
  }
  for (const group of pseudoGroups.values()) for (const winner of markGroup(group, allNames, layerRanks).values()) {
    winner.declaration.state = 'active'
    winner.declaration.reason = undefined
  }

  const winnersByDeclaration = new Map(editable.map(declaration => [declaration.id, declaration]))
  for (const rule of rules) for (const declaration of rule.declarations) {
    if (declaration.state !== 'overridden') continue
    for (const name of declarationNames(declaration, allNames)) {
      const winner = directWinners.get(name)
      if (winner && winner.declaration.id !== declaration.id && winnersByDeclaration.has(winner.declaration.id)) {
        declaration.reason = `Overridden by ${winner.rule.selectorText || 'element.style'}`
        break
      }
    }
  }
}
