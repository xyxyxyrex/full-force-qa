import type { Breakpoint } from '../../shared/designScale'
import { breakpointForFrameWidth } from '../../shared/designScale'

// Settings for the tolerant live-page capture. Everything here is pure so it can be tested.

export const MAX_CAPTURE_HEIGHT = 20_000
export const SOFT_CAPTURE_DEADLINE_MS = 60_000

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
// iPadOS reports a desktop Safari UA. A "Mobile" token would make WordPress serve phone markup.
const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

/** `undefined` keeps Electron's own Chrome user agent. */
export function userAgentFor(breakpoint: Breakpoint): string | undefined {
  if (breakpoint === 'mobile') return IPHONE_UA
  if (breakpoint === 'tablet') return IPAD_UA
  return undefined
}

const KNOWN_VIEWPORT_HEIGHTS: Record<number, number> = {
  1920: 1080, 1680: 1050, 1600: 900, 1536: 864, 1440: 1024, 1366: 768, 1280: 800,
  1180: 820, 1024: 768, 834: 1194, 820: 1180, 810: 1080, 768: 1024, 744: 1133,
  440: 956, 430: 932, 428: 926, 414: 896, 412: 915, 402: 874, 393: 852, 390: 844, 375: 667, 360: 800, 320: 568,
}

/** Height of the browser window used for one capture screen. */
export function viewportHeightFor(width: number): number {
  const rounded = Math.round(width)
  const known = KNOWN_VIEWPORT_HEIGHTS[rounded]
  if (known) return known
  const breakpoint = breakpointForFrameWidth(rounded)
  const ratio = breakpoint === 'desktop' ? 0.65 : breakpoint === 'tablet' ? 1.33 : 2.16
  return Math.min(1400, Math.max(560, Math.round(rounded * ratio)))
}

export interface CaptureUrlCheck {
  ok: boolean
  reason?: string
}

/** Captures only ever load public pages: never WordPress admin or login screens. */
export function checkCaptureUrl(raw: string): CaptureUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'That is not a valid page address.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'Only http and https pages can be captured.' }
  if (/\/wp-admin(?:\/|$)/i.test(url.pathname) || /wp-login\.php/i.test(url.pathname)) {
    return { ok: false, reason: 'WordPress admin and login pages are not captured.' }
  }
  if (url.searchParams.has('action')) return { ok: false, reason: 'Pages with an action parameter are not captured.' }
  return { ok: true }
}

export function isLoginUrl(raw: string): boolean {
  try {
    return /wp-login\.php/i.test(new URL(raw).pathname)
  } catch {
    return false
  }
}
