import type { DiffRegion } from '../../shared/automation'

/** Exact 8-connected components. No erosion, area filter, dilation or result cap.
 * Scanline flood fill keeps the frontier small for large solid changed areas. */
export function clusterDiff(mask: Uint8Array, width: number, height: number): DiffRegion[] {
  if (mask.length !== width * height) throw new Error('Diff mask dimensions do not match.')
  const regions: DiffRegion[] = []
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] !== 1) continue
    if (regions.length >= 200_000) throw new Error('The diff exceeds the 200,000-region memory budget. Comparison is unavailable; no regions were silently discarded.')
    const stack = [index]
    let left = width; let top = height; let right = 0; let bottom = 0; let pixels = 0
    while (stack.length) {
      const seed = stack.pop()!
      if (mask[seed] !== 1) continue
      const y = Math.floor(seed / width)
      let x0 = seed % width; let x1 = x0
      while (x0 > 0 && mask[y * width + x0 - 1] === 1) x0--
      while (x1 + 1 < width && mask[y * width + x1 + 1] === 1) x1++
      mask.fill(2, y * width + x0, y * width + x1 + 1)
      pixels += x1 - x0 + 1
      left = Math.min(left, x0); right = Math.max(right, x1)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
      for (const adjacentY of [y - 1, y + 1]) {
        if (adjacentY < 0 || adjacentY >= height) continue
        let inRun = false
        for (let x = Math.max(0, x0 - 1); x <= Math.min(width - 1, x1 + 1); x++) {
          const next = adjacentY * width + x
          if (mask[next] === 1) { if (!inRun) stack.push(next); inRun = true }
          else inRun = false
        }
      }
    }
    const regionWidth = right - left + 1; const regionHeight = bottom - top + 1
    regions.push({ x: left, y: top, width: regionWidth, height: regionHeight, pixels, percent: pixels / (regionWidth * regionHeight) * 100 })
  }
  // Restore the canonical binary mask for callers and repeatable clustering.
  for (let i = 0; i < mask.length; i++) if (mask[i] === 2) mask[i] = 1
  return regions.sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height)
}
