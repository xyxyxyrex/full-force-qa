export const normalizeText = (value = ''): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
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
