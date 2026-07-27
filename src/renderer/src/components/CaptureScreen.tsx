import { useState, useEffect, useRef } from 'react'
import type { MondayTicket, MondayLink } from './Dashboard'
import mondayLogo from '../assets/monday-icon-svgrepo-com.svg'
import './CaptureScreen.css'

interface Props {
  onCapture: (html: string, url: string, adminUrl: string) => void
  onBack: () => void
  initialAdminUrl?: string
  initialStagingUrl?: string
  /** When true, attempt capture immediately (reopening a saved project) */
  autoCapture?: boolean
}

/** Heuristics for detecting WP login, 404, or expired session in captured HTML */
function looksLike404OrExpired(html: string): boolean {
  const lower = html.toLowerCase()
  const isLogin = (
    lower.includes('wp-login.php') ||
    lower.includes('loginform') ||
    lower.includes('name="log"') ||
    (lower.includes('<form') && lower.includes('user_login'))
  )
  const is404 = (
    lower.includes('<title>page not found') ||
    lower.includes('class="error404"') ||
    lower.includes('class="page-not-found"') ||
    lower.includes('oops! that page can’t be found') ||
    lower.includes('404_page_not_found')
  )

  return isLogin || is404
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

interface TicketSearchItem {
  ticket: MondayTicket
  targetUrl: string
  targetLabel: string
}

function MondaySearchDropdown({
  items,
  onSelect,
  placeholder = 'Search tickets...'
}: {
  items: TicketSearchItem[]
  onSelect: (item: TicketSearchItem) => void
  placeholder?: string
}) {
  const [searchQuery, setSearchQuery] = useState('')

  const filtered = items.filter(({ ticket, targetUrl, targetLabel }) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase().trim()
    return (
      ticket.name.toLowerCase().includes(q) ||
      ticket.status.toLowerCase().includes(q) ||
      targetUrl.toLowerCase().includes(q) ||
      targetLabel.toLowerCase().includes(q)
    )
  })

  return (
    <div className="monday-search-dropdown-menu">
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
          <div className="monday-search-empty">No matching Monday tickets found</div>
        ) : (
          filtered.map((item, idx) => (
            <button
              key={`${item.ticket.id}-${idx}`}
              className="monday-search-item"
              onClick={() => onSelect(item)}
            >
              <div className="monday-search-item-header">
                <span className="monday-search-status-tag">{item.ticket.status}</span>
                <span className="monday-search-ticket-title">{item.ticket.name}</span>
              </div>
              <div className="monday-search-item-url-row">
                <span className="monday-search-url-label">{item.targetLabel}:</span>
                <span className="monday-search-url-text">{item.targetUrl}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export default function CaptureScreen({
  onCapture,
  onBack,
  initialAdminUrl = '',
  initialStagingUrl = '',
  autoCapture = false
}: Props) {
  const [adminUrl, setAdminUrl] = useState(() => normalizeUrl(initialAdminUrl))
  const [stagingUrl, setStagingUrl] = useState(() => normalizeUrl(initialStagingUrl))
  const [sheetsUrl, setSheetsUrl] = useState(() => normalizeUrl(localStorage.getItem('qa_google_sheet_url') || ''))
  const [figmaUrl, setFigmaUrl] = useState(() => normalizeUrl(localStorage.getItem('qa_figma_url') || ''))
  const [loggedIn, setLoggedIn] = useState(false)
  const [loading, setLoading] = useState(autoCapture)
  const [status, setStatus] = useState(autoCapture ? 'Opening project snapshot...' : '')
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const autoCaptureRan = useRef(false)

  // Monday tickets for URL quick-fill
  const [mondayTickets, setMondayTickets] = useState<MondayTicket[]>([])
  const [mondayDropdownOpen, setMondayDropdownOpen] = useState(false)
  const [sheetsDropdownOpen, setSheetsDropdownOpen] = useState(false)
  const [figmaDropdownOpen, setFigmaDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const sheetsDropdownRef = useRef<HTMLDivElement>(null)
  const figmaDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('monday_tickets')
      if (stored) setMondayTickets(JSON.parse(stored))
    } catch { /* ignore */ }
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
      localStorage.setItem('qa_google_sheet_url', norm)
    } else if (target === 'figma') {
      setFigmaUrl(norm)
      localStorage.setItem('qa_figma_url', norm)
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

    if (sheetsUrl.trim()) {
      localStorage.setItem('qa_google_sheet_url', normalizeUrl(sheetsUrl))
    }
    if (figmaUrl.trim()) {
      localStorage.setItem('qa_figma_url', normalizeUrl(figmaUrl))
    }

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
        onCapture(res.html, normStaging, normAdmin)
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

  useEffect(() => {
    if (autoCapture && initialStagingUrl && !autoCaptureRan.current) {
      autoCaptureRan.current = true
      doCapture(false)
    }
  }, [autoCapture, initialStagingUrl])

  // Build items for step search dropdowns
  const stagingItems: TicketSearchItem[] = mondayTickets
    .map(t => ({ ticket: t, targetUrl: getStagingUrlFromTicket(t), targetLabel: 'Staging' }))
    .filter(i => !!i.targetUrl)

  const sheetsItems: TicketSearchItem[] = mondayTickets
    .map(t => ({ ticket: t, targetUrl: getSheetUrlFromTicket(t), targetLabel: 'QA Sheet' }))
    .filter(i => !!i.targetUrl)

  const figmaItems: TicketSearchItem[] = mondayTickets
    .map(t => ({ ticket: t, targetUrl: getFigmaUrlFromTicket(t), targetLabel: 'Figma' }))
    .filter(i => !!i.targetUrl)

  // ── FIGMA-STYLE LOADING SCREEN OVERLAY ────────────────────────────────────
  if (loading) {
    return (
      <div className="capture-screen-backdrop">
        <div className="capture-card figma-loading-screen">
          <div className="figma-logo-wrap">
            <svg width="40" height="40" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#27272a" stroke="#3f3f46" strokeWidth="1" />
              <path d="M8 12h16v2H8zm0 5h12v2H8zm0 5h8v2H8z" fill="#f4f4f5" />
            </svg>
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
    <div className="capture-screen-backdrop" onClick={onBack}>
      <div className="capture-card" onClick={(e) => e.stopPropagation()}>
        <div className="capture-card-header">
          <button className="back-btn" onClick={onBack} title="Back to dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <div className="capture-logo">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#27272a" stroke="#3f3f46" strokeWidth="1" />
              <path d="M8 12h16v2H8zm0 5h12v2H8zm0 5h8v2H8z" fill="#f4f4f5" />
            </svg>
            <h1>
              {initialStagingUrl ? 'Recapture Page' : 'New Capture'}
            </h1>
          </div>
        </div>

        {/* Top-Level Ticket Selector (Autofills ALL fields at once) */}
        {mondayTickets.length > 0 && (
          <div className="top-ticket-autofill-banner">
            <div className="autofill-banner-header">
              <img src={mondayLogo} alt="" width="16" height="16" />
              <span>Autofill all fields from Monday Ticket:</span>
            </div>
            <select
              className="autofill-ticket-select"
              defaultValue=""
              onChange={(e) => {
                const selected = mondayTickets.find(t => t.id === e.target.value)
                if (selected) {
                  handleAutofillTicket(selected)
                }
              }}
            >
              <option value="" disabled>-- Select a Monday Ticket --</option>
              {mondayTickets.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  [{ticket.status}] {ticket.name}
                </option>
              ))}
            </select>
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
            <input
              type="text"
              className="capture-input"
              placeholder="https://example.com/?page_id=7145&preview=true"
              value={stagingUrl}
              onChange={(e) => {
                const val = e.target.value
                setStagingUrl(val.includes('&amp;') ? normalizeUrl(val) : val)
              }}
              onBlur={() => setStagingUrl(normalizeUrl(stagingUrl))}
              disabled={loading}
              onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
            />
            <button
              className="capture-btn btn-primary"
              onClick={handleCapture}
              disabled={loading || !stagingUrl.trim()}
            >
              Capture
            </button>
          </div>

          {/* Monday tickets quick-fill for staging */}
          {stagingItems.length > 0 && (
            <div className="monday-quickfill" ref={dropdownRef}>
              <button
                className="monday-quickfill-btn"
                onClick={() => setMondayDropdownOpen(!mondayDropdownOpen)}
              >
                <img src={mondayLogo} alt="" width="14" height="14" />
                <span>Fill from Monday ticket</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points={mondayDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                </svg>
              </button>

              {mondayDropdownOpen && (
                <MondaySearchDropdown
                  items={stagingItems}
                  placeholder="Search staging URLs..."
                  onSelect={(item) => handleSelectTicketLink(item.targetUrl, 'staging')}
                />
              )}
            </div>
          )}
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
            <input
              type="url"
              className="capture-input"
              placeholder="https://docs.google.com/spreadsheets/d/.../edit"
              value={sheetsUrl}
              onChange={(e) => setSheetsUrl(e.target.value)}
              onBlur={() => {
                if (sheetsUrl.trim()) localStorage.setItem('qa_google_sheet_url', normalizeUrl(sheetsUrl))
              }}
              disabled={loading}
            />
            {sheetsUrl.trim() && (
              <button
                className="capture-btn btn-clear"
                onClick={() => { setSheetsUrl(''); localStorage.removeItem('qa_google_sheet_url') }}
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>

          {/* Monday tickets quick-fill for sheets */}
          {sheetsItems.length > 0 && (
            <div className="monday-quickfill" ref={sheetsDropdownRef}>
              <button
                className="monday-quickfill-btn"
                onClick={() => setSheetsDropdownOpen(!sheetsDropdownOpen)}
              >
                <img src={mondayLogo} alt="" width="14" height="14" />
                <span>Fill from Monday ticket</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points={sheetsDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                </svg>
              </button>

              {sheetsDropdownOpen && (
                <MondaySearchDropdown
                  items={sheetsItems}
                  placeholder="Search QA Sheets..."
                  onSelect={(item) => handleSelectTicketLink(item.targetUrl, 'sheets')}
                />
              )}
            </div>
          )}
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
            <input
              type="url"
              className="capture-input"
              placeholder="https://www.figma.com/design/..."
              value={figmaUrl}
              onChange={(e) => setFigmaUrl(e.target.value)}
              onBlur={() => {
                if (figmaUrl.trim()) localStorage.setItem('qa_figma_url', normalizeUrl(figmaUrl))
              }}
              disabled={loading}
            />
            {figmaUrl.trim() && (
              <button
                className="capture-btn btn-clear"
                onClick={() => { setFigmaUrl(''); localStorage.removeItem('qa_figma_url') }}
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>

          {/* Monday tickets quick-fill for figma */}
          {figmaItems.length > 0 && (
            <div className="monday-quickfill" ref={figmaDropdownRef}>
              <button
                className="monday-quickfill-btn"
                onClick={() => setFigmaDropdownOpen(!figmaDropdownOpen)}
              >
                <img src={mondayLogo} alt="" width="14" height="14" />
                <span>Fill from Monday ticket</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points={figmaDropdownOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                </svg>
              </button>

              {figmaDropdownOpen && (
                <MondaySearchDropdown
                  items={figmaItems}
                  placeholder="Search Figma links..."
                  onSelect={(item) => handleSelectTicketLink(item.targetUrl, 'figma')}
                />
              )}
            </div>
          )}
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

        <p className="capture-note">
          Login is optional — skip step 1 if the staging page is publicly accessible.
        </p>
      </div>
    </div>
  )
}
