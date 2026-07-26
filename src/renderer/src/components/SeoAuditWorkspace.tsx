import { useState, useMemo } from 'react'
import { runSeoAudit, type SeoAuditReport, type AuditItem, type IssueSeverity } from '../utils/seoAudit'
import './SeoAuditWorkspace.css'

interface Props {
  html: string
  sourceUrl: string
}

type CategoryFilter = 'all' | 'meta' | 'headings' | 'images' | 'links' | 'schema' | 'content'
type SeverityFilter = 'all' | 'error' | 'warning' | 'pass'

export default function SeoAuditWorkspace({ html, sourceUrl }: Props) {
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [copied, setCopied] = useState(false)

  // Run SEO audit against the snapshot HTML
  const report: SeoAuditReport = useMemo(() => {
    return runSeoAudit(html, sourceUrl)
  }, [html, sourceUrl])

  // Collect all audit items
  const allAuditItems: AuditItem[] = useMemo(() => {
    const { meta, headings, images, links, schema, content } = report.categories
    return [...meta, ...headings, ...images, ...links, ...schema, ...content]
  }, [report])

  // Filter items
  const filteredItems = useMemo(() => {
    return allAuditItems.filter((item) => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
      if (severityFilter !== 'all' && item.severity !== severityFilter) return false
      if (searchTerm.trim()) {
        const query = searchTerm.toLowerCase()
        const titleMatch = item.title.toLowerCase().includes(query)
        const descMatch = item.description.toLowerCase().includes(query)
        const recMatch = item.recommendation.toLowerCase().includes(query)
        const valueMatch = item.details?.value?.toLowerCase().includes(query)
        return titleMatch || descMatch || recMatch || valueMatch
      }
      return true
    })
  }, [allAuditItems, categoryFilter, severityFilter, searchTerm])

  const getScoreColor = (score: number) => {
    if (score >= 80) return '#10b981' // Green
    if (score >= 50) return '#f59e0b' // Amber
    return '#ef4444' // Red
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
# On-Page SEO Audit Report
**Source URL:** ${sourceUrl}  
**SEO Score:** ${report.score}/100  
**Summary:** ${report.errorCount} Errors, ${report.warningCount} Warnings, ${report.passedCount} Passed Checks

## Key Metrics
- **Title:** ${report.metaData.title || 'Missing'}
- **Meta Description:** ${report.metaData.description || 'Missing'}
- **Canonical:** ${report.metaData.canonical || 'Missing'}
- **Word Count:** ${report.metaData.wordCount} words
- **H1 Headings:** ${report.metaData.h1Count}
- **Images Missing ALT:** ${report.metaData.missingAltCount} / ${report.metaData.totalImages}

## Issues List
${allAuditItems
  .filter((i) => i.severity === 'error' || i.severity === 'warning')
  .map((i) => `- [${i.severity.toUpperCase()}] **${i.title}**: ${i.description}`)
  .join('\n')}
    `.trim()

    navigator.clipboard.writeText(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="seo-audit-workspace">
      {/* ── Header / Score Summary Banner ──────────────────────────── */}
      <div className="audit-header-card">
        <div className="score-ring-container">
          <svg className="score-ring" width="100" height="100" viewBox="0 0 100 100">
            <circle className="ring-bg" cx="50" cy="50" r="42" strokeWidth="8" />
            <circle
              className="ring-progress"
              cx="50"
              cy="50"
              r="42"
              strokeWidth="8"
              stroke={getScoreColor(report.score)}
              strokeDasharray={263.89}
              strokeDashoffset={263.89 - (263.89 * report.score) / 100}
              strokeLinecap="round"
            />
          </svg>
          <div className="score-number">
            <span className="score-val" style={{ color: getScoreColor(report.score) }}>
              {report.score}
            </span>
            <span className="score-max">/100</span>
          </div>
        </div>

        <div className="audit-header-info">
          <div className="audit-header-title-row">
            <h2>SEO Audit Manager</h2>
            <span className="source-domain">
              {(() => {
                try {
                  return new URL(sourceUrl).hostname
                } catch {
                  return sourceUrl
                }
              })()}
            </span>
          </div>

          <div className="audit-stats-row">
            <button
              className={`stat-pill pill-error ${severityFilter === 'error' ? 'active' : ''}`}
              onClick={() => setSeverityFilter(severityFilter === 'error' ? 'all' : 'error')}
            >
              <span className="dot" />
              <span className="count">{report.errorCount}</span> Errors
            </button>
            <button
              className={`stat-pill pill-warning ${severityFilter === 'warning' ? 'active' : ''}`}
              onClick={() => setSeverityFilter(severityFilter === 'warning' ? 'all' : 'warning')}
            >
              <span className="dot" />
              <span className="count">{report.warningCount}</span> Warnings
            </button>
            <button
              className={`stat-pill pill-pass ${severityFilter === 'pass' ? 'active' : ''}`}
              onClick={() => setSeverityFilter(severityFilter === 'pass' ? 'all' : 'pass')}
            >
              <span className="dot" />
              <span className="count">{report.passedCount}</span> Passed
            </button>
            <span className="stat-pill pill-info">
              <span className="count">{report.infoCount}</span> Info
            </span>
          </div>
        </div>

        <div className="audit-header-actions">
          <button className="audit-act-btn" onClick={copyMarkdownSummary}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M5.5 3.5h7a1 1 0 011 1v7m-3-9.5h-7a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1v-7a1 1 0 00-1-1z" />
            </svg>
            {copied ? 'Copied MD!' : 'Copy Summary'}
          </button>
          <button className="audit-act-btn btn-primary" onClick={exportReportJson}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2v9m-4-4l4 4 4-4M2 13h12" />
            </svg>
            Export Report
          </button>
        </div>
      </div>

      {/* ── Toolbar / Filter Bar ──────────────────────────────────── */}
      <div className="audit-toolbar-bar">
        <div className="category-tabs">
          {(
            [
              { id: 'all', label: 'All Checks' },
              { id: 'meta', label: 'Meta & Title' },
              { id: 'headings', label: 'Headings' },
              { id: 'images', label: 'Images & ALT' },
              { id: 'links', label: 'Links' },
              { id: 'schema', label: 'Schema & Social' },
              { id: 'content', label: 'Content' }
            ] as Array<{ id: CategoryFilter; label: string }>
          ).map((cat) => (
            <button
              key={cat.id}
              className={`cat-tab-btn ${categoryFilter === cat.id ? 'active' : ''}`}
              onClick={() => setCategoryFilter(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="audit-search-wrap">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#707070" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" />
          </svg>
          <input
            className="audit-search-input"
            type="text"
            placeholder="Search audit issues..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button className="clear-search" onClick={() => setSearchTerm('')}>
              ×
            </button>
          )}
        </div>
      </div>

      {/* ── Main Layout Body ──────────────────────────────────────── */}
      <div className="audit-workspace-body">
        {/* Social Card Preview Box (when Meta/Schema tab is selected or viewed) */}
        {(categoryFilter === 'all' || categoryFilter === 'schema' || categoryFilter === 'meta') && (
          <div className="social-preview-section">
            <div className="preview-card-box">
              <div className="card-box-header">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <span>Social Card Preview (Open Graph)</span>
              </div>
              <div className="og-preview-card">
                {report.metaData.ogImage ? (
                  <div className="og-img-wrap">
                    <img src={report.metaData.ogImage} alt="OG Preview" />
                  </div>
                ) : (
                  <div className="og-img-placeholder">No og:image tag found</div>
                )}
                <div className="og-content-wrap">
                  <div className="og-site">
                    {(() => {
                      try {
                        return new URL(sourceUrl).hostname
                      } catch {
                        return sourceUrl
                      }
                    })()}
                  </div>
                  <div className="og-title">{report.metaData.ogTitle || report.metaData.title || 'Page Title Placeholder'}</div>
                  <div className="og-desc">
                    {report.metaData.ogDescription || report.metaData.description || 'No description meta tag provided for social networks.'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audit Items Grid */}
        <div className="audit-items-container">
          {filteredItems.length === 0 ? (
            <div className="audit-empty-state">
              <p>No audit checks matched your current filter.</p>
            </div>
          ) : (
            filteredItems.map((item) => (
              <AuditItemCard key={item.id} item={item} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function AuditItemCard({ item }: { item: AuditItem }) {
  const [expanded, setExpanded] = useState(false)

  const getSeverityIcon = (sev: IssueSeverity) => {
    if (sev === 'error') {
      return (
        <span className="item-icon icon-error" title="Critical Error">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </span>
      )
    }
    if (sev === 'warning') {
      return (
        <span className="item-icon icon-warning" title="Warning">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v6M8 12h.01" />
          </svg>
        </span>
      )
    }
    if (sev === 'pass') {
      return (
        <span className="item-icon icon-pass" title="Passed Check">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3.5 8.5l3 3 6-6" />
          </svg>
        </span>
      )
    }
    return (
      <span className="item-icon icon-info" title="Info">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7v5M8 5h.01" />
        </svg>
      </span>
    )
  }

  const hasDetails = item.details && (item.details.value || item.details.items?.length)

  return (
    <div className={`audit-card item-sev-${item.severity}`}>
      <div className="audit-card-main" onClick={() => hasDetails && setExpanded(!expanded)}>
        <div className="audit-card-left">
          {getSeverityIcon(item.severity)}
          <div className="audit-card-titles">
            <div className="card-title-row">
              <span className="item-title">{item.title}</span>
              <span className={`cat-badge cat-${item.category}`}>{item.category}</span>
            </div>
            <p className="item-desc">{item.description}</p>
          </div>
        </div>

        {hasDetails && (
          <button className="expand-toggle-btn">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        )}
      </div>

      {item.recommendation && (
        <div className="audit-card-rec">
          <span className="rec-label">Recommendation:</span> {item.recommendation}
        </div>
      )}

      {expanded && item.details && (
        <div className="audit-card-details">
          {item.details.value && (
            <div className="detail-value-box">
              <span className="detail-val-label">Current Value:</span>
              <code>{item.details.value}</code>
            </div>
          )}

          {item.details.items && item.details.items.length > 0 && (
            <div className="detail-items-list">
              {item.details.items.map((subItem, idx) => (
                <div key={idx} className={`detail-item-row status-${subItem.status || 'default'}`}>
                  <div className="sub-item-header">
                    <span className="sub-label">{subItem.label}</span>
                    <span className="sub-val">{subItem.value}</span>
                  </div>
                  {subItem.sub && <div className="sub-text">{subItem.sub}</div>}
                  {subItem.elementSnippet && (
                    <pre className="sub-snippet">
                      <code>{subItem.elementSnippet}</code>
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
