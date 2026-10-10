import { useEffect, useId, useRef, useState } from 'react'
import { CHAT_IMAGE_ACCEPT } from '../../../../shared/chatImages'
import ChatIcon from './ChatIcon'

export default function ComposerAdd({ adding, add, commands, opened }: { adding: boolean; add: (files: File[]) => void; commands: () => void; opened: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const show = () => { opened(); setOpen(true); window.setTimeout(() => root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus(), 0) }
  return <div className="qa-composer-add" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') || [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="qa-command-toggle" aria-label="Add to message" title="Add images or commands" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); show() } }}><ChatIcon name="plus" size={18}/></button>
    <input ref={input} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden aria-label="Attach images" onChange={event => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; add(files) }}/>
    {open && <div className="qa-composer-add-menu" id={id} role="menu" aria-label="Add to message">
      <button type="button" role="menuitem" disabled={adding} onClick={() => { setOpen(false); input.current?.click() }}><ChatIcon name="image"/>Attach images</button>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); commands() }}><ChatIcon name="commands"/>Commands</button>
      <small>Up to 4 images · 10 MB each</small>
    </div>}
  </div>
}
