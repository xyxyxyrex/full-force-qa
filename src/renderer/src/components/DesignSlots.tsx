import { useRef, useState } from 'react'
import { BREAKPOINTS, breakpointForFrameWidth, type Breakpoint } from '../../../shared/designScale'
import type { DesignSlots as DesignSlotsState, DesignSlotMeta } from '../../../shared/qaAgent'
import './DesignSlots.css'

const LABELS: Record<Breakpoint, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' }
const SCALE_OPTIONS = [1, 1.5, 2, 3, 4]

interface Props {
  slots: DesignSlotsState
  thumbnails: Partial<Record<Breakpoint, string>>
  /** The page these designs are for (its path), shown so it is clear what is loaded. */
  pageLabel?: string
  /** Something to tell the person about the breakpoint they are looking at, such as a missing design. */
  notice?: string
  activeBreakpoint?: Breakpoint | null
  busy?: boolean
  error?: string
  onAddFiles: (files: File[], target: Breakpoint | 'auto') => void
  onRemove: (breakpoint: Breakpoint) => void
  onMove: (breakpoint: Breakpoint, to: Breakpoint) => void
  onScale: (breakpoint: Breakpoint, scale: number) => void
}

const IMAGE_TYPES = /^image\/(png|jpeg|webp)$/

function sizeLabel(slot: DesignSlotMeta): string {
  return `${slot.frameWidth} px${slot.scale === 1 ? '' : ` · @${slot.scale}x`}`
}

/** Figma exports per breakpoint, stored by Parity so the QA agent can read them. */
export default function DesignSlots({ slots, thumbnails, pageLabel, notice, activeBreakpoint, busy, error, onAddFiles, onRemove, onMove, onScale }: Props) {
  const inputs = useRef<Partial<Record<Breakpoint, HTMLInputElement | null>>>({})
  const [dragOver, setDragOver] = useState<Breakpoint | null>(null)

  const takeFiles = (list: FileList | null | undefined, target: Breakpoint) => {
    const files = Array.from(list || []).filter((file) => IMAGE_TYPES.test(file.type))
    // Several images at once are sorted by their detected width; one image goes to the tile it was dropped on.
    if (files.length) onAddFiles(files, files.length === 1 ? target : 'auto')
  }

  return (
    <div className="design-slots" aria-label="Design images per breakpoint">
      <div className="design-slots-title">
        <span>Designs for QA agent</span>
        {busy && <small>Saving…</small>}
      </div>
      {pageLabel && <div className="design-slots-page" title="Designs are kept per page. Change the page and the designs change with it.">For page <code>{pageLabel}</code></div>}
      <div className="design-slots-grid">
        {BREAKPOINTS.map((breakpoint) => {
          const slot = slots[breakpoint]
          const detected = slot ? breakpointForFrameWidth(slot.frameWidth) : null
          const misplaced = !!slot && slot.detection !== 'manual' && slot.detection !== 'filename' && detected !== breakpoint
          return (
            <div
              key={breakpoint}
              className={`design-slot ${activeBreakpoint === breakpoint ? 'active' : ''} ${dragOver === breakpoint ? 'drag' : ''}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                setDragOver(breakpoint)
              }}
              onDragLeave={() => setDragOver((current) => (current === breakpoint ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                setDragOver(null)
                takeFiles(event.dataTransfer.files, breakpoint)
              }}
            >
              <div className="design-slot-name">
                <span>{LABELS[breakpoint]}</span>
                {slot && (
                  <button type="button" className="design-slot-x" title={`Remove the ${LABELS[breakpoint]} design`} aria-label={`Remove the ${LABELS[breakpoint]} design`} onClick={() => onRemove(breakpoint)}>×</button>
                )}
              </div>
              <button type="button" className="design-slot-thumb" onClick={() => inputs.current[breakpoint]?.click()} title={slot ? 'Replace this design' : 'Add a design'}>
                {slot && thumbnails[breakpoint] ? <img src={thumbnails[breakpoint]} alt={`${LABELS[breakpoint]} design`} /> : <span>Drop a PNG<br />or click</span>}
              </button>
              <input
                ref={(element) => { inputs.current[breakpoint] = element }}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  takeFiles(event.target.files, breakpoint)
                  event.target.value = ''
                }}
              />
              {slot ? (
                <>
                  {slot.fileName && <div className="design-slot-file" title={slot.fileName}>{slot.fileName}</div>}
                  <div className={`design-slot-size ${slot.confidence === 'low' ? 'low' : ''}`} title={`${slot.pixelWidth}×${slot.pixelHeight} px file`}>
                    {sizeLabel(slot)}{slot.confidence === 'low' ? ' · check scale' : ''}
                  </div>
                  <select className="design-slot-scale" value={slot.scale} onChange={(event) => onScale(breakpoint, Number(event.target.value))} aria-label={`${LABELS[breakpoint]} export scale`}>
                    {SCALE_OPTIONS.map((scale) => <option key={scale} value={scale}>{scale === 1 ? '1x (native)' : `@${scale}x export`}</option>)}
                  </select>
                  {misplaced && detected && (
                    <button type="button" className="design-slot-hint" onClick={() => onMove(breakpoint, detected)}>
                      Looks like {LABELS[detected]} → Move
                    </button>
                  )}
                </>
              ) : (
                <div className="design-slot-size empty">Empty</div>
              )}
            </div>
          )
        })}
      </div>
      {notice && !error && <div className="design-slots-notice" role="status">{notice}</div>}
      {error && <div className="design-slots-error" role="alert">{error}</div>}
    </div>
  )
}
