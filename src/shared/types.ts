export interface CaptureResult {
  success: boolean
  html?: string
  error?: string
  is404?: boolean
  isSessionExpired?: boolean
}

export interface Project {
  id: string
  name: string
  adminUrl: string
  stagingUrl: string
  figmaUrl?: string
  googleSheetUrl?: string
  createdAt: number
  lastOpenedAt: number
  thumbnailUrl?: string
  inTrash?: boolean
  deletedAt?: number
}

export interface SnapshotItem {
  id: string
  projectId: string
  title: string
  type: 'image' | 'html'
  timestamp: number
  fileSizeBytes: number
  fileSizeFormatted: string
  dataUrl?: string
  url: string
  viewportWidth?: number
  viewportHeight?: number
}

export type AppTheme =
  | 'dark'
  | 'light'
  | 'catppuccin-mocha'
  | 'nord'
  | 'cyberpunk-gold'
  | 'tokyo-night'
  | 'dracula'
  | 'synthwave-84'
  | 'github-dark'
  | 'rose-pine'
  | 'monokai-pro'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'emerald-abyss'
  | 'one-dark-pro'
  | 'sunset-crimson'

export interface AppHotkeys {
  quickSave: string
  undo: string
  redo: string
  toggleRulers: string
  toggleBoundaries: string
  resetZoom: string
  deselect: string
  panMode: string
}

export interface AppSettings {
  theme: AppTheme
  snapshotDirectory: string
  autoPurgeTrashDays: number
  captureDpiScale: number
  captureTimeoutMs: number
  defaultViewport: string
  mondaySyncIntervalMinutes: number
  hotkeys: AppHotkeys
}

export interface ElectronAPI {
  login: (adminUrl: string) => Promise<void>
  mondayLogin: () => Promise<{ success: boolean; token?: string; error?: string }>
  capture: (url: string) => Promise<CaptureResult>
  getProjects: () => Promise<Project[]>
  saveProject: (project: Project) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  openDetachedWindow: (url: string, title?: string) => Promise<void>
  figmaLoginWindow: (url?: string) => Promise<void>
  toggleMaximizeWindow: () => Promise<void>
  selectSnapshotDirectory: () => Promise<{ success: boolean; path?: string }>
  createSnapshot: (params: {
    projectId: string
    url: string
    type: 'image' | 'html'
    title?: string
    htmlContent?: string
    dataUrl?: string
    viewportWidth?: number
    viewportHeight?: number
  }) => Promise<{ success: boolean; snapshot?: SnapshotItem; error?: string }>
  getSnapshots: (projectId: string) => Promise<SnapshotItem[]>
  deleteSnapshot: (snapshotId: string) => Promise<{ success: boolean }>
  runGrammarSpellAudit: (items: Array<{ id: string; tag: string; text: string; index: number }>) => Promise<any>
  onGlobalEscape: (callback: () => void) => () => void
}

