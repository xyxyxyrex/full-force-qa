import { useState, useEffect, useCallback, useRef } from 'react'
import SmoothColorPicker from './SmoothColorPicker'
import { layoutModeFromDisplay, normalizeBoxModelValue } from '../utils/viewportLayoutPatches'

/* ═══════════════════════════════════════════════════════════
   NativeStylePanel — Figma-style compact style inspector
   ═══════════════════════════════════════════════════════════ */

interface Props {
  selectedElement: HTMLElement | null
  onStyleChange: (property: string, value: string, isFinalCommit?: boolean) => void
  onLayoutStylesChange?: (values: Record<string, string>, isFinalCommit?: boolean) => void
  isContainer?: boolean
  parentDisplay?: string
  activeViewportLabel?: string
  layoutOverlayEnabled?: boolean
  onLayoutOverlayChange?: (enabled: boolean) => void
  styleRevision?: number
  computedStyles?: Record<string, string> | null
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

const LayoutModeIcon = ({ mode }: { mode: 'block' | 'flex' | 'grid' }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    {mode === 'block' && <><rect x="2" y="2" width="12" height="4" rx="1"/><rect x="2" y="8" width="12" height="6" rx="1"/></>}
    {mode === 'flex' && <><rect x="1.5" y="3" width="3.5" height="10" rx="1"/><rect x="6.25" y="3" width="3.5" height="10" rx="1"/><rect x="11" y="3" width="3.5" height="10" rx="1"/></>}
    {mode === 'grid' && <><rect x="2" y="2" width="5" height="5" rx=".6"/><rect x="9" y="2" width="5" height="5" rx=".6"/><rect x="2" y="9" width="5" height="5" rx=".6"/><rect x="9" y="9" width="5" height="5" rx=".6"/></>}
  </svg>
)

const DirectionIcon = ({ direction }: { direction: string }) => {
  const vertical = direction.includes('column')
  const reverse = direction.includes('reverse')
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    {vertical ? <><rect x="3" y="2" width="10" height="3" rx=".8"/><rect x="3" y="7" width="10" height="3" rx=".8"/><path d={reverse ? 'M8 14V11m0 0-2 2m2-2 2 2' : 'M8 11v3m0 0-2-2m2 2 2-2'}/></> : <><rect x="2" y="3" width="3" height="10" rx=".8"/><rect x="7" y="3" width="3" height="10" rx=".8"/><path d={reverse ? 'M14 8h-3m0 0 2-2m-2 2 2 2' : 'M11 8h3m0 0-2-2m2 2-2 2'}/></>}
  </svg>
}

const DistributionIcon = ({ value, vertical = false }: { value: string; vertical?: boolean }) => {
  const points: Record<string, number[]> = {
    'flex-start': [3, 6], center: [6, 9], 'flex-end': [10, 13],
    'space-between': [2, 14], 'space-around': [4, 12], 'space-evenly': [5, 11],
    start: [3, 6], end: [10, 13], stretch: [3, 13], auto: [6, 10],
  }
  const [a, b] = points[value] || points.center
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    {vertical ? <><path d="M2 1v14" opacity=".35"/><rect x="4" y={a - 1} width="9" height="2" rx=".5"/><rect x="4" y={b - 1} width="9" height="2" rx=".5"/></> : <><path d="M1 2h14" opacity=".35"/><rect x={a - 1} y="4" width="2" height="9" rx=".5"/><rect x={b - 1} y="4" width="2" height="9" rx=".5"/></>}
  </svg>
}

const OverlayIcon = () => <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12" opacity=".7"/></svg>

// ─── Shared Styles ─────────────────────────────────────────

const base = {
  bg: 'var(--bg-input)',
  border: 'var(--border-color)',
  text: 'var(--text-primary)',
  muted: 'var(--text-secondary)',
  dim: 'var(--text-muted)',
  accent: 'var(--accent-color)',
  accentForeground: 'var(--accent-foreground, #ffffff)',
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
      <span style={{ fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px', color: base.muted }}>{title}</span>
    </div>
  )
}

type BoxEdges = { top: string; right: string; bottom: string; left: string }

function compactMetric(value: string) {
  const trimmed = String(value || '0').trim()
  if (!trimmed.endsWith('px')) return trimmed || '0'
  const numeric = Number.parseFloat(trimmed)
  if (!Number.isFinite(numeric)) return trimmed
  return Number.isInteger(numeric) ? String(numeric) : String(Math.round(numeric * 100) / 100)
}

function EditableBoxMetric({ value, label, style, onPreview, onCommit }: {
  value: string
  label: string
  style?: React.CSSProperties
  onPreview: (value: string) => void
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(() => compactMetric(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!editing) setDraft(compactMetric(value)) }, [editing, value])
  const normalized = (next: string) => normalizeBoxModelValue(next, value)
  const commit = (next: string) => {
    const result = normalized(next)
    setDraft(compactMetric(result))
    setEditing(false)
    onCommit(result)
  }

  return <input
    value={draft}
    aria-label={label}
    title={`${label}: ${value}`}
    spellCheck={false}
    onFocus={(event) => { setEditing(true); event.currentTarget.select() }}
    onChange={(event) => {
      const next = event.currentTarget.value
      setDraft(next)
      if (next.trim()) onPreview(normalized(next))
    }}
    onBlur={(event) => commit(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (event.key === 'Enter') event.currentTarget.blur()
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const current = Number.parseFloat(draft)
        if (!Number.isFinite(current)) return
        event.preventDefault()
        const next = String(current + (event.key === 'ArrowUp' ? 1 : -1))
        setDraft(next)
        onPreview(normalized(next))
      }
    }}
    style={{
      zIndex: 2, width: 34, height: 14, padding: '0 2px', boxSizing: 'border-box',
      border: editing ? `1px solid ${base.accent}` : '1px solid transparent', borderRadius: 2,
      outline: 'none', background: editing ? base.bg : 'color-mix(in srgb, var(--bg-app) 88%, transparent)',
      color: base.text, textAlign: 'center', font: '8px/12px ui-monospace, monospace', cursor: 'text',
      ...style,
    }}
  />
}

function BoxModelLayer({ name, values, properties, background, border, onChange, children }: {
  name: string
  values: BoxEdges
  properties: Record<keyof BoxEdges, string>
  background: string
  border?: string
  onChange: (property: string, value: string, isFinal: boolean) => void
  children: React.ReactNode
}) {
  const metric = (side: keyof BoxEdges, style: React.CSSProperties) => <EditableBoxMetric
    value={values[side]}
    label={`${name} ${side}`}
    style={{ position: 'absolute', ...style }}
    onPreview={(value) => onChange(properties[side], value, false)}
    onCommit={(value) => onChange(properties[side], value, true)}
  />
  return <div style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', padding: '17px 24px', background, border }}>
    <span style={{ position: 'absolute', left: 5, top: 3, color: base.text, fontSize: '8px', lineHeight: 1, fontFamily: 'ui-monospace, monospace' }}>{name}</span>
    {metric('top', { top: 1, left: '50%', transform: 'translateX(-50%)' })}
    {metric('right', { right: 1, top: '50%', transform: 'translateY(-50%)' })}
    {metric('bottom', { bottom: 1, left: '50%', transform: 'translateX(-50%)' })}
    {metric('left', { left: 1, top: '50%', transform: 'translateY(-50%)' })}
    {children}
  </div>
}

function BoxModelDiagram({ styles, computedStyles, onChange }: { styles: StyleState; computedStyles?: Record<string, string> | null; onChange: (property: string, value: string, isFinal: boolean) => void }) {
  const computed = (property: string, fallback: string) => computedStyles?.[property] || fallback
  const margin = {
    top: computed('margin-top', styles.marginTop), right: computed('margin-right', styles.marginRight),
    bottom: computed('margin-bottom', styles.marginBottom), left: computed('margin-left', styles.marginLeft),
  }
  const border = {
    top: computed('border-top-width', styles.borderWidth), right: computed('border-right-width', styles.borderWidth),
    bottom: computed('border-bottom-width', styles.borderWidth), left: computed('border-left-width', styles.borderWidth),
  }
  const padding = {
    top: computed('padding-top', styles.paddingTop), right: computed('padding-right', styles.paddingRight),
    bottom: computed('padding-bottom', styles.paddingBottom), left: computed('padding-left', styles.paddingLeft),
  }
  const width = computed('width', styles.width)
  const height = computed('height', styles.height)
  const description = `Margin ${Object.values(margin).join(' ')}, border ${Object.values(border).join(' ')}, padding ${Object.values(padding).join(' ')}, content ${width} by ${height}`

  return <div role="group" aria-label={`Editable box model. ${description}`} style={{ height: 154, padding: 5, overflow: 'hidden', border: `1px solid ${base.border}`, borderRadius: 6, background: 'var(--bg-app)', boxSizing: 'border-box' }}>
    <BoxModelLayer name="margin" values={margin} properties={{ top: 'margin-top', right: 'margin-right', bottom: 'margin-bottom', left: 'margin-left' }} onChange={onChange} background="color-mix(in srgb, #d6c94f 42%, var(--bg-input))" border="1px dashed color-mix(in srgb, #f4e84a 75%, var(--border-color))">
      <BoxModelLayer name="border" values={border} properties={{ top: 'border-top-width', right: 'border-right-width', bottom: 'border-bottom-width', left: 'border-left-width' }} onChange={onChange} background="color-mix(in srgb, #9b743d 48%, var(--bg-input))">
        <BoxModelLayer name="padding" values={padding} properties={{ top: 'padding-top', right: 'padding-right', bottom: 'padding-bottom', left: 'padding-left' }} onChange={onChange} background="color-mix(in srgb, #9b6cf4 55%, var(--bg-input))">
          <div style={{ width: '100%', height: '100%', minHeight: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, border: '1px dashed color-mix(in srgb, #22d3ee 80%, var(--border-color))', background: 'color-mix(in srgb, #06b6d4 68%, var(--bg-input))', color: base.text, boxSizing: 'border-box', whiteSpace: 'nowrap' }}>
            <EditableBoxMetric value={width} label="Content width" onPreview={(value) => onChange('width', value, false)} onCommit={(value) => onChange('width', value, true)} />
            <span aria-hidden="true" style={{ font: '8px/1 ui-monospace, monospace' }}>×</span>
            <EditableBoxMetric value={height} label="Content height" onPreview={(value) => onChange('height', value, false)} onCommit={(value) => onChange('height', value, true)} />
          </div>
        </BoxModelLayer>
      </BoxModelLayer>
    </BoxModelLayer>
  </div>
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
  const swatch = value === 'transparent' || value === 'none' ? '#000000' : value
  return <SmoothColorPicker value={swatch} onPreview={onLiveChange} onCommit={onChange} />
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
            color: value === opt.id ? base.accentForeground : base.muted,
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
  display: string; flexDirection: string; flexWrap: string
  justifyContent: string; alignItems: string; alignContent: string; justifyItems: string
  rowGap: string; columnGap: string; gridTemplateColumns: string; gridTemplateRows: string; gridAutoFlow: string
  order: string; flexGrow: string; flexShrink: string; flexBasis: string
  alignSelf: string; justifySelf: string; gridColumn: string; gridRow: string
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
  display: 'block', flexDirection: 'row', flexWrap: 'nowrap',
  justifyContent: 'normal', alignItems: 'normal', alignContent: 'normal', justifyItems: 'normal',
  rowGap: '0px', columnGap: '0px', gridTemplateColumns: 'none', gridTemplateRows: 'none', gridAutoFlow: 'row',
  order: '0', flexGrow: '0', flexShrink: '1', flexBasis: 'auto', alignSelf: 'auto', justifySelf: 'auto', gridColumn: 'auto', gridRow: 'auto',
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

export default function NativeStylePanel({ selectedElement, onStyleChange, onLayoutStylesChange, isContainer = false, parentDisplay = '', activeViewportLabel = 'Active viewport', layoutOverlayEnabled = false, onLayoutOverlayChange, styleRevision, computedStyles }: Props) {
  const [styles, setStyles] = useState<StyleState>(DEFAULT)
  const [sectors, setSectors] = useState({ layout: true, typography: true, spacing: true, size: true, appearance: false })

  useEffect(() => {
    if (computedStyles) {
      const value = (property: string, fallback: string) => computedStyles[property] || fallback
      setStyles({
        display: value('display', 'block'), flexDirection: value('flex-direction', 'row'), flexWrap: value('flex-wrap', 'nowrap'),
        justifyContent: value('justify-content', 'normal'), alignItems: value('align-items', 'normal'), alignContent: value('align-content', 'normal'), justifyItems: value('justify-items', 'normal'),
        rowGap: value('row-gap', value('gap', '0px')), columnGap: value('column-gap', value('gap', '0px')),
        gridTemplateColumns: value('grid-template-columns', 'none'), gridTemplateRows: value('grid-template-rows', 'none'), gridAutoFlow: value('grid-auto-flow', 'row'),
        order: value('order', '0'), flexGrow: value('flex-grow', '0'), flexShrink: value('flex-shrink', '1'), flexBasis: value('flex-basis', 'auto'),
        alignSelf: value('align-self', 'auto'), justifySelf: value('justify-self', 'auto'), gridColumn: value('grid-column', 'auto'), gridRow: value('grid-row', 'auto'),
        fontFamily: value('font-family', ''), fontSize: value('font-size', '16px'),
        fontWeight: value('font-weight', '400'), letterSpacing: value('letter-spacing', 'normal'),
        lineHeight: value('line-height', 'normal'), color: rgbToHex(value('color', '#000000')),
        textAlign: value('text-align', 'left'), textDecoration: value('text-decoration-line', value('text-decoration', 'none')),
        textTransform: value('text-transform', 'none'), textIndent: value('text-indent', '0px'), wordSpacing: value('word-spacing', 'normal'),
        marginTop: value('margin-top', '0px'), marginRight: value('margin-right', '0px'), marginBottom: value('margin-bottom', '0px'), marginLeft: value('margin-left', '0px'),
        paddingTop: value('padding-top', '0px'), paddingRight: value('padding-right', '0px'), paddingBottom: value('padding-bottom', '0px'), paddingLeft: value('padding-left', '0px'),
        gap: value('gap', '0px'), width: value('width', 'auto'), minWidth: value('min-width', 'auto'), maxWidth: value('max-width', 'none'),
        height: value('height', 'auto'), minHeight: value('min-height', 'auto'), maxHeight: value('max-height', 'none'),
        backgroundColor: rgbToHex(value('background-color', 'transparent')), borderWidth: value('border-top-width', value('border-width', '0px')),
        borderStyle: value('border-top-style', value('border-style', 'none')), borderColor: rgbToHex(value('border-top-color', value('border-color', '#000000'))),
        borderTopLeftRadius: value('border-top-left-radius', '0px'), borderTopRightRadius: value('border-top-right-radius', '0px'),
        borderBottomLeftRadius: value('border-bottom-left-radius', '0px'), borderBottomRightRadius: value('border-bottom-right-radius', '0px'),
        boxShadow: value('box-shadow', 'none'), opacity: value('opacity', '1')
      })
      return
    }
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
      display: cs.display || 'block', flexDirection: cs.flexDirection || 'row', flexWrap: cs.flexWrap || 'nowrap',
      justifyContent: cs.justifyContent || 'normal', alignItems: cs.alignItems || 'normal', alignContent: cs.alignContent || 'normal', justifyItems: cs.justifyItems || 'normal',
      rowGap: cs.rowGap || cs.gap || '0px', columnGap: cs.columnGap || cs.gap || '0px',
      gridTemplateColumns: cs.gridTemplateColumns || 'none', gridTemplateRows: cs.gridTemplateRows || 'none', gridAutoFlow: cs.gridAutoFlow || 'row',
      order: cs.order || '0', flexGrow: cs.flexGrow || '0', flexShrink: cs.flexShrink || '1', flexBasis: cs.flexBasis || 'auto',
      alignSelf: cs.alignSelf || 'auto', justifySelf: cs.justifySelf || 'auto', gridColumn: cs.gridColumn || 'auto', gridRow: cs.gridRow || 'auto',
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
  }, [computedStyles, selectedElement, styleRevision])

  const apply = useCallback((p: string, v: string) => onStyleChange(p, v, true), [onStyleChange])
  const preview = useCallback((p: string, v: string) => onStyleChange(p, v, false), [onStyleChange])
  const set = useCallback((k: keyof StyleState, p: string, v: string) => { setStyles(s => ({ ...s, [k]: v })); apply(p, v) }, [apply])
  const setPreview = useCallback((k: keyof StyleState, p: string, v: string) => { setStyles(s => ({ ...s, [k]: v })); preview(p, v) }, [preview])
  const handle = useCallback((k: keyof StyleState, p: string) => (v: string, f = true) => {
    setStyles(s => ({ ...s, [k]: v })); if (f) apply(p, v); else preview(p, v)
  }, [apply, preview])
  const applyLayout = useCallback((values: Record<string, string>, isFinal = true) => {
    const stateKeys: Record<string, keyof StyleState> = {
      display: 'display', 'flex-direction': 'flexDirection', 'flex-wrap': 'flexWrap',
      'justify-content': 'justifyContent', 'align-items': 'alignItems', 'align-content': 'alignContent', 'justify-items': 'justifyItems',
      'row-gap': 'rowGap', 'column-gap': 'columnGap', 'grid-template-columns': 'gridTemplateColumns', 'grid-template-rows': 'gridTemplateRows', 'grid-auto-flow': 'gridAutoFlow',
      order: 'order', 'flex-grow': 'flexGrow', 'flex-shrink': 'flexShrink', 'flex-basis': 'flexBasis',
      'align-self': 'alignSelf', 'justify-self': 'justifySelf', 'grid-column': 'gridColumn', 'grid-row': 'gridRow',
      'margin-top': 'marginTop', 'margin-right': 'marginRight', 'margin-bottom': 'marginBottom', 'margin-left': 'marginLeft',
      'padding-top': 'paddingTop', 'padding-right': 'paddingRight', 'padding-bottom': 'paddingBottom', 'padding-left': 'paddingLeft',
      'border-top-width': 'borderWidth', width: 'width', height: 'height',
    }
    setStyles(current => {
      const next = { ...current }
      Object.entries(values).forEach(([property, value]) => { const key = stateKeys[property]; if (key) (next as any)[key] = value })
      return next
    })
    if (onLayoutStylesChange) onLayoutStylesChange(values, isFinal)
    else Object.entries(values).forEach(([property, value]) => onStyleChange(property, value, isFinal))
  }, [onLayoutStylesChange, onStyleChange])

  const toggle = (k: keyof typeof sectors) => setSectors(s => ({ ...s, [k]: !s[k] }))

  if (!selectedElement && !computedStyles) {
    return <div style={{ padding: '20px 16px', color: base.dim, fontSize: '11px', textAlign: 'center' }}>Select an element to inspect</div>
  }

  const divider: React.CSSProperties = { borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }
  const row2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }
  const layoutMode = layoutModeFromDisplay(styles.display)
  const parentLayoutMode = layoutModeFromDisplay(parentDisplay)
  const isLayoutChild = parentDisplay.includes('flex') || parentDisplay.includes('grid')
  const fieldLabel: React.CSSProperties = { color: base.dim, fontSize: '9px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' }
  const textField: React.CSSProperties = { ...inputBase, borderRadius: '3px', padding: '5px 6px', width: '100%' }

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '11px', color: base.text }}>

      <div style={divider}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <SectorHeader title="Layout" open={sectors.layout} onToggle={() => toggle('layout')} />
          {onLayoutOverlayChange && <button type="button" onClick={() => onLayoutOverlayChange(!layoutOverlayEnabled)} aria-pressed={layoutOverlayEnabled} aria-label="Toggle flex and grid overlay" title={`Layout overlay for ${activeViewportLabel}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '24px', padding: 0, borderRadius: '4px', border: `1px solid ${layoutOverlayEnabled ? base.accent : base.border}`, background: layoutOverlayEnabled ? base.accent : base.bg, color: layoutOverlayEnabled ? base.accentForeground : base.muted, cursor: 'pointer' }}><OverlayIcon /></button>}
        </div>
        {sectors.layout && <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginTop: '8px' }}>
          {(isContainer || layoutMode === 'flex' || layoutMode === 'grid') && <BoxModelDiagram styles={styles} computedStyles={computedStyles} onChange={(property, value, isFinal) => applyLayout({ [property]: value }, isFinal)} />}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
            <span style={fieldLabel}>Container</span>
            <span title="Layout changes apply only to this viewport" style={{ maxWidth: '62%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: base.dim, fontSize: '9px', padding: '2px 5px', border: `1px solid ${base.border}`, borderRadius: '999px' }}>{activeViewportLabel}</span>
          </div>
          <IconBtnGroup value={layoutMode} onChange={(value) => applyLayout({ display: value })} options={[
            { id: 'block', icon: <LayoutModeIcon mode="block" />, title: 'Block layout' },
            { id: 'flex', icon: <LayoutModeIcon mode="flex" />, title: 'Flex layout' },
            { id: 'grid', icon: <LayoutModeIcon mode="grid" />, title: 'Grid layout' },
          ]} />

          {layoutMode === 'flex' && <>
            <div style={row2}>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Direction</div><IconBtnGroup value={styles.flexDirection} onChange={(value) => applyLayout({ 'flex-direction': value })} options={[
                { id: 'row', icon: <DirectionIcon direction="row" />, title: 'Row' }, { id: 'row-reverse', icon: <DirectionIcon direction="row-reverse" />, title: 'Row reverse' },
                { id: 'column', icon: <DirectionIcon direction="column" />, title: 'Column' }, { id: 'column-reverse', icon: <DirectionIcon direction="column-reverse" />, title: 'Column reverse' },
              ]} /></div>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Wrap</div><select value={styles.flexWrap} onChange={(event) => applyLayout({ 'flex-wrap': event.target.value })} style={{ ...textField, cursor: 'pointer' }}><option value="nowrap">No wrap</option><option value="wrap">Wrap</option><option value="wrap-reverse">Reverse</option></select></div>
            </div>
            <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Distribute</div><IconBtnGroup value={styles.justifyContent} onChange={(value) => applyLayout({ 'justify-content': value })} options={['flex-start','center','flex-end','space-between','space-around','space-evenly'].map(value => ({ id: value, icon: <DistributionIcon value={value} />, title: `Justify ${value}` }))} /></div>
            <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Align</div><IconBtnGroup value={styles.alignItems} onChange={(value) => applyLayout({ 'align-items': value })} options={['flex-start','center','flex-end','stretch','baseline'].map(value => ({ id: value, icon: <DistributionIcon value={value} vertical />, title: `Align ${value}` }))} /></div>
            <div style={row2}>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Row gap</div><DimInput value={styles.rowGap} onChange={(value, final) => applyLayout({ 'row-gap': value }, final)} /></div>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Column gap</div><DimInput value={styles.columnGap} onChange={(value, final) => applyLayout({ 'column-gap': value }, final)} /></div>
            </div>
          </>}

          {layoutMode === 'grid' && <>
            <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Columns</div><input value={styles.gridTemplateColumns} onChange={(event) => applyLayout({ 'grid-template-columns': event.target.value })} placeholder="repeat(3, 1fr)" style={textField} /></div>
            <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Rows</div><input value={styles.gridTemplateRows} onChange={(event) => applyLayout({ 'grid-template-rows': event.target.value })} placeholder="auto 1fr auto" style={textField} /></div>
            <div style={row2}>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Auto flow</div><select value={styles.gridAutoFlow} onChange={(event) => applyLayout({ 'grid-auto-flow': event.target.value })} style={{ ...textField, cursor: 'pointer' }}><option value="row">Row</option><option value="column">Column</option><option value="row dense">Row dense</option><option value="column dense">Column dense</option></select></div>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Item align</div><select value={styles.alignItems} onChange={(event) => applyLayout({ 'align-items': event.target.value, 'justify-items': event.target.value })} style={{ ...textField, cursor: 'pointer' }}><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option></select></div>
            </div>
            <div>
              <div style={{ ...fieldLabel, marginBottom: 4 }}>Content alignment</div>
              <div role="group" aria-label="Grid content alignment" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3, padding: 5, border: `1px solid ${base.border}`, borderRadius: 5, background: base.bg }}>
                {(['start','center','end'] as const).flatMap(vertical => (['start','center','end'] as const).map(horizontal => {
                  const active = styles.alignContent.includes(vertical) && styles.justifyContent.includes(horizontal)
                  return <button key={`${vertical}-${horizontal}`} title={`${vertical} ${horizontal}`} onClick={() => applyLayout({ 'align-content': vertical, 'justify-content': horizontal })} style={{ height: 20, border: 'none', borderRadius: 3, background: active ? base.accent : 'transparent', color: active ? base.accentForeground : base.dim, cursor: 'pointer', padding: 0 }}><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx={horizontal === 'start' ? 3 : horizontal === 'center' ? 7 : 11} cy={vertical === 'start' ? 3 : vertical === 'center' ? 7 : 11} r="1.6"/></svg></button>
                }))}
              </div>
            </div>
            <div style={row2}>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Row gap</div><DimInput value={styles.rowGap} onChange={(value, final) => applyLayout({ 'row-gap': value }, final)} /></div>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Column gap</div><DimInput value={styles.columnGap} onChange={(value, final) => applyLayout({ 'column-gap': value }, final)} /></div>
            </div>
          </>}

          {isLayoutChild && <div style={{ borderTop: `1px solid ${base.border}`, paddingTop: 9, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={fieldLabel}>Child in {parentLayoutMode}</span><span style={{ color: base.dim, fontSize: 9 }}>Parent layout</span></div>
            {parentLayoutMode === 'flex' ? <>
              <div style={row2}>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Order</div><input value={styles.order} onChange={(event) => applyLayout({ order: event.target.value })} style={textField} /></div>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Basis</div><DimInput value={styles.flexBasis} onChange={(value, final) => applyLayout({ 'flex-basis': value }, final)} /></div>
              </div>
              <div style={row2}>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Grow</div><input value={styles.flexGrow} onChange={(event) => applyLayout({ 'flex-grow': event.target.value })} style={textField} /></div>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Shrink</div><input value={styles.flexShrink} onChange={(event) => applyLayout({ 'flex-shrink': event.target.value })} style={textField} /></div>
              </div>
              <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Self alignment</div><IconBtnGroup value={styles.alignSelf} onChange={(value) => applyLayout({ 'align-self': value })} options={['auto','flex-start','center','flex-end','stretch'].map(value => ({ id: value, icon: <DistributionIcon value={value} vertical />, title: `Align self ${value}` }))} /></div>
            </> : <>
              <div style={row2}>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Column</div><input value={styles.gridColumn} onChange={(event) => applyLayout({ 'grid-column': event.target.value })} placeholder="auto / span 2" style={textField} /></div>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Row</div><input value={styles.gridRow} onChange={(event) => applyLayout({ 'grid-row': event.target.value })} placeholder="auto" style={textField} /></div>
              </div>
              <div style={row2}>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Align self</div><select value={styles.alignSelf} onChange={(event) => applyLayout({ 'align-self': event.target.value })} style={{ ...textField, cursor: 'pointer' }}><option value="auto">Auto</option><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option></select></div>
                <div><div style={{ ...fieldLabel, marginBottom: 4 }}>Justify self</div><select value={styles.justifySelf} onChange={(event) => applyLayout({ 'justify-self': event.target.value })} style={{ ...textField, cursor: 'pointer' }}><option value="auto">Auto</option><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option></select></div>
              </div>
            </>}
          </div>}
        </div>}
      </div>

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
            {layoutMode === 'block' && <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: base.dim, fontSize: '10px', fontWeight: 600, flexShrink: 0, width: '26px' }}>Gap</span>
              <DimInput value={styles.gap} units={['px','em','rem','%']} onChange={handle('gap','gap')} />
            </div>}
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
