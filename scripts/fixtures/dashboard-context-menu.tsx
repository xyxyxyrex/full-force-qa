import { createRoot } from 'react-dom/client'
import Dashboard from '../../src/renderer/src/components/Dashboard'

localStorage.setItem('qa_project_folders', JSON.stringify([{ id: 'folder-one', name: 'Audit pages', createdAt: Date.now() }]))
const project = { id: 'project-one', name: 'Homepage', stagingUrl: 'https://example.test/', createdAt: Date.now(), lastOpenedAt: Date.now(), folderId: 'folder-one' }
;(window as any).electronAPI = {
  getProjects: async () => [project],
  saveProject: async () => project,
  ticketsList: async () => ({ records: [], ownerKey: null }),
  onAccountChanged: () => () => {},
  figmaTokenStatus: async () => ({ connected: false, apiConfigured: false, browserSession: false }),
  onFigmaAuthChanged: () => () => {},
}
createRoot(document.getElementById('root')!).render(<Dashboard onNewProject={() => {}} onOpenProject={() => {}} />)
