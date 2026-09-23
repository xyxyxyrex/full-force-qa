/** Keep captured-page requests within Chromium's default referrer policy. */
export function safeResourceReferer(targetUrl: string, pageUrl?: string): string | undefined {
  if (!pageUrl) return undefined
  try {
    const target = new URL(targetUrl)
    const page = new URL(pageUrl)
    if (!['http:', 'https:'].includes(target.protocol) || !['http:', 'https:'].includes(page.protocol)) return undefined
    if (page.protocol === 'https:' && target.protocol === 'http:') return undefined
    page.username = ''
    page.password = ''
    page.hash = ''
    // A full cross-origin page URL may contain private paths or query parameters.
    return page.origin === target.origin ? page.href : page.origin + '/'
  } catch { return undefined }
}

/** An HTTPS capture may contain old same-host HTTP asset URLs. Try TLS first. */
export function capturedResourceCandidates(targetUrl: string, pageUrl: string): string[] {
  try {
    const target = new URL(targetUrl)
    const page = new URL(pageUrl)
    if (page.protocol === 'https:' && target.protocol === 'http:' &&
        target.hostname === page.hostname && !target.port && !target.username && !target.password) {
      const secure = new URL(target.href)
      secure.protocol = 'https:'
      return [secure.href, target.href]
    }
  } catch {}
  return [targetUrl]
}
