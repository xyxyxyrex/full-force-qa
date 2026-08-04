import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { runSeoAudit, type SeoAuditReport } from '../utils/seoAudit'
import { runGrammarSpellAudit, type GrammarSpellReport, type TextIssue } from '../utils/grammarSpellAudit'
import type { Editor } from 'grapesjs'
import './SeoAuditRightPanel.css'

interface Props {
  html: string
  sourceUrl: string
  editor: Editor | null
  selectedComponent: any
  iframeRef?: React.RefObject<HTMLIFrameElement>
}

type SectorKey = 'grammarSpell' | 'selected' | 'meta' | 'headers' | 'images' | 'links' | 'duplicates' | 'assets'

export default function SeoAuditRightPanel({
  html,
  sourceUrl,
  editor,
  selectedComponent,
  iframeRef
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

  const [auditOverlays, setAuditOverlays] = useState({
    showLinks: false,
    showAltText: false,
    showHrefs: false,
    showHeadings: false,
    showGrammarSpell: false
  })

  const toggleOverlay = (key: keyof typeof auditOverlays) => {
    setAuditOverlays((prev) => ({ ...prev, [key]: !prev[key] }))
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

  // Calculate Grammar & Spell Audit report (Harper.js + Hunspell)
  const [grammarReport, setGrammarReport] = useState<GrammarSpellReport>(() => {
    const targetDoc = getIframeDoc()
    return runGrammarSpellAudit(targetDoc || html)
  })

  const runAuditScan = useCallback(() => {
    const requestId = ++auditRequestRef.current
    const targetDoc = getIframeDoc()
    // Do not serialize through GrapesJS here. During project switches its model
    // may already be destroyed, and the native document/raw capture is also the
    // more accurate source for an SEO audit.
    const content = targetDoc || html
    import('../utils/grammarSpellAudit').then(({ runGrammarSpellAuditAsync }) => {
      runGrammarSpellAuditAsync(content).then((res) => {
        if (res && requestId === auditRequestRef.current) {
          setGrammarReport(res)
        }
      })
    })
  }, [html, getIframeDoc])

  useEffect(() => {
    runAuditScan()
    const timer = setInterval(runAuditScan, 3000)
    return () => {
      clearInterval(timer)
      // Invalidates an audit promise that completes after this panel unmounts.
      auditRequestRef.current += 1
    }
  }, [runAuditScan])

  const filteredGrammarIssues = useMemo(() => {
    if (grammarFilter === 'spelling') return grammarReport.issues.filter((i) => i.type === 'spelling')
    if (grammarFilter === 'grammar') return grammarReport.issues.filter((i) => i.type === 'grammar')
    return grammarReport.issues
  }, [grammarReport, grammarFilter])

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

    const updateOverlays = () => {
      const iframeDoc = getIframeDoc()
      if (!iframeDoc || !iframeDoc.body) return

      // Clean previous audit overlay container
      const oldContainer = iframeDoc.getElementById('__audit-overlay-container')
      if (oldContainer) oldContainer.remove()

      const { showLinks, showAltText, showHrefs, showHeadings, showGrammarSpell } = auditOverlays
      if (!showLinks && !showAltText && !showHrefs && !showHeadings && !showGrammarSpell) return

      const win = iframeDoc.defaultView || window
      const scrollX = win.scrollX || 0
      const scrollY = win.scrollY || 0

      // Single top-level overlay container in iframeDoc.body
      const container = iframeDoc.createElement('div')
      container.id = '__audit-overlay-container'
      container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:9999999;'
      iframeDoc.body.appendChild(container)

      const drawBadge = (el: Element, text: string, bgColor: string, textColor: string = '#ffffff') => {
        const rect = el.getBoundingClientRect()
        if (rect.width < 1 && rect.height < 1) return

        const badge = iframeDoc.createElement('div')
        badge.style.cssText = `
          position: absolute;
          left: ${Math.max(4, rect.left + scrollX + 4)}px;
          top: ${Math.max(4, rect.top + scrollY + 4)}px;
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
        `
        badge.textContent = text
        container.appendChild(badge)
      }

      // 1. Show Alt Text
      if (showAltText) {
        iframeDoc.querySelectorAll('img').forEach((img) => {
          const alt = img.getAttribute('alt')
          if (alt != null && alt.trim() !== '') {
            drawBadge(img, `alt: "${alt.trim().slice(0, 35)}"`, '#10b981')
          } else {
            drawBadge(img, 'MISSING ALT', '#ef4444')
          }
        })
      }

      // 2. Show Links
      if (showLinks) {
        iframeDoc.querySelectorAll('a').forEach((a) => {
          const href = a.getAttribute('href') || '#'
          drawBadge(a, `link: ${href.slice(0, 40)}`, '#3b82f6')
        })
      }

      // 3. Show Hrefs
      if (showHrefs) {
        iframeDoc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .btn, .button').forEach((btn) => {
          const href = btn.getAttribute('href') || btn.getAttribute('onclick') || btn.getAttribute('type') || 'button'
          drawBadge(btn, `href: ${href.slice(0, 40)}`, '#8b5cf6')
        })
      }

      // 4. Show Headings
      if (showHeadings) {
        iframeDoc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
          const tag = h.tagName.toUpperCase()
          const snippet = (h.textContent || '').trim().slice(0, 30)
          drawBadge(h, `${tag}: ${snippet}`, '#f59e0b', '#000000')
        })
      }

      // 5. Show Grammar & Spell Overlays
      if (showGrammarSpell) {
        const textElements = Array.from(
          iframeDoc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, button, td, th, label, div')
        )
        grammarReport.issues.forEach((issue) => {
          const targetEl = textElements[issue.elementIndex] as HTMLElement
          if (targetEl) {
            drawBadge(
              targetEl,
              `${issue.type.toUpperCase()}: ${issue.wordOrPhrase}`,
              issue.type === 'spelling' ? '#ef4444' : '#f59e0b'
            )
          }
        })
      }
    }

    updateOverlays()

    // Interval loop while active
    let interval: any = null
    const hasAnyActive = Object.values(auditOverlays).some(Boolean)
    if (hasAnyActive) {
      interval = setInterval(updateOverlays, 250)
    }

    return () => {
      if (interval) clearInterval(interval)
      const iframeDoc = getIframeDoc()
      if (iframeDoc) {
        const c = iframeDoc.getElementById('__audit-overlay-container')
        if (c) c.remove()
      }
    }
  }, [auditOverlays, editor, html, iframeRef, grammarReport])

  // Scroll to and highlight issue element inside live iframe DOM
  const scrollToAndHighlightIssue = (issue: TextIssue) => {
    let iframeDoc: Document | null = null
    if (iframeRef?.current?.contentDocument?.body) {
      iframeDoc = iframeRef.current.contentDocument
    } else if (editor && typeof editor.Canvas?.getDocument === 'function') {
      iframeDoc = editor.Canvas.getDocument()
    }

    if (!iframeDoc || !iframeDoc.body) return

    const textElements = Array.from(
      iframeDoc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, button, td, th, label, div')
    ).filter((el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'svg') return false
      const text = (el.textContent || '').trim()
      return text.length > 2
    })

    let targetEl = textElements[issue.elementIndex] as HTMLElement
    if (!targetEl || !(targetEl.textContent || '').includes(issue.wordOrPhrase)) {
      targetEl = Array.from(iframeDoc.body.querySelectorAll(issue.elementTag)).find(
        (el) => (el.textContent || '').includes(issue.wordOrPhrase)
      ) as HTMLElement
    }

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })

      const origOutline = targetEl.style.outline
      const origBoxShadow = targetEl.style.boxShadow
      const origTransition = targetEl.style.transition

      targetEl.style.transition = 'all 0.2s ease-in-out'
      targetEl.style.outline = '2px solid #ef4444'
      targetEl.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.75)'

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
            className={`seo-overlay-btn ${auditOverlays.showLinks ? 'active' : ''}`}
            onClick={() => toggleOverlay('showLinks')}
            title="Show Links"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>

          <button
            className={`seo-overlay-btn ${auditOverlays.showAltText ? 'active' : ''}`}
            onClick={() => toggleOverlay('showAltText')}
            title="Show Alt Text"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>

          <button
            className={`seo-overlay-btn ${auditOverlays.showHrefs ? 'active' : ''}`}
            onClick={() => toggleOverlay('showHrefs')}
            title="Show Hrefs"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </button>

          <button
            className={`seo-overlay-btn ${auditOverlays.showHeadings ? 'active' : ''}`}
            onClick={() => toggleOverlay('showHeadings')}
            title="Show Headings"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12h8m-8-6v12m8-12v12m5-6h3" />
            </svg>
          </button>

          <button
            className={`seo-overlay-btn ${auditOverlays.showGrammarSpell ? 'active' : ''}`}
            onClick={() => toggleOverlay('showGrammarSpell')}
            title="Show Grammar & Spell Overlays"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
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
                <span>GRAMMAR & SPELL CHECK ({grammarReport.totalIssues})</span>
                <button
                  style={{ background: 'transparent', border: 'none', color: '#a1a1aa', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    runAuditScan()
                  }}
                  title="Rescan page for grammar and spelling issues"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              </div>
              {grammarReport.totalIssues > 0 && (
                <span className="sector-badge-warn" style={{ background: 'rgba(239,68,68,0.18)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)', padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600 }}>
                  {grammarReport.totalIssues} ISSUES
                </span>
              )}
            </span>
          </div>

          {openSectors.grammarSpell && (
            <div className="sector-content">
              {/* Filter Sub-Tabs */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <button
                  style={{ padding: '2px 8px', fontSize: 10, borderRadius: 10, border: 'none', cursor: 'pointer', background: grammarFilter === 'all' ? '#3f3f46' : 'transparent', color: grammarFilter === 'all' ? '#fff' : '#a1a1aa', fontWeight: grammarFilter === 'all' ? 600 : 400 }}
                  onClick={() => setGrammarFilter('all')}
                >
                  All ({grammarReport.totalIssues})
                </button>
                <button
                  style={{ padding: '2px 8px', fontSize: 10, borderRadius: 10, border: 'none', cursor: 'pointer', background: grammarFilter === 'spelling' ? '#3f3f46' : 'transparent', color: grammarFilter === 'spelling' ? '#fff' : '#a1a1aa', fontWeight: grammarFilter === 'spelling' ? 600 : 400 }}
                  onClick={() => setGrammarFilter('spelling')}
                >
                  Spelling ({grammarReport.spellingCount})
                </button>
                <button
                  style={{ padding: '2px 8px', fontSize: 10, borderRadius: 10, border: 'none', cursor: 'pointer', background: grammarFilter === 'grammar' ? '#3f3f46' : 'transparent', color: grammarFilter === 'grammar' ? '#fff' : '#a1a1aa', fontWeight: grammarFilter === 'grammar' ? 600 : 400 }}
                  onClick={() => setGrammarFilter('grammar')}
                >
                  Grammar ({grammarReport.grammarCount})
                </button>
              </div>

              {filteredGrammarIssues.length === 0 ? (
                <div className="text-muted" style={{ fontSize: 11, padding: '8px 0', textAlign: 'center' }}>No grammar or spelling issues found</div>
              ) : (
                <div className="list-stack">
                  {filteredGrammarIssues.map((issue) => (
                    <div
                      key={issue.id}
                      className="list-item-row"
                      onClick={() => scrollToAndHighlightIssue(issue)}
                      style={{ cursor: 'pointer', padding: '8px 10px', background: '#18181b', borderRadius: 4, marginBottom: 4, border: '1px solid rgba(255,255,255,0.06)' }}
                      title="Click to scroll to and highlight this issue on canvas"
                    >
                      <div className="item-url-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="chip-badge" style={{ background: '#27272a', color: '#e4e4e7', padding: '1px 5px', borderRadius: 3, fontSize: 10 }}>{issue.elementTag}</span>
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              padding: '1px 5px',
                              borderRadius: 4,
                              textTransform: 'uppercase',
                              background: issue.type === 'spelling' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                              color: issue.type === 'spelling' ? '#fca5a5' : '#fcd34d',
                              border: issue.type === 'spelling' ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(245,158,11,0.3)'
                            }}
                          >
                            {issue.type}
                          </span>
                        </div>
                        <span style={{ fontSize: 10, color: '#a1a1aa' }}>Locate ↗</span>
                      </div>

                      <div className="item-text" style={{ fontSize: 11, color: '#f4f4f5', fontWeight: 600, marginBottom: 2 }}>
                        "{issue.wordOrPhrase}"
                      </div>
                      
                      <div style={{ fontSize: 10, color: '#a1a1aa', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <span>{issue.message}</span>
                        {issue.suggestion && (
                          <span style={{ color: '#10b981', fontWeight: 600 }}>
                            • Suggest: "{issue.suggestion}"
                          </span>
                        )}
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
