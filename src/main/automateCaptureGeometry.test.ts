import { describe, expect, it } from 'vitest'
import {
  createCaptureScrollPositions,
  isCaptureStickyPosition,
  resolveCaptureScrollPosition,
} from './automateCaptureGeometry'

describe('createCaptureScrollPositions', () => {
  it('uses Chromium\'s measured scroll range for the final tile', () => {
    const positions = createCaptureScrollPositions(8920, 1000, 7540)

    expect(positions.at(-1)).toBe(7540)
    expect(positions).not.toContain(7920)
    expect(positions).toEqual([...new Set(positions)])
  })

  it('captures a non-scrollable page once', () => {
    expect(createCaptureScrollPositions(900, 1000, 0)).toEqual([0])
  })
})

describe('isCaptureStickyPosition', () => {
  it('detects elements that become fixed or sticky after a capture scroll', () => {
    expect(isCaptureStickyPosition('static')).toBe(false)
    expect(isCaptureStickyPosition('fixed')).toBe(true)
    expect(isCaptureStickyPosition('sticky')).toBe(true)
  })
})

describe('resolveCaptureScrollPosition', () => {
  it('accepts a requested position within Chromium rounding tolerance', () => {
    expect(resolveCaptureScrollPosition(1760, 1758, 7540)).toEqual({
      top: 1758,
      clampedToEnd: false,
    })
  })

  it('accepts a four-pixel landing shift after sticky and lazy-page handlers settle', () => {
    expect(resolveCaptureScrollPosition(1760, 1764, 17665)).toEqual({
      top: 1764,
      clampedToEnd: false,
    })
  })

  it('accepts a final tile clamped to a newly shortened page', () => {
    expect(resolveCaptureScrollPosition(7920, 7540, 7540)).toEqual({
      top: 7540,
      clampedToEnd: true,
    })
  })

  it('rejects a scroll that stopped before the actual page end', () => {
    expect(resolveCaptureScrollPosition(7920, 6200, 7540)).toBeNull()
  })
})
