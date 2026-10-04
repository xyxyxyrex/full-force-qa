import sharp, { type OverlayOptions } from 'sharp'
import { MAX_EDGE, planOverviewParts } from './chunks'
import type { PageSection } from './sections'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const JPEG_QUALITY = 85
const GUTTER = 36
const COLUMN_GAP = 12
const HEADER = 16

/** A solid picture with a label, for "there is nothing here" cases. */
export async function placeholderJpeg(width: number, height: number, label: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" font-family="sans-serif" font-size="14" fill="#9a9a9a" text-anchor="middle">${escapeXml(label)}</text></svg>`
  return sharp({ create: { width, height, channels: 3, background: '#2a2a2a' } }).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: JPEG_QUALITY }).toBuffer()
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Crops a region (CSS px) and scales it; regions outside the image are clamped. Null when nothing is left. */
export async function cropJpeg(source: Buffer, rect: Rect, scale: number): Promise<Buffer | null> {
  const meta = await sharp(source).metadata()
  const left = Math.max(0, Math.round(rect.x))
  const top = Math.max(0, Math.round(rect.y))
  const width = Math.min(Math.round(rect.width), (meta.width || 0) - left)
  const height = Math.min(Math.round(rect.height), (meta.height || 0) - top)
  if (width < 1 || height < 1) return null
  let image = sharp(source).extract({ left, top, width, height })
  if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(width * scale)) })
  return image.jpeg({ quality: JPEG_QUALITY }).toBuffer()
}

export interface OverviewPart {
  jpeg: Buffer
  yFrom: number
  yTo: number
  scale: number
}

/**
 * Design (left, with a y ruler) and live (right, with section boxes) at one shared scale,
 * so a reviewer can map sections by eye. Very tall pages are split into several pictures.
 */
export async function renderOverview(input: { width: number; design: Buffer | null; live: Buffer; sections: PageSection[] }): Promise<OverviewPart[]> {
  const { width } = input
  const liveMeta = await sharp(input.live).metadata()
  const designMeta = input.design ? await sharp(input.design).metadata() : null
  const totalHeight = Math.max(liveMeta.height || 0, designMeta?.height || 0)
  const { parts, scale } = planOverviewParts({ width, height: totalHeight, extraX: GUTTER + COLUMN_GAP, extraY: HEADER })
  const sliceHeight = Math.ceil(totalHeight / parts)
  const columnWidth = Math.max(1, Math.round(width * scale))
  const canvasWidth = GUTTER + columnWidth * 2 + COLUMN_GAP
  const output: OverviewPart[] = []

  const column = async (source: Buffer | null, sourceHeight: number, yFrom: number, rows: number): Promise<Buffer | null> => {
    if (!source) return null
    const available = Math.min(rows, sourceHeight - yFrom)
    if (available < 1) return null
    return sharp(source).extract({ left: 0, top: yFrom, width, height: available }).resize({ width: columnWidth }).png().toBuffer()
  }

  for (let part = 0; part < parts; part++) {
    const yFrom = part * sliceHeight
    const yTo = Math.min(totalHeight, yFrom + sliceHeight)
    const rows = yTo - yFrom
    const bodyHeight = Math.max(1, Math.round(rows * scale))
    const canvasHeight = HEADER + bodyHeight
    const liveX = GUTTER + columnWidth + COLUMN_GAP
    const [designPiece, livePiece] = await Promise.all([
      column(input.design, designMeta?.height || 0, yFrom, rows),
      column(input.live, liveMeta.height || 0, yFrom, rows),
    ])

    const marks: string[] = []
    for (let y = Math.ceil(yFrom / 500) * 500; y < yTo; y += 500) {
      const py = HEADER + (y - yFrom) * scale
      marks.push(`<line x1="${GUTTER - 6}" y1="${py}" x2="${canvasWidth}" y2="${py}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="3 4"/><text x="2" y="${py - 2}" font-family="sans-serif" font-size="10" fill="#ffffff">${y}</text>`)
    }
    for (const section of input.sections) {
      const top = Math.max(section.top, yFrom)
      const bottom = Math.min(section.top + section.height, yTo)
      if (bottom <= top) continue
      const py = HEADER + (top - yFrom) * scale
      const ph = Math.max(2, (bottom - top) * scale)
      marks.push(`<rect x="${liveX}" y="${py}" width="${columnWidth}" height="${ph}" fill="none" stroke="#ff3b30" stroke-width="2"/><rect x="${liveX}" y="${py}" width="${Math.min(columnWidth, 18 + section.id.length * 7)}" height="14" fill="#ff3b30"/><text x="${liveX + 3}" y="${py + 11}" font-family="sans-serif" font-size="11" font-weight="bold" fill="#ffffff">${escapeXml(section.id)}</text>`)
    }
    const heading = `<text x="${GUTTER}" y="12" font-family="sans-serif" font-size="11" fill="#cfcfcf">${input.design ? 'DESIGN' : 'NO DESIGN FOR THIS BREAKPOINT'}</text><text x="${liveX}" y="12" font-family="sans-serif" font-size="11" fill="#cfcfcf">LIVE · y ${yFrom}–${yTo}px · 1:${(1 / scale).toFixed(1)}</text>`
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${heading}${marks.join('')}</svg>`

    const layers: OverlayOptions[] = []
    if (designPiece) layers.push({ input: designPiece, left: GUTTER, top: HEADER })
    if (livePiece) layers.push({ input: livePiece, left: liveX, top: HEADER })
    layers.push({ input: Buffer.from(overlay), left: 0, top: 0 })
    const jpeg = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: '#1c1c1c' } })
      .composite(layers)
      .jpeg({ quality: 82 })
      .toBuffer()
    output.push({ jpeg, yFrom, yTo, scale })
  }
  return output
}

/** True when a picture would be shrunk by the model (long edge over the limit). */
export async function exceedsEdgeLimit(image: Buffer): Promise<boolean> {
  const meta = await sharp(image).metadata()
  return Math.max(meta.width || 0, meta.height || 0) > MAX_EDGE
}
