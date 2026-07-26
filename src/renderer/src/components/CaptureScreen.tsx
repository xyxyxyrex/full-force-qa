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
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'https://' + trimmed
  }
  return trimmed
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
  const dropdownRef = useRef<HTMLDivElement>(null)
  const sheetsDropdownRef = useRef<HTMLDivElement>(null)

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
    }
    if (mondayDropdownOpen || sheetsDropdownOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [mondayDropdownOpen, sheetsDropdownOpen])

  const handleSelectTicketLink = (url: string, target: 'staging' | 'sheets') => {
    const norm = normalizeUrl(url)
    if (target === 'sheets') {
      setSheetsUrl(norm)
    } else {
      setStagingUrl(norm)
    }
    setMondayDropdownOpen(false)
  }

  // Helper: extract best staging URL from a ticket (including scraped update links)
  const getStagingUrlFromTicket = (ticket: MondayTicket): string => {
    if (ticket.stagingUrl) return ticket.stagingUrl
    const nonSheetFigma = ticket.otherLinks?.find(
      l => !l.url.includes('docs.google.com') && !l.url.includes('figma.com') && !l.url.includes('/wp-admin')
    )
    if (nonSheetFigma) return nonSheetFigma.url
    if (ticket.otherLinks && ticket.otherLinks.length > 0) return ticket.otherLinks[0].url
    return ''
  }

  // Collect all usable links from a ticket
  const getTicketLinks = (ticket: MondayTicket): MondayLink[] => {
    const links: MondayLink[] = []
    const bestStaging = getStagingUrlFromTicket(ticket)
    if (bestStaging) links.push({ url: bestStaging, label: 'Staging' })
    if (ticket.adminUrl) links.push({ url: ticket.adminUrl, label: 'WP Admin' })
    if (ticket.googleSheetUrl) links.push({ url: ticket.googleSheetUrl, label: 'QA Sheet' })
    if (ticket.figmaUrl) links.push({ url: ticket.figmaUrl, label: 'Figma' })
    for (const link of ticket.otherLinks || []) {
      if (!links.some(l => l.url === link.url)) {
        links.push(link)
      }
    }
    return links
  }

  // Auto-capture on mount when reopening a saved project
  useEffect(() => {
    if (autoCapture && initialStagingUrl && !autoCaptureRan.current) {
      autoCaptureRan.current = true
      doCapture(normalizeUrl(initialStagingUrl))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async () => {
    const targetAdmin = normalizeUrl(adminUrl)
    setAdminUrl(targetAdmin)
    if (!targetAdmin) return
    setLoading(true)
    setStatus('Opening login window...')
    setError('')
    setSessionExpired(false)
    try {
      await window.electronAPI.login(targetAdmin)
      setLoggedIn(true)
      setStatus('Logged in successfully')

      if (sessionExpired && stagingUrl.trim()) {
        setSessionExpired(false)
        await doCapture(normalizeUrl(stagingUrl))
      } else {
        setLoading(false)
      }
    } catch (e) {
      setError(`Login failed: ${(e as Error).message}`)
      setLoading(false)
    }
  }

  const doCapture = async (rawUrl: string) => {
    const url = normalizeUrl(rawUrl)
    if (!url) return
    setLoading(true)
    setStatus('Capturing page — this may take a few seconds...')
    setError('')
    try {
      const result = await window.electronAPI.capture(url)
      if (!result.success) {
        if (result.is404 || result.isSessionExpired || result.error?.includes('SESSION_EXPIRED_404')) {
          setSessionExpired(true)
          setLoggedIn(false)
          setError('⚠️ Session Expired / 404 Page Not Found — Preview links require an active WordPress session. Please re-login below.')
          setLoading(false)
          return
        }

        setError(result.error || 'Capture failed')
        setLoading(false)
        return
      }

      if (!result.html) {
        setError('Capture returned empty content')
        setLoading(false)
        return
      }

      // Check if the captured HTML is actually a 404 or WP login page
      if (looksLike404OrExpired(result.html)) {
        setSessionExpired(true)
        setLoggedIn(false)
        setError('⚠️ Session Expired / 404 Page Not Found — Please re-login to WordPress below, and the capture will retry automatically.')
        setLoading(false)
        return
      }

      // Save sheets URL to localStorage so EditorWorkspace picks it up
      if (sheetsUrl.trim()) {
        localStorage.setItem('qa_google_sheet_url', sheetsUrl.trim())
      }
      onCapture(result.html, url, adminUrl.trim())
    } catch (e) {
      setError(`Capture failed: ${(e as Error).message}`)
      setLoading(false)
    }
  }

  const handleCapture = () => {
    if (!stagingUrl.trim()) return
    doCapture(stagingUrl.trim())
  }

  // ── FIGMA-STYLE LOADING SCREEN OVERLAY ────────────────────────────────────
  if (loading) {
    return (
      <div className="capture-screen-backdrop" onClick={onBack}>
        <div className="figma-loading-screen" onClick={(e) => e.stopPropagation()}>
          <div className="figma-logo-wrap">
            <svg width="44" height="44" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#4C8BF5" />
              <path d="M8 12h16v2H8zm0 5h12v2H8zm0 5h8v2H8z" fill="#fff" />
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
              <rect width="32" height="32" rx="8" fill="#4C8BF5" />
              <path d="M8 12h16v2H8zm0 5h12v2H8zm0 5h8v2H8z" fill="#fff" />
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
                  const sUrl = getStagingUrlFromTicket(selected)
                  if (sUrl) setStagingUrl(normalizeUrl(sUrl))
                  if (selected.adminUrl) setAdminUrl(normalizeUrl(selected.adminUrl))
                  if (selected.googleSheetUrl) {
                    setSheetsUrl(normalizeUrl(selected.googleSheetUrl))
                    localStorage.setItem('qa_google_sheet_url', selected.googleSheetUrl)
                  }
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
              className={`capture-btn ${loggedIn && !sessionExpired ? 'btn-done' : sessionExpired ? 'btn-warn' : 'btn-secondary'}`}
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
              onChange={(e) => setStagingUrl(e.target.value)}
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

          {/* Monday tickets quick-fill */}
          {mondayTickets.length > 0 && (
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
                <div className="monday-quickfill-dropdown">
                  {mondayTickets.map((ticket) => {
                    const links = getTicketLinks(ticket)
                    if (links.length === 0) return null
                    return (
                      <div key={ticket.id} className="monday-quickfill-ticket">
                        <div className="monday-quickfill-ticket-name">{ticket.name}</div>
                        <div className="monday-quickfill-links">
                          {links.map((link, i) => (
                            <button
                              key={i}
                              className="monday-quickfill-link"
                              onClick={() => handleSelectTicketLink(link.url, link.label === 'QA Sheet' ? 'sheets' : 'staging')}
                              title={link.url}
                            >
                              <span className="monday-qf-label">{link.label}</span>
                              <span className="monday-qf-url">{link.url}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
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
          {mondayTickets.some(t => t.googleSheetUrl) && (
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
                <div className="monday-quickfill-dropdown">
                  {mondayTickets.filter(t => t.googleSheetUrl).map((ticket) => (
                    <button
                      key={ticket.id}
                      className="monday-quickfill-link"
                      onClick={() => handleSelectTicketLink(ticket.googleSheetUrl!, 'sheets')}
                      title={ticket.googleSheetUrl}
                    >
                      <span className="monday-qf-label">{ticket.name}</span>
                      <span className="monday-qf-url">{ticket.googleSheetUrl}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className={`capture-error ${sessionExpired ? 'error-warn' : ''}`}>{error}</div>
        )}

        <p className="capture-note">
          Login is optional — skip step 1 if the staging page is publicly accessible.
        </p>
      </div>
    </div>
  )
}
