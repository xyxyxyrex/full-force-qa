import { useEffect, useState, useMemo } from 'react'
import type { Project } from '../../../shared/types'
import mondayLogo from '../assets/monday-icon-svgrepo-com.svg'
import figmaIcon from '../assets/figma.png'
import sheetsIcon from '../assets/sheets.png'
import { fetchMondayTicketsApi, MondayTicket, MondayLink } from '../utils/mondayApi'
import './Dashboard.css'

export type { MondayTicket, MondayLink }

interface Props {
  onNewProject: () => void
  onOpenProject: (project: Project, forceForm?: boolean) => void
}

type SortOption = 'recent' | 'oldest' | 'name-asc' | 'name-desc'
type ViewMode = 'cards' | 'list'

interface ContextMenuState {
  x: number
  y: number
  ticket: MondayTicket
  isActive: boolean
}

const GRADIENTS = [
  'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0d324d 0%, #7f5a83 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  'linear-gradient(135deg, #1e130c 0%, #4a2511 100%)',
  'linear-gradient(135deg, #11292b 0%, #1e5254 100%)'
]

function getGradientForId(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % GRADIENTS.length
  return GRADIENTS[index]
}

function formatDate(timestamp: number): string {
  if (!timestamp) return ''
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function getDomain(urlStr: string): string {
  if (!urlStr) return ''
  try {
    const url = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`)
    return url.hostname.replace(/^www\./, '')
  } catch {
    return urlStr
  }
}

export default function Dashboard({ onNewProject, onOpenProject }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [viewMode, setViewMode] = useState<ViewMode>('cards')
  const [trashExpanded, setTrashExpanded] = useState(false)

  // Monday.com state
  const [mondayConnected, setMondayConnected] = useState(() => !!localStorage.getItem('monday_api_token'))
  const [mondayToken, setMondayToken] = useState(() => localStorage.getItem('monday_api_token') || '')
  const [mondayTickets, setMondayTickets] = useState<MondayTicket[]>(() => {
    try {
      const stored = localStorage.getItem('monday_tickets')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const [mondayModalOpen, setMondayModalOpen] = useState(false)
  const [tempTokenInput, setTempTokenInput] = useState(mondayToken)
  const [mondaySyncing, setMondaySyncing] = useState(false)
  const [mondaySectionExpanded, setMondaySectionExpanded] = useState(true)
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<string>>(new Set())

  // Active Monday Ticket IDs
  const [activeTicketIds, setActiveTicketIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('active_monday_ticket_ids')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })

  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Close context menu on outside click
  useEffect(() => {
    const handleClose = () => setContextMenu(null)
    window.addEventListener('click', handleClose)
    return () => window.removeEventListener('click', handleClose)
  }, [])

  useEffect(() => {
    window.electronAPI.getProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
    if (mondayToken) {
      fetchMondayTickets(mondayToken)
    }

    const handleUpdate = () => {
      try {
        const stored = localStorage.getItem('monday_tickets')
        if (stored) setMondayTickets(JSON.parse(stored))
      } catch { /* ignore */ }
    }
    window.addEventListener('monday_tickets_updated', handleUpdate)
    return () => window.removeEventListener('monday_tickets_updated', handleUpdate)
  }, [])

  const toggleActiveTicket = (ticketId: string) => {
    setActiveTicketIds((prev) => {
      const next = prev.includes(ticketId)
        ? prev.filter((id) => id !== ticketId)
        : [...prev, ticketId]
      localStorage.setItem('active_monday_ticket_ids', JSON.stringify(next))
      return next
    })
    setContextMenu(null)
  }

  // Active Monday tickets list
  const activeMondayTickets = useMemo(() => {
    return mondayTickets.filter((t) => activeTicketIds.includes(t.id))
  }, [mondayTickets, activeTicketIds])

  // Group Monday tickets by status
  const STATUS_ORDER = [
    'In Progress', 'Requested', 'On Hold/Blocked', 'Pending From Client',
    'Dev Complete', 'Des Complete', 'For Client Approval',
    'QA Passed', 'RSO Passed', 'Approved', 'Archive'
  ]
  const ticketsByStatus = useMemo(() => {
    const groups: Record<string, MondayTicket[]> = {}
    for (const ticket of mondayTickets) {
      const status = ticket.status || 'Other'
      if (!groups[status]) groups[status] = []
      groups[status].push(ticket)
    }
    const sorted: [string, MondayTicket[]][] = []
    for (const s of STATUS_ORDER) {
      if (groups[s]) { sorted.push([s, groups[s]]); delete groups[s] }
    }
    for (const [s, tickets] of Object.entries(groups)) {
      sorted.push([s, tickets])
    }
    return sorted
  }, [mondayTickets])

  const toggleStatusCollapse = (status: string) => {
    setCollapsedStatuses(prev => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // Modals state
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [deleteConfirmProject, setDeleteConfirmProject] = useState<Project | null>(null)
  const [permanentDeleteProject, setPermanentDeleteProject] = useState<Project | null>(null)

  // Edit form state
  const [editName, setEditName] = useState('')
  const [editAdminUrl, setEditAdminUrl] = useState('')
  const [editStagingUrl, setEditStagingUrl] = useState('')

  // Manual Monday API token fallback state
  const [showTokenFallbackModal, setShowTokenFallbackModal] = useState(false)
  const [manualTokenInput, setManualTokenInput] = useState('')
  const [manualTokenError, setManualTokenError] = useState('')

  const handleMondayLogin = async () => {
    setMondaySyncing(true)
    try {
      const res = await window.electronAPI.mondayLogin()
      if (res.success && res.token) {
        localStorage.setItem('monday_api_token', res.token)
        setMondayToken(res.token)
        setMondayConnected(true)
        fetchMondayTickets(res.token)
      } else if (
        res.error &&
        res.error !== 'Login window was closed' &&
        res.error !== 'Login cancelled' &&
        res.error !== 'No authorization code received'
      ) {
        setShowTokenFallbackModal(true)
      }
    } catch {
      // login window closed or cancelled
    } finally {
      setMondaySyncing(false)
    }
  }

  const handleSaveManualToken = async () => {
    const trimmed = manualTokenInput.trim()
    if (!trimmed) {
      setManualTokenError('Please enter a valid Monday API token.')
      return
    }
    setMondaySyncing(true)
    setManualTokenError('')
    try {
      const tickets = await fetchMondayTicketsApi(trimmed)
      localStorage.setItem('monday_api_token', trimmed)
      setMondayToken(trimmed)
      setMondayConnected(true)
      if (tickets && tickets.length > 0) {
        setMondayTickets(tickets)
      }
      setShowTokenFallbackModal(false)
      setManualTokenInput('')
    } catch {
      setManualTokenError('Failed to connect with token. Please verify the API token.')
    } finally {
      setMondaySyncing(false)
    }
  }

  const handleDisconnectMonday = () => {
    localStorage.removeItem('monday_api_token')
    localStorage.removeItem('monday_tickets')
    setMondayToken('')
    setMondayConnected(false)
    setMondayTickets([])
  }

  const fetchMondayTickets = async (token: string) => {
    setMondaySyncing(true)
    try {
      const fetched = await fetchMondayTicketsApi(token)
      if (fetched && fetched.length > 0) {
        setMondayTickets(fetched)
      }
    } catch (err) {
      console.error('[Monday] Fetch error:', err)
    } finally {
      setMondaySyncing(false)
    }
  }

  const handleLaunchTicket = (ticket: MondayTicket) => {
    if (ticket.googleSheetUrl) {
      localStorage.setItem('qa_google_sheet_url', ticket.googleSheetUrl)
    }
    const project: Project = {
      id: 'monday-' + ticket.id,
      name: ticket.name,
      stagingUrl: ticket.stagingUrl || '',
      adminUrl: ticket.adminUrl || '',
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    onOpenProject(project)
  }

  // Open Edit Modal
  const startEditing = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setEditingProject(project)
    setEditName(project.name)
    setEditAdminUrl(project.adminUrl)
    setEditStagingUrl(project.stagingUrl)
  }

  // Save Edit
  const handleSaveEdit = async () => {
    if (!editingProject) return
    const updated: Project = {
      ...editingProject,
      name: editName.trim() || editingProject.name,
      adminUrl: editAdminUrl.trim(),
      stagingUrl: editStagingUrl.trim()
    }
    await window.electronAPI.saveProject(updated)
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === updated.id)
      return exists ? prev.map((p) => (p.id === updated.id ? updated : p)) : [...prev, updated]
    })
    setEditingProject(null)
  }

  // Move to Trash (Soft Delete)
  const handleMoveToTrash = async (project: Project) => {
    const updated: Project = { ...project, inTrash: true, deletedAt: Date.now() }
    await window.electronAPI.saveProject(updated)
    setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
    setDeleteConfirmProject(null)
  }

  // Restore from Trash
  const handleRestore = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    const updated: Project = { ...project, inTrash: false }
    delete updated.deletedAt
    await window.electronAPI.saveProject(updated)
    setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
  }

  // Permanent Delete from Disk
  const handlePermanentDelete = async (projectId: string) => {
    await window.electronAPI.deleteProject(projectId)
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
    setPermanentDeleteProject(null)
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

  const getStatusColor = (status: string = ''): string => {
    const s = status.toLowerCase()
    if (s.includes('dev complete') || s.includes('in progress')) return '#3fb950'
    if (s.includes('requested')) return '#388bfd'
    if (s.includes('qa passed') || s.includes('approved') || s.includes('rso passed')) return '#a371f7'
    if (s.includes('hold') || s.includes('pending') || s.includes('client')) return '#d29922'
    return '#8b949e'
  }

  // Filtered & Sorted Active Projects (Unifies local projects and active Monday tickets without duplication)
  type DisplayProject = Project & { mondayTicket?: MondayTicket }

  const activeProjects = useMemo(() => {
    const localActive = projects.filter((p) => !p.inTrash)
    const result: DisplayProject[] = []
    const seenIds = new Set<string>()

    // 1. Process active Monday tickets first
    for (const ticket of mondayTickets) {
      if (!activeTicketIds.includes(ticket.id)) continue
      const monId = 'monday-' + ticket.id

      // Check if user has already captured or saved this ticket into a local project
      const existingLocal = localActive.find(
        (p) => p.id === monId || (p.stagingUrl && ticket.stagingUrl && p.stagingUrl.replace(/\/$/, '') === ticket.stagingUrl.replace(/\/$/, ''))
      )

      if (existingLocal) {
        if (!seenIds.has(existingLocal.id)) {
          seenIds.add(existingLocal.id)
          result.push({
            ...existingLocal,
            mondayTicket: ticket
          })
        }
      } else {
        if (!seenIds.has(monId)) {
          seenIds.add(monId)
          result.push({
            id: monId,
            name: ticket.name,
            stagingUrl: ticket.stagingUrl || '',
            adminUrl: ticket.adminUrl || '',
            createdAt: Date.now(),
            lastOpenedAt: Date.now(),
            mondayTicket: ticket
          })
        }
      }
    }

    // 2. Add remaining local projects EXCEPT inactive monday- projects
    for (const p of localActive) {
      if (seenIds.has(p.id)) continue

      if (p.id.startsWith('monday-')) {
        const rawTicketId = p.id.replace('monday-', '')
        if (!activeTicketIds.includes(rawTicketId)) {
          continue // Exclude inactive Monday tickets
        }
      }

      seenIds.add(p.id)
      result.push(p)
    }

    return result
      .filter((p) => {
        if (!searchQuery.trim()) return true
        const q = searchQuery.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          p.stagingUrl.toLowerCase().includes(q) ||
          p.adminUrl.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        if (sortBy === 'recent') return b.lastOpenedAt - a.lastOpenedAt
        if (sortBy === 'oldest') return a.lastOpenedAt - b.lastOpenedAt
        if (sortBy === 'name-asc') return a.name.localeCompare(b.name)
        if (sortBy === 'name-desc') return b.name.localeCompare(a.name)
        return 0
      })
  }, [projects, mondayTickets, activeTicketIds, searchQuery, sortBy])

  // Pinned Projects State
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('pinned_project_ids')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })

  const togglePinProject = (projectId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    setPinnedProjectIds((prev) => {
      const isPinned = prev.includes(projectId)
      const updated = isPinned ? prev.filter((id) => id !== projectId) : [...prev, projectId]
      localStorage.setItem('pinned_project_ids', JSON.stringify(updated))
      return updated
    })
  }

  const pinnedProjects = useMemo(() => {
    return activeProjects.filter((p) => pinnedProjectIds.includes(p.id))
  }, [activeProjects, pinnedProjectIds])

  const unpinnedActiveProjects = useMemo(() => {
    return activeProjects.filter((p) => !pinnedProjectIds.includes(p.id))
  }, [activeProjects, pinnedProjectIds])

  // Trash Projects
  const trashProjects = useMemo(() => {
    return projects.filter((p) => p.inTrash)
  }, [projects])

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
          <div className="dashboard-header-actions">
            <button
              className="figma-global-login-btn"
              onClick={() => {
                if (typeof (window.electronAPI as any)?.figmaLoginWindow === 'function') {
                  ;(window.electronAPI as any).figmaLoginWindow()
                } else {
                  window.open('https://www.figma.com/login', '_blank', 'width=1024,height=768')
                }
              }}
              title="Sign in to Figma in-app globally — persists across all projects and sessions"
            >
              <img src={figmaIcon} alt="Figma" width="16" height="16" style={{ objectFit: 'contain' }} />
              <span>Login to Figma</span>
            </button>
            <button className="new-project-btn" onClick={onNewProject}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
              New Capture
            </button>
          </div>
        </div>

        {/* Search, Sort, View Controls Bar */}
        <div className="dashboard-controls-bar">
          <div className="search-box">
            <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="search-input"
              placeholder="Search projects by title or URL..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="search-clear-btn" onClick={() => setSearchQuery('')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          <div className="controls-right">
            {/* Sort Dropdown */}
            <div className="sort-dropdown-wrap">
              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
              >
                <option value="recent">Sort by: Recent</option>
                <option value="oldest">Sort by: Oldest</option>
                <option value="name-asc">Sort by: Name (A–Z)</option>
                <option value="name-desc">Sort by: Name (Z–A)</option>
              </select>
            </div>

            {/* View Mode Segmented Toggle */}
            <div className="view-mode-toggle">
              <button
                className={`view-mode-btn ${viewMode === 'cards' ? 'active' : ''}`}
                onClick={() => setViewMode('cards')}
                title="Grid Card View"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </button>
              <button
                className={`view-mode-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
                title="Tabular List View"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* 1. PINNED PROJECTS SECTION (Top priority if any project is pinned) */}
        {!loading && pinnedProjects.length > 0 && (
          <div className="dashboard-section pinned-section" style={{ marginBottom: 28 }}>
            <div className="section-label-row">
              <h2 className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#38bdf8' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#38bdf8" stroke="#38bdf8" strokeWidth="2">
                  <path d="M12 17v5M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7z" />
                </svg>
                <span>PINNED PROJECTS ({pinnedProjects.length})</span>
              </h2>
            </div>

            {viewMode === 'cards' && (
              <div className="project-grid">
                {pinnedProjects.map((project) => {
                  const isMonday = !!project.mondayTicket
                  const statusColor = getStatusColor(project.mondayTicket?.status)
                  const isPinned = true

                  return (
                    <div
                      key={project.id}
                      className={`project-card ${isMonday ? 'has-monday-badge' : ''} is-pinned-card`}
                      onClick={() => {
                        if (isMonday && !project.adminUrl) {
                          handleLaunchTicket(project.mondayTicket!)
                        } else {
                          onOpenProject(project)
                        }
                      }}
                    >
                      <div className="project-thumbnail" style={{ background: project.thumbnailUrl ? 'none' : getGradientForId(project.id) }}>
                        {project.thumbnailUrl ? (
                          <img src={project.thumbnailUrl} alt={project.name} className="thumbnail-img" />
                        ) : (
                          <div className="gradient-badge">
                            {getDomain(project.stagingUrl || project.name).charAt(0).toUpperCase()}
                          </div>
                        )}
                        {isMonday && (
                          <div className="monday-circle-badge" style={{ borderColor: statusColor }} title={`Monday Ticket: ${project.mondayTicket?.status}`}>
                            <img src={mondayLogo} alt="Monday" width="14" height="14" />
                          </div>
                        )}
                        <div className="card-actions-overlay" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="card-action-btn pin-btn pinned"
                            onClick={(e) => togglePinProject(project.id, e)}
                            title="Unpin project"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="#38bdf8" stroke="#38bdf8" strokeWidth="2">
                              <path d="M12 17v5M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7z" />
                            </svg>
                          </button>
                          <button className="card-action-btn edit-btn" onClick={(e) => { e.stopPropagation(); onOpenProject(project, true) }} title="Edit Settings">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                          </button>
                          <button className="card-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); setDeleteConfirmProject(project) }} title="Move to Trash">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                          </button>
                        </div>
                      </div>
                      <div className="project-card-body">
                        <div className="project-name" title={project.name}>{project.name}</div>
                        <div className="project-url" title={project.stagingUrl}>{getDomain(project.stagingUrl)}</div>
                        <div className="project-meta-row">
                          <span className="project-meta">{formatDate(project.lastOpenedAt)}</span>
                          {isMonday && (
                            <span className={`monday-status-pill status-${project.mondayTicket?.status.toLowerCase().replace(/\s+/g, '-')}`} style={{ marginLeft: 'auto', fontSize: 9 }}>
                              {project.mondayTicket?.status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 2. ACTIVE PROJECTS SECTION */}
        <div className="dashboard-section" style={{ marginBottom: 28 }}>
          <div className="section-label-row">
            <h2 className="section-label">ACTIVE PROJECTS ({unpinnedActiveProjects.length})</h2>
          </div>

          {loading && <div className="dashboard-empty">Loading projects...</div>}

          {!loading && activeProjects.length === 0 && (
            <div className="dashboard-empty">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#404040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="36" height="36" rx="4" />
                  <path d="M6 18h36M18 18v24" />
                </svg>
              </div>
              <p>{searchQuery ? 'No matching projects found' : 'No active projects yet'}</p>
              <p className="empty-hint">{searchQuery ? 'Try clearing your search query' : 'Right-click a Monday ticket or click "New Capture" to get started'}</p>
            </div>
          )}

          {!loading && unpinnedActiveProjects.length > 0 && (
            <>
              {viewMode === 'cards' && (
                <div className="project-grid">
                  {unpinnedActiveProjects.map((project) => {
                    const isMonday = !!project.mondayTicket
                    const statusColor = getStatusColor(project.mondayTicket?.status)

                    return (
                      <div
                        key={project.id}
                        className={`project-card ${isMonday ? 'has-monday-badge' : ''}`}
                        onClick={() => {
                          if (isMonday && !project.adminUrl) {
                            handleLaunchTicket(project.mondayTicket!)
                          } else {
                            onOpenProject(project)
                          }
                        }}
                        onContextMenu={(e) => {
                          if (isMonday) {
                            e.preventDefault()
                            setContextMenu({ x: e.clientX, y: e.clientY, ticket: project.mondayTicket!, isActive: true })
                          }
                        }}
                      >
                        <div className="project-thumbnail" style={{ background: project.thumbnailUrl ? 'none' : getGradientForId(project.id) }}>
                          {project.thumbnailUrl ? (
                            <img src={project.thumbnailUrl} alt={project.name} className="thumbnail-img" />
                          ) : (
                            <div className="gradient-badge">
                              {getDomain(project.stagingUrl || project.name).charAt(0).toUpperCase()}
                            </div>
                          )}
                          {isMonday && (
                            <div className="monday-circle-badge" style={{ borderColor: statusColor }} title={`Monday Ticket: ${project.mondayTicket?.status}`}>
                              <img src={mondayLogo} alt="Monday" width="14" height="14" />
                            </div>
                          )}
                          <div className="card-actions-overlay" onClick={(e) => e.stopPropagation()}>
                            <button
                              className="card-action-btn pin-btn"
                              onClick={(e) => togglePinProject(project.id, e)}
                              title="Pin project to top"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 17v5M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7z" />
                              </svg>
                            </button>
                            <button className="card-action-btn edit-btn" onClick={(e) => { e.stopPropagation(); onOpenProject(project, true) }} title="Edit Settings">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                            </button>
                            {isMonday || project.id.startsWith('monday-') ? (
                              <button
                                className="card-action-btn delete-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const tId = project.mondayTicket ? project.mondayTicket.id : project.id.replace('monday-', '')
                                  toggleActiveTicket(tId)
                                }}
                                title="Set Inactive"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            ) : (
                              <button className="card-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); setDeleteConfirmProject(project) }} title="Move to Trash">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="project-card-body">
                          <div className="project-name" title={project.name}>{project.name}</div>
                          <div className="project-url" title={project.stagingUrl}>{getDomain(project.stagingUrl)}</div>
                          <div className="project-meta-row">
                            <span className="project-meta">{formatDate(project.lastOpenedAt)}</span>
                            {isMonday && (
                              <span className={`monday-status-pill status-${project.mondayTicket?.status.toLowerCase().replace(/\s+/g, '-')}`} style={{ marginLeft: 'auto', fontSize: 9 }}>
                                {project.mondayTicket?.status}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {viewMode === 'list' && (
                <div className="project-list-table">
                  <div className="list-header">
                    <div className="col-pin" style={{ width: 28 }} />
                    <div className="col-name">Project / Ticket Name</div>
                    <div className="col-domain">Staging Domain</div>
                    <div className="col-status">Status</div>
                    <div className="col-time">Last Opened</div>
                    <div className="col-actions">Actions</div>
                  </div>
                  {unpinnedActiveProjects.map((project) => {
                    const isMonday = !!project.mondayTicket
                    const isPinned = pinnedProjectIds.includes(project.id)

                    return (
                      <div
                        key={project.id}
                        className="list-row"
                        onClick={() => {
                          if (isMonday && !project.adminUrl) {
                            handleLaunchTicket(project.mondayTicket!)
                          } else {
                            onOpenProject(project)
                          }
                        }}
                      >
                        <div className="col-pin" onClick={(e) => togglePinProject(project.id, e)} title={isPinned ? "Unpin" : "Pin"}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? "#38bdf8" : "none"} stroke={isPinned ? "#38bdf8" : "#888"} strokeWidth="2">
                            <path d="M12 17v5M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7z" />
                          </svg>
                        </div>
                        <div className="col-name">
                          <div className="list-icon">
                            {getDomain(project.stagingUrl || project.name).charAt(0).toUpperCase()}
                          </div>
                          <span>{project.name}</span>
                        </div>
                        <div className="col-domain">{getDomain(project.stagingUrl || project.name)}</div>
                        <div className="col-status">
                          {project.mondayTicket?.status ? (
                            <span className={`card-status-badge status-${project.mondayTicket.status.toLowerCase().replace(/\s+/g, '-')}`}>
                              {project.mondayTicket.status}
                            </span>
                          ) : (
                            <span className="card-status-badge local">Local</span>
                          )}
                        </div>
                        <div className="col-time">{formatDate(project.lastOpenedAt)}</div>
                        <div className="col-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="list-action-btn"
                            onClick={() => onOpenProject(project, true)}
                            title="Edit Settings"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          {isMonday || project.id.startsWith('monday-') ? (
                            <button
                              className="list-action-btn delete"
                              onClick={() => {
                                const tId = project.mondayTicket ? project.mondayTicket.id : project.id.replace('monday-', '')
                                toggleActiveTicket(tId)
                              }}
                              title="Set Inactive"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          ) : (
                            <button
                              className="list-action-btn delete"
                              onClick={() => setDeleteConfirmProject(project)}
                              title="Move to Trash"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* 3. MY MONDAY TICKETS SECTION */}
        <div className="dashboard-section monday-section">
          <div className="section-label-row">
            <div className="section-title-with-badge" onClick={() => mondayConnected && setMondaySectionExpanded(!mondaySectionExpanded)} style={{ cursor: mondayConnected ? 'pointer' : 'default' }}>
              {mondayConnected && (
                <svg
                  className={`section-chevron ${mondaySectionExpanded ? 'expanded' : ''}`}
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
              <img src={mondayLogo} alt="Monday.com" style={{ width: 18, height: 18, objectFit: 'contain' }} />
              <h2 className="section-label">My Monday Tickets</h2>
              {mondayConnected ? (
                <span className="monday-badge connected">{mondayTickets.length} ticket{mondayTickets.length !== 1 ? 's' : ''}</span>
              ) : (
                <span className="monday-badge optional">Optional</span>
              )}
            </div>

            <div className="monday-header-actions">
              {mondayConnected ? (
                <>
                  <button
                    className="monday-sync-btn"
                    onClick={() => fetchMondayTickets(mondayToken)}
                    disabled={mondaySyncing}
                    title="Sync latest Monday tickets"
                  >
                    <svg className={mondaySyncing ? 'spin' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    <span>{mondaySyncing ? 'Syncing...' : 'Sync Now'}</span>
                  </button>
                  <button className="monday-account-btn" onClick={handleDisconnectMonday} title="Disconnect Monday.com">
                    Disconnect
                  </button>
                </>
              ) : (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className="monday-connect-btn"
                    onClick={handleMondayLogin}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                    <span>Connect Monday Account</span>
                  </button>
                  <button
                    className="monday-account-btn"
                    onClick={() => setShowTokenFallbackModal(true)}
                    title="Enter Personal API Token manually"
                  >
                    Enter Token
                  </button>
                </div>
              )}
            </div>
          </div>

          {!mondayConnected && (
            <div className="monday-notice-card">
              <div className="monday-notice-content">
                <strong>Monday.com Integration (Optional)</strong>
                <span>Log in to Monday.com using the "Connect Monday Account" button above to automatically fetch your assigned tickets and attached QA resources.</span>
              </div>
            </div>
          )}

          {/* Monday Ticket Cards grouped by status (collapsible sub-sections) */}
          {mondaySectionExpanded && ticketsByStatus.map(([status, tickets]) => (
            <div key={status} className="monday-status-group">
              <div
                className="monday-status-group-header"
                onClick={() => toggleStatusCollapse(status)}
              >
                <svg
                  className={`section-chevron ${collapsedStatuses.has(status) ? '' : 'expanded'}`}
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className={`monday-status-dot status-${status.toLowerCase().replace(/\s+/g, '-')}`} />
                <span className="monday-status-group-label">{status}</span>
                <span className="monday-status-group-count">{tickets.length}</span>
              </div>

              {!collapsedStatuses.has(status) && (
                <div className="monday-tickets-grid">
                  {tickets.map((ticket) => {
                    const isActive = activeTicketIds.includes(ticket.id)
                    return (
                      <div
                        key={ticket.id}
                        className={`monday-ticket-card ${isActive ? 'is-active-ticket' : ''}`}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setContextMenu({ x: e.clientX, y: e.clientY, ticket, isActive })
                        }}
                      >
                        <div className="monday-card-header">
                          <span className={`monday-status-pill status-${ticket.status.toLowerCase().replace(/\s+/g, '-')}`}>
                            {ticket.status}
                          </span>
                          {isActive && (
                            <span className="active-ticket-badge" title="Active Project Ticket">
                              Active
                            </span>
                          )}
                          <span className="monday-board-tag">{ticket.boardName}</span>
                        </div>

                        <h3 className="monday-ticket-title" title={ticket.name}>{ticket.name}</h3>

                        {/* Detected Smart Resources — link list with copy */}
                        <div className="monday-links-list">
                          {ticket.stagingUrl && (
                            <div className="monday-link-row">
                              <a className="monday-link-main" href={ticket.stagingUrl} target="_blank" rel="noreferrer" title={ticket.stagingUrl}>
                                <svg className="monday-link-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                                <span className="monday-link-label">Staging</span>
                                <span className="monday-link-url">{ticket.stagingUrl}</span>
                              </a>
                              <button className="monday-link-copy" title="Copy URL" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ticket.stagingUrl) }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                              </button>
                            </div>
                          )}
                          {ticket.adminUrl && (
                            <div className="monday-link-row">
                              <a className="monday-link-main" href={ticket.adminUrl} target="_blank" rel="noreferrer" title={ticket.adminUrl}>
                                <svg className="monday-link-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                                <span className="monday-link-label">WP Admin</span>
                                <span className="monday-link-url">{ticket.adminUrl}</span>
                              </a>
                              <button className="monday-link-copy" title="Copy URL" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ticket.adminUrl) }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                              </button>
                            </div>
                          )}
                          {ticket.googleSheetUrl && (
                            <div className="monday-link-row">
                              <a className="monday-link-main" href={ticket.googleSheetUrl} target="_blank" rel="noreferrer" title={ticket.googleSheetUrl}>
                                <img className="monday-link-icon-img" src={sheetsIcon} alt="Sheets" />
                                <span className="monday-link-label">QA Sheet</span>
                                <span className="monday-link-url">{ticket.googleSheetUrl}</span>
                              </a>
                              <button className="monday-link-copy" title="Copy URL" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ticket.googleSheetUrl!) }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                              </button>
                            </div>
                          )}
                          {ticket.figmaUrl && (
                            <div className="monday-link-row">
                              <a className="monday-link-main" href={ticket.figmaUrl} target="_blank" rel="noreferrer" title={ticket.figmaUrl}>
                                <img className="monday-link-icon-img" src={figmaIcon} alt="Figma" />
                                <span className="monday-link-label">Figma</span>
                                <span className="monday-link-url">{ticket.figmaUrl}</span>
                              </a>
                              <button className="monday-link-copy" title="Copy URL" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ticket.figmaUrl!) }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                              </button>
                            </div>
                          )}
                          {ticket.otherLinks?.map((link, i) => (
                            <div key={i} className="monday-link-row">
                              <a className="monday-link-main" href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                                <svg className="monday-link-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                                <span className="monday-link-label">{link.label}</span>
                                <span className="monday-link-url">{link.url}</span>
                              </a>
                              <button className="monday-link-copy" title="Copy URL" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(link.url) }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                              </button>
                            </div>
                          ))}
                          {!ticket.stagingUrl && !ticket.adminUrl && !ticket.googleSheetUrl && !ticket.figmaUrl && !ticket.otherLinks?.length && (
                            <div className="monday-link-row empty">
                              <span className="monday-link-label" style={{ color: '#555' }}>No links attached</span>
                            </div>
                          )}
                        </div>

                        <div className="monday-card-footer">
                          <span className="monday-updated">{ticket.updatedAt}</span>
                          <button
                            className="toggle-active-btn"
                            onClick={(e) => { e.stopPropagation(); toggleActiveTicket(ticket.id) }}
                            title={isActive ? 'Remove from Active Projects' : 'Set as Active Project'}
                          >
                            {isActive ? 'Set Inactive' : 'Set Active'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Active Projects Section */}
        <div className="dashboard-section">
          <div className="section-label-row">
            <h2 className="section-label">Active Projects ({activeProjects.length})</h2>
          </div>

          {loading && <div className="dashboard-empty">Loading projects...</div>}

          {!loading && activeProjects.length === 0 && (
            <div className="dashboard-empty">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#404040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="36" height="36" rx="4" />
                  <path d="M6 18h36M18 18v24" />
                </svg>
              </div>
              <p>{searchQuery ? 'No matching projects found' : 'No active projects yet'}</p>
              <p className="empty-hint">{searchQuery ? 'Try clearing your search query' : 'Right-click a Monday ticket or click "New Capture" to get started'}</p>
            </div>
          )}

          {!loading && activeProjects.length > 0 && (
            <>
              {/* GRID CARDS VIEW */}
              {viewMode === 'cards' && (
                <div className="project-grid">
                  {activeProjects.map((project) => {
                    const isMonday = !!project.mondayTicket
                    const statusColor = getStatusColor(project.mondayTicket?.status)

                    return (
                      <div
                        key={project.id}
                        className={`project-card ${isMonday ? 'has-monday-badge' : ''}`}
                        onClick={() => {
                          if (isMonday && !project.adminUrl) {
                            handleLaunchTicket(project.mondayTicket!)
                          } else {
                            onOpenProject(project)
                          }
                        }}
                        onContextMenu={(e) => {
                          if (isMonday) {
                            e.preventDefault()
                            setContextMenu({ x: e.clientX, y: e.clientY, ticket: project.mondayTicket!, isActive: true })
                          }
                        }}
                      >
                        {/* Card Thumbnail / Gradient Banner */}
                        <div
                          className="project-thumbnail"
                          style={{
                            background: project.thumbnailUrl ? 'none' : getGradientForId(project.id)
                          }}
                        >
                          {project.thumbnailUrl ? (
                            <img src={project.thumbnailUrl} alt={project.name} className="thumbnail-img" />
                          ) : (
                            <div className="gradient-badge">
                              {getDomain(project.stagingUrl || project.name).charAt(0).toUpperCase()}
                            </div>
                          )}

                          {/* Circular Monday Badge with Colored Status Ring */}
                          {isMonday && (
                            <div
                              className="monday-circle-badge"
                              style={{ borderColor: statusColor }}
                              title={`Monday Ticket: ${project.mondayTicket?.status}`}
                            >
                              <img src={mondayLogo} alt="Monday" width="14" height="14" />
                            </div>
                          )}

                          {/* Top Action Overlay Buttons */}
                          <div className="card-actions-overlay" onClick={(e) => e.stopPropagation()}>
                            <button
                              className="card-action-btn edit-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                onOpenProject(project, true)
                              }}
                              title="Edit URLs & Capture Form"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </button>

                            {isMonday || project.id.startsWith('monday-') ? (
                              <button
                                className="card-action-btn delete-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const tId = project.mondayTicket ? project.mondayTicket.id : project.id.replace('monday-', '')
                                  toggleActiveTicket(tId)
                                }}
                                title="Set Inactive"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            ) : (
                              <button
                                className="card-action-btn delete-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDeleteConfirmProject(project)
                                }}
                                title="Move to Trash"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Card Content Body */}
                        <div className="project-card-body">
                          <div className="project-name" title={project.name}>{project.name}</div>
                          <div className="project-url" title={project.stagingUrl}>{getDomain(project.stagingUrl)}</div>
                          <div className="project-meta-row">
                            <span className="project-meta">{formatDate(project.lastOpenedAt)}</span>
                            {isMonday && (
                              <span
                                className={`monday-status-pill status-${project.mondayTicket?.status.toLowerCase().replace(/\s+/g, '-')}`}
                                style={{ marginLeft: 'auto', fontSize: 9 }}
                              >
                                {project.mondayTicket?.status}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* TABULAR LIST VIEW */}
              {viewMode === 'list' && (
                <div className="project-list">
                  {activeProjects.map((project) => (
                    <div
                      key={project.id}
                      className="project-list-row"
                      onClick={() => {
                        if (project.mondayTicket && !project.adminUrl) {
                          handleLaunchTicket(project.mondayTicket)
                        } else {
                          onOpenProject(project)
                        }
                      }}
                    >
                      <div className="list-col-thumb" style={{ background: getGradientForId(project.id) }}>
                        {getDomain(project.stagingUrl || project.name).charAt(0).toUpperCase()}
                      </div>
                      <div className="list-col-info">
                        <div className="list-name">{project.name}</div>
                        <div className="list-url">{project.stagingUrl}</div>
                      </div>
                      <div className="list-col-date">{formatDate(project.lastOpenedAt)}</div>
                      <div className="list-col-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="list-action-btn edit-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenProject(project, true)
                          }}
                          title="Edit Project URLs"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                          <span>Edit</span>
                        </button>
                        <button
                          className="list-action-btn delete-btn"
                          onClick={() => setDeleteConfirmProject(project)}
                          title="Move to Trash"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                          <span>Trash</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Trash Section at Bottom */}
        <div className="dashboard-section trash-section">
          <div
            className="trash-section-header"
            onClick={() => setTrashExpanded((p) => !p)}
          >
            <div className="trash-title">
              <svg className={`trash-chevron ${trashExpanded ? 'open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              <span>Trash</span>
            </div>
            <span className="trash-badge">{trashProjects.length}</span>
          </div>

          {trashExpanded && (
            <div className="trash-content">
              {trashProjects.length === 0 ? (
                <div className="trash-empty">Trash is empty</div>
              ) : (
                <div className="project-grid">
                  {trashProjects.map((project) => (
                    <div key={project.id} className="project-card trash-card">
                      <div className="project-thumbnail trash-thumb" style={{ background: getGradientForId(project.id) }}>
                        <div className="gradient-badge">{getDomain(project.stagingUrl).charAt(0).toUpperCase()}</div>
                        <div className="trash-overlay-tag">TRASHED</div>
                      </div>
                      <div className="project-card-body">
                        <div className="project-name">{project.name}</div>
                        <div className="project-url">{getDomain(project.stagingUrl)}</div>
                        <div className="trash-actions">
                          <button
                            className="trash-btn restore-btn"
                            onClick={(e) => handleRestore(e, project)}
                            title="Restore Project"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                              <path d="M3 3v5h5" />
                            </svg>
                            Restore
                          </button>
                          <button
                            className="trash-btn perm-delete-btn"
                            onClick={() => setPermanentDeleteProject(project)}
                            title="Delete Permanently"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>



      {/* ── MOVE TO TRASH CONFIRMATION MODAL ───────────────────────── */}
      {deleteConfirmProject && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmProject(null)}>
          <div className="modal-dialog modal-dialog-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Move to Trash?</h3>
              <button className="modal-close-btn" onClick={() => setDeleteConfirmProject(null)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-text">
                Are you sure you want to move <strong>"{deleteConfirmProject.name}"</strong> to the trash?
              </p>
              <p className="modal-subtext">
                You can restore this project anytime from the Trash section at the bottom of the dashboard.
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn secondary-btn" onClick={() => setDeleteConfirmProject(null)}>
                Cancel
              </button>
              <button
                className="modal-btn danger-btn"
                onClick={() => handleMoveToTrash(deleteConfirmProject)}
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PERMANENT DELETE CONFIRMATION MODAL ────────────────────── */}
      {permanentDeleteProject && (
        <div className="modal-overlay" onClick={() => setPermanentDeleteProject(null)}>
          <div className="modal-dialog modal-dialog-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ color: '#f85149' }}>Delete Permanently?</h3>
              <button className="modal-close-btn" onClick={() => setPermanentDeleteProject(null)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-text">
                Permanently delete <strong>"{permanentDeleteProject.name}"</strong>?
              </p>
              <p className="modal-subtext" style={{ color: '#ff7b72' }}>
                This action cannot be undone. All captured data for this project will be deleted forever.
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn secondary-btn" onClick={() => setPermanentDeleteProject(null)}>
                Cancel
              </button>
              <button
                className="modal-btn danger-btn"
                onClick={() => handlePermanentDelete(permanentDeleteProject.id)}
              >
                Delete Forever
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MONDAY MANUAL API TOKEN FALLBACK MODAL ────────────────── */}
      {showTokenFallbackModal && (
        <div className="modal-overlay" onClick={() => setShowTokenFallbackModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <img src={mondayLogo} alt="" width="18" height="18" />
                <h3 className="modal-title">Monday.com API Token Fallback</h3>
              </div>
              <button className="modal-close-btn" onClick={() => setShowTokenFallbackModal(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-text">
                If Monday shows <em>"You are not permitted to use this app"</em> or browser auth fails, connect instantly using your <strong>Monday.com Personal API Token</strong>.
              </p>
              <p className="modal-subtext" style={{ marginBottom: '16px', fontSize: '12px', color: '#a1a1aa' }}>
                How to get your token: Open <strong>Monday.com</strong> → Avatar (bottom left) → <strong>Developers</strong> → <strong>My Tokens</strong> → Copy API v2 Token.
              </p>
              {manualTokenError && (
                <div style={{ color: '#ff7b72', fontSize: '13px', marginBottom: '12px', background: 'rgba(255,123,114,0.1)', padding: '8px 12px', borderRadius: '6px' }}>
                  {manualTokenError}
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Personal API Token</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Paste your Monday API token here..."
                  value={manualTokenInput}
                  onChange={(e) => setManualTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveManualToken()
                  }}
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn secondary-btn" onClick={() => setShowTokenFallbackModal(false)}>
                Cancel
              </button>
              <button className="modal-btn primary-btn" onClick={handleSaveManualToken} disabled={mondaySyncing}>
                {mondaySyncing ? 'Connecting...' : 'Connect Token'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MONDAY TICKET RIGHT-CLICK CONTEXT MENU ─────────────────── */}
      {contextMenu && (
        <div
          className="monday-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="monday-context-header">
            <img src={mondayLogo} alt="" width="14" height="14" />
            <span>{contextMenu.ticket.name}</span>
          </div>
          <div className="monday-context-divider" />
          <button
            className="monday-context-item"
            onClick={() => toggleActiveTicket(contextMenu.ticket.id)}
          >
            {contextMenu.isActive ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                <span>Set as Inactive</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
                <span>Set as Active Project</span>
              </>
            )}
          </button>
          <button
            className="monday-context-item"
            onClick={() => {
              handleLaunchTicket(contextMenu.ticket)
              setContextMenu(null)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            <span>Launch Capture & Pre-fill</span>
          </button>
        </div>
      )}
    </div>
  )
}
