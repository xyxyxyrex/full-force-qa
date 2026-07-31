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
  zoom?: number
  onSelect: (info: SelectedElementInfo | null, el: HTMLElement | null) => void
  onChange: () => void
}

export function attachLiveEditor(
  doc: Document,
  options: LiveEditorOptions
): { cleanup: () => void; updateOptions: (newOpts: Partial<LiveEditorOptions>) => void; setPaused: (p: boolean) => void; selectElement: (el: HTMLElement) => void; setZoom: (z: number) => void } {
  let mode = options.mode || 'edit'
  let revealAnimations = options.revealAnimations ?? true
  let currentZoom = options.zoom || 100
  let selectedEl: HTMLElement | null = null
  let hoverEl: HTMLElement | null = null
  let toolbarOffsetX = 0
  let toolbarOffsetY = 0

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

  // Shadow DOM Host for Mini Toolbar & Transform Handles — completely isolated from page CSS
  let hostEl: HTMLElement | null = null
  let shadowRoot: ShadowRoot | null = null
  let barEl: HTMLElement | null = null
  let boxEl: HTMLElement | null = null
  let dimBadgeEl: HTMLElement | null = null

  const removeToolbar = () => {
    if (hostEl) {
      hostEl.remove()
      hostEl = null
      shadowRoot = null
      barEl = null
      boxEl = null
      dimBadgeEl = null
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
    const invScale = 100 / Math.max(1, currentZoom)

    // 1. Position Action Bar above the element with drag offset
    let barTop = rect.top + scrollY - 38 + toolbarOffsetY
    if (barTop < scrollY && toolbarOffsetY === 0) barTop = rect.bottom + scrollY + 8
    let barLeft = rect.left + scrollX + toolbarOffsetX

    if (barEl) {
      barEl.style.top = `${barTop}px`
      barEl.style.left = `${barLeft}px`
      barEl.style.transform = `scale(${invScale})`
      barEl.style.transformOrigin = 'bottom left'
    }

    // 2. Position Bounding Box & Transform Handles directly over element
    if (boxEl) {
      boxEl.style.top = `${rect.top + scrollY}px`
      boxEl.style.left = `${rect.left + scrollX}px`
      boxEl.style.width = `${Math.max(1, rect.width)}px`
      boxEl.style.height = `${Math.max(1, rect.height)}px`

      const handles = boxEl.querySelectorAll<HTMLElement>('.handle')
      handles.forEach((h) => {
        h.style.transform = `scale(${invScale})`
      })
    }

    // 3. Update Live Dimension Badge (counter-scaled)
    if (dimBadgeEl) {
      dimBadgeEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} px`
      dimBadgeEl.style.transform = `scale(${invScale})`
      dimBadgeEl.style.transformOrigin = 'bottom right'
    }
  }

  const renderToolbar = (el: HTMLElement) => {
    removeToolbar()
    if (mode === 'interact') return

    // Host element (positioned at 0,0 of page document)
    const host = doc.createElement('div')
    host.id = 'live-mini-toolbar-host'
    host.style.cssText = 'position:absolute;top:0;left:0;z-index:999999;pointer-events:none;user-select:none;'
    
    // Attach Shadow Root for 100% CSS Isolation
    const shadow = host.attachShadow({ mode: 'open' })

    const shadowStyle = doc.createElement('style')
    shadowStyle.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .toolbar-bar {
        position: absolute;
        display: flex;
        align-items: center;
        gap: 3px;
        background: #18181b;
        border: 1px solid #3f3f46;
        border-radius: 6px;
        padding: 3px 6px;
        box-shadow: 0 8px 20px rgba(0,0,0,0.6);
        box-sizing: border-box;
        pointer-events: auto;
        z-index: 20;
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

      /* ── Transform Bounding Box & Handles ── */
      .transform-box {
        position: absolute;
        border: 1.5px solid #2563eb;
        pointer-events: none;
        box-sizing: border-box;
        z-index: 10;
      }

      .handle {
        position: absolute;
        width: 9px;
        height: 9px;
        background: #ffffff;
        border: 1.5px solid #2563eb;
        border-radius: 2px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        pointer-events: auto;
        box-sizing: border-box;
        z-index: 15;
      }
      .handle:hover {
        background: #2563eb;
        transform: scale(1.25);
      }

      .handle-nw { top: -5px; left: -5px; cursor: nwse-resize; }
      .handle-n  { top: -5px; left: calc(50% - 4px); cursor: ns-resize; }
      .handle-ne { top: -5px; right: -5px; cursor: nesw-resize; }
      .handle-e  { top: calc(50% - 4px); right: -5px; cursor: ew-resize; }
      .handle-se { bottom: -5px; right: -5px; cursor: nwse-resize; }
      .handle-s  { bottom: -5px; left: calc(50% - 4px); cursor: ns-resize; }
      .handle-sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
      .handle-w  { top: calc(50% - 4px); left: -5px; cursor: ew-resize; }

      .dim-badge {
        position: absolute;
        bottom: -24px;
        right: 8px;
        background: #18181b;
        color: #10b981;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
        border: 1px solid #3f3f46;
        box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        pointer-events: none;
        white-space: nowrap;
        font-family: inherit;
        z-index: 15;
      }
    `
    shadow.appendChild(shadowStyle)

    // Bounding Box Container
    const box = doc.createElement('div')
    box.className = 'transform-box'

    // Live Dimension Pill Badge
    const dimBadge = doc.createElement('div')
    dimBadge.className = 'dim-badge'
    box.appendChild(dimBadge)
    dimBadgeEl = dimBadge

    // 8-Point Transform Handles (NW, N, NE, E, SE, S, SW, W)
    const handleDirs = [
      { name: 'nw', dir: 'nw' },
      { name: 'n',  dir: 'n'  },
      { name: 'ne', dir: 'ne' },
      { name: 'e',  dir: 'e'  },
      { name: 'se', dir: 'se' },
      { name: 's',  dir: 's'  },
      { name: 'sw', dir: 'sw' },
      { name: 'w',  dir: 'w'  }
    ]

    handleDirs.forEach(({ name, dir }) => {
      const hEl = doc.createElement('div')
      hEl.className = `handle handle-${name}`
      hEl.title = `Drag to resize container (${dir.toUpperCase()})`

      hEl.onmousedown = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const startX = e.clientX
        const startY = e.clientY
        const startRect = el.getBoundingClientRect()
        const startW = startRect.width
        const startH = startRect.height

        const onMouseMove = (ev: MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          const dx = ev.clientX - startX
          const dy = ev.clientY - startY

          let newW = startW
          let newH = startH

          if (dir.includes('e')) newW = Math.max(10, startW + dx)
          if (dir.includes('w')) newW = Math.max(10, startW - dx)
          if (dir.includes('s')) newH = Math.max(10, startH + dy)
          if (dir.includes('n')) newH = Math.max(10, startH - dy)

          if (dir.includes('e') || dir.includes('w')) {
            el.style.setProperty('width', `${Math.round(newW)}px`, 'important')
            el.style.setProperty('max-width', 'none', 'important')
          }
          if (dir.includes('s') || dir.includes('n')) {
            el.style.setProperty('height', `${Math.round(newH)}px`, 'important')
            el.style.setProperty('max-height', 'none', 'important')
          }

          positionToolbar()
          options.onSelect(extractInfo(el), el)
        }

        const onMouseUp = (ev: MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
          doc.removeEventListener('mousemove', onMouseMove, true)
          doc.removeEventListener('mouseup', onMouseUp, true)
          options.onChange()
        }

        doc.addEventListener('mousemove', onMouseMove, true)
        doc.addEventListener('mouseup', onMouseUp, true)
      }

      box.appendChild(hEl)
    })

    shadow.appendChild(box)
    boxEl = box

    // Action Toolbar Bar
    const bar = doc.createElement('div')
    bar.className = 'toolbar-bar'

    // Tag Label Badge (draggable to move mini toolbar overlay)
    const tagLabel = doc.createElement('span')
    tagLabel.className = 'toolbar-tag'
    tagLabel.textContent = el.tagName.toLowerCase()
    tagLabel.title = 'Click and drag tag label to move this mini toolbar overlay'
    tagLabel.style.cursor = 'grab'
    bar.appendChild(tagLabel)

    // Move / Drag Handle (6-dot SVG grip icon to drag/reorder element inside page)
    const dragBtn = doc.createElement('button')
    dragBtn.className = 'toolbar-btn'
    dragBtn.title = 'Click and drag to reposition element inside page'
    dragBtn.style.cursor = 'grab'
    dragBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="6" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/></svg>'
    bar.appendChild(dragBtn)

    // ── Drag & Drop reordering logic ──
    let dropTarget: { el: HTMLElement; position: 'before' | 'after' } | null = null

    const handleDragStart = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const draggedEl = el
      doc.body.style.cursor = 'grabbing'
      dragBtn.style.cursor = 'grabbing'

      let dropLine = doc.getElementById('live-drop-indicator') as HTMLElement
      if (!dropLine) {
        dropLine = doc.createElement('div')
        dropLine.id = 'live-drop-indicator'
        dropLine.style.cssText = 'position:absolute;z-index:999999;background:#2563eb;box-shadow:0 0 10px #2563eb;pointer-events:none;display:none;border-radius:2px;transition:all 0.04s ease;'
        
        const dot1 = doc.createElement('div')
        dot1.className = 'drop-dot-1'
        dot1.style.cssText = 'position:absolute;width:10px;height:10px;background:#2563eb;border-radius:50%;box-shadow:0 0 6px #2563eb;'
        
        const dot2 = doc.createElement('div')
        dot2.className = 'drop-dot-2'
        dot2.style.cssText = 'position:absolute;width:10px;height:10px;background:#2563eb;border-radius:50%;box-shadow:0 0 6px #2563eb;'
        
        dropLine.appendChild(dot1)
        dropLine.appendChild(dot2)
        doc.body.appendChild(dropLine)
      }
      dropLine.style.display = 'block'

      const onMouseMove = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()

        const hoverTarget = doc.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
        if (
          !hoverTarget ||
          hoverTarget === doc.body ||
          hoverTarget === doc.documentElement ||
          hoverTarget === draggedEl ||
          draggedEl.contains(hoverTarget) ||
          hoverTarget.id === 'live-mini-toolbar-host' ||
          hoverTarget.closest('#live-mini-toolbar-host')
        ) {
          dropLine.style.display = 'none'
          dropTarget = null
          return
        }

        const cs = doc.defaultView?.getComputedStyle(hoverTarget)
        const parentCs = hoverTarget.parentElement ? doc.defaultView?.getComputedStyle(hoverTarget.parentElement) : null

        const isRowFlex = parentCs && parentCs.display.includes('flex') && parentCs.flexDirection.includes('row')
        const isInline = cs && (cs.display.includes('inline') || cs.display.includes('grid'))
        const prev = hoverTarget.previousElementSibling as HTMLElement | null
        const isSideBySide = prev ? Math.abs(hoverTarget.getBoundingClientRect().top - prev.getBoundingClientRect().top) < 15 : false
        const isHorizontal = isRowFlex || isInline || isSideBySide

        const rect = hoverTarget.getBoundingClientRect()
        const scrollX = doc.defaultView?.scrollX || 0
        const scrollY = doc.defaultView?.scrollY || 0

        const dot1 = dropLine.querySelector('.drop-dot-1') as HTMLElement
        const dot2 = dropLine.querySelector('.drop-dot-2') as HTMLElement

        if (isHorizontal) {
          const midX = rect.left + rect.width / 2
          const isLeft = ev.clientX < midX
          dropTarget = { el: hoverTarget, position: isLeft ? 'before' : 'after' }

          const lineX = isLeft ? rect.left + scrollX - 1.5 : rect.right + scrollX - 1.5
          dropLine.style.display = 'block'
          dropLine.style.width = '3px'
          dropLine.style.height = `${Math.max(16, rect.height)}px`
          dropLine.style.left = `${lineX}px`
          dropLine.style.top = `${rect.top + scrollY}px`

          if (dot1) { dot1.style.top = '-4px'; dot1.style.left = '-3.5px'; dot1.style.bottom = 'auto'; dot1.style.right = 'auto'; }
          if (dot2) { dot2.style.bottom = '-4px'; dot2.style.left = '-3.5px'; dot2.style.top = 'auto'; dot2.style.right = 'auto'; }
        } else {
          const midY = rect.top + rect.height / 2
          const isBefore = ev.clientY < midY
          dropTarget = { el: hoverTarget, position: isBefore ? 'before' : 'after' }

          const lineY = isBefore ? rect.top + scrollY - 1.5 : rect.bottom + scrollY - 1.5
          dropLine.style.display = 'block'
          dropLine.style.width = `${Math.max(20, rect.width)}px`
          dropLine.style.height = '3px'
          dropLine.style.left = `${rect.left + scrollX}px`
          dropLine.style.top = `${lineY}px`

          if (dot1) { dot1.style.left = '-4px'; dot1.style.top = '-3.5px'; dot1.style.right = 'auto'; dot1.style.bottom = 'auto'; }
          if (dot2) { dot2.style.right = '-4px'; dot2.style.top = '-3.5px'; dot2.style.left = 'auto'; dot2.style.bottom = 'auto'; }
        }
      }

      const onMouseUp = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()

        doc.body.style.cursor = ''
        dragBtn.style.cursor = 'grab'

        if (dropLine) dropLine.style.display = 'none'

        doc.removeEventListener('mousemove', onMouseMove, true)
        doc.removeEventListener('mouseup', onMouseUp, true)

        if (dropTarget && dropTarget.el && draggedEl.parentElement) {
          const { el: targetEl, position } = dropTarget
          if (position === 'before') {
            targetEl.parentElement?.insertBefore(draggedEl, targetEl)
          } else {
            targetEl.parentElement?.insertBefore(draggedEl, targetEl.nextElementSibling)
          }
          positionToolbar()
          options.onSelect(extractInfo(draggedEl), draggedEl)
          options.onChange()
        }

        dropTarget = null
      }

      doc.addEventListener('mousemove', onMouseMove, true)
      doc.addEventListener('mouseup', onMouseUp, true)
    }

    // Drag mini toolbar overlay itself
    const handleToolbarMove = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const startX = e.clientX
      const startY = e.clientY
      const startOffsetX = toolbarOffsetX
      const startOffsetY = toolbarOffsetY

      doc.body.style.cursor = 'grabbing'
      tagLabel.style.cursor = 'grabbing'

      const onMouseMove = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
        const scaleFactor = Math.max(0.1, currentZoom / 100)
        toolbarOffsetX = startOffsetX + (ev.clientX - startX) / scaleFactor
        toolbarOffsetY = startOffsetY + (ev.clientY - startY) / scaleFactor
        positionToolbar()
      }

      const onMouseUp = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
        doc.body.style.cursor = ''
        tagLabel.style.cursor = 'grab'
        doc.removeEventListener('mousemove', onMouseMove, true)
        doc.removeEventListener('mouseup', onMouseUp, true)
      }

      doc.addEventListener('mousemove', onMouseMove, true)
      doc.addEventListener('mouseup', onMouseUp, true)
    }

    tagLabel.onmousedown = handleToolbarMove
    dragBtn.onmousedown = handleDragStart

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
    barEl = bar

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

  // ── Helper: Check and dismiss cookie/privacy consent banners on click ──
  const handleCookieDismiss = (target: HTMLElement): boolean => {
    const cookieContainer = target.closest(
      '[class*="cookie"], [class*="consent"], [class*="gdpr"], [class*="privacy"], [id*="cookie"], [id*="consent"], [id*="gdpr"], .cky-consent-container, #cn-accept-cookie, .cmplz-cookiebanner'
    ) as HTMLElement | null

    if (cookieContainer) {
      cookieContainer.style.setProperty('display', 'none', 'important')
      options.onChange()
      return true
    }
    return false
  }

  // ── Helper: Universal Accordion & FAQ Reveal Engine ──
  const handleAccordionToggle = (target: HTMLElement): boolean => {
    // 1. Check if clicked target or any parent has a hash link (#collapse-123) or data-target/aria-controls
    const linkEl = (target.closest('a[href*="#"], [data-target], [data-bs-target], [aria-controls]') || target.closest('a, button, [role="button"]')) as HTMLElement | null
    let targetContentId = ''

    if (linkEl) {
      const href = linkEl.getAttribute('href') || ''
      const hashMatch = href.match(/#([a-zA-Z0-9-_]+)/)
      if (hashMatch && hashMatch[1] && !hashMatch[1].startsWith('elementor-action')) {
        targetContentId = hashMatch[1]
      }
      if (!targetContentId) {
        targetContentId = linkEl.getAttribute('data-target') || linkEl.getAttribute('data-bs-target') || linkEl.getAttribute('aria-controls') || ''
        targetContentId = targetContentId.replace(/^#/, '')
      }
    }

    // 2. Find toggler element (header / button / link)
    const toggler = (target.closest(
      '.ekit-accordion--toggler, .elementskit-btn-link, .elementskit-accordion-header, .elementor-accordion-title, .elementor-tab-title, .accordion-header, .accordion-title, [role="tab"], .faq-title, .toggle-title, summary'
    ) || linkEl) as HTMLElement | null

    if (!toggler && !targetContentId) return false

    // 3. Find item container (for context only — ALWAYS ensure outer card remains 100% visible)
    const item = target.closest(
      '.elementskit-card, .ekit-accordion-item, .elementskit-accordion-item, .elementor-accordion-item, .accordion-item, .card, .faq-item, .toggle-item, details'
    ) as HTMLElement | null

    if (item) {
      item.style.setProperty('display', 'block', 'important')
      item.style.setProperty('opacity', '1', 'important')
      item.style.setProperty('visibility', 'visible', 'important')
    }

    // 4. Gather ALL candidate content elements (ID match, card query, next sibling)
    const candidateMap = new Set<HTMLElement>()

    if (targetContentId) {
      try {
        const byId = doc.getElementById(targetContentId) || doc.querySelector(`#${CSS.escape(targetContentId)}`)
        if (byId && byId !== toggler) candidateMap.add(byId as HTMLElement)
      } catch {}
    }

    if (item) {
      const bodyEls = item.querySelectorAll<HTMLElement>(
        '.elementskit-card-body, .ekit-accordion-content, .elementskit-accordion-content, .elementor-tab-content, .accordion-body, .accordion-content, [role="tabpanel"], .faq-content, .faq-answer, .toggle-content, .collapse, [class*="card-body"], [class*="accordion-content"]'
      )
      bodyEls.forEach((b) => {
        if (b !== toggler) candidateMap.add(b)
      })
    }

    if (toggler) {
      if (toggler.nextElementSibling && toggler.nextElementSibling !== toggler) {
        candidateMap.add(toggler.nextElementSibling as HTMLElement)
      }
      if (toggler.parentElement && toggler.parentElement.nextElementSibling && toggler.parentElement.nextElementSibling !== toggler) {
        candidateMap.add(toggler.parentElement.nextElementSibling as HTMLElement)
      }
    }

    const contents = Array.from(candidateMap)
    if (contents.length === 0) return false

    // Check if currently hidden (collapsed)
    const isHidden =
      contents.some((c) => {
        const comp = doc.defaultView?.getComputedStyle(c)
        return (
          comp?.display === 'none' ||
          c.style.display === 'none' ||
          comp?.height === '0px' ||
          c.style.height === '0px' ||
          c.hasAttribute('hidden') ||
          (c.classList.contains('collapse') && !c.classList.contains('show'))
        )
      }) ||
      linkEl?.classList.contains('collapsed') ||
      toggler?.classList.contains('collapsed')

    if (isHidden) {
      // Expand ALL candidate content panels
      contents.forEach((c) => {
        c.style.setProperty('display', 'block', 'important')
        c.style.setProperty('height', 'auto', 'important')
        c.style.setProperty('max-height', 'none', 'important')
        c.style.setProperty('opacity', '1', 'important')
        c.style.setProperty('visibility', 'visible', 'important')
        c.removeAttribute('hidden')
        c.classList.add('show', 'in', 'open', 'is-open', 'active')
        c.classList.remove('collapse')

        const descendants = c.querySelectorAll<HTMLElement>('*')
        descendants.forEach((child) => {
          const childComp = doc.defaultView?.getComputedStyle(child)
          if (childComp?.display === 'none' || child.style.display === 'none') {
            child.style.setProperty('display', 'block', 'important')
          }
          if (childComp?.height === '0px' || child.style.height === '0px') {
            child.style.setProperty('height', 'auto', 'important')
          }
          child.style.setProperty('opacity', '1', 'important')
          child.style.setProperty('visibility', 'visible', 'important')
          child.style.setProperty('max-height', 'none', 'important')
        })
      })

      const togglersToUpdate = [toggler, linkEl].filter(Boolean) as HTMLElement[]
      togglersToUpdate.forEach((t) => {
        t.classList.add('elementor-active', 'active')
        t.classList.remove('collapsed')
        t.setAttribute('aria-expanded', 'true')
      })
    } else {
      // Collapse ALL candidate content panels
      contents.forEach((c) => {
        c.style.setProperty('display', 'none', 'important')
        c.style.setProperty('height', '0px', 'important')
        c.style.setProperty('opacity', '0', 'important')
        c.classList.remove('show', 'in', 'open', 'is-open', 'active')
        c.classList.add('collapse')
      })

      const togglersToUpdate = [toggler, linkEl].filter(Boolean) as HTMLElement[]
      togglersToUpdate.forEach((t) => {
        t.classList.remove('elementor-active', 'active')
        t.classList.add('collapsed')
        t.setAttribute('aria-expanded', 'false')
      })
    }

    options.onChange()
    return true

    return false
  }

  // ── Helper: Universal Carousel & Slider Engine (Swiper, Slick, Owl, Elementor Slides) ──
  const handleSliderNavigation = (target: HTMLElement): boolean => {
    const navBtn = target.closest(
      '.swiper-button-next, .swiper-button-prev, .slick-next, .slick-prev, .owl-next, .owl-prev, .swiper-pagination-bullet, .slick-dots li, .owl-dot, [class*="slider-next"], [class*="slider-prev"], [class*="carousel-next"], [class*="carousel-prev"], [class*="pagination-bullet"]'
    ) as HTMLElement | null

    if (!navBtn) return false

    const slider = navBtn.closest(
      '.swiper, .swiper-container, .slick-slider, .owl-carousel, .elementor-slides, .elementor-testimonial-carousel, [class*="slider"], [class*="carousel"]'
    ) as HTMLElement | null

    if (!slider) return false

    const slides = Array.from(
      slider.querySelectorAll(
        '.swiper-slide, .slick-slide, .owl-item, .elementor-slide, [class*="slide-item"], [class*="carousel-item"]'
      )
    ) as HTMLElement[]

    if (slides.length === 0) return false

    // Find current active slide index
    let activeIdx = slides.findIndex(s => s.classList.contains('swiper-slide-active') || s.classList.contains('slick-active') || s.classList.contains('active') || s.style.display !== 'none')
    if (activeIdx < 0) activeIdx = 0

    const btnStr = (navBtn.className + ' ' + navBtn.id + ' ' + (navBtn.getAttribute('aria-label') || '')).toLowerCase()
    const isNext = /next|right|forward/i.test(btnStr)
    const isPrev = /prev|previous|left|back/i.test(btnStr)

    let targetIdx = activeIdx

    if (isNext) {
      targetIdx = (activeIdx + 1) % slides.length
    } else if (isPrev) {
      targetIdx = (activeIdx - 1 + slides.length) % slides.length
    } else {
      const dots = Array.from(navBtn.parentElement?.children || [])
      const dotIdx = dots.indexOf(navBtn)
      if (dotIdx >= 0 && dotIdx < slides.length) {
        targetIdx = dotIdx
      }
    }

    slides.forEach((slide, idx) => {
      if (idx === targetIdx) {
        slide.style.setProperty('display', 'block', 'important')
        slide.style.setProperty('opacity', '1', 'important')
        slide.style.setProperty('visibility', 'visible', 'important')
        slide.classList.add('swiper-slide-active', 'slick-active', 'active')
      } else {
        slide.style.setProperty('display', 'none', 'important')
        slide.classList.remove('swiper-slide-active', 'slick-active', 'active')
      }
    })

    options.onChange()
    return true
  }

  // ── Helper: Universal Tab Switcher Engine (Elementor Tabs, Webflow Tabs, Bootstrap Tabs) ──
  const handleTabSwitch = (target: HTMLElement): boolean => {
    const tabBtn = target.closest(
      '.elementor-tab-title, [role="tab"], .nav-link, [data-tab], [class*="tab-title"], [class*="tab-link"], [class*="tab-btn"]'
    ) as HTMLElement | null

    if (!tabBtn) return false

    const tabContainer = tabBtn.closest(
      '.elementor-tabs, .tabs, .nav-tabs, [role="tablist"], [class*="tabs-wrapper"], [class*="tab-container"]'
    ) as HTMLElement | null

    if (!tabContainer) return false

    const allTabBtns = Array.from(
      tabContainer.querySelectorAll<HTMLElement>('.elementor-tab-title, [role="tab"], .nav-link, [data-tab], [class*="tab-title"], [class*="tab-link"]')
    )
    const allTabPanels = Array.from(
      tabContainer.querySelectorAll<HTMLElement>('.elementor-tab-content, [role="tabpanel"], .tab-pane, [class*="tab-content"], [class*="tab-pane"]')
    )

    const clickedIdx = allTabBtns.indexOf(tabBtn)
    if (clickedIdx >= 0 && allTabPanels.length > 0) {
      allTabBtns.forEach((btn, idx) => {
        if (idx === clickedIdx) {
          btn.classList.add('elementor-active', 'active', 'show')
          btn.setAttribute('aria-selected', 'true')
        } else {
          btn.classList.remove('elementor-active', 'active', 'show')
          btn.setAttribute('aria-selected', 'false')
        }
      })

      allTabPanels.forEach((panel, idx) => {
        if (idx === clickedIdx) {
          panel.style.setProperty('display', 'block', 'important')
          panel.style.setProperty('opacity', '1', 'important')
          panel.style.setProperty('visibility', 'visible', 'important')
          panel.classList.add('elementor-active', 'active', 'show')
        } else {
          panel.style.setProperty('display', 'none', 'important')
          panel.classList.remove('elementor-active', 'active', 'show')
        }
      })

      options.onChange()
      return true
    }

    return false
  }

  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target || target === doc.body || target === doc.documentElement || target.id === 'live-mini-toolbar-host' || target.closest('#live-mini-toolbar-host')) return

    // 1. Check and dismiss cookie/privacy consent window on click (works in both Live and Layout mode!)
    if (handleCookieDismiss(target)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }

    // 2. Intercept link tags to prevent browser redirects
    const anchor = target.closest('a') as HTMLAnchorElement | null

    if (mode === 'interact' || paused) {
      if (anchor) {
        e.preventDefault()
        e.stopPropagation()
      }
      // Toggle FAQ / Reveal-type accordion cards on click in Live mode!
      if (handleAccordionToggle(target)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Switch tabs (Elementor Tabs, Webflow Tabs, Bootstrap Tabs) in Live mode!
      if (handleTabSwitch(target)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Navigate sliders & carousels on click in Live mode!
      if (handleSliderNavigation(target)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      return
    }

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
    if (newOpts.zoom !== undefined) {
      currentZoom = newOpts.zoom
      positionToolbar()
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

  const setZoom = (z: number) => {
    currentZoom = z
    positionToolbar()
  }

  return { cleanup, updateOptions, setPaused, selectElement: selectElementExternally, setZoom }
}
