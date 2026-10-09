import { useEffect, useState } from 'react'
import type { AppTheme } from '../../../../shared/types'
import type { QaChatWindowSnapshot } from '../../../../shared/qaChatWindow'
import { applyTheme, loadSettings } from '../../theme/themeSystem'
import QaChat from '../QaChat'
import { qaChat, type ChatState } from '../qaChatStore'
import '../../theme/themes.css'

export default function DetachedChat() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true; let received = false; let theme = ''
    const accept = (snapshot: QaChatWindowSnapshot | null) => {
      if (!alive || !snapshot) return
      received = true
      if (theme !== snapshot.theme) {
        theme = snapshot.theme; applyTheme(theme as AppTheme)
        const color = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim()
        void window.electronAPI.setTitleBarOverlay?.(color).catch(() => {})
      }
      qaChat.mirror(snapshot.chat as ChatState); setReady(true)
    }
    const off = window.electronAPI.onQaWindowSnapshot(accept)
    void window.electronAPI.qaWindowReady().then(snapshot => { if (!received) accept(snapshot) }).catch(() => { if (alive) setError('Could not reconnect to the chat. Dock it and try again.') })
    const history = (event: Event) => window.electronAPI.qaWindowAction({ type: 'open', view: 'history', tab: (event as CustomEvent).detail?.tab })
    const tracker = (event: Event) => window.electronAPI.qaWindowAction({ type: 'open', view: 'tracker', projectKey: (event as CustomEvent).detail?.projectKey })
    const settings = () => window.electronAPI.qaWindowAction({ type: 'open', view: 'settings' })
    window.addEventListener('parity:open-qa-history', history); window.addEventListener('parity:open-ai-tracker', tracker); window.addEventListener('parity:settings-section', settings)
    const key = (event: KeyboardEvent) => { if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'q') { event.preventDefault(); void window.electronAPI.qaWindowDock() } }
    window.addEventListener('keydown', key)
    return () => { alive = false; off(); window.removeEventListener('keydown', key); window.removeEventListener('parity:open-qa-history', history); window.removeEventListener('parity:open-ai-tracker', tracker); window.removeEventListener('parity:settings-section', settings) }
  }, [])
  return <main className="qa-detached-window"><div className="qa-window-titlebar">QA agent <span>Parity</span></div>{ready ? <QaChat detached onClose={() => window.close()}/> : <div className="qa-window-loading" role="status">{error || 'Reconnecting to your chat…'}<button type="button" onClick={() => void window.electronAPI.qaWindowDock()}>Dock in Parity</button></div>}</main>
}

applyTheme(loadSettings().theme)
