import { useState, useEffect, useRef } from 'react'
import type { IntakeTicket as MondayTicket } from '../../../shared/tickets'
import type { TicketSourceRef } from '../../../shared/types'
import { listIntakeTickets } from '../services/ticketService'
import mondayLogo from '../assets/monday-icon-svgrepo-com.svg'
import parityIcon from '../assets/parity-512.png'
import parityLightIcon from '../assets/parity-light-512.png'
import './CaptureScreen.css'
import type { AuditCaptureContext } from '../../../shared/auditExport'

interface Props {
  onCapture: (html: string, url: string, adminUrl: string, details: CaptureProjectDetails, auditContext?: AuditCaptureContext) => void
  onAdd: (details: CaptureProjectDetails) => Promise<void> | void
  onBack: () => void
  initialName?: string
  initialAdminUrl?: string
  initialStagingUrl?: string
  initialFigmaUrl?: string
  initialSheetUrl?: string
  isNewProject?: boolean
  /** When true, attempt capture immediately (reopening a saved project) */
  autoCapture?: boolean
}

export interface CaptureProjectDetails {
  name: string
  adminUrl: string
  stagingUrl: string
  figmaUrl: string
  googleSheetUrl: string
  mondayTicketId?: string
  ticketRef?: TicketSourceRef
}

function ParityCaptureIcon({ size }: { size: number }) {
  return (
    <span
      className="capture-parity-icon"
      style={{ width: size, height: size }}
      role="img"
      aria-label="Parity"
    >
      <img className="capture-parity-icon-dark" src={parityIcon} alt="" />
      <img className="capture-parity-icon-light" src={parityLightIcon} alt="" />
    </span>
  )
}

/** Accurate detection for true WP login page (wp-login.php) or true 404 error page */
function looksLike404OrExpired(html: string): boolean {
  const lower = html.toLowerCase()

  // True WordPress Login Page (actual <body class="login"> or page title "Log In ‹ My Site")
  const isActualLoginPage = (
    lower.includes('<body class="login') ||
    lower.includes('<body class="login-action') ||
    lower.includes('<title>log in') ||
    lower.includes('<title>login ‹') ||
    lower.includes('<title>user login')
  )

  // True 404 error page
  const is404 = (
    lower.includes('<title>404 page not found') ||
    lower.includes('<title>page not found') ||
    lower.includes('class="error404"') ||
    lower.includes('class="error-404"') ||
    lower.includes('404_page_not_found')
  )

  return isActualLoginPage || is404
}

function normalizeUrl(url: string): string {
  let trimmed = (url || '').trim()
  if (!trimmed) return ''
  trimmed = trimmed.replace(/&amp;/gi, '&')
  trimmed = trimmed.replace(/&amp;/gi, '&')
  trimmed = trimmed.replace(/&lt;/gi, '<')
  trimmed = trimmed.replace(/&gt;/gi, '>')
  trimmed = trimmed.replace(/&quot;/gi, '"')
  trimmed = trimmed.replace(/&#39;/gi, "'")
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'https://' + trimmed
  }
  return trimmed
}

export interface TicketLinkItem {
  url: string
  label: string
}

export interface TicketSearchGroup {
  ticket: MondayTicket
  links: TicketLinkItem[]
}

export function getAllStagingLinks(ticket: MondayTicket): TicketLinkItem[] {
  const result: TicketLinkItem[] = []
  const seen = new Set<string>()

  if (ticket.stagingUrl) {
    const norm = normalizeUrl(ticket.stagingUrl)
    if (norm) {
      seen.add(norm.toLowerCase())
      result.push({ url: norm, label: 'Primary Staging URL' })
    }
  }

  if (ticket.otherLinks && Array.isArray(ticket.otherLinks)) {
    for (const link of ticket.otherLinks) {
      if (!link.url) continue
      const norm = normalizeUrl(link.url)
      const lower = norm.toLowerCase()
      if (seen.has(lower)) continue
      if (lower.includes('docs.google.com') || lower.includes('sheets.google.com') || lower.includes('figma.com') || lower.includes('/wp-admin')) {
        continue
      }
      seen.add(lower)
      result.push({ url: norm, label: link.label || 'Staging Link' })
    }
  }

  return result
}

export function getAllSheetLinks(ticket: MondayTicket): TicketLinkItem[] {
  const result: TicketLinkItem[] = []
  const seen = new Set<string>()

  if (ticket.googleSheetUrl) {
    const norm = normalizeUrl(ticket.googleSheetUrl)
    if (norm) {
      seen.add(norm.toLowerCase())
      result.push({ url: norm, label: 'QA Tracker Sheet' })
    }
  }

  if (ticket.otherLinks && Array.isArray(ticket.otherLinks)) {
    for (const link of ticket.otherLinks) {
      if (!link.url) continue
      const norm = normalizeUrl(link.url)
      const lower = norm.toLowerCase()
      if (seen.has(lower)) continue
      const isSheet = lower.includes('docs.google.com/spreadsheets') || lower.includes('sheets.google.com') || (link.label || '').toLowerCase().includes('sheet') || (link.label || '').toLowerCase().includes('tracker')
      if (isSheet) {
        seen.add(lower)
        result.push({ url: norm, label: link.label || 'Google Sheet' })
      }
    }
  }

  return result
}

export function getAllFigmaLinks(ticket: MondayTicket): TicketLinkItem[] {
  const result: TicketLinkItem[] = []
  const seen = new Set<string>()

  if (ticket.figmaUrl) {
    const norm = normalizeUrl(ticket.figmaUrl)
    if (norm) {
      seen.add(norm.toLowerCase())
      result.push({ url: norm, label: 'Figma Design' })
    }
  }

  if (ticket.otherLinks && Array.isArray(ticket.otherLinks)) {
    for (const link of ticket.otherLinks) {
      if (!link.url) continue
      const norm = normalizeUrl(link.url)
      const lower = norm.toLowerCase()
      if (seen.has(lower)) continue
      if (lower.includes('figma.com')) {
        seen.add(lower)
        result.push({ url: norm, label: link.label || 'Figma Link' })
      }
    }
  }

  return result
}

function MondaySearchDropdown({
  groups,
  onSelectLink,
  placeholder = 'Search tickets...',
  direction = 'down'
}: {
  groups: TicketSearchGroup[]
  onSelectLink: (url: string) => void
  placeholder?: string
  direction?: 'down' | 'up'
}) {
  const [searchQuery, setSearchQuery] = useState('')

  const filtered = groups.filter(({ ticket, links }) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase().trim()
    return (
      ticket.name.toLowerCase().includes(q) ||
      ticket.status.toLowerCase().includes(q) ||
      links.some(l => l.url.toLowerCase().includes(q) || l.label.toLowerCase().includes(q))
    )
  })

  return (
    <div className={`monday-search-dropdown-menu ${direction === 'up' ? 'drop-up' : ''}`}>
      <div className="monday-search-input-wrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="monday-search-input"
          placeholder={placeholder}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
        {searchQuery && (
          <button className="monday-search-clear" onClick={() => setSearchQuery('')}>✕</button>
        )}
      </div>

      <div className="monday-search-results">
        {filtered.length === 0 ? (
          <div className="monday-search-empty">No matching tickets found</div>
        ) : (
          filtered.map(({ ticket, links }, idx) => (
            <div key={`${ticket.id}-${idx}`} className="monday-search-ticket-card">
              <div className="monday-search-item-header">
                <span className="monday-search-status-tag">{ticket.providerLabel} · {ticket.status}</span>
                <span className="monday-search-ticket-title">{ticket.name}</span>
                {links.length > 1 && (
                  <span className="monday-multi-link-badge">{links.length} links</span>
                )}
              </div>
              <div className="monday-search-links-list">
                {links.map((link, lIdx) => (
                  <button
                    key={`${link.url}-${lIdx}`}
                    className="monday-search-item-link-btn"
                    onClick={() => onSelectLink(link.url)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, opacity: 0.7 }}>
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    <span className="monday-search-link-label">{link.label}:</span>
                    <span className="monday-search-url-text">{link.url}</span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default function CaptureScreen({
  onCapture,
  onAdd,
  onBack,
  initialName = '',
  initialAdminUrl = '',
  initialStagingUrl = '',
  initialFigmaUrl = '',
  initialSheetUrl = '',
  isNewProject = false,
  autoCapture = false
}: Props) {
  const [name, setName] = useState(initialName)
  const [adminUrl, setAdminUrl] = useState(() => normalizeUrl(initialAdminUrl))
  const [stagingUrl, setStagingUrl] = useState(() => normalizeUrl(initialStagingUrl))
  const [sheetsUrl, setSheetsUrl] = useState(() => normalizeUrl(initialSheetUrl))
  const [figmaUrl, setFigmaUrl] = useState(() => normalizeUrl(initialFigmaUrl))
  const [loggedIn, setLoggedIn] = useState(false)
  const [loading, setLoading] = useState(autoCapture)
  const [status, setStatus] = useState(autoCapture ? 'Opening project snapshot...' : '')
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const autoCaptureRan = useRef(false)

  // tickets for URL quick-fill
  const [mondayTickets, setMondayTickets] = useState<MondayTicket[]>([])
  const [mondayDropdownOpen, setMondayDropdownOpen] = useState(false)
  const [sheetsDropdownOpen, setSheetsDropdownOpen] = useState(false)
  const [figmaDropdownOpen, setFigmaDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const sheetsDropdownRef = useRef<HTMLDivElement>(null)
  const figmaDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    const load = () => void listIntakeTickets().then(tickets => { if (active) setMondayTickets(tickets) }).catch(() => { if (active) setMondayTickets([]) })
    load()
    window.addEventListener('parity:tickets-changed', load)
    return () => { active = false; window.removeEventListener('parity:tickets-changed', load) }
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setMondayDropdownOpen(false)
      }
      if (sheetsDropdownRef.current && !sheetsDropdownRef.current.contains(e.target as Node)) {
        setSheetsDropdownOpen(false)
      }
      if (figmaDropdownRef.current && !figmaDropdownRef.current.contains(e.target as Node)) {
        setFigmaDropdownOpen(false)
      }
    }
    if (mondayDropdownOpen || sheetsDropdownOpen || figmaDropdownOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [mondayDropdownOpen, sheetsDropdownOpen, figmaDropdownOpen])

  const handleSelectTicketLink = (url: string, target: 'staging' | 'sheets' | 'figma') => {
    const norm = normalizeUrl(url)
    if (target === 'sheets') {
      setSheetsUrl(norm)
    } else if (target === 'figma') {
      setFigmaUrl(norm)
    } else {
      setStagingUrl(norm)
    }
    setMondayDropdownOpen(false)
    setSheetsDropdownOpen(false)
    setFigmaDropdownOpen(false)
  }

  // Helpers to extract links from ticket (checking properties & otherLinks)
  const getStagingUrlFromTicket = (ticket: MondayTicket): string => {
    if (ticket.stagingUrl) return ticket.stagingUrl
    const nonSheetFigma = ticket.otherLinks?.find(
      l => !l.url.includes('docs.google.com') && !l.url.includes('figma.com') && !l.url.includes('/wp-admin')
    )
    if (nonSheetFigma) return nonSheetFigma.url
    if (ticket.otherLinks && ticket.otherLinks.length > 0) return ticket.otherLinks[0].url
    return ''
  }

  const getSheetUrlFromTicket = (ticket: MondayTicket): string => {
    if (ticket.googleSheetUrl) return ticket.googleSheetUrl
    const match = ticket.otherLinks?.find(l => 
      l.url.includes('docs.google.com/spreadsheets') || 
      l.url.includes('sheets.google.com') || 
      l.url.includes('google.com/sheets') ||
      (l.label || '').toLowerCase().includes('sheet') ||
      (l.label || '').toLowerCase().includes('tracker')
    )
    return match ? match.url : ''
  }

  const getFigmaUrlFromTicket = (ticket: MondayTicket): string => {
    if (ticket.figmaUrl) return ticket.figmaUrl
    const match = ticket.otherLinks?.find(l => l.url.includes('figma.com'))
    return match ? match.url : ''
  }

  const handleAutofillTicket = (selected: MondayTicket) => {
    if (!name.trim()) setName(selected.name)
    const sUrl = getStagingUrlFromTicket(selected)
    if (sUrl) setStagingUrl(normalizeUrl(sUrl))

    const aUrl = selected.adminUrl || selected.otherLinks?.find(l => l.url.includes('/wp-admin'))?.url
    if (aUrl) setAdminUrl(normalizeUrl(aUrl))

    const sheetUrl = getSheetUrlFromTicket(selected)
    if (sheetUrl) {
      const normSheet = normalizeUrl(sheetUrl)
      setSheetsUrl(normSheet)
      localStorage.setItem('qa_google_sheet_url', normSheet)
    }

    const figUrl = getFigmaUrlFromTicket(selected)
    if (figUrl) {
      const normFig = normalizeUrl(figUrl)
      setFigmaUrl(normFig)
      localStorage.setItem('qa_figma_url', normFig)
    }
  }

  const handleLogin = async () => {
    if (!adminUrl.trim()) return
    setError('')
    setSessionExpired(false)
    const norm = normalizeUrl(adminUrl)
    setAdminUrl(norm)
    setLoading(true)
    setStatus('Opening WordPress login in browser window...')

    try {
      await window.electronAPI.login(norm)
      setLoggedIn(true)
      setStatus('')
      setError('')
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const doCapture = async (force: boolean = false) => {
    if (!stagingUrl.trim()) return
    setError('')
    setSessionExpired(false)
    const normStaging = normalizeUrl(stagingUrl)
    const normAdmin = normalizeUrl(adminUrl)
    setStagingUrl(normStaging)

    setLoading(true)
    setStatus('Loading page & waiting for full rendering...')

    try {
      const res = await window.electronAPI.capture(normStaging)
      if (res.success && res.html) {
        if (!force && (res.is404 || res.isSessionExpired || looksLike404OrExpired(res.html))) {
          setSessionExpired(true)
          setError('Warning: Captured page looks like a WordPress login screen or 404 page. Please verify your admin login or preview URL.')
          setLoading(false)
          setStatus('')
          return
        }
        onCapture(res.html, normStaging, normAdmin, {
          name: name.trim(),
          adminUrl: normAdmin,
          stagingUrl: normStaging,
          figmaUrl: normalizeUrl(figmaUrl),
          googleSheetUrl: normalizeUrl(sheetsUrl),
          ticketRef: mondayTickets.find(ticket => ticket.id === selectedTicketId)?.source,
          mondayTicketId: mondayTickets.find(ticket => ticket.id === selectedTicketId)?.source.provider === 'monday' ? mondayTickets.find(ticket => ticket.id === selectedTicketId)!.source.externalId : undefined
        }, res.auditContext)
      } else {
        setError(res.error || 'Failed to extract HTML from page')
      }
    } catch (err: any) {
      setError(err.message || 'Capture failed')
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const handleCapture = () => doCapture(false)
  const handleForceOpenCaptured = () => doCapture(true)

  const handleAdd = async () => {
    if (!stagingUrl.trim()) return
    setError('')
    const details: CaptureProjectDetails = {
      name: name.trim(),
      adminUrl: normalizeUrl(adminUrl),
      stagingUrl: normalizeUrl(stagingUrl),
      figmaUrl: normalizeUrl(figmaUrl),
      googleSheetUrl: normalizeUrl(sheetsUrl),
      ticketRef: mondayTickets.find(ticket => ticket.id === selectedTicketId)?.source,
          mondayTicketId: mondayTickets.find(ticket => ticket.id === selectedTicketId)?.source.provider === 'monday' ? mondayTickets.find(ticket => ticket.id === selectedTicketId)!.source.externalId : undefined
    }
    setName(details.name)
    setAdminUrl(details.adminUrl)
    setStagingUrl(details.stagingUrl)
    setFigmaUrl(details.figmaUrl)
    setSheetsUrl(details.googleSheetUrl)
    setLoading(true)
    setStatus('Saving project...')
    try {
      await onAdd(details)
    } catch (err: any) {
      setError(err.message || 'Unable to add project')
      setLoading(false)
      setStatus('')
    }
  }

  useEffect(() => {
    if (autoCapture && initialStagingUrl && !autoCaptureRan.current) {
      autoCaptureRan.current = true
      doCapture(false)
    }
  }, [autoCapture, initialStagingUrl])

  const [selectedTicketId, setSelectedTicketId] = useState<string>('')

  // Build group items for step search dropdowns
  const stagingGroups: TicketSearchGroup[] = mondayTickets
    .map(t => ({ ticket: t, links: getAllStagingLinks(t) }))
    .filter(g => g.links.length > 0)

  const sheetsGroups: TicketSearchGroup[] = mondayTickets
    .map(t => ({ ticket: t, links: getAllSheetLinks(t) }))
    .filter(g => g.links.length > 0)

  const figmaGroups: TicketSearchGroup[] = mondayTickets
    .map(t => ({ ticket: t, links: getAllFigmaLinks(t) }))
    .filter(g => g.links.length > 0)

  const selectedTicket = mondayTickets.find(t => t.id === selectedTicketId)
  const selectedTicketStagingLinks = selectedTicket ? getAllStagingLinks(selectedTicket) : []

  // ── FIGMA-STYLE LOADING SCREEN OVERLAY ────────────────────────────────────
  if (loading) {
    return (
      <div className="capture-screen-backdrop">
        <div className="capture-card figma-loading-screen">
          <div className="figma-logo-wrap">
            <ParityCaptureIcon size={44} />
          </div>
          <div className="figma-loading-track">
            <div className="figma-loading-bar" />
          </div>
          <p className="figma-loading-text">{status || 'Capturing page...'}</p>
        </div>
      </div>
    )
  }

  // ── MODAL CAPTURE INPUT FORM ──────────────────────────────────────────────
  return (
    <div
      className="capture-screen-backdrop"
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) onBack()
      }}
    >
      <div className="capture-card" onClick={(e) => e.stopPropagation()}>
        <div className="capture-card-header">
          <button className="back-btn" onClick={onBack} title="Back to dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <div className="capture-logo">
            <ParityCaptureIcon size={30} />
            <h1>
              {isNewProject ? 'New Capture' : 'Recapture Page'}
            </h1>
          </div>
        </div>

        <div className="capture-section capture-name-section">
          <label className="capture-label" htmlFor="capture-project-name">
            Project name
            <span className="capture-optional-tag">Optional</span>
          </label>
          <p className="capture-hint capture-hint-no-step">
            Give this capture a recognizable name for the dashboard.
          </p>
          <input
            id="capture-project-name"
            type="text"
            className="capture-input"
            placeholder="e.g. Product landing page"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={loading}
          />
        </div>

        {/* Top-Level Ticket Selector (Autofills ALL fields at once) */}
        {mondayTickets.length > 0 && (
          <div className="top-ticket-autofill-banner">
            <div className="autofill-banner-header">
              <img src={mondayLogo} alt="" width="16" height="16" />
              <span>Autofill all fields from ticket:</span>
            </div>
            <select
              className="autofill-ticket-select"
              value={selectedTicketId}
              onChange={(e) => {
                const id = e.target.value
                setSelectedTicketId(id)
                const selected = mondayTickets.find(t => t.id === id)
                if (selected) {
                  handleAutofillTicket(selected)
                }
              }}
            >
              <option value="" disabled>-- Select a ticket --</option>
              {mondayTickets.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  [{ticket.status}] {ticket.name}
                </option>
              ))}
            </select>

            {selectedTicketStagingLinks.length > 1 && (
              <div className="top-ticket-sub-staging-picker" style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#e4e4e7', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>Select Staging Page ({selectedTicketStagingLinks.length} found):</span>
                </div>
                <select
                  className="autofill-ticket-select"
                  value={stagingUrl}
                  onChange={(e) => setStagingUrl(normalizeUrl(e.target.value))}
                >
                  {selectedTicketStagingLinks.map((link, idx) => (
                    <option key={idx} value={link.url}>
                      {link.label}: {link.url}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Step 1: WordPress admin login */}
        <div className="capture-section">
          <label className="capture-label">
            <span className="step-badge">1</span>
            WordPress Admin URL
          </label>
          <p className="capture-hint">
            {sessionExpired
              ? 'Your session expired. Please log in again.'
              : 'Enter your wp-admin URL to authenticate first'}
          </p>
          <div className="capture-input-row">
            <input
              type="text"
              className={`capture-input ${sessionExpired ? 'input-warn' : ''}`}
              placeholder="https://example.com/wp-admin"
              value={adminUrl}
              onChange={(e) => setAdminUrl(e.target.value)}
              onBlur={() => setAdminUrl(normalizeUrl(adminUrl))}
              disabled={loading || (loggedIn && !sessionExpired)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            />
            <button
              className={`capture-btn ${loggedIn && !sessionExpired ? 'btn-done' : sessionExpired ? 'btn-relogin' : 'btn-secondary'}`}
              onClick={handleLogin}
              disabled={loading || (loggedIn && !sessionExpired) || !adminUrl.trim()}
            >
              {loggedIn && !sessionExpired ? 'Logged In' : sessionExpired ? 'Re-Login' : 'Login'}
            </button>
          </div>
        </div>

        {/* Step 2: Staging page URL */}
        <div className="capture-section">
          <label className="capture-label">
            <span className="step-badge">2</span>
            Staging Page URL
          </label>
          <p className="capture-hint">
            The page you want to capture and inspect
          </p>
          <div className="capture-input-row">
            <div className="capture-input-combo" ref={dropdownRef}>
              <input
                type="text"
                className={`capture-input ${stagingGroups.length > 0 ? 'has-inline-actions' : ''}`}
                placeholder="https://example.com/?page_id=7145&preview=true"
                value={stagingUrl}
                onChange={(e) => {
                  const val = e.target.value
                  setStagingUrl(val.includes('&amp;') ? normalizeUrl(val) : val)
                }}
                onBlur={() => setStagingUrl(normalizeUrl(stagingUrl))}
                disabled={loading}
                onKeyDown={(e) => e.key === 'Enter' && (isNewProject ? void handleAdd() : handleCapture())}
              />
              {stagingGroups.length > 0 && <div className="capture-input-actions">
                <button type="button" className="capture-input-monday-btn" onClick={() => setMondayDropdownOpen(!mondayDropdownOpen)} aria-label="Fill staging URL from ticket" title="Fill from ticket" aria-expanded={mondayDropdownOpen}>
                  <img src={mondayLogo} alt="" width="14" height="14" />
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points={mondayDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} /></svg>
                </button>
              </div>}
              {mondayDropdownOpen && <MondaySearchDropdown groups={stagingGroups} placeholder="Search staging URLs..." onSelectLink={(url) => handleSelectTicketLink(url, 'staging')} />}
            </div>
            {!isNewProject && (
              <button
                className="capture-btn btn-primary"
                onClick={handleCapture}
                disabled={loading || !stagingUrl.trim()}
              >
                Capture
              </button>
            )}
          </div>

        </div>

        {/* Step 3: QA Tracker (optional) */}
        <div className="capture-section">
          <label className="capture-label">
            <span className="step-badge optional">3</span>
            QA Tracker
            <span className="capture-optional-tag">Optional</span>
          </label>
          <p className="capture-hint">
            Attach a Google Sheets link to edit your QA tracker in the bottom panel
          </p>
          <div className="capture-input-row">
            <div className="capture-input-combo" ref={sheetsDropdownRef}>
              <input
                type="url"
                className={`capture-input ${(sheetsUrl.trim() || sheetsGroups.length > 0) ? 'has-inline-actions' : ''} ${sheetsUrl.trim() && sheetsGroups.length > 0 ? 'has-two-inline-actions' : ''}`}
                placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                value={sheetsUrl}
                onChange={(e) => setSheetsUrl(e.target.value)}
                disabled={loading}
              />
              <div className="capture-input-actions">
                {sheetsUrl.trim() && <button type="button" className="capture-input-clear-btn" onClick={() => setSheetsUrl('')} title="Clear QA Tracker URL" aria-label="Clear QA Tracker URL">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>}
                {sheetsGroups.length > 0 && <button type="button" className="capture-input-monday-btn" onClick={() => setSheetsDropdownOpen(!sheetsDropdownOpen)} aria-label="Fill QA Tracker URL from ticket" title="Fill from ticket" aria-expanded={sheetsDropdownOpen}>
                  <img src={mondayLogo} alt="" width="14" height="14" />
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points={sheetsDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} /></svg>
                </button>}
              </div>
              {sheetsDropdownOpen && <MondaySearchDropdown groups={sheetsGroups} direction="up" placeholder="Search QA Sheets..." onSelectLink={(url) => handleSelectTicketLink(url, 'sheets')} />}
            </div>
          </div>
        </div>

        {/* Step 4: Figma Design Link (optional) */}
        <div className="capture-section">
          <label className="capture-label">
            <span className="step-badge optional">4</span>
            Figma Design
            <span className="capture-optional-tag">Optional</span>
          </label>
          <p className="capture-hint">
            Attach a Figma link to open design references in your browser from the top panel
          </p>
          <div className="capture-input-row">
            <div className="capture-input-combo" ref={figmaDropdownRef}>
              <input
                type="url"
                className={`capture-input ${(figmaUrl.trim() || figmaGroups.length > 0) ? 'has-inline-actions' : ''} ${figmaUrl.trim() && figmaGroups.length > 0 ? 'has-two-inline-actions' : ''}`}
                placeholder="https://www.figma.com/design/..."
                value={figmaUrl}
                onChange={(e) => setFigmaUrl(e.target.value)}
                disabled={loading}
              />
              <div className="capture-input-actions">
                {figmaUrl.trim() && <button type="button" className="capture-input-clear-btn" onClick={() => setFigmaUrl('')} title="Clear Figma URL" aria-label="Clear Figma URL">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>}
                {figmaGroups.length > 0 && <button type="button" className="capture-input-monday-btn" onClick={() => setFigmaDropdownOpen(!figmaDropdownOpen)} aria-label="Fill Figma URL from ticket" title="Fill from ticket" aria-expanded={figmaDropdownOpen}>
                  <img src={mondayLogo} alt="" width="14" height="14" />
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points={figmaDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} /></svg>
                </button>}
              </div>
              {figmaDropdownOpen && <MondaySearchDropdown groups={figmaGroups} direction="up" placeholder="Search Figma links..." onSelectLink={(url) => handleSelectTicketLink(url, 'figma')} />}
            </div>
          </div>
        </div>

        {error && (
          <div className={`capture-error ${sessionExpired ? 'error-warn' : ''}`}>
            <div className="capture-error-text">{error}</div>
            {sessionExpired && (
              <button
                className="capture-btn btn-proceed-force"
                onClick={handleForceOpenCaptured}
              >
                Proceed & Open Captured Page Anyway →
              </button>
            )}
          </div>
        )}

        {isNewProject && (
          <div className="capture-form-actions">
            <button type="button" className="capture-btn btn-secondary" onClick={onBack}>Cancel</button>
            <button
              type="button"
              className="capture-btn btn-primary capture-add-btn"
              onClick={() => void handleAdd()}
              disabled={loading || !stagingUrl.trim()}
            >
              Add
            </button>
          </div>
        )}

        <p className="capture-note">
          Login is optional — skip step 1 if the staging page is publicly accessible.
        </p>
      </div>
    </div>
  )
}
