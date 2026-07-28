import { useState, useEffect, useCallback, useRef } from 'react'

/* ═══════════════════════════════════════════════════════════
   NativeStylePanel — Figma-style compact style inspector
   ═══════════════════════════════════════════════════════════ */

interface Props {
  selectedElement: HTMLElement | null
  onStyleChange: (property: string, value: string, isFinalCommit?: boolean) => void
  styleRevision?: number
}

// ─── Constants ─────────────────────────────────────────────

const COMMON_FONTS = [
  'Arial, Helvetica, sans-serif', 'Helvetica, Arial, sans-serif',
  'Georgia, serif', 'Times New Roman, Times, serif',
  'Courier New, Courier, monospace', 'Verdana, Geneva, sans-serif',
  'Tahoma, Geneva, sans-serif', 'Trebuchet MS, Helvetica, sans-serif',
  'Roboto, sans-serif', 'Open Sans, sans-serif', 'Lato, sans-serif',
  'Poppins, sans-serif', 'Montserrat, sans-serif', 'Inter, sans-serif',
]

const FONT_WEIGHTS = [
  { value: '100', label: 'Thin (100)' }, { value: '200', label: 'Extra Light (200)' },
  { value: '300', label: 'Light (300)' }, { value: '400', label: 'Regular (400)' },
  { value: '500', label: 'Medium (500)' }, { value: '600', label: 'Semi Bold (600)' },
  { value: '700', label: 'Bold (700)' }, { value: '800', label: 'Extra Bold (800)' },
  { value: '900', label: 'Black (900)' },
]

const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']
const DIM_UNITS = ['px', '%', 'em', 'rem', 'vw', 'vh']

// ─── Helpers ───────────────────────────────────────────────

function rgbToHex(rgb: string): string {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return 'transparent'
  if (rgb.startsWith('#')) return rgb
  const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!match) return '#000000'
  const hex = (x: string) => ('0' + parseInt(x, 10).toString(16)).slice(-2)
  return '#' + hex(match[1]) + hex(match[2]) + hex(match[3])
}

function parseNumeric(val: string): { num: string; unit: string } {
  if (!val) return { num: '', unit: 'px' }
  const v = val.trim()
  if (/^(auto|normal|inherit|initial|none|transparent)$/i.test(v)) return { num: v, unit: '-' }
  const m = v.match(/^(-?\d*\.?\d+)\s*(px|%|em|rem|vh|vw|pt|ch)?$/i)
  if (m) return { num: m[1], unit: (m[2] || 'px').toLowerCase() }
  return { num: v, unit: '-' }
}

function buildCssValue(num: string, unit: string): string {
  if (/^(auto|normal|inherit|initial|none|transparent|)$/i.test(num)) return num
  if (unit === '-' || !unit) return num
  if (/^-?\d*\.?\d+$/.test(num)) return num + unit
  return num
}

// ─── Scrub: middle-mouse drag to adjust values ─────────────

function stepForUnit(unit: string): { step: number; precision: number } {
  if (unit === 'em' || unit === 'rem') return { step: 0.1, precision: 1 }
  return { step: 1, precision: 0 }
}

function useScrub(opts: {
  getValue: () => number
  step: number
  precision: number
  onScrub: (num: number, isFinal: boolean) => void
  min?: number
  max?: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    const o = optsRef.current
    let cur = o.getValue()
    if (isNaN(cur)) cur = 0
    ref.current?.requestPointerLock?.()
    const onMove = (ev: MouseEvent) => {
      let s = optsRef.current.step
      if (ev.shiftKey) s *= 10
      if (ev.altKey) s *= 0.1
      cur += -ev.movementY * s
      const { min, max, precision } = optsRef.current
      if (min !== undefined) cur = Math.max(min, cur)
      if (max !== undefined) cur = Math.min(max, cur)
      optsRef.current.onScrub(Number(cur.toFixed(precision)), false)
    }
    const onUp = () => {
      document.exitPointerLock?.()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      optsRef.current.onScrub(Number(cur.toFixed(optsRef.current.precision)), true)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return { ref, onMouseDown }
}

// ─── SVG Icons ─────────────────────────────────────────────

const icoProps = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor' }

const IcoAlignLeft = () => <svg {...icoProps}><rect x="1" y="2" width="14" height="1.6" rx=".8"/><rect x="1" y="6" width="9" height="1.6" rx=".8"/><rect x="1" y="10" width="12" height="1.6" rx=".8"/><rect x="1" y="14" width="7" height="1.6" rx=".8"/></svg>
const IcoAlignCenter = () => <svg {...icoProps}><rect x="1" y="2" width="14" height="1.6" rx=".8"/><rect x="3.5" y="6" width="9" height="1.6" rx=".8"/><rect x="2" y="10" width="12" height="1.6" rx=".8"/><rect x="4.5" y="14" width="7" height="1.6" rx=".8"/></svg>
const IcoAlignRight = () => <svg {...icoProps}><rect x="1" y="2" width="14" height="1.6" rx=".8"/><rect x="6" y="6" width="9" height="1.6" rx=".8"/><rect x="3" y="10" width="12" height="1.6" rx=".8"/><rect x="8" y="14" width="7" height="1.6" rx=".8"/></svg>
const IcoAlignJustify = () => <svg {...icoProps}><rect x="1" y="2" width="14" height="1.6" rx=".8"/><rect x="1" y="6" width="14" height="1.6" rx=".8"/><rect x="1" y="10" width="14" height="1.6" rx=".8"/><rect x="1" y="14" width="14" height="1.6" rx=".8"/></svg>

const IcoUnderline = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 2v5a4 4 0 008 0V2"/><line x1="3" y1="14.5" x2="13" y2="14.5"/></svg>
const IcoStrikethrough = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><line x1="1" y1="8" x2="15" y2="8"/><path d="M11 5.5C10.5 4 9.2 3 8 3S5 4 5 5.5c0 1 .7 1.8 2 2.5m1 0c1.5.5 3 1.5 3 2.5 0 1.5-1.5 2.5-3 2.5S5 12 5 11"/></svg>

const IcoLetterSpacing = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><text x="1" y="10" fontSize="8" fontWeight="700" fontFamily="Arial">A</text><text x="7.5" y="10" fontSize="8" fontWeight="700" fontFamily="Arial">V</text><path d="M3.5 12.5h7" stroke="currentColor" strokeWidth=".8" fill="none"/><path d="M3.5 11.5L2 12.5l1.5 1" stroke="currentColor" strokeWidth=".7" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="M10.5 11.5L12 12.5l-1.5 1" stroke="currentColor" strokeWidth=".7" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoLineHeight = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="5" y="1.5" width="8" height="1.2" rx=".6"/><rect x="5" y="6.4" width="8" height="1.2" rx=".6"/><rect x="5" y="11.3" width="8" height="1.2" rx=".6"/><path d="M2 3L2 11" stroke="currentColor" strokeWidth=".8" fill="none"/><path d="M1 4L2 2l1 2" stroke="currentColor" strokeWidth=".7" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="M1 10L2 12l1-2" stroke="currentColor" strokeWidth=".7" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoTextIndent = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="5" y="2" width="8" height="1.2" rx=".6"/><rect x="1" y="5.5" width="12" height="1.2" rx=".6"/><rect x="1" y="9" width="12" height="1.2" rx=".6"/><rect x="1" y="12.5" width="8" height="1.2" rx=".6"/><path d="M1 2L3.5 3.5L1 5" stroke="currentColor" strokeWidth=".9" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
const IcoWordSpacing = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><text x=".5" y="9" fontSize="7" fontWeight="700" fontFamily="Arial">W</text><path d="M10.5 4v6" stroke="currentColor" strokeWidth=".8" strokeDasharray="1.2 1" fill="none"/><text x="11" y="9" fontSize="7" fontWeight="700" fontFamily="Arial">S</text></svg>

// ─── Shared Styles ─────────────────────────────────────────

const base = {
  bg: '#18181b',
  border: '#3f3f46',
  text: '#e4e4e7',
  muted: '#71717a',
  dim: '#52525b',
  accent: '#2563eb',
}

const inputBase: React.CSSProperties = {
  background: base.bg, border: `1px solid ${base.border}`,
  color: base.text, fontSize: '11px', outline: 'none',
  fontFamily: 'inherit', minWidth: 0,
}

// ─── Sub-components ────────────────────────────────────────

function SectorHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', padding: '2px 0' }}>
      <svg width="8" height="8" viewBox="0 0 8 8" style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : '', color: base.muted, flexShrink: 0 }}>
        <path d="M2 0.5 L6 4 L2 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span style={{ fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#a1a1aa' }}>{title}</span>
    </div>
  )
}

/** Compact input + unit selector */
function DimInput({ value, units, onChange, placeholder, compact }: {
  value: string; units?: string[]; onChange: (v: string, isFinal?: boolean) => void
  placeholder?: string; compact?: boolean
}) {
  const { num, unit } = parseNumeric(value)
  const activeUnits = units || DIM_UNITS
  const resolvedUnit = unit === '-' ? 'px' : unit
  const { step, precision } = stepForUnit(resolvedUnit)
  const scrub = useScrub({
    getValue: () => parseFloat(num) || 0, step, precision,
    onScrub: (n, f) => onChange(buildCssValue(String(n), resolvedUnit), f),
  })

  return (
    <div style={{ display: 'flex', minWidth: 0 }}>
      <input ref={scrub.ref} type="text" value={num} placeholder={placeholder}
        onChange={(e) => onChange(buildCssValue(e.target.value, resolvedUnit))}
        onMouseDown={scrub.onMouseDown}
        style={{ ...inputBase, borderRight: 'none', borderRadius: '3px 0 0 3px', padding: compact ? '3px 4px' : '4px 6px', width: '100%' }}
      />
      <select value={unit === '-' ? '-' : unit}
        onChange={(e) => onChange(buildCssValue(num, e.target.value))}
        style={{ ...inputBase, borderLeft: 'none', borderRadius: '0 3px 3px 0', color: base.dim, padding: '0 1px', fontSize: '10px', cursor: 'pointer', flexShrink: 0, width: compact ? '32px' : '40px' }}
      >
        <option value="-">-</option>
        {activeUnits.map(u => <option key={u} value={u}>{u}</option>)}
      </select>
    </div>
  )
}

/** Inline icon + DimInput */
function IconDimRow({ icon, title, value, units, onChange }: {
  icon: React.ReactNode; title: string; value: string; units?: string[]
  onChange: (v: string, isFinal?: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
      <span title={title} style={{ color: base.dim, flexShrink: 0, display: 'flex', alignItems: 'center' }}>{icon}</span>
      <DimInput value={value} units={units} onChange={onChange} />
    </div>
  )
}

/** Color swatch + hex input */
function ColorInput({ value, onChange, onLiveChange }: {
  value: string; onChange: (v: string) => void; onLiveChange?: (v: string) => void
}) {
  const display = value === 'transparent' ? '' : value
  const swatch = value === 'transparent' || value === 'none' ? '#000000' : (value.startsWith('#') ? value : '#000000')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
      <input type="color" value={swatch}
        onInput={(e) => onLiveChange?.((e.target as HTMLInputElement).value)}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '24px', height: '24px', border: `1px solid ${base.border}`, background: base.bg, borderRadius: '3px', cursor: 'pointer', padding: '1px', flexShrink: 0 }}
      />
      <input type="text" value={display} placeholder="transparent"
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBase, borderRadius: '3px', padding: '4px 6px', flex: 1, minWidth: 0 }}
      />
    </div>
  )
}

/** Icon button group (like Figma toggle bar) */
function IconBtnGroup({ options, value, onChange }: {
  options: { id: string; icon?: React.ReactNode; label?: string; title: string }[]
  value: string; onChange: (id: string) => void
}) {
  return (
    <div style={{ display: 'flex', background: base.bg, border: `1px solid ${base.border}`, borderRadius: '4px', overflow: 'hidden' }}>
      {options.map(opt => (
        <button key={opt.id} onClick={() => onChange(opt.id)} title={opt.title}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: value === opt.id ? base.accent : 'transparent',
            color: value === opt.id ? '#fff' : base.muted,
            border: 'none', padding: '5px 0', cursor: 'pointer',
            fontSize: '10px', fontWeight: value === opt.id ? 600 : 400, fontFamily: 'inherit',
            transition: 'background 0.1s, color 0.1s',
          }}
        >
          {opt.icon || opt.label}
        </button>
      ))}
    </div>
  )
}

/** Cross-shaped TRBL editor (margin/padding) */
function CrossEditor({ centerLabel, values, onSideChange }: {
  centerLabel: string
  values: { top: string; right: string; bottom: string; left: string }
  onSideChange: (side: string, val: string, isFinal?: boolean) => void
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 24px 1fr',
      gridTemplateRows: 'auto auto auto',
      gap: '2px',
      alignItems: 'center',
      padding: '6px 4px',
      border: `1px solid ${base.border}`,
      borderRadius: '6px',
      background: 'rgba(255,255,255,0.015)',
    }}>
      {/* Top */}
      <div style={{ gridColumn: '1 / -1', justifySelf: 'center', width: '55%' }}>
        <DimInput compact value={values.top} onChange={(v, f) => onSideChange('top', v, f)} placeholder="0" />
      </div>
      {/* Left */}
      <div style={{ justifySelf: 'stretch' }}>
        <DimInput compact value={values.left} onChange={(v, f) => onSideChange('left', v, f)} placeholder="0" />
      </div>
      {/* Center label */}
      <div style={{ textAlign: 'center', color: '#52525b', fontSize: '8px', fontWeight: 700, letterSpacing: '0.06em', userSelect: 'none', textTransform: 'uppercase' }}>
        {centerLabel}
      </div>
      {/* Right */}
      <div style={{ justifySelf: 'stretch' }}>
        <DimInput compact value={values.right} onChange={(v, f) => onSideChange('right', v, f)} placeholder="0" />
      </div>
      {/* Bottom */}
      <div style={{ gridColumn: '1 / -1', justifySelf: 'center', width: '55%' }}>
        <DimInput compact value={values.bottom} onChange={(v, f) => onSideChange('bottom', v, f)} placeholder="0" />
      </div>
    </div>
  )
}

/** 2x2 corner editor (border-radius) */
function CornerEditor({ values, onChange }: {
  values: { tl: string; tr: string; bl: string; br: string }
  onChange: (corner: string, v: string, isFinal?: boolean) => void
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 20px 1fr', gridTemplateRows: 'auto 16px auto',
      gap: '2px', alignItems: 'center',
      padding: '4px', border: `1px solid ${base.border}`, borderRadius: '6px', background: 'rgba(255,255,255,0.015)',
    }}>
      <DimInput compact value={values.tl} units={['px', '%', 'em', 'rem']} onChange={(v, f) => onChange('tl', v, f)} />
      <div/>
      <DimInput compact value={values.tr} units={['px', '%', 'em', 'rem']} onChange={(v, f) => onChange('tr', v, f)} />
      <div/><div style={{ textAlign: 'center' }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#3f3f46" strokeWidth="1.2">
          <rect x="1" y="1" width="10" height="10" rx="3" />
        </svg>
      </div><div/>
      <DimInput compact value={values.bl} units={['px', '%', 'em', 'rem']} onChange={(v, f) => onChange('bl', v, f)} />
      <div/>
      <DimInput compact value={values.br} units={['px', '%', 'em', 'rem']} onChange={(v, f) => onChange('br', v, f)} />
    </div>
  )
}

/** Opacity slider + scrub input */
function OpacityRow({ value, onPreview, onCommit }: {
  value: string; onPreview: (v: string) => void; onCommit: (v: string) => void
}) {
  const scrub = useScrub({
    getValue: () => parseFloat(value) || 1, step: 0.01, precision: 2, min: 0, max: 1,
    onScrub: (n, f) => { if (f) onCommit(String(n)); else onPreview(String(n)) },
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, color: base.dim }}>
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M7 2a5 5 0 010 10" fill="currentColor" opacity=".4"/>
      </svg>
      <input type="range" min="0" max="1" step="0.01" value={value}
        onInput={(e) => onPreview((e.target as HTMLInputElement).value)}
        onChange={(e) => onCommit(e.target.value)}
        style={{ flex: 1, accentColor: base.accent, cursor: 'pointer', height: '14px' }}
      />
      <input ref={scrub.ref} type="text" value={value}
        onChange={(e) => onCommit(e.target.value)} onMouseDown={scrub.onMouseDown}
        style={{ ...inputBase, borderRadius: '3px', padding: '3px 4px', width: '38px', textAlign: 'center', flex: 'none' }}
      />
    </div>
  )
}

// ─── State ─────────────────────────────────────────────────

interface StyleState {
  fontFamily: string; fontSize: string; fontWeight: string
  letterSpacing: string; lineHeight: string; color: string
  textAlign: string; textDecoration: string; textTransform: string
  textIndent: string; wordSpacing: string
  marginTop: string; marginRight: string; marginBottom: string; marginLeft: string
  paddingTop: string; paddingRight: string; paddingBottom: string; paddingLeft: string
  gap: string
  width: string; minWidth: string; maxWidth: string
  height: string; minHeight: string; maxHeight: string
  backgroundColor: string
  borderWidth: string; borderStyle: string; borderColor: string
  borderTopLeftRadius: string; borderTopRightRadius: string
  borderBottomLeftRadius: string; borderBottomRightRadius: string
  boxShadow: string; opacity: string
}

const DEFAULT: StyleState = {
  fontFamily: '', fontSize: '16px', fontWeight: '400',
  letterSpacing: 'normal', lineHeight: 'normal', color: '#000000',
  textAlign: 'left', textDecoration: 'none', textTransform: 'none',
  textIndent: '0px', wordSpacing: 'normal',
  marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
  gap: '0px', width: 'auto', minWidth: 'auto', maxWidth: 'auto',
  height: 'auto', minHeight: 'auto', maxHeight: 'auto',
  backgroundColor: 'transparent', borderWidth: '0px', borderStyle: 'none', borderColor: '#000000',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
  borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px',
  boxShadow: 'none', opacity: '1',
}

// ─── Main Component ────────────────────────────────────────

export default function NativeStylePanel({ selectedElement, onStyleChange, styleRevision }: Props) {
  const [styles, setStyles] = useState<StyleState>(DEFAULT)
  const [sectors, setSectors] = useState({ typography: true, spacing: true, size: true, appearance: false })

  useEffect(() => {
    if (!selectedElement) return
    const win = selectedElement.ownerDocument.defaultView
    if (!win) return
    const cs = win.getComputedStyle(selectedElement)
    const inl = selectedElement.style
    const sizeVal = (k: string, computedFallback: string) => {
      const v = inl.getPropertyValue(k)
      if (v && v !== '') return v
      return computedFallback && computedFallback !== '' && computedFallback !== '0px' ? computedFallback : 'auto'
    }

    setStyles({
      fontFamily: cs.fontFamily || '', fontSize: cs.fontSize || '16px',
      fontWeight: cs.fontWeight || '400', letterSpacing: cs.letterSpacing || 'normal',
      lineHeight: cs.lineHeight || 'normal', color: rgbToHex(cs.color),
      textAlign: cs.textAlign || 'left',
      textDecoration: (cs as any).textDecorationLine || cs.textDecoration?.split(' ')[0] || 'none',
      textTransform: cs.textTransform || 'none',
      textIndent: cs.textIndent || '0px', wordSpacing: cs.wordSpacing || 'normal',
      marginTop: cs.marginTop || '0px', marginRight: cs.marginRight || '0px',
      marginBottom: cs.marginBottom || '0px', marginLeft: cs.marginLeft || '0px',
      paddingTop: cs.paddingTop || '0px', paddingRight: cs.paddingRight || '0px',
      paddingBottom: cs.paddingBottom || '0px', paddingLeft: cs.paddingLeft || '0px',
      gap: cs.gap || '0px',
      width: sizeVal('width', cs.width), minWidth: sizeVal('min-width', cs.minWidth), maxWidth: sizeVal('max-width', cs.maxWidth),
      height: sizeVal('height', cs.height), minHeight: sizeVal('min-height', cs.minHeight), maxHeight: sizeVal('max-height', cs.maxHeight),
      backgroundColor: rgbToHex(cs.backgroundColor),
      borderWidth: cs.borderTopWidth || '0px', borderStyle: cs.borderTopStyle || 'none',
      borderColor: rgbToHex(cs.borderTopColor),
      borderTopLeftRadius: cs.borderTopLeftRadius || '0px', borderTopRightRadius: cs.borderTopRightRadius || '0px',
      borderBottomLeftRadius: cs.borderBottomLeftRadius || '0px', borderBottomRightRadius: cs.borderBottomRightRadius || '0px',
      boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow || 'none',
      opacity: cs.opacity || '1',
    })
  }, [selectedElement, styleRevision])

  const apply = useCallback((p: string, v: string) => onStyleChange(p, v, true), [onStyleChange])
  const preview = useCallback((p: string, v: string) => onStyleChange(p, v, false), [onStyleChange])
  const set = useCallback((k: keyof StyleState, p: string, v: string) => { setStyles(s => ({ ...s, [k]: v })); apply(p, v) }, [apply])
  const setPreview = useCallback((k: keyof StyleState, p: string, v: string) => { setStyles(s => ({ ...s, [k]: v })); preview(p, v) }, [preview])
  const handle = useCallback((k: keyof StyleState, p: string) => (v: string, f = true) => {
    setStyles(s => ({ ...s, [k]: v })); if (f) apply(p, v); else preview(p, v)
  }, [apply, preview])

  const toggle = (k: keyof typeof sectors) => setSectors(s => ({ ...s, [k]: !s[k] }))

  if (!selectedElement) {
    return <div style={{ padding: '20px 16px', color: base.dim, fontSize: '11px', textAlign: 'center' }}>Select an element to inspect</div>
  }

  const divider: React.CSSProperties = { borderBottom: '1px solid #27272a', paddingBottom: '10px' }
  const row2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '11px', color: base.text }}>

      {/* ═══ TYPOGRAPHY ═══ */}
      <div style={divider}>
        <SectorHeader title="Typography" open={sectors.typography} onToggle={() => toggle('typography')} />
        {sectors.typography && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>

            {/* Font family */}
            {(() => {
              const cleanFont = (styles.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '')
              const matchedOpt = COMMON_FONTS.find(f => f.toLowerCase().startsWith(cleanFont.toLowerCase()) || f.toLowerCase().includes(cleanFont.toLowerCase())) || (cleanFont ? cleanFont : '')
              return (
                <select value={matchedOpt} onChange={(e) => set('fontFamily', 'font-family', e.target.value)}
                  style={{ ...inputBase, borderRadius: '3px', padding: '5px 6px', cursor: 'pointer', width: '100%' }}>
                  <option value="">Inherit</option>
                  {cleanFont && !COMMON_FONTS.some(f => f.toLowerCase().includes(cleanFont.toLowerCase())) && (
                    <option value={cleanFont}>{cleanFont}</option>
                  )}
                  {COMMON_FONTS.map(f => <option key={f} value={f}>{f.split(',')[0].replace(/^["']|["']$/g, '')}</option>)}
                </select>
              )
            })()}

            {/* Size + Weight */}
            <div style={row2}>
              <DimInput value={styles.fontSize} units={['px', 'em', 'rem', '%', 'vw']} onChange={handle('fontSize', 'font-size')} placeholder="Size" />
              <select value={styles.fontWeight} onChange={(e) => set('fontWeight', 'font-weight', e.target.value)}
                style={{ ...inputBase, borderRadius: '3px', padding: '4px 4px', cursor: 'pointer', width: '100%' }}>
                {FONT_WEIGHTS.map(fw => <option key={fw.value} value={fw.value}>{fw.label}</option>)}
              </select>
            </div>

            {/* Letter spacing + Line height (icon-prefixed) */}
            <div style={row2}>
              <IconDimRow icon={<IcoLetterSpacing/>} title="Letter spacing" value={styles.letterSpacing} units={['px','em','rem']} onChange={handle('letterSpacing', 'letter-spacing')} />
              <IconDimRow icon={<IcoLineHeight/>} title="Line height" value={styles.lineHeight} units={['px','em','rem','%']} onChange={handle('lineHeight', 'line-height')} />
            </div>

            {/* Color */}
            <ColorInput value={styles.color} onChange={(v) => set('color', 'color', v)} onLiveChange={(v) => setPreview('color', 'color', v)} />

            {/* Align */}
            <IconBtnGroup value={styles.textAlign} onChange={(v) => set('textAlign', 'text-align', v)} options={[
              { id: 'left', icon: <IcoAlignLeft/>, title: 'Align left' },
              { id: 'center', icon: <IcoAlignCenter/>, title: 'Align center' },
              { id: 'right', icon: <IcoAlignRight/>, title: 'Align right' },
              { id: 'justify', icon: <IcoAlignJustify/>, title: 'Justify' },
            ]} />

            {/* Decoration + Transform side by side */}
            <div style={row2}>
              <IconBtnGroup value={styles.textDecoration} onChange={(v) => set('textDecoration', 'text-decoration', v)} options={[
                { id: 'none', label: '—', title: 'None' },
                { id: 'underline', icon: <IcoUnderline/>, title: 'Underline' },
                { id: 'line-through', icon: <IcoStrikethrough/>, title: 'Strikethrough' },
              ]} />
              <IconBtnGroup value={styles.textTransform} onChange={(v) => set('textTransform', 'text-transform', v)} options={[
                { id: 'none', label: '—', title: 'None' },
                { id: 'uppercase', label: 'AA', title: 'Uppercase' },
                { id: 'lowercase', label: 'aa', title: 'Lowercase' },
                { id: 'capitalize', label: 'Aa', title: 'Capitalize' },
              ]} />
            </div>

            {/* Indent + Word spacing (icon-prefixed) */}
            <div style={row2}>
              <IconDimRow icon={<IcoTextIndent/>} title="Text indent" value={styles.textIndent} units={['px','em','rem','%']} onChange={handle('textIndent', 'text-indent')} />
              <IconDimRow icon={<IcoWordSpacing/>} title="Word spacing" value={styles.wordSpacing} units={['px','em','rem']} onChange={handle('wordSpacing', 'word-spacing')} />
            </div>
          </div>
        )}
      </div>

      {/* ═══ SPACING ═══ */}
      <div style={divider}>
        <SectorHeader title="Spacing" open={sectors.spacing} onToggle={() => toggle('spacing')} />
        {sectors.spacing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            <CrossEditor centerLabel="Margin" values={{ top: styles.marginTop, right: styles.marginRight, bottom: styles.marginBottom, left: styles.marginLeft }}
              onSideChange={(side, v, f) => handle(`margin${side[0].toUpperCase()+side.slice(1)}` as keyof StyleState, `margin-${side}`)(v, f)} />
            <CrossEditor centerLabel="Padding" values={{ top: styles.paddingTop, right: styles.paddingRight, bottom: styles.paddingBottom, left: styles.paddingLeft }}
              onSideChange={(side, v, f) => handle(`padding${side[0].toUpperCase()+side.slice(1)}` as keyof StyleState, `padding-${side}`)(v, f)} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: base.dim, fontSize: '10px', fontWeight: 600, flexShrink: 0, width: '26px' }}>Gap</span>
              <DimInput value={styles.gap} units={['px','em','rem','%']} onChange={handle('gap','gap')} />
            </div>
          </div>
        )}
      </div>

      {/* ═══ SIZE ═══ */}
      <div style={divider}>
        <SectorHeader title="Size" open={sectors.size} onToggle={() => toggle('size')} />
        {sectors.size && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '8px' }}>
            {([
              [['W', 'width', 'width'], ['H', 'height', 'height']],
              [['↓W', 'minWidth', 'min-width'], ['↓H', 'minHeight', 'min-height']],
              [['↑W', 'maxWidth', 'max-width'], ['↑H', 'maxHeight', 'max-height']],
            ] as [string, keyof StyleState, string][][]).map((row, i) => (
              <div key={i} style={row2}>
                {row.map(([label, key, prop]) => (
                  <div key={prop} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ color: base.dim, fontSize: '10px', fontWeight: 600, flexShrink: 0, width: '20px', textAlign: 'right' }}>{label}</span>
                    <DimInput value={styles[key]} onChange={handle(key, prop)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══ APPEARANCE ═══ */}
      <div>
        <SectorHeader title="Appearance" open={sectors.appearance} onToggle={() => toggle('appearance')} />
        {sectors.appearance && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>

            {/* Background */}
            <ColorInput value={styles.backgroundColor} onChange={(v) => set('backgroundColor', 'background-color', v)} onLiveChange={(v) => setPreview('backgroundColor', 'background-color', v)} />

            {/* Border: width + style + color in one row */}
            <div>
              <div style={{ color: base.dim, fontSize: '10px', fontWeight: 600, marginBottom: '4px' }}>Border</div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <div style={{ width: '60px', flexShrink: 0 }}>
                  <DimInput compact value={styles.borderWidth} units={['px','em','rem']} onChange={handle('borderWidth', 'border-width')} />
                </div>
                <select value={styles.borderStyle} onChange={(e) => set('borderStyle', 'border-style', e.target.value)}
                  style={{ ...inputBase, borderRadius: '3px', padding: '3px 4px', cursor: 'pointer', width: '64px', flexShrink: 0 }}>
                  {BORDER_STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ColorInput value={styles.borderColor} onChange={(v) => set('borderColor', 'border-color', v)} onLiveChange={(v) => setPreview('borderColor', 'border-color', v)} />
                </div>
              </div>
            </div>

            {/* Border radius — corner grid */}
            <div>
              <div style={{ color: base.dim, fontSize: '10px', fontWeight: 600, marginBottom: '4px' }}>Radius</div>
              <CornerEditor
                values={{ tl: styles.borderTopLeftRadius, tr: styles.borderTopRightRadius, bl: styles.borderBottomLeftRadius, br: styles.borderBottomRightRadius }}
                onChange={(c, v, f) => {
                  const map: Record<string, [keyof StyleState, string]> = {
                    tl: ['borderTopLeftRadius', 'border-top-left-radius'],
                    tr: ['borderTopRightRadius', 'border-top-right-radius'],
                    bl: ['borderBottomLeftRadius', 'border-bottom-left-radius'],
                    br: ['borderBottomRightRadius', 'border-bottom-right-radius'],
                  }
                  const [k, p] = map[c]
                  handle(k, p)(v, f)
                }}
              />
            </div>

            {/* Box shadow */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span style={{ color: base.dim, fontSize: '10px', fontWeight: 600 }}>Shadow</span>
                <button onClick={() => { if (styles.boxShadow === 'none' || !styles.boxShadow) set('boxShadow', 'box-shadow', '0 2px 4px rgba(0,0,0,0.2)') }}
                  style={{ background: 'none', border: `1px solid ${base.border}`, borderRadius: '3px', color: base.muted, cursor: 'pointer', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', padding: 0, lineHeight: 1 }} title="Add shadow">+</button>
              </div>
              <input type="text" value={styles.boxShadow === 'none' ? '' : styles.boxShadow} placeholder="none"
                onChange={(e) => set('boxShadow', 'box-shadow', e.target.value || 'none')}
                style={{ ...inputBase, borderRadius: '3px', padding: '4px 6px', width: '100%' }} />
            </div>

            {/* Opacity */}
            <OpacityRow value={styles.opacity} onPreview={(v) => setPreview('opacity', 'opacity', v)} onCommit={(v) => set('opacity', 'opacity', v)} />
          </div>
        )}
      </div>
    </div>
  )
}
