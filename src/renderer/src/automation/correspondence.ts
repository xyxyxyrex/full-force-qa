import type { DomNode } from '../utils/visualCompare'
import { normalizeText, tokenScore } from '../../../shared/automationText'
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

export interface PairScore { score: number; geometry: number; text: number }

/** The same scoring formula the matcher has always used — text similarity carries
 *  most of the weight, geometry and context break ties. Correspondence-only: the
 *  score this returns ranks candidates, it is never reused to report an error. */
export function pairScore(design: any, candidate: DomNode, root: { x: number; y: number; width: number; height: number }, liveWidth: number, liveHeight: number): PairScore | null {
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
 * Mutual best-ranked candidates — design_i's best candidate is live_j
 * AND live_j's best design match is also design_i. These cut both documents into
 * corresponding bands so an inserted or removed section stays local instead of
 * cascading through every match that follows it.
 */
export function findMutualAnchors(designItems: any[], candidates: DomNode[], root: { x: number; y: number; width: number; height: number }, score: (d: any, c: DomNode) => PairScore | null): Anchor[] {
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
export function solveBandAssignment(
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
export function repairMergesSplits(
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
