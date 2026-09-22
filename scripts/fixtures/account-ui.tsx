import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AccountPanel from '../../src/renderer/src/components/AccountPanel'
import TicketQueue from '../../src/renderer/src/components/TicketQueue'
import CaptureScreen from '../../src/renderer/src/components/CaptureScreen'
import { listIntakeTickets } from '../../src/renderer/src/services/ticketService'
function TestApp() {
  const [projects, setProjects] = useState<any[]>([])
  const [capture, setCapture] = useState(false)
  useEffect(() => {
    const load = () => { void window.electronAPI.getProjects().then(setProjects) }
    load(); window.addEventListener('qa_projects_updated', load)
    return () => window.removeEventListener('qa_projects_updated', load)
  }, [])
  ;(window as any).intakeTickets = listIntakeTickets
  return <main style={{ padding: 24 }}><AccountPanel /><TicketQueue projects={projects} onOpenProject={() => {}} /><button onClick={() => setCapture(!capture)}>Test Capture</button>{capture && <CaptureScreen onCapture={() => {}} onAdd={() => {}} onBack={() => setCapture(false)} />}</main>
}
createRoot(document.getElementById('root')!).render(<TestApp />)
