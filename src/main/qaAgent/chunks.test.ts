import { describe, expect, it } from 'vitest'
import { CHUNK_OVERLAP, MAX_PIXELS, maxChunkHeight, planChunks, planOverviewParts, scaleForWidth } from './chunks'

describe('scaleForWidth / maxChunkHeight', () => {
  it('shows frames up to 1568px at 1:1 and shrinks wider ones', () => {
    expect(scaleForWidth(1440)).toBe(1)
    expect(scaleForWidth(1568)).toBe(1)
    expect(scaleForWidth(1920)).toBeCloseTo(0.8167, 3)
  })

  it('keeps every chunk inside the pixel budget', () => {
    for (const width of [390, 834, 1440, 1920, 2560]) {
      const scale = scaleForWidth(width)
      const pixels = Math.round(width * scale) * Math.floor(maxChunkHeight(width) * scale)
      expect(pixels).toBeLessThanOrEqual(MAX_PIXELS)
    }
    expect(maxChunkHeight(1440)).toBe(798)
  })
})

describe('planChunks', () => {
  it('uses a single part for a short section', () => {
    const [only, ...rest] = planChunks({ width: 1440, live: { top: 600, bottom: 1200 }, design: { top: 580, bottom: 1250 } })
    expect(rest).toHaveLength(0)
    expect(only).toMatchObject({ part: 1, parts: 1, scale: 1, live: { top: 600, bottom: 1200 }, design: { top: 580, bottom: 1250 } })
  })

  it('splits tall sections into matching, overlapping parts that cover the range', () => {
    const plan = planChunks({ width: 1440, live: { top: 1000, bottom: 3200 }, design: { top: 900, bottom: 3000 } })
    expect(plan).toHaveLength(3)
    expect(plan[0].live.top).toBe(1000)
    expect(plan[2].live.bottom).toBe(3200)
    expect(plan[2].design!.bottom).toBe(3000)
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].live.top).toBeLessThan(plan[i - 1].live.bottom)
      expect(plan[i - 1].live.bottom - plan[i].live.top).toBeGreaterThanOrEqual(CHUNK_OVERLAP - 1)
    }
    for (const part of plan) expect(part.live.bottom - part.live.top).toBeLessThanOrEqual(maxChunkHeight(1440) + CHUNK_OVERLAP)
  })

  it('splits by the taller of the two sides and works without a design range', () => {
    const designTaller = planChunks({ width: 1440, live: { top: 0, bottom: 500 }, design: { top: 0, bottom: 1700 } })
    expect(designTaller).toHaveLength(3)
    const liveOnly = planChunks({ width: 390, live: { top: 0, bottom: 4000 }, design: null })
    expect(liveOnly.length).toBeGreaterThan(1)
    expect(liveOnly.every((part) => part.design === null)).toBe(true)
  })
})

describe('planOverviewParts', () => {
  it('uses one picture for a normal page and more for very tall ones', () => {
    expect(planOverviewParts({ width: 1440, height: 5000, extraX: 48, extraY: 16 }).parts).toBe(1)
    const tall = planOverviewParts({ width: 1440, height: 30000, extraX: 48, extraY: 16 })
    expect(tall.parts).toBeGreaterThan(1)
    expect(tall.scale).toBeGreaterThanOrEqual(0.15)
  })
})
