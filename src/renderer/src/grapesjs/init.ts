import grapesjs, { Editor } from 'grapesjs'
import 'grapesjs/dist/css/grapes.min.css'
import './theme.css'

interface SnapshotParts {
  bodyHtml: string
  cssLinks: string[]
  inlineCss: string
  bodyClass: string
  bodyStyle: string
  htmlStyle: string
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
  '-apple-system', 'blinkmacsystemfont', 'sf pro', 'sf pro text',
  'sf pro display', 'apple color emoji', 'segoe ui emoji',
  'segoe ui symbol', 'noto color emoji', 'brush script mt'
])

const SYSTEM_FONT_OPTIONS = [
  { id: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { id: 'Arial Black, Gadget, sans-serif', label: 'Arial Black' },
  { id: 'Comic Sans MS, cursive', label: 'Comic Sans MS' },
  { id: 'Courier New, Courier, monospace', label: 'Courier New' },
  { id: 'Georgia, serif', label: 'Georgia' },
  { id: 'Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { id: 'Impact, Charcoal, sans-serif', label: 'Impact' },
  { id: 'Tahoma, Geneva, sans-serif', label: 'Tahoma' },
  { id: 'Times New Roman, Times, serif', label: 'Times New Roman' },
  { id: 'Trebuchet MS, Helvetica, sans-serif', label: 'Trebuchet MS' },
  { id: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
]

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
  return html.replace(/\sstyle="([^"]*)"/gi, (_fullMatch, styleVal: string) => {
    const declarations = styleVal.split(';').filter(d => d.trim())
    const kept = declarations.filter(d => {
      const prop = d.split(':')[0].trim().toLowerCase()
      return !RESPONSIVE_PROPS.has(prop)
    })
    if (kept.length === 0) return ''
    return ` style="${kept.join(';')}"`
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

  // Extract html tag style (CSS custom properties / Elementor variables)
  const htmlTagMatch = html.match(/<html([^>]*)>/i)
  const htmlAttrs = htmlTagMatch ? htmlTagMatch[1] : ''
  const htmlStyleMatch = htmlAttrs.match(/style="([^"]*)"/)
  const htmlStyle = htmlStyleMatch ? htmlStyleMatch[1] : ''

  return { bodyHtml, cssLinks, inlineCss: inlineStyles.join('\n'), bodyClass, bodyStyle, htmlStyle }
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
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = url
    doc.head.appendChild(link)
    linkPromises.push(new Promise<void>((resolve) => {
      link.onload = () => resolve()
      link.onerror = () => resolve()
    }))
  }

  if (textFonts.length > 0) {
    const families = textFonts.map(
      (f) => `family=${encodeURIComponent(f)}:wght@100..900`
    )
    addLink(`https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`)
  }

  const cdnUrls = new Set<string>()
  for (const f of iconFonts) {
    if (CDN_FONTS[f]) cdnUrls.add(CDN_FONTS[f])
  }
  for (const url of cdnUrls) addLink(url)

  // Wait for stylesheet links to load
  await Promise.all(linkPromises)

  // Explicitly trigger font file downloads — without this, the browser only
  // downloads font files when an element on the page actually uses them.
  // Since the page's CSS classes reference these fonts but GrapesJS may not
  // have rendered with them yet, we force the download here.
  const loadPromises = textFonts.map((f) =>
    doc.fonts.load(`1em "${f}"`).catch(() => {})
  )
  await Promise.all(loadPromises)
  await doc.fonts.ready
}

/* ------------------------------------------------------------------ */
/*  Style Manager: update font-family dropdown with discovered fonts  */
/* ------------------------------------------------------------------ */

function updateFontOptions(editor: Editor, webFonts: string[]) {
  const webFontOpts = webFonts
    .filter((f) => !isIconFont(f))
    .sort()
    .map((f) => ({ id: f, label: f }))

  const allOptions = [...webFontOpts, ...SYSTEM_FONT_OPTIONS]

  // Walk GrapesJS StyleManager sectors to find the font-family property
  try {
    const sectors = editor.StyleManager.getSectors()
    sectors.each((sector: any) => {
      const props = sector.get('properties')
      if (!props) return
      props.each((prop: any) => {
        if (prop.get('property') === 'font-family') {
          prop.set('options', allOptions)
        }
      })
    })
  } catch (_) { /* graceful fallback */ }
}

/* ------------------------------------------------------------------ */
/*  Typography icon SVGs (used in StyleManager radio labels via HTML)  */
/* ------------------------------------------------------------------ */

const ICON_ALIGN_LEFT = '<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor"><rect x="1" y="2" width="13" height="1.5" rx=".5"/><rect x="1" y="5.5" width="8" height="1.5" rx=".5"/><rect x="1" y="9" width="11" height="1.5" rx=".5"/><rect x="1" y="12.5" width="6" height="1.5" rx=".5"/></svg>'
const ICON_ALIGN_CENTER = '<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor"><rect x="1" y="2" width="13" height="1.5" rx=".5"/><rect x="3.5" y="5.5" width="8" height="1.5" rx=".5"/><rect x="2" y="9" width="11" height="1.5" rx=".5"/><rect x="4.5" y="12.5" width="6" height="1.5" rx=".5"/></svg>'
const ICON_ALIGN_RIGHT = '<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor"><rect x="1" y="2" width="13" height="1.5" rx=".5"/><rect x="6" y="5.5" width="8" height="1.5" rx=".5"/><rect x="3" y="9" width="11" height="1.5" rx=".5"/><rect x="8" y="12.5" width="6" height="1.5" rx=".5"/></svg>'
const ICON_ALIGN_JUSTIFY = '<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor"><rect x="1" y="2" width="13" height="1.5" rx=".5"/><rect x="1" y="5.5" width="13" height="1.5" rx=".5"/><rect x="1" y="9" width="13" height="1.5" rx=".5"/><rect x="1" y="12.5" width="8" height="1.5" rx=".5"/></svg>'
const ICON_UNDERLINE = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.5 2v5.5a4 4 0 008 0V2"/><line x1="2" y1="13.5" x2="13" y2="13.5"/></svg>'
const ICON_STRIKETHROUGH = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="1" y1="7.5" x2="14" y2="7.5"/><path d="M10.5 4C10 3 9 2.5 7.5 2.5S4.5 3.5 4.5 5c0 1.2.8 2 2.5 2.5m.5 0c1.7.5 3 1.3 3 2.5 0 1.5-1.5 2.5-3 2.5S4.5 12 4 11"/></svg>'

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export function initEditor(container: HTMLElement, snapshotHtml: string, options?: InitEditorOptions): Editor {
  const { bodyHtml: rawBodyHtml, cssLinks: rawCssLinks, inlineCss, bodyClass, bodyStyle, htmlStyle } = parseSnapshotHtml(snapshotHtml)
  // 1. Strip iframes, noscripts (whitespace, widgets)
  // 2. Strip responsive inline styles so CSS @media queries work
  const bodyHtml = stripBakedResponsiveStyles(stripNonContentElements(rawBodyHtml))
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

    // Do NOT load external CSS links here — the captured CSSOM (injected
    // at the beginning of <head> in the load handler) already contains all
    // rules from those stylesheets.  Loading them again via canvas.styles
    // adds them AFTER GrapesJS's internal <style> blocks, causing the
    // original CSS to override user edits (e.g. font-family changes).
    // Fonts are loaded separately by the font scanning/injection code.
    canvas: { styles: [] },
    panels: { defaults: [] },

    colorPicker: {
      appendTo: 'parent',
      showAlpha: true,
      showInput: true,
      preferredFormat: 'hex',
    },

    deviceManager: {
      devices: [
        // widthMedia: '' on Desktop/Custom prevents GrapesJS from wrapping
        // user edits in @media rules.  Without this, ALL style changes get
        // stored as @media (max-width: 1900px) and _applyInline skips them.
        { name: 'Desktop', width: '1900px', widthMedia: '' },
        { name: 'Tablet', width: '1199px', widthMedia: '1199px' },
        { name: 'Mobile', width: '767px', widthMedia: '767px' },
        { name: 'Custom', width: '1900px', widthMedia: '' }
      ]
    },

    selectorManager: { appendTo: '#selector-container' },

    styleManager: {
      appendTo: '#style-manager-container',
      sectors: [
        {
          name: 'Typography',
          open: true,
          properties: [
            {
              property: 'font-family',
              type: 'select',
              options: SYSTEM_FONT_OPTIONS, // will be updated after iframe scan
            },
            {
              property: 'font-size',
              type: 'number',
              units: ['px', 'em', 'rem', '%', 'vw'],
              min: 0,
            },
            {
              property: 'font-weight',
              type: 'select',
              defaults: '400',
              full: true,
              options: [
                { id: '100', label: 'Thin (100)' },
                { id: '200', label: 'Extra Light (200)' },
                { id: '300', label: 'Light (300)' },
                { id: '400', label: 'Regular (400)' },
                { id: '500', label: 'Medium (500)' },
                { id: '600', label: 'Semi Bold (600)' },
                { id: '700', label: 'Bold (700)' },
                { id: '800', label: 'Extra Bold (800)' },
                { id: '900', label: 'Black (900)' },
              ]
            },
            'letter-spacing',
            'line-height',
            'color',
            {
              property: 'text-align',
              type: 'radio',
              defaults: 'left',
              full: true,
              options: [
                { id: 'left', label: ICON_ALIGN_LEFT },
                { id: 'center', label: ICON_ALIGN_CENTER },
                { id: 'right', label: ICON_ALIGN_RIGHT },
                { id: 'justify', label: ICON_ALIGN_JUSTIFY },
              ]
            },
            {
              property: 'text-decoration',
              type: 'radio',
              defaults: 'none',
              full: true,
              options: [
                { id: 'none', label: '—' },
                { id: 'underline', label: ICON_UNDERLINE },
                { id: 'line-through', label: ICON_STRIKETHROUGH },
              ]
            },
            {
              property: 'text-transform',
              type: 'radio',
              defaults: 'none',
              full: true,
              options: [
                { id: 'none', label: '—' },
                { id: 'uppercase', label: 'AA' },
                { id: 'lowercase', label: 'aa' },
                { id: 'capitalize', label: 'Aa' },
              ]
            },
            {
              property: 'text-indent',
              type: 'number',
              units: ['px', 'em', 'rem', '%'],
              defaults: '0',
            },
            {
              property: 'word-spacing',
              type: 'number',
              units: ['px', 'em', 'rem'],
              defaults: 'normal',
            },
          ]
        },
        {
          name: 'Spacing',
          open: true,
          properties: [
            'margin', 'padding',
            { property: 'gap', type: 'number', units: ['px', 'em', 'rem', '%'], defaults: '0', min: 0 }
          ]
        },
        {
          name: 'Size',
          open: true,
          properties: ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height']
        },
        {
          name: 'Appearance',
          open: false,
          properties: ['background-color', 'border', 'border-radius', 'box-shadow', 'opacity']
        }
      ]
    },

    layerManager: { appendTo: '#layers-container' }
  })

  // ── After load: inject CSS, enable resize, discover + load fonts ──
  editor.on('load', () => {
    const doc = editor.Canvas.getDocument()

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

      if (bodyClass) {
        doc.body.className = bodyClass
      }
      // WordPress resets body margin to 0; browser default is 8px
      doc.body.style.margin = '0'
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

    // ── Strip baked inline styles that break responsive CSS ──
    // Safety net: also strip from the live DOM in case GrapesJS re-adds
    // any responsive-toggle properties during rendering.
    if (doc) {
      doc.querySelectorAll('*').forEach((el: Element) => {
        const htmlEl = el as HTMLElement
        if (!htmlEl.style) return
        let changed = false
        for (const prop of RESPONSIVE_PROPS) {
          if (htmlEl.style.getPropertyValue(prop)) {
            htmlEl.style.removeProperty(prop)
            changed = true
          }
        }
        if (changed && htmlEl.getAttribute('style')?.trim() === '') {
          htmlEl.removeAttribute('style')
        }
      })
    }

    const enableResize = (component: ReturnType<typeof editor.getWrapper>) => {
      if (!component) return
      component.set('resizable', true)
      component.components().each((child) => enableResize(child))
    }
    enableResize(editor.getWrapper())

    // ── Scan iframe computed styles for ALL fonts (catches external CSS) ──
    if (doc) {
      const run = async () => {
        // Wait for external stylesheets to load in the iframe
        await new Promise((r) => setTimeout(r, 1500))

        // Scan computed styles — catches fonts from <link> stylesheets too
        const allFonts = scanDocumentFonts(doc)
        const textFonts = [...allFonts].filter((f) => !isIconFont(f))
        const iconFonts = [...allFonts].filter((f) => isIconFont(f))

        // Update the font-family dropdown with all discovered fonts
        updateFontOptions(editor, [...allFonts])

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

    console.log('[GJS] component:selected sync', {
      tag: el.tagName,
      classes: el.className?.toString?.()?.slice(0, 60),
      syncedProps: Object.keys(newStyles),
      fontFamily: newStyles['font-family'] || '(not synced)',
      ruleFont: ruleStyles['font-family'] || '(none)',
      compFont: currentStyles['font-family'] || '(none)',
    })

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

    console.log('[GJS] _applyInline', {
      tag: el.tagName,
      classes: el.className?.toString?.()?.slice(0, 60),
      allStylesFont: allStyles['font-family'] || '(none)',
      compFont: compStyles['font-family'] || '(none)',
      syncedFont: synced['font-family'] || '(none)',
      compFontMatchesSynced: compStyles['font-family'] === synced['font-family'],
      allStyleKeys: Object.keys(allStyles).filter(k => allStyles[k]).slice(0, 15),
    })

    const prev = _gjsApplied.get(el) || new Set<string>()
    const current = new Set<string>()

    for (const [prop, val] of Object.entries(allStyles)) {
      if (val == null || !String(val).trim()) continue
      const strVal = String(val)
      // Skip synced defaults — only apply !important for actual changes
      if (synced[prop] === strVal) continue
      if (prop === 'font-family') {
        console.log('[GJS] APPLYING font-family !important:', strVal, '| synced was:', synced[prop])
      }
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

  editor.on('component:styleUpdate', (comp: any) => {
    console.log('[GJS] component:styleUpdate fired', {
      tag: comp?.getEl?.()?.tagName,
      compFont: comp?.getStyle?.()?.['font-family'] || '(none)',
    })
    _applyInline(comp)
  })

  // Also listen for CSS rule additions/changes (class-based style targets)
  editor.CssComposer.getAll().on('add change', () => {
    const sel = editor.getSelected()
    if (sel) {
      // Log all CssComposer rules that have font-family
      editor.CssComposer.getAll().each((rule: any) => {
        const style = rule.getStyle() || {}
        if (style['font-family']) {
          console.log('[GJS] CssComposer rule with font-family:', {
            selector: rule.selectorsToString(),
            fontFamily: style['font-family'],
            mediaText: rule.get('mediaText') || '(none)',
          })
        }
      })
      _applyInline(sel)
    }
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
