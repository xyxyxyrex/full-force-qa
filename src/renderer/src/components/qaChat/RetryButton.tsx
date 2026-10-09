import { useState } from 'react'
import { qaChat, useQaChat } from '../qaChatStore'
export default function RetryButton({ id, blocked, settings }: { id?: string; blocked?: string; settings?: boolean }) {
  const chat = useQaChat(); const [busy, setBusy] = useState(false); const [retried, setRetried] = useState(false)
  if (!id) return null
  return <span className="qa-retry-actions"><button type="button" className="qa-retry" disabled={busy || retried || chat.running || !!blocked} title={blocked || 'Retry the failed work; keep completed checks'} onClick={() => {
    setBusy(true)
    void window.electronAPI.qaExecutionRetry(id).then(result => { if (!result.started) qaChat.addError(result.error); else setRetried(true) }).catch(() => qaChat.addError('Could not retry. Check the connection and try again.')).finally(() => setBusy(false))
  }}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M13 7a5 5 0 1 0-1 4M13 3v4H9"/></svg>{busy ? 'Retrying…' : retried ? 'Retried' : 'Retry'}</button>{blocked && <small>{blocked}</small>}{settings && <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('parity:settings-section', { detail: 'agents' }))}>Agent settings</button>}</span>
}
