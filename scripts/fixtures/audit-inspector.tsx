import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AuditInspectorPanel from '../../src/renderer/src/components/AuditInspectorPanel'
import { attachLiveEditor } from '../../src/renderer/src/utils/liveEditorBridge'
import { collectAuditableTextElements } from '../../src/renderer/src/utils/grammarSpellAudit'

const html = '<!doctype html><html><head><style>.cs-hero h1 { color: red; font-size: 24px; } h1 { color: blue; } .cs-hero h1:hover { background: yellow; }</style></head><body><section class="cs-hero"><h1 id="primary">Weight</h1><h1 id="secondary">Calculator</h1><ul><li><p>Tubings for sale</p></li></ul><div style="display:none"><p>Invisible phrase</p></div></section></body></html>'

function Fixture() {
  const [doc, setDoc] = useState<Document | null>(null)
  const [selected, setSelected] = useState<HTMLElement | null>(null)
  const [revision, setRevision] = useState(0)
  const bridge = useRef<ReturnType<typeof attachLiveEditor> | null>(null)
  useEffect(() => {
    if (!doc) return
    ;(window as any).auditTextElements = () => collectAuditableTextElements(doc)
    bridge.current = attachLiveEditor(doc, { mode: 'edit', onSelect: (_, element) => setSelected(element), onChange: () => {} })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') bridge.current?.deselect() }
    doc.addEventListener('keydown', escape, true)
    return () => { delete (window as any).auditTextElements; doc.removeEventListener('keydown', escape, true); bridge.current?.cleanup(); bridge.current = null }
  }, [doc])
  return <><iframe id="page" srcDoc={html} onLoad={(event) => setDoc(event.currentTarget.contentDocument)} /><AuditInspectorPanel doc={doc} selected={selected} revision={revision} annotations={[]} activeViewport={{ width: 300, height: 130 }} onSelect={(element) => { bridge.current?.selectElement(element); setSelected(element) }} onSelectAnnotation={() => {}} onChange={() => setRevision((value) => value + 1)} /></>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
