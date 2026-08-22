import { describe, expect, it } from 'vitest'
import { accessibleAccentForeground } from './themeSystem'

describe('accessibleAccentForeground', () => {
  it('uses a dark foreground on bright cyan and yellow accents', () => {
    expect(accessibleAccentForeground('#00f2fe')).toBe('#000000')
    expect(accessibleAccentForeground('#eab308')).toBe('#000000')
  })

  it('uses a light foreground on dark accents', () => {
    expect(accessibleAccentForeground('#2563eb')).toBe('#ffffff')
    expect(accessibleAccentForeground('rgb(20, 30, 50)')).toBe('#ffffff')
  })

  it('supports shorthand hex colors', () => {
    expect(accessibleAccentForeground('#0fc')).toBe('#000000')
  })
})
