import React from 'react'
import { createRoot } from 'react-dom/client'
import AuditMediaGallery from '../../src/renderer/src/components/AuditMediaGallery'
import { collectAuditMedia } from '../../src/renderer/src/utils/auditMediaGallery'

const base = new URLSearchParams(location.search).get('base') || ''
const resources = [
  { url: `${base}/photo.png`, kind: 'image' as const, source: 'img[src]', selector: 'main img' },
  { url: `${base}/photo.png`, kind: 'image' as const, source: 'CSS url()', selector: '.hero' },
  { url: 'inline-svg:1', kind: 'image' as const, source: 'inline svg', selector: 'svg', inlineContent: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="purple"/></svg>', mimeType: 'image/svg+xml' },
  { url: `${base}/sound.wav`, kind: 'audio' as const, source: 'audio[src]', selector: 'audio' },
  { url: `${base}/clip.mp4`, kind: 'video' as const, source: 'video[src]', selector: 'video' }
]

function Fixture() {
  const [open, setOpen] = React.useState(true)
  const items = React.useMemo(() => collectAuditMedia(resources), [])
  return <>
    <button type="button" id="reopen" onClick={() => setOpen(true)}>Open gallery</button>
    {open && <AuditMediaGallery
      items={items} sourceUrl={`${base}/page`} coveragePartial={false} capturedAt={Date.now()}
      onClose={() => setOpen(false)} onLocate={selector => { (window as any).__located = selector; return true }}
      onExportAll={() => {
        setOpen(false)
        void (async () => {
          const payload = { html: '<html></html>', sourceUrl: `${base}/page`, report: {}, resources, text: [], visibleText: '', markdown: '', links: [], seo: { title: '', description: '', canonical: '', robots: '', meta: {}, headings: [], hreflang: [], openGraph: {}, twitter: {}, structuredData: [] } }
          const plan = await (window as any).electronAPI.scanAuditExport({ kind: 'media', payload })
          ;(window as any).__bulkResult = await (window as any).electronAPI.startAuditExport(plan.planId)
        })().catch(error => { (window as any).__bulkError = String(error) })
      }}
    />}
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
