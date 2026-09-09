/**
 * Semantic QA facade. Correspondence ranks candidates; it never corrects geometry.
 * Only unique, reciprocal exact-text matches produce property assertions in this phase.
 */
import type { AutomationFinding, SemanticCoverage, ComparedRegion, FindingComparison } from '../../../shared/automation'
import { normalizeText, stableId, median } from '../../../shared/automationText'
import { pairScore, findMutualAnchors, solveBandAssignment, repairMergesSplits } from '../automation/correspondence'
import { compareGeometry } from '../automation/geometry'
import { compareStyles } from '../automation/styles'
import { AUTOMATION_TOLERANCE } from '../../../shared/automationTolerance'
export { normalizeText, stableId, median, tokenScore } from '../../../shared/automationText'
export { deltaE, figmaColorToRgb, parseCssColorToRgb, rgbToHex } from '../automation/colors'
export { hungarianAssignment } from '../automation/correspondence'
export type { ComparedRegion, FindingComparison, TokenAssertion } from '../../../shared/automation'
export type Finding = AutomationFinding
export interface DomNode {
  tag: string; role: string; text: string; src: string; context: string; path: string
  rect: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

export function semanticComparison(figmaRoot: any, domNodes: DomNode[], liveWidth: number, liveHeight: number, styleNames: Record<string, string> = {}): { findings: Finding[]; coverage: SemanticCoverage } {
  const root = figmaRoot?.absoluteBoundingBox || { x: 0, y: 0, width: liveWidth, height: liveHeight }
  const designItems: any[] = []
  let imageCount = 0
  const walk = (node: any, ancestors: string[] = []) => {
    if (!node || node.visible === false) return
    if (node.absoluteBoundingBox && node.type === 'TEXT' && normalizeText(node.characters)) {
      designItems.push({ ...node, __context: ancestors.join(' ') })
    }
    if (node.fills?.some((f: any) => f.type === 'IMAGE' && f.visible !== false)) imageCount++
    for (const child of node.children || []) walk(child, [...ancestors, node.name || ''])
  }
  walk(figmaRoot)
  const candidates = domNodes.filter(n => normalizeText(n.text) && n.tag !== 'img' && n.rect.width > 0 && n.rect.height > 0)
  const findings: Finding[] = []
  const matchedPairs: Array<{design:any;live:DomNode}> = []
  const coverage: SemanticCoverage = {
    designTextNodes: designItems.length, processedTextNodes: designItems.length,
    matchedTextNodes: 0, ambiguousTextNodes: 0, liveTextNodes: candidates.length,
    designImageNodes: imageCount, imageValidation: 'unavailable'
  }
  const score = (d: any, c: DomNode) => pairScore(d, c, root, liveWidth, liveHeight)
  const designRect = (d: any) => ({ x: d.absoluteBoundingBox.x - root.x, y: d.absoluteBoundingBox.y - root.y, width: d.absoluteBoundingBox.width, height: d.absoluteBoundingBox.height })
  const region = (d: any): ComparedRegion => ({ rect: designRect(d), pageWidth: root.width, pageHeight: root.height, label: String(d.characters) })
  const unresolved = (design: any, live?: DomNode, reason = 'No reciprocal exact-text correspondence was established.') => {
    findings.push({
      id: stableId('mapping', design.id || '', String(design.absoluteBoundingBox.y), design.characters),
      state: 'ambiguous', evidenceStrength: 'ambiguous', category: 'content', severity: 'low',
      title: `Unresolved mapping: “${String(design.characters).slice(0,72)}”`,
      detail: reason + ' No missing-content or property defect has been asserted.',
      sourceNodeId: design.id, targetNodeId: live?.path,
      matchQuality: { quality: 'ambiguous', reciprocal: false, reason },
      expected: design.characters, actual: live?.text,
      comparison: { design: region(design), ...(live ? { live: { rect: live.rect, pageWidth: liveWidth, pageHeight: liveHeight, label: live.text } } : {}) }
    })
  }
  const pushMissing = (design: any) => unresolved(design)
  const finalizePair = (design: any, live: DomNode, _rank: unknown) => {
    const text = normalizeText(design.characters)
    const designPeers = designItems.filter(d => normalizeText(d.characters) === text)
    const livePeers = candidates.filter(c => normalizeText(c.text) === text)
    // Repairs merge boxes and inherit styles from one run: not a verified 1:1 mapping.
    const original = designItems.includes(design) && candidates.includes(live)
    const s = score(design, live)
    const reciprocal = !!s && !designItems.some(d => d !== design && (score(d, live)?.score ?? -1) >= s.score)
      && !candidates.some(c => c !== live && (score(design, c)?.score ?? -1) >= s.score)
    if (!original || designPeers.length !== 1 || livePeers.length !== 1 || text !== normalizeText(live.text) || !reciprocal) {
      unresolved(design, live, 'Repeated text, a merge/split, or competing candidates makes correspondence ambiguous.')
      return
    }
    matchedPairs.push({design,live})
  }
  const claimedDesign = new Set<number>(); const claimedLive = new Set<number>()
  const anchors = findMutualAnchors(designItems, candidates, root, score)
  for (const anchor of anchors) {
    claimedDesign.add(anchor.designIndex); claimedLive.add(anchor.liveIndex)
    finalizePair(designItems[anchor.designIndex], candidates[anchor.liveIndex], anchor.match)
  }

  const designBoundaries = anchors.map((a) => a.designY)
  const liveBoundaries = anchors.map((a) => a.liveY)
  const bandOf = (y: number, boundaries: number[]) => { let band = 0; for (const b of boundaries) { if (y >= b) band++; else break }; return band }
  const bandCount = anchors.length + 1

  for (let band = 0; band < bandCount; band++) {
    const designIndices = designItems.map((d, i) => i).filter((i) => !claimedDesign.has(i) && bandOf(designItems[i].absoluteBoundingBox.y - root.y, designBoundaries) === band)
    const liveIndices = candidates.map((c, i) => i).filter((i) => !claimedLive.has(i) && bandOf(candidates[i].rect.y, liveBoundaries) === band)
    if (!designIndices.length) continue

    const assignment = solveBandAssignment(designIndices, liveIndices, designItems, candidates, score)
    const repair = repairMergesSplits(designIndices, liveIndices, assignment, designItems, candidates, root, liveWidth, liveHeight)

    for (const designIndex of designIndices) {
      if (repair.consumedDesign.has(designIndex)) { claimedDesign.add(designIndex); continue }
      const result = assignment.get(designIndex)
      if (result) {
        claimedDesign.add(designIndex); claimedLive.add(result.liveIndex)
        finalizePair(designItems[designIndex], candidates[result.liveIndex], result.match)
      }
    }
    for (const li of repair.consumedLive) claimedLive.add(li)
    for (const addition of repair.additions) finalizePair(addition.design, addition.live, addition.match)
  }

  for (let i = 0; i < designItems.length; i++) if (!claimedDesign.has(i)) pushMissing(designItems[i])


  coverage.matchedTextNodes = matchedPairs.length
  coverage.ambiguousTextNodes = designItems.length - matchedPairs.length
  for (const {design,live} of matchedPairs) {
    const expected = designRect(design)
    const geometry = compareGeometry(expected, live.rect)
    const label = String(design.characters).trim().replace(/\s+/g, ' ').slice(0,72)
    const key = stableId(design.id || '', live.path, label, String(expected.y))
    const comparison: FindingComparison = {
      design: region(design),
      live: { rect: live.rect, pageWidth: liveWidth, pageHeight: liveHeight, label: live.text },
      delta: geometry.difference
    }
    const base = {
      evidenceStrength: 'strong' as const, sourceNodeId: design.id, targetNodeId: live.path, comparison,
      matchQuality: { quality: 'strong' as const, reciprocal: true, reason: 'Unique exact text with reciprocal contextual assignment; not a probability.' }
    }
    for (const category of ['position','size'] as const) {
      const passed = category === 'position' ? geometry.positionPass : geometry.sizePass
      findings.push({
        ...base, id: stableId(key,category), category, state: passed ? 'pass' : 'fail', severity: passed ? 'pass' : 'medium',
        title: `${category === 'position' ? 'Position' : 'Size'}: “${label}”`,
        detail: 'Direct bounding-box measurement at native document coordinates. Text frames and CSS line boxes may have different extents; no CSS cause is inferred.',
        expected: category === 'position' ? {x:expected.x,y:expected.y} : {width:expected.width,height:expected.height},
        actual: category === 'position' ? {x:live.rect.x,y:live.rect.y} : {width:live.rect.width,height:live.rect.height},
        difference: category === 'position' ? {x:geometry.difference.x,y:geometry.difference.y} : {width:geometry.difference.width,height:geometry.difference.height}
      })
    }
    const tokens = compareStyles(design,live)
    const failed = tokens.filter(t => !t.passed && !t.unresolved)
    const unavailable = tokens.some(t => t.unresolved)
    if (tokens.length) {
      const state = failed.length ? 'fail' : unavailable ? 'unavailable' : 'pass'
      const styleName = styleNames[design.styles?.text] || ''
      findings.push({
        ...base, id: stableId(key,'tokens'), category: 'typography', state,
        evidenceStrength: state === 'unavailable' ? 'unverified' : 'strong',
        severity: state === 'pass' ? 'pass' : failed.length ? 'medium' : 'low',
        title: `Typography: “${label}”`,
        detail: `${styleName ? 'Figma style: '+styleName+'. ' : ''}Declared/computed properties only. Rendered font identity is not verified.`,
        expected: Object.fromEntries(tokens.map(t=>[t.name,t.figma])),
        actual: Object.fromEntries(tokens.map(t=>[t.name,t.css])),
        difference: { properties: Object.fromEntries(tokens.map(t=>[t.name,t.difference ?? (t.unresolved ? 'unavailable' : t.passed ? 'within tolerance' : 'different')])) }, tokens
      })
    }
  }
  // Keep auto-layout gap checks, using native bounds of all strongly matched direct text siblings.
  const groups = (node: any) => {
    if (!node || node.visible === false) return
    const children = (node.children || []).filter((c:any)=>c.type==='TEXT' && c.visible!==false)
    if (children.length >= 3 && typeof node.itemSpacing === 'number' && ['VERTICAL','HORIZONTAL'].includes(node.layoutMode)) {
      const pairs = children.map((c:any)=>matchedPairs.find(p=>p.design.id===c.id))
      if (pairs.every(Boolean)) {
        const gaps = pairs.slice(1).map((p:any,i:number)=>node.layoutMode==='VERTICAL'
          ? p.live.rect.y - (pairs[i].live.rect.y+pairs[i].live.rect.height)
          : p.live.rect.x - (pairs[i].live.rect.x+pairs[i].live.rect.width))
        // Every sample must agree with the spec; the median alone must not hide one wrong gap.
        const passed = gaps.every((gap:number)=>Math.abs(gap-node.itemSpacing)<=AUTOMATION_TOLERANCE.spacingPx)
        findings.push({id:stableId('spacing',node.id||node.name),category:'spacing',state:passed?'pass':'fail',
          evidenceStrength:'strong',severity:passed?'pass':'low',title:`Spacing: “${node.name || 'Frame'}”`,
          detail:'Rendered gaps between matched direct text siblings. This does not diagnose CSS gap, margin, or padding.',
          expected:node.itemSpacing,actual:gaps,difference:{value:median(gaps)-node.itemSpacing}})
      }
    }
    for (const child of node.children || []) groups(child)
  }
  groups(figmaRoot)
  findings.push({id:stableId('images-unavailable'),state:'unavailable',evidenceStrength:'unverified',category:'image',
    severity:'low',title:'Image identity validation unavailable',
    detail:'Image-layer and DOM image counts do not establish asset identity or cropping.',
    expected:imageCount,actual:domNodes.filter(n=>n.tag==='img').length})
  if (!designItems.length) findings.push({id:stableId('text-unavailable'),state:'unavailable',evidenceStrength:'unverified',
    category:'content',severity:'low',title:'No comparable text nodes',detail:'Semantic text coverage is unavailable, not a pass.'})
  return {findings,coverage}
}
export function semanticFindings(...args: Parameters<typeof semanticComparison>): Finding[] {
  return semanticComparison(...args).findings
}

export interface AnnotationFromFindingSpec {
  sourceFindingId: string
  title: string
  notes: string
  color?: string
  rect: { x: number; y: number; width: number; height: number }
  viewportWidth: number
  viewportHeight: number
  deviceType: 'desktop' | 'tablet' | 'mobile'
  deviceName: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function breakpointToDeviceType(breakpoint: string): 'desktop' | 'tablet' | 'mobile' {
  const lowered = breakpoint.toLowerCase()
  if (lowered === 'mobile') return 'mobile'
  if (lowered === 'tablet') return 'tablet'
  return 'desktop'
}

/**
 * Pass findings (nothing to fix) and findings with no live region (nothing to
 * point at — e.g. "Container is shifted Npx horizontally") aren't pinnable.
 */
export function findingToAnnotationSpec(
  finding: Finding, breakpoint: string, viewportWidth: number, viewportHeight: number
): AnnotationFromFindingSpec | null {
  if (finding.state !== 'fail' && finding.state !== 'visual') return null
  const rect = finding.comparison?.live?.rect
  if (!rect) return null

  const notesParts = [`<p>${escapeHtml(finding.detail)}</p>`]
  const failingTokens = (finding.tokens || []).filter((token) => !token.passed && !token.unresolved)
  if (failingTokens.length) {
    const rows = failingTokens.map((token) => `<li><strong>${escapeHtml(token.name)}</strong>: Figma ${escapeHtml(token.figma)} → CSS ${escapeHtml(token.css)}</li>`)
    notesParts.push(`<ul>${rows.join('')}</ul>`)
  }

  return {
    sourceFindingId: finding.id,
    title: finding.title,
    notes: notesParts.join(''),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewportWidth,
    viewportHeight,
    deviceType: breakpointToDeviceType(breakpoint),
    deviceName: breakpoint
  }
}
