import { useState, useEffect, useRef } from 'react'

interface Props {
  selectedElement: HTMLElement | null
  initialCss: string
  onCssChange: (updatedCss: string) => void
}

/**
 * VS Code Dark+ Style CSS Syntax Highlighter
 * Maps 1:1 character-by-character with plain text to eliminate cursor offset bugs.
 */
function highlightCss(css: string): string {
  if (!css) return ''

  const lines = css.split('\n')
  const highlightedLines = lines.map((line) => {
    const escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    // 1. Comments: /* ... */
    if (escaped.trim().startsWith('/*')) {
      return `<span style="color: #6a9955; font-style: italic;">${escaped}</span>`
    }

    // 2. Selectors with opening brace
    if (escaped.includes('{')) {
      const braceIdx = escaped.indexOf('{')
      const selector = escaped.slice(0, braceIdx)
      const rest = escaped.slice(braceIdx + 1)
      return `<span style="color: #569cd6; font-weight: 600;">${selector}</span><span style="color: #d4d4d4;">{</span>${rest}`
    }

    // 3. Closing brace
    if (escaped.trim() === '}') {
      return `<span style="color: #d4d4d4;">}</span>`
    }

    // 4. Property : Value declarations (NO extra spaces added)
    if (escaped.includes(':')) {
      const colonIdx = escaped.indexOf(':')
      const prop = escaped.slice(0, colonIdx)
      const rest = escaped.slice(colonIdx + 1)
      return `<span style="color: #9cdcfe;">${prop}</span><span style="color: #808080;">:</span><span style="color: #ce9178;">${rest}</span>`
    }

    return escaped
  })

  return highlightedLines.join('\n')
}

export default function CssInspectorEditor({ selectedElement, initialCss, onCssChange }: Props) {
  const [code, setCode] = useState(initialCss)
  const isEditingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const liveStyleRef = useRef<HTMLStyleElement | null>(null)

  // Sync initialCss when selectedElement changes or when user is not actively typing
  useEffect(() => {
    if (!isEditingRef.current) {
      setCode(initialCss)
    }
  }, [initialCss, selectedElement])

  // Attach/manage live <style> tag in native iframe document
  useEffect(() => {
    if (!selectedElement) return
    const doc = selectedElement.ownerDocument
    if (!doc) return

    let styleTag = doc.getElementById('__live-inspector-rules') as HTMLStyleElement
    if (!styleTag) {
      styleTag = doc.createElement('style')
      styleTag.id = '__live-inspector-rules'
      doc.head.appendChild(styleTag)
    }
    liveStyleRef.current = styleTag
  }, [selectedElement])

  const handleInput = (newText: string) => {
    isEditingRef.current = true
    setCode(newText)
    onCssChange(newText)

    if (!selectedElement) return

    // 1. Update element.style inline attribute cleanly without breaking or corrupting styles
    const elementStyleMatch = newText.match(/element\.style\s*\{([\s\S]*?)\}/)
    if (elementStyleMatch) {
      const inlineBody = elementStyleMatch[1].trim()
      selectedElement.style.cssText = inlineBody
    }

    // 2. Compile any custom/other rules into iframe <style> tag
    if (liveStyleRef.current) {
      const nonElementStyleRules = newText.replace(/element\.style\s*\{[\s\S]*?\}/g, '')
      liveStyleRef.current.textContent = nonElementStyleRules
    }
  }

  const handleBlur = () => {
    isEditingRef.current = false
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const target = e.currentTarget
      const start = target.selectionStart
      const end = target.selectionEnd
      const val = target.value
      const updated = val.substring(0, start) + '  ' + val.substring(end)
      setCode(updated)
      onCssChange(updated)
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2
      }, 0)
    }
  }

  const syncScroll = () => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop
      preRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }

  const sharedCodeStyles: React.CSSProperties = {
    margin: 0,
    padding: '10px',
    border: 'none',
    boxSizing: 'border-box',
    width: '100%',
    height: '100%',
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: '12px',
    lineHeight: '1.5',
    letterSpacing: '0px',
    wordSpacing: '0px',
    textTransform: 'none',
    textIndent: '0px',
    textShadow: 'none',
    tabSize: 2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    overflow: 'auto'
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '260px',
        background: '#121214',
        borderRadius: '6px',
        border: '1px solid #27272a',
        overflow: 'hidden'
      }}
    >
      {/* Syntax Highlighted Background View */}
      <pre
        ref={preRef}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlightCss(code) }}
        style={{
          ...sharedCodeStyles,
          position: 'absolute',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          color: '#9cdcfe'
        }}
      />

      {/* Transparent Editable Overlay */}
      <textarea
        ref={textareaRef}
        value={code}
        onInput={(e) => handleInput((e.target as HTMLTextAreaElement).value)}
        onChange={(e) => handleInput(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        spellCheck={false}
        placeholder="/* Directly edit CSS rules here */"
        style={{
          ...sharedCodeStyles,
          position: 'absolute',
          top: 0,
          left: 0,
          background: 'transparent',
          color: 'transparent',
          caretColor: '#38bdf8',
          outline: 'none',
          resize: 'none'
        }}
      />
    </div>
  )
}
