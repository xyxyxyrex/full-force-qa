import { useState, useEffect, useRef } from 'react'
import type { Project } from '../../shared/types'
import Dashboard from './components/Dashboard'
import CaptureScreen from './components/CaptureScreen'
import EditorWorkspace from './components/EditorWorkspace'
import { fetchMondayTicketsApi } from './utils/mondayApi'
import SettingsModal from './components/SettingsModal'
import { loadSettings, applyTheme } from './theme/themeSystem'
import type { AppSettings } from '../../shared/types'
import './theme/themes.css'
import './App.css'

export type View = 'dashboard' | 'capture' | 'editor'

export interface TabState {
  id: string
  title: string
  view: View
  snapshotHtml: string | null
  captureUrl: string
  snapshotKey: number
  activeProject: Project | null
  prefillAdmin: string
  prefillStaging: string
  skipAutoCapture: boolean
}

export default function App() {
  const lastSyncRef = useRef<number>(0)
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Apply theme on initial mount and when theme changes
  useEffect(() => {
    applyTheme(settings.theme)
  }, [settings.theme])

  const [tabs, setTabs] = useState<TabState[]>(() => {
    try {
      const saved = sessionStorage.getItem('fullforce_app_tabs')
      if (saved) {
        const parsed: TabState[] = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((t) => {
            const tabHtml = sessionStorage.getItem(`fullforce_snapshot_html_${t.id}`) || sessionStorage.getItem('fullforce_captured_html')
            return {
              ...t,
              snapshotHtml: t.view === 'editor' ? (tabHtml || null) : null
            }
          })
        }
      }
    } catch {}
    return [
      {
        id: 'tab-1',
        title: 'Dashboard',
        view: 'dashboard',
        snapshotHtml: null,
        captureUrl: '',
        snapshotKey: 0,
        activeProject: null,
        prefillAdmin: '',
        prefillStaging: '',
        skipAutoCapture: false
      }
    ]
  })

  const [activeTabId, setActiveTabId] = useState<string>(() => {
    const savedId = sessionStorage.getItem('fullforce_active_tab_id')
    return savedId || 'tab-1'
  })

  const [isPinned, setIsPinned] = useState<boolean>(() => localStorage.getItem('tab_bar_pinned') === 'true')

  // Persist tab configuration & snapshot HTML in sessionStorage across page reloads (Ctrl+R / F5)
  useEffect(() => {
    try {
      const serialized = tabs.map((t) => {
        if (t.snapshotHtml) {
          sessionStorage.setItem(`fullforce_snapshot_html_${t.id}`, t.snapshotHtml)
        }
        return {
          ...t,
          snapshotHtml: null
        }
      })
      sessionStorage.setItem('fullforce_app_tabs', JSON.stringify(serialized))
    } catch {}
  }, [tabs])

  useEffect(() => {
    sessionStorage.setItem('fullforce_active_tab_id', activeTabId)
  }, [activeTabId])

  const togglePin = () => {
    setIsPinned(prev => {
      const next = !prev
      localStorage.setItem('tab_bar_pinned', next ? 'true' : 'false')
      return next
    })
  }

  // ── Background Polling for Monday Tickets (every 2 minutes) ────────────────
  useEffect(() => {
    const doPoll = async () => {
      const token = localStorage.getItem('monday_api_token')
      if (token) {
        await fetchMondayTicketsApi(token)
        lastSyncRef.current = Date.now()
        window.dispatchEvent(new CustomEvent('monday_tickets_updated'))
      }
    }

    doPoll()
    const interval = setInterval(doPoll, 120000)
    return () => clearInterval(interval)
  }, [])

  const updateActiveTab = (updater: (tab: TabState) => TabState) => {
    setTabs(prev => prev.map(t => (t.id === activeTabId ? updater(t) : t)))
  }

  const handleNewTab = () => {
    const newId = 'tab-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6)
    const newTab: TabState = {
      id: newId,
      title: 'Dashboard',
      view: 'dashboard',
      snapshotHtml: null,
      captureUrl: '',
      snapshotKey: 0,
      activeProject: null,
      prefillAdmin: '',
      prefillStaging: '',
      skipAutoCapture: false
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newId)
  }

  const handleCloseTab = (tabIdToClose: string, e: React.MouseEvent) => {
    e.stopPropagation()
    sessionStorage.removeItem(`fullforce_snapshot_html_${tabIdToClose}`)
    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== tabIdToClose)
      if (remaining.length === 0) {
        const freshId = 'tab-' + Date.now()
        setActiveTabId(freshId)
        return [{
          id: freshId,
          title: 'Dashboard',
          view: 'dashboard',
          snapshotHtml: null,
          captureUrl: '',
          snapshotKey: 0,
          activeProject: null,
          prefillAdmin: '',
          prefillStaging: '',
          skipAutoCapture: false
        }]
      }
      if (activeTabId === tabIdToClose) {
        const idx = prev.findIndex(t => t.id === tabIdToClose)
        const nextActive = remaining[Math.max(0, idx - 1)]
        setActiveTabId(nextActive.id)
      }
      return remaining
    })
  }

  const goToDashboard = () => {
    updateActiveTab(t => ({
      ...t,
      view: 'dashboard',
      title: 'Dashboard',
      snapshotHtml: null,
      activeProject: null
    }))
    const token = localStorage.getItem('monday_api_token')
    if (token && Date.now() - lastSyncRef.current > 30000) {
      fetchMondayTicketsApi(token).then(() => {
        lastSyncRef.current = Date.now()
        window.dispatchEvent(new CustomEvent('monday_tickets_updated'))
      })
    }
  }

  const handleNewProject = () => {
    updateActiveTab(t => ({
      ...t,
      prefillAdmin: '',
      prefillStaging: '',
      activeProject: null,
      skipAutoCapture: true,
      view: 'capture',
      title: 'New Capture'
    }))
  }

  const handleOpenProject = (project: Project, forceForm: boolean = false) => {
    updateActiveTab(t => ({
      ...t,
      prefillAdmin: project.adminUrl || '',
      prefillStaging: project.stagingUrl || '',
      activeProject: project,
      skipAutoCapture: forceForm,
      view: 'capture',
      title: project.name || 'Capture'
    }))
  }

  const handleCapture = async (html: string, url: string, adminUrl: string) => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    const now = Date.now()
    const project: Project = activeTab?.activeProject
      ? { ...activeTab.activeProject, stagingUrl: url, adminUrl, lastOpenedAt: now }
      : {
          id: crypto.randomUUID(),
          name: deriveProjectName(url),
          adminUrl,
          stagingUrl: url,
          createdAt: now,
          lastOpenedAt: now
        }

    await window.electronAPI.saveProject(project)
    const tabId = activeTabId
    sessionStorage.setItem(`fullforce_snapshot_html_${tabId}`, html)
    sessionStorage.setItem('fullforce_captured_html', html)

    updateActiveTab(t => ({
      ...t,
      activeProject: project,
      snapshotHtml: html,
      captureUrl: url,
      snapshotKey: t.snapshotKey + 1,
      view: 'editor',
      title: project.name || deriveProjectName(url)
    }))
  }

  const handleReset = async () => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (!activeTab || !activeTab.captureUrl) return
    const result = await window.electronAPI.capture(activeTab.captureUrl)
    if (result.success && result.html) {
      const lower = result.html.toLowerCase()
      const is404 = lower.includes('<title>page not found') || lower.includes('class="error404"') || lower.includes('wp-login.php')
      if (is404) {
        updateActiveTab(t => ({ ...t, view: 'capture' }))
        return
      }
      updateActiveTab(t => ({ ...t, snapshotHtml: result.html!, snapshotKey: t.snapshotKey + 1 }))
    } else if (result.is404 || result.isSessionExpired) {
      updateActiveTab(t => ({ ...t, view: 'capture' }))
    }
  }

  const handleDoubleClickHeader = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (
      target.classList.contains('app-top-tab-bar') ||
      target.classList.contains('app-top-tab-bar-wrap') ||
      target.classList.contains('tab-list')
    ) {
      if (typeof (window.electronAPI as any)?.toggleMaximizeWindow === 'function') {
        ;(window.electronAPI as any).toggleMaximizeWindow()
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden', position: 'relative' }}>
      {/* Permanent Integrated Titlebar & Multi-Project Tab Bar */}
      <div className="app-top-tab-bar-wrap" onDoubleClick={handleDoubleClickHeader}>
        <div className="app-top-tab-bar" onDoubleClick={handleDoubleClickHeader}>
          <div className="tab-list" onDoubleClick={handleDoubleClickHeader}>
            {tabs.map((t) => {
              const isActive = t.id === activeTabId
              return (
                <div
                  key={t.id}
                  className={`app-tab-item ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveTabId(t.id)}
                  title={t.title}
                >
                  <span className="app-tab-title">{t.title}</span>
                  <button
                    className="app-tab-close"
                    onClick={(e) => handleCloseTab(t.id, e)}
                    title="Close Tab"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
            <button className="app-new-tab-btn" onClick={handleNewTab} title="Open New Tab (Dashboard)">
              +
            </button>
          </div>
        </div>
      </div>

      {/* Tab Workspaces Render Area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: 'calc(100vh - 38px)' }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              style={{
                display: isActive ? 'block' : 'none',
                height: '100%',
                width: '100%'
              }}
            >
              {tab.view === 'editor' && tab.snapshotHtml ? (
                <EditorWorkspace
                  key={tab.snapshotKey}
                  html={tab.snapshotHtml}
                  sourceUrl={tab.captureUrl}
                  project={tab.activeProject}
                  onReset={handleReset}
                  onNewCapture={goToDashboard}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              ) : (
                <>
                  <Dashboard
                    onNewProject={handleNewProject}
                    onOpenProject={handleOpenProject}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                  {tab.view === 'capture' && (
                    <CaptureScreen
                      onCapture={handleCapture}
                      onBack={goToDashboard}
                      initialAdminUrl={tab.prefillAdmin}
                      initialStagingUrl={tab.prefillStaging}
                      autoCapture={tab.skipAutoCapture ? false : !!(tab.activeProject && tab.activeProject.stagingUrl && tab.activeProject.adminUrl)}
                    />
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Global Settings Modal */}
      <SettingsModal
        isOpen={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(newSettings) => {
          setSettings(newSettings)
          applyTheme(newSettings.theme)
        }}
      />
    </div>
  )
}

function deriveProjectName(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return 'Untitled Project'
  }
}
