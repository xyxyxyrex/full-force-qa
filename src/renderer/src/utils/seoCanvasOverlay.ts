import type { Editor } from 'grapesjs'

/**
 * Precision highlights duplicate text elements (headings and content paragraphs)
 * directly on the GrapesJS iframe canvas with a subtle red border and [Duplicate] badge.
 * Excludes structural container divs, nav menus, headers, and footers.
 */
export function toggleCanvasDuplicates(editor: Editor | null, enable: boolean): number {
  if (!editor) return 0

  try {
    const doc = editor.Canvas.getDocument()
    if (!doc || !doc.body) return 0

    // 1. Remove any existing duplicate badges and highlights first
    doc.querySelectorAll('.seo-duplicate-badge').forEach((el) => el.remove())
    doc.querySelectorAll('.seo-duplicate-highlight').forEach((el) => {
      el.classList.remove('seo-duplicate-highlight')
    })

    if (!enable) return 0

    // 2. Inject clean CSS styles into iframe head if not already present
    if (!doc.getElementById('seo-audit-canvas-styles')) {
      const styleEl = doc.createElement('style')
      styleEl.id = 'seo-audit-canvas-styles'
      styleEl.textContent = `
        .seo-duplicate-highlight {
          position: relative !important;
          background-color: rgba(239, 68, 68, 0.12) !important;
          outline: 1.5px solid #ef4444 !important;
          outline-offset: 1px !important;
        }

        .seo-duplicate-badge {
          display: inline-block !important;
          font-size: 10px !important;
          font-weight: 700 !important;
          line-height: 1 !important;
          color: #ef4444 !important;
          background: #ffffff !important;
          border: 1px solid #ef4444 !important;
          border-radius: 3px !important;
          padding: 2px 4px !important;
          margin-left: 6px !important;
          vertical-align: middle !important;
          letter-spacing: 0 !important;
          text-transform: none !important;
          box-shadow: 0 1px 3px rgba(0,0,0,0.15) !important;
          user-select: none !important;
          pointer-events: none !important;
          z-index: 9999 !important;
        }
      `
      doc.head.appendChild(styleEl)
    }

    // 3. Query ONLY actual content elements (headings, paragraphs, leaf titles)
    // EXCLUDE structural container divs, section wrappers, nav, header, footer
    const rawCandidates = Array.from(
      doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, .elementor-heading-title, .entry-title')
    )

    // Filter out candidates inside nav, header, footer, or containers
    const candidates = rawCandidates.filter((el) => {
      const htmlEl = el as HTMLElement
      // Skip if inside nav, header, footer
      if (htmlEl.closest('nav, header, footer, .menu, .nav, .widget_nav_menu')) return false
      // Skip if contains nested block elements
      if (htmlEl.querySelector('div, section, p, h1, h2, h3, h4, h5, h6')) return false

      const text = (htmlEl.textContent || '').trim()
      // Ignore short texts (e.g. "Read More", "Learn More", "Click Here")
      return text.length >= 12
    })

    const textMap = new Map<string, HTMLElement[]>()

    candidates.forEach((el) => {
      const htmlEl = el as HTMLElement
      const text = (htmlEl.textContent || '').trim()
      const normalized = text.toLowerCase().replace(/\s+/g, ' ')

      const list = textMap.get(normalized) || []
      list.push(htmlEl)
      textMap.set(normalized, list)
    })

    let totalDuplicates = 0

    textMap.forEach((els) => {
      // ONLY highlight if text appears multiple times in distinct content elements
      if (els.length > 1) {
        totalDuplicates += els.length
        els.forEach((el) => {
          el.classList.add('seo-duplicate-highlight')

          // Append [Duplicate] badge if not present
          if (!el.querySelector('.seo-duplicate-badge')) {
            const badge = doc.createElement('span')
            badge.className = 'seo-duplicate-badge'
            badge.textContent = '[Duplicate]'
            el.appendChild(badge)
          }
        })
      }
    })

    return totalDuplicates
  } catch (err) {
    console.warn('[seoCanvasOverlay] Error toggling canvas duplicate highlights:', err)
    return 0
  }
}
