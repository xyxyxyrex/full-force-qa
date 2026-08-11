import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteAttachment, NoteDocument, NoteFolder, ParityAccountUser } from '../../../shared/types'
import { queueAccountStateSave } from '../services/accountStateService'
import './NotesWorkspace.css'

type NoteFilter = 'active' | 'pinned' | 'archived'
type NoteSort = 'updated' | 'created' | 'title'

function Icon({ name }: { name: string }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
  if (name === 'folder') return <svg {...common}><path d="M3 6.5h7l2 2h9v10H3z"/></svg>
  if (name === 'pin') return <svg {...common}><path d="m14 4 6 6-3 1-4 4-1 5-2-6-6-6 5-1 4-4z"/></svg>
  if (name === 'trash') return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>
  if (name === 'bold') return <svg {...common}><path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z"/></svg>
  if (name === 'italic') return <svg {...common}><path d="M19 4h-9M14 20H5M15 4 9 20"/></svg>
  if (name === 'underline') return <svg {...common}><path d="M6 4v6a6 6 0 0 0 12 0V4M4 21h16"/></svg>
  if (name === 'strike') return <svg {...common}><path d="M16 4H9a4 4 0 0 0-3.7 5.5M14.5 14.5A4 4 0 0 1 11 20H5M3 12h18"/></svg>
  if (name === 'list') return <svg {...common}><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
  if (name === 'ordered') return <svg {...common}><path d="M9 6h11M9 12h11M9 18h11M3 5h1v3M3 11h2l-2 3h2M3 17h2l-2 3h2"/></svg>
  if (name === 'quote') return <svg {...common}><path d="M5 7h5v5H6v5H3v-6a4 4 0 0 1 4-4M15 7h5v5h-4v5h-3v-6a4 4 0 0 1 4-4"/></svg>
  if (name === 'code') return <svg {...common}><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>
  if (name === 'link') return <svg {...common}><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></svg>
  if (name === 'image') return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>
  if (name === 'paperclip') return <svg {...common}><path d="m21 11-8 8a6 6 0 0 1-8-8l9-9a4 4 0 0 1 6 6l-9 9a2 2 0 0 1-3-3l8-8"/></svg>
  return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>
}

function plainText(html: string): string {
  const node = document.createElement('div')
  node.innerHTML = html
  return (node.textContent || '').replace(/\s+/g, ' ').trim()
}

function safeHref(value: string): string {
  try {
    const normalized = /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
    const parsed = new URL(normalized)
    return ['http:', 'https:', 'mailto:', 'parity-note:'].includes(parsed.protocol) ? parsed.href : ''
  } catch { return '' }
}

function sanitizeNoteHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html || ''
  const allowedTags = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'H1', 'H2', 'H3', 'HR', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRIKE', 'STRONG', 'U', 'UL'])
  for (const node of Array.from(template.content.querySelectorAll('*')).reverse()) {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes))
      continue
    }
    const allowedAttributes = node.tagName === 'A'
      ? new Set(['href', 'target', 'rel', 'data-note-attachment', 'data-note-file'])
      : node.tagName === 'IMG'
        ? new Set(['src', 'alt', 'data-note-attachment'])
        : new Set<string>()
    for (const attribute of Array.from(node.attributes)) {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) node.removeAttribute(attribute.name)
    }
    if (node instanceof HTMLAnchorElement) {
      const href = safeHref(node.getAttribute('href') || '')
      if (!href) node.replaceWith(...Array.from(node.childNodes))
      else {
        node.href = href
        node.target = '_blank'
        node.rel = 'noopener noreferrer'
      }
    }
    if (node instanceof HTMLImageElement) {
      const source = node.getAttribute('src') || ''
      if (!source.startsWith('parity-note://attachment/')) node.remove()
      else node.alt = node.alt || 'Local note attachment'
    }
  }
  return template.innerHTML.trim()
}

function createEmptyNote(folderId?: string): NoteDocument {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: 'Untitled note', contentHtml: '', plainText: '', folderId, tags: [], pinned: false, archived: false, attachments: [], createdAt: now, updatedAt: now }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}

export default function NotesWorkspace({ onOpenDashboard }: { onOpenDashboard: () => void }) {
  const [notes, setNotes] = useState<NoteDocument[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>(() => {
    try { return JSON.parse(localStorage.getItem('parity_note_folders') || '[]') } catch { return [] }
  })
  const [user, setUser] = useState<ParityAccountUser | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [filter, setFilter] = useState<NoteFilter>('active')
  const [sort, setSort] = useState<NoteSort>('updated')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [linkDialog, setLinkDialog] = useState<{ text: string; url: string } | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectionRef = useRef<Range | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const pendingNoteRef = useRef<NoteDocument | null>(null)
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve())

  const selectedNote = notes.find((note) => note.id === selectedId) || null

  const loadNotes = useCallback(async () => {
    setLoading(true)
    setError('')
    const result = await window.electronAPI.accountBootstrap()
    if (!result.connected || !result.user) {
      setUser(null)
      setNotes([])
      setSelectedId('')
      setError(result.error || 'Connect Monday.com from the Dashboard to use private Notes.')
      setLoading(false)
      return
    }
    setUser(result.user)
    const remoteNotes = result.notes || []
    setNotes(remoteNotes)
    setSelectedId((current) => remoteNotes.some((note) => note.id === current) ? current : remoteNotes[0]?.id || '')
    const remoteFolders = Array.isArray(result.state?.noteFolders) ? result.state.noteFolders : []
    setFolders(remoteFolders)
    localStorage.setItem('parity_note_folders', JSON.stringify(remoteFolders))
    window.dispatchEvent(new Event('qa_projects_updated'))
    setLoading(false)
  }, [])

  useEffect(() => { void loadNotes() }, [loadNotes])

  useEffect(() => {
    const reconnect = () => void loadNotes()
    const disconnect = () => {
      setUser(null)
      setNotes([])
      setFolders([])
      setSelectedId('')
      setError('Connect Monday.com from the Dashboard to use private Notes.')
    }
    window.addEventListener('parity:monday-connected', reconnect)
    window.addEventListener('parity:monday-disconnected', disconnect)
    return () => {
      window.removeEventListener('parity:monday-connected', reconnect)
      window.removeEventListener('parity:monday-disconnected', disconnect)
    }
  }, [loadNotes])

  useEffect(() => {
    const editor = editorRef.current
    if (editor && document.activeElement !== editor) editor.innerHTML = sanitizeNoteHtml(selectedNote?.contentHtml || '')
  }, [selectedId, selectedNote?.contentHtml])

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    const pending = pendingNoteRef.current
    if (pending) void saveChainRef.current.catch(() => {}).then(() => window.electronAPI.accountSaveNote(pending))
  }, [])

  const persistNote = useCallback(async (note: NoteDocument) => {
    const operation = saveChainRef.current.catch(() => {}).then(async () => {
      setSaveState('saving')
      const result = await window.electronAPI.accountSaveNote(note)
      if (!result.success) {
        setSaveState('error')
        setError(result.error || 'Unable to save note.')
        return false
      }
      if (
        pendingNoteRef.current?.id === note.id &&
        pendingNoteRef.current.updatedAt <= note.updatedAt
      ) pendingNoteRef.current = null
      setSaveState('saved')
      window.setTimeout(() => setSaveState((state) => state === 'saved' ? 'idle' : state), 1300)
      return true
    })
    saveChainRef.current = operation
    return operation
  }, [])

  const updateNote = useCallback((patch: Partial<NoteDocument>, immediate = false) => {
    if (!selectedNote) return
    const next = { ...selectedNote, ...patch, updatedAt: Date.now() }
    setNotes((current) => {
      const updated = current.map((note) => note.id === next.id ? next : note)
      return updated
    })
    pendingNoteRef.current = next
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    if (immediate) void persistNote(next)
    else saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistNote(next)
    }, 750)
  }, [persistNote, selectedNote])

  const createNote = async () => {
    if (!user) return
    const note = createEmptyNote(selectedFolder !== 'all' && selectedFolder !== 'none' ? selectedFolder : undefined)
    setNotes((current) => [note, ...current])
    setSelectedId(note.id)
    await persistNote(note)
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const deleteNote = async () => {
    if (!selectedNote || !window.confirm(`Delete “${selectedNote.title}”? This removes its cloud data and local attachments.`)) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    pendingNoteRef.current = null
    await saveChainRef.current.catch(() => {})
    const result = await window.electronAPI.accountDeleteNote(selectedNote.id)
    if (!result.success) { setError(result.error || 'Unable to delete note.'); return }
    await window.electronAPI.deleteNoteAttachments(selectedNote.attachments.map((attachment) => attachment.id))
    setNotes((current) => {
      const next = current.filter((note) => note.id !== selectedNote.id)
      setSelectedId(next[0]?.id || '')
      return next
    })
  }

  const createFolder = () => {
    const name = window.prompt('Folder name')?.trim()
    if (!name) return
    const next = [...folders, { id: crypto.randomUUID(), name: name.slice(0, 80), createdAt: Date.now() }]
    setFolders(next)
    localStorage.setItem('parity_note_folders', JSON.stringify(next))
    queueAccountStateSave({ noteFolders: next })
  }

  const rememberSelection = () => {
    const selection = window.getSelection()
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) selectionRef.current = selection.getRangeAt(0).cloneRange()
  }

  const restoreSelection = () => {
    const editor = editorRef.current
    if (!editor) return null
    editor.focus()
    const selection = window.getSelection()
    selection?.removeAllRanges()
    const range = selectionRef.current || document.createRange()
    if (!selectionRef.current) { range.selectNodeContents(editor); range.collapse(false) }
    selection?.addRange(range)
    return range
  }

  const emitEditorChange = () => {
    if (!editorRef.current) return
    const contentHtml = sanitizeNoteHtml(editorRef.current.innerHTML)
    updateNote({ contentHtml, plainText: plainText(contentHtml) })
  }

  const command = (name: string, value?: string) => {
    restoreSelection()
    document.execCommand(name, false, value)
    emitEditorChange()
    rememberSelection()
  }

  const insertNode = (node: Node, emit = true) => {
    const range = restoreSelection()
    if (!range) return
    range.deleteContents()
    range.insertNode(node)
    const spacer = document.createElement('br')
    node.parentNode?.insertBefore(spacer, node.nextSibling)
    range.setStartAfter(spacer)
    range.collapse(true)
    selectionRef.current = range.cloneRange()
    if (emit) emitEditorChange()
  }

  const attachFiles = async (files: File[], preferImages: boolean) => {
    if (!selectedNote || !files.length) return
    rememberSelection()
    setSaveState('saving')
    const newAttachments: NoteAttachment[] = []
    try {
      for (const file of files) {
        if (preferImages && !file.type.startsWith('image/')) continue
        const result = await window.electronAPI.saveNoteAttachment({ dataUrl: await fileToDataUrl(file), name: file.name })
        if (!result.success || !result.attachment) throw new Error(result.error || 'Attachment failed.')
        newAttachments.push(result.attachment)
        if (result.attachment.kind === 'image') {
          const image = document.createElement('img')
          image.src = result.attachment.uri
          image.alt = result.attachment.name
          image.dataset.noteAttachment = result.attachment.id
          insertNode(image, false)
        } else {
          const link = document.createElement('a')
          link.href = result.attachment.uri
          link.textContent = `📎 ${result.attachment.name}`
          link.dataset.noteAttachment = result.attachment.id
          link.dataset.noteFile = 'true'
          insertNode(link, false)
        }
      }
      const contentHtml = sanitizeNoteHtml(editorRef.current?.innerHTML || selectedNote.contentHtml)
      updateNote({
        attachments: [...selectedNote.attachments, ...newAttachments],
        contentHtml,
        plainText: plainText(contentHtml),
      }, true)
    } catch (attachmentError) {
      setSaveState('error')
      setError(attachmentError instanceof Error ? attachmentError.message : 'Attachment failed.')
    }
  }

  const applyLink = () => {
    if (!linkDialog) return
    const href = safeHref(linkDialog.url)
    const range = restoreSelection()
    if (!href || !range) return
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.textContent = linkDialog.text.trim() || href
    range.deleteContents()
    range.insertNode(anchor)
    setLinkDialog(null)
    emitEditorChange()
  }

  const visibleNotes = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase()
    return notes.filter((note) => {
      if (filter === 'active' && note.archived) return false
      if (filter === 'archived' && !note.archived) return false
      if (filter === 'pinned' && (!note.pinned || note.archived)) return false
      if (selectedFolder === 'none' && note.folderId) return false
      if (selectedFolder !== 'all' && selectedFolder !== 'none' && note.folderId !== selectedFolder) return false
      return !query || `${note.title} ${note.plainText} ${note.tags.join(' ')}`.toLowerCase().includes(query)
    }).sort((left, right) => sort === 'title' ? left.title.localeCompare(right.title) : sort === 'created' ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt)
  }, [deferredSearch, filter, notes, selectedFolder, sort])

  return <div className="notes-workspace">
    <aside className="notes-folders">
      <div className="notes-pane-title"><span>Notes</span><button onClick={createFolder} title="New folder"><Icon name="folder"/><Icon name="plus"/></button></div>
      <button className={selectedFolder === 'all' ? 'active' : ''} onClick={() => setSelectedFolder('all')}><Icon name="folder"/>All notes <em>{notes.filter((note) => !note.archived).length}</em></button>
      <button className={selectedFolder === 'none' ? 'active' : ''} onClick={() => setSelectedFolder('none')}><Icon name="folder"/>Unfiled</button>
      <div className="notes-folder-label">Folders</div>
      {folders.map((folder) => <button key={folder.id} className={selectedFolder === folder.id ? 'active' : ''} onClick={() => setSelectedFolder(folder.id)}><Icon name="folder"/>{folder.name}<em>{notes.filter((note) => note.folderId === folder.id && !note.archived).length}</em></button>)}
      <div className="notes-folder-spacer"/>
      <button className={filter === 'pinned' ? 'active' : ''} onClick={() => setFilter(filter === 'pinned' ? 'active' : 'pinned')}><Icon name="pin"/>Pinned</button>
      <button className={filter === 'archived' ? 'active' : ''} onClick={() => setFilter(filter === 'archived' ? 'active' : 'archived')}><Icon name="trash"/>Archive</button>
      {user && <div className="notes-account"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>Monday private workspace</small></div></div>}
    </aside>

    <section className="notes-index">
      <div className="notes-index-tools">
        <label><Icon name="search"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes"/></label>
        <select value={sort} onChange={(event) => setSort(event.target.value as NoteSort)}><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="title">Title A–Z</option></select>
        <button className="notes-new" onClick={() => void createNote()} disabled={!user}><Icon name="plus"/>New note</button>
      </div>
      <div className="notes-list">
        {loading && !notes.length ? <div className="notes-empty">Loading your private notes…</div> : visibleNotes.map((note) => <button key={note.id} className={selectedId === note.id ? 'active' : ''} onClick={() => setSelectedId(note.id)}>
          <strong>{note.title || 'Untitled note'}{note.pinned && <span>◆</span>}</strong>
          <p>{note.plainText || 'No content yet'}</p>
          <small>{new Date(note.updatedAt).toLocaleString()} {note.tags.slice(0, 2).map((tag) => <em key={tag}>#{tag}</em>)}</small>
        </button>)}
        {!loading && user && !visibleNotes.length && <div className="notes-empty">No matching notes.<button onClick={() => void createNote()}>Create one</button></div>}
      </div>
    </section>

    <main className="notes-editor-pane">
      {!user ? <div className="notes-connection-empty"><Icon name="paperclip"/><h2>Monday account required</h2><p>{error || 'Connect Monday.com to keep your notes private and synchronized.'}</p><button onClick={onOpenDashboard}>Open Dashboard</button></div>
      : !selectedNote ? <div className="notes-connection-empty"><h2>Your notes, organized</h2><p>Create a note to begin. Rich text is stored privately in Supabase; attachments stay on this device.</p><button onClick={() => void createNote()}>Create first note</button></div>
      : <>
        <header className="notes-document-header">
          <input className="notes-title" value={selectedNote.title} onChange={(event) => updateNote({ title: event.target.value.slice(0, 240) })} placeholder="Untitled note"/>
          <div className="notes-document-actions"><span className={`notes-save-state ${saveState}`}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span><button className={selectedNote.pinned ? 'active' : ''} onClick={() => updateNote({ pinned: !selectedNote.pinned }, true)} title="Pin note"><Icon name="pin"/></button><button onClick={() => updateNote({ archived: !selectedNote.archived }, true)} title={selectedNote.archived ? 'Restore note' : 'Archive note'}><Icon name="trash"/></button><button className="danger" onClick={() => void deleteNote()} title="Delete note">×</button></div>
        </header>
        <div className="notes-metadata"><select value={selectedNote.folderId || ''} onChange={(event) => updateNote({ folderId: event.target.value || undefined }, true)}><option value="">Unfiled</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><input value={selectedNote.tags.join(', ')} onChange={(event) => updateNote({ tags: event.target.value.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean).slice(0, 20) })} placeholder="tags, comma separated"/></div>
        <div className="notes-toolbar" role="toolbar">
          <select defaultValue="p" onChange={(event) => { command('formatBlock', event.target.value); event.currentTarget.value = 'p' }}><option value="p">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option></select>
          {[['bold','bold','Bold'],['italic','italic','Italic'],['underline','underline','Underline'],['strikeThrough','strike','Strikethrough'],['insertUnorderedList','list','Bulleted list'],['insertOrderedList','ordered','Numbered list'],['formatBlock','quote','Quote']].map(([cmd, icon, title]) => <button key={`${cmd}-${icon}`} title={title} onMouseDown={(event) => event.preventDefault()} onClick={() => command(cmd, icon === 'quote' ? 'blockquote' : undefined)}><Icon name={icon}/></button>)}
          <button title="Code block" onMouseDown={(event) => event.preventDefault()} onClick={() => command('formatBlock', 'pre')}><Icon name="code"/></button>
          <span/>
          <button title="Attach link" onMouseDown={(event) => event.preventDefault()} onClick={() => { rememberSelection(); setLinkDialog({ text: window.getSelection()?.toString() || '', url: '' }) }}><Icon name="link"/></button>
          <button title="Attach compressed image" onMouseDown={(event) => event.preventDefault()} onClick={() => { rememberSelection(); imageInputRef.current?.click() }}><Icon name="image"/></button>
          <button title="Attach local file" onMouseDown={(event) => event.preventDefault()} onClick={() => { rememberSelection(); fileInputRef.current?.click() }}><Icon name="paperclip"/></button>
          <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void attachFiles(Array.from(event.target.files || []), true); event.target.value = '' }}/>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void attachFiles(Array.from(event.target.files || []), false); event.target.value = '' }}/>
        </div>
        <div ref={editorRef} className="notes-rich-surface" contentEditable suppressContentEditableWarning data-placeholder="Start writing…" onInput={emitEditorChange} onBlur={() => { emitEditorChange(); rememberSelection() }} onKeyUp={rememberSelection} onMouseUp={rememberSelection} onClick={(event) => { const anchor = (event.target as HTMLElement).closest('a'); if (!anchor) return; event.preventDefault(); const href = anchor.getAttribute('href') || ''; if (href.startsWith('parity-note:')) void window.electronAPI.openNoteAttachment(href).then((result) => { if (!result.success) setError(result.error || 'Attachment unavailable.') }); else if (/^https?:|^mailto:/i.test(href)) void window.electronAPI.openExternal(href) }} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void attachFiles(images, true) } }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (pendingNoteRef.current) void persistNote(pendingNoteRef.current) } }}/>
        {linkDialog && <div className="notes-link-dialog"><label>Display text<input value={linkDialog.text} onChange={(event) => setLinkDialog({ ...linkDialog, text: event.target.value })} autoFocus/></label><label>URL<input value={linkDialog.url} onChange={(event) => setLinkDialog({ ...linkDialog, url: event.target.value })} placeholder="https://example.com" onKeyDown={(event) => { if (event.key === 'Enter') applyLink() }}/></label><div><button onClick={() => setLinkDialog(null)}>Cancel</button><button className="primary" disabled={!safeHref(linkDialog.url)} onClick={applyLink}>Apply</button></div></div>}
        {error && <div className="notes-error" onClick={() => setError('')}>{error}<span>×</span></div>}
      </>}
    </main>
  </div>
}
