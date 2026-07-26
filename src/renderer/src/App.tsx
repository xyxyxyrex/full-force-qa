import { useState, useEffect, useRef } from 'react'
import type { Project } from '../../shared/types'
import Dashboard from './components/Dashboard'
import CaptureScreen from './components/CaptureScreen'
import EditorWorkspace from './components/EditorWorkspace'
import { fetchMondayTicketsApi } from './utils/mondayApi'

type View = 'dashboard' | 'capture' | 'editor'

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [snapshotHtml, setSnapshotHtml] = useState<string | null>(null)
  const [captureUrl, setCaptureUrl] = useState('')
  const [snapshotKey, setSnapshotKey] = useState(0)
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [syncKey, setSyncKey] = useState(0)
  const lastSyncRef = useRef<number>(0)

  // Pre-fill CaptureScreen when opening a saved project
  const [prefillAdmin, setPrefillAdmin] = useState('')
  const [prefillStaging, setPrefillStaging] = useState('')

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

    // Initial poll
    doPoll()

    // Poll every 2 minutes (120,000 ms) regardless of active view
    const interval = setInterval(doPoll, 120000)
    return () => clearInterval(interval)
  }, [])

  const goToDashboard = () => {
    setView('dashboard')
    setSnapshotHtml(null)
    setActiveProject(null)
    // Auto-sync if returning to dashboard and last sync was > 30 seconds ago
    const token = localStorage.getItem('monday_api_token')
    if (token && Date.now() - lastSyncRef.current > 30000) {
      fetchMondayTicketsApi(token).then(() => {
        lastSyncRef.current = Date.now()
        window.dispatchEvent(new CustomEvent('monday_tickets_updated'))
      })
    }
  }

  const [skipAutoCapture, setSkipAutoCapture] = useState(false)

  const handleNewProject = () => {
    setPrefillAdmin('')
    setPrefillStaging('')
    setActiveProject(null)
    setSkipAutoCapture(true)
    setView('capture')
  }

  const handleOpenProject = (project: Project, forceForm: boolean = false) => {
    setPrefillAdmin(project.adminUrl || '')
    setPrefillStaging(project.stagingUrl || '')
    setActiveProject(project)
    setSkipAutoCapture(forceForm)
    setView('capture')
  }

  const handleCapture = async (html: string, url: string, adminUrl: string) => {
    const now = Date.now()
    const project: Project = activeProject
      ? { ...activeProject, stagingUrl: url, adminUrl, lastOpenedAt: now }
      : {
          id: crypto.randomUUID(),
          name: deriveProjectName(url),
          adminUrl,
          stagingUrl: url,
          createdAt: now,
          lastOpenedAt: now
        }

    await window.electronAPI.saveProject(project)
    setActiveProject(project)
    setSnapshotHtml(html)
    setCaptureUrl(url)
    setSnapshotKey((k) => k + 1)
    setView('editor')
  }

  const handleReset = async () => {
    if (!captureUrl) return
    const result = await window.electronAPI.capture(captureUrl)
    if (result.success && result.html) {
      const lower = result.html.toLowerCase()
      const is404 = lower.includes('<title>page not found') || lower.includes('class="error404"') || lower.includes('wp-login.php')
      if (is404) {
        setView('capture')
        return
      }
      setSnapshotHtml(result.html)
      setSnapshotKey((k) => k + 1)
    } else if (result.is404 || result.isSessionExpired) {
      setView('capture')
    }
  }

  if (view === 'editor' && snapshotHtml) {
    return (
      <EditorWorkspace
        key={snapshotKey}
        html={snapshotHtml}
        sourceUrl={captureUrl}
        onReset={handleReset}
        onNewCapture={goToDashboard}
      />
    )
  }

  return (
    <>
      <Dashboard
        onNewProject={handleNewProject}
        onOpenProject={handleOpenProject}
      />
      {view === 'capture' && (
        <CaptureScreen
          onCapture={handleCapture}
          onBack={goToDashboard}
          initialAdminUrl={prefillAdmin}
          initialStagingUrl={prefillStaging}
          autoCapture={skipAutoCapture ? false : !!(activeProject && activeProject.stagingUrl && activeProject.adminUrl)}
        />
      )}
    </>
  )
}

function deriveProjectName(url: string): string {
  try {
    const u = new URL(url)
    // Use hostname without www
    return u.hostname.replace(/^www\./, '')
  } catch {
    return 'Untitled Project'
  }
}
