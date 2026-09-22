import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import type { Project, ProjectFolder } from '../../../shared/types'
import mondayLogo from '../assets/monday-icon-svgrepo-com.svg'
import figmaIcon from '../assets/figma.png'
import sheetsIcon from '../assets/sheets.png'
import parityIcon from '../assets/parity-favicon.svg'
import parityLightIcon from '../assets/parity-light-512.png'
import type { MondayLink, MondayTicket } from '../utils/mondayApi'
import type { FigmaConnectionStatus } from '../../../shared/types'
import {
  canMoveFolder,
  countDirectFolderItems,
  getChildFolders,
  getFolderBreadcrumbs,
  getFolderDisplayPath,
} from '../utils/projectFolders'
import TicketQueue, { useTicketStore } from './TicketQueue'
import { toIntakeTicket, sameTicket, projectTicketRef } from '../../../shared/tickets'
import { saveTicket } from '../services/ticketService'
import './Dashboard.css'

export type { MondayTicket, MondayLink }

interface Props {
  onNewProject: (folderId?: string) => void
  onOpenProject: (project: Project, forceForm?: boolean) => void
  onOpenSettings?: () => void
  initialFolderId?: string | null
  initialTicketId?: string
  onFolderChange?: (location: { folderId: string | null; folderName: string; folderPath: string }) => void
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

interface ProjectContextMenuState { x: number; y: number; project: Project }
interface FolderContextMenuState { x: number; y: number; folder: ProjectFolder }
interface DashboardContextMenuState { x: number; y: number }
interface FolderEditorState { mode: 'create' | 'rename'; name: string; folderId?: string; parentId?: string; projectId?: string }
interface SelectionBox { left: number; top: number; width: number; height: number }

const GRADIENTS = [
  'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0d324d 0%, #7f5a83 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  'linear-gradient(135deg, #1e130c 0%, #4a2511 100%)',
  'linear-gradient(135deg, #11292b 0%, #1e5254 100%)'
]

const projectSelectionKey = (projectId: string) => `project:${projectId}`
const folderSelectionKey = (folderId: string) => `folder:${folderId}`

function GenericProjectThumbnail({ compact = false }: { compact?: boolean }) {
  return <span className={`generic-project-thumbnail ${compact ? 'compact' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3" width="27" height="18" rx="2.5" />
      <path d="M3 8h26" /><circle cx="6" cy="5.6" r=".7" fill="currentColor" stroke="none" /><circle cx="8.7" cy="5.6" r=".7" fill="currentColor" stroke="none" />
      <rect x="6" y="11" width="8" height="6.5" rx="1" /><path d="M17 11h8M17 14h6M17 17h7" />
    </svg>
  </span>
}

function FolderArtwork() {
  return <svg className="dashboard-folder-artwork" viewBox="0 0 112 88" aria-hidden="true">
    <path d="M7 17a8 8 0 0 1 8-8h27l10 11h45a8 8 0 0 1 8 8v48a8 8 0 0 1-8 8H15a8 8 0 0 1-8-8z" fill="currentColor" opacity=".58" />
    <path d="M7 29h98v47a8 8 0 0 1-8 8H15a8 8 0 0 1-8-8z" fill="currentColor" />
    <path d="M15 32h82a5 5 0 0 1 5 5v3H10v-3a5 5 0 0 1 5-5z" fill="var(--bg-card)" opacity=".72" />
  </svg>
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

export default function Dashboard({ onNewProject, onOpenProject, onOpenSettings, initialFolderId = null, initialTicketId, onFolderChange }: Props) {
  const viewOwner = localStorage.getItem('parity_account_owner_key')
  const saveScopedProject = (project: Project) => { project.localOwnerKey = viewOwner; return window.electronAPI.saveProject(project, viewOwner) }
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('recent')
  const [viewMode, setViewMode] = useState<ViewMode>('cards')
  const [trashExpanded, setTrashExpanded] = useState(false)
  const [folders, setFolders] = useState<ProjectFolder[]>(() => {
    try { return JSON.parse(localStorage.getItem('qa_project_folders') || '[]') } catch { return [] }
  })
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialFolderId)
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null)
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState | null>(null)
  const [dashboardContextMenu, setDashboardContextMenu] = useState<DashboardContextMenuState | null>(null)
  const [folderEditor, setFolderEditor] = useState<FolderEditorState | null>(null)
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [draggingSelectionKeys, setDraggingSelectionKeys] = useState<string[]>([])
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [selectedBrowserItems, setSelectedBrowserItems] = useState<Set<string>>(new Set())
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null)
  const selectionOriginRef = useRef<{ pointerId: number; clientX: number; clientY: number; additive: boolean } | null>(null)
  const selectionBaseRef = useRef<Set<string>>(new Set())

  const ticketStore = useTicketStore()
  const mondayTickets = useMemo(() => (ticketStore?.records || []).map(record => toIntakeTicket(record.ticket)), [ticketStore])
  const [figmaStatus, setFigmaStatus] = useState<FigmaConnectionStatus>({ connected: false, apiConfigured: false, browserSession: false })

  const activeTicketIds = (ticketStore?.records || []).filter(record => record.ticket.progress.active).map(record => record.ticket.id)

  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Close context menu on outside click
  useEffect(() => {
    const handleClose = () => { setContextMenu(null); setProjectContextMenu(null); setFolderContextMenu(null); setDashboardContextMenu(null) }
    window.addEventListener('click', handleClose)
    return () => window.removeEventListener('click', handleClose)
  }, [])

  useEffect(() => {
    localStorage.setItem('qa_project_folders', JSON.stringify(folders))
    window.dispatchEvent(new CustomEvent('qa_folders_updated', { detail: folders }))
    window.dispatchEvent(new CustomEvent('parity:account-state-dirty', { detail: { folders } }))
  }, [folders])

  useEffect(() => {
    if (currentFolderId && !folders.some((folder) => folder.id === currentFolderId)) setCurrentFolderId(null)
  }, [currentFolderId, folders])

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
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'qa_project_folders') {
        try { const next = JSON.parse(event.newValue || '[]'); if (Array.isArray(next)) setFolders(next) } catch {}
      }
      reloadProjects()
    }
    window.addEventListener('qa_projects_updated', onProjectsUpdated)
    window.addEventListener('qa_folders_updated', onFoldersUpdated)
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('qa_projects_updated', onProjectsUpdated); window.removeEventListener('qa_folders_updated', onFoldersUpdated); window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onStorage) }
  }, [reloadProjects])

  useEffect(() => {
    window.electronAPI.getProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
    void window.electronAPI.figmaTokenStatus().then(setFigmaStatus).catch(() => {})
    const unsubscribeFigma = window.electronAPI.onFigmaAuthChanged?.(setFigmaStatus)

    return () => unsubscribeFigma?.()
  }, [])

  const toggleActiveTicket = async (ticketId: string) => {
    const record = ticketStore?.records.find(item => item.ticket.id === ticketId || item.ticket.source.provider === 'monday' && item.ticket.source.externalId === ticketId)
    if (record) await saveTicket({ ...record.ticket, progress: { ...record.ticket.progress, active: !record.ticket.progress.active }, updatedAt: Date.now() }, ticketStore!.ownerKey)
    setContextMenu(null)
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

  // Open Edit Modal
  const startEditing = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setEditingProject(project)
    setEditName(project.name)
    setEditAdminUrl(project.adminUrl)
    setEditStagingUrl(project.stagingUrl)
    setEditMondayTicketId('')
  }

  // Save Edit
  const handleSaveEdit = async () => {
    if (!editingProject) return
    const updated: Project = {
      ...editingProject,
      name: editName.trim() || editingProject.name,
      adminUrl: editAdminUrl.trim(),
      stagingUrl: editStagingUrl.trim(),
      ticketRef: mondayTickets.find(ticket => ticket.id === editMondayTicketId)?.source || editingProject.ticketRef,
      mondayTicketId: editMondayTicketId ? (mondayTickets.find(ticket => ticket.id === editMondayTicketId)?.source.provider === 'monday' ? mondayTickets.find(ticket => ticket.id === editMondayTicketId)!.source.externalId : undefined) : editingProject.mondayTicketId
    }
    await saveScopedProject(updated)
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
    await saveScopedProject(updated)
    notifyProjectsChanged()
    setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
    setDeleteConfirmProject(null)
  }

  // Restore from Trash
  const handleRestore = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    const updated: Project = { ...project, inTrash: false }
    delete updated.deletedAt
    await saveScopedProject(updated)
    notifyProjectsChanged()
    setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
  }

  // Permanent Delete from Disk
  const handlePermanentDelete = async (projectId: string) => {
    await window.electronAPI.deleteProject(projectId, viewOwner)
    notifyProjectsChanged()
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
    setPermanentDeleteProject(null)
  }
  const openProjectEditor = (project: Project) => {
    setEditingProject(project)
    setEditName(project.name)
    setEditAdminUrl(project.adminUrl || '')
    setEditStagingUrl(project.stagingUrl || '')
    setEditMondayTicketId(mondayTickets.find(ticket => sameTicket(projectTicketRef(project, ticket.source.connectionId), ticket.source))?.id || '')
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
    await saveScopedProject(updated)
    notifyProjectsChanged()
    setProjects((current) => current.some((item) => item.id === updated.id) ? current.map((item) => item.id === updated.id ? updated : item) : current.concat(updated))
    setProjectContextMenu(null)
  }

  const prepareDashboardDrag = (event: React.DragEvent, primaryKey: string) => {
    const keys = selectedBrowserItems.has(primaryKey) ? [...selectedBrowserItems] : [primaryKey]
    if (!selectedBrowserItems.has(primaryKey)) setSelectedBrowserItems(new Set(keys))
    event.dataTransfer.setData('application/x-fullforce-dashboard-selection', JSON.stringify(keys))
    setDraggingSelectionKeys(keys)
    return keys
  }

  const beginProjectDrag = (event: React.DragEvent, project: Project) => {
    event.dataTransfer.effectAllowed = 'move'
    prepareDashboardDrag(event, projectSelectionKey(project.id))
    event.dataTransfer.setData('application/x-fullforce-project', project.id)
    event.dataTransfer.setData('text/plain', project.id)
    setDraggingFolderId(null)
    setDraggingProjectId(project.id)
  }

  const beginFolderDrag = (event: React.DragEvent, folder: ProjectFolder) => {
    event.dataTransfer.effectAllowed = 'move'
    prepareDashboardDrag(event, folderSelectionKey(folder.id))
    event.dataTransfer.setData('application/x-fullforce-folder', folder.id)
    event.dataTransfer.setData('text/plain', `folder:${folder.id}`)
    setDraggingProjectId(null)
    setDraggingFolderId(folder.id)
  }

  const moveFolderToFolder = (folderId: string, parentId?: string) => {
    if (!canMoveFolder(folders, folderId, parentId)) return
    setFolders((current) => current.map((folder) => folder.id === folderId
      ? { ...folder, parentId: parentId || undefined }
      : folder))
    setFolderContextMenu(null)
  }

  const canDropDraggedItem = (folderId?: string) => {
    const draggedFolderIds = draggingSelectionKeys
      .filter((key) => key.startsWith('folder:'))
      .map((key) => key.slice(7))
    if (!draggedFolderIds.length && draggingFolderId) draggedFolderIds.push(draggingFolderId)
    return draggedFolderIds.every((draggedId) => canMoveFolder(folders, draggedId, folderId))
  }

  const moveBrowserSelectionToFolder = async (keys: string[], folderId?: string) => {
    const folderIds = keys.filter((key) => key.startsWith('folder:')).map((key) => key.slice(7))
    if (!folderIds.every((id) => canMoveFolder(folders, id, folderId))) return

    if (folderIds.length) {
      const movedFolders = new Set(folderIds)
      setFolders((current) => current.map((folder) => movedFolders.has(folder.id)
        ? { ...folder, parentId: folderId || undefined }
        : folder))
    }

    const projectIds = new Set(keys.filter((key) => key.startsWith('project:')).map((key) => key.slice(8)))
    if (projectIds.size) {
      const selectedProjects = activeProjects.filter((project) => projectIds.has(project.id))
      const updatedProjects = selectedProjects.map((project) => ({ ...project, folderId: folderId || undefined }))
      await Promise.all(updatedProjects.map((project) => saveScopedProject(project)))
      const updatedById = new Map(updatedProjects.map((project) => [project.id, project]))
      setProjects((current) => {
        const next = current.map((project) => updatedById.get(project.id) || project)
        for (const project of updatedProjects) if (!current.some((item) => item.id === project.id)) next.push(project)
        return next
      })
      notifyProjectsChanged()
    }

    setSelectedBrowserItems(new Set())
  }

  const dropDashboardItem = async (event: React.DragEvent, folderId?: string) => {
    event.preventDefault()
    let selectionKeys: string[] = []
    try {
      const rawSelection = event.dataTransfer.getData('application/x-fullforce-dashboard-selection')
      const parsed = rawSelection ? JSON.parse(rawSelection) : []
      if (Array.isArray(parsed)) selectionKeys = parsed.filter((key): key is string => typeof key === 'string' && /^(folder|project):/.test(key))
    } catch {}
    const plainData = event.dataTransfer.getData('text/plain')
    const droppedFolderId = event.dataTransfer.getData('application/x-fullforce-folder') || (plainData.startsWith('folder:') ? plainData.slice(7) : '') || draggingFolderId
    const projectId = event.dataTransfer.getData('application/x-fullforce-project') || (!droppedFolderId ? plainData : '') || draggingProjectId
    setDragOverFolderId(null)
    setDraggingProjectId(null)
    setDraggingFolderId(null)
    setDraggingSelectionKeys([])
    if (selectionKeys.length) {
      await moveBrowserSelectionToFolder(selectionKeys, folderId)
      return
    }
    if (droppedFolderId) {
      moveFolderToFolder(droppedFolderId, folderId)
      return
    }
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
    await saveScopedProject(sibling)
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
      const folder: ProjectFolder = {
        id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        parentId: folderEditor.parentId || undefined,
        createdAt: Date.now(),
      }
      setFolders((current) => current.concat(folder))
      if (folderEditor.projectId) {
        const project = projects.find((item) => item.id === folderEditor.projectId) || activeProjects.find((item) => item.id === folderEditor.projectId) || projectContextMenu?.project
        if (project) await moveProjectToFolder(project, folder.id)
      }
    }
    setFolderEditor(null)
  }

  const deleteFolder = async (folder: ProjectFolder) => {
    const destinationName = folder.parentId
      ? folders.find((item) => item.id === folder.parentId)?.name || 'the parent folder'
      : 'Home'
    if (!window.confirm(`Delete “${folder.name}”? Its projects and subfolders will be moved to ${destinationName}.`)) return
    const affected = projects.filter((project) => project.folderId === folder.id)
    const updated = affected.map((project) => ({ ...project, folderId: folder.parentId || undefined }))
    await Promise.all(updated.map((project) => saveScopedProject(project)))
    notifyProjectsChanged()
    setProjects((current) => current.map((project) => project.folderId === folder.id ? { ...project, folderId: folder.parentId || undefined } : project))
    setFolders((current) => current
      .filter((item) => item.id !== folder.id)
      .map((item) => item.parentId === folder.id ? { ...item, parentId: folder.parentId || undefined } : item))
    if (currentFolderId === folder.id) setCurrentFolderId(folder.parentId || null)
    setFolderContextMenu(null)
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

  const activeProjects = useMemo((): (Project & { mondayTicket?: MondayTicket })[] => {
    return projects.filter(project => {
      if (project.inTrash) return false
      const linked = ticketStore?.records.find(({ ticket }) => sameTicket(projectTicketRef(project, ticket.source.connectionId), ticket.source))
      if (linked && (!linked.ticket.progress.active || linked.ticket.archived)) return false
      const query = searchQuery.toLowerCase().trim()
      return !query || [project.name, project.stagingUrl, project.adminUrl].some(value => value?.toLowerCase().includes(query))
    }).sort((a, b) => sortBy === 'recent' ? b.lastOpenedAt - a.lastOpenedAt : sortBy === 'oldest' ? a.lastOpenedAt - b.lastOpenedAt : sortBy === 'name-desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name))
  }, [projects, ticketStore, searchQuery, sortBy])

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

  const currentFolders = useMemo(
    () => getChildFolders(folders, currentFolderId),
    [currentFolderId, folders],
  )

  const currentFolderProjects = useMemo(
    () => activeProjects.filter((project) => (project.folderId || null) === currentFolderId),
    [activeProjects, currentFolderId],
  )

  const visibleActiveProjects = useMemo(
    () => currentFolderId
      ? currentFolderProjects
      : currentFolderProjects.filter((project) => !pinnedProjectIds.includes(project.id)),
    [currentFolderId, currentFolderProjects, pinnedProjectIds],
  )

  const folderBreadcrumbs = useMemo(
    () => getFolderBreadcrumbs(folders, currentFolderId),
    [currentFolderId, folders],
  )

  useEffect(() => {
    const currentFolder = folderBreadcrumbs[folderBreadcrumbs.length - 1]
    onFolderChange?.({
      folderId: currentFolder?.id || null,
      folderName: currentFolder?.name || '',
      folderPath: folderBreadcrumbs.map((folder) => folder.name).join(' / '),
    })
  }, [folderBreadcrumbs, onFolderChange])

  const folderMoveOptions = useMemo(
    () => folders
      .map((folder) => ({ folder, label: getFolderDisplayPath(folders, folder.id) }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })),
    [folders],
  )

  const getProjectTicketId = (project: DisplayProject) =>
    ticketStore?.records.find(({ ticket }) => sameTicket(projectTicketRef(project, ticket.source.connectionId), ticket.source))?.ticket.id || ''

  useEffect(() => {
    setSelectedBrowserItems(new Set())
    setSelectionBox(null)
    selectionOriginRef.current = null
  }, [currentFolderId, searchQuery])

  useEffect(() => {
    const visibleKeys = new Set([
      ...currentFolders.map((folder) => folderSelectionKey(folder.id)),
      ...visibleActiveProjects.map((project) => projectSelectionKey(project.id)),
    ])
    setSelectedBrowserItems((current) => {
      const next = new Set([...current].filter((key) => visibleKeys.has(key)))
      return next.size === current.size ? current : next
    })
  }, [currentFolders, visibleActiveProjects])

  const handleBrowserItemClick = (event: React.MouseEvent, key: string, openItem: () => void) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      setSelectedBrowserItems((current) => {
        const next = new Set(current)
        next.has(key) ? next.delete(key) : next.add(key)
        return next
      })
      return
    }
    if (selectedBrowserItems.has(key)) {
      event.preventDefault()
      event.stopPropagation()
      if (selectedBrowserItems.size > 1) return
    }
    setSelectedBrowserItems(new Set())
    openItem()
  }

  const beginMarqueeSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-selection-key], button, a, input, textarea, select, .dashboard-selection-actions')) return
    const surface = browserSurfaceRef.current
    if (!surface) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const additive = event.ctrlKey || event.metaKey
    selectionOriginRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, additive }
    selectionBaseRef.current = additive ? new Set(selectedBrowserItems) : new Set()
    if (!additive) setSelectedBrowserItems(new Set())
    const bounds = surface.getBoundingClientRect()
    setSelectionBox({ left: event.clientX - bounds.left, top: event.clientY - bounds.top, width: 0, height: 0 })
  }

  const updateMarqueeSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = selectionOriginRef.current
    const surface = browserSurfaceRef.current
    if (!origin || !surface || origin.pointerId !== event.pointerId) return
    const left = Math.min(origin.clientX, event.clientX)
    const top = Math.min(origin.clientY, event.clientY)
    const right = Math.max(origin.clientX, event.clientX)
    const bottom = Math.max(origin.clientY, event.clientY)
    const bounds = surface.getBoundingClientRect()
    setSelectionBox({ left: left - bounds.left, top: top - bounds.top, width: right - left, height: bottom - top })

    const next = new Set(selectionBaseRef.current)
    surface.querySelectorAll<HTMLElement>('[data-selection-key]').forEach((element) => {
      const itemBounds = element.getBoundingClientRect()
      const intersects = itemBounds.left < right && itemBounds.right > left && itemBounds.top < bottom && itemBounds.bottom > top
      if (intersects) next.add(element.dataset.selectionKey || '')
    })
    next.delete('')
    setSelectedBrowserItems(next)
  }

  const finishMarqueeSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = selectionOriginRef.current
    if (!origin || origin.pointerId !== event.pointerId) return
    selectionOriginRef.current = null
    setSelectionBox(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const deleteSelectedBrowserItems = async () => {
    const selectedFolderIds = new Set([...selectedBrowserItems].filter((key) => key.startsWith('folder:')).map((key) => key.slice(7)))
    const selectedProjectIds = new Set([...selectedBrowserItems].filter((key) => key.startsWith('project:')).map((key) => key.slice(8)))
    const selectedProjects = activeProjects.filter((project) => selectedProjectIds.has(project.id))
    const activeMondayProjects = selectedProjects.filter((project) => {
      const ticketId = getProjectTicketId(project)
      return !!ticketId && activeTicketIds.includes(ticketId)
    })
    const activeMondayIds = new Set(activeMondayProjects.map((project) => getProjectTicketId(project)).filter(Boolean))
    const localProjects = selectedProjects.filter((project) => !activeMondayProjects.some((item) => item.id === project.id))
    const selectedFolders = folders.filter((folder) => selectedFolderIds.has(folder.id))
    if (!selectedFolders.length && !selectedProjects.length) return

    const warnings = [
      `Remove ${selectedFolders.length + selectedProjects.length} selected item${selectedFolders.length + selectedProjects.length === 1 ? '' : 's'}?`,
      activeMondayProjects.length ? `${activeMondayProjects.length} active Monday project${activeMondayProjects.length === 1 ? '' : 's'} will be marked inactive, not permanently deleted.` : '',
      localProjects.length ? `${localProjects.length} captured project${localProjects.length === 1 ? '' : 's'} will be moved to Trash and can be restored.` : '',
      selectedFolders.length ? `${selectedFolders.length} folder${selectedFolders.length === 1 ? '' : 's'} will be removed; their contents will move up one level.` : '',
    ].filter(Boolean)
    if (!window.confirm(warnings.join('\n\n'))) return

    const folderParents = new Map(selectedFolders.map((folder) => [folder.id, folder.parentId]))
    const projectUpdates = new Map<string, Project>()
    for (const project of localProjects) projectUpdates.set(project.id, { ...project, inTrash: true, deletedAt: Date.now() })
    for (const project of projects) {
      if (project.folderId && folderParents.has(project.folderId) && !projectUpdates.has(project.id)) {
        projectUpdates.set(project.id, { ...project, folderId: folderParents.get(project.folderId) || undefined })
      }
    }
    await Promise.all([...projectUpdates.values()].map((project) => saveScopedProject(project)))
    if (projectUpdates.size) {
      setProjects((current) => current.map((project) => projectUpdates.get(project.id) || project))
      notifyProjectsChanged()
    }

    if (selectedFolders.length) {
      setFolders((current) => current
        .filter((folder) => !selectedFolderIds.has(folder.id))
        .map((folder) => folder.parentId && folderParents.has(folder.parentId)
          ? { ...folder, parentId: folderParents.get(folder.parentId) || undefined }
          : folder))
    }

    for (const id of activeMondayIds) await toggleActiveTicket(id)

    if (selectedProjectIds.size) {
      setPinnedProjectIds((current) => {
        const next = current.filter((projectId) => !selectedProjectIds.has(projectId))
        localStorage.setItem('pinned_project_ids', JSON.stringify(next))
        window.dispatchEvent(new CustomEvent('parity:account-state-dirty', { detail: { pinnedProjectIds: next } }))
        return next
      })
    }
    setSelectedBrowserItems(new Set())
  }

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

  const renderProjectList = (projectList: DisplayProject[]) => (
    <div className="project-list-table">
      <div className="list-header">
        <div className="col-pin" aria-hidden="true" />
        <div className="col-name">Project / Ticket Name</div>
        <div className="col-domain">Staging Domain</div>
        <div className="col-status">Status</div>
        <div className="col-time">Last Opened</div>
        <div className="col-actions">Actions</div>
      </div>
      {projectList.map((project) => {
        const isMonday = !!project.mondayTicket
        const isPinned = pinnedProjectIds.includes(project.id)
        return (
          <div
            key={project.id}
            className={`list-row ${isPinned ? 'is-pinned-row' : ''}`}
            draggable
            onDragStart={(event) => beginProjectDrag(event, project)}
            onDragEnd={() => { setDraggingProjectId(null); setDraggingFolderId(null); setDraggingSelectionKeys([]); setDragOverFolderId(null) }}
            onContextMenu={(event) => { event.preventDefault(); setProjectContextMenu({ x: event.clientX, y: event.clientY, project }) }}
            onClick={() => isMonday && !project.adminUrl ? onOpenProject(project) : onOpenProject(project)}
          >
            <button className="col-pin list-pin-btn" onClick={(event) => togglePinProject(project.id, event)} title={isPinned ? 'Unpin' : 'Pin'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? '#38bdf8' : 'none'} stroke={isPinned ? '#38bdf8' : 'currentColor'} strokeWidth="2">
                <path d="M12 17v5M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7z" />
              </svg>
            </button>
            <div className="col-name">
              <div className="list-icon" style={{ background: project.thumbnailUrl ? `url(${project.thumbnailUrl}) top center / cover` : getGradientForId(project.id) }}>
                {!project.thumbnailUrl && getDomain(project.stagingUrl || project.name).charAt(0).toUpperCase()}
              </div>
              <span title={project.name}>{project.name}</span>
            </div>
            <div className="col-domain" title={project.stagingUrl}>{getDomain(project.stagingUrl || project.name)}</div>
            <div className="col-status">
              <span className={`card-status-badge ${project.mondayTicket?.status ? `status-${project.mondayTicket.status.toLowerCase().replace(/\s+/g, '-')}` : 'local'}`}>
                {project.mondayTicket?.status || 'Local'}
              </span>
            </div>
            <div className="col-time">{formatDate(project.lastOpenedAt)}</div>
            <div className="col-actions" onClick={(event) => event.stopPropagation()}>
              <button className="list-action-btn" onClick={() => onOpenProject(project, true)} title="Edit Settings">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
              </button>
              {getProjectTicketId(project)
                ? renderSetInactiveButton(project, 'list-action-btn active-project-inactive-list-btn')
                : <button className="list-action-btn delete" onClick={() => setDeleteConfirmProject(project)} title="Move to Trash">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                  </button>}
            </div>
          </div>
        )
      })}
    </div>
  )

  // Trash Projects
  const trashProjects = useMemo(() => {
    return projects.filter((p) => p.inTrash)
  }, [projects])

  const openDashboardContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"], .project-card, .list-row, .dashboard-folder-tile, .monday-ticket-card, .project-context-menu, .folder-modal')) return
    event.preventDefault()
    setContextMenu(null)
    setProjectContextMenu(null)
    setFolderContextMenu(null)
    setSelectedBrowserItems(new Set())
    setDashboardContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 250)),
    })
  }

  return (
    <div className="dashboard" onContextMenu={openDashboardContextMenu}>
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
            <button className="new-project-btn" onClick={() => onNewProject(currentFolderId || undefined)}>
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
            <button className="dashboard-new-folder-btn" onClick={() => setFolderEditor({ mode: 'create', name: '', parentId: currentFolderId || undefined })}>
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

        {/* 1. PINNED PROJECTS SECTION (Top priority if any project is pinned) */}
        {!loading && !currentFolderId && pinnedProjects.length > 0 && (
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
            onDragEnd={() => { setDraggingProjectId(null); setDraggingFolderId(null); setDraggingSelectionKeys([]); setDragOverFolderId(null) }}
                      onClick={() => {
                        if (isMonday && !project.adminUrl) {
                          onOpenProject(project)
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
            {viewMode === 'list' && renderProjectList(pinnedProjects)}
          </div>
        )}

        {/* 2. FOLDERS, THEN ACTIVE PROJECTS */}
        <div
          ref={browserSurfaceRef}
          className={`dashboard-section dashboard-selection-surface active-project-dropzone ${dragOverFolderId === '__current__' ? 'drag-over' : ''} ${selectionBox ? 'is-selecting' : ''}`}
          style={{ marginBottom: 28 }}
          onPointerDown={beginMarqueeSelection}
          onPointerMove={updateMarqueeSelection}
          onPointerUp={finishMarqueeSelection}
          onPointerCancel={finishMarqueeSelection}
          onDragOver={(event) => { if (!canDropDraggedItem(currentFolderId || undefined)) { event.dataTransfer.dropEffect = 'none'; return }; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverFolderId('__current__') }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderId(null) }}
          onDrop={(event) => void dropDashboardItem(event, currentFolderId || undefined)}
        >
          {currentFolderId && <div className="section-label-row dashboard-browser-heading">
            <nav className="dashboard-folder-breadcrumbs" aria-label="Folder path">
              <button
                type="button"
                className={dragOverFolderId === '__root__' ? 'drop-target' : ''}
                onClick={() => setCurrentFolderId(null)}
                onDragOver={(event) => { event.stopPropagation(); if (!canDropDraggedItem()) { event.dataTransfer.dropEffect = 'none'; return }; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverFolderId('__root__') }}
                onDragLeave={() => setDragOverFolderId(null)}
                onDrop={(event) => { event.stopPropagation(); void dropDashboardItem(event) }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                Home
              </button>
              {folderBreadcrumbs.map((folder, index) => <span key={folder.id}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
                <button
                  type="button"
                  className={dragOverFolderId === `breadcrumb:${folder.id}` ? 'drop-target' : ''}
                  aria-current={index === folderBreadcrumbs.length - 1 ? 'page' : undefined}
                  onClick={() => setCurrentFolderId(folder.id)}
                  onDragOver={(event) => { event.stopPropagation(); if (!canDropDraggedItem(folder.id)) { event.dataTransfer.dropEffect = 'none'; return }; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverFolderId(`breadcrumb:${folder.id}`) }}
                  onDragLeave={() => setDragOverFolderId(null)}
                  onDrop={(event) => { event.stopPropagation(); void dropDashboardItem(event, folder.id) }}
                >{folder.name}</button>
              </span>)}
            </nav>
            <span className="dashboard-folder-item-count">{currentFolders.length + visibleActiveProjects.length} items</span>
          </div>}

          {selectedBrowserItems.size > 0 && <div className="dashboard-selection-actions">
            <strong>{selectedBrowserItems.size} selected</strong>
            <span>Drag any selected item to move the group.</span>
            <button type="button" onClick={() => setSelectedBrowserItems(new Set())}>Clear</button>
            <button type="button" className="danger" onClick={() => void deleteSelectedBrowserItems()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6" /></svg>
              Delete
            </button>
          </div>}

          {loading && <div className="dashboard-empty">Loading projects...</div>}

          {!loading && <>
            <div className="dashboard-folder-section-heading"><h3>Folders</h3><span>{currentFolders.length}</span></div>
            {currentFolders.length > 0 && <div className={`dashboard-folder-grid ${viewMode === 'list' ? 'is-list-view' : ''}`}>
            {currentFolders.map((folder) => {
              const selectionKey = folderSelectionKey(folder.id)
              const itemCount = countDirectFolderItems(folders, activeProjects, folder.id)
              const openFolderMenu = (x: number, y: number) => {
                setProjectContextMenu(null)
                setFolderContextMenu({ x, y, folder })
              }
              return <div
                className={`dashboard-folder-tile ${dragOverFolderId === folder.id ? 'drag-over' : ''} ${draggingFolderId === folder.id ? 'dragging' : ''}`}
                key={folder.id}
                data-selection-key={selectionKey}
                data-selected={selectedBrowserItems.has(selectionKey) || undefined}
                draggable
                onDragStart={(event) => beginFolderDrag(event, folder)}
            onDragEnd={() => { setDraggingProjectId(null); setDraggingFolderId(null); setDraggingSelectionKeys([]); setDragOverFolderId(null) }}
                onDragOver={(event) => { event.stopPropagation(); if (!canDropDraggedItem(folder.id)) { event.dataTransfer.dropEffect = 'none'; return }; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverFolderId(folder.id) }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderId(null) }}
                onDrop={(event) => { event.stopPropagation(); void dropDashboardItem(event, folder.id) }}
                onContextMenu={(event) => { event.preventDefault(); openFolderMenu(event.clientX, event.clientY) }}
              >
                <button type="button" className="dashboard-folder-open" onClick={(event) => handleBrowserItemClick(event, selectionKey, () => setCurrentFolderId(folder.id))} onDoubleClick={() => { setSelectedBrowserItems(new Set()); setCurrentFolderId(folder.id) }} title={`Open ${folder.name}`}>
                  <FolderArtwork />
                  <span className="dashboard-folder-copy">
                    <strong>{folder.name}</strong>
                    <small>{itemCount} {itemCount === 1 ? 'item' : 'items'}</small>
                  </span>
                </button>
                <button type="button" className="dashboard-folder-more" aria-label={`Folder actions for ${folder.name}`} onClick={(event) => { event.stopPropagation(); openFolderMenu(event.clientX, event.clientY) }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                </button>
              </div>
            })}
            </div>}
          </>}

          {!loading && <>
            <div className="dashboard-browser-section-separator" aria-hidden="true" />
            <div className="dashboard-folder-section-heading dashboard-active-projects-heading">
              <h3>Active Projects</h3>
              <span>{visibleActiveProjects.length}</span>
            </div>
          </>}

          {!loading && currentFolders.length === 0 && visibleActiveProjects.length === 0 && (!currentFolderId ? pinnedProjects.length === 0 : true) && (
            <div className="dashboard-empty">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#404040" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="36" height="36" rx="4" />
                  <path d="M6 18h36M18 18v24" />
                </svg>
              </div>
              <p>{searchQuery ? 'No matching projects found' : currentFolderId ? 'This folder is empty' : 'No active projects yet'}</p>
              <p className="empty-hint">{searchQuery ? 'Try clearing your search query' : currentFolderId ? 'Create a subfolder or move a project here' : 'Right-click a Monday ticket or click "New Capture" to get started'}</p>
            </div>
          )}

          {!loading && visibleActiveProjects.length > 0 && (
            <>
              {viewMode === 'cards' && (
                <div className="project-grid">
                  {visibleActiveProjects.map((project) => {
                    const selectionKey = projectSelectionKey(project.id)
                    const isMonday = !!project.mondayTicket
                    const statusColor = getStatusColor(project.mondayTicket?.status)

                    return (
                      <div
                        key={project.id}
                        className={`project-card ${isMonday ? 'has-monday-badge' : ''}`}
                        data-selection-key={selectionKey}
                        data-selected={selectedBrowserItems.has(selectionKey) || undefined}
                        draggable
                        onDragStart={(event) => beginProjectDrag(event, project)}
            onDragEnd={() => { setDraggingProjectId(null); setDraggingFolderId(null); setDraggingSelectionKeys([]); setDragOverFolderId(null) }}
                        onClick={(event) => handleBrowserItemClick(event, selectionKey, () => {
                          if (isMonday && !project.adminUrl) onOpenProject(project)
                          else onOpenProject(project)
                        })}
                        onDoubleClick={() => { setSelectedBrowserItems(new Set()); if (isMonday && !project.adminUrl) onOpenProject(project); else onOpenProject(project) }}
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
                  {visibleActiveProjects.map((project) => {
                    const selectionKey = projectSelectionKey(project.id)
                    const isMonday = !!project.mondayTicket
                    const isPinned = pinnedProjectIds.includes(project.id)

                    return (
                      <div
                        key={project.id}
                        className="list-row"
                        data-selection-key={selectionKey}
                        data-selected={selectedBrowserItems.has(selectionKey) || undefined}
                        draggable
                        onDragStart={(event) => beginProjectDrag(event, project)}
            onDragEnd={() => { setDraggingProjectId(null); setDraggingFolderId(null); setDraggingSelectionKeys([]); setDragOverFolderId(null) }}
                        onContextMenu={(event) => { event.preventDefault(); setProjectContextMenu({ x: event.clientX, y: event.clientY, project }) }}
                        onClick={(event) => handleBrowserItemClick(event, selectionKey, () => {
                          if (isMonday && !project.adminUrl) onOpenProject(project)
                          else onOpenProject(project)
                        })}
                        onDoubleClick={() => { setSelectedBrowserItems(new Set()); if (isMonday && !project.adminUrl) onOpenProject(project); else onOpenProject(project) }}
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
          {selectionBox && <div className="dashboard-selection-rectangle" style={{ left: selectionBox.left, top: selectionBox.top, width: selectionBox.width, height: selectionBox.height }} />}
        </div>

        {/* 3. MY MONDAY TICKETS SECTION */}
        <TicketQueue projects={projects} folderId={currentFolderId || undefined} initialTicketId={initialTicketId} onOpenProject={onOpenProject} />

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
                <div className={`project-grid ${viewMode === 'list' ? 'dashboard-trash-list' : ''}`}>
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
                  <p>Update this page and its linked ticket.</p>
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
                    <span>Autofill from ticket:</span>
                  </div>
                  <select
                    className="project-edit-select"
                    value={editMondayTicketId}
                    onChange={(event) => autofillEditFromMonday(event.target.value)}
                  >
                    <option value="">-- Select a ticket --</option>
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
      {folderEditor && <div className="folder-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFolderEditor(null) }}>
        <div className="folder-modal">
          <div className="folder-modal-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></div>
          <h3>{folderEditor.mode === 'rename' ? 'Rename folder' : 'Create folder'}</h3>
          <p>{folderEditor.projectId
            ? 'The selected project will be moved into this folder.'
            : folderEditor.parentId
              ? `Create this folder inside ${folders.find((folder) => folder.id === folderEditor.parentId)?.name || 'the current folder'}.`
              : 'Create a folder in Home to organize related projects.'}</p>
          <input autoFocus value={folderEditor.name} placeholder="Folder name" onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void submitFolderEditor(); if (event.key === 'Escape') setFolderEditor(null) }} />
          <div className="folder-modal-actions"><button onClick={() => setFolderEditor(null)}>Cancel</button><button className="primary" disabled={!folderEditor.name.trim()} onClick={() => void submitFolderEditor()}>{folderEditor.mode === 'rename' ? 'Save' : 'Create'}</button></div>
        </div>
      </div>}


    </div>
  )
}
