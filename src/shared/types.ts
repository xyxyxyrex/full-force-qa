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
}

