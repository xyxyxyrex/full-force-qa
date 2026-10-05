import { describe, expect, it } from 'vitest'
import { checkCaptureUrl, isLoginUrl, userAgentFor, viewportHeightFor } from './captureSettings'

describe('viewportHeightFor', () => {
  it('uses known device heights', () => {
    expect(viewportHeightFor(1440)).toBe(1024)
    expect(viewportHeightFor(1920)).toBe(1080)
    expect(viewportHeightFor(390)).toBe(844)
    expect(viewportHeightFor(834)).toBe(1194)
  })

  it('derives a sensible height for unknown widths', () => {
    expect(viewportHeightFor(1500)).toBeGreaterThanOrEqual(900)
    expect(viewportHeightFor(1500)).toBeLessThanOrEqual(1100)
    expect(viewportHeightFor(700)).toBeGreaterThan(700)
    expect(viewportHeightFor(350)).toBeGreaterThanOrEqual(560)
    expect(viewportHeightFor(5000)).toBeLessThanOrEqual(1400)
  })
})

describe('userAgentFor', () => {
  it('keeps Chrome on desktop, a phone UA on mobile and a non-mobile Safari UA on tablet', () => {
    expect(userAgentFor('desktop')).toBeUndefined()
    expect(userAgentFor('mobile')).toMatch(/iPhone.*Mobile\//)
    expect(userAgentFor('tablet')).toMatch(/Macintosh/)
    expect(userAgentFor('tablet')).not.toMatch(/Mobile/)
  })
})

describe('checkCaptureUrl', () => {
  it('allows ordinary pages', () => {
    expect(checkCaptureUrl('https://svenson.innovnational.com/alopecia-page/')).toEqual({ ok: true })
    expect(checkCaptureUrl('http://localhost:3000/a?b=1')).toEqual({ ok: true })
  })

  it('refuses admin, login, action and non-web URLs', () => {
    expect(checkCaptureUrl('https://x.test/wp-admin/options.php').ok).toBe(false)
    expect(checkCaptureUrl('https://x.test/wp-admin').ok).toBe(false)
    expect(checkCaptureUrl('https://x.test/wp-login.php?redirect_to=/').ok).toBe(false)
    expect(checkCaptureUrl('https://x.test/page/?action=delete').ok).toBe(false)
    expect(checkCaptureUrl('file:///etc/passwd').ok).toBe(false)
    expect(checkCaptureUrl('javascript:alert(1)').ok).toBe(false)
    expect(checkCaptureUrl('not a url').ok).toBe(false)
  })

  it('does not mistake similar paths for admin', () => {
    expect(checkCaptureUrl('https://x.test/wp-administrator-guide/').ok).toBe(true)
  })
})

describe('isLoginUrl', () => {
  it('spots the WordPress login redirect', () => {
    expect(isLoginUrl('https://x.test/wp-login.php?redirect_to=%2F')).toBe(true)
    expect(isLoginUrl('https://x.test/login/')).toBe(false)
  })
})
