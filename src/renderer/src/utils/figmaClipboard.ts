export function extractFigmaUrl(text: string): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) || []
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ''))
      if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname.toLowerCase())) continue
      if (/^\/(design|file|proto|board|make)\/[^/]+/i.test(url.pathname)) return url.href
      if (url.pathname === '/embed') {
        const embedded = url.searchParams.get('url')
        if (embedded) return extractFigmaUrl(embedded)
      }
    } catch { /* Ignore unrelated clipboard text. */ }
  }
  return null
}
