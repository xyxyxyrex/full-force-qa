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
}
