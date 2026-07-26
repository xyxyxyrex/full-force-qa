import { useState, useMemo } from 'react'
import { runSeoAudit, type SeoAuditReport } from '../utils/seoAudit'
import type { Editor } from 'grapesjs'
import './SeoAuditRightPanel.css'

interface Props {
  html: string
  sourceUrl: string
  editor: Editor | null
  selectedComponent: any
}

type SectorKey = 'selected' | 'meta' | 'headers' | 'images' | 'links' | 'duplicates' | 'assets'

export default function SeoAuditRightPanel({
  html,
  sourceUrl,
  editor,
  selectedComponent
}: Props) {
  const [openSectors, setOpenSectors] = useState<Record<SectorKey, boolean>>({
    selected: true,
    meta: true,
    headers: true,
    images: true,
    links: false,
    duplicates: true,
    assets: false
  })

  const [copied, setCopied] = useState(false)

  // Calculate SEO audit report
  const report: SeoAuditReport = useMemo(() => {
    return runSeoAudit(html, sourceUrl)
  }, [html, sourceUrl])

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
**SEO Health Score:** ${report.score}/100  
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

      {/* ── Overview Stats Row (Flat Dark Inspector Style) ────────── */}
      <div className="seo-score-bar">
        <div className="score-val-badge">Score: <strong>{report.score}</strong> / 100</div>
        <div className="score-counts-inline">
          <span className="count-tag tag-err">{report.errorCount} Err</span>
          <span className="count-tag tag-warn">{report.warningCount} Warn</span>
          <span className="count-tag tag-pass">{report.passedCount} Pass</span>
        </div>
      </div>

      <div className="seo-sectors-wrap">

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
