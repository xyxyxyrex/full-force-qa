import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentInfo } from '../../../../shared/qaAgent'
import AgentIcon from './AgentIcon'
import type { ModelDiscoveryState } from './useModelDiscovery'

export default function AgentModelPicker({ agent, value, state, load, save, active, disabled }: {
  agent: AgentInfo; value: string; state: ModelDiscoveryState; load: () => void
  save: (value: string) => Promise<boolean>; active: boolean; disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState(0)
  const [custom, setCustom] = useState(false)
  const [draft, setDraft] = useState(value)
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, top: 0, width: 0, maxHeight: 360 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const customInput = useRef<HTMLInputElement>(null)
  const listId = useId()
  const choices = state.models.map(id => state.options?.find(option => option.id === id) || { id, label: id })
  if (value && !choices.some(option => option.id === value)) choices.unshift({ id: value, label: value, description: 'Saved model · not in the current list' })
  if (agent.kind === 'subscription') choices.unshift({ id: '', label: 'App default', description: 'Let your signed-in app choose' })
  const filtered = choices.filter(option => `${option.label} ${option.id}`.toLowerCase().includes(search.toLowerCase()))
  const selected = choices.find(option => option.id === value)
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus() }
  useEffect(() => { if (!active || disabled) setOpen(false) }, [active, disabled])
  useEffect(() => { if (open && active && !disabled && state.status === 'idle') load() }, [open, active, disabled, state.status, load])
  useEffect(() => { setCursor(0) }, [search, state.models])
  useEffect(() => { if (custom) customInput.current?.focus() }, [custom])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 16
      const above = rect.top - 16
      const down = below >= 260 || below >= above
      const maxHeight = Math.max(120, Math.min(360, down ? below : above))
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), ...(down ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }), width, maxHeight })
    }
    place(); input.current?.focus()
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => { if (open) document.getElementById(`${listId}-${cursor}`)?.scrollIntoView({ block: 'nearest' }) }, [cursor, open, listId])
  const choose = (id: string) => { close(true); void save(id) }
  return <div className="agents-model-picker">
    <span className="agents-field-label">Model</span>
    <button type="button" ref={trigger} className="agents-model-trigger" aria-label="Choose model" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => { setSearch(''); setOpen(!open) }}>
      <AgentIcon id={agent.id} model={value}/><span>{selected?.label || 'Choose a model'}</span><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {custom && <div className="agents-custom-model">
      <label className="agents-field"><span>Custom model ID</span><input type="text" ref={customInput} aria-label="Custom model ID" value={draft} maxLength={120} spellCheck={false} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setCustom(false); trigger.current?.focus() } if (event.key === 'Enter' && draft.trim()) { void save(draft.trim()).then(saved => { if (saved) setCustom(false) }) } }}/></label>
      <div className="agents-row"><button className="agents-button" disabled={!draft.trim() || disabled} onClick={() => void save(draft.trim()).then(saved => { if (saved) { setCustom(false); trigger.current?.focus() } })}>Apply</button><button className="agents-link" onClick={() => { setCustom(false); trigger.current?.focus() }}>Cancel</button></div>
    </div>}
    {open && createPortal(<div ref={menu} className="agents-panel agents-model-menu" style={position} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close() }}>
      <input type="text" ref={input} className="agents-model-search" role="combobox" aria-label="Search models" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={filtered[cursor] ? `${listId}-${cursor}` : undefined} placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setCursor(current => event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(0, filtered.length - 1) : Math.max(0, Math.min(filtered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))) }
        if (event.key === 'Enter' && filtered[cursor]) { event.preventDefault(); choose(filtered[cursor].id) }
      }}/>
      {state.status === 'loading' && <div className="agents-model-loading" role="status">Loading models…<div className="agents-skeleton-line"/><div className="agents-skeleton-line"/></div>}
      {state.error && <p className="agents-warn" role="alert">{state.error}</p>}
      <div id={listId} role="listbox" aria-label="Available models" aria-busy={state.status === 'loading'} className="agents-model-options">
        {filtered.map((option, index) => <button key={option.id} type="button" role="option" tabIndex={-1} id={`${listId}-${index}`} aria-selected={value === option.id} className={`agents-model-option ${index === cursor ? 'highlighted' : ''}`} onMouseEnter={() => setCursor(index)} onClick={() => choose(option.id)}>
          <AgentIcon id={agent.id} model={option.id}/><span className="agents-model-text"><strong>{option.label}</strong>{option.label !== option.id && option.id && <small>{option.id}</small>}{option.description && <small>{option.description}</small>}</span>
          {option.id === state.recommended && <span className="agents-badge">Suggested</span>}{value === option.id && <span aria-hidden="true">✓</span>}
        </button>)}
        {!filtered.length && state.status !== 'loading' && <p className="agents-muted">{search ? 'No matching models.' : 'No models found. Refresh or enter a custom model.'}</p>}
      </div>
      <div className="agents-model-footer"><button className="agents-link" type="button" disabled={state.status === 'loading'} onClick={load}>Refresh models</button><button className="agents-link" type="button" onClick={() => { close(); setCustom(true) }}>Custom model…</button></div>
    </div>, document.body)}
  </div>
}
