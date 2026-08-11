/**
 * Figma-vs-live comparison engine. No React, no DOM, no Electron — pure data in,
 * findings out — so it can run under a fixture test as easily as inside the app.
 */

export interface DomNode {
  tag: string; role: string; text: string; src: string; context: string; path: string
  rect: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

export interface ComparedRegion { rect: { x: number; y: number; width: number; height: number }; pageWidth: number; pageHeight: number; label: string }

export interface TokenAssertion { name: string; passed: boolean; figma: string; css: string; isExtended?: boolean; unresolved?: boolean }

export interface FindingComparison { design?: ComparedRegion; live?: ComparedRegion; delta?: { x?: number; y?: number; width?: number; height?: number; fontSize?: number } }

export interface Finding {
  id: string
  severity: 'high' | 'medium' | 'low' | 'pass'
  title: string; detail: string; confidence: number
  comparison?: FindingComparison; tokens?: TokenAssertion[]
}

export const normalizeText = (value = ''): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const textTokens = (value: string) => new Set(normalizeText(value).split(' ').filter(Boolean))

export function tokenScore(left: string, right: string): number {
  const a = normalizeText(left); const b = normalizeText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const minLen = Math.min(a.length, b.length); const maxLen = Math.max(a.length, b.length)
  if (minLen >= 12 && (a.includes(b) || b.includes(a) || (a.length >= 20 && b.includes(a.slice(0, 25))) || (b.length >= 20 && a.includes(b.slice(0, 25))))) {
    return Math.max(0.85, (minLen / maxLen) * 0.95)
  }
  const aa = textTokens(a); const bb = textTokens(b)
  if (!aa.size || !bb.size) return 0
  let common = 0
  aa.forEach((token) => { if (bb.has(token)) common++ })
  const jaccard = common / Math.max(aa.size, bb.size)
  const minSize = Math.min(aa.size, bb.size)
  const containment = minSize >= 3 ? (common / minSize) * 0.90 : jaccard
  return Math.max(jaccard, containment)
}

/** FNV-1a — stable across runs and across Figma node-id churn, which is the point. */
export function stableId(...parts: string[]): string {
  let hash = 0x811c9dc5
  const input = parts.join('|')
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Fits a monotonic step function over ΔY (live − design) so that a section that
 * grew or shrank produces one named step instead of one false "position mismatch"
 * per element below it. Change points are found with a robust windowed median —
 * no need for anything fancier than that.
 */
export function fitVerticalDrift(anchors: Array<{ designY: number; liveY: number }>): {
  steps: Array<{ designY: number; offset: number }>
  sample: (designY: number) => number
} {
  const flat = { steps: [{ designY: 0, offset: 0 }], sample: () => 0 }
  if (!anchors.length) return flat
  const sorted = [...anchors].sort((a, b) => a.designY - b.designY)
  const deltas = sorted.map((a) => a.liveY - a.designY)
  const MIN_SEG = 3
  const JUMP_PX = 18
  const steps: Array<{ designY: number; offset: number }> = []
  let segStart = 0
  for (let i = 1; i <= sorted.length; i++) {
    const atEnd = i === sorted.length
    const windowStart = Math.max(segStart, i - MIN_SEG)
    const jumped = !atEnd && Math.abs(deltas[i] - median(deltas.slice(windowStart, i))) > JUMP_PX
    if (atEnd || (jumped && i - segStart >= MIN_SEG)) {
      steps.push({ designY: sorted[segStart].designY, offset: median(deltas.slice(segStart, i)) })
      segStart = i
    }
  }
  if (!steps.length) return flat
  const sample = (designY: number) => {
    let offset = steps[0].offset
    for (const step of steps) { if (designY >= step.designY) offset = step.offset; else break }
    return offset
  }
  return { steps, sample }
}

type Rgb = [number, number, number]

function srgbToLinear(channel: number): number {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function rgbToLab([r, g, b]: Rgb): [number, number, number] {
  const rl = srgbToLinear(r); const gl = srgbToLinear(g); const bl = srgbToLinear(b)
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
  const xn = 0.95047; const yn = 1.0; const zn = 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / xn); const fy = f(y / yn); const fz = f(z / zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function deltaE(a: Rgb, b: Rgb): number {
  const labA = rgbToLab(a); const labB = rgbToLab(b)
  return Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2])
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1)}`.toLowerCase()
}

/** Composites Figma fill + node opacity over a white canvas — the same ground the analyst is looking at. */
export function figmaColorToRgb(fills: any[], nodeOpacity = 1): Rgb | null {
  if (!Array.isArray(fills)) return null
  const solid = fills.find((f) => f.visible !== false && f.type === 'SOLID' && f.color)
  if (!solid) return null
  const alpha = (solid.opacity ?? 1) * (typeof nodeOpacity === 'number' ? nodeOpacity : 1)
  const r = (solid.color.r || 0) * 255; const g = (solid.color.g || 0) * 255; const b = (solid.color.b || 0) * 255
  return [r * alpha + 255 * (1 - alpha), g * alpha + 255 * (1 - alpha), b * alpha + 255 * (1 - alpha)]
}

export function parseCssColorToRgb(cssColor: string): Rgb | null {
  if (!cssColor) return null
  if (cssColor.startsWith('#')) {
    const hex = cssColor.slice(1)
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    if (full.length < 6) return null
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const match = cssColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
  if (!match) return null
  const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1
  const r = parseFloat(match[1]); const g = parseFloat(match[2]); const b = parseFloat(match[3])
  return [r * alpha + 255 * (1 - alpha), g * alpha + 255 * (1 - alpha), b * alpha + 255 * (1 - alpha)]
}

// ── Correspondence: banding, optimal assignment, merge/split repair ─────────

/**
 * Kuhn–Munkres (Hungarian) algorithm: the minimum-cost perfect assignment on a
 * square cost matrix, in O(n³). `Infinity` marks a forbidden pairing. Band sizes
 * here are small (single digits to low tens of elements), so the cubic cost is
 * irrelevant — this runs once per comparison, not in a hot loop.
 */
export function hungarianAssignment(cost: number[][]): number[] {
  const n = cost.length
  if (n === 0) return []
  const INF = Infinity
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0) // p[j] = 1-indexed row currently assigned to column j
  const way = new Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(INF)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF; let j1 = -1
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta }
        else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }
  const rowAssignment = new Array(n).fill(-1)
  for (let j = 1; j <= n; j++) if (p[j] > 0) rowAssignment[p[j] - 1] = j - 1
  return rowAssignment
}

interface PairScore { score: number; geometry: number; text: number }

/** The same scoring formula the matcher has always used — text similarity carries
 *  most of the weight, geometry and context break ties. Correspondence-only: the
 *  score this returns ranks candidates, it is never reused to report an error. */
function pairScore(design: any, candidate: DomNode, root: { x: number; y: number; width: number; height: number }, liveWidth: number, liveHeight: number): PairScore | null {
  const designText = normalizeText(design.characters)
  const candidateText = normalizeText(candidate.text)
  const exact = designText === candidateText
  const text = tokenScore(design.characters, candidate.text)
  if ((!exact && text < .45) || (!exact && Math.min(designText.length, candidateText.length) < 5)) return null
  const box = design.absoluteBoundingBox
  const dx = Math.abs((box.x - root.x) / root.width - candidate.rect.x / liveWidth)
  const dy = Math.abs((box.y - root.y) / root.height - candidate.rect.y / liveHeight)
  const normalizedDistance = Math.hypot(dx, dy)
  if (!exact && text < .50 && normalizedDistance > .45) return null
  const geometry = Math.max(0, 1 - normalizedDistance * 2.0)
  const context = tokenScore(design.__context || '', `${candidate.context} ${candidate.path}`)
  const expectedFont = Number(design.style?.fontSize || 0)
  const headingAffinity = expectedFont >= 20 ? (/^h[1-6]$/.test(candidate.tag) ? .06 : -.08) : 0
  return { score: text * .68 + geometry * .23 + context * .09 + headingAffinity, geometry, text }
}

interface Anchor { designIndex: number; liveIndex: number; designY: number; liveY: number; match: PairScore }

/**
 * Mutual best-matches at high confidence — design_i's best candidate is live_j
 * AND live_j's best design match is also design_i. These cut both documents into
 * corresponding bands so an inserted or removed section stays local instead of
 * cascading through every match that follows it.
 */
function findMutualAnchors(designItems: any[], candidates: DomNode[], root: { x: number; y: number; width: number; height: number }, score: (d: any, c: DomNode) => PairScore | null): Anchor[] {
  const designBest: Array<{ liveIndex: number; match: PairScore } | null> = designItems.map((design) => {
    let best: { liveIndex: number; match: PairScore } | null = null
    candidates.forEach((candidate, liveIndex) => {
      const result = score(design, candidate)
      if (result && (!best || result.score > best.match.score)) best = { liveIndex, match: result }
    })
    return best
  })
  const liveBest: Array<{ designIndex: number; match: PairScore } | null> = candidates.map((candidate) => {
    let best: { designIndex: number; match: PairScore } | null = null
    designItems.forEach((design, designIndex) => {
      const result = score(design, candidate)
      if (result && (!best || result.score > best.match.score)) best = { designIndex, match: result }
    })
    return best
  })
  const anchors: Anchor[] = []
  designItems.forEach((design, designIndex) => {
    const db = designBest[designIndex]
    if (!db || db.match.score < 0.85) return
    const lb = liveBest[db.liveIndex]
    if (lb && lb.designIndex === designIndex) {
      anchors.push({ designIndex, liveIndex: db.liveIndex, designY: design.absoluteBoundingBox.y - root.y, liveY: candidates[db.liveIndex].rect.y, match: db.match })
    }
  })
  return anchors.sort((a, b) => a.designY - b.designY)
}

const BAND_MATCH_FLOOR = 0.48

/** Optimal assignment within one band: every design/live pairing's cost, a
 *  dummy row and column per side so a genuine non-match doesn't have to be
 *  forced, then Hungarian over the padded square matrix. */
function solveBandAssignment(
  designIndices: number[], liveIndices: number[], designItems: any[], candidates: DomNode[],
  score: (d: any, c: DomNode) => PairScore | null
): Map<number, { liveIndex: number; match: PairScore }> {
  const result = new Map<number, { liveIndex: number; match: PairScore }>()
  if (!designIndices.length || !liveIndices.length) return result
  const n = designIndices.length; const m = liveIndices.length; const size = n + m
  const NO_MATCH_COST = 1 - BAND_MATCH_FLOOR + 0.01 // worse than any acceptable real match
  const scores: Array<Array<PairScore | null>> = designIndices.map((di) => liveIndices.map((li) => score(designItems[di], candidates[li])))
  const cost: number[][] = Array.from({ length: size }, () => new Array(size).fill(NO_MATCH_COST))
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const s = scores[i][j]; if (s) cost[i][j] = 1 - s.score }
  for (let i = n; i < size; i++) for (let j = 0; j < size; j++) cost[i][j] = j >= m ? 0 : NO_MATCH_COST // dummy design rows only pair with dummy live columns for free
  const assignment = hungarianAssignment(cost)
  for (let i = 0; i < n; i++) {
    const j = assignment[i]
    if (j < m) {
      const s = scores[i][j]
      if (s && s.score >= BAND_MATCH_FLOOR) result.set(designIndices[i], { liveIndex: liveIndices[j], match: s })
    }
  }
  return result
}

function mergeDesignPair(a: any, b: any): any {
  const boxA = a.absoluteBoundingBox; const boxB = b.absoluteBoundingBox
  const x = Math.min(boxA.x, boxB.x); const y = Math.min(boxA.y, boxB.y)
  const right = Math.max(boxA.x + boxA.width, boxB.x + boxB.width); const bottom = Math.max(boxA.y + boxA.height, boxB.y + boxB.height)
  return { ...a, characters: `${a.characters} ${b.characters}`, absoluteBoundingBox: { x, y, width: right - x, height: bottom - y } }
}

function mergeLivePair(a: DomNode, b: DomNode): DomNode {
  const x = Math.min(a.rect.x, b.rect.x); const y = Math.min(a.rect.y, b.rect.y)
  const right = Math.max(a.rect.x + a.rect.width, b.rect.x + b.rect.width); const bottom = Math.max(a.rect.y + a.rect.height, b.rect.y + b.rect.height)
  return { ...a, text: `${a.text} ${b.text}`, rect: { x, y, width: right - x, height: bottom - y } }
}

interface RepairResult {
  additions: Array<{ design: any; live: DomNode; match: PairScore }>
  consumedDesign: Set<number>
  consumedLive: Set<number>
}

/**
 * Repairs the case a fixed 1:1 assignment can't represent: one browser element
 * that renders several Figma text layers, or the reverse. The common shape isn't
 * two mutually-unmatched leftovers — it's one split-off run left stranded because
 * its sibling alone already looked like a good enough match and claimed the only
 * live counterpart. So this also revises an existing assignment when merging the
 * stranded neighbor into it scores at least as well. Bounded on purpose — only
 * adjacent items, only within a band — this is a post-pass, not a second engine.
 */
function repairMergesSplits(
  designIndices: number[], liveIndices: number[], assignment: Map<number, { liveIndex: number; match: PairScore }>,
  designItems: any[], candidates: DomNode[],
  root: { x: number; y: number; width: number; height: number }, liveWidth: number, liveHeight: number
): RepairResult {
  const additions: Array<{ design: any; live: DomNode; match: PairScore }> = []
  const consumedDesign = new Set<number>(); const consumedLive = new Set<number>()
  const MERGE_FLOOR = 0.55; const REGRESSION_TOLERANCE = 0.05

  // ---- 2 design layers → the 1 live node a neighbor already claimed ----
  const byDesignY = [...designIndices].sort((a, b) => designItems[a].absoluteBoundingBox.y - designItems[b].absoluteBoundingBox.y)
  for (const u of byDesignY.filter((i) => !assignment.has(i))) {
    if (consumedDesign.has(u)) continue
    const pos = byDesignY.indexOf(u)
    const neighbors = [byDesignY[pos - 1], byDesignY[pos + 1]].filter((n): n is number => n !== undefined && assignment.has(n) && !consumedDesign.has(n))
    for (const neighbor of neighbors) {
      const neighborMatch = assignment.get(neighbor)!
      const [first, second] = designItems[u].absoluteBoundingBox.y < designItems[neighbor].absoluteBoundingBox.y ? [u, neighbor] : [neighbor, u]
      const merged = mergeDesignPair(designItems[first], designItems[second])
      const result = pairScore(merged, candidates[neighborMatch.liveIndex], root, liveWidth, liveHeight)
      if (result && result.score >= MERGE_FLOOR && result.score >= neighborMatch.match.score - REGRESSION_TOLERANCE) {
        additions.push({ design: merged, live: candidates[neighborMatch.liveIndex], match: result })
        consumedDesign.add(u); consumedDesign.add(neighbor); consumedLive.add(neighborMatch.liveIndex)
        break
      }
    }
  }

  // ---- 2 live nodes → the 1 design layer a neighbor already claimed ----
  const matchedLiveOf = new Map<number, number>()
  assignment.forEach((v, designIndex) => matchedLiveOf.set(v.liveIndex, designIndex))
  const byLiveY = [...liveIndices].sort((a, b) => candidates[a].rect.y - candidates[b].rect.y)
  for (const u of byLiveY.filter((i) => !matchedLiveOf.has(i))) {
    if (consumedLive.has(u)) continue
    const pos = byLiveY.indexOf(u)
    const neighbors = [byLiveY[pos - 1], byLiveY[pos + 1]].filter((n): n is number => n !== undefined && matchedLiveOf.has(n) && !consumedLive.has(n))
    for (const neighborLive of neighbors) {
      const neighborDesignIndex = matchedLiveOf.get(neighborLive)!
      if (consumedDesign.has(neighborDesignIndex)) continue
      const neighborMatch = assignment.get(neighborDesignIndex)!
      const [first, second] = candidates[u].rect.y < candidates[neighborLive].rect.y ? [u, neighborLive] : [neighborLive, u]
      const merged = mergeLivePair(candidates[first], candidates[second])
      const result = pairScore(designItems[neighborDesignIndex], merged, root, liveWidth, liveHeight)
      if (result && result.score >= MERGE_FLOOR && result.score >= neighborMatch.match.score - REGRESSION_TOLERANCE) {
        additions.push({ design: designItems[neighborDesignIndex], live: merged, match: result })
        consumedDesign.add(neighborDesignIndex); consumedLive.add(u); consumedLive.add(neighborLive)
        break
      }
    }
  }

  return { additions, consumedDesign, consumedLive }
}

interface MatchedPair {
  design: any; live: DomNode; best: { index: number; score: number; geometry: number; text: number }
  box: { x: number; y: number; width: number; height: number }
  label: string; designContext: string; adjustedDesignRect: { x: number; y: number; width: number; height: number }
  designCenterY: number; designCenterX: number
}

interface AutoLayoutGroup { frameName: string; layoutMode: 'HORIZONTAL' | 'VERTICAL'; itemSpacing: number; textChildren: any[] }

/** Auto-layout `itemSpacing` is the design's literal, numeric gap spec — the richest
 *  untapped signal in a Figma file. Only direct TEXT children are considered: it's
 *  the one grouping shape guaranteed comparable without a container-matching pass. */
function collectAutoLayoutGroups(node: any, groups: AutoLayoutGroup[]): void {
  if (node.visible === false) return
  if ((node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') && Array.isArray(node.children) && typeof node.itemSpacing === 'number') {
    const directText = node.children.filter((child: any) => child.visible !== false && child.type === 'TEXT' && child.absoluteBoundingBox)
    if (directText.length >= 2) groups.push({ frameName: node.name || 'Frame', layoutMode: node.layoutMode, itemSpacing: node.itemSpacing, textChildren: directText })
  }
  for (const child of node.children || []) collectAutoLayoutGroups(child, groups)
}

export function semanticFindings(figmaRoot: any, domNodes: DomNode[], liveWidth: number, liveHeight: number, styleNames: Record<string, string> = {}): Finding[] {
  const root = figmaRoot?.absoluteBoundingBox || { x: 0, y: 0, width: liveWidth, height: liveHeight }
  const figmaText: any[] = []; const figmaImages: any[] = []
  const walk = (node: any, ancestors: any[] = []) => {
    if (node.visible !== false && node.absoluteBoundingBox) {
      if (node.type === 'TEXT' && normalizeText(node.characters || '')) {
        figmaText.push({ ...node, __context: ancestors.slice(-5).map((item) => item?.name || '').filter(Boolean).join(' ') })
      }
      if (Array.isArray(node.fills) && node.fills.some((fill: any) => fill?.type === 'IMAGE')) figmaImages.push(node)
    }
    for (const child of node.children || []) walk(child, [...ancestors, node])
  }
  walk(figmaRoot)
  const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'li', 'span', 'div', 'dt', 'dd', 'summary', 'figcaption', 'th', 'td'])
  const candidates = domNodes.filter((node) => node.text && textTags.has(node.tag))
  const findings: Finding[] = []; const matchedPairs: MatchedPair[] = []
  const designItems = figmaText.slice(0, 240)

  const score = (design: any, candidate: DomNode) => pairScore(design, candidate, root, liveWidth, liveHeight)

  const finalizePair = (design: any, live: DomNode, matchScore: { score: number; geometry: number; text: number }) => {
    const label = String(design.characters).trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRect = { x: design.absoluteBoundingBox.x - root.x, y: design.absoluteBoundingBox.y - root.y, width: design.absoluteBoundingBox.width, height: design.absoluteBoundingBox.height }
    const designContext = String(design.__context || '').trim().replace(/\s+/g, ' ').slice(0, 72)

    const figmaFullText = String(design.characters || '').trim()
    const figmaParagraphs = figmaFullText.split(/\n\s*\n/).filter(Boolean)
    let adjustedDesignRect = { ...designRect }
    if (figmaParagraphs.length > 1 && live.text) {
      const matchedIndex = figmaParagraphs.findIndex((p) => tokenScore(p, live.text) >= 0.50)
      const idx = matchedIndex >= 0 ? matchedIndex : 0
      const targetP = figmaParagraphs[idx]
      const pRatio = Math.min(1, targetP.length / Math.max(1, figmaFullText.length))
      const targetHeight = Math.max(20, Math.round(designRect.height * pRatio))
      const yOffset = (designRect.height / figmaParagraphs.length) * idx
      adjustedDesignRect = { ...designRect, y: Math.round(designRect.y + yOffset), height: targetHeight }
    }

    // Compare vertical centers, not box tops — a text frame's top and a CSS line
    // box's top differ by roughly half the leading, which otherwise reads as a
    // uniform position error on every single text element in the page.
    matchedPairs.push({
      design, live, best: { index: -1, ...matchScore }, box: design.absoluteBoundingBox, label, designContext, adjustedDesignRect,
      designCenterY: adjustedDesignRect.y + adjustedDesignRect.height / 2,
      designCenterX: designRect.x + designRect.width / 2
    })
  }

  const pushMissing = (design: any) => {
    const label = String(design.characters).trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRect = { x: design.absoluteBoundingBox.x - root.x, y: design.absoluteBoundingBox.y - root.y, width: design.absoluteBoundingBox.width, height: design.absoluteBoundingBox.height }
    const designContext = String(design.__context || '').trim().replace(/\s+/g, ' ').slice(0, 72)
    const designRegion: ComparedRegion = { rect: designRect, pageWidth: root.width, pageHeight: root.height, label: `TEXT · ${label}${designContext ? ` · ${designContext}` : ''}` }
    findings.push({ id: stableId('missing', label, String(Math.round(designRect.y))), severity: 'high', title: `Missing design text: “${label}”`, detail: 'No sufficiently similar visible DOM element was found.', confidence: 100, comparison: { design: designRegion } })
  }

  // ---- Correspondence, in three steps ----
  //
  // 1. Anchor: mutual best-matches (design_i's best candidate is live_j, and
  //    live_j's best design match is also design_i) at high confidence. These cut
  //    both documents into corresponding bands, so a section inserted or removed
  //    on one side stays local instead of cascading through everything after it.
  // 2. Solve: within each band, an optimal assignment over the full cost matrix —
  //    not a single greedy scan — so one early low-confidence claim can no longer
  //    block the correct match for something later in the list.
  // 3. Repair: adjacent leftovers get one merge/split pass (2 design texts → 1
  //    live node, or the reverse) before anything is called missing.
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

  // ---- Drift decomposition: fit what page growth explains, so what's left over
  // is the actual local defect instead of a false positive on everything below it. ----
  const confidentPairs = matchedPairs.filter((p) => p.best.score >= 0.6)
  const verticalDrift = fitVerticalDrift(confidentPairs.map((p) => ({
    designY: p.designCenterY, liveY: p.live.rect.y + p.live.rect.height / 2
  })))
  const globalDx = median(confidentPairs.map((p) =>
    (p.live.rect.x + p.live.rect.width / 2) - (p.designCenterX / root.width * liveWidth)
  ))

  // ---- Auto-layout spacing: measure the actual pixel gap between rendered
  // siblings rather than trusting a CSS `gap` declaration that may not exist —
  // margins collapse, but rendered space doesn't lie. ----
  const autoLayoutGroups: AutoLayoutGroup[] = []
  collectAutoLayoutGroups(figmaRoot, autoLayoutGroups)
  if (autoLayoutGroups.length) {
    const matchByDesignId = new Map(matchedPairs.map((p) => [p.design.id, p]))
    for (const group of autoLayoutGroups) {
      const measured: number[] = []
      for (let i = 0; i < group.textChildren.length - 1; i++) {
        const a = matchByDesignId.get(group.textChildren[i].id)
        const b = matchByDesignId.get(group.textChildren[i + 1].id)
        if (!a || !b || a.best.score < 0.6 || b.best.score < 0.6) continue
        const gap = group.layoutMode === 'VERTICAL'
          ? b.live.rect.y - (a.live.rect.y + a.live.rect.height)
          : b.live.rect.x - (a.live.rect.x + a.live.rect.width)
        measured.push(gap)
      }
      // Two samples minimum — one noisy pair shouldn't produce a hard finding.
      if (measured.length < 2) continue
      const measuredGap = median(measured)
      const drift = Math.abs(measuredGap - group.itemSpacing)
      if (drift > 3) {
        findings.push({
          id: stableId('spacing', group.frameName, String(group.itemSpacing)),
          severity: drift > 12 ? 'medium' : 'low',
          title: `Spacing mismatch in “${group.frameName}”`,
          detail: `Figma ${group.layoutMode === 'VERTICAL' ? 'row' : 'column'} gap is ${group.itemSpacing}px; the live page measures ${Math.round(measuredGap)}px between rendered siblings (${measured.length} samples).`,
          confidence: 85
        })
      }
    }
  }

  // ---- Pass 2: every matched pair gets both a position finding and a token
  // finding — a defect can be "wrong size AND wrong place" now. ----
  for (const pair of matchedPairs) {
    const { design, live, best, box, label, designContext, adjustedDesignRect, designCenterY, designCenterX } = pair
    const findingKey = stableId(live.path || live.tag, label)
    const expectedCenterY = designCenterY + verticalDrift.sample(designCenterY)
    const liveCenterY = live.rect.y + live.rect.height / 2
    const dyEffective = Math.abs(liveCenterY - expectedCenterY)

    const expectedLeftX = (box.x - root.x) / root.width * liveWidth + globalDx
    const expectedCenterX = designCenterX / root.width * liveWidth + globalDx
    const liveCenterX = live.rect.x + live.rect.width / 2
    const dxLeft = Math.abs(expectedLeftX - live.rect.x)
    const dxCenter = Math.abs(expectedCenterX - liveCenterX)
    const dxEffective = Math.min(dxLeft, dxCenter)

    const expectedFont = Number(design.style?.fontSize || 0); const actualFont = parseFloat(live.styles.fontSize || '0')
    const matchedDesignRegion: ComparedRegion = { rect: adjustedDesignRect, pageWidth: root.width, pageHeight: root.height, label: `TEXT · ${label}${designContext ? ` · ${designContext}` : ''}` }
    const liveRegion: ComparedRegion = { rect: live.rect, pageWidth: liveWidth, pageHeight: liveHeight, label: `<${live.tag}> · ${live.text.slice(0, 54)}${live.context ? ` · ${live.context.slice(0, 42)}` : ''}` }
    const comparison: FindingComparison = { design: matchedDesignRegion, live: liveRegion, delta: { x: dxEffective === dxLeft ? live.rect.x - expectedLeftX : liveCenterX - expectedCenterX, y: liveCenterY - expectedCenterY, width: live.rect.width - adjustedDesignRect.width / root.width * liveWidth, height: live.rect.height - adjustedDesignRect.height / root.height * liveHeight } }

    if (dyEffective > 28 || dxEffective > 45) {
      findings.push({ id: stableId(findingKey, 'position'), severity: (dyEffective > 60 || dxEffective > 100) ? 'high' : 'medium', title: `Position mismatch: “${label}”`, detail: `Matched <${live.tag}> is displaced from its drift-corrected expected position (residual ΔY ${Math.round(dyEffective)}px, ΔX ${Math.round(dxEffective)}px).`, confidence: Math.round(best.score * 100), comparison })
    } else if (dyEffective <= 15 && dxEffective <= 20 && best.score >= 0.70) {
      findings.push({ id: stableId(findingKey, 'position'), severity: 'pass', title: `Spec Verified: Position & Content “${label}”`, detail: `Matched <${live.tag}> at expected location (residual ΔY ${Math.round(dyEffective)}px, ΔX ${Math.round(dxEffective)}px)`, confidence: Math.round(best.score * 100), comparison })
    }

    const tokenList: TokenAssertion[] = []
    if (expectedFont && actualFont) {
      const passed = Math.abs(expectedFont - actualFont) <= 1.0
      tokenList.push({ name: 'font-size', passed, figma: `${expectedFont}px`, css: `${Math.round(actualFont * 10) / 10}px` })
    }
    const expectedWeight = Number(design.style?.fontWeight || 400); const actualWeight = Number(live.styles.fontWeight || 400)
    if (expectedWeight && actualWeight) {
      const passed = Math.abs(expectedWeight - actualWeight) < 100
      tokenList.push({ name: 'font-weight', passed, figma: `${expectedWeight}`, css: `${actualWeight}` })
    }
    const expectedLineHeight = Math.round(Number(design.style?.lineHeightPx || 0))
    const rawLiveLineHeight = live.styles.lineHeight || ''
    const actualLineHeight = Math.round(parseFloat(rawLiveLineHeight))
    if (expectedLineHeight > 0 && Number.isFinite(actualLineHeight) && actualLineHeight > 0) {
      const passed = Math.abs(expectedLineHeight - actualLineHeight) <= 2.5
      tokenList.push({ name: 'line-height', passed, figma: `${expectedLineHeight}px`, css: `${actualLineHeight}px` })
    } else if (expectedLineHeight > 0 && rawLiveLineHeight) {
      // "normal" (or anything else unparseable) isn't a value we can compare — say so
      // instead of quietly dropping the assertion, which reads as a silent pass.
      tokenList.push({ name: 'line-height', passed: false, unresolved: true, figma: `${expectedLineHeight}px`, css: rawLiveLineHeight })
    }
    const expectedLetterSpacing = Number(design.style?.letterSpacing || 0)
    const rawCssLs = live.styles.letterSpacing || '0'
    const actualLetterSpacing = (rawCssLs === 'normal' || !rawCssLs) ? 0 : (parseFloat(rawCssLs) || 0)
    if (!isNaN(actualLetterSpacing)) {
      const passed = Math.abs(expectedLetterSpacing - actualLetterSpacing) <= 0.5
      tokenList.push({ name: 'letter-spacing', passed, figma: `${Math.round(expectedLetterSpacing * 10) / 10}px`, css: `${Math.round(actualLetterSpacing * 10) / 10}px` })
    }
    const expectedFamily = String(design.style?.fontFamily || '').trim()
    const actualFamily = String(live.styles.fontFamily || '').trim()
    if (expectedFamily && actualFamily) {
      const passed = actualFamily.toLowerCase().includes(expectedFamily.toLowerCase())
      tokenList.push({ name: 'font-family', passed, figma: expectedFamily, css: actualFamily.split(',')[0].replace(/["']/g, '') })
    }
    const figmaRgb = figmaColorToRgb(design.fills, design.opacity)
    const liveRgb = parseCssColorToRgb(live.styles.color)
    if (figmaRgb && liveRgb) {
      const distance = deltaE(figmaRgb, liveRgb)
      const passed = distance <= 2.3 // ~ the smallest colour difference a human reliably notices
      tokenList.push({ name: 'color', passed, figma: rgbToHex(figmaRgb), css: passed ? rgbToHex(liveRgb) : `${rgbToHex(liveRgb)} · ΔE ${distance.toFixed(1)}` })
    }

    // Extended UI Properties (only revealed via [...more] button if inconsistent)
    const figmaAlign = String(design.style?.textAlignHorizontal || '').toLowerCase()
    const liveAlign = String(live.styles.textAlign || '').toLowerCase()
    if (figmaAlign && liveAlign && figmaAlign !== 'left') {
      const passed = liveAlign.includes(figmaAlign) || (figmaAlign === 'justified' && liveAlign === 'justify')
      if (!passed) tokenList.push({ name: 'text-align', passed: false, figma: figmaAlign, css: liveAlign, isExtended: true })
    }
    const figmaBgRgb = figmaColorToRgb(design.fills, design.opacity)
    const liveBgRgb = parseCssColorToRgb(live.styles.backgroundColor)
    if (figmaBgRgb && liveBgRgb && live.styles.backgroundColor && !/transparent|rgba?\(0,\s*0,\s*0,\s*0\)/.test(live.styles.backgroundColor)) {
      const distance = deltaE(figmaBgRgb, liveBgRgb)
      if (distance > 4.0) tokenList.push({ name: 'bg-color', passed: false, figma: rgbToHex(figmaBgRgb), css: `${rgbToHex(liveBgRgb)} · ΔE ${distance.toFixed(1)}`, isExtended: true })
    }
    if (design.cornerRadius && live.styles.borderRadius) {
      const expectedRadius = Number(design.cornerRadius || 0)
      const actualRadius = parseFloat(live.styles.borderRadius || '0')
      if (expectedRadius > 0 && Math.abs(expectedRadius - actualRadius) > 2) {
        tokenList.push({ name: 'border-radius', passed: false, figma: `${expectedRadius}px`, css: `${actualRadius}px`, isExtended: true })
      }
    }
    // Designer-typed caps read the same as text-transform: uppercase in a rendered
    // screenshot but are a different defect — this only fires when Figma applied an
    // automatic case transform the live CSS doesn't declare.
    const figmaCaseMap: Record<string, string> = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }
    const expectedTransform = figmaCaseMap[String(design.style?.textCase || '').toUpperCase()]
    if (expectedTransform) {
      const liveTransform = String(live.styles.textTransform || 'none').toLowerCase()
      if (liveTransform !== expectedTransform) tokenList.push({ name: 'text-case', passed: false, figma: expectedTransform, css: liveTransform, isExtended: true })
    }
    // The declared family matching Figma's spec (checked above) doesn't mean it
    // actually rendered — a failed webfont load falls back silently and every
    // value-level check still passes. This is the only check that catches that.
    if (live.styles.fontLoaded === 'false') {
      tokenList.push({ name: 'font-loaded', passed: false, figma: expectedFamily || String(design.style?.fontFamily || 'expected family'), css: 'fell back to a substitute — declared family did not render' })
    }

    if (tokenList.length > 0) {
      const fails = tokenList.filter((t) => !t.passed && !t.unresolved)
      const passes = tokenList.filter((t) => t.passed)
      const unresolved = tokenList.filter((t) => t.unresolved)
      const isPass = fails.length === 0
      const title = isPass ? `CSS Tokens Verified: “${label}”` : `CSS Token Mismatch: “${label}”`
      // A resolved style name turns "40px" into "text/heading-2" — the difference
      // between a ticket that names an instance and one that names the system.
      const styleId = design.styles?.text || design.styles?.fill
      const styleName = styleId ? styleNames[styleId] : ''
      const detailParts = [
        styleName ? `Figma style: ${styleName}` : '',
        isPass ? `${passes.length} typography tokens verified against Figma spec` : `Mismatch on ${fails.map((f) => `${f.name} (Figma ${f.figma} vs CSS ${f.css})`).join(', ')}`,
        unresolved.length ? `${unresolved.map((t) => t.name).join(', ')} could not be resolved (${unresolved.map((t) => t.css).join(', ')})` : ''
      ].filter(Boolean)

      findings.push({
        id: stableId(findingKey, 'tokens'),
        severity: isPass ? 'pass' : fails.some((f) => f.name === 'font-size' || f.name === 'font-loaded') ? 'high' : 'medium',
        title,
        detail: detailParts.join(' · '),
        confidence: isPass ? 98 : 92,
        tokens: tokenList,
        comparison
      })
    }
  }

  // ---- One finding per real step, not one per element below it ----
  let previousOffset = 0
  verticalDrift.steps.forEach((step, index) => {
    if (index > 0 && Math.abs(step.offset - previousOffset) > 15) {
      const shift = Math.round(step.offset - previousOffset)
      findings.push({
        id: stableId('drift-step', String(Math.round(step.designY))),
        severity: Math.abs(shift) > 60 ? 'high' : 'medium',
        title: `Section growth near design Y ${Math.round(step.designY)}px shifts everything below by ${shift > 0 ? '+' : ''}${shift}px`,
        detail: 'Detected from a change in the matched-element offset trend, not from a single element — likely one section that grew or shrank rather than many separately misplaced elements.',
        confidence: 88,
        comparison: {
          design: { rect: { x: 0, y: step.designY, width: root.width, height: 4 }, pageWidth: root.width, pageHeight: root.height, label: `Design Y ${Math.round(step.designY)}px` },
          live: { rect: { x: 0, y: step.designY + step.offset, width: liveWidth, height: 4 }, pageWidth: liveWidth, pageHeight: liveHeight, label: `Live Y ${Math.round(step.designY + step.offset)}px` },
          delta: { y: shift }
        }
      })
    }
    previousOffset = step.offset
  })
  if (Math.abs(globalDx) > 8) {
    findings.push({
      id: stableId('global-dx'),
      severity: Math.abs(globalDx) > 30 ? 'medium' : 'low',
      title: `Container is shifted ${Math.round(globalDx)}px horizontally from spec`,
      detail: 'A single consistent horizontal offset was detected across matched elements — check the outer container width or margin rather than each element individually.',
      confidence: 80
    })
  }

  const liveImages = domNodes.filter((node) => node.tag === 'img')
  if (figmaImages.length !== liveImages.length) findings.push({ id: stableId('image-count'), severity: 'medium', title: 'Image count differs', detail: `Figma contains ${figmaImages.length} image layers; the live page contains ${liveImages.length} visible images.`, confidence: 72, comparison: { design: { rect: { x: 0, y: 0, width: root.width, height: root.height }, pageWidth: root.width, pageHeight: root.height, label: `${figmaImages.length} Figma image layers` }, live: { rect: { x: 0, y: 0, width: liveWidth, height: liveHeight }, pageWidth: liveWidth, pageHeight: liveHeight, label: `${liveImages.length} live images` } } })
  if (!findings.length) findings.push({ id: stableId('no-findings'), severity: 'pass', title: 'No material semantic mismatches detected', detail: `${figmaText.length} text layers and ${figmaImages.length} image layers were evaluated.`, confidence: 92 })
  const rank = { high: 0, medium: 1, low: 2, pass: 3 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export function extractSemanticAnchors(figmaRoot: any, domNodes: DomNode[], liveWidth: number, liveHeight: number): Array<{ designY: number; liveY: number; confidence: number }> {
  const root = figmaRoot?.absoluteBoundingBox || { x: 0, y: 0, width: liveWidth, height: liveHeight }
  const figmaText: any[] = []
  const walk = (node: any) => {
    if (node.visible !== false && node.absoluteBoundingBox) {
      if (node.type === 'TEXT' && normalizeText(node.characters || '')) {
        figmaText.push(node)
      }
    }
    for (const child of node.children || []) walk(child)
  }
  walk(figmaRoot)

  const textTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'li', 'span', 'dt', 'dd', 'summary'])
  const candidates = domNodes.filter((node) => node.text && textTags.has(node.tag))
  const anchors: Array<{ designY: number; liveY: number; confidence: number }> = []
  const used = new Set<number>()

  for (const design of figmaText) {
    const designText = normalizeText(design.characters)
    if (designText.length < 5) continue

    let bestIdx = -1
    let bestScore = 0

    for (let index = 0; index < candidates.length; index++) {
      if (used.has(index)) continue
      const candidate = candidates[index]
      const candidateText = normalizeText(candidate.text)

      let score = 0
      if (designText === candidateText) {
        score = 1.0
      } else {
        const tScore = tokenScore(design.characters, candidate.text)
        if (tScore > 0.85 && Math.min(designText.length, candidateText.length) >= 10) {
          score = tScore
        }
      }

      if (score > bestScore) {
        bestScore = score
        bestIdx = index
      }
    }

    if (bestIdx >= 0 && bestScore >= 0.85) {
      used.add(bestIdx)
      const live = candidates[bestIdx]
      const designY = design.absoluteBoundingBox.y - root.y
      anchors.push({ designY, liveY: live.rect.y, confidence: bestScore })
    }
  }

  return anchors.sort((a, b) => a.designY - b.designY)
}

// ── Bridge to the annotation system ──────────────────────────────────────────
// Converts a Finding into the shape EditorWorkspace's annotation pipeline needs.
// One direction only: an annotation created from a finding is indistinguishable
// from a hand-drawn one afterward, so it rides the existing share/workflow/viewer
// pipeline for free — nothing here talks to Supabase or the viewer directly.

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
  if (finding.severity === 'pass') return null
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
