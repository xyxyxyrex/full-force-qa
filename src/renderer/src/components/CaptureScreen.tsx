import { useState, useEffect, useRef } from 'react'
import './CaptureScreen.css'

interface Props {
  onCapture: (html: string, url: string, adminUrl: string) => void
  onBack: () => void
  initialAdminUrl?: string
  initialStagingUrl?: string
  /** When true, attempt capture immediately (reopening a saved project) */
  autoCapture?: boolean
}

/** Heuristics for detecting a WP login/auth wall in the captured HTML */
function looksLikeLoginPage(html: string): boolean {
  const lower = html.toLowerCase()
  return (
    lower.includes('wp-login.php') ||
    lower.includes('loginform') ||
    lower.includes('name="log"') ||
    (lower.includes('<form') && lower.includes('user_login'))
  )
}

export default function CaptureScreen({
  onCapture,
  onBack,
  initialAdminUrl = '',
  initialStagingUrl = '',
  autoCapture = false
}: Props) {
  const [adminUrl, setAdminUrl] = useState(initialAdminUrl)
  const [stagingUrl, setStagingUrl] = useState(initialStagingUrl)
  const [loggedIn, setLoggedIn] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const autoCaptureRan = useRef(false)

  // Auto-capture on mount when reopening a saved project
  useEffect(() => {
    if (autoCapture && initialStagingUrl && !autoCaptureRan.current) {
      autoCaptureRan.current = true
      doCapture(initialStagingUrl)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async () => {
    if (!adminUrl.trim()) return
    setLoading(true)
    setStatus('Opening login window...')
    setError('')
    setSessionExpired(false)
    try {
      await window.electronAPI.login(adminUrl.trim())
      setLoggedIn(true)
      setStatus('Logged in successfully')

      // If we hit session-expired before, retry the capture automatically
      if (sessionExpired && stagingUrl.trim()) {
        setSessionExpired(false)
        await doCapture(stagingUrl.trim())
      }
    } catch (e) {
      setError(`Login failed: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const doCapture = async (url: string) => {
    setLoading(true)
    setStatus('Capturing page \u2014 this may take a few seconds...')
    setError('')
    try {
      const result = await window.electronAPI.capture(url)
      if (!result.success) {
        setError(result.error || 'Capture failed')
        return
      }
      if (!result.html) {
        setError('Capture returned empty content')
        return
      }

      // Check if the captured HTML is actually a WP login page (session expired)
      if (looksLikeLoginPage(result.html)) {
        setSessionExpired(true)
        setLoggedIn(false)
        setError('Session expired \u2014 please log in again, then the capture will retry automatically.')
        return
      }

      onCapture(result.html, url, adminUrl.trim())
    } catch (e) {
      setError(`Capture failed: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleCapture = () => {
    if (!stagingUrl.trim()) return
    doCapture(stagingUrl.trim())
  }

  return (
    <div className="capture-screen">
      <div className="capture-card">
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
              {initialStagingUrl ? 'Recapture' : 'New Capture'}
            </h1>
          </div>
        </div>

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
              type="url"
              className={`capture-input ${sessionExpired ? 'input-warn' : ''}`}
              placeholder="https://example.com/wp-admin"
              value={adminUrl}
              onChange={(e) => setAdminUrl(e.target.value)}
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
              type="url"
              className="capture-input"
              placeholder="https://example.com/?page_id=7145&preview=true"
              value={stagingUrl}
              onChange={(e) => setStagingUrl(e.target.value)}
              disabled={loading}
              onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
            />
            <button
              className="capture-btn btn-primary"
              onClick={handleCapture}
              disabled={loading || !stagingUrl.trim()}
            >
              {loading && status.includes('Capturing') ? 'Capturing...' : 'Capture'}
            </button>
          </div>
        </div>

        {status && !error && (
          <div className="capture-status">{status}</div>
        )}
        {error && (
          <div className={`capture-error ${sessionExpired ? 'error-warn' : ''}`}>{error}</div>
        )}

        <p className="capture-note">
          Login is optional \u2014 skip step 1 if the staging page is publicly accessible.
        </p>
      </div>
    </div>
  )
}
