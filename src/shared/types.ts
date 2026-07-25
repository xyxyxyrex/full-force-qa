export interface CaptureResult {
  success: boolean
  html?: string
  error?: string
}

export interface Project {
  id: string
  name: string
  adminUrl: string
  stagingUrl: string
  createdAt: number
  lastOpenedAt: number
}

export interface ElectronAPI {
  login: (adminUrl: string) => Promise<void>
  capture: (url: string) => Promise<CaptureResult>
  getProjects: () => Promise<Project[]>
  saveProject: (project: Project) => Promise<void>
  deleteProject: (id: string) => Promise<void>
}
