import { useCallback, useState, useEffect, useRef } from 'react'
import type { AppUpdateStatus, FeedbackArea, Project } from '../../shared/types'
import Dashboard from './components/Dashboard'
import { refreshMondayTickets, syncTickets } from './services/ticketService'
import CaptureScreen, { type CaptureProjectDetails } from './components/CaptureScreen'
import EditorWorkspace, { type WorkspaceTab } from './components/EditorWorkspace'
import NotesWorkspace from './components/NotesWorkspace'
import SettingsModal from './components/SettingsModal'
import FeedbackModal from './components/FeedbackModal'
import { loadSettings, applyTheme } from './theme/themeSystem'
import type { AppSettings } from '../../shared/types'
import parityIcon from './assets/parity-favicon.svg'
import parityLightIcon from './assets/parity-light-512.png'
import { applyCloudAccountState, collectLocalAccountState, queueAccountStateSave, resetLocalAccountState, setAccountStateSyncReady } from './services/accountStateService'
import './theme/themes.css'
import './App.css'
import type { AuditCaptureContext } from '../../shared/auditExport'
import CommandPalette from './components/CommandPalette'
import { usePaletteProvider, rankItemsAsync, type PaletteItem } from './palette/registry'
import { getPaletteNotes, setPaletteNotes, workspaceItems } from './palette/workspaceSearch'
import { HOTKEY_DEFINITIONS, THEME_LIST, saveSettings } from './theme/themeSystem'
import type { ProjectFolder } from '../../shared/types'
import { normalizeWorkspaceUrl, sameWorkspacePage } from './utils/workspaceUrl'

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
  newProjectFolderId?: string
  dashboardFolderId?: string | null
  dashboardFolderName?: string
  dashboardFolderPath?: string
  workspaceTab?: WorkspaceTab
  auditContext?: AuditCaptureContext | null
  initialNoteId?: string
  initialTicketId?: string
  previewOnly?: boolean
  pendingCaptureUrl?: string
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
  const viewOwner = localStorage.getItem('parity_account_owner_key')
  const saveScopedProject = (project: Project) => { project.localOwnerKey = viewOwner; return window.electronAPI.saveProject(project, viewOwner) }
  const lastSyncRef = useRef<number>(0)
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [accountReady, setAccountReady] = useState(false)
  const accountGeneration = useRef(0)
  const [activityBarPinned, setActivityBarPinned] = useState(() => localStorage.getItem('parity_activity_bar_pinned') === 'true')
  const [activityBarVisible, setActivityBarVisible] = useState(true)
  const activityHideTimerRef = useRef<number | null>(null)
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({ state: 'idle', currentVersion: '' })

  const syncMondayTickets = useCallback(async (): Promise<boolean> => {
    try { if (!(await window.electronAPI.mondayStatus()).connected) return false; await refreshMondayTickets(); lastSyncRef.current = Date.now(); return true } catch { return false }
  }, [])

  const syncPrivateAccount = useCallback(async () => {
    const generation = ++accountGeneration.current
    const status = await window.electronAPI.accountStatus()
    if (generation !== accountGeneration.current) return
    const previousOwnerKey = localStorage.getItem('parity_account_owner_key')
    const ownerKey = status.user?.ownerKey
    const accountChanged = previousOwnerKey !== (ownerKey || null)
    if (accountChanged && previousOwnerKey) localStorage.setItem('parity_local_state:' + previousOwnerKey, JSON.stringify(collectLocalAccountState()))
    if (!ownerKey) {
      setPaletteNotes(null, [])
      setAccountStateSyncReady(false, true)
      if (previousOwnerKey) {
        localStorage.setItem('parity_legacy_owner_key', previousOwnerKey)
        localStorage.removeItem('parity_account_owner_key')
      }
      if (previousOwnerKey) resetLocalAccountState()
      if (accountChanged) window.dispatchEvent(new Event('parity:account-owner-changed'))
      setAccountReady(true)
      return
    }
    if (accountChanged) {
      setPaletteNotes(null, [])
      setAccountStateSyncReady(false, true)
      resetLocalAccountState()
      window.dispatchEvent(new Event('parity:account-owner-changed'))
    }
    localStorage.setItem('parity_account_owner_key', ownerKey)
    const savedState = localStorage.getItem('parity_local_state:' + ownerKey)
    if (accountChanged && savedState) { try { setSettings(applyCloudAccountState(JSON.parse(savedState))) } catch {} }
    setAccountReady(true)
    setAccountStateSyncReady(false, true)
    const result = await window.electronAPI.accountBootstrap()
    if (generation !== accountGeneration.current || !result.connected) return
    setPaletteNotes(ownerKey, result.notes || [])
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
    void syncTickets()
  }, [])

  useEffect(() => {
    const onConnected = () => {
      setPaletteNotes(null, [])
      setAccountReady(false)
      setAccountStateSyncReady(false, true)
      window.dispatchEvent(new Event('parity:account-owner-changed'))
      void syncPrivateAccount().catch(() => setAccountReady(true))
    }
    const openSettings = () => setSettingsOpen(true)
    const unsubscribe = window.electronAPI.onAccountChanged(onConnected)
    window.addEventListener('parity:open-account', openSettings)
    window.addEventListener('parity:open-integrations', openSettings)
    const onStateDirty = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail && typeof detail === 'object') queueAccountStateSave(detail)
    }
    window.addEventListener('parity:account-state-dirty', onStateDirty)
    const reconnect = () => void syncPrivateAccount().catch(() => {})
    window.addEventListener('online', reconnect)
    const retry = window.setInterval(reconnect, 120000)
    void syncPrivateAccount().catch(() => setAccountReady(true))
    return () => {
      unsubscribe()
      clearInterval(retry)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('parity:open-account', openSettings)
      window.removeEventListener('parity:open-integrations', openSettings)
      window.removeEventListener('parity:account-state-dirty', onStateDirty)
    }
  }, [syncPrivateAccount])

  // Apply theme on initial mount and when theme changes
  useEffect(() => {
    applyTheme(settings.theme)
    const frame = window.requestAnimationFrame(() => {
      const symbolColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--text-primary')
        .trim() || '#edefee'
      void window.electronAPI.setTitleBarOverlay(symbolColor).catch(() => {})
    })
    return () => window.cancelAnimationFrame(frame)
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

  // Persist only lightweight tab metadata in sessionStorage. Captured pages can
  // exceed Chromium's Web Storage quota, so their HTML lives in Electron's
  // filesystem-backed workspace cache instead.
  useEffect(() => {
    try {
      const serialized = tabs.map((t) => {
        sessionStorage.removeItem(`fullforce_snapshot_html_${t.id}`)
        return {
          ...t,
          captureUrl: t.previewOnly && t.activeProject ? t.activeProject.stagingUrl : t.captureUrl,
          previewOnly: false,
          pendingCaptureUrl: undefined,
          snapshotHtml: null,
          auditContext: null
        }
      })
      sessionStorage.setItem('fullforce_app_tabs', JSON.stringify(serialized))
      sessionStorage.removeItem('fullforce_captured_html')
    } catch {}
  }, [tabs])

  useEffect(() => {
    let cancelled = false
    const hydrateWorkspaceHtml = async () => {
      // Migrate snapshots left by older releases before their Web Storage keys
      // are discarded, then load filesystem-backed snapshots for current tabs.
      await Promise.all(tabs.filter((tab) => isRenderableSnapshot(tab.snapshotHtml)).map((tab) =>
        window.electronAPI.saveWorkspaceHtml(tab.id, tab.snapshotHtml!).catch((error) => {
          console.warn('[Workspace HTML] Unable to migrate legacy tab:', error)
        })
      ))
      const editorTabs = tabs.filter((tab) => tab.view === 'editor' && !tab.snapshotHtml)
      if (editorTabs.length === 0) return
      const loaded = await Promise.all(editorTabs.map(async (tab) => ({
        tabId: tab.id,
        html: await window.electronAPI.loadWorkspaceHtml(tab.id),
        auditContext: await window.electronAPI.loadWorkspaceAuditContext(tab.id)
      })))
      if (cancelled) return
      const byTabId = new Map(loaded.filter((item) => isRenderableSnapshot(item.html)).map((item) => [item.tabId, item]))
      if (byTabId.size > 0) {
        setTabs((current) => current.map((tab) => {
          const loadedTab = byTabId.get(tab.id)
          return loadedTab ? { ...tab, snapshotHtml: loadedTab.html!, auditContext: loadedTab.auditContext } : tab
        }))
      }
    }
    void hydrateWorkspaceHtml().catch((error) => console.warn('[Workspace HTML] Unable to restore tabs:', error))
    return () => { cancelled = true }
    // Restore the tabs captured by the initial session metadata exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    sessionStorage.setItem('fullforce_active_tab_id', activeTabId)
  }, [activeTabId])

  useEffect(() => {
    const resetOpenWorkspaces = () => {
      setTabs((current) => {
        for (const tab of current) {
          sessionStorage.removeItem(`fullforce_snapshot_html_${tab.id}`)
          void window.electronAPI.deleteWorkspaceHtml(tab.id)
        }
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
    void window.electronAPI.deleteWorkspaceHtml(tabIdToClose)
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
      title: t.dashboardFolderName || 'Dashboard',
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

  const handleNewProject = (folderId?: string) => {
    updateActiveTab(t => ({
      ...t,
      prefillAdmin: '',
      prefillStaging: '',
      activeProject: null,
      newProjectFolderId: folderId,
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
      newProjectFolderId: undefined,
      skipAutoCapture: forceForm,
      view: 'capture',
      title: project.name || 'Capture'
    }))
  }

  const handleCapture = async (html: string, url: string, adminUrl: string, details: CaptureProjectDetails, auditContext?: AuditCaptureContext) => {
    const activeTab = tabs.find(t => t.id === activeTabId)
    const now = Date.now()
    const project: Project = activeTab?.activeProject
      ? {
          ...activeTab.activeProject,
          name: details.name || activeTab.activeProject.name,
          stagingUrl: url,
          adminUrl,
          figmaUrl: details.figmaUrl || undefined,
          googleSheetUrl: details.googleSheetUrl || undefined,
          mondayTicketId: details.mondayTicketId || activeTab.activeProject.mondayTicketId,
          ticketRef: details.ticketRef || activeTab.activeProject.ticketRef,
          lastOpenedAt: now
        }
      : {
          id: crypto.randomUUID(),
          name: details.name || deriveProjectName(url),
          adminUrl,
          stagingUrl: url,
          figmaUrl: details.figmaUrl || undefined,
          googleSheetUrl: details.googleSheetUrl || undefined,
          mondayTicketId: details.mondayTicketId,
          ticketRef: details.ticketRef,
          folderId: activeTab?.newProjectFolderId,
          createdAt: now,
          lastOpenedAt: now
        }

    await saveScopedProject(project)
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
    const tabId = activeTabId
    try {
      await window.electronAPI.saveWorkspaceHtml(tabId, html)
      if (auditContext) await window.electronAPI.saveWorkspaceAuditContext(tabId, auditContext)
    } catch (error) {
      // A cache write must never prevent a successful capture from opening.
      console.warn('[Workspace HTML] Capture will remain available in memory:', error)
    }

    updateActiveTab(t => ({
      ...t,
      activeProject: project,
      snapshotHtml: html,
      auditContext: auditContext || null,
      captureUrl: url,
      snapshotKey: t.snapshotKey + 1,
      view: 'editor',
      title: project.name || deriveProjectName(url)
    }))
  }

  const handleDashboardFolderChange = useCallback((location: {
    folderId: string | null
    folderName: string
    folderPath: string
  }) => {
    setTabs((current) => current.map((tab) => {
      if (tab.id !== activeTabId) return tab
      const dashboardTitle = location.folderName || 'Dashboard'
      const title = tab.view === 'dashboard' ? dashboardTitle : tab.title
      if (
        tab.dashboardFolderId === location.folderId &&
        tab.dashboardFolderName === location.folderName &&
        tab.dashboardFolderPath === location.folderPath &&
        tab.title === title
      ) return tab
      return {
        ...tab,
        title,
        dashboardFolderId: location.folderId,
        dashboardFolderName: location.folderName,
        dashboardFolderPath: location.folderPath,
      }
    }))
  }, [activeTabId])

  const handleAddProject = async (details: CaptureProjectDetails) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    const now = Date.now()
    const project: Project = {
      id: crypto.randomUUID(),
      name: details.name || deriveProjectName(details.stagingUrl),
      adminUrl: details.adminUrl,
      stagingUrl: details.stagingUrl,
      figmaUrl: details.figmaUrl || undefined,
      googleSheetUrl: details.googleSheetUrl || undefined,
      mondayTicketId: details.mondayTicketId,
          ticketRef: details.ticketRef,
      folderId: activeTab?.newProjectFolderId,
      createdAt: now,
      lastOpenedAt: now
    }
    await saveScopedProject(project)
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
    goToDashboard()
  }

  const handleProjectThumbnailCaptured = async (dataUrl: string) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    const project = activeTab?.activeProject
    if (!project || project.thumbnailUrl || !dataUrl.startsWith('data:image/')) return
    const updatedProject: Project = { ...project, thumbnailUrl: dataUrl }
    await saveScopedProject(updatedProject)
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
    updateActiveTab((tab) => ({ ...tab, activeProject: tab.activeProject?.id === updatedProject.id ? updatedProject : tab.activeProject }))
  }

  const handleProjectUpdated = useCallback(async (updatedProject: Project) => {
    await saveScopedProject(updatedProject)
    setTabs((current) => current.map((tab) =>
      tab.activeProject?.id === updatedProject.id
        ? { ...tab, activeProject: updatedProject }
        : tab
    ))
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
  }, [])

  const handleWorkspaceNavigate = useCallback(async (rawUrl: string) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    if (!activeTab) return { success: false, error: 'No active project tab.' }
    const ownerAtStart = localStorage.getItem('parity_account_owner_key')

    const targetUrl = normalizeWorkspaceUrl(rawUrl)
    if (!targetUrl) return { success: false, error: 'Enter a valid website URL.' }

    const result = await window.electronAPI.capture(targetUrl)
    if (ownerAtStart !== localStorage.getItem('parity_account_owner_key')) return { success: false, error: 'The active account changed. Try again.' }
    if (!result.success || !result.html) {
      return { success: false, error: result.error || 'Unable to capture this URL.' }
    }

    const lower = result.html.toLowerCase()
    if (result.is404 || result.isSessionExpired || lower.includes('<title>page not found') || lower.includes('class="error404"') || lower.includes('wp-login.php')) {
      return { success: false, error: result.isSessionExpired ? 'The website session has expired.' : 'The page could not be captured.' }
    }

    const previewOnly = !!activeTab.activeProject && !sameWorkspacePage(targetUrl, activeTab.activeProject.stagingUrl)
    if (!previewOnly) {
      await window.electronAPI.saveWorkspaceHtml(activeTab.id, result.html)
      if (result.auditContext) await window.electronAPI.saveWorkspaceAuditContext(activeTab.id, result.auditContext)
    }
    setTabs((current) => current.map((tab) => tab.id === activeTab.id ? {
      ...tab,
      snapshotHtml: result.html!,
      auditContext: result.auditContext || null,
      captureUrl: targetUrl,
      snapshotKey: tab.snapshotKey + 1,
      previewOnly,
      pendingCaptureUrl: previewOnly ? targetUrl : undefined,
    } : tab))
    return { success: true }
  }, [activeTabId, tabs])

  const handleCaptureFromWorkspace = async (sourceTabId: string, rawUrl: string, requestedFolderId?: string) => {
    const sourceTab = tabs.find((tab) => tab.id === sourceTabId)
    const targetUrl = normalizeWorkspaceUrl(rawUrl)
    if (!sourceTab || !targetUrl) return { success: false, error: 'This page is no longer available.' }
    const ownerAtStart = localStorage.getItem('parity_account_owner_key')
    const result = await window.electronAPI.capture(targetUrl)
    if (ownerAtStart !== localStorage.getItem('parity_account_owner_key')) return { success: false, error: 'The active account changed. Try again.' }
    if (!result.success || !result.html) return { success: false, error: result.error || 'Unable to capture this page.' }
    const lower = result.html.toLowerCase()
    if (result.is404 || result.isSessionExpired || lower.includes('<title>page not found') || lower.includes('class="error404"') || lower.includes('wp-login.php')) {
      return { success: false, error: result.isSessionExpired ? 'The website session has expired.' : 'This page could not be captured.' }
    }
    let folders: ProjectFolder[] = []
    try { folders = JSON.parse(localStorage.getItem('qa_project_folders') || '[]') } catch {}
    if (!Array.isArray(folders)) folders = []
    if (requestedFolderId && !folders.some((folder) => folder.id === requestedFolderId)) return { success: false, error: 'The selected folder no longer exists. Choose another location.' }
    const folderId = requestedFolderId
    const sourceProject = sourceTab.activeProject
    let adminUrl = ''
    try {
      if (sourceProject?.adminUrl && new URL(sourceProject.stagingUrl).origin === new URL(targetUrl).origin) adminUrl = sourceProject.adminUrl
    } catch {}
    const now = Date.now()
    const project: Project = {
      id: crypto.randomUUID(),
      name: deriveCapturedPageName(targetUrl, result.html),
      adminUrl,
      stagingUrl: targetUrl,
      folderId,
      createdAt: now,
      lastOpenedAt: now,
      localOwnerKey: ownerAtStart,
    }
    await window.electronAPI.saveProject(project, ownerAtStart)
    const tabId = `tab-${crypto.randomUUID()}`
    try {
      await window.electronAPI.saveWorkspaceHtml(tabId, result.html)
      if (result.auditContext) await window.electronAPI.saveWorkspaceAuditContext(tabId, result.auditContext)
    } catch (error) {
      console.warn('[Workspace HTML] New project will remain available in memory:', error)
    }
    if (ownerAtStart !== localStorage.getItem('parity_account_owner_key')) return { success: false, error: 'The active account changed. Reopen the project from Dashboard.' }
    setTabs((current) => [...current.map((tab) => tab.id === sourceTabId && tab.pendingCaptureUrl ? { ...tab, pendingCaptureUrl: undefined } : tab), {
      id: tabId,
      title: project.name,
      view: 'editor',
      snapshotHtml: result.html!,
      captureUrl: targetUrl,
      snapshotKey: 0,
      activeProject: project,
      auditContext: result.auditContext || null,
      prefillAdmin: adminUrl,
      prefillStaging: targetUrl,
      skipAutoCapture: false,
      workspaceTab: sourceTab.workspaceTab,
    }])
    setActiveTabId(tabId)
    window.dispatchEvent(new CustomEvent('qa_projects_updated'))
    return { success: true }
  }

  const handleOpenExistingFromWorkspace = (project: Project) => {
    const existing = tabs.find((tab) => tab.activeProject?.id === project.id && tab.view !== 'dashboard')
    if (existing) { setActiveTabId(existing.id); return }
    const id = `tab-${crypto.randomUUID()}`
    setTabs((current) => [...current, {
      id,
      title: project.name,
      view: 'capture',
      snapshotHtml: null,
      captureUrl: project.stagingUrl,
      snapshotKey: 0,
      activeProject: project,
      prefillAdmin: project.adminUrl || '',
      prefillStaging: project.stagingUrl,
      skipAutoCapture: false,
    }])
    setActiveTabId(id)
  }

  const handleWorkspaceTabChange = useCallback((workspaceTab: WorkspaceTab) => {
    setTabs((current) => current.map((tab) =>
      tab.id === activeTabId ? { ...tab, workspaceTab } : tab
    ))
  }, [activeTabId])

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
      if (!activeTab.previewOnly) {
        void window.electronAPI.saveWorkspaceHtml(activeTab.id, result.html).catch(() => {})
        if (result.auditContext) void window.electronAPI.saveWorkspaceAuditContext(activeTab.id, result.auditContext).catch(() => {})
      }
      updateActiveTab(t => ({ ...t, snapshotHtml: result.html!, auditContext: result.auditContext || null, snapshotKey: t.snapshotKey + 1 }))
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
  const feedbackArea: FeedbackArea = activeTab?.view === 'editor'
    ? activeTab.workspaceTab === 'live' ? 'live' : activeTab.workspaceTab === 'audit' ? 'audit' : activeTab.workspaceTab === 'automate' ? 'automate' : 'edit'
    : activeTab?.view === 'notes' ? 'notes' : activeTab?.view === 'dashboard' ? 'dashboard' : 'other'

  const paletteData = useRef<Promise<PaletteItem[]> | null>(null)
  const openSearchTab = (view: 'dashboard' | 'notes', values: Partial<TabState>) => {
    const id = `tab-search-${crypto.randomUUID()}`
    setTabs(current => [...current, { id, title: view === 'notes' ? 'Notes' : 'Dashboard', view, snapshotHtml: null, captureUrl: '', snapshotKey: 0, activeProject: null, prefillAdmin: '', prefillStaging: '', skipAutoCapture: false, ...values }])
    setActiveTabId(id)
  }
  usePaletteProvider({
    id: 'application', label: 'Workspace data',
    commands: () => [
      { id: 'app.dashboard', title: 'Open Dashboard', group: 'Commands', run: () => openUtilityView('dashboard') },
      { id: 'app.notes', title: 'Open Notes', group: 'Commands', run: () => openUtilityView('notes') },
      { id: 'app.capture', title: 'New project / capture website', group: 'Commands', run: () => handleNewProject() },
      { id: 'app.tab', title: 'New tab', group: 'Commands', run: handleNewTab },
      { id: 'app.settings', title: 'Open Settings', group: 'Commands', description: 'Account, integrations, shortcuts, appearance and directory', run: () => setSettingsOpen(true) },
      { id: 'app.feedback', title: 'Send feedback or report a bug', group: 'Commands', description: 'Tell us about a problem or suggest a Parity feature', run: () => setFeedbackOpen(true) },
      ...(['account', 'general', 'hotkeys', 'appearance', 'integrations'] as const).map(section => ({ id: `settings:${section}`, title: `Settings: ${section}`, group: 'Commands' as const, run: () => { setSettingsOpen(true); window.dispatchEvent(new CustomEvent('parity:settings-section', { detail: section })) } })),
      ...THEME_LIST.map(theme => ({ id: `theme:${theme.id}`, title: `Theme: ${theme.name}`, description: theme.description, group: 'Commands' as const, run: () => { const next = { ...settings, theme: theme.id }; setSettings(next); saveSettings(next) } })),
      ...tabs.map(tab => ({ id: `tab:${tab.id}`, title: tab.title, description: `Switch to ${tab.view} tab`, group: 'Tabs' as const, run: () => setActiveTabId(tab.id) })),
      ...(activeTab?.view === 'editor' ? [] : HOTKEY_DEFINITIONS.map(command => ({ id: `workspace:${command.key}`, title: command.label, description: command.description, shortcut: settings.hotkeys[command.key], group: 'Commands' as const, disabled: 'Open a captured project first', run: () => {} }))),
    ],
    search: async (query, signal, options) => {
      const owner = localStorage.getItem('parity_account_owner_key')
      if (!paletteData.current) paletteData.current = (async () => {
        const [projects, ticketState] = await Promise.all([window.electronAPI.getProjects(), owner ? window.electronAPI.ticketsList().catch(() => null) : null])
        if (owner !== localStorage.getItem('parity_account_owner_key')) return []
        let folders: ProjectFolder[] = []
        try { folders = JSON.parse(localStorage.getItem('qa_project_folders') || '[]') } catch {}
        const guard = (run: () => void) => { if (owner !== localStorage.getItem('parity_account_owner_key')) throw new Error('Account changed. Search again.'); run() }
        return workspaceItems({ projects, folders, tickets: ticketState?.ownerKey === owner ? ticketState.records.map(record => record.ticket) : [], notes: getPaletteNotes(owner) }, {
          project: project => guard(() => handleOpenProject(project)),
          folder: folder => guard(() => openSearchTab('dashboard', { dashboardFolderId: folder.id, title: folder.name, dashboardFolderName: folder.name })),
          ticket: ticket => guard(() => openSearchTab('dashboard', { initialTicketId: ticket.id })),
          note: note => guard(() => openSearchTab('notes', { initialNoteId: note.id })),
        })
      })()
      const items = await paletteData.current
      if (signal.aborted || owner !== localStorage.getItem('parity_account_owner_key')) return { items: [] }
      return rankItemsAsync(options.group === 'All' ? items : items.filter(item => item.group === options.group), query, signal, options.limit)
    },
    release: () => { paletteData.current = null },
  })

  const persistTabHtml = (tabId: string, mountedSnapshotKey: number, updatedHtml: string) => {
    // Reject an iframe's transient about:blank document. Persisting that value
    // would replace the capture and remount GrapesJS with an empty Body.
    if (!isRenderableSnapshot(updatedHtml)) return
    setTabs((prev) => {
      const currentTab = prev.find((tab) => tab.id === tabId)
      // Ignore teardown from an editor that was replaced by a newer recapture.
      if (!currentTab || currentTab.snapshotKey !== mountedSnapshotKey) return prev
      if (!currentTab.previewOnly) void window.electronAPI.saveWorkspaceHtml(tabId, updatedHtml).catch((error) => {
        console.warn('[Workspace HTML] Unable to persist editor changes:', error)
      })
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
                  title={t.dashboardFolderPath ? `Dashboard / ${t.dashboardFolderPath}` : t.title}
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
          <button
            type="button"
            className={`app-feedback-btn ${feedbackOpen ? 'active' : ''}`}
            onClick={() => setFeedbackOpen(true)}
            title="Feedback & report a bug"
            aria-label="Feedback and report a bug"
            aria-pressed={feedbackOpen}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5Z" /><path d="M8 9h8M8 12h5" /></svg>
          </button>
          <button
            type="button"
            className={`app-settings-btn ${settingsOpen ? 'active' : ''}`}
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
            aria-pressed={settingsOpen}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22h-4v-.09A1.65 1.65 0 0 0 9 20.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 10a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.92 5 1.65 1.65 0 0 0 10 3.49V3h4v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.12.62.58 1.12 1.18 1.31l.42.13v4l-.09.03A1.65 1.65 0 0 0 19.4 15Z" />
            </svg>
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
        <button onClick={() => window.dispatchEvent(new Event('parity:open-palette'))} title="Search and commands (Ctrl+Shift+F)" aria-label="Search and commands"><svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><span>Search and commands</span></button>
        <button onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2.3-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2.3.7v3l2.3.7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2.3h3l.7-2.3 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z"/></svg><span>Settings</span></button>
        <button className={activityBarPinned ? 'pinned' : ''} onClick={toggleActivityBarPin} title={activityBarPinned ? 'Auto-hide sidebar' : 'Keep sidebar visible'} aria-label={activityBarPinned ? 'Auto-hide sidebar' : 'Keep sidebar visible'}><svg viewBox="0 0 24 24"><path d="M8 4h8l-1 6 3 3H6l3-3zM12 13v8"/></svg><span>{activityBarPinned ? 'Auto-hide' : 'Pin sidebar'}</span></button>
      </aside>

      {/* Tab Workspaces Render Area */}
      <div className="app-workspace-host">
        {accountReady && activeTab && (
          <div key={activeTab.id} style={{ height: '100%', width: '100%' }}>
            {activeTab.view === 'editor' && activeTab.snapshotHtml ? (
              <EditorWorkspace
                key={`${activeTab.id}:${activeTab.snapshotKey}`}
                html={activeTab.snapshotHtml}
                sourceUrl={activeTab.captureUrl}
                auditContext={activeTab.auditContext}
                hotkeys={settings.hotkeys}
                project={activeTab.activeProject}
                onReset={handleReset}
                onNewCapture={goToDashboard}
                onOpenSettings={() => setSettingsOpen(true)}
                onPersistHtml={(updatedHtml) => persistTabHtml(activeTab.id, activeTab.snapshotKey, updatedHtml)}
                onThumbnailCaptured={handleProjectThumbnailCaptured}
                onProjectUpdated={handleProjectUpdated}
                initialWorkspaceTab={activeTab.workspaceTab}
                onWorkspaceTabChange={handleWorkspaceTabChange}
                onNavigateCapture={handleWorkspaceNavigate}
                onCaptureNewProject={(url, folderId) => handleCaptureFromWorkspace(activeTab.id, url, folderId)}
                onOpenExistingProject={handleOpenExistingFromWorkspace}
                pendingCaptureUrl={activeTab.pendingCaptureUrl}
                onDismissPendingCapture={() => setTabs((current) => current.map((tab) => tab.id === activeTab.id && tab.pendingCaptureUrl ? { ...tab, pendingCaptureUrl: undefined } : tab))}
              />
            ) : activeTab.view === 'notes' ? (
              <NotesWorkspace initialNoteId={activeTab.initialNoteId} onOpenDashboard={() => openUtilityView('dashboard')} />
            ) : (
              <>
                <Dashboard
                  onNewProject={handleNewProject}
                  onOpenProject={handleOpenProject}
                  onOpenSettings={() => setSettingsOpen(true)}
                  initialFolderId={activeTab.dashboardFolderId}
                  initialTicketId={activeTab.initialTicketId}
                  onFolderChange={handleDashboardFolderChange}
                />
                {activeTab.view === 'capture' && (
                  <CaptureScreen
                    onCapture={handleCapture}
                    onAdd={handleAddProject}
                    onBack={goToDashboard}
                    initialName={activeTab.activeProject?.name || ''}
                    initialAdminUrl={activeTab.prefillAdmin}
                    initialStagingUrl={activeTab.prefillStaging}
                    initialFigmaUrl={activeTab.activeProject?.figmaUrl || ''}
                    initialSheetUrl={activeTab.activeProject?.googleSheetUrl || ''}
                    isNewProject={!activeTab.activeProject}
                    autoCapture={activeTab.skipAutoCapture ? false : !!(activeTab.activeProject && activeTab.activeProject.stagingUrl && activeTab.activeProject.adminUrl)}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Global Settings Modal */}
      <CommandPalette scopeKey={`${viewOwner}:${activeTab?.id}:${activeTab?.workspaceTab}:${activeTab?.snapshotKey}`} />
      <SettingsModal
        isOpen={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(newSettings) => {
          setSettings(newSettings)
          applyTheme(newSettings.theme)
        }}
      />
      {feedbackOpen && <FeedbackModal
        initialArea={feedbackArea}
        onClose={() => setFeedbackOpen(false)}
        onOpenAccount={() => {
          setFeedbackOpen(false)
          setSettingsOpen(true)
          window.dispatchEvent(new Event('parity:open-account'))
        }}
      />}
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

function deriveCapturedPageName(url: string, html: string): string {
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (path) {
      const name = decodeURIComponent(path).replace(/\.[a-z\d]+$/i, '').replace(/[-_]+/g, ' ').trim()
      if (name) return name.replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 100)
    }
    const title = new DOMParser().parseFromString(html, 'text/html').title.trim()
    if (title) return title.slice(0, 100)
  } catch {}
  return deriveProjectName(url)
}
