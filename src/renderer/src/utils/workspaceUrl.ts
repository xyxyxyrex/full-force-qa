export function normalizeWorkspaceUrl(value: string): string | null {
  const input = value.trim()
  if (!input) return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) return null
  if (/^(javascript|data|file|about|mailto|blob):/i.test(input)) return null
  try {
    const local = /^(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(input)
    const url = new URL(/^https?:\/\//i.test(input) ? input : `${local ? 'http' : 'https'}://${input}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

export function sameWorkspacePage(left: string, right: string): boolean {
  const normalized = [left, right].map(value => {
    const url = normalizeWorkspaceUrl(value)
    if (!url) return null
    const parsed = new URL(url)
    parsed.hash = ''
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.href
  })
  return !!normalized[0] && normalized[0] === normalized[1]
}
