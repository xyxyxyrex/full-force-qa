import { describe, expect, it } from 'vitest'
import { comparisonWipeFromDrag } from './comparisonWipe'

describe('comparison wipe drag', () => {
  it('moves horizontally to reveal and vertically to adjust opacity', () => {
    expect(comparisonWipeFromDrag({ x: 200, y: 200, reveal: 50, opacity: 50 }, { x: 300, y: 160 }, 400))
      .toEqual({ reveal: 75, opacity: 70 })
  })
  it('clamps both values', () => {
    expect(comparisonWipeFromDrag({ x: 0, y: 0, reveal: 50, opacity: 50 }, { x: -500, y: 500 }, 400))
      .toEqual({ reveal: 0, opacity: 0 })
  })
})
