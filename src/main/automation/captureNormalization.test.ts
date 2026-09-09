import { describe, expect, it } from 'vitest'
import { assertFigmaNativeSize, assertNativeSize } from './captureNormalization'
import { comparePixels } from './pixelDiff'
import { visualFindings } from '../../shared/automationFindings'

describe('Figma native export validation', () => {
  it.each([5800, 5801, 5802])('accepts native export rounding to %ipx without modifying dimensions', height => {
    const actual = { width: 1920, height }
    const expected = { width: 1920, height: 5801 }
    expect(() => assertFigmaNativeSize(actual, expected)).not.toThrow()
    expect(actual).toEqual({ width: 1920, height })
    expect(expected).toEqual({ width: 1920, height: 5801 })
  })

  it('accepts whole-pixel rasterization of fractional frame dimensions', () => {
    expect(() => assertFigmaNativeSize(
      { width: 1921, height: 5802 }, { width: 1920.25, height: 5801.25 }
    )).not.toThrow()
  })

  it.each([
    { width: 1920, height: 5803 }, { width: 1920, height: 5799 },
    { width: 1922, height: 5801 }, { width: 960, height: 2901 },
    { width: 3840, height: 11602 }
  ])('rejects larger discrepancies and scaled exports: %j', actual => {
    expect(() => assertFigmaNativeSize(actual, { width: 1920, height: 5801 })).toThrow(/No resize/)
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid metadata: %s', value => {
    expect(() => assertFigmaNativeSize({ width: 1920, height: 5801 }, { width: value, height: 5801 })).toThrow(/invalid dimensions/)
    expect(() => assertFigmaNativeSize({ width: value, height: 5801 }, { width: 1920, height: 5801 })).toThrow(/invalid dimensions/)
  })

  it('rejects missing decoded dimensions', () => {
    expect(() => assertFigmaNativeSize({}, { width: 1920, height: 5801 })).toThrow(/invalid dimensions/)
  })

  it('keeps Chromium tile validation exact, including a single extra pixel', () => {
    expect(() => assertNativeSize({ width: 1920, height: 1201 }, { width: 1920, height: 1200 }, 'Capture tile')).toThrow(/No resize/)
  })

  it('retains a one-pixel export height difference in the actual comparison', () => {
    const design = { width: 20, height: 102, data: new Uint8Array(20 * 102 * 4).fill(255) }
    const live = { width: 20, height: 101, data: new Uint8Array(20 * 101 * 4).fill(255) }
    assertFigmaNativeSize(design, { width: 20, height: 101 })
    const result = comparePixels(design, live)
    expect(result.design.height).toBe(102)
    expect(result.dimensions.heightDelta).toBe(-1)
    expect(result.excludedPixels.design).toBe(20)
    expect(visualFindings({ ...result, diffDataUrl: '' })).toContainEqual(expect.objectContaining({
      title: 'Page height', state: 'fail', expected: 102, actual: 101
    }))
  })
})
