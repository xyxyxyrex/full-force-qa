import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { contextualCommands, paletteProviders, rankItems, type PaletteGroup, type PaletteItem, type PaletteProvider } from '../palette/registry'
import './CommandPalette.css'

const groups: Array<PaletteGroup | 'All'> = ['All', 'Commands', 'Page', 'Files', 'Projects', 'Folders', 'Tickets', 'Notes', 'Annotations', 'Tabs']

function MatchText({ text, query }: { text: string; query: string }) {
  const terms = query.replace(/^\s*>\s*/, '').replace(/"/g, '').toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const match = terms.map(term => ({ term, index: lower.indexOf(term) })).filter(value => value.index >= 0).sort((a, b) => a.index - b.index)[0]
  if (!match) return <>{text}</>
  return <>{text.slice(0, match.index)}<mark>{text.slice(match.index, match.index + match.term.length)}</mark>{text.slice(match.index + match.term.length)}</>
}

export default function CommandPalette({ scopeKey }: { scopeKey: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<PaletteGroup | 'All'>('All')
  const [items, setItems] = useState<PaletteItem[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(80)
  const sourceRef = useRef<PaletteProvider[]>([])
  const controlsRef = useRef<PaletteItem[]>([])
  const controller = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  const openSequence = useRef(0)
  const executeRef = useRef<() => void>(() => {})
  const visible = items.filter(item => group === 'All' || item.group === group)
  const visibleRef = useRef(visible)
  openRef.current = open
  visibleRef.current = visible

  useEffect(() => {
    const show = () => {
      if (openRef.current) { inputRef.current?.focus(); return }
      openSequence.current++
      restoreRef.current = document.activeElement as HTMLElement
      sourceRef.current = paletteProviders()
      controlsRef.current = contextualCommands(document)
      setQuery(''); setGroup('All'); setLimit(80); setActive(0); setError(''); setItems([]); setOpen(true)
    }
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) show(); return
      }
      if (!openRef.current) return
      // Own all shortcuts while the palette has focus, including Escape and save.
      event.stopImmediatePropagation()
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + visibleRef.current.length) % Math.max(1, visibleRef.current.length))
      }
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); executeRef.current() }
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || [])]
        const index = focusable.indexOf(document.activeElement as HTMLElement)
        event.preventDefault()
        focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
      }
    }
    const unsubscribe = window.electronAPI?.onOpenCommandPalette?.(show)
    window.addEventListener('parity:open-palette', show)
    window.addEventListener('keydown', key, true)
    return () => { unsubscribe?.(); window.removeEventListener('parity:open-palette', show); window.removeEventListener('keydown', key, true) }
  }, [])

  useEffect(() => { openSequence.current++; setOpen(false) }, [scopeKey])
  useEffect(() => {
    const reset = () => { openSequence.current++; controller.current?.abort(); setItems([]); setQuery(''); setOpen(false) }
    window.addEventListener('parity:account-owner-changed', reset)
    return () => window.removeEventListener('parity:account-owner-changed', reset)
  }, [])

  useEffect(() => {
    if (!open) return
    const root = document.getElementById('root')
    const wasInert = root?.inert
    if (root) root.inert = true
    inputRef.current?.focus()
    return () => {
      controller.current?.abort()
      sourceRef.current.forEach(provider => provider.release?.())
      if (root) root.inert = !!wasInert
      if (restoreRef.current?.isConnected) restoreRef.current.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    controller.current?.abort()
    controller.current = abort
    setLoading(true); setActive(0)
    const commandOnly = query.trimStart().startsWith('>')
    const term = commandOnly ? query.trimStart().slice(1).trim() : query.trim()
    const timer = window.setTimeout(async () => {
      const commands = [...sourceRef.current.flatMap(provider => provider.commands?.() || []), ...controlsRef.current]
      const unique = commands.filter((item, index) => commands.findIndex(candidate => candidate.group === item.group && candidate.title.toLowerCase() === item.title.toLowerCase()) === index)
      const ranked = rankItems(unique.filter(item => (!commandOnly || item.group === 'Commands') && (group === 'All' || item.group === group)), term, limit)
      if (abort.signal.aborted) return
      setItems(ranked.items); setTotal(ranked.total || 0); setWarnings([])
      const providers = commandOnly || group === 'Commands' || !term ? [] : sourceRef.current.filter(provider => provider.search)
      const results = await Promise.all(providers.map(async provider => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            provider.search!(term, abort.signal, { group, limit }),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Search timed out. Try again.')), 15000) }),
          ])
        } catch (cause) { return { items: [], total: 0, warning: `${provider.label}: ${cause instanceof Error ? cause.message : 'Search unavailable'}` } }
        finally { clearTimeout(timeout) }
      }))
      if (abort.signal.aborted) return
      setItems([...ranked.items, ...results.flatMap(result => result.items)])
      setTotal((ranked.total || 0) + results.reduce((sum, result) => sum + (result.total ?? result.items.length), 0))
      setWarnings(results.flatMap(result => result.warning ? [result.warning] : []))
      setLoading(false)
    }, query ? 150 : 0)
    return () => { clearTimeout(timer); abort.abort() }
  }, [open, query, group, limit])

  useEffect(() => { setActive(0) }, [group])
  useEffect(() => { dialogRef.current?.querySelector(`[data-result-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active])

  const execute = async (item?: PaletteItem) => {
    if (!item || running || item.disabled) return
    const sequence = openSequence.current
    setRunning(true); setError('')
    try {
      if (item.group === 'Commands') {
        // Remove the modal before commands capture the canvas or open dialogs.
        setOpen(false)
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      }
      if (sequence !== openSequence.current) return
      await item.run()
      if (sequence === openSequence.current) setOpen(false)
    }
    catch (cause) {
      if (sequence !== openSequence.current) return
      sourceRef.current = paletteProviders()
      if (!openRef.current) controlsRef.current = contextualCommands(document)
      setError(cause instanceof Error ? cause.message : 'Unable to run this action.'); setOpen(true)
    }
    finally { setRunning(false) }
  }
  executeRef.current = () => {
    const focused = document.activeElement
    if (focused instanceof HTMLButtonElement && dialogRef.current?.contains(focused)) focused.click()
    else void execute(visible[active])
  }

  if (!open) return null
  return createPortal(<div className="command-palette-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !running) setOpen(false) }}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Search Parity and run commands" ref={dialogRef}>
      <header><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
        <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setLimit(80); setError('') }} placeholder="Search Parity, or type > for commands…" aria-label="Search Parity" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list" aria-activedescendant={visible[active] ? `palette-option-${active}` : undefined} autoComplete="off" spellCheck={false}/>
        <button onClick={() => setOpen(false)} aria-label="Close command palette"><kbd>Esc</kbd></button>
      </header>
      <nav aria-label="Search categories">{groups.map(category => <button key={category} aria-pressed={group === category} onClick={() => { setGroup(category); setLimit(80) }}>{category}</button>)}</nav>
      <div className="palette-status" role="status">{loading ? 'Searching…' : query ? `${total} matches · ${visible.length} shown` : 'Commands and shortcuts · type to search page and workspace data'}{running && ' · Opening…'}</div>
      {error && <div className="palette-error" role="alert">{error}</div>}
      <div className="palette-results" id="palette-results" role="listbox" aria-label="Search results" aria-busy={loading}>
        {visible.map((item, index) => <div key={item.id} role="option" aria-selected={index === active} aria-disabled={!!item.disabled} id={`palette-option-${index}`} data-result-index={index} className={`palette-result ${index === active ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`} onMouseMove={() => setActive(index)} onClick={() => void execute(item)}>
          <span className="palette-kind">{item.group}</span><span className="palette-result-copy"><strong><MatchText text={item.title} query={query}/></strong><small><MatchText text={item.disabled || item.description || ''} query={query}/></small></span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
        </div>)}
        {!visible.length && !loading && <div className="palette-empty">No matches. Try fewer words or another category.</div>}
      </div>
      {!loading && total > visible.length && limit < 10000 && <button className="palette-more" onClick={() => setLimit(current => Math.min(10000, current + 80))}>Show more matches</button>}
      {!!warnings.length && <details className="palette-coverage"><summary>Search coverage</summary>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> open or run</span><span><kbd>&gt;</kbd> commands only</span><span>Ctrl Shift F</span></footer>
    </div>
  </div>, document.body)
}
