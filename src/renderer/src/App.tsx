import { useCallback, useState, useEffect, useRef } from 'react'
import type { AppUpdateStatus, Project } from '../../shared/types'
import Dashboard from './components/Dashboard'
import CaptureScreen from './components/CaptureScreen'
import EditorWorkspace from './components/EditorWorkspace'
import NotesWorkspace from './components/NotesWorkspace'
import { fetchMondayTicketsApi } from './utils/mondayApi'
import SettingsModal from './components/SettingsModal'
import { loadSettings, applyTheme } from './theme/themeSystem'
import type { AppSettings } from '../../shared/types'
import parityIcon from './assets/parity-favicon.svg'
import parityLightIcon from './assets/parity-light-512.png'
import { applyCloudAccountState, collectLocalAccountState, queueAccountStateSave, resetLocalAccountState, setAccountStateSyncReady } from './services/accountStateService'
import './theme/themes.css'
import './App.css'

export type View = 'dashboard' | 'capture' | 'editor' | 'notes'

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

function isRenderableSnapshot(html: string | null): html is string {
  if (!html || !html.trim()) return false
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const body = doc.body
    return !!body && (body.children.length > 0 || !!body.textContent?.trim())
  } catch {
    return false
  }
}

export default function App() {
  const lastSyncRef = useRef<number>(0)
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activityBarPinned, setActivityBarPinned] = useState(() => localStorage.getItem('parity_activity_bar_pinned') === 'true')
  const [activityBarVisible, setActivityBarVisible] = useState(true)
  const activityHideTimerRef = useRef<number | null>(null)
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({ state: 'idle', currentVersion: '' })

  const syncMondayTickets = useCallback(async (): Promise<boolean> => {
    try {
      const status = await window.electronAPI.mondayStatus()
      if (!status.connected) return false
      await fetchMondayTicketsApi()
      lastSyncRef.current = Date.now()
      window.dispatchEvent(new CustomEvent('monday_tickets_updated'))
      return true
    } catch (error) {
      console.warn('[Monday] Sync skipped:', error)
      return false
    }
  }, [])

  const syncPrivateAccount = useCallback(async () => {
    const status = await window.electronAPI.mondayStatus()
    if (!status.connected) {
      setAccountStateSyncReady(false)
      return
    }
    setAccountStateSyncReady(false, true)
    const result = await window.electronAPI.accountBootstrap()
    if (!result.connected) {
      setAccountStateSyncReady(false)
      return
    }
    const previousOwnerKey = localStorage.getItem('parity_account_owner_key')
    const accountChanged = !!(result.user && previousOwnerKey && previousOwnerKey !== result.user.ownerKey)
    if (result.user) localStorage.setItem('parity_account_owner_key', result.user.ownerKey)
    if (result.state) {
      if (accountChanged) resetLocalAccountState()
      setSettings(applyCloudAccountState(result.state))
      setAccountStateSyncReady(true, true)
    } else {
      setAccountStateSyncReady(true, true)
      const initialState = result.user && previousOwnerKey && previousOwnerKey !== result.user.ownerKey
        ? resetLocalAccountState()
        : collectLocalAccountState()
      if (accountChanged) setSettings(loadSettings())
      queueAccountStateSave(initialState)
    }
    if (accountChanged) window.dispatchEvent(new Event('parity:account-owner-changed'))
    window.dispatchEvent(new Event('qa_projects_updated'))
  }, [])

  useEffect(() => {
    const onConnected = () => void syncPrivateAccount()
    const onDisconnected = () => setAccountStateSyncReady(false, true)
    const onStateDirty = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail && typeof detail === 'object') queueAccountStateSave(detail)
    }
    window.addEventListener('parity:monday-connected', onConnected)
    window.addEventListener('parity:monday-disconnected', onDisconnected)
    window.addEventListener('parity:account-state-dirty', onStateDirty)
    void syncPrivateAccount().catch(() => {})
    return () => {
      window.removeEventListener('parity:monday-connected', onConnected)
      window.removeEventListener('parity:monday-disconnected', onDisconnected)
      window.removeEventListener('parity:account-state-dirty', onStateDirty)
    }
  }, [syncPrivateAccount])

  // Apply theme on initial mount and when theme changes
  useEffect(() => {
    applyTheme(settings.theme)
  }, [settings.theme])

  useEffect(() => {
    if (activityBarPinned) {
      setActivityBarVisible(true)
      return
    }
    const timer = window.setTimeout(() => setActivityBarVisible(false), 1400)
    return () => window.clearTimeout(timer)
  }, [activityBarPinned])

  useEffect(() => {
    let disposed = false
    void window.electronAPI.getUpdateStatus().then((status) => {
      if (!disposed) setUpdateStatus(status)
    }).catch(() => {})
    const unsubscribe = window.electronAPI.onUpdateStatus((status) => {
      if (!disposed) setUpdateStatus(status)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const updateButtonTitle = (() => {
    if (updateStatus.state === 'available') return `Version ${updateStatus.version} is available. Click to download.`
    if (updateStatus.state === 'downloading') return `Downloading version ${updateStatus.version || ''} (${Math.round(updateStatus.percent || 0)}%)`
    if (updateStatus.state === 'downloaded') return `Version ${updateStatus.version} is ready. Click to restart and install.`
    if (updateStatus.state === 'checking') return 'Checking for updates…'
    if (updateStatus.state === 'error') return `${updateStatus.message || 'Update check failed'} Click to retry.`
    if (updateStatus.state === 'not-available') return `Parity ${updateStatus.currentVersion || ''} is up to date. Click to check again.`
    return 'Check for updates'
  })()

  const handleUpdateButton = async () => {
    if (updateStatus.state === 'checking' || updateStatus.state === 'downloading') return
    if (updateStatus.state === 'available') {
      await window.electronAPI.downloadUpdate()
      return
    }
    if (updateStatus.state === 'downloaded') {
      await window.electronAPI.installUpdate()
      return
    }
    await window.electronAPI.checkForUpdates()
  }

  const [tabs, setTabs] = useState<TabState[]>(() => {
    try {
      const saved = sessionStorage.getItem('fullforce_app_tabs')
      if (saved) {
        const parsed: TabState[] = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((t) => {
            const savedTabHtml = sessionStorage.getItem(`fullforce_snapshot_html_${t.id}`)
            const legacyHtml = sessionStorage.getItem('fullforce_captured_html')
            const tabHtml = isRenderableSnapshot(savedTabHtml)
              ? savedTabHtml
              : isRenderableSnapshot(legacyHtml) ? legacyHtml : null
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

  useEffect(() => {
    const resetOpenWorkspaces = () => {
      setTabs((current) => {
        for (const tab of current) sessionStorage.removeItem(`fullforce_snapshot_html_${tab.id}`)
        const id = `tab-dashboard-${Date.now()}`
        setActiveTabId(id)
        return [{ id, title: 'Dashboard', view: 'dashboard', snapshotHtml: null, captureUrl: '', snapshotKey: 0, activeProject: null, prefillAdmin: '', prefillStaging: '', skipAutoCapture: false }]
      })
    }
    window.addEventListener('parity:account-owner-changed', resetOpenWorkspaces)
    return () => window.removeEventListener('parity:account-owner-changed', resetOpenWorkspaces)
  }, [])

  const togglePin = () => {
    setIsPinned(prev => {
      const next = !prev
      localStorage.setItem('tab_bar_pinned', next ? 'true' : 'false')
      return next
    })
  }

  // ── Background Polling for Monday Tickets (every 2 minutes) ────────────────
  useEffect(() => {
    const intervalMinutes = settings.mondaySyncIntervalMinutes
    let interval: ReturnType<typeof setInterval> | undefined
    if (intervalMinutes > 0) {
      void syncMondayTickets()
      interval = setInterval(() => void syncMondayTickets(), intervalMinutes * 60_000)
    }
    return () => {
      if (interval !== undefined) clearInterval(interval)
    }
  }, [settings.mondaySyncIntervalMinutes, syncMondayTickets])

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
    if (Date.now() - lastSyncRef.current > 30000) {
      void syncMondayTickets()
    }
  }

  const openUtilityView = (view: 'dashboard' | 'notes') => {
    const existing = tabs.find((tab) => tab.view === view && !tab.activeProject)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const id = `tab-${view}-${Date.now()}`
    setTabs((current) => [...current, {
      id,
      title: view === 'notes' ? 'Notes' : 'Dashboard',
      view,
      snapshotHtml: null,
      captureUrl: '',
      snapshotKey: 0,
      activeProject: null,
      prefillAdmin: '',
      prefillStaging: '',
      skipAutoCapture: false,
    }])
    setActiveTabId(id)
  }

  const revealActivityBar = () => {
    if (activityHideTimerRef.current !== null) window.clearTimeout(activityHideTimerRef.current)
    setActivityBarVisible(true)
  }

  const scheduleActivityBarHide = () => {
    if (activityBarPinned) return
    if (activityHideTimerRef.current !== null) window.clearTimeout(activityHideTimerRef.current)
    activityHideTimerRef.current = window.setTimeout(() => setActivityBarVisible(false), 900)
  }

  const toggleActivityBarPin = () => {
    setActivityBarPinned((current) => {
      const next = !current
      localStorage.setItem('parity_activity_bar_pinned', String(next))
      if (next) setActivityBarVisible(true)
      return next
    })
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
    if (!forceForm) {
      const existingTab = tabs.find((tab) => tab.activeProject?.id === project.id && tab.view !== 'dashboard')
      if (existingTab) {
        setActiveTabId(existingTab.id)
        return
      }
    }
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
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
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

  const handleProjectThumbnailCaptured = async (dataUrl: string) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    const project = activeTab?.activeProject
    if (!project || project.thumbnailUrl || !dataUrl.startsWith('data:image/')) return
    const updatedProject: Project = { ...project, thumbnailUrl: dataUrl }
    await window.electronAPI.saveProject(updatedProject)
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
    updateActiveTab((tab) => ({ ...tab, activeProject: tab.activeProject?.id === updatedProject.id ? updatedProject : tab.activeProject }))
  }

  const handleProjectUpdated = useCallback(async (updatedProject: Project) => {
    await window.electronAPI.saveProject(updatedProject)
    setTabs((current) => current.map((tab) =>
      tab.activeProject?.id === updatedProject.id
        ? { ...tab, activeProject: updatedProject }
        : tab
    ))
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
  }, [])

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

  useEffect(() => {
    const syncOpenProjects = () => {
      void window.electronAPI.getProjects().then((projects) => {
        const byId = new Map(projects.map((project) => [project.id, project]))
        setTabs((current) => current.map((tab) => tab.activeProject && byId.has(tab.activeProject.id) ? { ...tab, activeProject: byId.get(tab.activeProject.id)! } : tab))
      })
    }
    window.addEventListener('qa_projects_updated', syncOpenProjects)
    return () => window.removeEventListener('qa_projects_updated', syncOpenProjects)
  }, [])

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0]

  const persistTabHtml = (tabId: string, mountedSnapshotKey: number, updatedHtml: string) => {
    // Reject an iframe's transient about:blank document. Persisting that value
    // would replace the capture and remount GrapesJS with an empty Body.
    if (!isRenderableSnapshot(updatedHtml)) return
    setTabs((prev) => {
      const currentTab = prev.find((tab) => tab.id === tabId)
      // Ignore teardown from an editor that was replaced by a newer recapture.
      if (!currentTab || currentTab.snapshotKey !== mountedSnapshotKey) return prev
      try {
        sessionStorage.setItem(`fullforce_snapshot_html_${tabId}`, updatedHtml)
        sessionStorage.setItem('fullforce_captured_html', updatedHtml)
      } catch {}
      return prev.map((tab) => tab.id === tabId ? { ...tab, snapshotHtml: updatedHtml } : tab)
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden', position: 'relative' }}>
      {/* Permanent Integrated Titlebar & Multi-Project Tab Bar */}
      <div className="app-top-tab-bar-wrap" onDoubleClick={handleDoubleClickHeader}>
        <div className="app-top-tab-bar" onDoubleClick={handleDoubleClickHeader}>
          <div className="app-brand" aria-label="Parity">
            <img className="parity-dark-icon" src={parityIcon} alt="" aria-hidden="true" />
            <img className="parity-light-icon" src={parityLightIcon} alt="" aria-hidden="true" />
            <span>parity</span>
          </div>
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
          <button
            type="button"
            className={`app-update-btn state-${updateStatus.state}`}
            onClick={() => void handleUpdateButton()}
            title={updateButtonTitle}
            aria-label={updateButtonTitle}
            aria-live="polite"
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v11" />
              <path d="m8 10 4 4 4-4" />
              <path d="M5 17v2h14v-2" />
            </svg>
            {(updateStatus.state === 'available' || updateStatus.state === 'downloaded') && <span className="app-update-dot" />}
          </button>
        </div>
      </div>

      {/* VS Code-style auto-hiding Activity Bar */}
      <div className="app-activity-hotzone" onMouseEnter={revealActivityBar} />
      <aside className={`app-activity-bar ${activityBarVisible || activityBarPinned ? 'visible' : ''}`} onMouseEnter={revealActivityBar} onMouseLeave={scheduleActivityBarHide} aria-label="Primary navigation">
        <button className={activeTab?.view === 'dashboard' ? 'active' : ''} onClick={() => openUtilityView('dashboard')} title="Dashboard" aria-label="Dashboard">
          <svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8v9H6a3 3 0 0 1-3-3z"/><path d="M9 20v-7h6v7"/></svg><span>Dashboard</span>
        </button>
        <button className={activeTab?.view === 'notes' ? 'active' : ''} onClick={() => openUtilityView('notes')} title="Notes" aria-label="Notes">
          <svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h5M9 12h7M9 16h7"/></svg><span>Notes</span>
        </button>
        <div className="app-activity-spacer" />
        <button onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2.3-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2.3.7v3l2.3.7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2.3h3l.7-2.3 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z"/></svg><span>Settings</span></button>
        <button className={activityBarPinned ? 'pinned' : ''} onClick={toggleActivityBarPin} title={activityBarPinned ? 'Auto-hide sidebar' : 'Keep sidebar visible'} aria-label={activityBarPinned ? 'Auto-hide sidebar' : 'Keep sidebar visible'}><svg viewBox="0 0 24 24"><path d="M8 4h8l-1 6 3 3H6l3-3zM12 13v8"/></svg><span>{activityBarPinned ? 'Auto-hide' : 'Pin sidebar'}</span></button>
      </aside>

      {/* Tab Workspaces Render Area */}
      <div className="app-workspace-host">
        {activeTab && (
          <div key={activeTab.id} style={{ height: '100%', width: '100%' }}>
            {activeTab.view === 'editor' && activeTab.snapshotHtml ? (
              <EditorWorkspace
                key={`${activeTab.id}:${activeTab.snapshotKey}`}
                html={activeTab.snapshotHtml}
                sourceUrl={activeTab.captureUrl}
                project={activeTab.activeProject}
                onReset={handleReset}
                onNewCapture={goToDashboard}
                onOpenSettings={() => setSettingsOpen(true)}
                onPersistHtml={(updatedHtml) => persistTabHtml(activeTab.id, activeTab.snapshotKey, updatedHtml)}
                onThumbnailCaptured={handleProjectThumbnailCaptured}
                onProjectUpdated={handleProjectUpdated}
              />
            ) : activeTab.view === 'notes' ? (
              <NotesWorkspace onOpenDashboard={() => openUtilityView('dashboard')} />
            ) : (
              <>
                <Dashboard
                  onNewProject={handleNewProject}
                  onOpenProject={handleOpenProject}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                {activeTab.view === 'capture' && (
                  <CaptureScreen
                    onCapture={handleCapture}
                    onBack={goToDashboard}
                    initialAdminUrl={activeTab.prefillAdmin}
                    initialStagingUrl={activeTab.prefillStaging}
                    autoCapture={activeTab.skipAutoCapture ? false : !!(activeTab.activeProject && activeTab.activeProject.stagingUrl && activeTab.activeProject.adminUrl)}
                  />
                )}
              </>
            )}
          </div>
        )}
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
