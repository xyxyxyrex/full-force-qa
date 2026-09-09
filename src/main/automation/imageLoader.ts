import { PNG } from 'pngjs'
import type { Raster } from './pixelDiff'

export const MAX_IMAGE_PIXELS = 45_000_000
export function decodeScreenshot(dataUrl: string): Raster {
  if (!/^data:image\/png;base64,/i.test(dataUrl)) throw new Error('Automation requires PNG screenshots.')
  if (dataUrl.length > 256_000_000) throw new Error('Screenshot exceeds the comparison memory budget.')
  const bytes = Buffer.from(dataUrl.substring(dataUrl.indexOf(',') + 1), 'base64')
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12, 16).toString() !== 'IHDR') throw new Error('Invalid PNG screenshot.')
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('Screenshot exceeds the 45 million native-pixel limit; comparison is unavailable. No resizing was applied.')
  return PNG.sync.read(bytes)
}
export function encodeMask(mask: Uint8Array, width: number, height: number): string {
  const png = new PNG({ width, height })
  for (let i = 0; i < mask.length; i++) {
    // Black/white deterministic mask. Excluded area is not present in this image.
    const color = mask[i] ? 255 : 0
    png.data[i * 4] = color; png.data[i * 4 + 1] = color; png.data[i * 4 + 2] = color; png.data[i * 4 + 3] = 255
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`
}
