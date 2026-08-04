import { useEffect, useRef, useState } from 'react'
import './SmoothColorPicker.css'

interface Props {
  value: string
  onPreview?: (value: string) => void
  onCommit: (value: string) => void
  title?: string
  compact?: boolean
}

type Hsv = { h: number; s: number; v: number }

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

function normalizeHex(value: string) {
  const raw = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(raw)) return `#${raw.slice(1).split('').map((part) => part + part).join('')}`.toUpperCase()
  const rgb = raw.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)
  if (!rgb) return '#000000'
  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => clamp(Number(part), 0, 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

function hexToHsv(value: string): Hsv {
  const hex = normalizeHex(value)
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min
  let h = 0
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h = Math.round(h * 60); if (h < 0) h += 360
  }
  return { h, s: max ? delta / max : 0, v: max }
}

function hsvToHex({ h, s, v }: Hsv) {
  const c = v * s; const x = c * (1 - Math.abs((h / 60) % 2 - 1)); const m = v - c
  let rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return `#${rgb.map((part) => Math.round((part + m) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

export default function SmoothColorPicker({ value, onPreview, onCommit, title = 'Color', compact = false }: Props) {
  const normalized = normalizeHex(value)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(normalized)
  const [text, setText] = useState(normalized)
  const rootRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  const frameRef = useRef(0)

  useEffect(() => {
    if (open) return
    const next = normalizeHex(value)
    setDraft(next); setText(next); draftRef.current = next
  }, [value, open])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])

  const preview = (next: string) => {
    draftRef.current = next; setDraft(next); setText(next)
    if (!onPreview || frameRef.current) return
    frameRef.current = requestAnimationFrame(() => { frameRef.current = 0; onPreview(draftRef.current) })
  }
  const commit = (next = draftRef.current) => {
    const color = normalizeHex(next)
    if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = 0 }
    draftRef.current = color; setDraft(color); setText(color); onCommit(color)
  }
  const hsv = hexToHsv(draft)
  const updatePlane = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    preview(hsvToHex({ h: hexToHsv(draftRef.current).h, s: clamp((event.clientX - rect.left) / rect.width), v: 1 - clamp((event.clientY - rect.top) / rect.height) }))
  }
  const startPlane = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); updatePlane(event)
  }

  return <div ref={rootRef} className={`smooth-color-picker ${compact ? 'compact' : ''}`} onPointerDown={(event) => event.stopPropagation()}>
    <button type="button" className="smooth-color-trigger" title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      {compact && <span>A</span>}<i style={{ background: draft }} />{!compact && <code>{draft}</code>}
    </button>
    {open && <div className="smooth-color-popover">
      <div className="smooth-color-plane" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={startPlane} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePlane(event) }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); commit() }} onPointerCancel={() => commit()}>
        <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <input className="smooth-color-hue" type="range" min="0" max="359" value={hsv.h} aria-label="Hue" onInput={(event) => preview(hsvToHex({ ...hexToHsv(draftRef.current), h: Number(event.currentTarget.value) }))} onPointerUp={() => commit()} onKeyUp={() => commit()} />
      <div className="smooth-color-hex-row"><i style={{ background: draft }} /><span>#</span><input value={text.replace(/^#/, '')} maxLength={6} spellCheck={false} aria-label="Hex color" onChange={(event) => { const raw = event.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase(); setText(`#${raw}`); if (raw.length === 6) preview(`#${raw}`) }} onBlur={() => commit(text)} onKeyDown={(event) => { if (event.key === 'Enter') { commit(text); event.currentTarget.blur() } }} /></div>
    </div>}
  </div>
}

