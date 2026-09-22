import { useEffect, useMemo, useState } from 'react'
import type { AccountStatus } from '../../../shared/types'
import './AccountPanel.css'

type AccountAction = 'google' | 'restore' | 'new' | 'signout'

function GoogleLogo() {
  return <svg className="account-google-logo" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20H42V20H24v8h11.3A12 12 0 0 1 12 24c0-1.9.4-3.7 1.2-5.3l-6.6-5.1A20 20 0 0 0 4 24c0 11 9 20 20 20 11 0 20-9 20-20 0-1.3-.1-2.7-.4-4Z" />
    <path fill="#FF3D00" d="m6.6 13.6 6.6 5.1A12 12 0 0 1 32.4 14l5.7-5.7A20 20 0 0 0 6.6 13.6Z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.1l-6.2-5.2A12 12 0 0 1 13.2 29l-6.5 5A20 20 0 0 0 24 44Z" />
    <path fill="#1976D2" d="M43.6 20H42V20H24v8h11.3a12 12 0 0 1-4.1 5.7l6.2 5.2C41.1 35.5 44 30.5 44 24c0-1.3-.1-2.7-.4-4Z" />
  </svg>
}

function cleanError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'Account operation failed.'
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
}

export default function AccountPanel() {
  const [status, setStatus] = useState<AccountStatus>({ signedIn: false, needsSetup: false })
  const [pending, setPending] = useState<AccountAction | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const load = () => void window.electronAPI.accountStatus().then(next => { if (active) setStatus(next) })
    load(); const unsubscribe = window.electronAPI.onAccountChanged(load)
    return () => { active = false; unsubscribe() }
  }, [])
  const messages = useMemo(() => [...new Set([error, status.error].filter((value): value is string => !!value))], [error, status.error])
  const run = async (action: AccountAction, work: () => Promise<void>) => {
    setPending(action); setError('')
    try { await work() } catch (cause) { setError(cleanError(cause)) } finally { setPending(null) }
  }
  const email = status.email || status.user?.email

  return <section className="account-panel">
    <header className="account-panel-header">
      <div>
        <h3>Parity account</h3>
        <p>Keep Notes, projects, and tickets private and available across sessions.</p>
      </div>
      {status.signedIn && <span className="account-status-badge"><span /> Connected</span>}
    </header>

    {messages.map(message => <div key={message} role="alert" className="account-alert">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></svg>
      <span>{message}</span>
    </div>)}

    {!status.signedIn ? <div className="account-login-card">
      <div className="account-login-mark"><GoogleLogo /></div>
      <div className="account-login-copy">
        <strong>Sign in to Parity</strong>
        <span>Use your Google account to access private workspace data.</span>
      </div>
      <button className="account-google-button" disabled={pending !== null} onClick={() => void run('google', async () => setStatus(await window.electronAPI.accountLoginGoogle()))}>
        <GoogleLogo />
        {pending === 'google' ? 'Waiting for Google…' : 'Continue with Google'}
      </button>
      <small>A secure browser window will open to complete sign-in.</small>
    </div> : <>
      <div className="account-identity-card">
        <div className="account-avatar">{email?.charAt(0).toUpperCase() || 'G'}</div>
        <div className="account-identity-copy"><span>Signed in with Google</span><strong>{email || 'Google account'}</strong></div>
        <button className="account-text-button" disabled={pending !== null} onClick={() => void run('signout', async () => { await window.electronAPI.accountSignOut(); setStatus({ signedIn: false, needsSetup: false }) })}>{pending === 'signout' ? 'Signing out…' : 'Sign out'}</button>
      </div>

      {status.needsSetup ? <div className="account-setup">
        <div className="account-section-heading"><span>Workspace setup</span><h4>Choose how you want to continue</h4><p>This choice controls where your existing Parity data is stored.</p></div>
        <div className="account-workspace-options">
          <article className="account-workspace-card">
            <div className="account-option-icon account-option-icon--restore"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg></div>
            <div><h5>Restore Monday workspace</h5><p>Link the Notes, projects, folders, and attachments from your existing Monday identity.</p></div>
            <button className="account-primary-button" disabled={pending !== null} onClick={() => void run('restore', async () => setStatus(await window.electronAPI.accountInitialize('monday')))}>{pending === 'restore' ? 'Restoring…' : 'Restore my existing Monday workspace'}</button>
          </article>
          <article className="account-workspace-card">
            <div className="account-option-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></div>
            <div><h5>Start fresh</h5><p>Create an independent workspace. You can still connect Monday later for ticket intake.</p></div>
            <button className="account-secondary-button" disabled={pending !== null} onClick={() => void run('new', async () => setStatus(await window.electronAPI.accountInitialize('new')))}>{pending === 'new' ? 'Creating…' : 'Start a new workspace'}</button>
          </article>
        </div>
        <p className="account-setup-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>Restoring requires an active Monday connection under Integrations &amp; Capture.</p>
      </div> : <div className="account-ready-card">
        <div className="account-ready-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-8" /></svg></div>
        <div><strong>Your workspace is ready</strong><p>Monday can be connected or disconnected without affecting your Parity account.</p></div>
      </div>}
    </>}
  </section>
}
