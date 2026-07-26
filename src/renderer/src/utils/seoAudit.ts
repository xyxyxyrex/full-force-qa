export type IssueSeverity = 'error' | 'warning' | 'pass' | 'info'

export interface AuditItemDetail {
  label: string
  value: string
  sub?: string
  elementSnippet?: string
  status?: 'ok' | 'fail' | 'warn'
}

export interface AuditItem {
  id: string
  category: 'meta' | 'headings' | 'images' | 'links' | 'schema' | 'content'
  title: string
  description: string
  severity: IssueSeverity
  recommendation: string
  details?: {
    value?: string
    count?: number
    items?: AuditItemDetail[]
  }
}

export interface ImageAuditInfo {
  src: string
  alt: string | null
  fileName: string
  hasAlt: boolean
  isDecorative: boolean
}

export interface LinkAuditInfo {
  url: string
  anchorText: string
  isDoFollow: boolean
  isExternal: boolean
}

export interface HeaderAuditInfo {
  tag: string // 'H1', 'H2', 'H3', etc.
  text: string
  level: number
}

export interface AssetAuditInfo {
  internalJs: string[]
  externalJs: string[]
  internalCss: string[]
  externalCss: string[]
}

export interface DuplicateItemInfo {
  text: string
  count: number
  tag: string
}

export interface SeoAuditReport {
  score: number // 0 - 100
  passedCount: number
  warningCount: number
  errorCount: number
  infoCount: number
  categories: {
    meta: AuditItem[]
    headings: AuditItem[]
    images: AuditItem[]
    links: AuditItem[]
    schema: AuditItem[]
    content: AuditItem[]
  }
  metaData: {
    title: string
    description: string
    keywords: string
    canonical: string
    ogTitle: string
    ogDescription: string
    ogImage: string
    twitterCard: string
    wordCount: number
    h1Count: number
    missingAltCount: number
    totalImages: number
  }
  headersList: HeaderAuditInfo[]
  imagesList: ImageAuditInfo[]
  linksList: LinkAuditInfo[]
  assets: AssetAuditInfo
  duplicatesList: DuplicateItemInfo[]
}

/**
 * Runs a comprehensive On-Page SEO Audit against raw snapshot HTML and source URL.
 */
export function runSeoAudit(htmlString: string, sourceUrl: string): SeoAuditReport {
  const parser = new DOMParser()
  const doc = parser.parseFromString(htmlString, 'text/html')
  let origin = ''
  try {
    origin = new URL(sourceUrl).origin
  } catch {
    origin = ''
  }

  const metaItems: AuditItem[] = []
  const headingItems: AuditItem[] = []
  const imageItems: AuditItem[] = []
  const linkItems: AuditItem[] = []
  const schemaItems: AuditItem[] = []
  const contentItems: AuditItem[] = []

  // Helper getters
  const getMeta = (nameOrProp: string): string => {
    const el =
      doc.querySelector(`meta[name="${nameOrProp}"]`) ||
      doc.querySelector(`meta[property="${nameOrProp}"]`) ||
      doc.querySelector(`meta[name="${nameOrProp.toLowerCase()}"]`) ||
      doc.querySelector(`meta[property="${nameOrProp.toLowerCase()}"]`)
    return el ? (el.getAttribute('content') || '').trim() : ''
  }

  /* ------------------------------------------------------------------ */
  /* 1. Meta Tags & Indexability                                        */
  /* ------------------------------------------------------------------ */

  const titleEl = doc.querySelector('title')
  const titleText = titleEl ? (titleEl.textContent || '').trim() : ''
  const metaDesc = getMeta('description')
  const metaKeywords = getMeta('keywords')
  const canonicalEl = doc.querySelector('link[rel="canonical"]')
  const canonicalHref = canonicalEl ? (canonicalEl.getAttribute('href') || '').trim() : ''
  const ogTitle = getMeta('og:title')
  const ogDesc = getMeta('og:description')
  const ogImage = getMeta('og:image')
  const twitterCard = getMeta('twitter:card')

  if (!titleText) {
    metaItems.push({
      id: 'meta-title-missing',
      category: 'meta',
      title: 'Title Tag is Missing or Empty',
      description: 'The page lacks a <title> element, which is vital for search engine rankings and snippet headlines.',
      severity: 'error',
      recommendation: 'Add a descriptive <title> tag between 50 and 60 characters containing your primary keyword.',
      details: { value: 'None' }
    })
  } else if (titleText.length < 30) {
    metaItems.push({
      id: 'meta-title-short',
      category: 'meta',
      title: 'Title Tag is Too Short',
      description: `Title tag is ${titleText.length} characters long. Short titles waste valuable SERP keyword opportunity.`,
      severity: 'warning',
      recommendation: 'Expand title to 50–60 characters to include relevant target keywords.',
      details: { value: titleText }
    })
  } else if (titleText.length > 60) {
    metaItems.push({
      id: 'meta-title-long',
      category: 'meta',
      title: 'Title Tag May Be Truncated',
      description: `Title tag is ${titleText.length} characters long. Google typically truncates titles over 60 characters in search results.`,
      severity: 'warning',
      recommendation: 'Keep title tag within 50–60 characters to avoid SERP truncation.',
      details: { value: titleText }
    })
  } else {
    metaItems.push({
      id: 'meta-title-optimal',
      category: 'meta',
      title: 'Title Tag Length is Optimal',
      description: `Title tag length (${titleText.length} characters) is within the recommended 50–60 character range.`,
      severity: 'pass',
      recommendation: 'Good job! Keep monitoring target keyword performance.',
      details: { value: titleText }
    })
  }

  if (!metaDesc) {
    metaItems.push({
      id: 'meta-desc-missing',
      category: 'meta',
      title: 'Meta Description is Missing',
      description: 'No meta description found. Search engines will generate an automatic snippet which may reduce CTR.',
      severity: 'error',
      recommendation: 'Add a meta description tag between 120 and 155 characters summarizing page content.',
      details: { value: 'None' }
    })
  } else if (metaDesc.length < 70) {
    metaItems.push({
      id: 'meta-desc-short',
      category: 'meta',
      title: 'Meta Description is Short',
      description: `Meta description is ${metaDesc.length} characters. Expand it to better explain page value and encourage clicks.`,
      severity: 'warning',
      recommendation: 'Aim for 120–155 characters to maximize search engine snippet real estate.',
      details: { value: metaDesc }
    })
  } else if (metaDesc.length > 160) {
    metaItems.push({
      id: 'meta-desc-long',
      category: 'meta',
      title: 'Meta Description May Be Truncated',
      description: `Meta description is ${metaDesc.length} characters. Snippets over 155–160 characters get truncated on desktop/mobile.`,
      severity: 'warning',
      recommendation: 'Trim meta description to 120–155 characters.',
      details: { value: metaDesc }
    })
  } else {
    metaItems.push({
      id: 'meta-desc-optimal',
      category: 'meta',
      title: 'Meta Description Length is Optimal',
      description: `Meta description is ${metaDesc.length} characters long, fitting well within SERP limits.`,
      severity: 'pass',
      recommendation: 'Ensure your call-to-action remains clear.',
      details: { value: metaDesc }
    })
  }

  /* ------------------------------------------------------------------ */
  /* 2. Heading Hierarchy Audit & Header List                           */
  /* ------------------------------------------------------------------ */

  const h1Els = Array.from(doc.querySelectorAll('h1'))
  const allHeadings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))

  const headersList: HeaderAuditInfo[] = allHeadings.map((h) => ({
    tag: h.tagName.toUpperCase(),
    text: (h.textContent || '').trim(),
    level: parseInt(h.tagName.substring(1), 10)
  }))

  if (h1Els.length === 0) {
    headingItems.push({
      id: 'heading-h1-missing',
      category: 'headings',
      title: 'Missing <h1> Heading',
      description: 'The page has no <h1> heading. An <h1> heading is crucial for establishing the main topic of the page.',
      severity: 'error',
      recommendation: 'Add exactly one <h1> heading near the top of your main content area.',
      details: { count: 0 }
    })
  } else if (h1Els.length > 1) {
    headingItems.push({
      id: 'heading-h1-multiple',
      category: 'headings',
      title: `Multiple <h1> Headings Found (${h1Els.length})`,
      description: 'Multiple <h1> tags can dilute heading structure hierarchy and keyword signals.',
      severity: 'warning',
      recommendation: 'Use a single <h1> heading per page, and structure sub-topics using <h2> and <h3> tags.',
      details: {
        count: h1Els.length,
        items: h1Els.map((h, i) => ({
          label: `H1 #${i + 1}`,
          value: (h.textContent || '').trim() || '(Empty H1)',
          elementSnippet: h.outerHTML.slice(0, 100)
        }))
      }
    })
  } else {
    headingItems.push({
      id: 'heading-h1-ok',
      category: 'headings',
      title: 'Single <h1> Heading Verified',
      description: `Single <h1> heading found: "${(h1Els[0].textContent || '').trim()}"`,
      severity: 'pass',
      recommendation: 'Ensure your H1 matches the primary search intent.',
      details: {
        value: (h1Els[0].textContent || '').trim()
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* 3. Image & Asset Audit List                                        */
  /* ------------------------------------------------------------------ */

  const imgEls = Array.from(doc.querySelectorAll('img'))
  const missingAltImgs: AuditItemDetail[] = []
  const imagesList: ImageAuditInfo[] = []

  imgEls.forEach((img, idx) => {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || ''
    const alt = img.getAttribute('alt')
    const fileName = src.split('/').pop()?.split('?')[0] || `Image #${idx + 1}`

    const hasAlt = alt !== null && alt.trim().length > 0
    const isDecorative = alt === ''

    imagesList.push({
      src,
      alt,
      fileName,
      hasAlt,
      isDecorative
    })

    if (alt === null) {
      missingAltImgs.push({
        label: fileName,
        value: src.slice(0, 80),
        sub: 'Missing alt attribute entirely',
        elementSnippet: img.outerHTML.slice(0, 120),
        status: 'fail'
      })
    }
  })

  if (missingAltImgs.length > 0) {
    imageItems.push({
      id: 'img-alt-missing',
      category: 'images',
      title: `Images Missing ALT Attributes (${missingAltImgs.length})`,
      description: `${missingAltImgs.length} out of ${imgEls.length} images lack alt attributes entirely. ALT text is essential for web accessibility and image search ranking.`,
      severity: 'error',
      recommendation: 'Add descriptive alt text to all informative images. For purely decorative images, use alt="".',
      details: { count: missingAltImgs.length, items: missingAltImgs }
    })
  } else if (imgEls.length > 0) {
    imageItems.push({
      id: 'img-alt-pass',
      category: 'images',
      title: 'All Images Have ALT Attributes',
      description: `All ${imgEls.length} images contain alt attributes.`,
      severity: 'pass',
      recommendation: 'Maintain descriptive alt text coverage.'
    })
  }

  /* ------------------------------------------------------------------ */
  /* 4. Links & Anchors Audit List                                      */
  /* ------------------------------------------------------------------ */

  const aEls = Array.from(doc.querySelectorAll('a'))
  const linksList: LinkAuditInfo[] = []

  aEls.forEach((a) => {
    const href = (a.getAttribute('href') || '').trim()
    const text = (a.textContent || '').trim()
    const rel = (a.getAttribute('rel') || '').toLowerCase()

    const isDoFollow = !rel.includes('nofollow')
    let isExternal = false

    try {
      if (href.startsWith('http://') || href.startsWith('https://')) {
        const u = new URL(href)
        if (origin && u.origin !== origin) {
          isExternal = true
        }
      }
    } catch {
      /* relative link */
    }

    linksList.push({
      url: href,
      anchorText: text,
      isDoFollow,
      isExternal
    })
  })

  /* ------------------------------------------------------------------ */
  /* 5. Assets Audit (Internal/External JS & CSS)                      */
  /* ------------------------------------------------------------------ */

  const internalJsSet = new Set<string>()
  const externalJsSet = new Set<string>()
  const internalCssSet = new Set<string>()
  const externalCssSet = new Set<string>()

  // Helper to normalize and categorize asset URLs
  const addAssetUrl = (urlStr: string, isJs: boolean) => {
    let raw = urlStr.trim().replace(/&amp;/g, '&')
    // Clean trailing quotes, semicolons, brackets
    raw = raw.replace(/['";,\\\)\}]*$/, '').replace(/^['";,\\\(\{]*/, '')
    if (!raw) return
    if (raw.startsWith('//')) {
      raw = 'https:' + raw
    }

    try {
      const u = new URL(raw, origin || 'https://localhost')
      if (!u.hostname || !u.hostname.includes('.')) return
      const hostOrigin = origin ? new URL(origin).hostname : ''
      const isInternal = hostOrigin ? (u.hostname === hostOrigin || u.hostname.endsWith('.' + hostOrigin)) : true
      const fullUrl = u.href

      if (isJs) {
        if (isInternal) internalJsSet.add(fullUrl)
        else externalJsSet.add(fullUrl)
      } else {
        if (isInternal) internalCssSet.add(fullUrl)
        else externalCssSet.add(fullUrl)
      }
    } catch {
      /* ignore invalid URLs */
    }
  }

  // A) Extract from snapshot-network-js meta tag (captured network JS traffic from Electron)
  const metaNetJs = doc.querySelector('meta[name="snapshot-network-js"]')
  if (metaNetJs) {
    const content = metaNetJs.getAttribute('content') || ''
    content.split('|||').forEach((url) => addAssetUrl(url, true))
  }

  // B) Extract from snapshot-network-css meta tag (captured network CSS traffic from Electron)
  const metaNetCss = doc.querySelector('meta[name="snapshot-network-css"]')
  if (metaNetCss) {
    const content = metaNetCss.getAttribute('content') || ''
    content.split('|||').forEach((url) => addAssetUrl(url, false))
  }

  // C) Extract from snapshot-all-scripts meta tag (from Electron capture containing 100% of page scripts)
  const metaAllScripts = doc.querySelector('meta[name="snapshot-all-scripts"]')
  if (metaAllScripts) {
    const content = metaAllScripts.getAttribute('content') || ''
    content.split('|||').forEach((url) => addAssetUrl(url, true))
  }

  // D) Extract from snapshot-preserved-scripts meta tag (from Electron capture)
  const metaPreserved = doc.querySelector('meta[name="snapshot-preserved-scripts"]')
  if (metaPreserved) {
    const content = metaPreserved.getAttribute('content') || ''
    content.split('|||').forEach((url) => addAssetUrl(url, true))
  }

  // E) Extract from all <script src="..."> elements in DOM
  doc.querySelectorAll('script[src]').forEach((s) => {
    const src = s.getAttribute('src')
    if (src) addAssetUrl(src, true)
  })

  // F) Regex match all <script ... src="..."> from raw HTML string
  const scriptRegex = /<script[^>]+?src=["']([^"']+)["']/gi
  let sm: RegExpExecArray | null
  while ((sm = scriptRegex.exec(htmlString)) !== null) {
    if (sm[1]) addAssetUrl(sm[1], true)
  }

  // G) Regex match inline & embedded script URLs (gtag/js, gtm.js, analytics.js, tidio, recaptcha, doubleclick, etc.)
  const externalScriptRegex = /https?:\/\/[^\s"'<>\(\)]+?(?:gtag\/js|gtm\.js|analytics\.js|recaptcha|viewthroughconversion|tidio|\.js)(?:\?[^\s"'<>\(\)]*)?/gi
  let im: RegExpExecArray | null
  while ((im = externalScriptRegex.exec(htmlString)) !== null) {
    if (im[0]) addAssetUrl(im[0], true)
  }

  // F) Extract from all <link rel="stylesheet"> elements in DOM
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
    const href = l.getAttribute('href')
    if (href) addAssetUrl(href, false)
  })

  // G) Regex match all <link ... href="..."> from raw HTML string
  const linkCssRegex = /<link[^>]+?href=["']([^"']+)["'][^>]*?>/gi
  let lm: RegExpExecArray | null
  while ((lm = linkCssRegex.exec(htmlString)) !== null) {
    if (/rel=["']stylesheet["']/i.test(lm[0]) && lm[1]) {
      addAssetUrl(lm[1], false)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 6. Score Calculation                                               */
  /* ------------------------------------------------------------------ */
  /* 6. Duplicate Content Scan                                          */
  /* ------------------------------------------------------------------ */

  const textCountMap = new Map<string, { count: number; tag: string; originalText: string }>()
  const rawContentEls = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, .elementor-heading-title, .entry-title'))

  const contentEls = rawContentEls.filter((el) => {
    const htmlEl = el as HTMLElement
    if (htmlEl.closest('nav, header, footer, .menu, .nav, .widget_nav_menu')) return false
    if (htmlEl.querySelector('div, section, p, h1, h2, h3, h4, h5, h6')) return false
    const txt = (htmlEl.textContent || '').trim()
    return txt.length >= 12
  })

  contentEls.forEach((el) => {
    const txt = (el.textContent || '').trim()
    const normalized = txt.toLowerCase().replace(/\s+/g, ' ')
    const existing = textCountMap.get(normalized)
    if (existing) {
      existing.count++
    } else {
      textCountMap.set(normalized, {
        count: 1,
        tag: el.tagName.toUpperCase(),
        originalText: txt
      })
    }
  })

  const duplicatesList: DuplicateItemInfo[] = []
  textCountMap.forEach((val) => {
    if (val.count > 1) {
      duplicatesList.push({
        text: val.originalText,
        count: val.count,
        tag: val.tag
      })
    }
  })

  /* ------------------------------------------------------------------ */
  /* 7. Score Calculation & Return                                      */
  /* ------------------------------------------------------------------ */

  const allItems = [...metaItems, ...headingItems, ...imageItems, ...linkItems, ...schemaItems, ...contentItems]

  let errors = 0
  let warnings = 0
  let passes = 0
  let infos = 0

  allItems.forEach((item) => {
    if (item.severity === 'error') errors++
    else if (item.severity === 'warning') warnings++
    else if (item.severity === 'pass') passes++
    else if (item.severity === 'info') infos++
  })

  const rawScore = 100 - errors * 12 - warnings * 4
  const score = Math.max(0, Math.min(100, rawScore))

  return {
    score,
    passedCount: passes,
    warningCount: warnings,
    errorCount: errors,
    infoCount: infos,
    categories: {
      meta: metaItems,
      headings: headingItems,
      images: imageItems,
      links: linkItems,
      schema: schemaItems,
      content: contentItems
    },
    metaData: {
      title: titleText,
      description: metaDesc,
      keywords: metaKeywords,
      canonical: canonicalHref,
      ogTitle,
      ogDescription: ogDesc,
      ogImage,
      twitterCard,
      wordCount: (doc.body ? doc.body.textContent || '' : '').split(/\s+/).filter(Boolean).length,
      h1Count: h1Els.length,
      missingAltCount: missingAltImgs.length,
      totalImages: imgEls.length
    },
    headersList,
    imagesList,
    linksList,
    assets: {
      internalJs: Array.from(internalJsSet),
      externalJs: Array.from(externalJsSet),
      internalCss: Array.from(internalCssSet),
      externalCss: Array.from(externalCssSet)
    },
    duplicatesList
  }
}
