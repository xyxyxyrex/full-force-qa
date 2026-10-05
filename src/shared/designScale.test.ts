import { describe, expect, it } from 'vitest'
import { breakpointForFrameWidth, detectDesignScale, isBreakpoint, breakpointToFollow } from './designScale'

describe('breakpointForFrameWidth', () => {
  it('maps widths to breakpoints', () => {
    expect(breakpointForFrameWidth(390)).toBe('mobile')
    expect(breakpointForFrameWidth(599)).toBe('mobile')
    expect(breakpointForFrameWidth(600)).toBe('tablet')
    expect(breakpointForFrameWidth(1024)).toBe('tablet')
    expect(breakpointForFrameWidth(1180)).toBe('tablet')
    expect(breakpointForFrameWidth(1199)).toBe('tablet')
    expect(breakpointForFrameWidth(1200)).toBe('desktop')
    expect(breakpointForFrameWidth(1920)).toBe('desktop')
  })
})

describe('isBreakpoint', () => {
  it('accepts only the three breakpoints', () => {
    expect(isBreakpoint('desktop')).toBe(true)
    expect(isBreakpoint('phone')).toBe(false)
    expect(isBreakpoint(undefined)).toBe(false)
  })
})

describe('detectDesignScale', () => {
  it('reads native exports as 1x', () => {
    expect(detectDesignScale({ pixelWidth: 1440 })).toMatchObject({ scale: 1, frameWidth: 1440, breakpoint: 'desktop', confidence: 'high' })
    expect(detectDesignScale({ pixelWidth: 390 })).toMatchObject({ scale: 1, frameWidth: 390, breakpoint: 'mobile' })
  })

  it('detects 2x and 3x exports', () => {
    expect(detectDesignScale({ pixelWidth: 2880 })).toMatchObject({ scale: 2, frameWidth: 1440, breakpoint: 'desktop' })
    expect(detectDesignScale({ pixelWidth: 750 })).toMatchObject({ scale: 2, frameWidth: 375, breakpoint: 'mobile' })
    expect(detectDesignScale({ pixelWidth: 1170 })).toMatchObject({ scale: 3, frameWidth: 390, breakpoint: 'mobile' })
  })

  it('tolerates one pixel of export rounding', () => {
    expect(detectDesignScale({ pixelWidth: 1439 })).toMatchObject({ scale: 1, frameWidth: 1439, breakpoint: 'desktop' })
    expect(detectDesignScale({ pixelWidth: 2881 })).toMatchObject({ scale: 2, frameWidth: 1441 })
  })

  it('prefers the slot an image was dropped on when two readings fit', () => {
    expect(detectDesignScale({ pixelWidth: 1536 })).toMatchObject({ scale: 1, frameWidth: 1536, breakpoint: 'desktop', detection: 'dimensions' })
    expect(detectDesignScale({ pixelWidth: 1536, slotHint: 'tablet' })).toMatchObject({ scale: 2, frameWidth: 768, breakpoint: 'tablet', detection: 'slot' })
  })

  it('lets a file name suffix win', () => {
    expect(detectDesignScale({ pixelWidth: 1170, fileName: 'home-mobile@3x.png' })).toMatchObject({ scale: 3, frameWidth: 390, detection: 'filename', confidence: 'high' })
    expect(detectDesignScale({ pixelWidth: 1500, fileName: 'hero@1.5x.png' })).toMatchObject({ scale: 1.5, frameWidth: 1000 })
    expect(detectDesignScale({ pixelWidth: 1440, fileName: 'plan@2xl.png' })).toMatchObject({ scale: 1, detection: 'dimensions' })
  })

  it('guesses with low confidence for unknown widths', () => {
    expect(detectDesignScale({ pixelWidth: 1000 })).toMatchObject({ scale: 1, frameWidth: 1000, breakpoint: 'tablet', detection: 'fallback', confidence: 'low' })
    expect(detectDesignScale({ pixelWidth: 2650 })).toMatchObject({ scale: 2, frameWidth: 1325, breakpoint: 'desktop', confidence: 'low' })
  })

  it('rejects invalid widths', () => {
    expect(() => detectDesignScale({ pixelWidth: 0 })).toThrow()
    expect(() => detectDesignScale({ pixelWidth: Number.NaN })).toThrow()
  })
})

describe('breakpointToFollow', () => {
  it('stays put when nothing was added or one of the designs is for the breakpoint on screen', () => {
    expect(breakpointToFollow([], 'desktop')).toBeNull()
    expect(breakpointToFollow(['desktop'], 'desktop')).toBeNull()
    expect(breakpointToFollow(['mobile', 'desktop'], 'desktop')).toBeNull()
  })
  it('moves to the first design added when none is for the breakpoint on screen', () => {
    expect(breakpointToFollow(['mobile'], 'desktop')).toBe('mobile')
    expect(breakpointToFollow(['tablet', 'mobile'], 'desktop')).toBe('tablet')
  })
})
