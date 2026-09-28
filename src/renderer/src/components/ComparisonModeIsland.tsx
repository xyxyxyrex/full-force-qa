import './ComparisonModeIsland.css'
import type { CSSProperties } from 'react'

type Mode = 'overlay' | 'side-by-side' | 'diff'

interface Props {
  mode: Mode
  hasImage: boolean
  onModeChange: (mode: Mode) => void
  style?: CSSProperties
}

export default function ComparisonModeIsland({ mode, hasImage, onModeChange, style }: Props) {
  return (
    <div className="comparison-mode-island" style={style} role="group" aria-label="Figma comparison mode" onPointerDown={(event) => event.stopPropagation()}>
      <span className="comparison-mode-source" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="9" height="9" rx="1"/><rect x="12" y="12" width="9" height="9" rx="1"/><path d="M12 3h4a3 3 0 0 1 3 3v4"/></svg>
        Figma
      </span>
      <span className="comparison-mode-divider" aria-hidden="true" />
      <button type="button" className={mode === 'overlay' ? 'active' : ''} disabled={!hasImage} aria-pressed={mode === 'overlay'} title={hasImage ? 'Drag the divider to reveal and adjust opacity' : 'Paste a PNG to use Overlay'} onClick={() => onModeChange('overlay')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></svg>
        Overlay
      </button>
      <button type="button" className={mode === 'side-by-side' ? 'active' : ''} aria-pressed={mode === 'side-by-side'} title="Show the Figma reference beside the page" onClick={() => onModeChange('side-by-side')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="2" y="4" width="9" height="16" rx="2"/><rect x="13" y="4" width="9" height="16" rx="2"/></svg>
        Side
      </button>
      <button type="button" className={mode === 'diff' ? 'active' : ''} disabled={!hasImage} aria-pressed={mode === 'diff'} title={hasImage ? 'Show difference and adjust contrast in the Figma menu' : 'Paste a PNG to use Diff'} onClick={() => onModeChange('diff')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 20 20 4M5 5h5M5 5v5M19 19h-5m5 0v-5"/><circle cx="12" cy="12" r="2"/></svg>
        Diff
      </button>
    </div>
  )
}
