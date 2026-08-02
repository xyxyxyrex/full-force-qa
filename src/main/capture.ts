import { BrowserWindow, net } from 'electron'

export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return ''
  let url = rawUrl.trim()
  url = url.replace(/&amp;/gi, '&')
  url = url.replace(/&amp;/gi, '&')
  url = url.replace(/&lt;/gi, '<')
  url = url.replace(/&gt;/gi, '>')
  url = url.replace(/&quot;/gi, '"')
  url = url.replace(/&#39;/gi, "'")
  return url
}

/**
 * Fetch a resource via Electron's net module with proper browser-like headers.
 * Retries with different header combinations for WAF-protected staging sites.
 */
async function netFetchWithHeaders(
  href: string,
  refererUrl: string,
  accept: string = 'text/css,*/*;q=0.1',
  dest: string = 'style'
): Promise<string | null> {
  const headerSets = [
    // Primary: full browser-like headers
    {
      'Accept': accept,
      'Referer': refererUrl,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Sec-Fetch-Dest': dest,
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    // Fallback: minimal headers (some WAFs are stricter about header combinations)
    {
      'Accept': accept,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  ]

  for (const headers of headerSets) {
    try {
      const response = await net.fetch(href, { credentials: 'include', headers })
      if (response.ok) {
        const text = await response.text()
        if (text && text.trim().length > 5) return text
      }
    } catch {}
  }
  return null
}

/**
 * Resolve a potentially relative URL against a base URL.
 */
function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).href
  } catch {
    return relative
  }
}

/**
 * Resolve all relative url() references in CSS text to absolute URLs.
 * Handles: url(relative.png), url("relative.png"), url('../path/file.woff2')
 */
function resolveRelativeCssUrls(cssText: string, cssSourceUrl: string): string {
  if (!cssText || !cssSourceUrl) return cssText
  return cssText.replace(
    /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi,
    (_match, quote, rawUrl) => {
      const trimmed = rawUrl.trim()
      // Skip data URIs, absolute URLs, and fragment-only references
      if (trimmed.startsWith('data:') || trimmed.startsWith('http://') ||
          trimmed.startsWith('https://') || trimmed.startsWith('//') ||
          trimmed.startsWith('#')) {
        return _match
      }
      const resolved = resolveUrl(trimmed, cssSourceUrl)
      return `url(${quote}${resolved}${quote})`
    }
  )
}

/**
 * Recursively resolve @import rules in CSS text by fetching the imported stylesheets.
 * Prevents infinite loops via a visited set.
 */
async function resolveImports(
  cssText: string,
  cssSourceUrl: string,
  pageUrl: string,
  visited: Set<string> = new Set()
): Promise<string> {
  if (!cssText) return ''

  // Match @import url("...") or @import "..."
  const importRegex = /@import\s+(?:url\(\s*(['"]?)([^'")]+?)\1\s*\)|(['"])([^'"]+?)\3)\s*([^;]*);\s*/gi
  let result = cssText
  let match: RegExpExecArray | null

  // Collect all imports first to avoid regex state issues
  const imports: { full: string; href: string; media: string }[] = []
  while ((match = importRegex.exec(cssText)) !== null) {
    const rawHref = match[2] || match[4]
    const media = (match[5] || '').trim()
    if (rawHref) {
      imports.push({ full: match[0], href: rawHref, media })
    }
  }

  for (const imp of imports) {
    const absoluteHref = resolveUrl(imp.href, cssSourceUrl)
    if (visited.has(absoluteHref)) {
      result = result.replace(imp.full, `/* @import already resolved: ${absoluteHref} */`)
      continue
    }
    visited.add(absoluteHref)

    console.log(`[capture] Resolving @import: ${absoluteHref}`)
    const importedCss = await netFetchWithHeaders(absoluteHref, pageUrl)
    if (importedCss) {
      // Resolve url() references relative to the imported stylesheet's URL
      let processed = resolveRelativeCssUrls(importedCss, absoluteHref)
      // Recursively resolve nested @imports
      processed = await resolveImports(processed, absoluteHref, pageUrl, visited)

      // Wrap in media query if the @import had a media condition
      const replacement = imp.media
        ? `/* resolved @import: ${absoluteHref} */\n@media ${imp.media} {\n${processed}\n}`
        : `/* resolved @import: ${absoluteHref} */\n${processed}`
      result = result.replace(imp.full, replacement)
      console.log(`[capture] @import resolved: ${absoluteHref} (${processed.length} chars)`)
    } else {
      console.warn(`[capture] @import failed to fetch: ${absoluteHref}`)
      // Leave the @import as-is so it can try to load at render time
    }
  }

  return result
}

/**
 * Opens the URL in a hidden BrowserWindow (shares default session for auth cookies),
 * waits for dynamic rendering, scrolls to load lazy assets, injects <base href="URL">,
 * and extracts the full native outerHTML with all CSS inlined.
 *
 * For QA fidelity: no custom CSS is injected. The captured HTML should render
 * identically to the original page. This handles WordPress, Elementor, WooCommerce,
 * wpcomstaging.com staging sites, Autoptimize cached CSS (.php endpoints),
 * and other common WordPress stacks.
 */
export async function captureUrl(rawUrl: string): Promise<string> {
  const url = sanitizeUrl(rawUrl)
  const captureWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      webSecurity: false
    }
  })

  try {
    let httpStatusCode = 200
    captureWindow.webContents.on('did-navigate', (_e, _navUrl, httpResponseCode) => {
      if (httpResponseCode) httpStatusCode = httpResponseCode
    })

    await captureWindow.loadURL(url)
    console.log('[capture] Pure Chromium page loaded:', url)

    // Wait for page load + extra 3s for dynamic JS rendering
    await captureWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        if (document.readyState === 'complete') {
          setTimeout(resolve, 3000);
        } else {
          window.addEventListener('load', () => setTimeout(resolve, 3000));
          setTimeout(resolve, 6000);
        }
      })
    `)
    console.log('[capture] 3s post-load wait complete')

    // Detect 404 Page Not Found or WP Login Redirect (session expired)
    const pageCheck: { is404OrLogin: boolean; title: string; reason: string } = await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const title = document.title || '';
          const lowerTitle = title.toLowerCase();
          const is404Body = document.body ? (
            document.body.classList.contains('error404') ||
            document.body.classList.contains('page-not-found') ||
            !!document.querySelector('.error-404, #error-404')
          ) : false;
          const titleHas404 = lowerTitle.includes('404 page not found') || lowerTitle.includes('page not found') || lowerTitle.includes('page cannot be found') || lowerTitle.startsWith('404 -') || lowerTitle === '404';
          const isLoginPage = window.location.pathname.endsWith('wp-login.php') || (document.body && document.body.classList.contains('login'));
          if (isLoginPage) return { is404OrLogin: true, title, reason: 'WordPress Login Redirect' };
          if (is404Body || titleHas404) return { is404OrLogin: true, title, reason: '404 Page Not Found' };
          return { is404OrLogin: false, title, reason: '' };
        } catch(e) {
          return { is404OrLogin: false, title: '', reason: '' };
        }
      })()
    `)

    if (httpStatusCode === 404 || pageCheck.is404OrLogin) {
      console.warn(`[capture] ⚠ Session Expired / 404 Warning: ${pageCheck.reason} ("${pageCheck.title}") - URL: ${captureWindow.webContents.getURL()}`)
    }

    // Scroll through page to trigger lazy loading of images & below-the-fold content
    await captureWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        try {
          const scrollHeight = document.body ? document.body.scrollHeight : 5000;
          const viewportH = window.innerHeight || 1080;
          const steps = Math.ceil(scrollHeight / viewportH);
          let i = 0;
          function step() {
            if (i <= steps) {
              window.scrollTo(0, i * viewportH);
              i++;
              requestAnimationFrame(step);
            } else {
              window.scrollTo(0, 0);
              setTimeout(resolve, 1000);
            }
          }
          step();
        } catch(e) { resolve(); }
      })
    `)

    // Convert all relative <link>, <script>, <img>, <a> URLs into absolute HTTPS URLs
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          document.querySelectorAll('link[href]').forEach(el => {
            try { if (el.href) el.setAttribute('href', el.href); } catch(e) {}
          });
          document.querySelectorAll('script[src]').forEach(el => {
            try { if (el.src) el.setAttribute('src', el.src); } catch(e) {}
          });
          document.querySelectorAll('img[src]').forEach(el => {
            try { if (el.src) el.setAttribute('src', el.src); } catch(e) {}
          });
          document.querySelectorAll('img[data-src]').forEach(el => {
            try {
              const ds = el.getAttribute('data-src');
              if (ds) { const u = new URL(ds, location.href); el.setAttribute('data-src', u.href); }
            } catch(e) {}
          });
          document.querySelectorAll('source[srcset], img[srcset]').forEach(el => {
            try {
              const srcset = el.getAttribute('srcset');
              if (srcset) {
                const resolved = srcset.split(',').map(s => {
                  const parts = s.trim().split(/\\s+/);
                  if (parts[0]) parts[0] = new URL(parts[0], location.href).href;
                  return parts.join(' ');
                }).join(', ');
                el.setAttribute('srcset', resolved);
              }
            } catch(e) {}
          });
          document.querySelectorAll('a[href]').forEach(el => {
            try { if (el.href) el.setAttribute('href', el.href); } catch(e) {}
          });
        } catch(e) {}
      })()
    `)

    // ── STEP 1: Try extracting already-parsed CSS from browser's CSSOM ──
    // This grabs CSS that the browser successfully loaded during the initial page render,
    // bypassing WAF issues that block fetch() re-downloads
    const cssomResult: { inlined: number; remaining: string[]; inlinedSources: string[] } = await captureWindow.webContents.executeJavaScript(`
      (() => {
        let inlined = 0;
        const remaining = [];
        const inlinedSources = [];
        try {
          const links = Array.from(document.querySelectorAll('link[rel*="stylesheet"]'));
          for (const link of links) {
            try {
              const href = link.href;
              if (!href || href.startsWith('data:')) continue;
              // Try to find matching CSSStyleSheet in document.styleSheets
              let matched = false;
              for (const sheet of document.styleSheets) {
                try {
                  if (sheet.href === href || (sheet.ownerNode && sheet.ownerNode === link)) {
                    const rules = [];
                    for (const rule of sheet.cssRules) {
                      rules.push(rule.cssText);
                    }
                    if (rules.length > 0) {
                      const style = document.createElement('style');
                      style.setAttribute('data-captured-stylesheet', href);
                      if (link.media) style.setAttribute('media', link.media);
                      style.textContent = rules.join('\\n');
                      if (link.parentNode) {
                        link.parentNode.replaceChild(style, link);
                      }
                      inlined++;
                      inlinedSources.push(href);
                      matched = true;
                      break;
                    }
                  }
                } catch (e) {
                  // CORS blocks access to cross-origin cssRules — expected
                }
              }
              if (!matched) remaining.push(href);
            } catch (e) {}
          }
        } catch(e) {}
        return { inlined, remaining, inlinedSources };
      })()
    `)
    console.log(`[capture] CSSOM extraction: inlined ${cssomResult.inlined} stylesheets, ${cssomResult.remaining.length} remaining`)

    // ── STEP 2: Fetch remaining stylesheets via Electron's net module (Node-side) ──
    // Uses the session's cookies and proper headers — bypasses WAF restrictions that block in-page fetch()
    const netFetchedSources: string[] = []
    if (cssomResult.remaining.length > 0) {
      for (const href of cssomResult.remaining) {
        try {
          const cssText = await netFetchWithHeaders(href, url)
          if (cssText) {
            // Resolve relative url() references to absolute before inlining
            let processed = resolveRelativeCssUrls(cssText, href)
            // Resolve @import rules recursively
            processed = await resolveImports(processed, href, url)

            // Inject inlined CSS back into the page
            await captureWindow.webContents.executeJavaScript(`
              (() => {
                try {
                  const href = ${JSON.stringify(href)};
                  const cssText = ${JSON.stringify(processed)};
                  const link = Array.from(document.querySelectorAll('link[rel*="stylesheet"]')).find(l => l.href === href);
                  if (link) {
                    const style = document.createElement('style');
                    style.setAttribute('data-captured-stylesheet', href);
                    if (link.media) style.setAttribute('media', link.media);
                    style.textContent = cssText;
                    if (link.parentNode) {
                      link.parentNode.replaceChild(style, link);
                    }
                  } else {
                    const style = document.createElement('style');
                    style.setAttribute('data-captured-stylesheet', href);
                    style.textContent = cssText;
                    if (document.head) document.head.appendChild(style);
                  }
                } catch(e) {}
              })()
            `)
            netFetchedSources.push(href)
            console.log(`[capture] net.fetch inlined: ${href} (${processed.length} chars)`)
          } else {
            console.warn(`[capture] net.fetch failed for: ${href}`)
          }
        } catch (e) {
          console.warn(`[capture] net.fetch error for ${href}:`, e)
        }
      }
    }

    // ── STEP 3: Final fallback — try in-page fetch() for any remaining <link> stylesheets ──
    await captureWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const links = Array.from(document.querySelectorAll('link[rel*="stylesheet"]'));
          for (const link of links) {
            try {
              const href = link.href;
              if (!href || href.startsWith('data:')) continue;
              const res = await fetch(href, { credentials: 'include' });
              if (res.ok) {
                const cssText = await res.text();
                if (cssText && cssText.trim()) {
                  const style = document.createElement('style');
                  style.setAttribute('data-captured-stylesheet', href);
                  if (link.media) style.setAttribute('media', link.media);
                  style.textContent = cssText;
                  if (link.parentNode) {
                    link.parentNode.replaceChild(style, link);
                  } else if (document.head) {
                    document.head.appendChild(style);
                  }
                }
              }
            } catch (e) {
              console.warn('[capture] Could not fetch stylesheet to inline:', e);
            }
          }
        } catch(e) {}
      })()
    `)

    // ── STEP 4: Resolve @import rules inside already-inlined <style> tags ──
    // Some themes use @import inside <style> tags (e.g., @import url("header.css"))
    const importInfo: { index: number; source: string; cssText: string }[] = await captureWindow.webContents.executeJavaScript(`
      (() => {
        const results = [];
        try {
          const styles = document.querySelectorAll('style[data-captured-stylesheet]');
          styles.forEach((style, i) => {
            if (style.textContent && style.textContent.includes('@import')) {
              results.push({
                index: i,
                source: style.getAttribute('data-captured-stylesheet') || '',
                cssText: style.textContent
              });
            }
          });
          // Also check inline <style> tags without the captured attribute
          document.querySelectorAll('style:not([data-captured-stylesheet])').forEach((style, i) => {
            if (style.textContent && style.textContent.includes('@import')) {
              results.push({
                index: 1000 + i,
                source: '',
                cssText: style.textContent
              });
            }
          });
        } catch(e) {}
        return results;
      })()
    `)

    if (importInfo.length > 0) {
      console.log(`[capture] Found ${importInfo.length} <style> tags with @import rules to resolve`)
      for (const info of importInfo) {
        const baseUrl = info.source || url
        const resolved = await resolveImports(info.cssText, baseUrl, url)
        if (resolved !== info.cssText) {
          // Also resolve any remaining relative url() references
          const fullyResolved = resolveRelativeCssUrls(resolved, baseUrl)
          const idx = info.index
          await captureWindow.webContents.executeJavaScript(`
            (() => {
              try {
                const selector = ${idx < 1000
                  ? `'style[data-captured-stylesheet]'`
                  : `'style:not([data-captured-stylesheet])'`};
                const targetIdx = ${idx < 1000 ? idx : idx - 1000};
                const styles = document.querySelectorAll(selector);
                if (styles[targetIdx]) {
                  styles[targetIdx].textContent = ${JSON.stringify(fullyResolved)};
                }
              } catch(e) {}
            })()
          `)
          console.log(`[capture] Resolved @imports in <style> tag #${idx}`)
        }
      }
    }

    // ── STEP 5: Resolve relative url() in all remaining inline <style> tags ──
    // WordPress themes often have relative url() in their inline CSS (background images, fonts, etc.)
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const baseUrl = ${JSON.stringify(url)};
          document.querySelectorAll('style').forEach(style => {
            if (!style.textContent) return;
            const css = style.textContent;
            // Check if there are any relative url() references to resolve
            if (/url\\(\\s*['"]?(?!\\/\\/|https?:\\/\\/|data:)/.test(css)) {
              const sourceUrl = style.getAttribute('data-captured-stylesheet') || baseUrl;
              const resolved = css.replace(
                /url\\(\\s*(['"]?)([^'"\\)]+?)\\1\\s*\\)/gi,
                (match, quote, rawUrl) => {
                  const trimmed = rawUrl.trim();
                  if (trimmed.startsWith('data:') || trimmed.startsWith('http://') ||
                      trimmed.startsWith('https://') || trimmed.startsWith('//') ||
                      trimmed.startsWith('#')) {
                    return match;
                  }
                  try {
                    const abs = new URL(trimmed, sourceUrl).href;
                    return 'url(' + quote + abs + quote + ')';
                  } catch(e) { return match; }
                }
              );
              style.textContent = resolved;
            }
          });
        } catch(e) {}
      })()
    `)

    // ── STEP 6: Inline images as data URIs for staging sites that block direct access ──
    // For <img> elements whose src points to the same host as the captured URL
    const pageHost = new URL(url).host
    const imgUrls: string[] = await captureWindow.webContents.executeJavaScript(`
      (() => {
        const urls = [];
        try {
          document.querySelectorAll('img[src]').forEach(img => {
            try {
              const src = img.src;
              if (src && !src.startsWith('data:') && src.includes(${JSON.stringify(pageHost)})) {
                urls.push(src);
              }
            } catch(e) {}
          });
        } catch(e) {}
        return [...new Set(urls)];
      })()
    `)

    if (imgUrls.length > 0) {
      console.log(`[capture] Attempting to inline ${imgUrls.length} same-host images as data URIs`)
      const imageCache = new Map<string, string>()
      for (const imgSrc of imgUrls) {
        try {
          const response = await net.fetch(imgSrc, {
            credentials: 'include',
            headers: {
              'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
              'Referer': url,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Sec-Fetch-Dest': 'image',
              'Sec-Fetch-Mode': 'no-cors',
              'Sec-Fetch-Site': 'same-origin'
            }
          })
          if (response.ok) {
            const contentType = response.headers.get('content-type') || 'image/png'
            const buffer = Buffer.from(await response.arrayBuffer())
            // Only inline if image is under 2MB to avoid bloating HTML
            if (buffer.length > 0 && buffer.length < 2 * 1024 * 1024) {
              const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
              imageCache.set(imgSrc, dataUri)
            }
          }
        } catch (e) {
          // Skip images that can't be fetched — they'll show as broken but that's better than crashing
        }
      }

      if (imageCache.size > 0) {
        console.log(`[capture] Successfully fetched ${imageCache.size}/${imgUrls.length} images for inlining`)
        // Build a mapping object and inject it in one pass
        const mapping = Object.fromEntries(imageCache)
        await captureWindow.webContents.executeJavaScript(`
          (() => {
            try {
              const map = ${JSON.stringify(mapping)};
              document.querySelectorAll('img[src]').forEach(img => {
                if (map[img.src]) {
                  img.setAttribute('src', map[img.src]);
                }
              });
              // Also handle srcset
              document.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
                const srcset = el.getAttribute('srcset');
                if (!srcset) return;
                let updated = srcset;
                for (const [orig, dataUri] of Object.entries(map)) {
                  if (updated.includes(orig)) {
                    updated = updated.split(orig).join(dataUri);
                  }
                }
                if (updated !== srcset) el.setAttribute('srcset', updated);
              });
            } catch(e) {}
          })()
        `)
      }
    }

    // ── STEP 7: Inline ALL remaining <link rel="stylesheet"> via in-page fetch ──
    // Catches CDN stylesheets (cookieconsent, Bootstrap, Font Awesome, Google Fonts, etc.)
    // that weren't inlined by CSSOM extraction or net.fetch (e.g., cross-origin sheets
    // whose cssRules were CORS-blocked and whose CDN URL wasn't fetchable via net.fetch)
    await captureWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const links = Array.from(document.querySelectorAll('link[rel*="stylesheet"]'));
          for (const link of links) {
            try {
              const href = link.href;
              if (!href || href.startsWith('data:')) continue;
              const res = await fetch(href);
              if (res.ok) {
                const ct = res.headers.get('content-type') || '';
                // Guard against HTML error pages masquerading as CSS
                if (ct.includes('text/html') && !ct.includes('text/css')) continue;
                const cssText = await res.text();
                if (cssText && cssText.trim().length > 10) {
                  const style = document.createElement('style');
                  style.setAttribute('data-captured-stylesheet', href);
                  if (link.media) style.setAttribute('media', link.media);
                  style.textContent = cssText;
                  if (link.parentNode) {
                    link.parentNode.replaceChild(style, link);
                  }
                }
              }
            } catch(e) {}
          }
        } catch(e) {}
      })()
    `)

    // Inject <base href="URL"> into <head> as fallback for any remaining relative URLs
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          let base = document.querySelector('base');
          if (!base) {
            base = document.createElement('base');
            if (document.head) {
              document.head.insertBefore(base, document.head.firstChild);
            }
          }
          base.setAttribute('href', ${JSON.stringify(url)});
        } catch(e) {}
      })()
    `)

    // ── STEP 8: Strip executable <script> tags ──
    // The captured HTML is rendered in a srcDoc iframe for static QA preview.
    // Scripts re-executing in the iframe cause problems:
    //   - Cookie consent JS re-initializes and conflicts with captured banner styles
    //   - Staging WAF blocks JS files (403 errors in console)
    //   - reCAPTCHA timeouts
    //   - Analytics double-counting
    // Data scripts (ld+json, application/json) are preserved for SEO audit.
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const script of scripts) {
            const type = (script.getAttribute('type') || '').toLowerCase();
            // Preserve structured data and non-executable script types
            if (type === 'application/ld+json' || type === 'application/json') continue;
            script.remove();
          }
        } catch(e) {}
      })()
    `)

    // Extract exact document HTML as rendered by Chromium
    const html: string = await captureWindow.webContents.executeJavaScript(`
      document.documentElement ? document.documentElement.outerHTML : ''
    `)

    const linkCount = (html.match(/<link[^>]*rel=["']stylesheet["']/gi) || []).length
    const styleCount = (html.match(/<style/gi) || []).length
    const importCount = (html.match(/@import\s/gi) || []).length
    console.log(`[DEBUG CAPTURE] Pure HTML extracted length: ${html.length} | <link stylesheet>: ${linkCount} | <style>: ${styleCount} | @import remaining: ${importCount}`)
    return html || '<html><body></body></html>'
  } finally {
    captureWindow.destroy()
  }
}
