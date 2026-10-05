import { createRoot } from 'react-dom/client'
import Dashboard from '../../src/renderer/src/components/Dashboard'

localStorage.setItem('qa_project_folders', JSON.stringify([{ id: 'folder-one', name: 'Audit pages', createdAt: Date.now() }]))
const project = { id: 'project-one', name: 'Homepage', stagingUrl: 'https://example.test/', createdAt: Date.now(), lastOpenedAt: Date.now(), folderId: 'folder-one' }
const savedProjects: any[] = []
let failTwoOnce = true
;(window as any).__dashboardTest = { savedProjects, captureCalls: 0, newProjectFolders: [] as Array<string | undefined>, openedProjects: [] as string[], batchCalls: [] as any[], chatOpened: 0, batchResult: { started: true } as any }
window.addEventListener('parity:open-qa-chat', () => { (window as any).__dashboardTest.chatOpened += 1 })
;(window as any).electronAPI = {
  getProjects: async () => [project, ...savedProjects],
  saveProject: async (nextProject: any) => {
    if (nextProject.stagingUrl === 'https://two.test/' && failTwoOnce) { failTwoOnce = false; throw new Error('Simulated save failure') }
    const index = savedProjects.findIndex(item => item.id === nextProject.id)
    if (index >= 0) savedProjects[index] = nextProject
    else savedProjects.push(nextProject)
    return nextProject
  },
  qaAgentsSettings: async () => ({ functionalChecks: true }),
  qaBatchStart: async (options: any) => { (window as any).__dashboardTest.batchCalls.push(options); return (window as any).__dashboardTest.batchResult },
  capture: async () => { (window as any).__dashboardTest.captureCalls += 1; return { success: false } },
  ticketsList: async () => ({ records: [], ownerKey: null }),
  onAccountChanged: () => () => {},
  figmaTokenStatus: async () => ({ connected: false, apiConfigured: false, browserSession: false }),
  onFigmaAuthChanged: () => () => {},
}
createRoot(document.getElementById('root')!).render(<Dashboard
  onNewProject={(folderId) => (window as any).__dashboardTest.newProjectFolders.push(folderId)}
  onOpenProject={(nextProject) => (window as any).__dashboardTest.openedProjects.push(nextProject.id)}
/>)
