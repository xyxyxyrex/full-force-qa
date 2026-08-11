import grapesjs, { Editor } from 'grapesjs'
import 'grapesjs/dist/css/grapes.min.css'
import './theme.css'

interface SnapshotParts {
  bodyHtml: string
  cssLinks: string[]
  inlineCss: string
  htmlClass: string
  bodyClass: string
  bodyStyle: string
  htmlStyle: string
  widgetScripts: string[]
}

export interface InitEditorOptions {
  onMissingFonts?: (fonts: string[]) => void
}

const SYSTEM_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  'inherit', 'initial', 'unset', 'revert',
  'arial', 'helvetica', 'helvetica neue', 'times new roman', 'times',
  'georgia', 'verdana', 'courier new', 'courier', 'tahoma',
  'trebuchet ms', 'impact', 'comic sans ms', 'lucida console',
  'lucida sans', 'lucida sans unicode', 'palatino', 'palatino linotype',
  'garamond', 'bookman', 'book antiqua', 'segoe ui', 'calibri', 'cambria',
  'microsoft sans serif', 'consolas', 'monaco', 'menlo',
  '-apple-system', 'apple-system', 'blinkmacsystemfont', 'sf pro', 'sf pro text',
  'sf pro display', 'apple color emoji', 'segoe ui emoji',
  'segoe ui symbol', 'noto color emoji', 'brush script mt',
  'liberation sans', 'liberation serif', 'liberation mono',
  'dejavu sans', 'dejavu serif', 'cantarell', 'fira sans', 'droid sans', 'ubuntu'
])


const CDN_FONTS: Record<string, string> = {
  'Font Awesome 6 Free': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
  'Font Awesome 6 Brands': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
  'Font Awesome 5 Free': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css',
  'Font Awesome 5 Brands': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css',
  'FontAwesome': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css',
  'Material Icons': 'https://fonts.googleapis.com/icon?family=Material+Icons',
  'Material Symbols Outlined': 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined',
  'Material Symbols Rounded': 'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded',
}

/* ------------------------------------------------------------------ */
/*  HTML parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Properties commonly changed by CSS @media queries.  These must NOT
 * exist as inline styles because inline styles override media queries
 * at ALL viewport widths.  The CSSOM capture already preserves the
 * correct CSS rules (including @media blocks) for every breakpoint,
 * so removing these inline values lets those rules take effect.
 *
 * This covers Elementor-generated inline styles AND our own baked
 * styles from capture.ts.
 */
const RESPONSIVE_PROPS = new Set([
  // Layout flow
  'display', 'flex-direction', 'justify-content', 'align-items',
  'flex-wrap', 'order', 'grid-template-columns', 'grid-template-rows',
  // Typography — font-family included because CSSOM rules already provide
  // the correct font and baked inline values block user edits from
  // taking effect (inline styles override GrapesJS CSS changes).
  'font-family', 'font-size', 'line-height', 'letter-spacing', 'font-weight',
  // Spacing (Elementor changes per breakpoint)
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap',
  // Sizing — only max-width (responsive containers use it).
  // Do NOT strip width/min-width — Elementor columns rely on inline
  // width for layout and stripping causes content to shift/expand.
  'max-width',
  // Alignment
  'text-align',
])

/**
 * Strip responsive CSS properties from inline styles in the HTML string.
 * The CSSOM capture preserves all CSS rules (including @media queries)
 * so these inline values are redundant and harmful — they override the
 * media queries at every viewport width.
 */
function stripNonContentElements(html: string): string {
  // Remove iframes — chat widgets, analytics, trackers, empty embeds.
  // WordPress/Elementor pages use iframes for non-content purposes
  // (Tidio, Intercom, Google Tag Manager, etc.) that create whitespace
  // after scripts are stripped.
  let result = html
  result = result.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
  result = result.replace(/<iframe[^>]*\/>/gi, '')
  // Remove <noscript> blocks — not useful in the editor
  result = result.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
  return result
}

function stripBakedResponsiveStyles(html: string): string {
  // Match opening HTML tags individually so we can check for
  // data-widget-frozen before stripping responsive properties.
  // Frozen widget styles must be preserved — they were fully baked
  // during capture and have no CSS rules to fall back on.
  return html.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    if (!tag.includes(' style="')) return tag
    // Preserve all inline styles on frozen widget & preserved header elements
    if (tag.includes('data-widget-frozen') || tag.includes('data-header-preserved')) return tag

    return tag.replace(/ style="([^"]*)"/i, (_m, styleVal: string) => {
      const declarations = styleVal.split(';').filter(d => d.trim())
      const kept = declarations.filter(d => {
        const parts = d.split(':')
        const prop = parts[0].trim().toLowerCase()
        const val = parts.slice(1).join(':').trim().toLowerCase()
        // Strip inline display: none from non-popup/modal elements so stylesheet @media queries natively unhide them on mobile
        if (prop === 'display' && val.includes('none')) {
          const isPopupOrModal = /popup|modal|consent|cookie|dialog/i.test(tag)
          if (!isPopupOrModal) return false
          return true
        }
        return !RESPONSIVE_PROPS.has(prop)
      })
      if (kept.length === 0) return ''
      return ` style="${kept.join(';')}"`
    })
  })
}

function parseSnapshotHtml(html: string): SnapshotParts {
  const cssLinks: string[] = []
  const inlineStyles: string[] = []

  // Extract CSS <link> tags — preserve media attribute for responsive sheets
  const linkRe = /<link[^>]*?href=["']([^"']+)["'][^>]*?>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    if (/rel=["']stylesheet["']/i.test(m[0])) {
      const href = m[1].replace(/&amp;/g, '&')
      // Check for media attribute — if present, we'll inject it manually
      // in the load handler rather than via canvas.styles (which loses it)
      const mediaMatch = m[0].match(/media=["']([^"']+)["']/i)
      if (mediaMatch) {
        // Store as object with media info (will be handled separately)
        cssLinks.push(`${href}|||${mediaMatch[1]}`)
      } else {
        cssLinks.push(href)
      }
    }
  }

  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi
  while ((m = styleRe.exec(html)) !== null) {
    inlineStyles.push(m[1])
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  const bodyHtml = bodyMatch ? bodyMatch[1] : html

  // Extract body tag attributes (class, style, data-*) — needed for CSS
  // selector matching and CSS variable inheritance
  const bodyTagMatch = html.match(/<body([^>]*)>/i)
  const bodyAttrs = bodyTagMatch ? bodyTagMatch[1] : ''
  const bodyClassMatch = bodyAttrs.match(/class="([^"]*)"/)
  const bodyClass = bodyClassMatch ? bodyClassMatch[1] : ''
  const bodyStyleMatch = bodyAttrs.match(/style="([^"]*)"/)
  const bodyStyle = bodyStyleMatch ? bodyStyleMatch[1] : ''

  // Extract html tag attributes (class, style)
  const htmlTagMatch = html.match(/<html([^>]*)>/i)
  const htmlAttrs = htmlTagMatch ? htmlTagMatch[1] : ''
  const htmlClassMatch = htmlAttrs.match(/class="([^"]*)"/)
  const htmlClass = htmlClassMatch ? htmlClassMatch[1] : ''
  const htmlStyleMatch = htmlAttrs.match(/style="([^"]*)"/)
  const htmlStyle = htmlStyleMatch ? htmlStyleMatch[1] : ''

  // Extract preserved script URLs from meta tag (injected during capture)
  const scriptsMeta = html.match(/<meta[^>]*name=["']snapshot-preserved-scripts["'][^>]*content=["']([^"']*)["'][^>]*>/i)
  const widgetScripts = scriptsMeta ? scriptsMeta[1].split('|||').filter(s => s.trim()) : []

  return { bodyHtml, cssLinks, inlineCss: inlineStyles.join('\n'), htmlClass, bodyClass, bodyStyle, htmlStyle, widgetScripts }
}

/* ------------------------------------------------------------------ */
/*  Font helpers                                                      */
/* ------------------------------------------------------------------ */

function isIconFont(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('font awesome') || lower.includes('fontawesome') ||
    lower.includes('material icons') || lower.includes('material symbols') ||
    lower.includes('icomoon') || lower.includes('ionicons') ||
    lower.includes('glyphicons') || lower.includes('dashicons')
}

/** Extract the primary font name from a computed font-family string */
function primaryFont(ff: string): string {
  return ff.split(',')[0].trim().replace(/^["']|["']$/g, '')
}

/** Scan all elements in the document for non-system font-family names */
function scanDocumentFonts(doc: Document): Set<string> {
  const fonts = new Set<string>()
  doc.querySelectorAll('*').forEach((el) => {
    const computed = doc.defaultView?.getComputedStyle(el)
    if (!computed) return
    computed.fontFamily.split(',').forEach((f) => {
      const clean = f.trim().replace(/^["']|["']$/g, '')
      if (clean && !SYSTEM_FONTS.has(clean.toLowerCase())) {
        fonts.add(clean)
      }
    })
  })
  return fonts
}

function isFontRendering(doc: Document, fontName: string): boolean {
  const canvas = doc.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return true

  const testStr = 'abcdefghijklmnopqrstuvwxyz0123456789!@#$%'
  const size = '72px'

  for (const fallback of ['monospace', 'sans-serif', 'serif']) {
    ctx.font = `${size} ${fallback}`
    const baseWidth = ctx.measureText(testStr).width
    ctx.font = `${size} "${fontName}", ${fallback}`
    const testWidth = ctx.measureText(testStr).width
    if (Math.abs(baseWidth - testWidth) > 0.1) return true
  }
  return false
}

function getLoadedWebFonts(doc: Document): Set<string> {
  const loaded = new Set<string>()
  doc.fonts.forEach((face) => {
    if (face.status === 'loaded') {
      loaded.add(face.family.replace(/^["']|["']$/g, ''))
    }
  })
  return loaded
}

function findMissing(doc: Document, fonts: string[]): string[] {
  const loaded = getLoadedWebFonts(doc)
  return fonts.filter((f) => {
    if (loaded.has(f)) return false
    if (!isIconFont(f) && isFontRendering(doc, f)) return false
    return true
  })
}

/* ------------------------------------------------------------------ */
/*  Font loading                                                      */
/* ------------------------------------------------------------------ */

async function injectAndLoadFonts(doc: Document, textFonts: string[], iconFonts: string[]): Promise<void> {
  const linkPromises: Promise<void>[] = []

  const addLink = (url: string) => {
    if (!url || doc.querySelector(`link[href="${CSS.escape(url)}"]`)) return
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = url
    doc.head.appendChild(link)
    linkPromises.push(new Promise<void>((resolve) => {
      link.onload = () => resolve()
      link.onerror = () => resolve()
    }))
  }

  // Load each text font cleanly from Google Fonts
  for (const rawFont of textFonts) {
    let fontName = rawFont.trim().replace(/^["']|["']$/g, '')
    if (!fontName) continue
    if (fontName.toLowerCase() === 'oxygen-sans') fontName = 'Oxygen'
    if (fontName.toLowerCase() === 'noto-sans') fontName = 'Noto Sans'

    const encoded = encodeURIComponent(fontName).replace(/%20/g, '+')
    addLink(`https://fonts.googleapis.com/css2?family=${encoded}:wght@400;500;600;700&display=swap`)
  }

  const cdnUrls = new Set<string>()
  for (const f of iconFonts) {
    if (CDN_FONTS[f]) cdnUrls.add(CDN_FONTS[f])
  }
  for (const url of cdnUrls) addLink(url)

  // Wait for stylesheet links to load
  await Promise.all(linkPromises)

  // Trigger browser font file loading
  const loadPromises = textFonts.map((f) => {
    let fontName = f.trim().replace(/^["']|["']$/g, '')
    if (fontName.toLowerCase() === 'oxygen-sans') fontName = 'Oxygen'
    return doc.fonts.load(`1em "${fontName}"`).catch(() => {})
  })
  await Promise.all(loadPromises)
  try { await doc.fonts.ready } catch {}
}


/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

function sanitizeDomAttributeNames(html: string): string {
  if (!html) return ''
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const attributeProbe = doc.createElement('div')
    const all = doc.querySelectorAll('*')
    all.forEach(el => {
      // Remove hardcoded inline height from heading elements (h1-h6) so multi-line titles expand naturally without overlapping paragraph text
      if (/^H[1-6]$/i.test(el.tagName) && el instanceof HTMLElement) {
        if (el.style.height) {
          el.style.height = ''
        }
      }
      const attrs = Array.from(el.attributes)
      attrs.forEach(attr => {
        try {
          attributeProbe.setAttribute(attr.name, '')
          attributeProbe.removeAttribute(attr.name)
        } catch {
          try { el.removeAttributeNode(attr) } catch {}
        }
      })
      const srcset = el.getAttribute('srcset')
      if (srcset && /(?:^|,)\s*data:/i.test(srcset)) {
        el.removeAttribute('srcset')
      }
    })
    return doc.body ? doc.body.innerHTML : html
  } catch {
    return html
  }
}

export function initEditor(container: HTMLElement, snapshotHtml: string, options?: InitEditorOptions): Editor {
  const { bodyHtml: rawBodyHtml, cssLinks: rawCssLinks, inlineCss, htmlClass, bodyClass, bodyStyle, htmlStyle, widgetScripts } = parseSnapshotHtml(snapshotHtml)
  // DOM-based validation preserves valid SVG, srcset, apostrophes, and data URIs.
  const bodyHtml = sanitizeDomAttributeNames(rawBodyHtml)
  let fontsReady = false

  // Separate regular CSS links from media-constrained ones
  // Media-constrained links use "href|||media" format from parseSnapshotHtml
  const plainCssLinks: string[] = []
  const mediaCssLinks: { href: string; media: string }[] = []
  for (const link of rawCssLinks) {
    if (link.includes('|||')) {
      const [href, media] = link.split('|||')
      mediaCssLinks.push({ href, media })
    } else {
      plainCssLinks.push(link)
    }
  }

  const editor = grapesjs.init({
    container,
    height: '100%',
    width: 'auto',
    fromElement: false,
    components: bodyHtml,

    storageManager: false,

    canvas: { styles: plainCssLinks },
    panels: { defaults: [] },

    colorPicker: {
      appendTo: 'parent',
      showAlpha: true,
      showInput: true,
      preferredFormat: 'hex',
    },

    deviceManager: {
      devices: [
        { name: 'Desktop', width: '1920px', height: '1200px', widthMedia: '' },
        { name: 'Tablet', width: '1180px', height: '820px', widthMedia: '1180px' },
        { name: 'Mobile', width: '430px', height: '932px', widthMedia: '430px' },
        { name: 'Custom', width: '1920px', height: '1200px', widthMedia: '' }
      ]
    },

    selectorManager: { appendTo: '#selector-container' },

    // styleManager disabled — replaced by NativeStylePanel in EditorWorkspace

    layerManager: {
      appendTo: '#layers-container',
      showTextable: true,
      sortable: true
    } as any
  })

  // ── After load: inject CSS, enable resize, discover + load fonts ──
  editor.on('load', () => {
    const doc = editor.Canvas.getDocument()

    // Keyboard events do not bubble out of the GrapesJS iframe. Relay their
    // normalized input data to the workspace so user-defined bindings remain
    // authoritative instead of installing hard-coded Escape/undo handlers.
    if (doc?.defaultView?.parent) {
      const relay = (phase: 'keydown' | 'keyup') => (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null
        const detail = {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          editable: !!target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
          handled: false,
        }
        doc.defaultView!.parent.dispatchEvent(
          new CustomEvent(`parity:embedded-${phase}`, { detail }),
        )
        if (detail.handled) {
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
        }
      }
      doc.addEventListener('keydown', relay('keydown'), true)
      doc.addEventListener('keyup', relay('keyup'), true)
    }

    // Ensure <base href="..."> from snapshotHtml is injected into doc.head first!
    const baseMatch = snapshotHtml.match(/<base[^>]*href=["']([^"']+)["'][^>]*>/i)
    if (doc && baseMatch) {
      if (!doc.querySelector('base')) {
        const baseEl = doc.createElement('base')
        baseEl.setAttribute('href', baseMatch[1])
        doc.head.insertBefore(baseEl, doc.head.firstChild)
      }
    }

    // Restore original <html> and <body> attributes.
    // WordPress/Elementor CSS selectors depend on body classes (e.g.
    // .elementor-kit-345, .page-id-7145) and CSS custom properties
    // (--e-global-*) defined on :root / body for typography & layout.
    //
    // CRITICAL: CSS custom properties (--*) must go into a <style> block,
    // NOT inline styles.  The capture process bakes them at 1920px desktop,
    // but Elementor's CSSOM contains @media queries that change them at
    // different breakpoints.  Inline styles override those @media rules.
    // Moving them to a <style> block with normal specificity lets the
    // @media rules win at mobile/tablet viewports.
    if (doc) {
      if (htmlClass) {
        doc.documentElement.className = htmlClass
      }

      // Add reset style to prevent canvas scrollbar margin gaps on right side
      const canvasReset = doc.createElement('style')
      canvasReset.textContent = `
        html, body {
          overflow-x: hidden !important;
        }
      `
      doc.head.appendChild(canvasReset)

      // Split htmlStyle into custom properties (→ <style>) and regular (→ inline)
      const cssVarsHtml: string[] = []
      const regularHtml: string[] = []
      if (htmlStyle) {
        htmlStyle.split(';').forEach(d => {
          const trimmed = d.trim()
          if (!trimmed) return
          if (trimmed.startsWith('--')) {
            cssVarsHtml.push(trimmed)
          } else {
            regularHtml.push(trimmed)
          }
        })
        if (regularHtml.length > 0) {
          doc.documentElement.setAttribute('style', regularHtml.join(';'))
        }
      }

      // Split bodyStyle similarly
      const cssVarsBody: string[] = []
      const regularBody: string[] = []
      if (bodyStyle) {
        bodyStyle.split(';').forEach(d => {
          const trimmed = d.trim()
          if (!trimmed) return
          if (trimmed.startsWith('--')) {
            cssVarsBody.push(trimmed)
          } else {
            regularBody.push(trimmed)
          }
        })
        if (regularBody.length > 0) {
          const existing = doc.body.getAttribute('style') || ''
          doc.body.setAttribute('style', existing + (existing ? ';' : '') + regularBody.join(';'))
        }
      }

      // Inject CSS custom properties as a stylesheet rule (not inline)
      // so that @media queries in the captured CSSOM can override them.
      if (cssVarsHtml.length > 0 || cssVarsBody.length > 0) {
        const varsStyle = doc.createElement('style')
        varsStyle.setAttribute('data-css-vars', 'true')
        let css = ''
        if (cssVarsHtml.length > 0) {
          css += `:root { ${cssVarsHtml.join('; ')}; }\n`
        }
        if (cssVarsBody.length > 0) {
          css += `body { ${cssVarsBody.join('; ')}; }\n`
        }
        varsStyle.textContent = css
        // Insert BEFORE the captured CSSOM so @media rules can override
        doc.head.insertBefore(varsStyle, doc.head.firstChild)
      }

      // No custom CSS injection — the captured site's own CSS should render 1:1

    }

    // Inject captured CSSOM at the BEGINNING of <head>.
    // GrapesJS inserts its own <style> blocks later in <head>.
    // By putting captured CSS first, GrapesJS-generated rules (user edits)
    // naturally override captured rules via CSS cascade order — no need
    // for !important hacks for font-family and other properties.
    if (doc && inlineCss) {
      const styleEl = doc.createElement('style')
      styleEl.setAttribute('data-snapshot-cssom', 'true')
      styleEl.textContent = inlineCss
      // Insert after the CSS vars block (if any) but before GrapesJS styles
      const varsBlock = doc.querySelector('style[data-css-vars]')
      if (varsBlock && varsBlock.nextSibling) {
        doc.head.insertBefore(styleEl, varsBlock.nextSibling)
      } else {
        doc.head.insertBefore(styleEl, doc.head.firstChild)
      }
    }

    // Inject external CSS links into iframe <head> (elementor-icons, FontAwesome, etc.)
    if (doc && plainCssLinks.length > 0) {
      for (const href of plainCssLinks) {
        if (!doc.querySelector(`link[href="${CSS.escape(href)}"]`)) {
          const link = doc.createElement('link')
          link.rel = 'stylesheet'
          link.href = href
          doc.head.appendChild(link)
        }
      }
    }

    // Inject media-constrained CSS links that canvas.styles can't handle
    if (doc && mediaCssLinks.length > 0) {
      for (const { href, media } of mediaCssLinks) {
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = href
        link.media = media
        doc.head.appendChild(link)
      }
    }

    // Preserve native HTML & stylesheets intact without stripping inline styles
    if (doc) {
      const resetStyle = doc.createElement('style')
      resetStyle.setAttribute('data-canvas-reset', 'true')
      resetStyle.textContent = `
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          width: 100% !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
          box-sizing: border-box !important;
        }
        *, *:before, *:after {
          box-sizing: border-box;
        }
      `
      doc.head.insertBefore(resetStyle, doc.head.firstChild)
    }

    // ── Hide SVG sprite sheets & symbol definitions (eicons, FontAwesome, etc.) ──
    // WordPress/Elementor injects icon sprite sheets at the bottom of <body>.
    // When display:none is stripped, browser renders them as 300x150 layout blocks
    // creating a large white section at the bottom of the page.
    if (doc) {
      doc.querySelectorAll('svg').forEach((svg) => {
        const hasDefsOrSymbols = svg.querySelector('symbol, defs') !== null
        const directShapes = svg.querySelectorAll(':scope > path, :scope > rect, :scope > circle, :scope > polygon, :scope > polyline, :scope > ellipse, :scope > image, :scope > text')
        if (hasDefsOrSymbols && directShapes.length === 0) {
          svg.style.display = 'none'
        } else if (svg.parentElement === doc.body) {
          const style = doc.defaultView?.getComputedStyle(svg)
          if (style?.position !== 'absolute' && style?.position !== 'fixed') {
            svg.style.display = 'none'
          }
        }
      })

      // Hide direct children of <body> sitting after <footer> or <main> if they are non-content/empty
      const bodyChildren = Array.from(doc.body.children)
      let seenMainOrFooter = false
      for (const child of bodyChildren) {
        const tag = child.tagName.toLowerCase()
        if (tag === 'footer' || tag === 'main') {
          seenMainOrFooter = true
          continue
        }
        if (seenMainOrFooter) {
          const htmlChild = child as HTMLElement
          if (htmlChild.hasAttribute && (htmlChild.hasAttribute('data-widget-frozen') || htmlChild.closest('[data-widget-frozen]'))) {
            continue
          }
          if (tag === 'span' || tag === 'i' || /hamburger|burger|toggle|toggler|icon|eicon/i.test(htmlChild.className + ' ' + htmlChild.id)) {
            continue
          }
          if (tag === 'svg' || tag === 'link' || tag === 'script') {
            const text = (htmlChild.textContent || '').trim()
            const hasMedia = htmlChild.querySelector('img, video, canvas, iframe')
            if (!text && !hasMedia) {
              htmlChild.style.display = 'none'
            }
          } else {
            const text = (htmlChild.textContent || '').trim()
            const hasMedia = htmlChild.querySelector('img, video, canvas, iframe')
            const style = doc.defaultView?.getComputedStyle(htmlChild)
            const isFixedOrSticky = style?.position === 'fixed' || style?.position === 'sticky' || style?.position === 'absolute'
            if (!text && !hasMedia && !isFixedOrSticky) {
              htmlChild.style.display = 'none'
            }
          }
        }
      }
    }

    // ── Collapse empty containers (leftover from stripped iframes/widgets) ──
    // stripNonContentElements removes iframes/noscripts but leaves parent
    // containers behind.  These empty divs can have min-height/padding that
    // creates visible whitespace.  Walk bottom-up so nested empty containers
    // are collapsed recursively (inner empties first, then outer becomes empty).
    if (doc) {
      const isVisuallyEmpty = (el: HTMLElement): boolean => {
        // Has meaningful text?
        if ((el.textContent || '').trim().length > 0) return false
        // Has images, videos, canvas, or other media?
        if (el.querySelector('img, video, canvas, picture, object, embed')) return false
        // SVGs: sprite sheets or small decorative SVGs should not prevent collapsing
        const svgs = el.querySelectorAll('svg')
        for (const svg of Array.from(svgs)) {
          if (svg.querySelector('symbol, defs') !== null) continue
          const w = parseFloat(svg.getAttribute('width') || '0')
          const h = parseFloat(svg.getAttribute('height') || '0')
          if (w > 24 || h > 24) return false
          const vb = svg.getAttribute('viewBox')
          if (vb && !w && !h) {
            const parts = vb.split(/[\s,]+/)
            if (parseFloat(parts[2] || '0') > 24 || parseFloat(parts[3] || '0') > 24) return false
          }
        }
        // Has background image?
        const cs = doc.defaultView?.getComputedStyle(el)
        if (cs?.backgroundImage && cs.backgroundImage !== 'none') return false
        return true
      }
      // Collect all containers, then process deepest-first (reverse DOM order)
      const containers = Array.from(doc.querySelectorAll('div, section, aside, span, p, article, nav, header, footer, form, ul, ol, svg, a'))
      containers.reverse().forEach((el: Element) => {
        const htmlEl = el as HTMLElement
        // Skip frozen widget elements
        if (htmlEl.hasAttribute('data-widget-frozen') || htmlEl.closest('[data-widget-frozen]')) return
        // Never collapse icon elements, buttons, menu toggles, or hamburger lines
        const tag = htmlEl.tagName.toLowerCase()
        const isIconOrToggle = tag === 'span' || tag === 'i' || tag === 'svg' || tag === 'button' ||
          /hamburger|burger|toggle|toggler|icon|eicon/i.test(htmlEl.className + ' ' + htmlEl.id) ||
          htmlEl.closest('.elementor-menu-toggle, .menu-toggle, [class*="hamburger"], [class*="burger"]') !== null
        if (isIconOrToggle) return
        // Check if all children are hidden (already collapsed)
        const visibleChildren = Array.from(htmlEl.children).filter(
          (child) => (child as HTMLElement).style?.display !== 'none'
        )
        if (visibleChildren.length > 0) return
        if (!isVisuallyEmpty(htmlEl)) return
        htmlEl.style.display = 'none'
      })
    }

    const enableResize = (component: ReturnType<typeof editor.getWrapper>) => {
      if (!component) return
      component.set('resizable', true)
      component.components().each((child: any) => enableResize(child))
    }
    enableResize(editor.getWrapper())

    // ── Inject preserved page scripts (jQuery, Elementor, widgets, etc.) ──
    // Scripts are loaded sequentially to respect dependency order (jQuery
    // must finish before plugins that depend on it, etc.).  This makes
    // interactive elements (chat widgets, sliders, tabs, menus) fully
    // functional inside the editor — 1:1 with the staging site.
    if (doc && widgetScripts.length > 0) {
      const injectScripts = async () => {
        for (const url of widgetScripts) {
          await new Promise<void>((resolve) => {
            const s = doc!.createElement('script')
            s.src = url
            s.onload = () => resolve()
            s.onerror = () => resolve() // continue even if one fails
            doc!.body.appendChild(s)
          })
        }
      }
      injectScripts().catch(() => {})
    }

    // ── Scan iframe computed styles for ALL fonts (catches external CSS) ──
    if (doc) {
      const run = async () => {
        // Wait for external stylesheets to load in the iframe
        await new Promise((r) => setTimeout(r, 1500))

        // Scan computed styles — catches fonts from <link> stylesheets too
        const allFonts = scanDocumentFonts(doc)
        const textFonts = [...allFonts].filter((f) => !isIconFont(f))
        const iconFonts = [...allFonts].filter((f) => isIconFont(f))

        // Load from Google Fonts / CDN + force download font files
        await injectAndLoadFonts(doc, textFonts, iconFonts)

        // Mark fonts as ready — component:selected handler can now safely sync
        fontsReady = true

        // Detect any fonts that still couldn't load
        const missing = findMissing(doc, [...allFonts])
        if (missing.length > 0 && options?.onMissingFonts) {
          options.onMissingFonts(missing)
        }
      }
      run().catch(() => {})
    }
  })

  // ── On component selection: sync computed styles into GrapesJS model ──
  // GrapesJS only shows styles from its own model (not external stylesheets).
  // External CSS (WordPress/Elementor) defines all the real spacing, typography,
  // etc. — so the style panel shows 0/empty for everything by default.
  // Fix: read computed values from the iframe and populate the model.
  // Only syncs properties not already in the model (preserves user edits).
  const PROPS_TO_SYNC = [
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'gap',
    'font-size', 'font-weight', 'letter-spacing', 'line-height',
    'text-align', 'text-decoration', 'text-transform', 'color',
    'text-indent', 'word-spacing',
  ]

  // Track which values were synced from computed styles (defaults) vs. user edits.
  // Only user edits get inline !important — synced defaults must NOT override
  // responsive CSS media queries when the viewport size changes.
  const _syncedDefaults = new WeakMap<Element, Record<string, string>>()

  editor.on('component:selected', (component: any) => {
    const el = component.getEl()
    if (!el) return
    const iframeDoc = editor.Canvas.getDocument()
    const computed = iframeDoc?.defaultView?.getComputedStyle(el)
    if (!computed) return

    // Check BOTH component inline styles AND CssComposer rules for
    // existing values.  If the user already changed a property (stored
    // in a CssComposer rule), we must NOT overwrite it with the
    // computed default.
    const currentStyles = component.getStyle() || {}
    const ruleStyles: Record<string, any> = {}
    try {
      const selectors = component.getSelectors()
      if (selectors && selectors.getFullString) {
        const fullSel = selectors.getFullString()
        if (fullSel) {
          const rule = editor.CssComposer.getRule(fullSel)
          if (rule) Object.assign(ruleStyles, rule.getStyle() || {})
        }
      }
    } catch (_) {}

    const newStyles: Record<string, string> = {}

    for (const prop of PROPS_TO_SYNC) {
      // Skip if already set in component inline styles OR CssComposer rule
      const cur = currentStyles[prop] || ruleStyles[prop]
      if (cur && cur !== '') continue
      const val = computed.getPropertyValue(prop)
      if (val && val !== '0px' && val !== '0' && val !== 'normal' && val !== 'none' && val !== '') {
        newStyles[prop] = val
      }
    }

    // Font-family: only after fonts are loaded (avoids syncing fallback names)
    if (fontsReady) {
      // Skip if user already changed font-family via CssComposer
      if (!ruleStyles['font-family'] && !currentStyles['font-family']) {
        const pf = primaryFont(computed.fontFamily)
        if (pf && !SYSTEM_FONTS.has(pf.toLowerCase())) {
          newStyles['font-family'] = pf
        }
      }
    }

    // Store synced values so _applyInline knows these are defaults, not user edits
    _syncedDefaults.set(el, { ...newStyles })

    if (Object.keys(newStyles).length > 0) {
      component.addStyle(newStyles)
    }
  })

  // ── Apply model styles as inline !important to override external CSS ──
  // WordPress/Elementor stylesheets use high-specificity selectors and
  // !important rules that override GrapesJS's generated CSS rules.
  // Applying as inline !important ensures user edits always take effect.
  //
  // CRITICAL: only apply !important for values the user ACTUALLY CHANGED
  // (different from the synced computed default). Synced defaults must NOT
  // get !important because that would block responsive CSS media queries
  // from working when the viewport size changes.
  //
  // Styles can live in two places in GrapesJS:
  //   1. Component inline styles (component.getStyle())
  //   2. CSS rules created via the SelectorManager (class-based targets)
  // We merge both but only !important user-edited values.
  const _gjsApplied = new WeakMap<Element, Set<string>>()
  const _gjsModifiedEls = new Set<Element>()

  const _applyInline = (component: any) => {
    const el = component.getEl()
    if (!el) return

    // Determine the current device's media query so we can include
    // matching media-specific rules (GrapesJS stores edits under the
    // current device's widthMedia).
    const curDevice = editor.Devices.get(editor.getDevice())
    const curWidthMedia = curDevice?.get('widthMedia') || ''
    const curMedia = curWidthMedia ? `(max-width: ${curWidthMedia})` : ''

    // Collect all styles that should apply to this element.
    const allStyles: Record<string, any> = {}

    // Find rules by selector matching against the DOM element.
    // Include rules with NO media (base styles) and rules matching
    // the current device's media query (user edits at this breakpoint).
    try {
      editor.CssComposer.getAll().each((rule: any) => {
        if (rule.get('state')) return
        const ruleMedia = rule.get('mediaText') || ''
        // Include: no media (base) OR matches current device
        if (ruleMedia && ruleMedia !== curMedia) return
        try {
          const selStr = rule.selectorsToString()
          if (selStr && el.matches(selStr)) {
            Object.assign(allStyles, rule.getStyle() || {})
          }
        } catch (_) { /* selector may not be matchable */ }
      })
    } catch (_) {}

    // Direct rule lookup via component's own selectors — catches
    // GrapesJS-specific selector formats that el.matches() can't parse.
    // Check both base rules and current-device media rules.
    try {
      const selectors = component.getSelectors()
      if (selectors && selectors.getFullString) {
        const fullSel = selectors.getFullString()
        if (fullSel) {
          // Base rule (no media)
          const rule = editor.CssComposer.getRule(fullSel)
          if (rule) Object.assign(allStyles, rule.getStyle() || {})
          // Current device media rule
          if (curMedia) {
            const mediaRule = editor.CssComposer.getRule(fullSel, {
              atRuleType: 'media',
              atRuleParams: curMedia
            })
            if (mediaRule) Object.assign(allStyles, mediaRule.getStyle() || {})
          }
        }
      }
    } catch (_) {}

    // Component inline styles — but DON'T let them overwrite CssComposer
    // values.  CssComposer rules contain user edits (newer), while
    // component.getStyle() contains stale values from HTML parsing or
    // computed-style syncing.  Only merge component values for properties
    // that have NO CssComposer value yet.
    const synced = _syncedDefaults.get(el) || {}
    const compStyles = component.getStyle() || {}
    for (const [prop, val] of Object.entries(compStyles)) {
      if (val == null || !String(val).trim()) continue
      // If CssComposer already has this property, it's from a user edit — don't overwrite
      if (allStyles[prop] != null) continue
      const strVal = String(val)
      // Skip synced defaults
      if (synced[prop] === strVal) continue
      allStyles[prop] = val
    }

    const prev = _gjsApplied.get(el) || new Set<string>()
    const current = new Set<string>()

    for (const [prop, val] of Object.entries(allStyles)) {
      if (val == null || !String(val).trim()) continue
      const strVal = String(val)
      // Skip synced defaults — only apply !important for actual changes
      if (synced[prop] === strVal) continue
      el.style.setProperty(prop, strVal, 'important')
      current.add(prop)
    }

    // Remove inline styles for properties the user cleared from the panel
    for (const prop of prev) {
      if (!current.has(prop)) {
        el.style.removeProperty(prop)
      }
    }

    _gjsApplied.set(el, current)
    if (current.size > 0) _gjsModifiedEls.add(el)
  }

  editor.on('component:styleUpdate', _applyInline)

  // Also listen for CSS rule additions/changes (class-based style targets)
  editor.CssComposer.getAll().on('add change', () => {
    const sel = editor.getSelected()
    if (sel) _applyInline(sel)
  })

  // ── Responsive: clear user-edit overrides on device change ──
  // Responsive properties are stripped from inline styles before GrapesJS
  // parses them (stripBakedResponsiveStyles), so CSS @media queries work
  // at all viewports.  On device change we only need to:
  //   1. Clear any inline !important styles added by _applyInline (user edits)
  //   2. Re-sync the selected element's computed styles for the new viewport
  editor.on('device:change', () => {
    const device = editor.Devices.get(editor.getDevice())
    const frame = editor.Canvas.getFrameEl()
    if (!frame) return

    // Ensure wrapper width matches device
    if (device) {
      const w = device.get('width')
      const wrapper = frame.parentElement
      if (wrapper && w) {
        wrapper.style.width = typeof w === 'number' ? `${w}px` : w
      }
    }

    // Clear GrapesJS user-edit inline !important overrides
    for (const el of _gjsModifiedEls) {
      const props = _gjsApplied.get(el)
      if (props) {
        for (const prop of props) {
          ;(el as HTMLElement).style.removeProperty(prop)
        }
      }
      _gjsApplied.delete(el)
    }
    _gjsModifiedEls.clear()

    // Re-sync selected element's computed styles for the new viewport
    requestAnimationFrame(() => {
      if (frame.contentWindow) {
        frame.contentWindow.dispatchEvent(new Event('resize'))
      }
      const sel = editor.getSelected()
      if (!sel) return
      const el = sel.getEl()
      if (!el) return
      const doc = editor.Canvas.getDocument()
      const computed = doc?.defaultView?.getComputedStyle(el)
      if (!computed) return
      const newStyles: Record<string, string> = {}
      for (const prop of PROPS_TO_SYNC) {
        const val = computed.getPropertyValue(prop)
        if (val && val !== '0px' && val !== '0' && val !== 'normal' && val !== 'none' && val !== '') {
          newStyles[prop] = val
        }
      }
      _syncedDefaults.set(el, { ...newStyles })
      sel.setStyle(newStyles)
    })
  })

  return editor
}

/**
 * Load missing fonts into the GrapesJS canvas.
 * Uses CDN for known icon fonts, Google Fonts for everything else.
 * Returns the list of fonts that are still missing after loading.
 */
export async function loadMissingFonts(editor: Editor, fonts: string[]): Promise<string[]> {
  const doc = editor.Canvas.getDocument()
  if (!doc) return fonts

  const textFonts = fonts.filter((f) => !CDN_FONTS[f])
  const iconFonts = fonts.filter((f) => !!CDN_FONTS[f])
  await injectAndLoadFonts(doc, textFonts, iconFonts)

  return findMissing(doc, fonts)
}
