// What the agent's own browser may do, kept pure so it can be tested. The browser stays on the
// site under review, never opens WordPress admin, login or logout pages, and sends no data (form
// submissions, POST/PUT/PATCH/DELETE requests) unless the person turned sending on.

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The site a URL belongs to: scheme and host, with a leading "www." ignored. */
export function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return null
    return `${parsed.protocol}//${parsed.host.replace(/^www\./i, '').toLowerCase()}`
  } catch { return null }
}

export const sameSite = (url: string, site: string): boolean => siteOf(url) === site

/** WordPress admin, login and logout pages. The front-end endpoints admin-ajax.php and /wp-json stay usable. */
export function isAdminUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()
    if (/\/wp-admin\/admin-ajax\.php$/.test(path)) return false
    if (/\/wp-admin(\/|$)|\/wp-login\.php/.test(path)) return true
    if (/(^|\/)(log-?out|sign-?out)(\/|$)/.test(path)) return true
    return /(^|&)action=(logout|log-out|delete|trash)\b/i.test(parsed.search.slice(1))
  } catch { return true }
}

/** A page the person may have the agent review: a plain web page, not WordPress admin or login. */
export function isReviewablePageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return false
    if (/\/wp-admin(\/|$)|\/wp-login\.php/i.test(parsed.pathname) || /[?&]action=/i.test(parsed.search)) return false
    return true
  } catch { return false }
}

export const SEND_OFF_REASON = 'sending data is off (Settings → AI Agents)'

export type Verdict = { allowed: true } | { allowed: false; reason: string }

/** May the browser go to this page? */
export function checkNavigation(url: string, site: string): Verdict {
  if (!/^https?:/i.test(url)) return { allowed: false, reason: `only web pages can be opened, not ${url.split(':')[0]}: links` }
  if (!sameSite(url, site)) return { allowed: false, reason: `it leaves the site under review (${site})` }
  if (!isReviewablePageUrl(url) || isAdminUrl(url)) return { allowed: false, reason: 'WordPress admin, login and logout pages are off limits' }
  return { allowed: true }
}

export interface BlockedRequest {
  kind: 'form' | 'request' | 'navigation' | 'admin'
  method: string
  url: string
  reason: string
}

/** May this network request from the browser go ahead? */
export function checkRequest(input: { method: string; url: string; resourceType: string; site: string; allowSend: boolean }): { allow: true } | { allow: false; blocked: BlockedRequest } {
  const method = input.method.toUpperCase()
  const isPage = input.resourceType === 'mainFrame' || input.resourceType === 'subFrame'
  if (input.resourceType === 'mainFrame' && SAFE_METHODS.has(method)) {
    const verdict = checkNavigation(input.url, input.site)
    if (!verdict.allowed) return { allow: false, blocked: { kind: 'navigation', method, url: input.url, reason: verdict.reason } }
  }
  if (sameSite(input.url, input.site) && isAdminUrl(input.url)) return { allow: false, blocked: { kind: 'admin', method, url: input.url, reason: 'WordPress admin, login and logout are off limits' } }
  if (!SAFE_METHODS.has(method)) {
    if (!input.allowSend) return { allow: false, blocked: { kind: isPage ? 'form' : 'request', method, url: input.url, reason: SEND_OFF_REASON } }
    if (!sameSite(input.url, input.site)) return { allow: false, blocked: { kind: isPage ? 'form' : 'request', method, url: input.url, reason: 'data may only be sent to the site under review' } }
  }
  return { allow: true }
}

/** May the agent call this address on the site's API? */
export function checkApiRequest(input: { method: string; url: string; site: string; allowSend: boolean }): Verdict {
  const method = input.method.toUpperCase()
  if (!/^https?:/i.test(input.url) || !sameSite(input.url, input.site)) return { allowed: false, reason: `requests may only go to the site under review (${input.site})` }
  if (isAdminUrl(input.url)) return { allowed: false, reason: 'WordPress admin, login and logout are off limits' }
  if (!SAFE_METHODS.has(method) && !input.allowSend) return { allowed: false, reason: `${method} sends data, and sending is off. The person can turn it on in Settings → AI Agents → "Let the agent submit forms and send API requests".` }
  return { allowed: true }
}

/** Which links on a page the link check may request. Admin, login and logout links are never requested (a logout link would sign the person out). */
export function linkCheckPlan(href: string): 'check' | 'skip-admin' | 'skip-scheme' | 'placeholder' {
  const trimmed = href.trim()
  if (!trimmed || trimmed === '#' || /^javascript:/i.test(trimmed)) return 'placeholder'
  if (/^(mailto|tel|sms):/i.test(trimmed)) return 'skip-scheme'
  if (!/^https?:/i.test(trimmed)) return 'skip-scheme'
  if (isAdminUrl(trimmed) || /\/wp-login\.php/i.test(trimmed)) return 'skip-admin'
  return 'check'
}
