import { describe, expect, it } from 'vitest'
import {
  deltaE,
  figmaColorToRgb,
  findingToAnnotationSpec,
  fitVerticalDrift,
  hungarianAssignment,
  parseCssColorToRgb,
  semanticFindings,
  stableId,
  tokenScore,
  type DomNode,
  type Finding
} from './visualCompare'

describe('fitVerticalDrift', () => {
  it('reports zero offset for a page with no drift', () => {
    const anchors = [0, 100, 200, 300, 400].map((designY) => ({ designY, liveY: designY }))
    const drift = fitVerticalDrift(anchors)
    expect(drift.steps).toHaveLength(1)
    expect(drift.sample(250)).toBe(0)
  })

  it('isolates a section-growth step instead of smearing it across every anchor', () => {
    // First three anchors unshifted, last two shifted +62 — one section grew.
    const anchors = [
      { designY: 60, liveY: 60 },
      { designY: 120, liveY: 120 },
      { designY: 180, liveY: 180 },
      { designY: 420, liveY: 482 },
      { designY: 480, liveY: 542 }
    ]
    const drift = fitVerticalDrift(anchors)
    expect(drift.steps).toHaveLength(2)
    expect(drift.sample(180)).toBe(0)
    expect(drift.sample(480)).toBe(62)
  })
})

describe('deltaE (Lab colour distance)', () => {
  it('is ~0 for identical colours', () => {
    expect(deltaE([20, 40, 60], [20, 40, 60])).toBeLessThan(0.01)
  })

  it('is large between black and white', () => {
    expect(deltaE([0, 0, 0], [255, 255, 255])).toBeGreaterThan(50)
  })

  it('is small for near-identical colours a human would not distinguish', () => {
    expect(deltaE([250, 5, 5], [255, 0, 0])).toBeLessThan(5)
  })

  it('is large between red and blue', () => {
    expect(deltaE([255, 0, 0], [0, 0, 255])).toBeGreaterThan(50)
  })
})

describe('color parsing', () => {
  it('parses hex', () => {
    expect(parseCssColorToRgb('#ff0000')).toEqual([255, 0, 0])
  })

  it('parses rgb()', () => {
    expect(parseCssColorToRgb('rgb(255, 0, 0)')).toEqual([255, 0, 0])
  })

  it('composites rgba() alpha over white', () => {
    const [r, g, b] = parseCssColorToRgb('rgba(0,0,0,0.5)')!
    expect(r).toBeCloseTo(127.5, 0)
    expect(g).toBeCloseTo(127.5, 0)
    expect(b).toBeCloseTo(127.5, 0)
  })

  it('composites Figma fill + node opacity over white', () => {
    const fills = [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 0 } }]
    const [r, g, b] = figmaColorToRgb(fills, 0.5)!
    expect(r).toBeCloseTo(127.5, 0)
    expect(g).toBeCloseTo(127.5, 0)
    expect(b).toBeCloseTo(127.5, 0)
  })
})

describe('tokenScore', () => {
  it('scores identical text as 1', () => {
    expect(tokenScore('Get Started', 'Get Started')).toBe(1)
  })

  it('scores unrelated text near 0', () => {
    expect(tokenScore('Get Started', 'Privacy Policy')).toBeLessThan(0.2)
  })
})

describe('stableId', () => {
  it('is deterministic', () => {
    expect(stableId('a', 'b', 'c')).toBe(stableId('a', 'b', 'c'))
  })

  it('differs when inputs differ', () => {
    expect(stableId('a', 'b')).not.toBe(stableId('a', 'c'))
  })
})

// ---- semanticFindings: a small synthetic page exercising the whole pipeline ----

function textNode(characters: string, box: { x: number; y: number; width: number; height: number }, opts: {
  fontSize: number; fontWeight?: number; lineHeightPx?: number; colorRgb?: [number, number, number]
}, styleOverrides: Record<string, unknown> = {}) {
  const [r, g, b] = opts.colorRgb ?? [15, 15, 20]
  return {
    id: `text-${characters}-${box.x}-${box.y}`,
    type: 'TEXT',
    characters,
    absoluteBoundingBox: box,
    opacity: 1,
    style: {
      fontSize: opts.fontSize,
      fontWeight: opts.fontWeight ?? 400,
      lineHeightPx: opts.lineHeightPx ?? opts.fontSize * 1.4,
      letterSpacing: 0,
      fontFamily: 'Inter',
      textAlignHorizontal: 'LEFT',
      ...styleOverrides
    },
    fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: r / 255, g: g / 255, b: b / 255 } }]
  }
}

function domNode(tag: string, text: string, rect: { x: number; y: number; width: number; height: number }, styles: Partial<DomNode['styles']>): DomNode {
  return {
    tag, role: '', text, src: '', context: '', path: tag, rect,
    styles: { fontSize: '', fontFamily: 'Inter', fontWeight: '400', color: 'rgb(15,15,20)', backgroundColor: 'transparent', textAlign: 'left', lineHeight: '', letterSpacing: '0px', ...styles }
  }
}

describe('semanticFindings', () => {
  const root = {
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 1000 },
    children: [
      textNode('Welcome to Acme', { x: 40, y: 40, width: 300, height: 40 }, { fontSize: 32, fontWeight: 700 }),
      textNode('Trusted by thousands', { x: 40, y: 100, width: 220, height: 24 }, { fontSize: 16 }),
      textNode('Color Test Label', { x: 40, y: 160, width: 200, height: 20 }, { fontSize: 14, colorRgb: [255, 0, 0] }),
      // These two sit below a section that grew by 62px in the live page.
      textNode('Section Two Heading', { x: 40, y: 400, width: 300, height: 32 }, { fontSize: 24, fontWeight: 700 }),
      textNode('Some paragraph text here for section two', { x: 40, y: 460, width: 400, height: 20 }, { fontSize: 14 }),
      // Never rendered live.
      textNode('Missing Footer Text', { x: 40, y: 900, width: 200, height: 20 }, { fontSize: 14 })
    ]
  }

  const domNodes: DomNode[] = [
    domNode('h1', 'Welcome to Acme', { x: 40, y: 40, width: 300, height: 40 }, { fontSize: '32px', fontWeight: '700', lineHeight: `${32 * 1.4}px` }),
    // "normal" line-height can't be compared against a px spec — exercises the unresolved path.
    domNode('p', 'Trusted by thousands', { x: 40, y: 100, width: 220, height: 24 }, { fontSize: '16px', lineHeight: 'normal' }),
    domNode('label', 'Color Test Label', { x: 40, y: 160, width: 200, height: 20 }, { fontSize: '14px', color: 'rgb(0,0,255)', lineHeight: `${14 * 1.4}px` }),
    domNode('h2', 'Section Two Heading', { x: 40, y: 462, width: 300, height: 32 }, { fontSize: '24px', fontWeight: '700', lineHeight: `${24 * 1.4}px` }),
    domNode('p', 'Some paragraph text here for section two', { x: 40, y: 522, width: 400, height: 20 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px` })
  ]

  const findings = semanticFindings(root, domNodes, 800, 1000)

  it('flags the element that never rendered', () => {
    const missing = findings.filter((f) => f.title.includes('Missing design text'))
    expect(missing).toHaveLength(1)
    expect(missing[0].title).toContain('Missing Footer Text')
  })

  it('attributes the 62px shift to one section-growth finding, not per-element mismatches', () => {
    const growth = findings.filter((f) => f.title.includes('Section growth'))
    expect(growth).toHaveLength(1)
    expect(growth[0].title).toContain('+62')

    const positionMismatches = findings.filter((f) => f.title.startsWith('Position mismatch'))
    expect(positionMismatches).toHaveLength(0)
  })

  it('verifies position for every matched element once drift is removed', () => {
    const verified = findings.filter((f) => f.title.startsWith('Spec Verified: Position'))
    expect(verified).toHaveLength(5)
  })

  it('catches the colour defect the geometry pass cannot see', () => {
    const colorMismatch = findings.find((f) => f.title.includes('CSS Token Mismatch') && f.title.includes('Color Test Label'))
    expect(colorMismatch).toBeDefined()
    expect(colorMismatch!.tokens?.some((t) => t.name === 'color' && !t.passed)).toBe(true)
  })

  it('reports an unresolved token instead of silently dropping it', () => {
    const trusted = findings.find((f) => f.title.startsWith('CSS Tokens') && f.title.includes('Trusted by thousands'))
    expect(trusted).toBeDefined()
    expect(trusted!.tokens?.some((t) => t.name === 'line-height' && t.unresolved)).toBe(true)
    expect(trusted!.detail).toContain('could not be resolved')
  })

  it('does not invent a horizontal offset finding when there is none', () => {
    expect(findings.some((f) => f.title.includes('Container is shifted'))).toBe(false)
  })

  it('gives every finding a stable, non-empty id', () => {
    for (const finding of findings) expect(finding.id).toBeTruthy()
  })
})

describe('semanticFindings — deepened model assertions', () => {
  const root = {
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 600, height: 400 },
    children: [
      // Figma applies an automatic UPPER transform; the live CSS declares none.
      textNode('call to action', { x: 20, y: 20, width: 200, height: 24 }, { fontSize: 14 }, { textCase: 'UPPER' }),
      // The declared family never actually rendered (webfont failed to load), and
      // the layer references a published text style — this should resolve by name.
      { ...textNode('Custom Heading', { x: 20, y: 80, width: 200, height: 32 }, { fontSize: 28 }, { fontFamily: 'Brand Sans' }), styles: { text: 'style:heading' } },
      {
        type: 'FRAME',
        name: 'Stat List',
        visible: true,
        layoutMode: 'VERTICAL',
        itemSpacing: 24,
        absoluteBoundingBox: { x: 20, y: 150, width: 300, height: 150 },
        children: [
          textNode('Stat One', { x: 20, y: 150, width: 100, height: 20 }, { fontSize: 14 }),
          textNode('Stat Two', { x: 20, y: 194, width: 100, height: 20 }, { fontSize: 14 }),
          textNode('Stat Three', { x: 20, y: 238, width: 100, height: 20 }, { fontSize: 14 })
        ]
      }
    ]
  }

  const domNodes: DomNode[] = [
    domNode('button', 'call to action', { x: 20, y: 20, width: 200, height: 24 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px`, textTransform: 'none' }),
    domNode('h2', 'Custom Heading', { x: 20, y: 80, width: 200, height: 32 }, { fontSize: '28px', fontFamily: 'Brand Sans, sans-serif', lineHeight: `${28 * 1.4}px`, fontLoaded: 'false' }),
    // Live gap is compressed to 8px on a 24px spec.
    domNode('p', 'Stat One', { x: 20, y: 150, width: 100, height: 20 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px` }),
    domNode('p', 'Stat Two', { x: 20, y: 178, width: 100, height: 20 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px` }),
    domNode('p', 'Stat Three', { x: 20, y: 206, width: 100, height: 20 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px` })
  ]

  const findings = semanticFindings(root, domNodes, 600, 400)

  it('flags a design case-transform the live CSS never declares', () => {
    const finding = findings.find((f) => f.title.includes('call to action'))
    expect(finding?.tokens?.some((t) => t.name === 'text-case' && !t.passed)).toBe(true)
  })

  it('catches a webfont that silently failed to load', () => {
    const finding = findings.find((f) => f.title.includes('Custom Heading'))
    const fontToken = finding?.tokens?.find((t) => t.name === 'font-loaded')
    expect(fontToken?.passed).toBe(false)
    expect(finding?.severity).toBe('high')
  })

  it('attributes a compressed sibling gap to the auto-layout group, not each element', () => {
    const spacing = findings.filter((f) => f.title.includes('Spacing mismatch'))
    expect(spacing).toHaveLength(1)
    expect(spacing[0].title).toContain('Stat List')
    expect(spacing[0].detail).toContain('24px')
    expect(spacing[0].detail).toContain('8px')
  })

  it('resolves a referenced Figma style into a named detail, and stays silent for unknown ids', () => {
    const withNames = semanticFindings(root, domNodes, 600, 400, { 'style:heading': 'text/heading-2' })
    const heading = withNames.find((f) => f.title.includes('Custom Heading') && f.title.startsWith('CSS Token'))
    expect(heading?.detail).toContain('Figma style: text/heading-2')

    // An id that isn't in the map shouldn't fabricate a name for the same node.
    const withoutMatch = semanticFindings(root, domNodes, 600, 400, { 'unrelated:id': 'text/unused' })
    expect(withoutMatch.some((f) => f.detail.includes('Figma style:'))).toBe(false)
  })
})

// ---- Hungarian assignment: the algorithm underneath banded correspondence ----

describe('hungarianAssignment', () => {
  it('solves a trivial unambiguous case', () => {
    const cost = [
      [1, 10],
      [10, 1]
    ]
    expect(hungarianAssignment(cost)).toEqual([0, 1])
  })

  it('finds the swap a greedy row-by-row scan would miss', () => {
    // Row 0's own best column is 0 (cost 1). A greedy scan assigns row 0 to
    // column 0 first, forcing row 1 into column 1 at cost 9 — total 10.
    // The true optimum swaps them: row 0→col 1 (2), row 1→col 0 (3) — total 5.
    const cost = [
      [1, 2],
      [3, 9]
    ]
    const assignment = hungarianAssignment(cost)
    const total = assignment.reduce((sum, col, row) => sum + cost[row][col], 0)
    expect(total).toBe(5)
    expect(assignment).toEqual([1, 0])
  })

  it('respects a forbidden (Infinity) pairing', () => {
    const cost = [
      [Infinity, 1],
      [1, Infinity]
    ]
    expect(hungarianAssignment(cost)).toEqual([1, 0])
  })

  it('handles a larger matrix without leaving rows unassigned', () => {
    const cost = [
      [4, 1, 3, 8],
      [2, 0, 5, 7],
      [9, 6, 1, 2],
      [3, 4, 2, 0]
    ]
    const assignment = hungarianAssignment(cost)
    expect(new Set(assignment).size).toBe(4)
    for (const col of assignment) expect(col).toBeGreaterThanOrEqual(0)
  })
})

// ---- Correspondence: order independence is the property optimal assignment buys.
// A greedy, order-dependent matcher produces different results depending on which
// design layer happens to be processed first; this must not. ----

describe('semanticFindings — correspondence engine', () => {
  const buildFixture = (reversed: boolean) => {
    const texts = [
      textNode('Welcome to Acme', { x: 40, y: 40, width: 300, height: 40 }, { fontSize: 32, fontWeight: 700 }),
      textNode('Trusted by thousands', { x: 40, y: 100, width: 220, height: 24 }, { fontSize: 16 }),
      textNode('Section Two Heading', { x: 40, y: 400, width: 300, height: 32 }, { fontSize: 24, fontWeight: 700 }),
      textNode('Some paragraph text here for section two', { x: 40, y: 460, width: 400, height: 20 }, { fontSize: 14 })
    ]
    const doms = [
      domNode('h1', 'Welcome to Acme', { x: 40, y: 40, width: 300, height: 40 }, { fontSize: '32px', fontWeight: '700', lineHeight: `${32 * 1.4}px` }),
      domNode('p', 'Trusted by thousands', { x: 40, y: 100, width: 220, height: 24 }, { fontSize: '16px', lineHeight: `${16 * 1.4}px` }),
      domNode('h2', 'Section Two Heading', { x: 40, y: 400, width: 300, height: 32 }, { fontSize: '24px', fontWeight: '700', lineHeight: `${24 * 1.4}px` }),
      domNode('p', 'Some paragraph text here for section two', { x: 40, y: 460, width: 400, height: 20 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px` })
    ]
    const root = { type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 700 }, children: reversed ? [...texts].reverse() : texts }
    const domNodes: DomNode[] = reversed ? [...doms].reverse() : doms
    return { root, domNodes }
  }

  it('produces the same matches regardless of input order', () => {
    const forward = buildFixture(false)
    const reversed = buildFixture(true)
    const forwardFindings = semanticFindings(forward.root, forward.domNodes, 800, 700)
    const reversedFindings = semanticFindings(reversed.root, reversed.domNodes, 800, 700)
    const titles = (list: typeof forwardFindings) => list.map((f) => f.title).sort()
    expect(titles(forwardFindings)).toEqual(titles(reversedFindings))
    expect(forwardFindings.some((f) => f.title.includes('Missing design text'))).toBe(false)
    expect(reversedFindings.some((f) => f.title.includes('Missing design text'))).toBe(false)
  })

  it('repairs a live paragraph that renders two adjacent design text layers as one', () => {
    // A common rich-text pattern: Figma splits a sentence into two runs for
    // formatting; the browser renders it as a single text node.
    const root = {
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 600, height: 200 },
      children: [
        textNode('Save up to 40%', { x: 20, y: 20, width: 140, height: 20 }, { fontSize: 14 }),
        textNode('on your first order.', { x: 160, y: 20, width: 160, height: 20 }, { fontSize: 14 })
      ]
    }
    const domNodes: DomNode[] = [
      domNode('p', 'Save up to 40% on your first order.', { x: 20, y: 20, width: 300, height: 20 }, { fontSize: '14px', lineHeight: `${14 * 1.4}px` })
    ]
    const findings = semanticFindings(root, domNodes, 600, 200)
    expect(findings.some((f) => f.title.includes('Missing design text'))).toBe(false)
    expect(findings.some((f) => f.title.includes('Save up to 40%') && f.title.includes('on your first order'))).toBe(true)
  })
})

// ---- findingToAnnotationSpec: the bridge into the annotation system ----

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    severity: 'high',
    title: 'Position mismatch: “CTA Button”',
    detail: 'Matched <button> is displaced from its drift-corrected expected position.',
    confidence: 92,
    comparison: {
      live: { rect: { x: 40, y: 120, width: 160, height: 44 }, pageWidth: 1440, pageHeight: 900, label: '<button>' }
    },
    ...overrides
  }
}

describe('findingToAnnotationSpec', () => {
  it('is not pinnable when the finding passed', () => {
    expect(findingToAnnotationSpec(makeFinding({ severity: 'pass' }), 'Desktop', 1440, 900)).toBeNull()
  })

  it('is not pinnable when there is no live region to point at', () => {
    expect(findingToAnnotationSpec(makeFinding({ comparison: undefined }), 'Desktop', 1440, 900)).toBeNull()
  })

  it('carries the live rect straight through, unscaled', () => {
    const spec = findingToAnnotationSpec(makeFinding(), 'Desktop', 1440, 900)
    expect(spec?.rect).toEqual({ x: 40, y: 120, width: 160, height: 44 })
    expect(spec?.viewportWidth).toBe(1440)
    expect(spec?.viewportHeight).toBe(900)
  })

  it('maps severity to the existing annotation swatch colours', () => {
    expect(findingToAnnotationSpec(makeFinding({ severity: 'high' }), 'Desktop', 1440, 900)?.color).toBe('#ff0055')
    expect(findingToAnnotationSpec(makeFinding({ severity: 'medium' }), 'Desktop', 1440, 900)?.color).toBe('#f59e0b')
    expect(findingToAnnotationSpec(makeFinding({ severity: 'low' }), 'Desktop', 1440, 900)?.color).toBe('#3b82f6')
  })

  it('derives deviceType from the breakpoint label, case-insensitively', () => {
    expect(findingToAnnotationSpec(makeFinding(), 'Mobile', 375, 812)?.deviceType).toBe('mobile')
    expect(findingToAnnotationSpec(makeFinding(), 'tablet', 768, 1024)?.deviceType).toBe('tablet')
    expect(findingToAnnotationSpec(makeFinding(), 'Desktop', 1440, 900)?.deviceType).toBe('desktop')
    expect(findingToAnnotationSpec(makeFinding(), 'Desktop', 1440, 900)?.deviceName).toBe('Desktop')
  })

  it('includes failing token rows in the notes but not passing or unresolved ones', () => {
    const spec = findingToAnnotationSpec(makeFinding({
      tokens: [
        { name: 'font-size', passed: false, figma: '40px', css: '32px' },
        { name: 'font-weight', passed: true, figma: '700', css: '700' },
        { name: 'line-height', passed: false, unresolved: true, figma: '24px', css: 'normal' }
      ]
    }), 'Desktop', 1440, 900)
    expect(spec?.notes).toContain('font-size')
    expect(spec?.notes).toContain('Figma 40px')
    expect(spec?.notes).toContain('CSS 32px')
    expect(spec?.notes).not.toContain('font-weight')
    expect(spec?.notes).not.toContain('line-height')
  })

  it('escapes HTML-significant characters in the notes', () => {
    const spec = findingToAnnotationSpec(makeFinding({ detail: 'Figma <b>bold</b> & "quoted" text' }), 'Desktop', 1440, 900)
    expect(spec?.notes).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(spec?.notes).not.toContain('<b>bold</b>')
  })
})
