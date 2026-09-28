import { describe, expect, it } from 'vitest'
import { finishGuideGesture, guidePositionFromViewport } from './guides'

const guides = [
  { axis: 'x' as const, position: 0.25 },
  { axis: 'y' as const, position: 0.5 },
]
const start = { x: 100, y: 100 }

describe('guide gestures', () => {
  it('snaps to the website viewport center, independent of the canvas origin', () => {
    const viewport = { left: 200, top: 300, width: 430, height: 932 }
    expect(guidePositionFromViewport('y', 420, 600, viewport, 0.5)).toMatchObject({ ratio: 0.5, px: 430, screenX: 415, snapped: true })
    expect(guidePositionFromViewport('x', 400, 771, viewport, 0.5)).toMatchObject({ ratio: 0.5, px: 932, screenY: 766, snapped: true })
    expect(guidePositionFromViewport('y', 600, 600, viewport, 0.5).snapped).toBe(false)
  })

  it('deletes only the clicked guide', () => {
    expect(finishGuideGesture(guides, 0, start, { x: 102, y: 101 }, 0.25, false, false)).toEqual([guides[1]])
  })

  it('moves a dragged guide without changing the other guide', () => {
    expect(finishGuideGesture(guides, 1, start, { x: 140, y: 100 }, 0.75, false, false)).toEqual([
      guides[0], { axis: 'y', position: 0.75 },
    ])
  })

  it('deletes a guide dragged outside the preview', () => {
    expect(finishGuideGesture(guides, 1, start, { x: 140, y: 100 }, 1.2, true, false)).toEqual([guides[0]])
  })

  it('keeps guides after a cancelled drag or stale index', () => {
    expect(finishGuideGesture(guides, 0, start, { x: 140, y: 100 }, 0.8, false, true)).toBe(guides)
    expect(finishGuideGesture(guides, 3, start, start, 0, false, false)).toBe(guides)
  })
})
