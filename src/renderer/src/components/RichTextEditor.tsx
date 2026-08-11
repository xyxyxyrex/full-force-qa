import React, { useEffect, useRef, useState } from 'react'
import './RichTextEditor.css'

type ToolbarIconName = 'bold' | 'italic' | 'underline' | 'strike' | 'bulletList' | 'numberList' | 'link' | 'image'

const ToolbarIcon: React.FC<{ name: ToolbarIconName }> = ({ name }) => {
  const props = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'bold') return <svg {...props}><path d="M7 4h6a4 4 0 0 1 0 8H7z" /><path d="M7 12h7a4 4 0 0 1 0 8H7z" /></svg>
  if (name === 'italic') return <svg {...props}><path d="M19 4h-9" /><path d="M14 20H5" /><path d="m15 4-6 16" /></svg>
  if (name === 'underline') return <svg {...props}><path d="M6 4v6a6 6 0 0 0 12 0V4" /><path d="M4 21h16" /></svg>
  if (name === 'strike') return <svg {...props}><path d="M16 4H9a4 4 0 0 0-3.7 5.5" /><path d="M14.5 14.5A4 4 0 0 1 11 20H5" /><path d="M3 12h18" /></svg>
  if (name === 'bulletList') return <svg {...props}><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" /><path d="M8 6h12M8 12h12M8 18h12" /></svg>
  if (name === 'numberList') return <svg {...props}><path d="M3 5h1v4M3 9h2M3 14h2l-2 3h2" /><path d="M9 6h11M9 12h11M9 18h11" /></svg>
  if (name === 'link') return <svg {...props}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
  return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></svg>
}

const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'I', 'IMG', 'LI', 'OL',
  'P', 'PRE', 'S', 'SPAN', 'STRIKE', 'STRONG', 'U', 'UL',
])

function safeLink(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const normalized = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(normalized)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

export function sanitizeRichText(html: string): string {
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html || ''
  const elements = Array.from(template.content.querySelectorAll('*')).reverse()
  elements.forEach((node) => {
    if (!ALLOWED_TAGS.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes))
      return
    }
    const allowedAttributes = node.tagName === 'A'
      ? new Set(['href', 'target', 'rel'])
      : node.tagName === 'IMG'
        ? new Set(['src', 'alt', 'data-qa-asset'])
        : new Set<string>()
    Array.from(node.attributes).forEach((attribute) => {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) node.removeAttribute(attribute.name)
    })
    if (node instanceof HTMLAnchorElement) {
      const href = safeLink(node.getAttribute('href') || '')
      if (!href) node.removeAttribute('href')
      else {
        node.href = href
        node.target = '_blank'
        node.rel = 'noopener noreferrer'
      }
    }
    if (node instanceof HTMLImageElement) {
      const source = node.getAttribute('src') || ''
      const assetPath = node.dataset.qaAsset || ''
      if (!assetPath && !/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source)) node.remove()
      else {
        node.alt = node.alt || 'Attached image'
        if (assetPath) node.removeAttribute('src')
      }
    }
  })
  return template.innerHTML.trim()
}

export function plainTextFromRichText(html: string): string {
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, ' ')
  const container = document.createElement('div')
  container.innerHTML = sanitizeRichText(html)
  return (container.textContent || '').replace(/\s+/g, ' ').trim()
}

async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be attached.')
  if (file.size > 20 * 1024 * 1024) throw new Error('Images must be smaller than 20 MB before compression.')
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('The image could not be decoded.'))
      element.src = objectUrl
    })
    const maxEdge = 1600
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('Image compression is unavailable.')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error('Image compression failed.')),
        'image/webp',
        0.78,
      )
    })
    if (blob.size > 5 * 1024 * 1024) throw new Error('The compressed image is still larger than 5 MB.')
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('The compressed image could not be read.'))
      reader.readAsDataURL(blob)
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

interface RichTextEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  compact?: boolean
  ariaLabel?: string
}

export const RichTextEditor: React.FC<RichTextEditorProps> = ({
  value,
  onChange,
  placeholder = 'Add a description…',
  compact = false,
  ariaLabel = 'Rich text editor',
}) => {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const savedRangeRef = useRef<Range | null>(null)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [imageStatus, setImageStatus] = useState('')

  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.innerHTML !== value && document.activeElement !== editor) {
      editor.innerHTML = sanitizeRichText(value)
    }
  }, [value])

  const emitChange = () => {
    const editor = editorRef.current
    if (editor) onChange(sanitizeRichText(editor.innerHTML))
  }

  const rememberSelection = () => {
    const selection = window.getSelection()
    if (selection?.rangeCount && editorRef.current?.contains(selection.anchorNode)) {
      savedRangeRef.current = selection.getRangeAt(0).cloneRange()
    }
  }

  const restoreSelection = () => {
    const editor = editorRef.current
    if (!editor) return null
    editor.focus()
    const selection = window.getSelection()
    selection?.removeAllRanges()
    const range = savedRangeRef.current || document.createRange()
    if (!savedRangeRef.current) range.selectNodeContents(editor)
    if (!savedRangeRef.current) range.collapse(false)
    selection?.addRange(range)
    return range
  }

  const runCommand = (command: string) => {
    restoreSelection()
    document.execCommand(command, false)
    emitChange()
    rememberSelection()
  }

  const openLinkDialog = () => {
    rememberSelection()
    const selection = window.getSelection()?.toString() || ''
    setLinkText(selection)
    setLinkUrl('')
    setLinkDialogOpen(true)
  }

  const applyLink = () => {
    const href = safeLink(linkUrl)
    if (!href) return
    const range = restoreSelection()
    if (!range) return
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.textContent = linkText.trim() || href
    range.deleteContents()
    range.insertNode(anchor)
    range.setStartAfter(anchor)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    savedRangeRef.current = range.cloneRange()
    setLinkDialogOpen(false)
    emitChange()
  }

  const insertImageData = (dataUrl: string, alt: string) => {
    const range = restoreSelection()
    if (!range) return
    const image = document.createElement('img')
    image.src = dataUrl
    image.alt = alt || 'Attached image'
    range.deleteContents()
    range.insertNode(image)
    const spacer = document.createElement('br')
    image.after(spacer)
    range.setStartAfter(spacer)
    range.collapse(true)
    savedRangeRef.current = range.cloneRange()
    emitChange()
  }

  const addImages = async (files: File[]) => {
    if (!files.length) return
    rememberSelection()
    setImageStatus('Compressing image…')
    try {
      for (const file of files) insertImageData(await compressImage(file), file.name)
      setImageStatus('Image compressed and attached')
    } catch (error) {
      setImageStatus(error instanceof Error ? error.message : 'Image attachment failed.')
    } finally {
      window.setTimeout(() => setImageStatus(''), 2600)
    }
  }

  return (
    <div className={`rich-text-editor${compact ? ' compact' : ''}`}>
      <div className="rich-text-toolbar" role="toolbar" aria-label="Text formatting">
        {[
          ['bold', 'bold', 'Bold'],
          ['italic', 'italic', 'Italic'],
          ['underline', 'underline', 'Underline'],
          ['strikeThrough', 'strike', 'Strikethrough'],
          ['insertUnorderedList', 'bulletList', 'Bulleted list'],
          ['insertOrderedList', 'numberList', 'Numbered list'],
        ].map(([command, icon, title]) => (
          <button key={command} type="button" title={title} aria-label={title} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand(command)}><ToolbarIcon name={icon as ToolbarIconName} /></button>
        ))}
        <button type="button" title="Attach link" aria-label="Attach link" onMouseDown={(event) => event.preventDefault()} onClick={openLinkDialog}><ToolbarIcon name="link" /></button>
        <button type="button" title="Attach compressed image" aria-label="Attach compressed image" onMouseDown={(event) => event.preventDefault()} onClick={() => { rememberSelection(); fileInputRef.current?.click() }}><ToolbarIcon name="image" /></button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void addImages(Array.from(event.target.files || [])); event.target.value = '' }} />
      </div>
      <div
        ref={editorRef}
        className="rich-text-surface"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        onInput={emitChange}
        onBlur={() => { emitChange(); rememberSelection() }}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
          if (files.length) {
            event.preventDefault()
            void addImages(files)
          }
        }}
      />
      {imageStatus && <div className="rich-text-status" role="status">{imageStatus}</div>}
      {linkDialogOpen && (
        <div className="rich-link-dialog" role="dialog" aria-label="Attach link">
          <label>Display Text<input value={linkText} onChange={(event) => setLinkText(event.target.value)} autoFocus /></label>
          <label>URL<input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://example.com" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyLink() } }} /></label>
          <div><button type="button" onClick={() => setLinkDialogOpen(false)}>Cancel</button><button type="button" className="apply" disabled={!safeLink(linkUrl)} onClick={applyLink}>Apply</button></div>
        </div>
      )}
    </div>
  )
}

export const RichTextContent: React.FC<{ html: string; className?: string }> = ({ html, className }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeRichText(html) }} />
)
