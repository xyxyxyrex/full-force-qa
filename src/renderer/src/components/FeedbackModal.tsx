import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AccountStatus, FeedbackArea, FeedbackKind } from '../../../shared/types'
import './FeedbackModal.css'

const areas: Array<{ value: FeedbackArea; label: string }> = [
  { value: 'dashboard', label: 'Dashboard' }, { value: 'edit', label: 'Edit' },
  { value: 'live', label: 'Live' }, { value: 'audit', label: 'Audit' },
  { value: 'automate', label: 'Automate' }, { value: 'notes', label: 'Notes' },
  { value: 'settings', label: 'Settings' }, { value: 'other', label: 'Other' }
]

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unable to send feedback.'
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
}

export default function FeedbackModal({ initialArea, onClose, onOpenAccount }: {
  initialArea: FeedbackArea
  onClose: () => void
  onOpenAccount: () => void
}) {
  const [account, setAccount] = useState<AccountStatus | null>(null)
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [area, setArea] = useState<FeedbackArea>(initialArea)
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    const load = () => void window.electronAPI.accountStatus()
      .then(status => { if (active) setAccount(status) })
      .catch(cause => { if (active) { setAccount({ signedIn: false, needsSetup: false }); setError(errorMessage(cause)) } })
    load()
    titleRef.current?.focus()
    const unsubscribe = window.electronAPI.onAccountChanged(() => {
      setKind('bug'); setTitle(''); setDetails(''); setReceipt(''); setError(''); load()
    })
    return () => { active = false; unsubscribe() }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || !account?.signedIn) return
    setPending(true); setError('')
    try {
      const result = await window.electronAPI.submitFeedback({ kind, title: title.trim(), details: details.trim(), area })
      setReceipt(result.id)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setPending(false) }
  }

  return <div className="feedback-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose() }}>
    <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title" onKeyDown={event => { if (event.key === 'Escape' && !pending) { event.stopPropagation(); onClose() } }}>
      <header className="feedback-header">
        <div><span className="feedback-eyebrow">Help &amp; Feedback</span><h2 id="feedback-title">Tell us about Parity</h2></div>
        <button type="button" className="feedback-close" aria-label="Close feedback" title="Close" disabled={pending} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19" /></svg></button>
      </header>

      {receipt ? <div className="feedback-receipt" role="status">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
        <h3>Feedback sent</h3><p>Thank you. Your report is saved for review.</p>
        <small>Reference ID: <code>{receipt}</code></small>
        <button type="button" className="feedback-primary" onClick={onClose}>Done</button>
      </div> : !account ? <div className="feedback-status">Checking your Parity account…</div> : !account.signedIn ? <div className="feedback-signin">
        {error && <p className="feedback-error" role="alert">{error}</p>}
        <p>Sign in with your Parity account to send feedback or report a problem.</p>
        <button type="button" className="feedback-primary" onClick={onOpenAccount}>Open account settings</button>
      </div> : <form className="feedback-form" onSubmit={event => void submit(event)}>
        <div className="feedback-kind" role="group" aria-label="Feedback type">
          {([['bug', 'Report a bug'], ['feature', 'Suggest a feature'], ['general', 'General feedback']] as const).map(([value, label]) =>
            <button type="button" key={value} aria-pressed={kind === value} className={kind === value ? 'selected' : ''} disabled={pending} onClick={() => setKind(value)}>{label}</button>)}
        </div>
        <label>Title<input ref={titleRef} value={title} onChange={event => setTitle(event.target.value)} required minLength={4} maxLength={120} placeholder={kind === 'bug' ? 'What went wrong?' : 'What would you like to share?'} disabled={pending} /></label>
        <label>{kind === 'bug' ? 'What happened? How can we reproduce it?' : 'Details'}<textarea value={details} onChange={event => setDetails(event.target.value)} required minLength={10} maxLength={4000} rows={6} placeholder={kind === 'bug' ? 'What you did, what you expected, and what happened instead…' : 'Tell us more…'} disabled={pending} /></label>
        <label>Area<select value={area} onChange={event => setArea(event.target.value as FeedbackArea)} disabled={pending}>{areas.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <p className="feedback-privacy">Sent with {account.email || account.user?.email || 'your Parity account'}, your app version and platform. Page content, Notes, screenshots and credentials are not attached.</p>
        {error && <p className="feedback-error" role="alert">{error}</p>}
        <footer><button type="button" className="feedback-secondary" disabled={pending} onClick={onClose}>Cancel</button><button type="submit" className="feedback-primary" disabled={pending || title.trim().length < 4 || details.trim().length < 10}>{pending ? 'Sending…' : 'Send feedback'}</button></footer>
      </form>}
    </section>
  </div>
}
