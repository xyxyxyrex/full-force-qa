import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import QaChat from '../../src/renderer/src/components/QaChat'
import DetachedChat from '../../src/renderer/src/components/qaChat/DetachedChat'
import { qaChat } from '../../src/renderer/src/components/qaChatStore'
import { handleChatWindowAction } from '../../src/renderer/src/components/qaChat/windowBridge'
import { applyTheme } from '../../src/renderer/src/theme/themeSystem'
import '../../src/renderer/src/theme/themes.css'

function Host() {
  const [detached, setDetached] = useState(false)
  useEffect(() => {
    const sync = () => window.electronAPI.qaWindowSync({ chat: qaChat.getState(), theme: document.documentElement.getAttribute('data-theme') || 'parity' })
    const off = qaChat.subscribe(sync)
    const actions = window.electronAPI.onQaWindowAction(handleChatWindowAction)
    const changed = window.electronAPI.onQaWindowChanged(value => { setDetached(value); sync() })
    window.electronAPI.qaReportContext({ projectKey: 'window-project', project: { id: 'window-project', name: 'Window fixture', stagingUrl: 'https://example.test' }, pageUrl: 'https://example.test/page', viewport: { width: 1440, height: 900 }, breakpoint: 'desktop', workspaceTab: 'editBeta', reportedAt: Date.now() })
    ;(window as any).__chat = qaChat
    ;(window as any).__theme = (theme: any) => { applyTheme(theme); sync() }
    ;(window as any).__opened = []
    const open = (event: Event) => (window as any).__opened.push({ name: event.type, detail: (event as CustomEvent).detail })
    for (const name of ['parity:open-qa-history', 'parity:open-ai-tracker', 'parity:settings-section']) window.addEventListener(name, open)
    sync(); return () => { off(); actions(); changed() }
  }, [])
  return detached ? <p>Chat is detached</p> : <div style={{ height: '100vh' }}><QaChat onClose={() => {}}/></div>
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('qaChat') === '1' ? <DetachedChat/> : <Host/>)
