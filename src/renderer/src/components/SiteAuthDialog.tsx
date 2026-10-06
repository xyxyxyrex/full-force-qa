import { useEffect, useRef, useState } from 'react'
import type { SiteAuthRequest } from '../../../shared/httpAuth'
import './SiteAuthDialog.css'

export default function SiteAuthDialog({ standalone = false }: { standalone?: boolean }) {
  const [request, setRequest] = useState<SiteAuthRequest | null>(null)
  useEffect(() => {
    let active = true, received = false
    const stop = window.electronAPI.onSiteAuthRequest(value => { received = true; setRequest(value) })
    void window.electronAPI.siteAuthPending().then(value => { if (active && !received) setRequest(value) })
    return () => { active = false; stop() }
  }, [])
  return request ? <CredentialsForm key={request.id} request={request} standalone={standalone} /> : null
}

function CredentialsForm({ request, standalone }: { request: SiteAuthRequest; standalone: boolean }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    form.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const respond = async (cancel: boolean) => {
    if (pending) return
    setPending(true)
    try {
      const accepted = await window.electronAPI.siteAuthRespond(request.id, cancel ? null : { username, password })
      if (!accepted) { setError('This sign-in request has expired. Try opening the page again.'); setPending(false) }
    } catch { setError('Unable to complete sign-in. Please try again.'); setPending(false) }
    setPassword('')
  }
  return <div className={`site-auth-backdrop${standalone ? ' site-auth-standalone' : ''}`}>
    <form ref={form} className="site-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="site-auth-title" aria-describedby="site-auth-description" onSubmit={event => { event.preventDefault(); void respond(false) }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void respond(true) }
      if (event.key === 'Tab') {
        const nodes = [...(form.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])]
        const first = nodes[0], last = nodes.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg><div><span>Website access</span><h2 id="site-auth-title">Sign in to {request.isProxy ? 'your proxy' : 'this site'}</h2></div></header>
      <p id="site-auth-description">{request.isProxy ? 'Proxy authorization required for' : 'Authorization required by'} <strong>{request.origin}</strong></p>
      {request.realm && <small className="site-auth-realm">{request.realm}</small>}
      {request.retry && <p className="site-auth-error" role="alert">The server did not accept those credentials. Please try again.</p>}
      {error && <p className="site-auth-error" role="alert">{error}</p>}
      <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={1024} disabled={pending} /></label>
      <label>Password<div className="site-auth-password"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={4096} disabled={pending} /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)} disabled={pending}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
      <p className="site-auth-note">Used only for this server during your current Parity session.</p>
      <footer><button type="button" onClick={() => void respond(true)} disabled={pending}>Cancel</button><button className="site-auth-primary" type="submit" disabled={pending || !username.trim()}>{pending ? 'Signing in…' : 'Sign in'}</button></footer>
    </form>
  </div>
}
