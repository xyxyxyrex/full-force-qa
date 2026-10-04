// How a section is cut into pictures: each stays within Claude Code's image budget
// (about 1.15 megapixels and 1568px on the long edge) and design and live are cut into
// the same number of matching parts.

export const MAX_EDGE = 1568
export const MAX_PIXELS = 1_150_000
export const CHUNK_OVERLAP = 24

export interface Range {
  top: number
  bottom: number
}

export interface ChunkPlan {
  part: number
  parts: number
  scale: number
  live: Range
  design: Range | null
}

/** Output scale for a frame that is `width` CSS px wide. */
export function scaleForWidth(width: number): number {
  return width <= MAX_EDGE ? 1 : MAX_EDGE / width
}

/** Tallest slice, in CSS px, that fits the pixel budget at that width. */
export function maxChunkHeight(width: number): number {
  const scale = scaleForWidth(width)
  const shown = Math.round(width * scale)
  return Math.max(200, Math.floor(MAX_PIXELS / shown / scale))
}

export function planChunks(input: { width: number; live: Range; design: Range | null }): ChunkPlan[] {
  const { width, live, design } = input
  const scale = scaleForWidth(width)
  const limit = maxChunkHeight(width)
  const liveHeight = Math.max(1, live.bottom - live.top)
  const designHeight = design ? Math.max(1, design.bottom - design.top) : 0
  const parts = Math.max(1, Math.ceil(liveHeight / limit), design ? Math.ceil(designHeight / limit) : 1)
  const slice = (range: Range, height: number, index: number): Range => {
    const step = height / parts
    const top = range.top + Math.round(step * index)
    const bottom = index === parts - 1 ? range.bottom : Math.min(range.bottom, range.top + Math.round(step * (index + 1)) + CHUNK_OVERLAP)
    return { top, bottom }
  }
  return Array.from({ length: parts }, (_, index) => ({
    part: index + 1,
    parts,
    scale,
    live: slice(live, liveHeight, index),
    design: design ? slice(design, designHeight, index) : null,
  }))
}

/**
 * Splits the overview into enough pictures that a page is not shrunk past the point where
 * its structure is readable. `extraX`/`extraY` are the output pixels added around the two
 * columns (ruler gutter, column gap, header), which count toward the size limit.
 */
export function planOverviewParts(input: { width: number; height: number; extraX: number; extraY: number }): { parts: number; scale: number } {
  const MIN_SCALE = 0.15
  const widthScale = (MAX_EDGE - input.extraX) / (input.width * 2)
  for (let parts = 1; parts <= 6; parts++) {
    const sliceHeight = input.height / parts
    const scale = Math.min(1, widthScale, (MAX_EDGE - input.extraY) / sliceHeight)
    if (scale >= MIN_SCALE || parts === 6) return { parts, scale }
  }
  return { parts: 6, scale: MIN_SCALE }
}
