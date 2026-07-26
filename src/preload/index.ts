import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureResult, Project } from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  login(adminUrl: string): Promise<void> {
    return ipcRenderer.invoke('auth:login', adminUrl)
  },
  mondayLogin(): Promise<{ success: boolean; token?: string; error?: string }> {
    return ipcRenderer.invoke('monday:login')
  },
  capture(url: string): Promise<CaptureResult> {
    return ipcRenderer.invoke('capture:start', url)
  },
  getProjects(): Promise<Project[]> {
    return ipcRenderer.invoke('projects:list')
  },
  saveProject(project: Project): Promise<void> {
    return ipcRenderer.invoke('projects:save', project)
  },
  deleteProject(id: string): Promise<void> {
    return ipcRenderer.invoke('projects:delete', id)
  }
})
