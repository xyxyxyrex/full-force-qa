import { useState } from 'react'
import type { Project } from '../../shared/types'
import Dashboard from './components/Dashboard'
import CaptureScreen from './components/CaptureScreen'
import EditorWorkspace from './components/EditorWorkspace'

type View = 'dashboard' | 'capture' | 'editor'

export default function App() {
  const [view, setView] = useState<View>('dashboard')
  const [snapshotHtml, setSnapshotHtml] = useState<string | null>(null)
  const [captureUrl, setCaptureUrl] = useState('')
  const [snapshotKey, setSnapshotKey] = useState(0)
  const [activeProject, setActiveProject] = useState<Project | null>(null)

  // Pre-fill CaptureScreen when opening a saved project
  const [prefillAdmin, setPrefillAdmin] = useState('')
  const [prefillStaging, setPrefillStaging] = useState('')

  const goToDashboard = () => {
    setView('dashboard')
    setSnapshotHtml(null)
    setActiveProject(null)
  }

  const handleNewProject = () => {
    setPrefillAdmin('')
    setPrefillStaging('')
    setActiveProject(null)
    setView('capture')
  }

  const handleOpenProject = (project: Project) => {
    setPrefillAdmin(project.adminUrl)
    setPrefillStaging(project.stagingUrl)
    setActiveProject(project)
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
      setSnapshotHtml(result.html)
      setSnapshotKey((k) => k + 1)
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

  if (view === 'capture') {
    return (
      <CaptureScreen
        onCapture={handleCapture}
        onBack={goToDashboard}
        initialAdminUrl={prefillAdmin}
        initialStagingUrl={prefillStaging}
        autoCapture={!!activeProject}
      />
    )
  }

  return (
    <Dashboard
      onNewProject={handleNewProject}
      onOpenProject={handleOpenProject}
    />
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
