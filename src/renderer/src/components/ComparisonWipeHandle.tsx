import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { comparisonWipeFromDrag } from '../utils/comparisonWipe'
import './ComparisonWipeHandle.css'

interface Props {
  reveal: number
  opacity: number
  width: number
  onReveal: (value: number) => void
  onOpacity: (value: number) => void
}

export default function ComparisonWipeHandle({ reveal, opacity, width, onReveal, onOpacity }: Props) {
  const [dragging, setDragging] = useState(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragCleanupRef.current?.()

    const pointerId = event.pointerId
    const handle = event.currentTarget
    const start = { x: event.clientX, y: event.clientY, reveal, opacity }
    const endDrag = () => {
      if (!dragCleanupRef.current) return
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', stopPointer, true)
      window.removeEventListener('pointercancel', stopPointer, true)
      window.removeEventListener('mouseup', endDrag, true)
      window.removeEventListener('blur', endDrag)
      window.removeEventListener('keydown', stopOnEscape, true)
      document.removeEventListener('visibilitychange', stopWhenHidden)
      handle.removeEventListener('lostpointercapture', endDrag)
      dragCleanupRef.current = null
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId) } catch { /* A detached handle has no capture. */ }
      setDragging(false)
    }
    const move = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerId) return
      if (nextEvent.buttons === 0) { endDrag(); return }
      const next = comparisonWipeFromDrag(start, { x: nextEvent.clientX, y: nextEvent.clientY }, width)
      onReveal(next.reveal)
      onOpacity(next.opacity)
    }
    const stopPointer = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId === pointerId) endDrag()
    }
    const stopOnEscape = (nextEvent: KeyboardEvent) => {
      if (nextEvent.key === 'Escape') endDrag()
    }
    const stopWhenHidden = () => {
      if (document.hidden) endDrag()
    }

    dragCleanupRef.current = endDrag
    setDragging(true)
    try { handle.setPointerCapture(pointerId) } catch { /* The drag shield still catches release. */ }
    handle.addEventListener('lostpointercapture', endDrag)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', stopPointer, true)
    window.addEventListener('pointercancel', stopPointer, true)
    window.addEventListener('mouseup', endDrag, true)
    window.addEventListener('blur', endDrag)
    window.addEventListener('keydown', stopOnEscape, true)
    document.addEventListener('visibilitychange', stopWhenHidden)
  }

  return (
    <>
      {dragging && createPortal(<div className="comparison-drag-shield" aria-hidden="true" />, document.body)}
      <div className={`comparison-wipe ${dragging ? 'is-dragging' : ''} ${reveal > 60 ? 'near-right-edge' : ''}`} style={{ left: `${reveal}%` }}>
        <button
          type="button"
          className="comparison-wipe-handle"
          onPointerDown={beginDrag}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); onReveal(Math.max(0, reveal - 2)) }
            if (event.key === 'ArrowRight') { event.preventDefault(); onReveal(Math.min(100, reveal + 2)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); onOpacity(Math.min(100, opacity + 5)) }
            if (event.key === 'ArrowDown') { event.preventDefault(); onOpacity(Math.max(0, opacity - 5)) }
          }}
          aria-label={`Comparison reveal ${Math.round(reveal)} percent, opacity ${Math.round(opacity)} percent. Drag left or right to reveal, up or down to change opacity.`}
          title="Drag left/right to compare · up/down for opacity"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 6-5 6 5 6M16 6l5 6-5 6M3 12h18" /></svg>
        </button>
        <span className="comparison-wipe-value" aria-hidden="true"><b>Reveal {Math.round(reveal)}%</b><i>Opacity {Math.round(opacity)}%</i></span>
        <span className="comparison-opacity-gauge" aria-hidden="true">
          <small>OPACITY</small>
          <span className="comparison-opacity-track"><span style={{ height: `${opacity}%` }} /></span>
          <strong>{Math.round(opacity)}%</strong>
        </span>
      </div>
    </>
  )
}
