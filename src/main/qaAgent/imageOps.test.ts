import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { cropJpeg, placeholderJpeg, renderOverview } from './imageOps'
import type { PageSection } from './sections'

// A page of horizontal color bands: red 0-400, green 400-800, blue 800-1200.
async function bands(width: number, height: number): Promise<Buffer> {
  const colors = ['#ff0000', '#00ff00', '#0000ff']
  const bandHeight = Math.ceil(height / 3)
  const layers = await Promise.all(colors.map(async (color, i) => ({
    input: await sharp({ create: { width, height: Math.min(bandHeight, height - i * bandHeight), channels: 3, background: color } }).png().toBuffer(),
    top: i * bandHeight, left: 0,
  })))
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(layers).png().toBuffer()
}
const pixel = async (jpeg: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  const o = (y * info.width + x) * info.channels
  return [data[o], data[o + 1], data[o + 2]]
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 40)

describe('cropJpeg', () => {
  it('crops the requested region of the page', async () => {
    const page = await bands(400, 1200)
    const crop = await cropJpeg(page, { x: 0, y: 450, width: 400, height: 200 }, 1)
    const meta = await sharp(crop!).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 400, 200])
    expect(near(await pixel(crop!, 200, 100), [0, 255, 0])).toBe(true)
  })

  it('scales down and clamps regions that run past the image', async () => {
    const page = await bands(400, 1200)
    const crop = await cropJpeg(page, { x: 0, y: 1100, width: 400, height: 600 }, 0.5)
    const meta = await sharp(crop!).metadata()
    expect([meta.width, meta.height]).toEqual([200, 50])
    expect(near(await pixel(crop!, 100, 25), [0, 0, 255])).toBe(true)
  })

  it('returns null when the region is entirely outside the image', async () => {
    const page = await bands(400, 1200)
    expect(await cropJpeg(page, { x: 0, y: 1300, width: 400, height: 100 }, 1)).toBeNull()
    expect(await cropJpeg(page, { x: 500, y: 0, width: 100, height: 100 }, 1)).toBeNull()
  })
})

describe('placeholderJpeg', () => {
  it('makes a labelled picture of the right size', async () => {
    const meta = await sharp(await placeholderJpeg(300, 80, 'No design here <ok>')).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 300, 80])
  })
})

describe('renderOverview', () => {
  const sections: PageSection[] = [
    { id: 'S1', label: 'Hero', tag: 'section', selector: 'section.hero', top: 0, height: 600 },
    { id: 'S2', label: 'Body', tag: 'section', selector: 'section.body', top: 600, height: 600 },
  ]

  it('puts design and live side by side in one picture that stays within the size limit', async () => {
    const [part, ...rest] = await renderOverview({ width: 1440, design: await bands(1440, 1100), live: await bands(1440, 1200), sections })
    expect(rest).toHaveLength(0)
    expect(part).toMatchObject({ yFrom: 0, yTo: 1200 })
    const meta = await sharp(part.jpeg).metadata()
    expect(meta.format).toBe('jpeg')
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568)
    expect(meta.width).toBeGreaterThan(meta.height! / 4)
  })

  it('works without a design and splits very tall pages into several pictures', async () => {
    const single = await renderOverview({ width: 1440, design: null, live: await bands(1440, 1200), sections })
    expect(single).toHaveLength(1)
    const tall = await renderOverview({ width: 1440, design: null, live: await bands(1440, 24000), sections: [] })
    expect(tall.length).toBeGreaterThan(1)
    expect(tall[0].yTo).toBe(tall[1].yFrom)
    expect(tall.at(-1)!.yTo).toBe(24000)
    for (const item of tall) {
      const meta = await sharp(item.jpeg).metadata()
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568)
    }
  })
})
