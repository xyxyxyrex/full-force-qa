import { useState } from 'react'
import { isBreakpoint } from '../../../../shared/designScale'
import { rowView } from '../../../../shared/trackerFormat'
import type { ChatMessage } from '../qaChatStore'
import { FindingCard, PictureLightbox, type FindingPicture } from '../QaFindings'
export default function Findings({ message }: { message: Extract<ChatMessage, { kind: 'findings' }> }) {
  const [pictures, setPictures] = useState<Record<number, FindingPicture | 'loading' | null>>({})
  const [zoom, setZoom] = useState<FindingPicture | null>(null)
  const load = () => {
    if (!isBreakpoint(message.breakpoint)) return
    message.rows.forEach((row, index) => {
      if (!row.evidence || pictures[index] !== undefined) return
      setPictures(previous => ({ ...previous, [index]: 'loading' }))
      void window.electronAPI.qaHistoryPicture(message.runId, { kind: 'draft', breakpoint: message.breakpoint as 'desktop' | 'tablet' | 'mobile', index, ...(message.area === 'functional' ? { area: 'functional' as const } : {}) }).then(src => setPictures(previous => ({ ...previous, [index]: src ? { src, caption: `${message.breakpoint} · ${message.pageUrl}` } : null }))).catch(() => setPictures(previous => ({ ...previous, [index]: null })))
    })
  }
  return <div className="qa-chat-findings"><details onToggle={event => { if (event.currentTarget.open) load() }}><summary>{message.rows.length} saved finding{message.rows.length === 1 ? '' : 's'} · {message.breakpoint}<small>{message.pageUrl}</small></summary><ol className="qa-findings">{message.rows.map((row, index) => <FindingCard key={index} index={index} view={rowView({version:1, columns:Object.keys(row.cells), examples:[]}, Object.values(row.cells))} picture={pictures[index]} onZoom={setZoom}/>)}</ol><button type="button" onClick={() => window.dispatchEvent(new CustomEvent('parity:open-qa-history', { detail: { tab: 'reviews' } }))}>Open review history</button></details><PictureLightbox picture={zoom} onClose={() => setZoom(null)}/></div>
}
