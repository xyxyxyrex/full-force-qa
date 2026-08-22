import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { runSeoAudit, type SeoAuditReport } from '../utils/seoAudit'
import {
  applyIssueSuggestion,
  grammarAuditContentSignature,
  issueDomRange,
  locateIssueElement,
  runGrammarSpellAuditAsync,
  type GrammarSpellReport,
  type TextIssue
} from '../utils/grammarSpellAudit'
import type { Editor } from 'grapesjs'
import { auditOverlayGeometry } from '../utils/auditOverlayScale'
import { auditOverlayModeLabel, nextAuditOverlayMode, type AuditOverlayMode } from '../utils/auditOverlayMode'
import {
  AUDIT_MEDIA_SELECTOR,
  auditMediaResourceUrl,
  auditMediaTypeLabel,
  dataUrlByteLength,
  formatAuditResourceSize
} from '../utils/auditResourceSize'
import './SeoAuditRightPanel.css'

interface Props {
  html: string
  sourceUrl: string
  editor: Editor | null
  selectedComponent: any
  canvasZoom: number
  iframeRef?: React.RefObject<HTMLIFrameElement>
  onDocumentChange?: (doc: Document, description: string) => void
}

type SectorKey = 'grammarSpell' | 'selected' | 'meta' | 'headers' | 'images' | 'links' | 'duplicates' | 'assets'
type AuditOverlayKey = 'showLinks' | 'showAltText' | 'showHrefs' | 'showHeadings' | 'showGrammarSpell' | 'showFileSizes'

export default function SeoAuditRightPanel({
  html,
  sourceUrl,
  editor,
  selectedComponent,
  canvasZoom,
  iframeRef,
  onDocumentChange
}: Props) {
  const [openSectors, setOpenSectors] = useState<Record<SectorKey, boolean>>({
    grammarSpell: true,
    selected: true,
    meta: true,
    headers: true,
    images: true,
    links: false,
    duplicates: true,
    assets: false
  })

  const [copied, setCopied] = useState(false)
  const [grammarFilter, setGrammarFilter] = useState<'all' | 'spelling' | 'grammar'>('all')
  const auditRequestRef = useRef(0)
  const auditSignatureRef = useRef('')
  const [grammarScanStatus, setGrammarScanStatus] = useState<'idle' | 'scanning' | 'ready' | 'error'>('idle')
  const [grammarScanError, setGrammarScanError] = useState('')
  const [ignoredIssueKeys, setIgnoredIssueKeys] = useState<Set<string>>(() => new Set())

  const [auditOverlays, setAuditOverlays] = useState<Record<AuditOverlayKey, AuditOverlayMode>>({
    showLinks: 'off',
    showAltText: 'off',
    showHrefs: 'off',
    showHeadings: 'off',
    showGrammarSpell: 'off',
    showFileSizes: 'off'
  })
  const clickedOverlayElementsRef = useRef<Record<AuditOverlayKey, Set<Element>>>({
    showLinks: new Set(), showAltText: new Set(), showHrefs: new Set(),
    showHeadings: new Set(), showGrammarSpell: new Set(), showFileSizes: new Set()
  })
  const hoveredOverlayElementsRef = useRef<Record<AuditOverlayKey, Element | null>>({
    showLinks: null, showAltText: null, showHrefs: null,
    showHeadings: null, showGrammarSpell: null, showFileSizes: null
  })
  const [resourceFileSizes, setResourceFileSizes] = useState<Record<string, number | null>>({})
  const resourceSizeRequestRef = useRef(0)

  const toggleOverlay = (key: AuditOverlayKey) => {
    setAuditOverlays((prev) => {
      const next = nextAuditOverlayMode(prev[key])
      if (next === 'off') {
        clickedOverlayElementsRef.current[key].clear()
        hoveredOverlayElementsRef.current[key] = null
      }
      return { ...prev, [key]: next }
    })
  }
  const overlayButtonClass = (key: AuditOverlayKey) => {
    const mode = auditOverlays[key]
    return `seo-overlay-btn mode-${mode} ${mode !== 'off' ? 'active' : ''}`
  }
  const overlayButtonTitle = (key: AuditOverlayKey, name: string) => {
    const mode = auditOverlays[key]
    return `${name}: ${auditOverlayModeLabel(mode)}. Next: ${auditOverlayModeLabel(nextAuditOverlayMode(mode))}`
  }
  const overlayModeBadge = (key: AuditOverlayKey) => {
    const mode = auditOverlays[key]
    if (mode === 'off') return null
    return <span className="seo-overlay-mode-badge" aria-hidden="true">{mode === 'hover' ? 'H' : mode === 'click' ? 'C' : 'A'}</span>
  }

  // Calculate SEO audit report
  const report: SeoAuditReport = useMemo(() => {
    return runSeoAudit(html, sourceUrl)
  }, [html, sourceUrl])

  const getIframeDoc = useCallback((): Document | null => {
    if (iframeRef?.current?.contentDocument?.body) {
      return iframeRef.current.contentDocument
    }
    if (editor && typeof editor.Canvas?.getDocument === 'function') {
      try {
        const doc = editor.Canvas.getDocument()
        if (doc && doc.body) return doc
      } catch {
        // The editor can be torn down while React is switching projects.
        // Fall through to the native iframe/raw HTML sources below.
      }
    }
    const gjsIframe = document.querySelector('iframe.gjs-frame') as HTMLIFrameElement
    if (gjsIframe?.contentDocument?.body) {
      return gjsIframe.contentDocument
    }
    return null
  }, [editor, iframeRef])

  useEffect(() => {
    if (auditOverlays.showFileSizes === 'off') return
    const requestId = ++resourceSizeRequestRef.current
    const iframe = iframeRef?.current

    const inspectResources = async () => {
      const targetDoc = getIframeDoc()
      if (!targetDoc?.body) return
      const targets = Array.from(targetDoc.querySelectorAll(AUDIT_MEDIA_SELECTOR))
      const urls = Array.from(new Set(targets.map(auditMediaResourceUrl).filter(Boolean)))
      const measured: Record<string, number | null> = {}
      const remoteUrls: string[] = []

      for (const url of urls) {
        const inlineSize = dataUrlByteLength(url)
        if (inlineSize != null) {
          measured[url] = inlineSize
          continue
        }
        try {
          const entries = targetDoc.defaultView?.performance.getEntriesByName(url) || []
          const entry = entries[entries.length - 1] as PerformanceResourceTiming | undefined
          const timingSize = Number(entry?.encodedBodySize || entry?.transferSize || 0)
          if (timingSize > 0) {
            measured[url] = timingSize
            continue
          }
        } catch {}
        remoteUrls.push(url)
      }

      if (requestId !== resourceSizeRequestRef.current) return
      setResourceFileSizes(measured)
      if (remoteUrls.length === 0 || typeof window.electronAPI?.getResourceFileSizes !== 'function') return

      try {
        const results = await window.electronAPI.getResourceFileSizes(remoteUrls, sourceUrl)
        if (requestId !== resourceSizeRequestRef.current) return
        setResourceFileSizes((current) => {
          const next = { ...current }
          results.forEach((result) => { next[result.url] = result.sizeBytes })
          return next
        })
      } catch {
        if (requestId !== resourceSizeRequestRef.current) return
        setResourceFileSizes((current) => {
          const next = { ...current }
          remoteUrls.forEach((url) => { if (!(url in next)) next[url] = null })
          return next
        })
      }
    }

    const timer = window.setTimeout(() => void inspectResources(), 50)
    const handleLoad = () => void inspectResources()
    iframe?.addEventListener('load', handleLoad)
    return () => {
      window.clearTimeout(timer)
      iframe?.removeEventListener('load', handleLoad)
      resourceSizeRequestRef.current += 1
    }
  }, [auditOverlays.showFileSizes, getIframeDoc, iframeRef, sourceUrl])

  const [grammarReport, setGrammarReport] = useState<GrammarSpellReport>({
    totalIssues: 0,
    spellingCount: 0,
    grammarCount: 0,
    issues: [],
    scannedElements: 0,
    engines: { harper: false, spellingFallback: false, warnings: [] }
  })

  const issueKey = useCallback((issue: TextIssue) =>
    `${issue.elementPath}:${issue.start}:${issue.end}:${issue.ruleId || issue.type}:${issue.wordOrPhrase}`, [])

  const runAuditScan = useCallback(async (force = false) => {
    const targetDoc = getIframeDoc()
    const content = targetDoc || html
    const signature = grammarAuditContentSignature(content)
    if (!force && signature === auditSignatureRef.current) return
    auditSignatureRef.current = signature
    const requestId = ++auditRequestRef.current
    setGrammarScanStatus('scanning')
    setGrammarScanError('')
    try {
      const result = await runGrammarSpellAuditAsync(content)
      if (requestId !== auditRequestRef.current) return
      setGrammarReport(result)
      const fatalWarning = !result.engines?.harper && !result.engines?.spellingFallback
        ? result.engines?.warnings?.[0] || 'No grammar or spelling engine could be initialized.'
        : ''
      setGrammarScanError(fatalWarning)
      setGrammarScanStatus(fatalWarning ? 'error' : 'ready')
    } catch (error) {
      if (requestId !== auditRequestRef.current) return
      auditSignatureRef.current = ''
      setGrammarScanError(error instanceof Error ? error.message : 'The page could not be scanned.')
      setGrammarScanStatus('error')
    }
  }, [html, getIframeDoc])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void runAuditScan(true), 150)
    const changeTimer = window.setInterval(() => void runAuditScan(false), 1500)
    const iframe = iframeRef?.current
    const handleLoad = () => void runAuditScan(true)
    iframe?.addEventListener('load', handleLoad)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(changeTimer)
      iframe?.removeEventListener('load', handleLoad)
      auditRequestRef.current += 1
    }
  }, [iframeRef, runAuditScan])

  const visibleGrammarIssues = useMemo(
    () => grammarReport.issues.filter((issue) => !ignoredIssueKeys.has(issueKey(issue))),
    [grammarReport.issues, ignoredIssueKeys, issueKey]
  )
  const grammarCounts = useMemo(() => ({
    total: visibleGrammarIssues.length,
    spelling: visibleGrammarIssues.filter((issue) => issue.type === 'spelling').length,
    grammar: visibleGrammarIssues.filter((issue) => issue.type === 'grammar').length
  }), [visibleGrammarIssues])
  const filteredGrammarIssues = useMemo(() => {
    if (grammarFilter === 'spelling') return visibleGrammarIssues.filter((issue) => issue.type === 'spelling')
    if (grammarFilter === 'grammar') return visibleGrammarIssues.filter((issue) => issue.type === 'grammar')
    return visibleGrammarIssues
  }, [visibleGrammarIssues, grammarFilter])

  // ── Canvas Overlay Injector (Targeting Native Preview IFRAME) ─────────────
  useEffect(() => {
    const getIframeDoc = (): Document | null => {
      // 1. Primary target: Native preview iframe (liveIframeRef)
      if (iframeRef?.current?.contentDocument?.body) {
        return iframeRef.current.contentDocument
      }
      // 2. Query iframe in DOM
      const iframeEls = Array.from(document.querySelectorAll('iframe')) as HTMLIFrameElement[]
      for (const iframe of iframeEls) {
        try {
          if (iframe.contentDocument && iframe.contentDocument.body) {
            return iframe.contentDocument
          }
        } catch (_) {}
      }
      // 3. Fallback: GrapesJS canvas
      try {
        if (editor && editor.Canvas) {
          const doc = typeof editor.Canvas.getDocument === 'function' ? editor.Canvas.getDocument() : null
          if (doc && doc.body) return doc
          const frame = typeof editor.Canvas.getFrameEl === 'function' ? editor.Canvas.getFrameEl() : null
          if (frame?.contentDocument?.body) return frame.contentDocument
        }
      } catch (_) {}
      return null
    }

    const overlayKeys = Object.keys(auditOverlays) as AuditOverlayKey[]
    let interactionDoc: Document | null = null
    let grammarTargetElements = new Set<Element>()
    const selectorFor = (key: AuditOverlayKey) => {
      if (key === 'showLinks') return 'a'
      if (key === 'showAltText') return 'img'
      if (key === 'showHrefs') return 'button, [role="button"], input[type="button"], input[type="submit"], .btn, .button'
      if (key === 'showHeadings') return 'h1, h2, h3, h4, h5, h6'
      if (key === 'showFileSizes') return AUDIT_MEDIA_SELECTOR
      return ''
    }
    const targetFor = (key: AuditOverlayKey, start: Element | null): Element | null => {
      if (!start) return null
      if (key !== 'showGrammarSpell') {
        const selector = selectorFor(key)
        const match = selector ? start.closest(selector) : null
        return match?.ownerDocument === interactionDoc ? match : null
      }
      let current: Element | null = start
      while (current && current !== interactionDoc?.body) {
        if (grammarTargetElements.has(current)) return current
        current = current.parentElement
      }
      return null
    }
    const shouldShow = (key: AuditOverlayKey, element: Element) => {
      const mode = auditOverlays[key]
      if (mode === 'all') return true
      if (mode === 'hover') return hoveredOverlayElementsRef.current[key] === element
      if (mode === 'click') return clickedOverlayElementsRef.current[key].has(element)
      return false
    }
    const eventElement = (target: EventTarget | null) => {
      const node = target as Element | null
      return node?.nodeType === 1 ? node : null
    }
    const onPointerOver = (event: PointerEvent) => {
      let changed = false
      const start = eventElement(event.target)
      overlayKeys.forEach((key) => {
        if (auditOverlays[key] !== 'hover') return
        const target = targetFor(key, start)
        if (hoveredOverlayElementsRef.current[key] === target) return
        hoveredOverlayElementsRef.current[key] = target
        changed = true
      })
      if (changed) updateOverlays()
    }
    const onPointerOut = (event: PointerEvent) => {
      let changed = false
      const related = eventElement(event.relatedTarget)
      overlayKeys.forEach((key) => {
        if (auditOverlays[key] !== 'hover') return
        const target = targetFor(key, related)
        if (hoveredOverlayElementsRef.current[key] === target) return
        hoveredOverlayElementsRef.current[key] = target
        changed = true
      })
      if (changed) updateOverlays()
    }
    const onOverlayClick = (event: MouseEvent) => {
      const start = eventElement(event.target)
      let handled = false
      overlayKeys.forEach((key) => {
        if (auditOverlays[key] !== 'click') return
        const target = targetFor(key, start)
        if (!target) return
        const selected = clickedOverlayElementsRef.current[key]
        if (selected.has(target)) selected.delete(target)
        else selected.add(target)
        handled = true
      })
      if (!handled) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      updateOverlays()
    }
    const bindInteractions = (doc: Document) => {
      if (interactionDoc === doc) return
      interactionDoc?.removeEventListener('pointerover', onPointerOver, true)
      interactionDoc?.removeEventListener('pointerout', onPointerOut, true)
      interactionDoc?.removeEventListener('click', onOverlayClick, true)
      interactionDoc = doc
      interactionDoc.addEventListener('pointerover', onPointerOver, true)
      interactionDoc.addEventListener('pointerout', onPointerOut, true)
      interactionDoc.addEventListener('click', onOverlayClick, true)
    }

    const updateOverlays = () => {
      const iframeDoc = getIframeDoc()
      if (!iframeDoc || !iframeDoc.body) return

      // Clean previous audit overlay container
      const oldContainer = iframeDoc.getElementById('__audit-overlay-container')
      if (oldContainer) oldContainer.remove()

      const { showLinks, showAltText, showHrefs, showHeadings, showGrammarSpell, showFileSizes } = auditOverlays
      if (overlayKeys.every((key) => auditOverlays[key] === 'off')) return
      bindInteractions(iframeDoc)
      overlayKeys.forEach((key) => {
        clickedOverlayElementsRef.current[key].forEach((element) => {
          if (!element.isConnected || element.ownerDocument !== iframeDoc)
            clickedOverlayElementsRef.current[key].delete(element)
        })
      })
      grammarTargetElements = new Set(
        visibleGrammarIssues
          .map((issue) => locateIssueElement(iframeDoc, issue))
          .filter((element): element is HTMLElement => Boolean(element)),
      )

      const win = iframeDoc.defaultView || window
      const scrollX = win.scrollX || 0
      const scrollY = win.scrollY || 0
      const { inverseScale, stackStep, underlineThickness } = auditOverlayGeometry(canvasZoom)
      const themeStyles = getComputedStyle(document.documentElement)
      const overlayAccent = themeStyles.getPropertyValue('--accent-color').trim() || '#8a918e'
      const overlayForeground = themeStyles.getPropertyValue('--accent-foreground').trim() || '#ffffff'

      // Single top-level overlay container in iframeDoc.body
      const container = iframeDoc.createElement('div')
      container.id = '__audit-overlay-container'
      container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:9999999;'
      iframeDoc.body.appendChild(container)

      const drawBadge = (el: Element, text: string, bgColor: string, textColor: string = '#ffffff', stackIndex = 0) => {
        const rect = el.getBoundingClientRect()
        if (rect.width < 1 && rect.height < 1) return

        const badge = iframeDoc.createElement('div')
        badge.style.cssText = `
          position: absolute;
          left: ${Math.max(4 * inverseScale, rect.left + scrollX + 4 * inverseScale)}px;
          top: ${Math.max(4 * inverseScale, rect.top + scrollY + 4 * inverseScale + stackIndex * stackStep)}px;
          background: ${bgColor};
          color: ${textColor};
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 4px;
          pointer-events: none;
          z-index: 9999999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          line-height: 1.2;
          white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0,0,0,0.6);
          border: 1px solid rgba(255,255,255,0.25);
          transform: scale(${inverseScale});
          transform-origin: top left;
          max-width: ${360 * inverseScale}px;
          overflow: hidden;
          text-overflow: ellipsis;
        `
        badge.textContent = text
        container.appendChild(badge)
      }

      // 1. Show Alt Text
      if (showAltText !== 'off') {
        iframeDoc.querySelectorAll('img').forEach((img) => {
          if (!shouldShow('showAltText', img)) return
          const alt = img.getAttribute('alt')
          if (alt != null && alt.trim() !== '') {
            drawBadge(img, `alt: "${alt.trim().slice(0, 35)}"`, overlayAccent, overlayForeground)
          } else {
            drawBadge(img, 'MISSING ALT', overlayAccent, overlayForeground)
          }
        })
      }

      // 2. Show Links
      if (showLinks !== 'off') {
        iframeDoc.querySelectorAll('a').forEach((a) => {
          if (!shouldShow('showLinks', a)) return
          const href = a.getAttribute('href') || '#'
          drawBadge(a, `link: ${href.slice(0, 40)}`, overlayAccent, overlayForeground)
        })
      }

      // 3. Show Hrefs
      if (showHrefs !== 'off') {
        iframeDoc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .btn, .button').forEach((btn) => {
          if (!shouldShow('showHrefs', btn)) return
          const href = btn.getAttribute('href') || btn.getAttribute('onclick') || btn.getAttribute('type') || 'button'
          drawBadge(btn, `href: ${href.slice(0, 40)}`, overlayAccent, overlayForeground)
        })
      }

      // 4. Show Headings
      if (showHeadings !== 'off') {
        iframeDoc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
          if (!shouldShow('showHeadings', h)) return
          const tag = h.tagName.toUpperCase()
          const snippet = (h.textContent || '').trim().slice(0, 30)
          drawBadge(h, `${tag}: ${snippet}`, overlayAccent, overlayForeground)
        })
      }

      // 5. Show Grammar & Spell Overlays
      if (showGrammarSpell !== 'off') {
        const stackByElement = new Map<HTMLElement, number>()
        visibleGrammarIssues.forEach((issue) => {
          const targetEl = locateIssueElement(iframeDoc, issue)
          if (targetEl) {
            if (!shouldShow('showGrammarSpell', targetEl)) return
            const stackIndex = stackByElement.get(targetEl) || 0
            stackByElement.set(targetEl, stackIndex + 1)
            drawBadge(
              targetEl,
              `${issue.category || issue.type}: ${issue.wordOrPhrase}`,
              overlayAccent,
              overlayForeground,
              stackIndex
            )
            const range = issueDomRange(iframeDoc, issue)
            Array.from(range?.getClientRects() || []).forEach((rect) => {
              if (rect.width < 1 || rect.height < 1) return
              const underline = iframeDoc.createElement('div')
              underline.style.cssText = `position:absolute;left:${rect.left + scrollX}px;top:${rect.bottom + scrollY - underlineThickness}px;width:${rect.width}px;height:${underlineThickness}px;background:${overlayAccent};border-radius:${underlineThickness}px;box-shadow:0 0 ${4 * inverseScale}px currentColor;`
              container.appendChild(underline)
            })
          }
        })
      }

      // 6. Show downloaded file size for rendered media resources.
      if (showFileSizes !== 'off') {
        iframeDoc.querySelectorAll(AUDIT_MEDIA_SELECTOR).forEach((element) => {
          if (!shouldShow('showFileSizes', element)) return
          const resourceUrl = auditMediaResourceUrl(element)
          if (!resourceUrl) return
          const hasMeasurement = Object.prototype.hasOwnProperty.call(resourceFileSizes, resourceUrl)
          const bytes = resourceFileSizes[resourceUrl]
          const sizeLabel = hasMeasurement
            ? bytes == null ? 'Unknown' : formatAuditResourceSize(bytes)
            : 'Measuring...'
          drawBadge(element, `${auditMediaTypeLabel(element)} · ${sizeLabel}`, overlayAccent, overlayForeground)
        })
      }
    }

    updateOverlays()

    // Interval loop while active
    let interval: any = null
    const hasAnyActive = Object.values(auditOverlays).some((mode) => mode !== 'off')
    if (hasAnyActive) {
      interval = setInterval(updateOverlays, 250)
    }

    return () => {
      if (interval) clearInterval(interval)
      interactionDoc?.removeEventListener('pointerover', onPointerOver, true)
      interactionDoc?.removeEventListener('pointerout', onPointerOut, true)
      interactionDoc?.removeEventListener('click', onOverlayClick, true)
      interactionDoc = null
      const iframeDoc = getIframeDoc()
      if (iframeDoc) {
        const c = iframeDoc.getElementById('__audit-overlay-container')
        if (c) c.remove()
      }
    }
  }, [auditOverlays, canvasZoom, editor, html, iframeRef, resourceFileSizes, visibleGrammarIssues])

  // Scroll to and highlight issue element inside live iframe DOM
  const scrollToAndHighlightIssue = (issue: TextIssue) => {
    let iframeDoc: Document | null = null
    if (iframeRef?.current?.contentDocument?.body) {
      iframeDoc = iframeRef.current.contentDocument
    } else if (editor && typeof editor.Canvas?.getDocument === 'function') {
      iframeDoc = editor.Canvas.getDocument()
    }

    if (!iframeDoc || !iframeDoc.body) return

    const targetEl = locateIssueElement(iframeDoc, issue)

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })

      const origOutline = targetEl.style.outline
      const origBoxShadow = targetEl.style.boxShadow
      const origTransition = targetEl.style.transition

      targetEl.style.transition = 'all 0.2s ease-in-out'
      const hostTheme = getComputedStyle(document.documentElement)
      const accent = hostTheme.getPropertyValue('--accent-color').trim() || '#8a918e'
      targetEl.style.outline = `2px solid ${accent}`
      targetEl.style.boxShadow = `0 0 0 4px ${accent}`

      setTimeout(() => {
        targetEl.style.outline = origOutline
        targetEl.style.boxShadow = origBoxShadow
        targetEl.style.transition = origTransition
      }, 2500)

      if (editor) {
        selectElementOnCanvas(targetEl)
      }
    }
  }

  const applySuggestion = (issue: TextIssue, replacement: string) => {
    const iframeDoc = getIframeDoc()
    if (!iframeDoc || !applyIssueSuggestion(iframeDoc, issue, replacement)) {
      setGrammarScanError('This text changed after the scan. Rescan the page and try again.')
      setGrammarScanStatus('error')
      return
    }
    onDocumentChange?.(iframeDoc, `${issue.wordOrPhrase} → ${replacement || 'removed'}`)
    auditSignatureRef.current = ''
    setIgnoredIssueKeys((current) => {
      const next = new Set(current)
      next.delete(issueKey(issue))
      return next
    })
    window.setTimeout(() => void runAuditScan(true), 60)
  }

  const ignoreIssue = (issue: TextIssue) => {
    setIgnoredIssueKeys((current) => new Set(current).add(issueKey(issue)))
  }

  const toggleSector = (sector: SectorKey) => {
    setOpenSectors((prev) => ({ ...prev, [sector]: !prev[sector] }))
  }

  // Selected element inspection attributes
  const selectedInfo = useMemo(() => {
    if (!selectedComponent) return null
    const tag = (selectedComponent.get('tagName') || 'div').toLowerCase()
    const el = selectedComponent.getEl()
    const attrs = selectedComponent.getAttributes() || {}
    const text = el ? (el.textContent || '').trim() : ''
    const classes = selectedComponent.getClasses() || []

    return {
      tag,
      classes: classes.length > 0 ? '.' + classes.join('.') : '',
      el,
      attrs,
      text,
      src: attrs.src || attrs['data-src'] || '',
      alt: attrs.alt != null ? attrs.alt : null,
      href: attrs.href || '',
      target: attrs.target || '',
      rel: attrs.rel || ''
    }
  }, [selectedComponent])

  // Select an element on the canvas by element reference
  const selectElementOnCanvas = (targetEl: HTMLElement | null) => {
    if (!editor || !targetEl) return
    try {
      const wrapper = editor.getWrapper()
      const findComp = (comp: any): any => {
        if (comp.getEl() === targetEl) return comp
        const children = comp.components()
        for (let i = 0; i < children.length; i++) {
          const found = findComp(children.at(i))
          if (found) return found
        }
        return null
      }
      const matched = findComp(wrapper)
      if (matched) {
        editor.select(matched)
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } catch (_) {}
  }

  const exportReportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2))
    const downloadAnchor = document.createElement('a')
    downloadAnchor.setAttribute('href', dataStr)
    downloadAnchor.setAttribute('download', `seo-audit-${new URL(sourceUrl).hostname || 'report'}.json`)
    document.body.appendChild(downloadAnchor)
    downloadAnchor.click()
    downloadAnchor.remove()
  }

  const copyMarkdownSummary = () => {
    const md = `
# On-Page SEO Audit Summary
**URL:** ${sourceUrl}  
**Title:** ${report.metaData.title || 'Missing'}  
**Meta Description:** ${report.metaData.description || 'Missing'}  
**Canonical:** ${report.metaData.canonical || 'Missing'}  
**Headings Count:** ${report.headersList.length}  
**Images Count:** ${report.imagesList.length} (${report.metaData.missingAltCount} missing ALT)  
**Links Count:** ${report.linksList.length}
    `.trim()

    navigator.clipboard.writeText(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="seo-audit-right-panel">
      {/* ── Main Section Header matching Layout's SELECTORS / STYLE ── */}
      <div className="panel-header seo-main-header">
        <span>SEO AUDIT</span>
        <div className="seo-header-actions">
          <button className="gjs-btn-action" onClick={copyMarkdownSummary} title="Copy Summary">
            {copied ? 'Copied' : '- Copy -'}
          </button>
          <button className="gjs-btn-action" onClick={exportReportJson} title="Export JSON Report">
            - Export -
          </button>
        </div>
      </div>

      {/* ── Overview Stats Row (Err / Warn / Pass) ────────── */}
      <div className="seo-score-bar">
        <div className="score-counts-inline">
          <span className="count-tag tag-err">{report.errorCount} Err</span>
          <span className="count-tag tag-warn">{report.warningCount} Warn</span>
          <span className="count-tag tag-pass">{report.passedCount} Pass</span>
        </div>
      </div>

      {/* ── Canvas Overlays Toggle Buttons (Icon-Only System) ────── */}
      <div className="seo-overlay-toggles-bar">
        <div className="seo-toggle-bar-title">Canvas Overlays</div>
        <div className="seo-toggle-btn-group">
          <button
            className={overlayButtonClass('showLinks')}
            onClick={() => toggleOverlay('showLinks')}
            title={overlayButtonTitle('showLinks', 'Links overlay')}
            aria-label={overlayButtonTitle('showLinks', 'Links overlay')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {overlayModeBadge('showLinks')}
          </button>

          <button
            className={overlayButtonClass('showAltText')}
            onClick={() => toggleOverlay('showAltText')}
            title={overlayButtonTitle('showAltText', 'Alt text overlay')}
            aria-label={overlayButtonTitle('showAltText', 'Alt text overlay')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            {overlayModeBadge('showAltText')}
          </button>

          <button
            className={overlayButtonClass('showHrefs')}
            onClick={() => toggleOverlay('showHrefs')}
            title={overlayButtonTitle('showHrefs', 'Button target overlay')}
            aria-label={overlayButtonTitle('showHrefs', 'Button target overlay')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
            {overlayModeBadge('showHrefs')}
          </button>

          <button
            className={overlayButtonClass('showHeadings')}
            onClick={() => toggleOverlay('showHeadings')}
            title={overlayButtonTitle('showHeadings', 'Headings overlay')}
            aria-label={overlayButtonTitle('showHeadings', 'Headings overlay')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12h8m-8-6v12m8-12v12m5-6h3" />
            </svg>
            {overlayModeBadge('showHeadings')}
          </button>

          <button
            className={overlayButtonClass('showGrammarSpell')}
            onClick={() => toggleOverlay('showGrammarSpell')}
            title={overlayButtonTitle('showGrammarSpell', 'Grammar and spelling overlay')}
            aria-label={overlayButtonTitle('showGrammarSpell', 'Grammar and spelling overlay')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            {overlayModeBadge('showGrammarSpell')}
          </button>

          <button
            className={overlayButtonClass('showFileSizes')}
            onClick={() => toggleOverlay('showFileSizes')}
            title={overlayButtonTitle('showFileSizes', 'Media file size overlay')}
            aria-label={overlayButtonTitle('showFileSizes', 'Media file size overlay')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M8 13h8M8 17h5" />
            </svg>
            {overlayModeBadge('showFileSizes')}
          </button>
        </div>
      </div>

      <div className="seo-sectors-wrap">

        {/* ── Sector: Grammar & Spell Checker ─────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('grammarSpell')}>
            <span className="arrow-icon">{openSectors.grammarSpell ? '▼' : '►'}</span>
            <span className="sector-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>GRAMMAR & SPELL CHECK ({grammarCounts.total})</span>
                <button
                  className="grammar-rescan-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    void runAuditScan(true)
                  }}
                  title="Rescan page for grammar and spelling issues"
                  disabled={grammarScanStatus === 'scanning'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              </div>
              {grammarCounts.total > 0 && (
                <span className="grammar-issue-count">
                  {grammarCounts.total} ISSUES
                </span>
              )}
            </span>
          </div>

          {openSectors.grammarSpell && (
            <div className="sector-content">
              <div className="grammar-engine-status">
                <span className={`grammar-status-dot ${grammarScanStatus}`} />
                <span>
                  {grammarScanStatus === 'scanning'
                    ? 'Scanning page…'
                    : grammarReport.engines?.harper
                      ? `Offline Harper · ${grammarReport.scannedElements || 0} text blocks`
                      : grammarReport.engines?.spellingFallback
                        ? 'Offline spelling fallback'
                        : 'Checker unavailable'}
                </span>
              </div>
              {grammarScanError && <div className="grammar-scan-error">{grammarScanError}</div>}
              {grammarReport.engines?.warnings?.filter((warning) => warning !== grammarScanError).map((warning) => (
                <div className="grammar-scan-warning" key={warning}>{warning}</div>
              ))}
              {/* Filter Sub-Tabs */}
              <div className="grammar-filter-tabs">
                <button
                  className={`grammar-filter-btn ${grammarFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setGrammarFilter('all')}
                >
                  All ({grammarCounts.total})
                </button>
                <button
                  className={`grammar-filter-btn ${grammarFilter === 'spelling' ? 'active' : ''}`}
                  onClick={() => setGrammarFilter('spelling')}
                >
                  Spelling ({grammarCounts.spelling})
                </button>
                <button
                  className={`grammar-filter-btn ${grammarFilter === 'grammar' ? 'active' : ''}`}
                  onClick={() => setGrammarFilter('grammar')}
                >
                  Grammar ({grammarCounts.grammar})
                </button>
              </div>

              {grammarScanStatus === 'scanning' && grammarReport.scannedElements === 0 ? (
                <div className="grammar-empty-state">Analyzing visible English content…</div>
              ) : filteredGrammarIssues.length === 0 ? (
                <div className="grammar-empty-state">No {grammarFilter === 'all' ? 'grammar or spelling' : grammarFilter} issues found.</div>
              ) : (
                <div className="list-stack">
                  {filteredGrammarIssues.map((issue) => (
                    <div
                      key={issue.id}
                      className="list-item-row grammar-issue-card"
                      onClick={() => scrollToAndHighlightIssue(issue)}
                      title="Click to scroll to and highlight this issue on canvas"
                    >
                      <div className="item-url-row grammar-issue-heading">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="chip-badge grammar-element-badge">{issue.elementTag}</span>
                          <span className="grammar-type-badge">
                            {issue.type}
                          </span>
                        </div>
                        <span className="grammar-locate-label">Locate ↗</span>
                      </div>

                      <div className="item-text grammar-issue-phrase">
                        "{issue.wordOrPhrase}"
                      </div>
                      
                      <div className="grammar-issue-message">
                        <span>{issue.message}</span>
                        {issue.suggestion && (
                          <span className="grammar-inline-suggestion">
                            • Suggest: "{issue.suggestion}"
                          </span>
                        )}
                      </div>
                      <div className="grammar-issue-context">{issue.elementSnippet}</div>
                      <div className="grammar-issue-actions" onClick={(event) => event.stopPropagation()}>
                        {(issue.suggestions || (issue.suggestion ? [issue.suggestion] : [])).map((suggestion) => (
                          <button
                            key={`${issue.id}-${suggestion}`}
                            className="grammar-suggestion-btn"
                            onClick={() => applySuggestion(issue, suggestion)}
                            title={suggestion ? `Replace with “${suggestion}”` : 'Remove this text'}
                          >
                            {suggestion || 'Remove'}
                          </button>
                        ))}
                        <button className="grammar-ignore-btn" onClick={() => ignoreIssue(issue)}>Ignore</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Sector: Selected Element Inspector ────────────────────── */}
        {selectedInfo && (
          <div className="seo-sector">
            <div className="sector-header" onClick={() => toggleSector('selected')}>
              <span className="arrow-icon">{openSectors.selected ? '▼' : '►'}</span>
              <span className="sector-title">SELECTED ELEMENT</span>
            </div>
            {openSectors.selected && (
              <div className="sector-content">
                <div className="selected-tag-info">
                  Selected: <span className="tag-name">{selectedInfo.tag}{selectedInfo.classes}</span>
                </div>

                {selectedInfo.tag === 'img' && (
                  <div className="field-row">
                    <label className="field-lbl">Alt Attribute</label>
                    <div className="field-input-box">
                      {selectedInfo.alt != null ? (selectedInfo.alt || '(Empty alt="")') : '❌ Missing Alt Attribute'}
                    </div>
                  </div>
                )}

                {/^h[1-6]$/.test(selectedInfo.tag) && (
                  <div className="field-row">
                    <label className="field-lbl">Heading Text</label>
                    <div className="field-input-box">{selectedInfo.text || '(Empty)'}</div>
                  </div>
                )}

                {selectedInfo.tag === 'a' && (
                  <div className="field-row">
                    <label className="field-lbl">Href Target</label>
                    <div className="field-input-box">{selectedInfo.href || '(Empty)'}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Sector: Meta Tags ─────────────────────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('meta')}>
            <span className="arrow-icon">{openSectors.meta ? '▼' : '►'}</span>
            <span className="sector-title">META TAGS</span>
          </div>
          {openSectors.meta && (
            <div className="sector-content">
              <div className="field-row">
                <div className="field-lbl-row">
                  <label className="field-lbl">Title Tag</label>
                  <span className="field-sub">{report.metaData.title.length} px</span>
                </div>
                <div className="field-input-box">{report.metaData.title || <span className="text-muted">No Title</span>}</div>
              </div>

              <div className="field-row">
                <div className="field-lbl-row">
                  <label className="field-lbl">Meta Description</label>
                  <span className="field-sub">{report.metaData.description.length} px</span>
                </div>
                <div className="field-input-box">{report.metaData.description || <span className="text-muted">No Description</span>}</div>
              </div>

              <div className="field-row">
                <label className="field-lbl">Canonical URL</label>
                <div className="field-input-box">{report.metaData.canonical || <span className="text-muted">No Canonical Tag</span>}</div>
              </div>

              <div className="field-row">
                <label className="field-lbl">og:Title</label>
                <div className="field-input-box">{report.metaData.ogTitle || <span className="text-muted">No OG Title</span>}</div>
              </div>

              <div className="field-row">
                <label className="field-lbl">og:Image</label>
                <div className="field-input-box">{report.metaData.ogImage || <span className="text-muted">No OG Image</span>}</div>
              </div>
            </div>
          )}
        </div>

        {/* ── Sector: Header Tags ───────────────────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('headers')}>
            <span className="arrow-icon">{openSectors.headers ? '▼' : '►'}</span>
            <span className="sector-title">HEADER TAGS ({report.headersList.length})</span>
          </div>
          {openSectors.headers && (
            <div className="sector-content">
              {report.headersList.length === 0 ? (
                <div className="text-muted">No headings found</div>
              ) : (
                <div className="list-stack">
                  {report.headersList.map((h, idx) => (
                    <div
                      key={idx}
                      className="list-item-row"
                      onClick={() => {
                        if (editor) {
                          const doc = editor.Canvas.getDocument()
                          if (doc) {
                            const hEls = doc.querySelectorAll('h1, h2, h3, h4, h5, h6')
                            selectElementOnCanvas(hEls[idx] as HTMLElement)
                          }
                        }
                      }}
                    >
                      <span className="chip-badge">{h.tag}</span>
                      <span className="item-text">{h.text || '(Empty)'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Sector: Images & ALT ──────────────────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('images')}>
            <span className="arrow-icon">{openSectors.images ? '▼' : '►'}</span>
            <span className="sector-title">
              IMAGES & ALT ({report.imagesList.length})
              {report.metaData.missingAltCount > 0 && (
                <span className="sector-badge-warn">{report.metaData.missingAltCount} MISSING</span>
              )}
            </span>
          </div>
          {openSectors.images && (
            <div className="sector-content">
              {report.imagesList.length === 0 ? (
                <div className="text-muted">No images found</div>
              ) : (
                <div className="list-stack">
                  {report.imagesList.map((img, idx) => (
                    <div
                      key={idx}
                      className={`list-item-row ${!img.hasAlt && !img.isDecorative ? 'row-warn' : ''}`}
                      onClick={() => {
                        if (editor) {
                          const doc = editor.Canvas.getDocument()
                          if (doc) {
                            const imgs = doc.querySelectorAll('img')
                            selectElementOnCanvas(imgs[idx] as HTMLElement)
                          }
                        }
                      }}
                    >
                      <div className="item-url">{img.fileName}</div>
                      <div className="item-alt-sub">
                        Alt: {img.hasAlt ? img.alt : img.isDecorative ? 'empty' : <strong className="text-err">Missing</strong>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Sector: Links & Anchors ───────────────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('links')}>
            <span className="arrow-icon">{openSectors.links ? '▼' : '►'}</span>
            <span className="sector-title">LINKS & ANCHORS ({report.linksList.length})</span>
          </div>
          {openSectors.links && (
            <div className="sector-content">
              {report.linksList.length === 0 ? (
                <div className="text-muted">No links found</div>
              ) : (
                <div className="list-stack">
                  {report.linksList.map((link, idx) => (
                    <div
                      key={idx}
                      className="list-item-row"
                      onClick={() => {
                        if (editor) {
                          const doc = editor.Canvas.getDocument()
                          if (doc) {
                            const links = doc.querySelectorAll('a')
                            selectElementOnCanvas(links[idx] as HTMLElement)
                          }
                        }
                      }}
                    >
                      <div className="item-url-row">
                        <span className="item-url">{link.url || '(Empty href)'}</span>
                        <span className="chip-badge-sm">{link.isDoFollow ? 'DoFollow' : 'NoFollow'}</span>
                      </div>
                      <div className="item-alt-sub">
                        Anchor: {link.anchorText ? `"${link.anchorText}"` : <strong className="text-err">No Anchor Text</strong>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Sector: Duplicate Content ─────────────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('duplicates')}>
            <span className="arrow-icon">{openSectors.duplicates ? '▼' : '►'}</span>
            <span className="sector-title">
              DUPLICATE CONTENT ({report.duplicatesList.length})
              {report.duplicatesList.length > 0 && (
                <span className="sector-badge-warn">{report.duplicatesList.length} FOUND</span>
              )}
            </span>
          </div>
          {openSectors.duplicates && (
            <div className="sector-content">
              {report.duplicatesList.length === 0 ? (
                <div className="text-muted">No duplicate text elements detected</div>
              ) : (
                <div className="list-stack">
                  {report.duplicatesList.map((dup, idx) => (
                    <div
                      key={idx}
                      className="list-item-row row-warn"
                      onClick={() => {
                        if (editor) {
                          const doc = editor.Canvas.getDocument()
                          if (doc) {
                            const matched = Array.from(doc.querySelectorAll(dup.tag.toLowerCase())).find(
                              (el) => (el.textContent || '').trim().toLowerCase() === dup.text.toLowerCase()
                            )
                            if (matched) selectElementOnCanvas(matched as HTMLElement)
                          }
                        }
                      }}
                      title="Click to highlight duplicate element on canvas"
                    >
                      <div className="item-url-row">
                        <span className="chip-badge">{dup.tag}</span>
                        <span className="chip-badge-sm text-err">{dup.count} Instances [Duplicate]</span>
                      </div>
                      <div className="item-text">"{dup.text}"</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Sector: Assets & Libraries ───────────────────────────── */}
        <div className="seo-sector">
          <div className="sector-header" onClick={() => toggleSector('assets')}>
            <span className="arrow-icon">{openSectors.assets ? '▼' : '►'}</span>
            <span className="sector-title">ASSETS & LIBRARIES</span>
          </div>
          {openSectors.assets && (
            <div className="sector-content">
              <div className="field-row">
                <label className="field-lbl">Internal JS ({report.assets.internalJs.length})</label>
                <div className="asset-list-box">
                  {report.assets.internalJs.length === 0 ? (
                    <div className="text-muted">None</div>
                  ) : (
                    report.assets.internalJs.map((url, i) => <div key={i} className="asset-item">{url}</div>)
                  )}
                </div>
              </div>
              <div className="field-row">
                <label className="field-lbl">External JS ({report.assets.externalJs.length})</label>
                <div className="asset-list-box">
                  {report.assets.externalJs.length === 0 ? (
                    <div className="text-muted">None</div>
                  ) : (
                    report.assets.externalJs.map((url, i) => <div key={i} className="asset-item">{url}</div>)
                  )}
                </div>
              </div>
              <div className="field-row">
                <label className="field-lbl">Internal CSS ({report.assets.internalCss.length})</label>
                <div className="asset-list-box">
                  {report.assets.internalCss.length === 0 ? (
                    <div className="text-muted">None</div>
                  ) : (
                    report.assets.internalCss.map((url, i) => <div key={i} className="asset-item">{url}</div>)
                  )}
                </div>
              </div>
              <div className="field-row">
                <label className="field-lbl">External CSS ({report.assets.externalCss.length})</label>
                <div className="asset-list-box">
                  {report.assets.externalCss.length === 0 ? (
                    <div className="text-muted">None</div>
                  ) : (
                    report.assets.externalCss.map((url, i) => <div key={i} className="asset-item">{url}</div>)
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
