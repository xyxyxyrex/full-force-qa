import { describe, expect, it } from 'vitest'
import { calculateFreeTransformResize, scalePercent, signedPixels } from './freeTransform'

const rect = { left: 100, top: 50, width: 200, height: 100 }

describe('calculateFreeTransformResize', () => {
  it('keeps corner scaling proportional and anchored to the opposite corner', () => {
    const result = calculateFreeTransformResize(rect, -1, -1, -50, -25, false)
    expect(result.scaleX).toBeCloseTo(1.25)
    expect(result.scaleY).toBeCloseTo(1.25)
    expect(result.rect).toEqual({ left: 50, top: 25, width: 250, height: 125 })
  })

  it('allows independent corner stretching with Shift', () => {
    const result = calculateFreeTransformResize(rect, 1, 1, 50, -20, true)
    expect(result.scaleX).toBeCloseTo(1.25)
    expect(result.scaleY).toBeCloseTo(0.8)
    expect(result.rect).toEqual({ left: 100, top: 50, width: 250, height: 80 })
  })

  it('stretches one axis from an edge and never crosses its anchor', () => {
    const edge = calculateFreeTransformResize(rect, -1, 0, 500, 0, false)
    expect(edge.rect.left).toBe(299)
    expect(edge.rect.width).toBe(1)
    expect(edge.scaleY).toBe(1)
  })

  it.each([
    ['nw', -1, -1],
    ['n', 0, -1],
    ['ne', 1, -1],
    ['e', 1, 0],
    ['se', 1, 1],
    ['s', 0, 1],
    ['sw', -1, 1],
    ['w', -1, 0],
  ] as const)('keeps the opposite edge fixed for the %s handle', (_name, horizontal, vertical) => {
    const result = calculateFreeTransformResize(
      rect,
      horizontal,
      vertical,
      horizontal * 20,
      vertical * 10,
      false,
    )
    if (horizontal < 0) expect(result.rect.left + result.rect.width).toBeCloseTo(rect.left + rect.width)
    if (horizontal > 0) expect(result.rect.left).toBe(rect.left)
    if (!horizontal) expect(result.rect.width).toBe(rect.width)
    if (vertical < 0) expect(result.rect.top + result.rect.height).toBeCloseTo(rect.top + rect.height)
    if (vertical > 0) expect(result.rect.top).toBe(rect.top)
    if (!vertical) expect(result.rect.height).toBe(rect.height)
  })
})

describe('free transform labels', () => {
  it('formats compact Photoshop-style HUD values', () => {
    expect(signedPixels(24.4)).toBe('+24')
    expect(signedPixels(-7.6)).toBe('−8')
    expect(scalePercent(1.247)).toBe('125%')
  })
})
