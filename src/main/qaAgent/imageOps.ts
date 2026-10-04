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

export interface EvidenceInput {
  design: Buffer | null
  live: Buffer
  /** Boxes in CSS px on each page; either may be missing. */
  designRect?: Rect
  liveRect?: Rect
  header: { design: string; live: string }
  caption: string
}

const EVIDENCE_PADDING = 48
const EVIDENCE_MAX_HEIGHT = 900
const EVIDENCE_MAX_WIDTH = 2400
const EVIDENCE_GAP = 16

interface Cut {
  image: Buffer
  width: number
  height: number
  box: Rect | null
}

async function cutAround(source: Buffer, rect: Rect | undefined): Promise<Cut | null> {
  const meta = await sharp(source).metadata()
  const sourceWidth = meta.width || 0
  const sourceHeight = meta.height || 0
  if (!rect) return null
  const left = Math.max(0, Math.round(rect.x) - EVIDENCE_PADDING)
  const top = Math.max(0, Math.round(rect.y) - EVIDENCE_PADDING)
  const right = Math.min(sourceWidth, Math.round(rect.x + rect.width) + EVIDENCE_PADDING)
  const bottom = Math.min(sourceHeight, Math.round(rect.y + rect.height) + EVIDENCE_PADDING)
  if (right - left < 1 || bottom - top < 1) return null
  const image = await sharp(source).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer()
  return { image, width: right - left, height: bottom - top, box: { x: Math.round(rect.x) - left, y: Math.round(rect.y) - top, width: Math.round(rect.width), height: Math.round(rect.height) } }
}

/** Design and live crops side by side with the issue boxed in red, as WebP. */
export async function renderEvidence(input: EvidenceInput): Promise<Buffer> {
  const [design, live] = await Promise.all([
    input.design && input.designRect ? cutAround(input.design, input.designRect) : Promise.resolve(null),
    cutAround(input.live, input.liveRect ?? { x: 0, y: 0, width: Math.min(1200, (await sharp(input.live).metadata()).width || 1200), height: 700 }),
  ])
  const cuts = [design, live].filter((cut): cut is Cut => !!cut)
  if (!cuts.length) throw new Error('The evidence area is outside the page.')
  const tallest = Math.max(...cuts.map((cut) => cut.height))
  const totalWidth = cuts.reduce((sum, cut) => sum + cut.width, 0) + EVIDENCE_GAP * (cuts.length - 1)
  const scale = Math.min(1, EVIDENCE_MAX_HEIGHT / tallest, EVIDENCE_MAX_WIDTH / totalWidth)
  const titleHeight = 22
  const captionHeight = input.caption ? 26 : 0

  const pieces: Array<{ cut: Cut; label: string }> = []
  if (design) pieces.push({ cut: design, label: input.header.design })
  if (live) pieces.push({ cut: live, label: input.header.live })
  const layers: OverlayOptions[] = []
  const marks: string[] = []
  let x = 0
  for (const { cut, label } of pieces) {
    const width = Math.max(1, Math.round(cut.width * scale))
    const height = Math.max(1, Math.round(cut.height * scale))
    layers.push({ input: await sharp(cut.image).resize({ width, height }).png().toBuffer(), left: x, top: titleHeight })
    if (cut.box) {
      marks.push(`<rect x="${x + cut.box.x * scale}" y="${titleHeight + cut.box.y * scale}" width="${Math.max(2, cut.box.width * scale)}" height="${Math.max(2, cut.box.height * scale)}" fill="none" stroke="#ff2d2d" stroke-width="3"/>`)
    }
    marks.push(`<text x="${x + 4}" y="15" font-family="sans-serif" font-size="12" font-weight="bold" fill="#ffffff">${escapeXml(label)}</text>`)
    x += width + EVIDENCE_GAP
  }
  const canvasWidth = Math.max(1, x - EVIDENCE_GAP)
  const bodyHeight = Math.max(...pieces.map(({ cut }) => Math.round(cut.height * scale)))
  const canvasHeight = titleHeight + bodyHeight + captionHeight
  if (input.caption) marks.push(`<text x="4" y="${titleHeight + bodyHeight + 18}" font-family="sans-serif" font-size="13" fill="#ffffff">${escapeXml(input.caption.slice(0, Math.floor(canvasWidth / 7)))}</text>`)
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${marks.join('')}</svg>`), left: 0, top: 0 })
  return sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: '#1c1c1c' } }).composite(layers).webp({ quality: 90, smartSubsample: true }).toBuffer()
}

/** A small JPEG for the approval card. */
export async function thumbnailJpeg(image: Buffer, width = 360): Promise<Buffer> {
  return sharp(image).resize({ width, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()
}
