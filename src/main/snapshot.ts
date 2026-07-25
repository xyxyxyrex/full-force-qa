/**
 * DOM Snapshot Freezing (§5.2)
 *
 * Takes raw captured HTML and produces a "frozen" version:
 * 1. Resolve lazy-loaded images (data-src → src, etc.)
 * 2. Rewrite relative URLs to absolute against source origin
 * 3. Strip all <script> tags and inline event handlers
 * 4. Inject <base> tag for remaining relative references
 * 5. Preserve all <style> and <link rel="stylesheet"> as-is
 */

export function freezeSnapshot(html: string, sourceUrl: string): string {
  const origin = new URL(sourceUrl).origin
  let result = html

  // Step 1 — resolve lazy-loaded assets BEFORE stripping JS
  result = resolveLazyImages(result)

  // Step 2 — rewrite relative URLs to absolute
  result = rewriteRelativeUrls(result, origin)

  // Step 3 — strip scripts and event handlers
  result = stripScripts(result)

  // Step 4 — inject <base> for anything we missed
  result = injectBaseTag(result, origin)

  return result
}

/* ------------------------------------------------------------------ */

function resolveLazyImages(html: string): string {
  let result = html

  // Map data-* lazy attributes to their real counterparts
  const srcMappings: Array<{ dataAttr: string; targetAttr: string }> = [
    { dataAttr: 'data-src', targetAttr: 'src' },
    { dataAttr: 'data-lazy-src', targetAttr: 'src' },
    { dataAttr: 'data-original', targetAttr: 'src' },
    { dataAttr: 'data-srcset', targetAttr: 'srcset' },
    { dataAttr: 'data-lazy-srcset', targetAttr: 'srcset' }
  ]

  for (const { dataAttr, targetAttr } of srcMappings) {
    const regex = new RegExp(
      `(<(?:img|source|iframe)[^>]*?)\\s*${dataAttr}="([^"]*)"`,
      'gi'
    )
    result = result.replace(regex, (_match, before: string, value: string) => {
      const existing = new RegExp(`${targetAttr}="[^"]*"`)
      if (existing.test(before)) {
        return before.replace(existing, `${targetAttr}="${value}"`)
      }
      return `${before} ${targetAttr}="${value}"`
    })
  }

  // Background-image lazy attributes
  for (const attr of ['data-bg', 'data-background-image']) {
    const regex = new RegExp(`(<[^>]*?)\\s*${attr}="([^"]*)"`, 'gi')
    result = result.replace(regex, (_match, before: string, value: string) => {
      if (before.includes('style="')) {
        return before.replace('style="', `style="background-image:url('${value}');`)
      }
      return `${before} style="background-image:url('${value}')"`
    })
  }

  // Remove loading="lazy" so the browser fetches immediately
  result = result.replace(/\s+loading="lazy"/gi, '')

  return result
}

/* ------------------------------------------------------------------ */

function rewriteRelativeUrls(html: string, origin: string): string {
  let result = html

  // Rewrite root-relative paths in src, href, action, poster
  result = result.replace(
    /((?:src|href|action|poster)\s*=\s*")(\/[^/"][^"]*?)(")/gi,
    (_m, pre: string, path: string, post: string) => `${pre}${origin}${path}${post}`
  )

  // Rewrite root-relative paths inside srcset
  result = result.replace(/srcset="([^"]*)"/gi, (_m, value: string) => {
    const rewritten = value.replace(
      /(^|,\s*)(\/[^\s,]+)/g,
      (_s: string, sep: string, path: string) => `${sep}${origin}${path}`
    )
    return `srcset="${rewritten}"`
  })

  // Rewrite url() in inline styles and <style> blocks
  result = result.replace(
    /url\(\s*['"]?(\/[^'")]+)['"]?\s*\)/gi,
    (_m, path: string) => `url('${origin}${path}')`
  )

  return result
}

/* ------------------------------------------------------------------ */

function stripScripts(html: string): string {
  let result = html

  // Remove <script>…</script> blocks
  result = result.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi,
    ''
  )

  // Remove inline event handlers (onclick, onload, onerror, …)
  result = result.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
  result = result.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')

  return result
}

/* ------------------------------------------------------------------ */

function injectBaseTag(html: string, origin: string): string {
  return html.replace(
    /(<head[^>]*>)/i,
    `$1\n<base href="${origin}/">`
  )
}
