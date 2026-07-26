/**
 * Lightweight Live Editor Bridge
 * Injected into the canvas iframe to provide:
 * 1. 100% Native Chromium 1:1 Rendering
 * 2. Interaction Mode Toggle ('edit' vs 'interact')
 * 3. Entrance Animation & On-Scroll Element Revealer
 * 4. Direct Inline Text Editing & Element Selection
 * 5. Isolated Shadow-DOM Monotone Mini Action Toolbar (Select Parent, Move, Duplicate, Delete)
 */

export interface SelectedElementInfo {
  tagName: string
  id: string
  className: string
  innerText: string
  innerHTML: string
  attributes: Record<string, string>
  styles: {
    color: string
    backgroundColor: string
    fontSize: string
    fontWeight: string
    fontFamily: string
    display: string
    margin: string
    padding: string
  }
}

export interface LiveEditorOptions {
  mode?: 'edit' | 'interact'
  revealAnimations?: boolean
  onSelect: (info: SelectedElementInfo | null, el: HTMLElement | null) => void
  onChange: () => void
}

export function attachLiveEditor(
  doc: Document,
  options: LiveEditorOptions
): { cleanup: () => void; updateOptions: (newOpts: Partial<LiveEditorOptions>) => void; setPaused: (p: boolean) => void; selectElement: (el: HTMLElement) => void } {
  let mode = options.mode || 'edit'
  let revealAnimations = options.revealAnimations ?? true
  let selectedEl: HTMLElement | null = null
  let hoverEl: HTMLElement | null = null

  // Inject editor highlight style into Document <head>
  const style = doc.createElement('style')
  style.id = 'live-editor-overlay-style'
  style.textContent = `
    [data-live-hover="true"]:not([data-live-selected="true"]) {
      outline: 1.5px dashed #3b82f6 !important;
      outline-offset: -1px !important;
      cursor: pointer !important;
    }
    [data-live-selected="true"] {
      outline: 2px solid #2563eb !important;
      outline-offset: -1px !important;
    }
    [contenteditable="true"] {
      outline: 2px solid #10b981 !important;
      cursor: text !important;
    }
  `
  doc.head.appendChild(style)

  // Inject animation revealer style block
  const animStyle = doc.createElement('style')
  animStyle.id = 'live-editor-anim-reveal-style'
  const updateAnimStyle = (active: boolean) => {
    animStyle.textContent = active ? `
      [data-aos], .elementor-invisible, .wow, .animated, [data-sal], .has-animation,
      .elementor-element[data-settings*="animation"], [class*="elementor-animation-"],
      [class*="animate-"], [style*="opacity: 0"], [style*="opacity:0"],
      [style*="visibility: hidden"], [style*="visibility:hidden"] {
        opacity: 1 !important;
        transform: none !important;
        visibility: visible !important;
        animation: none !important;
        transition: none !important;
      }
    ` : ''
  }
  updateAnimStyle(revealAnimations)
  doc.head.appendChild(animStyle)

  // Shadow DOM Host for Mini Toolbar — completely isolated from page CSS
  let hostEl: HTMLElement | null = null
  let shadowRoot: ShadowRoot | null = null

  const removeToolbar = () => {
    if (hostEl) {
      hostEl.remove()
      hostEl = null
      shadowRoot = null
    }
  }

  const positionToolbar = () => {
    if (!hostEl || !selectedEl || !doc.body.contains(selectedEl)) {
      removeToolbar()
      return
    }
    const rect = selectedEl.getBoundingClientRect()
    const scrollX = doc.defaultView?.scrollX || 0
    const scrollY = doc.defaultView?.scrollY || 0
    let top = rect.top + scrollY - 36
    if (top < scrollY) top = rect.bottom + scrollY + 6
    let left = rect.left + scrollX
    hostEl.style.top = `${top}px`
    hostEl.style.left = `${left}px`
  }

  const renderToolbar = (el: HTMLElement) => {
    removeToolbar()
    if (mode === 'interact') return

    // Host element
    const host = doc.createElement('div')
    host.id = 'live-mini-toolbar-host'
    host.style.cssText = 'position:absolute;z-index:999999;pointer-events:auto;user-select:none;'
    
    // Attach Shadow Root for 100% CSS Isolation
    const shadow = host.attachShadow({ mode: 'open' })

    const shadowStyle = doc.createElement('style')
    shadowStyle.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .toolbar-bar {
        display: flex;
        align-items: center;
        gap: 3px;
        background: #18181b;
        border: 1px solid #3f3f46;
        border-radius: 6px;
        padding: 3px 6px;
        box-shadow: 0 8px 20px rgba(0,0,0,0.6);
        box-sizing: border-box;
      }
      .toolbar-tag {
        font-size: 10px;
        font-weight: 700;
        color: #10b981;
        padding: 0 4px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        line-height: 1;
      }
      .toolbar-divider {
        width: 1px;
        height: 14px;
        background: #3f3f46;
        margin: 0 2px;
      }
      .toolbar-btn {
        all: unset;
        background: transparent !important;
        border: none !important;
        border-radius: 4px !important;
        color: #a1a1aa !important;
        width: 26px !important;
        height: 26px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        padding: 0 !important;
        margin: 0 !important;
        box-shadow: none !important;
        transition: background 0.15s, color 0.15s;
        box-sizing: border-box;
      }
      .toolbar-btn:hover {
        background: #27272a !important;
        color: #f4f4f5 !important;
      }
      .toolbar-btn-danger:hover {
        background: #7f1d1d !important;
        color: #fca5a5 !important;
      }
      .toolbar-btn svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
    `
    shadow.appendChild(shadowStyle)

    const bar = doc.createElement('div')
    bar.className = 'toolbar-bar'

    const tagLabel = doc.createElement('span')
    tagLabel.className = 'toolbar-tag'
    tagLabel.textContent = el.tagName.toLowerCase()
    bar.appendChild(tagLabel)

    const div1 = doc.createElement('div')
    div1.className = 'toolbar-divider'
    bar.appendChild(div1)

    // 1. Select Parent ⬆
    const parentBtn = doc.createElement('button')
    parentBtn.className = 'toolbar-btn'
    parentBtn.title = 'Select Parent Element'
    parentBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
    parentBtn.onclick = (e) => {
      e.stopPropagation()
      if (el.parentElement && el.parentElement !== doc.body) {
        selectElement(el.parentElement)
      }
    }
    bar.appendChild(parentBtn)

    // 2. Move Up ⬆
    const moveUpBtn = doc.createElement('button')
    moveUpBtn.className = 'toolbar-btn'
    moveUpBtn.title = 'Move Element Up'
    moveUpBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>'
    moveUpBtn.onclick = (e) => {
      e.stopPropagation()
      if (el.previousElementSibling) {
        el.parentElement?.insertBefore(el, el.previousElementSibling)
        positionToolbar()
        options.onChange()
      }
    }
    bar.appendChild(moveUpBtn)

    // 3. Move Down ⬇
    const moveDownBtn = doc.createElement('button')
    moveDownBtn.className = 'toolbar-btn'
    moveDownBtn.title = 'Move Element Down'
    moveDownBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>'
    moveDownBtn.onclick = (e) => {
      e.stopPropagation()
      if (el.nextElementSibling) {
        el.parentElement?.insertBefore(el.nextElementSibling, el)
        positionToolbar()
        options.onChange()
      }
    }
    bar.appendChild(moveDownBtn)

    // 4. Duplicate 📋
    const dupBtn = doc.createElement('button')
    dupBtn.className = 'toolbar-btn'
    dupBtn.title = 'Duplicate Element'
    dupBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
    dupBtn.onclick = (e) => {
      e.stopPropagation()
      const clone = el.cloneNode(true) as HTMLElement
      clone.removeAttribute('data-live-selected')
      clone.removeAttribute('data-live-hover')
      el.parentElement?.insertBefore(clone, el.nextElementSibling)
      selectElement(clone)
      options.onChange()
    }
    bar.appendChild(dupBtn)

    // 5. Delete 🗑
    const delBtn = doc.createElement('button')
    delBtn.className = 'toolbar-btn toolbar-btn-danger'
    delBtn.title = 'Delete Element'
    delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    delBtn.onclick = (e) => {
      e.stopPropagation()
      removeToolbar()
      el.remove()
      options.onSelect(null, null)
      options.onChange()
    }
    bar.appendChild(delBtn)

    shadow.appendChild(bar)
    doc.body.appendChild(host)
    hostEl = host
    shadowRoot = shadow
    positionToolbar()
  }

  const extractInfo = (el: HTMLElement): SelectedElementInfo => {
    const cs = doc.defaultView?.getComputedStyle(el)
    const attrs: Record<string, string> = {}
    Array.from(el.attributes).forEach((a) => {
      if (!a.name.startsWith('data-live-')) {
        attrs[a.name] = a.value
      }
    })

    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: el.className || '',
      innerText: el.innerText || '',
      innerHTML: el.innerHTML || '',
      attributes: attrs,
      styles: {
        color: cs?.color || '',
        backgroundColor: cs?.backgroundColor || '',
        fontSize: cs?.fontSize || '',
        fontWeight: cs?.fontWeight || '',
        fontFamily: cs?.fontFamily || '',
        display: cs?.display || '',
        margin: cs?.margin || '',
        padding: cs?.padding || ''
      }
    }
  }

  const selectElement = (target: HTMLElement) => {
    if (selectedEl && selectedEl !== target) {
      selectedEl.removeAttribute('data-live-selected')
      selectedEl.removeAttribute('contenteditable')
    }

    selectedEl = target
    selectedEl.setAttribute('data-live-selected', 'true')

    if (selectedEl.children.length === 0 || selectedEl.tagName.match(/^(P|H[1-6]|SPAN|A|BUTTON|LI|LABEL|TD|TH)$/i)) {
      selectedEl.setAttribute('contenteditable', 'true')
    }

    renderToolbar(selectedEl)
    options.onSelect(extractInfo(selectedEl), selectedEl)
  }

  const handleMouseOver = (e: MouseEvent) => {
    if (mode === 'interact' || paused) return
    const target = e.target as HTMLElement
    if (!target || target === doc.body || target === doc.documentElement || target.id === 'live-mini-toolbar-host' || target.closest('#live-mini-toolbar-host')) return
    if (hoverEl && hoverEl !== target) {
      hoverEl.removeAttribute('data-live-hover')
    }
    hoverEl = target
    hoverEl.setAttribute('data-live-hover', 'true')
  }

  const handleMouseOut = (e: MouseEvent) => {
    if (mode === 'interact' || paused) return
    const target = e.target as HTMLElement
    if (target) target.removeAttribute('data-live-hover')
  }

  const handleClick = (e: MouseEvent) => {
    if (mode === 'interact' || paused) return
    const target = e.target as HTMLElement
    if (!target || target === doc.body || target === doc.documentElement || target.id === 'live-mini-toolbar-host' || target.closest('#live-mini-toolbar-host')) return
    e.preventDefault()
    e.stopPropagation()

    selectElement(target)
  }

  const handleInput = () => {
    options.onChange()
  }

  const handleScroll = () => {
    positionToolbar()
  }

  doc.addEventListener('mouseover', handleMouseOver, true)
  doc.addEventListener('mouseout', handleMouseOut, true)
  doc.addEventListener('click', handleClick, true)
  doc.addEventListener('input', handleInput, true)
  doc.defaultView?.addEventListener('scroll', handleScroll, true)

  const cleanup = () => {
    doc.removeEventListener('mouseover', handleMouseOver, true)
    doc.removeEventListener('mouseout', handleMouseOut, true)
    doc.removeEventListener('click', handleClick, true)
    doc.removeEventListener('input', handleInput, true)
    doc.defaultView?.removeEventListener('scroll', handleScroll, true)
    style.remove()
    animStyle.remove()
    removeToolbar()
    if (selectedEl) {
      selectedEl.removeAttribute('data-live-selected')
      selectedEl.removeAttribute('contenteditable')
    }
    if (hoverEl) {
      hoverEl.removeAttribute('data-live-hover')
    }
  }

  const updateOptions = (newOpts: Partial<LiveEditorOptions>) => {
    if (newOpts.mode !== undefined) {
      mode = newOpts.mode
      if (mode === 'interact') {
        removeToolbar()
        if (selectedEl) {
          selectedEl.removeAttribute('data-live-selected')
          selectedEl.removeAttribute('contenteditable')
        }
        if (hoverEl) {
          hoverEl.removeAttribute('data-live-hover')
        }
      }
    }
    if (newOpts.revealAnimations !== undefined) {
      revealAnimations = newOpts.revealAnimations
      updateAnimStyle(revealAnimations)
    }
  }

  let paused = false
  const setPaused = (p: boolean) => {
    paused = p
    if (p && hoverEl) {
      hoverEl.removeAttribute('data-live-hover')
      hoverEl = null
    }
  }

  const selectElementExternally = (el: HTMLElement) => {
    selectElement(el)
  }

  return { cleanup, updateOptions, setPaused, selectElement: selectElementExternally }
}
