import { useEffect, useState } from 'react'
import type { Project } from '../../../shared/types'
import './Dashboard.css'

interface Props {
  onNewProject: () => void
  onOpenProject: (project: Project) => void
}

export default function Dashboard({ onNewProject, onOpenProject }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.electronAPI.getProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
  }, [])

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await window.electronAPI.deleteProject(id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - ts

    if (diff < 60_000) return 'Just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
    return d.toLocaleDateString()
  }

  const getDomain = (url: string) => {
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        {/* Header */}
        <div className="dashboard-header">
          <div className="dashboard-title-row">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#4C8BF5" />
              <path d="M8 12h16v2H8zm0 5h12v2H8zm0 5h8v2H8z" fill="#fff" />
            </svg>
            <h1>QA Snapshot Editor</h1>
          </div>
          <button className="new-project-btn" onClick={onNewProject}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            New Capture
          </button>
        </div>

        {/* Recent projects */}
        <div className="dashboard-section">
          <h2 className="section-label">Recent Projects</h2>

          {loading && (
            <div className="dashboard-empty">Loading...</div>
          )}

          {!loading && projects.length === 0 && (
            <div className="dashboard-empty">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#404040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="36" height="36" rx="4" />
                  <path d="M6 18h36M18 18v24" />
                </svg>
              </div>
              <p>No projects yet</p>
              <p className="empty-hint">Click "New Capture" to get started</p>
            </div>
          )}

          {!loading && projects.length > 0 && (
            <div className="project-grid">
              {projects.map((project) => (
                <button
                  key={project.id}
                  className="project-card"
                  onClick={() => onOpenProject(project)}
                >
                  <div className="project-card-top">
                    <div className="project-favicon">
                      {project.name.charAt(0).toUpperCase()}
                    </div>
                    <button
                      className="project-delete"
                      onClick={(e) => handleDelete(e, project.id)}
                      title="Remove project"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                  <div className="project-name">{project.name}</div>
                  <div className="project-url">{getDomain(project.stagingUrl)}</div>
                  <div className="project-meta">{formatDate(project.lastOpenedAt)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
