import { useCallback, useEffect, useState, useMemo } from 'react'
import type { Project } from '../../../shared/types'
import mondayLogo from '../assets/monday-icon-svgrepo-com.svg'
import figmaIcon from '../assets/figma.png'
import sheetsIcon from '../assets/sheets.png'
import parityIcon from '../assets/parity-favicon.svg'
import parityLightIcon from '../assets/parity-light-512.png'
import {
  fetchMondayMetadataApi,
  fetchMondayTicketsApi,
  loadMondayPreferences,
  saveMondayPreferences,
  type MondayLink,
  type MondayMetadata,
  type MondaySyncPreferences,
  type MondayTicket,
} from '../utils/mondayApi'
import { supabaseAnonKey, supabaseConfigurationError, supabaseUrl } from '../../../shared/supabaseClient'
import type { FigmaConnectionStatus } from '../../../shared/types'
import './Dashboard.css'

export type { MondayTicket, MondayLink }

interface Props {
  onNewProject: () => void
  onOpenProject: (project: Project, forceForm?: boolean) => void
  onOpenSettings?: () => void
}

type SortOption = 'recent' | 'oldest' | 'name-asc' | 'name-desc'
type ViewMode = 'cards' | 'list'
type MondaySortOption = 'updated-desc' | 'updated-asc' | 'name-asc' | 'board-asc' | 'status-asc'

interface ContextMenuState {
  x: number
  y: number
  ticket: MondayTicket
  isActive: boolean
}

interface ProjectFolder { id: string; name: string; createdAt: number }
interface ProjectContextMenuState { x: number; y: number; project: Project }
interface FolderEditorState { mode: 'create' | 'rename'; name: string; folderId?: string; projectId?: string }

const GRADIENTS = [
  'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0d324d 0%, #7f5a83 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  'linear-gradient(135deg, #1e130c 0%, #4a2511 100%)',
  'linear-gradient(135deg, #11292b 0%, #1e5254 100%)'
]

function GenericProjectThumbnail({ compact = false }: { compact?: boolean }) {
  return <span className={`generic-project-thumbnail ${compact ? 'compact' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3" width="27" height="18" rx="2.5" />
      <path d="M3 8h26" /><circle cx="6" cy="5.6" r=".7" fill="currentColor" stroke="none" /><circle cx="8.7" cy="5.6" r=".7" fill="currentColor" stroke="none" />
      <rect x="6" y="11" width="8" height="6.5" rx="1" /><path d="M17 11h8M17 14h6M17 17h7" />
    </svg>
  </span>
}

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

function getTicketStagingLinks(ticket: MondayTicket): MondayLink[] {
  const links: MondayLink[] = []
  const seen = new Set<string>()
  const add = (url: string | undefined, label: string) => {
    const value = url?.trim()
    if (!value || seen.has(value.toLowerCase())) return
    const lower = value.toLowerCase()
    if (lower.includes('figma.com') || lower.includes('docs.google.com') || lower.includes('sheets.google.com') || lower.includes('/wp-admin')) return
    seen.add(lower)
    links.push({ url: value, label })
  }
  add(ticket.stagingUrl, 'Primary Staging URL')
  ticket.otherLinks?.forEach((link) => add(link.url, link.label || 'Staging Page'))
  return links
}

export default function Dashboard({ onNewProject, onOpenProject, onOpenSettings }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [viewMode, setViewMode] = useState<ViewMode>('cards')
  const [trashExpanded, setTrashExpanded] = useState(false)
  const [folders, setFolders] = useState<ProjectFolder[]>(() => {
    try { return JSON.parse(localStorage.getItem('qa_project_folders') || '[]') } catch { return [] }
  })
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null)
  const [folderEditor, setFolderEditor] = useState<FolderEditorState | null>(null)
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)

  // Monday.com state
  const [mondayConnected, setMondayConnected] = useState(false)
  const [mondayAccountName, setMondayAccountName] = useState('')
  const [mondayTickets, setMondayTickets] = useState<MondayTicket[]>(() => {
    try {
      const stored = localStorage.getItem('monday_tickets')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const [mondaySyncing, setMondaySyncing] = useState(false)
  const [mondayError, setMondayError] = useState('')
  const [mondaySourceModalOpen, setMondaySourceModalOpen] = useState(false)
  const [mondayMetadata, setMondayMetadata] = useState<MondayMetadata | null>(null)
  const [mondayPreferences, setMondayPreferences] = useState<MondaySyncPreferences>(() => loadMondayPreferences() || { boardIds: [], assignmentMode: 'me', userIds: [] })
  const [mondaySourceSearch, setMondaySourceSearch] = useState('')
  const [mondayUserSearch, setMondayUserSearch] = useState('')
  const [mondayTicketSearch, setMondayTicketSearch] = useState('')
  const [mondayBoardFilter, setMondayBoardFilter] = useState('all')
  const [mondayStatusFilter, setMondayStatusFilter] = useState('all')
  const [mondaySort, setMondaySort] = useState<MondaySortOption>('updated-desc')
  const [expandedTicketLinks, setExpandedTicketLinks] = useState<Set<string>>(new Set())
  const [mondaySectionExpanded, setMondaySectionExpanded] = useState(true)
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<string>>(new Set())
  const [figmaStatus, setFigmaStatus] = useState<FigmaConnectionStatus>({ connected: false, apiConfigured: false, browserSession: false })

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
    const handleClose = () => { setContextMenu(null); setProjectContextMenu(null) }
    window.addEventListener('click', handleClose)
    return () => window.removeEventListener('click', handleClose)
  }, [])

  useEffect(() => {
    localStorage.setItem('qa_project_folders', JSON.stringify(folders))
    window.dispatchEvent(new CustomEvent('qa_folders_updated', { detail: folders }))
    window.dispatchEvent(new CustomEvent('parity:account-state-dirty', { detail: { folders } }))
  }, [folders])

  const reloadProjects = useCallback(() => { void window.electronAPI.getProjects().then(setProjects) }, [])
  const notifyProjectsChanged = () => window.dispatchEvent(new CustomEvent('qa_projects_updated'))

  useEffect(() => {
    const onProjectsUpdated = () => reloadProjects()
    const onFoldersUpdated = (event: Event) => {
      const next = (event as CustomEvent<ProjectFolder[]>).detail
      if (!Array.isArray(next)) return
      setFolders((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    const onFocus = () => reloadProjects()
    const onActiveTicketsUpdated = (event: Event) => {
      const next = (event as CustomEvent<string[]>).detail
      if (Array.isArray(next)) setActiveTicketIds(next)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'qa_project_folders') {
        try { const next = JSON.parse(event.newValue || '[]'); if (Array.isArray(next)) setFolders(next) } catch {}
      }
      if (event.key === 'active_monday_ticket_ids') {
        try { const next = JSON.parse(event.newValue || '[]'); if (Array.isArray(next)) setActiveTicketIds(next) } catch {}
      }
      reloadProjects()
    }
    window.addEventListener('qa_projects_updated', onProjectsUpdated)
    window.addEventListener('qa_folders_updated', onFoldersUpdated)
    window.addEventListener('focus', onFocus)
    window.addEventListener('qa_active_ticket_ids_updated', onActiveTicketsUpdated)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('qa_projects_updated', onProjectsUpdated); window.removeEventListener('qa_folders_updated', onFoldersUpdated); window.removeEventListener('focus', onFocus); window.removeEventListener('qa_active_ticket_ids_updated', onActiveTicketsUpdated); window.removeEventListener('storage', onStorage) }
  }, [reloadProjects])

  useEffect(() => {
    window.electronAPI.getProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
    void (async () => {
      let status = await window.electronAPI.mondayStatus()
      if (!status.connected) {
        const legacyToken = localStorage.getItem('monday_api_token') || localStorage.getItem('monday_token') || localStorage.getItem('monday_api_key')
        if (legacyToken) {
          const migrated = await window.electronAPI.mondaySetPersonalToken(
            legacyToken,
            supabaseConfigurationError ? undefined : { supabaseUrl, supabaseAnonKey },
          )
          for (const key of ['monday_api_token', 'monday_token', 'monday_api_key']) localStorage.removeItem(key)
          if (migrated.success && migrated.status) status = migrated.status
        }
      }
      setMondayConnected(status.connected)
      setMondayAccountName(status.user?.name || '')
      if (status.connected && loadMondayPreferences()?.boardIds.length) void fetchMondayTickets()
    })().catch((error) => setMondayError(error instanceof Error ? error.message : 'Unable to restore Monday connection.'))
    void window.electronAPI.figmaTokenStatus().then(setFigmaStatus).catch(() => {})
    const unsubscribeFigma = window.electronAPI.onFigmaAuthChanged?.(setFigmaStatus)

    const handleUpdate = () => {
      try {
        const stored = localStorage.getItem('monday_tickets')
        if (stored) setMondayTickets(JSON.parse(stored))
      } catch { /* ignore */ }
    }
    window.addEventListener('monday_tickets_updated', handleUpdate)
    return () => { window.removeEventListener('monday_tickets_updated', handleUpdate); unsubscribeFigma?.() }
  }, [])

  const toggleActiveTicket = async (ticketId: string) => {
    const isActivating = !activeTicketIds.includes(ticketId)
    setActiveTicketIds((prev) => {
      const next = prev.includes(ticketId)
        ? prev.filter((id) => id !== ticketId)
        : [...prev, ticketId]
      localStorage.setItem('active_monday_ticket_ids', JSON.stringify(next))
      window.dispatchEvent(new CustomEvent('parity:account-state-dirty', { detail: { activeTicketIds: next } }))
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('qa_active_ticket_ids_updated', { detail: next })))
      return next
    })

    if (isActivating) {
      const targetTicket = mondayTickets.find((t) => t.id === ticketId)
      if (targetTicket) {
        const monId = 'monday-' + targetTicket.id
        const newProject: Project = {
          id: monId,
          mondayTicketId: targetTicket.id,
          name: targetTicket.name,
          stagingUrl: targetTicket.stagingUrl || '',
          adminUrl: targetTicket.adminUrl || '',
          createdAt: Date.now(),
          lastOpenedAt: Date.now()
        }
        await window.electronAPI.saveProject(newProject)
        notifyProjectsChanged()
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === monId)
          return exists ? prev.map((p) => (p.id === monId ? newProject : p)) : [...prev, newProject]
        })
      }
    }
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
  const visibleMondayTickets = useMemo(() => {
    const query = mondayTicketSearch.trim().toLowerCase()
    return mondayTickets.filter((ticket) => {
      if (mondayBoardFilter !== 'all' && !ticket.boardName.split(' + ').includes(mondayBoardFilter)) return false
      if (mondayStatusFilter !== 'all' && ticket.status !== mondayStatusFilter) return false
      if (!query) return true
      return [ticket.name, ticket.boardName, ticket.status, ...(ticket.assigneeNames || []), ticket.stagingUrl, ticket.adminUrl, ticket.figmaUrl, ticket.googleSheetUrl, ...ticket.otherLinks.map((link) => `${link.label} ${link.url}`)]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(query))
    }).sort((a, b) => {
      if (mondaySort === 'updated-asc') return a.updatedAt.localeCompare(b.updatedAt)
      if (mondaySort === 'name-asc') return a.name.localeCompare(b.name)
      if (mondaySort === 'board-asc') return a.boardName.localeCompare(b.boardName)
      if (mondaySort === 'status-asc') return a.status.localeCompare(b.status)
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  }, [mondayTickets, mondayTicketSearch, mondayBoardFilter, mondayStatusFilter, mondaySort])
  const mondayBoardOptions = useMemo(() => [...new Set(mondayTickets.flatMap((ticket) => ticket.boardName.split(' + ')))].sort(), [mondayTickets])
  const mondayStatusOptions = useMemo(() => [...new Set(mondayTickets.map((ticket) => ticket.status))].sort(), [mondayTickets])

  const ticketsByStatus = useMemo(() => {
    const groups: Record<string, MondayTicket[]> = {}
    for (const ticket of visibleMondayTickets) {
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
  }, [visibleMondayTickets])

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
  const [editMondayTicketId, setEditMondayTicketId] = useState('')

  // Manual Monday API token fallback state
  const [showTokenFallbackModal, setShowTokenFallbackModal] = useState(false)
  const [manualTokenInput, setManualTokenInput] = useState('')
  const [manualTokenError, setManualTokenError] = useState('')

  const fetchMondayTickets = async (preferences?: MondaySyncPreferences) => {
    setMondaySyncing(true)
    setMondayError('')
    try {
      const fetched = await fetchMondayTicketsApi(preferences)
      setMondayTickets(fetched || [])
      localStorage.setItem('monday_tickets', JSON.stringify(fetched || []))
      localStorage.setItem('qa_cached_monday_tickets', JSON.stringify(fetched || []))
      window.dispatchEvent(new Event('monday_tickets_updated'))
    } catch (err) {
      console.error('[Monday] Fetch error:', err)
      setMondayError(err instanceof Error ? err.message : 'Unable to sync Monday tickets.')
    } finally {
      setMondaySyncing(false)
    }
  }

  const openMondaySources = async (firstConnection = false) => {
    setMondaySyncing(true)
    setMondayError('')
    try {
      const metadata = await fetchMondayMetadataApi()
      setMondayMetadata(metadata)
      setMondayAccountName(metadata.me.name)
      if (firstConnection || !mondayPreferences.boardIds.length) {
        const preferred = metadata.boards.filter((board) => /qa|web development/i.test(board.name)).map((board) => board.id)
        setMondayPreferences({ boardIds: preferred.length ? preferred : metadata.boards.slice(0, 2).map((board) => board.id), assignmentMode: 'me', userIds: [] })
      }
      setMondaySourceModalOpen(true)
    } catch (error) {
      setMondayError(error instanceof Error ? error.message : 'Unable to load Monday boards and users.')
    } finally {
      setMondaySyncing(false)
    }
  }

  const saveMondaySourcesAndSync = async () => {
    if (!mondayPreferences.boardIds.length) { setMondayError('Select at least one board.'); return }
    if (mondayPreferences.assignmentMode === 'users' && !mondayPreferences.userIds.length) { setMondayError('Select at least one person.'); return }
    saveMondayPreferences(mondayPreferences)
    setMondaySourceModalOpen(false)
    await fetchMondayTickets(mondayPreferences)
  }

  const handleMondayLogin = async () => {
    setMondaySyncing(true)
    setMondayError('')
    try {
      if (supabaseConfigurationError) throw new Error(supabaseConfigurationError)
      const res = await window.electronAPI.mondayLogin({ supabaseUrl, supabaseAnonKey })
      if (res.success && res.status?.connected) {
        setMondayConnected(true)
        setMondayAccountName(res.status.user?.name || '')
        window.dispatchEvent(new Event('parity:monday-connected'))
        await openMondaySources(true)
      } else if (res.error) setMondayError(res.error)
    } catch (e) {
      console.error('[Monday] Login error:', e)
      setMondayError(e instanceof Error ? e.message : 'Unable to connect Monday.com.')
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
      const result = await window.electronAPI.mondaySetPersonalToken(
        trimmed,
        supabaseConfigurationError ? undefined : { supabaseUrl, supabaseAnonKey },
      )
      if (!result.success || !result.status?.connected) throw new Error(result.error || 'Monday rejected this token.')
      setMondayConnected(true)
      setMondayAccountName(result.status.user?.name || '')
      window.dispatchEvent(new Event('parity:monday-connected'))
      setShowTokenFallbackModal(false)
      setManualTokenInput('')
      await openMondaySources(true)
    } catch (error) {
      setManualTokenError(error instanceof Error ? error.message : 'Failed to connect with token.')
    } finally {
      setMondaySyncing(false)
    }
  }

  const handleDisconnectMonday = async () => {
    await window.electronAPI.mondayDisconnect(supabaseConfigurationError ? undefined : { supabaseUrl, supabaseAnonKey })
    localStorage.removeItem('monday_tickets')
    localStorage.removeItem('qa_cached_monday_tickets')
    setMondayConnected(false)
    setMondayAccountName('')
    setMondayTickets([])
    window.dispatchEvent(new Event('parity:monday-disconnected'))
  }

  const handleLaunchTicket = (ticket: MondayTicket) => {
    if (ticket.googleSheetUrl) {
      localStorage.setItem('qa_google_sheet_url', ticket.googleSheetUrl)
    }
    const project: Project = {
      id: crypto.randomUUID(),
      mondayTicketId: ticket.id,
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
      stagingUrl: editStagingUrl.trim(),
      mondayTicketId: editMondayTicketId || editingProject.mondayTicketId
    }
    await window.electronAPI.saveProject(updated)
    notifyProjectsChanged()
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
    notifyProjectsChanged()
    setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
    setDeleteConfirmProject(null)
  }

  // Restore from Trash
  const handleRestore = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    const updated: Project = { ...project, inTrash: false }
    delete updated.deletedAt
    await window.electronAPI.saveProject(updated)
    notifyProjectsChanged()
    setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
  }

  // Permanent Delete from Disk
  const handlePermanentDelete = async (projectId: string) => {
    await window.electronAPI.deleteProject(projectId)
    notifyProjectsChanged()
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
    setPermanentDeleteProject(null)
  }
  const openProjectEditor = (project: Project) => {
    setEditingProject(project)
    setEditName(project.name)
    setEditAdminUrl(project.adminUrl || '')
    setEditStagingUrl(project.stagingUrl || '')
    setEditMondayTicketId(project.mondayTicketId || (project.id.startsWith('monday-') ? project.id.slice(7) : ''))
  }

  const autofillEditFromMonday = (ticketId: string) => {
    const ticket = mondayTickets.find((item) => item.id === ticketId)
    if (!ticket) return
    const stagingLinks = getTicketStagingLinks(ticket)
    const adminUrl = ticket.adminUrl || ticket.otherLinks?.find((link) => link.url.toLowerCase().includes('/wp-admin'))?.url || ''
    setEditMondayTicketId(ticket.id)
    setEditName(ticket.name)
    if (stagingLinks[0]?.url) setEditStagingUrl(stagingLinks[0].url)
    if (adminUrl) setEditAdminUrl(adminUrl)
  }

  const moveProjectToFolder = async (project: Project, folderId?: string) => {
    const updated = { ...project, folderId: folderId || undefined }
    await window.electronAPI.saveProject(updated)
    notifyProjectsChanged()
    setProjects((current) => current.some((item) => item.id === updated.id) ? current.map((item) => item.id === updated.id ? updated : item) : current.concat(updated))
    setProjectContextMenu(null)
  }

  const beginProjectDrag = (event: React.DragEvent, project: Project) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-fullforce-project', project.id)
    event.dataTransfer.setData('text/plain', project.id)
    setDraggingProjectId(project.id)
  }

  const dropProjectInFolder = async (event: React.DragEvent, folderId?: string) => {
    event.preventDefault()
    const projectId = event.dataTransfer.getData('application/x-fullforce-project') || event.dataTransfer.getData('text/plain') || draggingProjectId
    setDragOverFolderId(null); setDraggingProjectId(null)
    if (!projectId) return
    const project = projects.find((item) => item.id === projectId) || activeProjects.find((item) => item.id === projectId)
    if (project) await moveProjectToFolder(project, folderId)
  }

  const createSiblingProject = async (source: Project) => {
    const sibling: Project = {
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} — New Page`,
      stagingUrl: '',
      inTrash: false,
      deletedAt: undefined,
      thumbnailUrl: undefined,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    await window.electronAPI.saveProject(sibling)
    notifyProjectsChanged()
    setProjects((current) => current.concat(sibling))
    setProjectContextMenu(null)
    onOpenProject(sibling, true)
  }

  const submitFolderEditor = async () => {
    if (!folderEditor) return
    const name = folderEditor.name.trim()
    if (!name) return
    if (folderEditor.mode === 'rename' && folderEditor.folderId) {
      setFolders((current) => current.map((folder) => folder.id === folderEditor.folderId ? { ...folder, name } : folder))
    } else {
      const folder: ProjectFolder = { id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, createdAt: Date.now() }
      setFolders((current) => current.concat(folder))
      if (folderEditor.projectId) {
        const project = projects.find((item) => item.id === folderEditor.projectId) || activeProjects.find((item) => item.id === folderEditor.projectId) || projectContextMenu?.project
        if (project) await moveProjectToFolder(project, folder.id)
      }
    }
    setFolderEditor(null)
  }

  const deleteFolder = async (folder: ProjectFolder) => {
    if (!window.confirm(`Delete “${folder.name}”? Projects will be moved back to Active Projects.`)) return
    const affected = projects.filter((project) => project.folderId === folder.id)
    const updated = affected.map((project) => ({ ...project, folderId: undefined }))
    await Promise.all(updated.map((project) => window.electronAPI.saveProject(project)))
    notifyProjectsChanged()
    setProjects((current) => current.map((project) => project.folderId === folder.id ? { ...project, folderId: undefined } : project))
    setFolders((current) => current.filter((item) => item.id !== folder.id))
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

      const ticketProjects = localActive.filter((project) => project.mondayTicketId === ticket.id || project.id === monId)
      const legacyProject = !ticketProjects.length ? localActive.find((project) => project.stagingUrl && ticket.stagingUrl && project.stagingUrl.replace(/\/$/, '') === ticket.stagingUrl.replace(/\/$/, '')) : null
      if (legacyProject) ticketProjects.push(legacyProject)

      if (ticketProjects.length) {
        for (const project of ticketProjects) {
          if (seenIds.has(project.id)) continue
          seenIds.add(project.id)
          result.push({ ...project, mondayTicket: ticket })
        }
      } else {
        if (!seenIds.has(monId)) {
          seenIds.add(monId)
          result.push({
            id: monId,
            mondayTicketId: ticket.id,
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

      const linkedTicketId = p.mondayTicketId || (p.id.startsWith('monday-') ? p.id.slice('monday-'.length) : '')
      if (linkedTicketId && !activeTicketIds.includes(linkedTicketId)) {
        continue // Exclude every local page linked to an inactive Monday ticket
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
      window.dispatchEvent(new CustomEvent('parity:account-state-dirty', { detail: { pinnedProjectIds: updated } }))
      return updated
    })
  }

  const pinnedProjects = useMemo(() => {
    return activeProjects.filter((p) => pinnedProjectIds.includes(p.id) && !p.folderId)
  }, [activeProjects, pinnedProjectIds])

  const unpinnedActiveProjects = useMemo(() => {
    return activeProjects.filter((p) => !pinnedProjectIds.includes(p.id) && !p.folderId)
  }, [activeProjects, pinnedProjectIds])

  const folderGroups = useMemo(() => folders.map((folder) => ({ folder, projects: activeProjects.filter((project) => project.folderId === folder.id) })), [activeProjects, folders])

  const getProjectTicketId = (project: DisplayProject) =>
    project.mondayTicket?.id ||
    project.mondayTicketId ||
    (project.id.startsWith('monday-') ? project.id.slice('monday-'.length) : '')

  const renderSetInactiveButton = (
    project: DisplayProject,
    className = 'active-project-inactive-btn'
  ) => {
    const ticketId = getProjectTicketId(project)
    if (!ticketId || !activeTicketIds.includes(ticketId)) return null
    return (
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation()
          void toggleActiveTicket(ticketId)
        }}
        title="Remove from Active Projects"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
        <span>Set Inactive</span>
      </button>
    )
  }

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
            <img className="dashboard-brand-icon parity-dark-icon" src={parityIcon} alt="" aria-hidden="true" />
            <img className="dashboard-brand-icon parity-light-icon" src={parityLightIcon} alt="" aria-hidden="true" />
            <h1 className="dashboard-wordmark">parity</h1>
          </div>
          <div className="dashboard-header-actions">
            {onOpenSettings && (
              <button
                className="dashboard-settings-btn"
                onClick={onOpenSettings}
                title="Settings: hotkeys, snapshot storage, themes, and integrations"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 14px',
                  backgroundColor: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>Settings</span>
              </button>
            )}
            <button
              className={`figma-global-login-btn ${figmaStatus.connected ? 'connected' : ''}`}
              onClick={async () => {
                if (figmaStatus.connected) {
                  await window.electronAPI.openExternal('https://www.figma.com/files')
                  return
                }
                if (typeof (window.electronAPI as any)?.figmaLoginWindow === 'function') {
                  await (window.electronAPI as any).figmaLoginWindow()
                  setFigmaStatus(await window.electronAPI.figmaTokenStatus())
                } else {
                  window.open('https://www.figma.com/login', '_blank', 'width=1024,height=768')
                }
              }}
              title="Sign in to Figma in-app globally — persists across all projects and sessions"
            >
              <img src={figmaIcon} alt="Figma" width="16" height="16" style={{ objectFit: 'contain' }} />
              <span>{figmaStatus.connected ? `Figma: ${figmaStatus.user?.handle || figmaStatus.user?.email || 'Connected'}` : 'Login to Figma'}</span>
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
            <button className="dashboard-new-folder-btn" onClick={() => setFolderEditor({ mode: 'create', name: '' })}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v6M9 14h6" /></svg>
              New Folder
            </button>
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

        {/* Project folders */}
        {!loading && folderGroups.length > 0 && <div className="dashboard-folders">
          {folderGroups.map(({ folder, projects: folderProjects }) => {
            const collapsed = collapsedFolders.has(folder.id)
            return <section className={`dashboard-folder ${dragOverFolderId === folder.id ? 'drag-over' : ''}`} key={folder.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverFolderId(folder.id) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderId(null) }} onDrop={(event) => void dropProjectInFolder(event, folder.id)}>
              <div className="dashboard-folder-header">
                <button className="dashboard-folder-toggle" onClick={() => setCollapsedFolders((current) => { const next = new Set(current); next.has(folder.id) ? next.delete(folder.id) : next.add(folder.id); return next })}>
                  <span className="dashboard-folder-chevron">{collapsed ? '›' : '⌄'}</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                  <strong>{folder.name}</strong><small>{folderProjects.length}</small>
                </button>
                <div className="dashboard-folder-actions">
                  <button onClick={() => setFolderEditor({ mode: 'rename', folderId: folder.id, name: folder.name })} title="Rename folder">Rename</button>
                  <button onClick={() => void deleteFolder(folder)} title="Delete folder">Delete</button>
                </div>
              </div>
              {!collapsed && <div className="dashboard-folder-projects">
                {folderProjects.length ? folderProjects.map((project) => <button key={project.id} draggable onDragStart={(event) => beginProjectDrag(event, project)} onDragEnd={() => { setDraggingProjectId(null); setDragOverFolderId(null) }} className={`dashboard-folder-project ${draggingProjectId === project.id ? 'dragging' : ''}`} onClick={() => onOpenProject(project)} onContextMenu={(event) => { event.preventDefault(); setProjectContextMenu({ x: event.clientX, y: event.clientY, project }) }}>
                  <span className="folder-project-preview" style={{ background: project.thumbnailUrl ? 'var(--bg-elevated)' : getGradientForId(project.id) }}>
                    {project.thumbnailUrl ? <img src={project.thumbnailUrl} alt="" /> : <GenericProjectThumbnail />}
                  </span>
                  <span className="folder-project-content">
                    <b title={project.name}>{project.name}</b>
                    <small title={project.stagingUrl}>{getDomain(project.stagingUrl)}</small>
                    <span className="folder-project-meta"><em>{formatDate(project.lastOpenedAt)}</em>{project.mondayTicket?.status && <i>{project.mondayTicket.status}</i>}</span>
                  </span>
                </button>) : <div className="dashboard-folder-empty">No projects in this folder. Right-click a project and choose Move.</div>}
              </div>}
            </section>
          })}
        </div>}

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
                      draggable
                      onDragStart={(event) => beginProjectDrag(event, project)}
                      onDragEnd={() => { setDraggingProjectId(null); setDragOverFolderId(null) }}
                      onClick={() => {
                        if (isMonday && !project.adminUrl) {
                          handleLaunchTicket(project.mondayTicket!)
                        } else {
                          onOpenProject(project)
                        }
                      }}
                      onContextMenu={(event) => { event.preventDefault(); setProjectContextMenu({ x: event.clientX, y: event.clientY, project }) }}
                    >
                      <div className="project-thumbnail" style={{ background: project.thumbnailUrl ? 'none' : getGradientForId(project.id) }}>
                        {project.thumbnailUrl ? (
                          <img src={project.thumbnailUrl} alt={project.name} className="thumbnail-img" />
                        ) : (
                          <div className="gradient-badge"><GenericProjectThumbnail /></div>
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
                          {getProjectTicketId(project) ? (
                            <button
                              className="card-action-btn delete-btn"
                              onClick={(event) => {
                                event.stopPropagation()
                                void toggleActiveTicket(getProjectTicketId(project))
                              }}
                              title="Set Inactive"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
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
                        {renderSetInactiveButton(project)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 2. ACTIVE PROJECTS SECTION */}
        <div className={`dashboard-section active-project-dropzone ${dragOverFolderId === '__active__' ? 'drag-over' : ''}`} style={{ marginBottom: 28 }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverFolderId('__active__') }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderId(null) }} onDrop={(event) => void dropProjectInFolder(event)}>
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
                        draggable
                        onDragStart={(event) => beginProjectDrag(event, project)}
                        onDragEnd={() => { setDraggingProjectId(null); setDragOverFolderId(null) }}
                        onClick={() => {
                          if (isMonday && !project.adminUrl) {
                            handleLaunchTicket(project.mondayTicket!)
                          } else {
                            onOpenProject(project)
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setProjectContextMenu({ x: e.clientX, y: e.clientY, project })
                        }}
                      >
                        <div className="project-thumbnail" style={{ background: project.thumbnailUrl ? 'none' : getGradientForId(project.id) }}>
                          {project.thumbnailUrl ? (
                            <img src={project.thumbnailUrl} alt={project.name} className="thumbnail-img" />
                          ) : (
                            <div className="gradient-badge"><GenericProjectThumbnail /></div>
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
                          {renderSetInactiveButton(project)}
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
                        draggable
                        onDragStart={(event) => beginProjectDrag(event, project)}
                        onDragEnd={() => { setDraggingProjectId(null); setDragOverFolderId(null) }}
                        onContextMenu={(event) => { event.preventDefault(); setProjectContextMenu({ x: event.clientX, y: event.clientY, project }) }}
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
                          {getProjectTicketId(project) ? (
                            renderSetInactiveButton(project, 'list-action-btn active-project-inactive-list-btn')
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
              <h2 className="section-label">Monday Work</h2>
              {mondayConnected ? (
                <span className="monday-badge connected">{mondayTickets.length} ticket{mondayTickets.length !== 1 ? 's' : ''}</span>
              ) : (
                <span className="monday-badge optional">Optional</span>
              )}
            </div>

            <div className="monday-header-actions">
              {mondayConnected ? (
                <>
                  <button className="monday-account-btn" onClick={() => void openMondaySources()} title="Choose boards and people">
                    Sources
                  </button>
                  <button
                    className="monday-sync-btn"
                    onClick={() => fetchMondayTickets()}
                    disabled={mondaySyncing}
                    title="Sync latest Monday tickets"
                  >
                    <svg className={mondaySyncing ? 'spin' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    <span>{mondaySyncing ? 'Syncing...' : 'Sync Now'}</span>
                  </button>
                  <button className="monday-account-btn" onClick={() => void handleDisconnectMonday()} title="Disconnect Monday.com">
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

          {mondayConnected && mondayAccountName && <div className="monday-connection-line">Connected as <strong>{mondayAccountName}</strong></div>}
          {mondayError && <div className="monday-inline-error" role="alert">{mondayError}</div>}

          {mondayConnected && mondaySectionExpanded && (
            <div className="monday-organizer-bar">
              <div className="monday-organizer-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
                <input value={mondayTicketSearch} onChange={(event) => setMondayTicketSearch(event.target.value)} placeholder="Search tickets, people, boards, or links" />
              </div>
              <select value={mondayBoardFilter} onChange={(event) => setMondayBoardFilter(event.target.value)} aria-label="Filter Monday board">
                <option value="all">All boards</option>
                {mondayBoardOptions.map((board) => <option key={board} value={board}>{board}</option>)}
              </select>
              <select value={mondayStatusFilter} onChange={(event) => setMondayStatusFilter(event.target.value)} aria-label="Filter Monday status">
                <option value="all">All statuses</option>
                {mondayStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <select value={mondaySort} onChange={(event) => setMondaySort(event.target.value as MondaySortOption)} aria-label="Sort Monday tickets">
                <option value="updated-desc">Recently updated</option>
                <option value="updated-asc">Oldest updated</option>
                <option value="name-asc">Name A-Z</option>
                <option value="board-asc">Board A-Z</option>
                <option value="status-asc">Status A-Z</option>
              </select>
              <span className="monday-results-count">{visibleMondayTickets.length} shown</span>
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
                    const linkCount = Number(!!ticket.stagingUrl) + Number(!!ticket.adminUrl) + Number(!!ticket.googleSheetUrl) + Number(!!ticket.figmaUrl) + (ticket.otherLinks?.length || 0)
                    const linksOpen = expandedTicketLinks.has(ticket.id)
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
                        <div className={`monday-links-list ${!linksOpen && linkCount > 2 ? 'collapsed' : ''}`}>
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
                        {linkCount > 2 && (
                          <button className="monday-links-toggle" onClick={() => setExpandedTicketLinks((current) => {
                            const next = new Set(current)
                            if (next.has(ticket.id)) next.delete(ticket.id); else next.add(ticket.id)
                            return next
                          })}>{linksOpen ? 'Hide links' : `Show all ${linkCount} links`}</button>
                        )}

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
                        <div className="gradient-badge"><GenericProjectThumbnail /></div>
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
      {editingProject && (
        <div className="modal-overlay project-edit-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingProject(null) }}>
          <div className="modal-dialog project-edit-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="project-edit-header">
              <div className="project-edit-heading">
                <div className="project-edit-logo" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" />
                    <path d="m13.5 6.5 4 4" />
                  </svg>
                </div>
                <div>
                  <h3>Rename / Edit Project</h3>
                  <p>Update this page without changing its folder or Monday ticket.</p>
                </div>
              </div>
              <button className="modal-close-btn project-edit-close" onClick={() => setEditingProject(null)} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="project-edit-body">
              {mondayTickets.length > 0 && (
                <div className="project-edit-monday">
                  <div className="project-edit-monday-label">
                    <img src={mondayLogo} alt="" width="16" height="16" />
                    <span>Autofill all fields from Monday Ticket:</span>
                  </div>
                  <select
                    className="project-edit-select"
                    value={editMondayTicketId}
                    onChange={(event) => autofillEditFromMonday(event.target.value)}
                  >
                    <option value="">-- Select a Monday Ticket --</option>
                    {mondayTickets.map((ticket) => (
                      <option key={ticket.id} value={ticket.id}>[{ticket.status}] {ticket.name}</option>
                    ))}
                  </select>
                  {editMondayTicketId && getTicketStagingLinks(mondayTickets.find((ticket) => ticket.id === editMondayTicketId)!).length > 1 && (
                    <div className="project-edit-page-picker">
                      <label htmlFor="edit-ticket-page">Select staging page</label>
                      <select id="edit-ticket-page" className="project-edit-select" value={editStagingUrl} onChange={(event) => setEditStagingUrl(event.target.value)}>
                        {getTicketStagingLinks(mondayTickets.find((ticket) => ticket.id === editMondayTicketId)!).map((link, index) => (
                          <option key={`${link.url}-${index}`} value={link.url}>{link.label}: {link.url}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
              <div className="project-edit-section">
                <label className="project-edit-label" htmlFor="edit-project-name"><span className="project-edit-step">1</span>Project name</label>
                <p className="project-edit-hint">The name displayed on the dashboard and in its folder</p>
                <input id="edit-project-name" autoFocus className="project-edit-input" value={editName} onChange={(event) => setEditName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleSaveEdit() }} />
              </div>
              <div className="project-edit-section">
                <label className="project-edit-label" htmlFor="edit-staging-url"><span className="project-edit-step">2</span>Staging Page URL</label>
                <p className="project-edit-hint">The page opened by this project</p>
                <input id="edit-staging-url" className="project-edit-input" value={editStagingUrl} onChange={(event) => setEditStagingUrl(event.target.value)} placeholder="https://staging.example.com/page/" />
              </div>
              <div className="project-edit-section">
                <label className="project-edit-label" htmlFor="edit-admin-url"><span className="project-edit-step">3</span>WordPress Admin URL <span className="project-edit-optional">Optional</span></label>
                <p className="project-edit-hint">Used to restore the authenticated WordPress session</p>
                <input id="edit-admin-url" className="project-edit-input" value={editAdminUrl} onChange={(event) => setEditAdminUrl(event.target.value)} placeholder="https://staging.example.com/wp-admin" />
              </div>
            </div>
            <div className="project-edit-footer">
              <button className="project-edit-btn project-edit-btn-secondary" onClick={() => setEditingProject(null)}>Cancel</button>
              <button className="project-edit-btn project-edit-btn-primary" disabled={!editName.trim()} onClick={() => void handleSaveEdit()}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

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
      {mondaySourceModalOpen && mondayMetadata && (
        <div className="modal-overlay" onClick={() => setMondaySourceModalOpen(false)}>
          <div className="modal-dialog monday-source-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div className="monday-source-title"><img src={mondayLogo} alt="" width="20" height="20" /><div><h3 className="modal-title">Choose Monday sources</h3><span>{mondayMetadata.me.name} · only accessible boards and users are shown</span></div></div>
              <button className="modal-close-btn" onClick={() => setMondaySourceModalOpen(false)} aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
            </div>
            <div className="modal-body monday-source-body">
              <section className="monday-source-panel">
                <div className="monday-source-panel-head"><div><strong>Boards</strong><span>{mondayPreferences.boardIds.length} selected</span></div><div><button onClick={() => setMondayPreferences((current) => ({ ...current, boardIds: mondayMetadata.boards.map((board) => board.id) }))}>All</button><button onClick={() => setMondayPreferences((current) => ({ ...current, boardIds: [] }))}>None</button></div></div>
                <input className="monday-source-search" value={mondaySourceSearch} onChange={(event) => setMondaySourceSearch(event.target.value)} placeholder="Search accessible boards" />
                <div className="monday-source-list">
                  {mondayMetadata.boards.filter((board) => board.name.toLowerCase().includes(mondaySourceSearch.toLowerCase())).map((board) => (
                    <label key={board.id} className="monday-source-option"><input type="checkbox" checked={mondayPreferences.boardIds.includes(board.id)} onChange={() => setMondayPreferences((current) => ({ ...current, boardIds: current.boardIds.includes(board.id) ? current.boardIds.filter((id) => id !== board.id) : [...current.boardIds, board.id] }))} /><span><strong>{board.name}</strong><small>{board.kind || 'board'} · {board.state || 'active'}</small></span></label>
                  ))}
                </div>
              </section>
              <section className="monday-source-panel">
                <div className="monday-source-panel-head"><div><strong>Items to include</strong><span>Editable at any time</span></div></div>
                <div className="monday-assignment-modes">
                  <label className={mondayPreferences.assignmentMode === 'me' ? 'active' : ''}><input type="radio" name="monday-assignment" checked={mondayPreferences.assignmentMode === 'me'} onChange={() => setMondayPreferences((current) => ({ ...current, assignmentMode: 'me' }))} /><span><strong>Assigned to me</strong><small>Items where {mondayMetadata.me.name} appears in a People column</small></span></label>
                  <label className={mondayPreferences.assignmentMode === 'all' ? 'active' : ''}><input type="radio" name="monday-assignment" checked={mondayPreferences.assignmentMode === 'all'} onChange={() => setMondayPreferences((current) => ({ ...current, assignmentMode: 'all' }))} /><span><strong>Everything</strong><small>Every accessible item in the selected boards</small></span></label>
                  <label className={mondayPreferences.assignmentMode === 'users' ? 'active' : ''}><input type="radio" name="monday-assignment" checked={mondayPreferences.assignmentMode === 'users'} onChange={() => setMondayPreferences((current) => ({ ...current, assignmentMode: 'users' }))} /><span><strong>Selected people</strong><small>Choose one or more assignees</small></span></label>
                </div>
                {mondayPreferences.assignmentMode === 'users' && <>
                  <input className="monday-source-search" value={mondayUserSearch} onChange={(event) => setMondayUserSearch(event.target.value)} placeholder="Search people by name or email" />
                  <div className="monday-source-list people">
                    {mondayMetadata.users.filter((user) => user.enabled !== false && `${user.name} ${user.email || ''}`.toLowerCase().includes(mondayUserSearch.toLowerCase())).map((user) => (
                      <label key={user.id} className="monday-source-option"><input type="checkbox" checked={mondayPreferences.userIds.includes(user.id)} onChange={() => setMondayPreferences((current) => ({ ...current, userIds: current.userIds.includes(user.id) ? current.userIds.filter((id) => id !== user.id) : [...current.userIds, user.id] }))} /><span><strong>{user.name}{user.id === mondayMetadata.me.id ? ' (you)' : ''}</strong><small>{user.email || (user.isGuest ? 'Guest' : 'Monday user')}</small></span></label>
                    ))}
                  </div>
                </>}
              </section>
            </div>
            {mondayError && <div className="monday-source-error" role="alert">{mondayError}</div>}
            <div className="modal-footer"><button className="modal-btn secondary-btn" onClick={() => setMondaySourceModalOpen(false)}>Cancel</button><button className="modal-btn primary-btn" disabled={mondaySyncing || !mondayPreferences.boardIds.length} onClick={() => void saveMondaySourcesAndSync()}>{mondaySyncing ? 'Syncing…' : 'Save & Sync'}</button></div>
          </div>
        </div>
      )}

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
      {projectContextMenu && <div className="project-context-menu" style={{ top: projectContextMenu.y, left: projectContextMenu.x }} onClick={(event) => event.stopPropagation()}>
        <div className="project-context-title"><b>{projectContextMenu.project.name}</b><small>{getDomain(projectContextMenu.project.stagingUrl)}</small></div>
        <div className="project-context-divider" />
        <div className="project-context-move">
          <button><span>Move</span><span>›</span></button>
          <div className="project-context-submenu">
            {projectContextMenu.project.folderId && <button onClick={() => void moveProjectToFolder(projectContextMenu.project)}><span>Active Projects</span></button>}
            {folders.map((folder) => <button key={folder.id} className={projectContextMenu.project.folderId === folder.id ? 'active' : ''} onClick={() => void moveProjectToFolder(projectContextMenu.project, folder.id)}><span>{folder.name}</span>{projectContextMenu.project.folderId === folder.id && <em>✓</em>}</button>)}
            <div className="project-context-divider" />
            <button onClick={() => { setFolderEditor({ mode: 'create', name: '', projectId: projectContextMenu.project.id }); setProjectContextMenu(null) }}><span>New folder…</span></button>
          </div>
        </div>
        {(projectContextMenu.project.mondayTicketId || projectContextMenu.project.id.startsWith('monday-')) && <button onClick={() => void createSiblingProject(projectContextMenu.project)}>Create another page</button>}
        <button onClick={() => { const project = projectContextMenu.project; setProjectContextMenu(null); openProjectEditor(project) }}>Rename / Edit</button>
        <button onClick={() => { togglePinProject(projectContextMenu.project.id); setProjectContextMenu(null) }}>{pinnedProjectIds.includes(projectContextMenu.project.id) ? 'Unpin' : 'Pin'}</button>
        <div className="project-context-divider" />
        <button className="danger" onClick={() => { setDeleteConfirmProject(projectContextMenu.project); setProjectContextMenu(null) }}>Move to Trash</button>
      </div>}

      {folderEditor && <div className="folder-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFolderEditor(null) }}>
        <div className="folder-modal">
          <div className="folder-modal-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></div>
          <h3>{folderEditor.mode === 'rename' ? 'Rename folder' : 'Create folder'}</h3>
          <p>{folderEditor.projectId ? 'The selected project will be moved into this folder.' : 'Group related staging pages and projects.'}</p>
          <input autoFocus value={folderEditor.name} placeholder="Folder name" onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void submitFolderEditor(); if (event.key === 'Escape') setFolderEditor(null) }} />
          <div className="folder-modal-actions"><button onClick={() => setFolderEditor(null)}>Cancel</button><button className="primary" disabled={!folderEditor.name.trim()} onClick={() => void submitFolderEditor()}>{folderEditor.mode === 'rename' ? 'Save' : 'Create'}</button></div>
        </div>
      </div>}

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
