// Designs belong to a page, not just a project: a QA analyst checks several pages of one project
// and changes the URL inside it. The key combines both, so each page remembers its own PNGs.

/** The page's identity: its path and query, without the host, the #fragment or a trailing slash. */
export function pageIdOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return null
    const path = parsed.pathname.replace(/\/+$/, '') || '/'
    return `${path}${parsed.search}`
  } catch {
    return null
  }
}

export const DESIGN_KEY_SEPARATOR = '#'

/** The storage key for one page of one project. Falls back to the project when the URL cannot be read. */
export function designKeyOf(projectKey: string, pageUrl: string | undefined | null): string {
  const id = pageUrl ? pageIdOf(pageUrl) : null
  return id ? `${projectKey}${DESIGN_KEY_SEPARATOR}${id}` : projectKey
}

/** The project part of a key made by designKeyOf. */
export function projectOfDesignKey(key: string): string {
  const index = key.indexOf(DESIGN_KEY_SEPARATOR)
  return index < 0 ? key : key.slice(0, index)
}
