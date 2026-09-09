import pixelmatch from 'pixelmatch'
import type { ImageSize } from '../../shared/automation'
import { AUTOMATION_TOLERANCE } from '../../shared/automationTolerance'
import { clusterDiff } from './clusterDiff'

export interface Raster extends ImageSize { data: Uint8Array }
export function comparePixels(design: Raster, live: Raster, options: { pixelThreshold: number; includeAA: boolean } = { pixelThreshold: AUTOMATION_TOLERANCE.pixelThreshold, includeAA: AUTOMATION_TOLERANCE.includeAA }, tileRows = 256) {
  for (const image of [design, live]) {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) throw new Error('Invalid RGBA image dimensions.')
  }
  if (!Number.isFinite(options.pixelThreshold) || options.pixelThreshold < 0 || options.pixelThreshold > 1 || typeof options.includeAA !== 'boolean') throw new Error('Invalid pixel tolerance.')
  if (!Number.isInteger(tileRows) || tileRows < 1) throw new Error('Invalid tile size.')
  const width = Math.min(design.width, live.width); const height = Math.min(design.height, live.height)
  const mask = new Uint8Array(width * height)
  const copyRows = (image: Raster, start: number, end: number) => {
    const data = new Uint8Array(width * (end - start) * 4)
    for (let y = start; y < end; y++) data.set(image.data.subarray(y * image.width * 4, (y * image.width + width) * 4), (y - start) * width * 4)
    return data
  }
  let changedPixels = 0
  for (let y = 0; y < height; y += tileRows) {
    // AA detection reads neighbors of neighbors. A 2px halo makes tile edges
    // equivalent to running Pixelmatch on the entire common overlap.
    const start = Math.max(0, y - 2); const end = Math.min(height, y + tileRows + 2)
    const a = copyRows(design, start, end); const b = copyRows(live, start, end)
    const output = new Uint8Array(a.length)
    pixelmatch(a, b, output, width, end - start, { threshold: options.pixelThreshold, includeAA: options.includeAA, diffMask: true, diffColor: [255, 0, 0], checkerboard: false })
    for (let row = y; row < Math.min(height, y + tileRows); row++) {
      for (let x = 0; x < width; x++) {
        const changed = output[((row - start) * width + x) * 4 + 3] === 255 ? 1 : 0
        mask[row * width + x] = changed
        changedPixels += changed
      }
    }
  }
  return {
    schemaVersion: 2 as const, engine: 'pixelmatch' as const,
    design: { width: design.width, height: design.height }, live: { width: live.width, height: live.height }, overlap: { width, height },
    dimensions: { widthDelta: live.width - design.width, heightDelta: live.height - design.height },
    changedPixels, changedPercent: changedPixels / mask.length * 100, comparedPixels: mask.length,
    excludedPixels: { design: design.width * design.height - mask.length, live: live.width * live.height - mask.length },
    regions: clusterDiff(mask, width, height), options: { ...options }, mask,
  }
}
