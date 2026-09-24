import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import FeedbackModal from '../../src/renderer/src/components/FeedbackModal'
import '../../src/renderer/src/theme/themes.css'

function Fixture() {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" aria-label="Feedback and report a bug" onClick={() => setOpen(true)}>Feedback</button>
    {open && <FeedbackModal initialArea="audit" onClose={() => setOpen(false)} onOpenAccount={() => { (window as any).__openedAccount = true; setOpen(false) }} />}
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
