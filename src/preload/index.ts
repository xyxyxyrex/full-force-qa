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
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('app:openExternal', url)
  },
  openDetachedWindow(url: string, title?: string): Promise<void> {
    return ipcRenderer.invoke('app:openDetachedWindow', url, title)
  },
  figmaLoginWindow(url?: string): Promise<void> {
    return ipcRenderer.invoke('app:figmaLoginWindow', url)
  },
  toggleMaximizeWindow(): Promise<void> {
    return ipcRenderer.invoke('app:toggleMaximizeWindow')
  },
  createSnapshot(params: any): Promise<any> {
    return ipcRenderer.invoke('snapshot:create', params)
  },
  getSnapshots(projectId: string): Promise<any> {
    return ipcRenderer.invoke('snapshot:list', projectId)
  },
  deleteSnapshot(snapshotId: string): Promise<any> {
    return ipcRenderer.invoke('snapshot:delete', snapshotId)
  }
})
