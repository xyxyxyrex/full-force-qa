import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { Project, SnapshotItem } from '../../../shared/types'
import { initEditor, loadMissingFonts } from '../grapesjs/init'
import { attachLiveEditor } from '../utils/liveEditorBridge'
import type { Editor } from 'grapesjs'
import SeoAuditRightPanel from './SeoAuditRightPanel'
import EditBetaWorkspace from './EditBetaWorkspace'
import type { EditBetaWorkspaceHandle } from './EditBetaWorkspace'
import AutomateWorkspace from './AutomateWorkspace'
import NativeStylePanel from './NativeStylePanel'
import CssInspectorEditor from './CssInspectorEditor'
import { toggleCanvasDuplicates } from '../utils/seoCanvasOverlay'
import figmaIcon from '../assets/figma.png'
import mondayIcon from '../assets/monday-icon-svgrepo-com.svg'
import { fetchMondayTicketsApi, type MondayTicket } from '../utils/mondayApi'
import './EditorWorkspace.css'

const defaultQaSheetData = [
  {
    name: 'QA Tracker',
    color: '#4c8bf5',
    status: 1,
    order: 0,
    column: 14,
    row: 50,
    celldata: [
      // Row 0: Dark Headers
      { r: 0, c: 0, v: { v: 'Page Link', m: 'Page Link', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 1, v: { v: 'Section', m: 'Section', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 2, v: { v: 'Screenshot', m: 'Screenshot', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 3, v: { v: 'Remarks', m: 'Remarks', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 4, v: { v: 'Display', m: 'Display', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 5, v: { v: 'Status', m: 'Status', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 6, v: { v: 'QA Screenshots', m: 'QA Screenshots', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 7, v: { v: 'Reason for Rejection (if applicable)', m: 'Reason for Rejection (if applicable)', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 8, v: { v: 'Screenshot and Remarks (Dev)', m: 'Screenshot and Remarks (Dev)', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },
      { r: 0, c: 9, v: { v: 'Remarks (PM)', m: 'Remarks (PM)', bg: '#1c1c1c', fc: '#ffffff', bl: 1, ht: 0, vt: 0 } },

      // Row 1: Subheader
      { r: 1, c: 0, v: { v: 'QA Notes:', m: 'QA Notes:', bg: '#fff2cc', fc: '#7f6000', bl: 1, it: 1 } }
    ],
    config: {
      merge: {},
      columnlen: {
        0: 160,
        1: 190,
        2: 180,
        3: 290,
        4: 100,
        5: 120,
        6: 160,
        7: 220,
        8: 220,
        9: 160
      }
    }
  }
]

function getGoogleSheetsEmbedUrl(rawUrl: string): string {
  if (!rawUrl) return ''
  let cleaned = rawUrl.trim()
  if (cleaned.includes('docs.google.com/spreadsheets')) {
    // Extract Spreadsheet ID
    const match = cleaned.match(/\/d\/([a-zA-Z0-9-_]+)/)
    const sheetId = match && match[1] ? match[1] : null

    // Extract gid (specific tab ID if present, e.g. #gid=12345)
    let gidParam = ''
    const gidMatch = cleaned.match(/[?&#]gid=([0-9]+)/)
    if (gidMatch && gidMatch[1]) {
      gidParam = `&gid=${gidMatch[1]}`
    }

    if (sheetId) {
      // rm=embedded: Strips top 140px Google title header so bottom worksheet tabs NEVER get pushed down after JS grid load
      // widget=true: Keeps bottom worksheet tab navigation bar active
      // hl=en: Forces English UI language
      cleaned = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?rm=embedded&widget=true&hl=en${gidParam}`
    } else {
      if (!cleaned.includes('rm=')) cleaned += `${cleaned.includes('?') ? '&' : '?'}rm=embedded`
      if (!cleaned.includes('widget=')) cleaned += `&widget=true`
      if (!cleaned.includes('hl=')) cleaned += `&hl=en`
    }
  }
  return cleaned
}

interface Props {
  html: string
  sourceUrl: string
  project?: Project | null
  onReset: () => void
  onNewCapture: () => void
  onPersistHtml?: (html: string) => void
  onThumbnailCaptured?: (dataUrl: string) => void
}

type DevicePreset = 'Desktop' | 'Tablet' | 'Mobile'
type ViewportMode = 'preset' | 'free'
type WorkspaceTab = 'editBeta' | 'layout' | 'live' | 'audit' | 'automate'

interface Guide {
  axis: 'x' | 'y'
  position: number // 0–1 fraction of content width (y) or height (x)
}

export interface HistoryStep {
  id: string
  action: string
  detail?: string
  timestamp: string
  iconType: 'init' | 'add' | 'remove' | 'edit' | 'style' | 'move'
}

interface DevtoolsPreset {
  name: string
  w: number
  h: number
  category?: string
}

function getMinifiedName(tag: string, classes: string[]): string {
  const clsStr = classes.join(' ')
  if (clsStr.includes('elementor-widget-heading')) return 'Heading'
  if (clsStr.includes('elementor-widget-button') || tag === 'button') return 'Button'
  if (clsStr.includes('elementor-widget-image') || tag === 'img') return 'Image'
  if (clsStr.includes('elementor-widget-icon')) return 'Icon'
  if (clsStr.includes('elementor-widget-container')) return 'Widget Box'

  switch (tag) {
    case 'p': return 'Paragraph'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'Heading'
    case 'section': return 'Section'
    case 'header': return 'Header'
    case 'footer': return 'Footer'
    case 'nav': return 'Navigation'
    case 'article': return 'Article'
    case 'aside': return 'Sidebar'
    case 'main': return 'Main'
    case 'form': return 'Form'
    case 'input': case 'textarea': case 'select': return 'Form Input'
    case 'ul': case 'ol': return 'List'
    case 'li': return 'List Item'
    case 'a': return 'Link'
    case 'span': return 'Span'
    case 'img': return 'Image'
    case 'button': return 'Button'
    case 'svg': return 'SVG Icon'
    default: return tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : 'Div'
  }
}

function getVerboseName(tag: string, id: string, classes: string[]): string {
  const cleanClasses = classes.filter((c) => !c.startsWith('gjs-'))
  const parts: string[] = []
  if (tag) parts.push(tag.toLowerCase())
  if (id) parts.push(`#${id}`)
  if (cleanClasses.length > 0) {
    const primaryCls = cleanClasses.slice(0, 2).map((c) => `.${c}`).join('')
    parts.push(primaryCls)
  }
  const result = parts.join('')
  return result || tag || 'element'
}

function findGrapesComponentForNativeEl(wrapper: any, el: HTMLElement): any {
  if (!wrapper || !el) return null

  // 1. Try exact data-npath attribute
  const npath = el.getAttribute('data-npath')
  if (npath) {
    try {
      const found = wrapper.find(`[data-npath="${npath}"]`)?.[0]
      if (found) return found
    } catch {}
  }

  // 2. Try ID
  if (el.id) {
    try {
      const found = wrapper.find(`#${CSS.escape(el.id)}`)?.[0]
      if (found) return found
    } catch {}
  }

  // Calculate sibling index among same-tag siblings in native DOM
  const parentEl = el.parentElement
  const sameTagSiblings = parentEl ? Array.from(parentEl.children).filter(c => c.tagName === el.tagName) : []
  const sameTagIdx = sameTagSiblings.indexOf(el)

  // 3. Try Tag + Classes
  const tag = el.tagName.toLowerCase()
  const classes = Array.from(el.classList).filter(c => c && !c.startsWith('__bd') && !c.startsWith('gjs')).map(c => `.${CSS.escape(c)}`).join('')
  if (classes) {
    try {
      const candidates = wrapper.find(`${tag}${classes}`)
      if (candidates && candidates.length > 0) {
        const text = (el.innerText || '').trim().slice(0, 20)
        if (text) {
          const match = candidates.find((c: any) => {
            const cText = (c.get('content') || '').trim()
            return cText && (cText.includes(text) || text.includes(cText))
          })
          if (match) return match
        }
        const targetIdx = sameTagIdx >= 0 && sameTagIdx < candidates.length ? sameTagIdx : 0
        return candidates[targetIdx]
      }
    } catch {}
  }

  // 4. Try Tag alone with sameTagIdx matching
  try {
    const candidates = wrapper.find(tag)
    if (candidates && candidates.length > 0) {
      const text = (el.innerText || '').trim().slice(0, 20)
      if (text) {
        const match = candidates.find((c: any) => {
          const cText = (c.get('content') || '').trim()
          return cText && (cText.includes(text) || text.includes(cText))
        })
        if (match) return match
      }
      const targetIdx = sameTagIdx >= 0 && sameTagIdx < candidates.length ? sameTagIdx : 0
      return candidates[targetIdx]
    }
  } catch {}

  return null
}

function findNativeElForGrapesComponent(doc: Document, comp: any): HTMLElement | null {
  if (!doc || !comp) return null

  // 1. Try exact data-npath attribute
  const npath = comp.get ? comp.get('attributes')?.['data-npath'] : null
  if (npath) {
    try {
      const found = doc.querySelector(`[data-npath="${npath}"]`) as HTMLElement
      if (found) return found
    } catch {}
  }

  // 2. Try ID
  const attrs = comp.get ? comp.get('attributes') || {} : {}
  if (attrs.id) {
    try {
      const found = doc.getElementById(attrs.id)
      if (found) return found
    } catch {}
  }

  // Get index among same-tag siblings in GrapesJS component tree
  let compIdx = 0
  if (comp.parent) {
    const parent = comp.parent()
    if (parent && parent.components) {
      const sibs: any[] = []
      parent.components().each((c: any) => {
        if (c.get && c.get('tagName') === comp.get('tagName')) {
          sibs.push(c)
        }
      })
      compIdx = Math.max(0, sibs.indexOf(comp))
    }
  }

  // 3. Try Tag + Classes
  const tag = (comp.get('tagName') || 'div').toLowerCase()
  const classes = comp.get('classes')?.toArray()?.map((c: any) => c.get ? c.get('name') : c) || []
  if (classes.length > 0) {
    const sel = `${tag}.${classes.map((c: string) => CSS.escape(c)).join('.')}`
    try {
      const candidates = doc.querySelectorAll(sel)
      if (candidates.length > 0) {
        const targetIdx = compIdx < candidates.length ? compIdx : 0
        return candidates[targetIdx] as HTMLElement
      }
    } catch {}
  }

  // 4. Try Tag alone
  try {
    const candidates = doc.querySelectorAll(tag)
    if (candidates.length > 0) {
      const targetIdx = compIdx < candidates.length ? compIdx : 0
      return candidates[targetIdx] as HTMLElement
    }
  } catch {}

  return null
}

function updateLayersDisplayMode(editor: any, mode: 'minified' | 'verbose') {
  if (!editor) return
  const wrapper = editor.getWrapper()
  if (!wrapper) return

  const processComponent = (comp: any, depth = 0) => {
    const tag = (comp.get('tagName') || 'div').toLowerCase()
    const classes = comp.get('classes')?.toArray()?.map((c: any) => c.get ? c.get('name') : c) || []
    const id = comp.get('attributes')?.id || ''

    if (mode === 'minified') {
      comp.set('custom-name', getMinifiedName(tag, classes))
    } else {
      comp.set('custom-name', getVerboseName(tag, id, classes))
    }

    // Ensure element is visible in LayerManager
    comp.set('layerable', true)

    // Auto-expand top-level structural containers (main, header, section, wrapper)
    if (depth <= 2 || ['main', 'header', 'section', 'body', 'wrapper', 'article'].includes(tag) || id.includes('page') || id.includes('main')) {
      comp.set('open', true)
    }

    if (comp.components) {
      comp.components().each((child: any) => processComponent(child, depth + 1))
    }
  }

  processComponent(wrapper, 0)

  try {
    const lm = editor.LayerManager
    if (lm && lm.render) {
      lm.render()
    }
  } catch {}
}

const PRESETS: Record<DevicePreset, { w: number; h: number; label: string }> = {
  Desktop: { w: 1920, h: 1200, label: '1920×1200' },
  Tablet:  { w: 1199, h: 768,  label: '1199×768' },
  Mobile:  { w: 329,  h: 767,  label: '329×767' }
}

const DEVTOOLS_PRESETS: DevtoolsPreset[] = [
  { name: 'Desktop (1920×1200)', w: 1920, h: 1200, category: 'Standard' },
  { name: 'Laptop (1440×900)', w: 1440, h: 900, category: 'Standard' },
  { name: 'Tablet (1199×768)', w: 1199, h: 768, category: 'Standard' },
  { name: 'Mobile (329×767)', w: 329, h: 767, category: 'Standard' },
  { name: 'iPhone SE', w: 375, h: 667 },
  { name: 'iPhone XR', w: 414, h: 896 },
  { name: 'iPhone 12 Pro', w: 390, h: 844 },
  { name: 'iPhone 14 Pro Max', w: 430, h: 932 },
  { name: 'Pixel 7', w: 412, h: 915 },
  { name: 'Samsung Galaxy S8+', w: 360, h: 740 },
  { name: 'Samsung Galaxy S20 Ultra', w: 412, h: 915 },
  { name: 'iPad Mini', w: 768, h: 1024 },
  { name: 'iPad Air', w: 820, h: 1180 },
  { name: 'iPad Pro', w: 1024, h: 1366 },
  { name: 'Surface Pro 7', w: 912, h: 1368 },
  { name: 'Surface Duo', w: 540, h: 720 },
  { name: 'Galaxy Z Fold 5', w: 344, h: 882 },
  { name: 'Asus Zenbook Fold', w: 853, h: 1280 },
  { name: 'Samsung Galaxy A51/71', w: 412, h: 914 },
  { name: 'Nest Hub', w: 1024, h: 600 },
  { name: 'Nest Hub Max', w: 1280, h: 800 }
]

const ZOOM_MIN = 25
const ZOOM_MAX = 200
const ZOOM_STEP = 10

function serializeWorkspaceHtml(doc: Document): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement
  const hadColorHighlightOverlay = !!root.querySelector('#__color-highlight-overlay')
  const transientSelectors = [
    '#live-editor-overlay-style',
    '#live-editor-anim-reveal-style',
    '#live-mini-toolbar-host',
    '#live-drop-indicator',
    '#__fi-styles',
    '.__fi-badge',
    '.__fi-tooltip',
    '#__bd-styles',
    '.__bd-container',
    '#__color-highlight-overlay',
    '#seo-audit-canvas-styles',
    '.seo-duplicate-badge',
    '#__audit-overlay-container'
  ]
  root.querySelectorAll(transientSelectors.join(',')).forEach((el) => el.remove())

  root.querySelectorAll<HTMLElement>('[data-live-selected], [data-live-hover], [contenteditable], [data-npath]').forEach((el) => {
    el.removeAttribute('data-live-selected')
    el.removeAttribute('data-live-hover')
    el.removeAttribute('contenteditable')
    el.removeAttribute('data-npath')
  })
  root.querySelectorAll<HTMLElement>('.seo-duplicate-highlight').forEach((el) => el.classList.remove('seo-duplicate-highlight'))
  root.querySelectorAll<HTMLElement>('[data-fi-was-static]').forEach((el) => {
    el.style.removeProperty('position')
    el.removeAttribute('data-fi-was-static')
  })
  root.querySelectorAll<HTMLElement>('[data-gs-img]').forEach((el) => el.removeAttribute('data-gs-img'))
  if (hadColorHighlightOverlay) root.querySelector('body')?.style.removeProperty('filter')

  return root.outerHTML
}

export default function EditorWorkspace({
  html,
  sourceUrl,
  project,
  onReset,
  onNewCapture,
  onOpenSettings,
  onPersistHtml,
  onThumbnailCaptured
}: Props & { onOpenSettings?: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const onPersistHtmlRef = useRef(onPersistHtml)
  const devtoolsDropdownRef = useRef<HTMLDivElement>(null)

  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('editBeta')
  const [selectedComponent, setSelectedComponent] = useState<any>(null)
  const [activePreset, setActivePreset] = useState<DevicePreset>('Desktop')
  const [mode, setMode] = useState<ViewportMode>('preset')
  const [vpWidth, setVpWidth] = useState(1920)
  const [vpHeight, setVpHeight] = useState(1200)
  const vpWidthRef = useRef(1920)
  const vpHeightRef = useRef(1200)
  const editBetaRef = useRef<EditBetaWorkspaceHandle>(null)
  const [devtoolsDropdownOpen, setDevtoolsDropdownOpen] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [resetting, setResetting] = useState(false)
  const [frameRect, setFrameRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const [missingFonts, setMissingFonts] = useState<string[]>([])
  const [loadingFonts, setLoadingFonts] = useState(false)
  const [fontsAttempted, setFontsAttempted] = useState(false)

  // ── Snapshots & Project ID Scope ─────────────────
  const activeProjectId = project?.id || (sourceUrl ? new URL(sourceUrl.startsWith('http') ? sourceUrl : `https://${sourceUrl}`).hostname.replace(/^www\./, '') : 'default_project')

  const [storedFigmaUrl, setStoredFigmaUrl] = useState<string>(() => project?.figmaUrl || localStorage.getItem(`qa_${activeProjectId}_figma_url`) || '')
  const [figmaModalOpen, setFigmaModalOpen] = useState(false)
  const [figmaInputVal, setFigmaInputVal] = useState('')
  const [figmaModalTab, setFigmaModalTab] = useState<'live' | 'png' | 'monday'>('live')

  const [mondayPickerOpen, setMondayPickerOpen] = useState(false)
  const [mondayPickerTarget, setMondayPickerTarget] = useState<'mastersheet' | 'figma'>('mastersheet')
  const [mondayTicketsList, setMondayTicketsList] = useState<MondayTicket[]>([])
  const [loadingMondayTickets, setLoadingMondayTickets] = useState(false)
  const [mondaySearchQuery, setMondaySearchQuery] = useState('')
  const mondaySearchInputRef = useRef<HTMLInputElement>(null)
  const googleSheetInputRef = useRef<HTMLInputElement>(null)

  const loadMondayTicketsForPicker = async () => {
    let hasCached = false
    const cached = localStorage.getItem('qa_cached_monday_tickets')
    if (cached) {
      try {
        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMondayTicketsList(parsed)
          hasCached = true
        }
      } catch (_) {}
    }

    if (!hasCached) {
      setLoadingMondayTickets(true)
    }

    try {
      const token =
        localStorage.getItem('monday_api_token') ||
        localStorage.getItem('monday_token') ||
        localStorage.getItem('monday_api_key') ||
        ''
      if (token) {
        const fetched = await fetchMondayTicketsApi(token)
        if (fetched && fetched.length > 0) {
          setMondayTicketsList(fetched)
          localStorage.setItem('qa_cached_monday_tickets', JSON.stringify(fetched))
        }
      }
    } catch (e) {
      console.warn('[MondayPicker] Error fetching tickets:', e)
    } finally {
      setLoadingMondayTickets(false)
    }
  }

  const openMondayTicketPicker = (target: 'mastersheet' | 'figma') => {
    setMondayPickerTarget(target)
    setMondaySearchQuery('')
    setMondayPickerOpen(true)
    loadMondayTicketsForPicker()
    setTimeout(() => {
      mondaySearchInputRef.current?.focus()
    }, 60)
  }

  const filteredMondayTickets = useMemo(() => {
    const q = mondaySearchQuery.trim().toLowerCase()
    if (!q) return mondayTicketsList
    return mondayTicketsList.filter((t) => {
      const name = (t.name || '').toLowerCase()
      const board = (t.boardName || '').toLowerCase()
      const status = (t.status || '').toLowerCase()
      return name.includes(q) || board.includes(q) || status.includes(q)
    })
  }, [mondayTicketsList, mondaySearchQuery])

  const openFigmaModal = () => {
    setFigmaInputVal(project?.figmaUrl || localStorage.getItem(`qa_${activeProjectId}_figma_url`) || '')
    setFigmaModalOpen(true)
  }

  const saveFigmaModal = () => {
    const trimmed = figmaInputVal.trim()
    localStorage.setItem(`qa_${activeProjectId}_figma_url`, trimmed)
    setStoredFigmaUrl(trimmed)
    setFigmaCardDismissed(false)
    setFigmaSplitOpen(true)
    setFigmaViewMode('live')
    setOverlayMode('side-by-side')
    setOverlayVisible(true)
    setFigmaModalOpen(false)
    if (project) {
      window.electronAPI.saveProject({ ...project, figmaUrl: trimmed })
    }
  }

  const clearFigmaModal = () => {
    localStorage.removeItem(`qa_${activeProjectId}_figma_url`)
    setStoredFigmaUrl('')
    setFigmaInputVal('')
    setFigmaModalOpen(false)
    if (project) {
      window.electronAPI.saveProject({ ...project, figmaUrl: '' })
    }
  }

  const handleFigmaButtonClick = () => {
    if (storedFigmaUrl) {
      window.electronAPI.openExternal(storedFigmaUrl)
    } else {
      openFigmaModal()
    }
  }

  // ── Auto-highlight canvas duplicates in Audit mode ──
  useEffect(() => {
    const timer = setTimeout(() => {
      toggleCanvasDuplicates(editorRef.current, workspaceTab === 'audit')
    }, 300)
    return () => clearTimeout(timer)
  }, [workspaceTab])

  // ── Panel resize state ────────────────────────
  const [leftPanelWidth, setLeftPanelWidth] = useState(260)
  const [rightPanelWidth, setRightPanelWidth] = useState(260)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [figmaSplitOpen, setFigmaSplitOpen] = useState(false)
  const [figmaSplitWidth, setFigmaSplitWidth] = useState(550)
  const [bottomSheetOpen, setBottomSheetOpen] = useState(true)
  const [bottomSheetHeight, setBottomSheetHeight] = useState(520)
  const [bottomSheetMaximized, setBottomSheetMaximized] = useState(false)
  const panelDragRef = useRef<{
    side: 'left' | 'right' | 'bottom' | 'figma'
    startX: number
    startY: number
    startWidth: number
    startHeight: number
  } | null>(null)

  // ── Bottom Sheet Tab & Google Sheets state ─────
  const [activeSheetTab, setActiveSheetTab] = useState<'mock' | 'google'>('mock')
  const [googleSheetsUrl, setGoogleSheetsUrl] = useState(() => project?.googleSheetUrl || localStorage.getItem(`qa_${activeProjectId}_google_sheet_url`) || '')
  const [isEditingGoogleUrl, setIsEditingGoogleUrl] = useState(() => !(project?.googleSheetUrl || localStorage.getItem(`qa_${activeProjectId}_google_sheet_url`)))
  const [tempGoogleUrl, setTempGoogleUrl] = useState(googleSheetsUrl)

  const handleSaveGoogleUrl = (urlToSave?: string) => {
    const target = (urlToSave !== undefined ? urlToSave : tempGoogleUrl).trim()
    setGoogleSheetsUrl(target)
    localStorage.setItem(`qa_${activeProjectId}_google_sheet_url`, target)
    setIsEditingGoogleUrl(false)
    if (project) {
      window.electronAPI.saveProject({ ...project, googleSheetUrl: target })
    }
  }

  // Recalculate FortuneSheet grid layout whenever bottom sheet is opened or resized
  useEffect(() => {
    if (bottomSheetOpen) {
      const timer = setTimeout(() => {
        window.dispatchEvent(new Event('resize'))
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [bottomSheetOpen, bottomSheetHeight, activeSheetTab])

  // ── Rulers & guides state ─────────────────────
  const [rulersOn, setRulersOn] = useState(false)
  const [guidesOn, setGuidesOn] = useState(true)
  const [guidesAlwaysVisible, setGuidesAlwaysVisible] = useState(false)
  const [guides, setGuides] = useState<Guide[]>([])
  const [draggingGuide, setDraggingGuide] = useState<Guide | null>(null)
  const [rulerDropdownOpen, setRulerDropdownOpen] = useState(false)
  const [addGuidesOpen, setAddGuidesOpen] = useState(false)
  const [layoutColumns, setLayoutColumns] = useState(3)
  const [layoutRows, setLayoutRows] = useState(3)
  const [layoutMargin, setLayoutMargin] = useState(0)
  const [layoutClear, setLayoutClear] = useState(true)
  const hRulerRef = useRef<HTMLCanvasElement>(null)
  const vRulerRef = useRef<HTMLCanvasElement>(null)
  const canvasInnerRef = useRef<HTMLDivElement>(null)
  const rulerDropdownRef = useRef<HTMLDivElement>(null)

  // ── Canvas frame tracking (iframe position within canvas-inner) ──
  const [canvasFrame, setCanvasFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  const getCanvasFrame = useCallback(() => {
    const inner = canvasInnerRef.current
    if (!inner) return null
    const wrapper = liveIframeRef.current?.parentElement || editorRef.current?.Canvas.getFrameEl()?.parentElement
    if (!wrapper) return null
    const innerRect = inner.getBoundingClientRect()
    const wrapperRect = wrapper.getBoundingClientRect()
    return {
      left: wrapperRect.left - innerRect.left,
      top: wrapperRect.top - innerRect.top,
      width: wrapperRect.width,
      height: wrapperRect.height
    }
  }, [])

  // ── Font inspector state ──────────────────────
  const [fontInspectorOn, setFontInspectorOn] = useState(false)
  const fontInspectorCleanupRef = useRef<(() => void) | null>(null)

  // ── Boundaries (element inspection) state ─────
  const [boundariesOn, setBoundariesOn] = useState(false)
  const [showMargins, setShowMargins] = useState(true)
  const [showPaddings, setShowPaddings] = useState(true)
  const [showDimensions, setShowDimensions] = useState(true)
  const [showGaps, setShowGaps] = useState(true)
  const [boundariesDropdownOpen, setBoundariesDropdownOpen] = useState(false)
  const boundariesDropdownRef = useRef<HTMLDivElement>(null)
  const boundariesCleanupRef = useRef<(() => void) | null>(null)
  const bdOptsRef = useRef({ showMargins: true, showPaddings: true, showDimensions: true, showGaps: true })
  const bdLockedRef = useRef<HTMLElement | null>(null)
  const bdHoveredRef = useRef<HTMLElement | null>(null)
  const bdContainerRef = useRef<HTMLDivElement | null>(null)
  const bdDocRef = useRef<Document | null>(null)
  const bdRedrawRef = useRef<(() => void) | null>(null)

  // ── Color & Font palette state ────────────────
  const [colorsExpanded, setColorsExpanded] = useState(true)
  const [fontsExpanded, setFontsExpanded] = useState(true)
  const [pageColors, setPageColors] = useState<{ hex: string; count: number }[]>([])
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set())
  const [pageFonts, setPageFonts] = useState<{ family: string; count: number }[]>([])
  const [selectedFonts, setSelectedFonts] = useState<Set<string>>(new Set())

  // ── Left panel accordion & Photoshop History state ─
  const [layersExpanded, setLayersExpanded] = useState(true)
  const [layerDisplayMode, setLayerDisplayMode] = useState<'minified' | 'verbose'>('minified')
  const [cssExpanded, setCssExpanded] = useState(true)
  const [cssBlocks, setCssBlocks] = useState<{ source: string; selector: string; props: { name: string; value: string; priority: string }[]; isInline?: boolean }[]>([])
  const cssRevisionRef = useRef(0)
  const [historyExpanded, setHistoryExpanded] = useState(true)
  const [layerCount, setLayerCount] = useState(0)
  const [historySteps, setHistorySteps] = useState<HistoryStep[]>([
    {
      id: 'step-0',
      action: 'Initial Snapshot',
      detail: 'Original page capture',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      iconType: 'init'
    }
  ])
  const [historyIndex, setHistoryIndex] = useState(0)
  const historyIndexRef = useRef(0)
  const isJumpingHistoryRef = useRef(false)
  const isEditorReadyRef = useRef(false)
  const isSelectingRef = useRef(false)
  const selectingFromNativeRef = useRef(false)

  // ── Design / Snapshot Overlay state (project-scoped) ──
  const [figmaImage, setFigmaImageState] = useState<string | null>(() => localStorage.getItem(`qa_${activeProjectId}_uploaded_figma_png`) || null)
  const [snapshotImage, setSnapshotImageState] = useState<string | null>(() => localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_image`) || null)
  const [snapshotLabel, setSnapshotLabelState] = useState<string>(() => localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_label`) || 'Site Snapshot')

  const [overlayImage, setOverlayImageState] = useState<string | null>(() => {
    const source = localStorage.getItem(`qa_${activeProjectId}_active_reference`)
    if (source === 'snapshot') return snapshotImage
    if (source === 'figma') return figmaImage
    return snapshotImage || figmaImage || null
  })
  const [overlayLabel, setOverlayLabelState] = useState<string>(() => {
    const source = localStorage.getItem(`qa_${activeProjectId}_active_reference`)
    if (source === 'snapshot') return localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_label`) || 'Site Snapshot'
    return 'Figma Design'
  })
  const [overlayOpacity, setOverlayOpacity] = useState<number>(() => Number(localStorage.getItem(`qa_${activeProjectId}_figma_overlay_opacity`)) || 50)
  const [overlayVisible, setOverlayVisible] = useState<boolean>(() => localStorage.getItem(`qa_${activeProjectId}_figma_overlay_visible`) !== 'false')
  const [overlayMode, setOverlayMode] = useState<'overlay' | 'side-by-side' | 'diff'>(() => (localStorage.getItem(`qa_${activeProjectId}_figma_overlay_mode`) as any) || 'side-by-side')
  const [overlayPanelOpen, setOverlayPanelOpen] = useState(false)
  const [figmaCardDismissed, setFigmaCardDismissed] = useState(false)
  const [figmaViewMode, setFigmaViewMode] = useState<'live' | 'png'>('live')

  const setFigmaImage = useCallback((img: string | null) => {
    setFigmaImageState(img)
    if (img) {
      localStorage.setItem(`qa_${activeProjectId}_uploaded_figma_png`, img)
    } else {
      localStorage.removeItem(`qa_${activeProjectId}_uploaded_figma_png`)
      if (localStorage.getItem(`qa_${activeProjectId}_active_reference`) === 'figma') {
        const fallback = localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_image`)
        const fallbackLabel = localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_label`) || 'Site Snapshot'
        setOverlayImageState(fallback)
        setOverlayLabelState(fallback ? fallbackLabel : 'Figma Design')
        if (fallback) {
          localStorage.setItem(`qa_${activeProjectId}_active_reference`, 'snapshot')
          localStorage.setItem(`qa_${activeProjectId}_overlay_label`, fallbackLabel)
        } else {
          localStorage.removeItem(`qa_${activeProjectId}_active_reference`)
          localStorage.removeItem(`qa_${activeProjectId}_overlay_label`)
        }
      }
    }
  }, [activeProjectId])

  const setSnapshotImage = useCallback((img: string | null, label: string = 'Site Snapshot') => {
    setSnapshotImageState(img)
    setSnapshotLabelState(label)
    if (img) {
      localStorage.setItem(`qa_${activeProjectId}_snapshot_overlay_image`, img)
      localStorage.setItem(`qa_${activeProjectId}_snapshot_overlay_label`, label)
    } else {
      localStorage.removeItem(`qa_${activeProjectId}_snapshot_overlay_image`)
      localStorage.removeItem(`qa_${activeProjectId}_snapshot_overlay_label`)
      if (localStorage.getItem(`qa_${activeProjectId}_active_reference`) === 'snapshot') {
        const fallback = localStorage.getItem(`qa_${activeProjectId}_uploaded_figma_png`)
        setOverlayImageState(fallback)
        setOverlayLabelState('Figma Design')
        if (fallback) {
          localStorage.setItem(`qa_${activeProjectId}_active_reference`, 'figma')
          localStorage.setItem(`qa_${activeProjectId}_overlay_label`, 'Figma Design')
        } else {
          localStorage.removeItem(`qa_${activeProjectId}_active_reference`)
          localStorage.removeItem(`qa_${activeProjectId}_overlay_label`)
        }
      }
    }
  }, [activeProjectId])

  const setOverlayImage = useCallback((img: string | null, label: string = 'Figma Design') => {
    const source = label === 'Figma Design' ? 'figma' : 'snapshot'
    if (!img) {
      if ((localStorage.getItem(`qa_${activeProjectId}_active_reference`) || source) === 'figma') setFigmaImage(null)
      else setSnapshotImage(null)
      return
    }
    if (source === 'figma') {
      setFigmaImage(img)
    } else {
      setSnapshotImage(img, label)
    }
    setOverlayImageState(img)
    setOverlayLabelState(label)
    localStorage.setItem(`qa_${activeProjectId}_active_reference`, source)
    localStorage.setItem(`qa_${activeProjectId}_overlay_label`, label)
  }, [activeProjectId, setFigmaImage, setSnapshotImage])

  useEffect(() => {
    localStorage.setItem(`qa_${activeProjectId}_figma_overlay_opacity`, String(overlayOpacity))
  }, [activeProjectId, overlayOpacity])

  useEffect(() => {
    localStorage.setItem(`qa_${activeProjectId}_figma_overlay_visible`, String(overlayVisible))
  }, [activeProjectId, overlayVisible])

  useEffect(() => {
    localStorage.setItem(`qa_${activeProjectId}_figma_overlay_mode`, overlayMode)
  }, [activeProjectId, overlayMode])

  // ── Dynamic Re-sync whenever active project changes ──
  useEffect(() => {
    if (!activeProjectId) return

    const figUrl = project?.figmaUrl || localStorage.getItem(`qa_${activeProjectId}_figma_url`) || ''
    const sheetUrl = project?.googleSheetUrl || localStorage.getItem(`qa_${activeProjectId}_google_sheet_url`) || ''
    const figPng = localStorage.getItem(`qa_${activeProjectId}_uploaded_figma_png`) || null
    const snapImg = localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_image`) || null
    const snapLbl = localStorage.getItem(`qa_${activeProjectId}_snapshot_overlay_label`) || 'Site Snapshot'
    const storedSource = localStorage.getItem(`qa_${activeProjectId}_active_reference`)
    const legacyLabel = localStorage.getItem(`qa_${activeProjectId}_overlay_label`)
    const activeSource = storedSource === 'snapshot' && snapImg ? 'snapshot'
      : storedSource === 'figma' && figPng ? 'figma'
      : legacyLabel && legacyLabel !== 'Figma Design' && snapImg ? 'snapshot'
      : legacyLabel === 'Figma Design' && figPng ? 'figma'
      : snapImg ? 'snapshot'
      : figPng ? 'figma'
      : null

    setStoredFigmaUrl(figUrl)
    setFigmaInputVal(figUrl)
    setGoogleSheetsUrl(sheetUrl)
    setTempGoogleUrl(sheetUrl)
    setIsEditingGoogleUrl(!sheetUrl)

    setFigmaImageState(figPng)
    setSnapshotImageState(snapImg)
    setSnapshotLabelState(snapLbl)
    setOverlayImageState(activeSource === 'snapshot' ? snapImg : activeSource === 'figma' ? figPng : null)
    setOverlayLabelState(activeSource === 'snapshot' ? snapLbl : 'Figma Design')
    if (activeSource) {
      localStorage.setItem(`qa_${activeProjectId}_active_reference`, activeSource)
      localStorage.setItem(`qa_${activeProjectId}_overlay_label`, activeSource === 'snapshot' ? snapLbl : 'Figma Design')
    } else {
      localStorage.removeItem(`qa_${activeProjectId}_active_reference`)
      localStorage.removeItem(`qa_${activeProjectId}_overlay_label`)
    }
    setFigmaSplitOpen(!!figUrl || !!figPng)
  }, [activeProjectId, project?.id, project?.figmaUrl, project?.googleSheetUrl])

  const figmaWebviewRef = useRef<any>(null)

  useEffect(() => {
    const wv = figmaWebviewRef.current
    if (!wv) return
    const handleNewWindow = (e: any) => {
      if (e.url) {
        if (typeof (window.electronAPI as any)?.figmaLoginWindow === 'function') {
          ;(window.electronAPI as any).figmaLoginWindow(e.url).then(() => {
            try { wv.reload() } catch {}
          })
        } else {
          window.open(e.url, '_blank', 'width=1024,height=768')
        }
      }
    }
    const handleDomReady = () => {
      try {
        const scale = Math.max(0.2, Math.min(1.0, canvasFrame ? canvasFrame.width / vpWidth : 1))
        if (typeof wv.setZoomFactor === 'function') {
          wv.setZoomFactor(scale)
        }
      } catch (e) {}
    }
    wv.addEventListener('new-window', handleNewWindow)
    wv.addEventListener('dom-ready', handleDomReady)
    handleDomReady()
    return () => {
      try {
        wv.removeEventListener('new-window', handleNewWindow)
        wv.removeEventListener('dom-ready', handleDomReady)
      } catch (e) {}
    }
  }, [storedFigmaUrl, figmaSplitOpen, canvasFrame?.width, vpWidth])

  // ── Snapshots State & Helper Functions ─────────────
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([])
  const [snapshotCategoryFilter, setSnapshotCategoryFilter] = useState<'all' | 'desktop' | 'tablet' | 'phone' | 'custom'>('all')
  const [snapshotsExpanded, setSnapshotsExpanded] = useState(true)
  const [snapshotDropdownOpen, setSnapshotDropdownOpen] = useState(false)
  const [snapshotCreating, setSnapshotCreating] = useState(false)
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null)
  const snapshotDropdownRef = useRef<HTMLDivElement>(null)

  const [selectedMultiBreakpoints, setSelectedMultiBreakpoints] = useState<string[]>([
    'Desktop (1920×1200)',
    'iPad Air',
    'iPhone 12 Pro'
  ])
  const [batchToast, setBatchToast] = useState<{ active: boolean; message: string; isComplete?: boolean } | null>(null)

  const getFigmaEmbedUrl = (url?: string) => {
    if (!url) return ''
    if (url.includes('figma.com/embed')) return url
    return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`
  }

  const getSnapshotCategory = (snap: SnapshotItem): 'desktop' | 'tablet' | 'phone' | 'custom' => {
    const w = snap.viewportWidth || 1920
    if (w >= 1024) return 'desktop'
    if (w >= 600 && w < 1024) return 'tablet'
    if (w === 390 || w === 430 || w === 412 || w === 360 || w === 375 || w === 414 || w < 600) return 'phone'
    return 'custom'
  }

  const loadSnapshots = useCallback(async () => {
    try {
      const list = await window.electronAPI.getSnapshots(activeProjectId)
      if (Array.isArray(list)) setSnapshots(list)
    } catch (err) {
      console.error('Failed to load snapshots:', err)
    }
  }, [activeProjectId])

  useEffect(() => {
    loadSnapshots()
  }, [loadSnapshots])

  const formatSnapshotDate = (timestamp?: number | string) => {
    if (!timestamp) return ''
    const d = new Date(timestamp)
    if (isNaN(d.getTime())) return ''

    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    const isToday = d.toDateString() === now.toDateString()

    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const isYesterday = d.toDateString() === yesterday.toDateString()

    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    if (isToday) return `Today, ${timeStr}`
    if (isYesterday) return `Yesterday, ${timeStr}`
    if (diffDays >= 2 && diffDays < 7) {
      const dayName = d.toLocaleDateString([], { weekday: 'short' })
      return `${dayName}, ${timeStr}`
    }

    const isSameYear = d.getFullYear() === now.getFullYear()
    if (isSameYear) {
      const monthDay = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      return `${monthDay}, ${timeStr}`
    }

    const fullDate = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    return fullDate
  }

  const formatSnapshotTitle = (snap: SnapshotItem) => {
    const dims = (snap.viewportWidth && snap.viewportHeight)
      ? `${snap.viewportWidth}x${snap.viewportHeight}`
      : `${vpWidth}x${vpHeight}`

    const dateFormatted = formatSnapshotDate(snap.timestamp || (snap as any).createdAt)
    if (dateFormatted) {
      return `${dims} • ${dateFormatted}`
    }

    let title = snap.title || ''
    if (/^(Image|HTML)\s+Snapshot\s+/i.test(title)) {
      const rawTime = title.replace(/^(Image|HTML)\s+Snapshot\s+/i, '').trim()
      const minimalTime = rawTime.replace(/(\d{1,2}:\d{2}):\d{2}\s*([AP]M)?/i, '$1 $2').trim()
      return `${dims} • ${minimalTime}`
    }
    return title || dims
  }

  const handleCreateSnapshot = async (type: 'image' | 'html') => {
    setSnapshotCreating(true)
    setSnapshotDropdownOpen(false)
    setBatchToast({
      active: true,
      message: `Capturing ${type === 'image' ? 'Visual Image' : 'Interactive HTML'} Snapshot (${vpWidth}×${vpHeight})...`
    })
    try {
      const targetUrl = liveUrl || sourceUrl
      const currentHtml = liveIframeRef.current?.contentDocument?.documentElement?.outerHTML || html
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

      const res = await window.electronAPI.createSnapshot({
        projectId: activeProjectId,
        url: targetUrl,
        type,
        title: `${vpWidth}x${vpHeight} • ${timeStr}`,
        viewportWidth: vpWidth,
        viewportHeight: vpHeight,
        htmlContent: type === 'html' ? currentHtml : undefined
      })
      if (res.success && res.snapshot) {
        setSnapshots((prev) => [res.snapshot!, ...prev])
        if (res.snapshot.type === 'image' && res.snapshot.dataUrl) {
          const cat = getSnapshotCategory(res.snapshot)
          setSnapshotCategoryFilter(cat)
          setOverlayImage(res.snapshot.dataUrl, 'Site Snapshot')
          setOverlayVisible(true)
        }
        setBatchToast({
          active: true,
          message: `✓ Snapshot Saved (${res.snapshot.fileSizeFormatted})`,
          isComplete: true
        })
      } else {
        setBatchToast({
          active: true,
          message: `⚠ Error: ${res.error || 'Failed to create snapshot'}`,
          isComplete: true
        })
      }
    } catch (err: any) {
      console.error('[Snapshot Debug - Renderer] Exception in handleCreateSnapshot:', err)
      setBatchToast({
        active: true,
        message: `⚠ Failed: ${err.message || 'Error'}`,
        isComplete: true
      })
    } finally {
      setSnapshotCreating(false)
      setTimeout(() => setBatchToast(null), 4000)
    }
  }

  const handleCaptureMultiBreakpoints = async () => {
    if (selectedMultiBreakpoints.length === 0) return
    setSnapshotCreating(true)
    setSnapshotDropdownOpen(false)

    const targets = DEVTOOLS_PRESETS.filter((p) => selectedMultiBreakpoints.includes(p.name))
    const total = targets.length

    setBatchToast({
      active: true,
      message: `Starting Multi-Device Snapshot (${total} Breakpoints)...`
    })

    try {
      const targetUrl = liveUrl || sourceUrl
      let successCount = 0

      for (let i = 0; i < total; i++) {
        const item = targets[i]
        setBatchToast({
          active: true,
          message: `Capturing Breakpoints [${i + 1}/${total}]: ${item.name} (${item.w}×${item.h})...`
        })

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const res = await window.electronAPI.createSnapshot({
          projectId: activeProjectId,
          url: targetUrl,
          type: 'image',
          title: `${item.w}x${item.h} • ${timeStr}`,
          viewportWidth: item.w,
          viewportHeight: item.h
        })

        if (res.success && res.snapshot && res.snapshot.dataUrl) {
          successCount++
          setSnapshots((prev) => [res.snapshot!, ...prev])
          const cat = getSnapshotCategory(res.snapshot)
          setSnapshotCategoryFilter(cat)
          setOverlayImage(res.snapshot.dataUrl, 'Site Snapshot')
          setOverlayVisible(true)
        }

        await new Promise((r) => setTimeout(r, 300))
      }

      setBatchToast({
        active: true,
        message: `✓ Multi-Device Snapshot Complete! ${successCount} Breakpoints Saved.`,
        isComplete: true
      })
    } catch (err: any) {
      setBatchToast({
        active: true,
        message: `⚠ Multi-Snapshot Error: ${err.message || 'Failed'}`,
        isComplete: true
      })
    } finally {
      setSnapshotCreating(false)
      setTimeout(() => setBatchToast(null), 5000)
    }
  }

  const handleDeleteSnapshot = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    const removed = snapshots.find((snapshot) => snapshot.id === id)
    await window.electronAPI.deleteSnapshot(id)
    setSnapshots((prev) => prev.filter((snapshot) => snapshot.id !== id))
    if (removed?.dataUrl && removed.dataUrl === snapshotImage) setSnapshotImage(null)
  }

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClose = (e: MouseEvent) => {
      if (snapshotDropdownRef.current && !snapshotDropdownRef.current.contains(e.target as Node)) {
        setSnapshotDropdownOpen(false)
      }
      if (overlayDropdownRef.current && !overlayDropdownRef.current.contains(e.target as Node)) {
        setOverlayPanelOpen(false)
      }
      if (snapshotPanelDropdownRef.current && !snapshotPanelDropdownRef.current.contains(e.target as Node)) {
        setSnapshotPanelOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClose)
    return () => window.removeEventListener('mousedown', handleClose)
  }, [])

  const overlayFileRef = useRef<HTMLInputElement>(null)
  const overlayDropdownRef = useRef<HTMLDivElement>(null)
  const [snapshotPanelOpen, setSnapshotPanelOpen] = useState(false)
  const snapshotPanelDropdownRef = useRef<HTMLDivElement>(null)
  const [iframeScrollY, setIframeScrollY] = useState(0)

  const nativeDomSnapshotsRef = useRef<string[]>([])

  // ── Push a new action into the Photoshop History stack ──
  const pushHistoryStep = useCallback((action: string, detail?: string, iconType: HistoryStep['iconType'] = 'edit') => {
    if (isJumpingHistoryRef.current || !isEditorReadyRef.current) return

    // Save native DOM snapshot for 100% reliable Undo/Redo
    const doc = liveIframeRef.current?.contentDocument
    if (doc && doc.body) {
      const snap = doc.body.innerHTML
      const baseSnaps = nativeDomSnapshotsRef.current.slice(0, historyIndexRef.current + 1)
      nativeDomSnapshotsRef.current = [...baseSnaps, snap]
    }

    const newStep: HistoryStep = {
      id: 'step-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      action,
      detail,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      iconType
    }
    setHistorySteps((prevSteps) => {
      const base = prevSteps.slice(0, historyIndexRef.current + 1)
      const next = [...base, newStep]
      historyIndexRef.current = next.length - 1
      setHistoryIndex(next.length - 1)
      return next
    })
  }, [])

  // ── Rollback or jump to a specific history index (Photoshop style) ──
  const jumpToHistoryIndex = useCallback((targetIndex: number) => {
    const editor = editorRef.current
    if (!editor) return
    const current = historyIndexRef.current
    if (targetIndex === current) return

    isJumpingHistoryRef.current = true

    // Restore native DOM snapshot if available
    const doc = liveIframeRef.current?.contentDocument
    if (doc && doc.body && nativeDomSnapshotsRef.current[targetIndex] != null) {
      doc.body.innerHTML = nativeDomSnapshotsRef.current[targetIndex]
    }

    if (editor.UndoManager) {
      const diff = targetIndex - current
      if (diff < 0) {
        for (let i = 0; i < Math.abs(diff); i++) {
          if (editor.UndoManager.hasUndo()) editor.UndoManager.undo()
        }
      } else {
        for (let i = 0; i < diff; i++) {
          if (editor.UndoManager.hasRedo()) editor.UndoManager.redo()
        }
      }
    }

    historyIndexRef.current = targetIndex
    setHistoryIndex(targetIndex)
    setTimeout(() => {
      isJumpingHistoryRef.current = false
    }, 50)
  }, [])

  const revertToInitial = useCallback(() => {
    jumpToHistoryIndex(0)
  }, [jumpToHistoryIndex])

  // ── Click outside devtools dropdown ─────────────────
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (devtoolsDropdownRef.current && !devtoolsDropdownRef.current.contains(e.target as Node)) {
        setDevtoolsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ── Helpers to push dimensions into GrapesJS ──
  const applyDimensions = useCallback((w: number, h: number) => {
    const editor = editorRef.current
    if (editor) {
      // Update or add the Custom device, then switch to it
      const devices = editor.Devices
      const existing = devices.get('Custom')
      if (existing) {
        existing.set({ width: `${w}px`, height: `${h}px` })
      }
      editor.setDevice('Custom')

      // Directly size the canvas frame element for both width and height
      const frame = editor.Canvas.getFrameEl()
      if (frame) {
        frame.style.width = `${w}px`
        frame.style.height = `${h}px`
      }
    }

    // Also size the native overlay iframe and live webview wrapper
    const nativeFrame = liveIframeRef.current
    if (nativeFrame) {
      nativeFrame.style.width = `${w}px`
      nativeFrame.style.height = `${h}px`
    }
    const liveWrap = liveWebviewRef.current?.parentElement
    if (liveWrap) {
      liveWrap.style.width = `${w}px`
      liveWrap.style.height = `${h}px`
    }
  }, [])

  const pushHistoryRef = useRef(pushHistoryStep)
  useEffect(() => {
    pushHistoryRef.current = pushHistoryStep
  }, [pushHistoryStep])

  const toggleLayerDisplayMode = (mode: 'minified' | 'verbose') => {
    setLayerDisplayMode(mode)
    if (editorRef.current) {
      updateLayersDisplayMode(editorRef.current, mode)
    }
  }

  const liveIframeRef = useRef<HTMLIFrameElement | null>(null)
  const nativeIframeLoadedRef = useRef(false)

  useEffect(() => {
    onPersistHtmlRef.current = onPersistHtml
  }, [onPersistHtml])

  // Inactive application tabs are unmounted to release their iframe,
  // GrapesJS instance, webviews, listeners, and animation loops. Persist the
  // latest edited DOM before React tears down this workspace.
  useEffect(() => {
    return () => {
      const currentDoc = liveIframeRef.current?.contentDocument
      // A newly-created iframe initially exposes an empty about:blank document.
      // Never persist it before srcDoc has emitted its load event.
      if (nativeIframeLoadedRef.current && currentDoc?.documentElement) {
        onPersistHtmlRef.current?.(serializeWorkspaceHtml(currentDoc))
      }
    }
  }, [])

  const [interactionMode, setInteractionMode] = useState<'edit' | 'interact'>('edit')
  // Preserve the captured page's visibility and transforms by default.
  // Revealing animation targets is an explicit inspection aid because forcing
  // hidden/animated nodes visible can expose responsive duplicates and alter
  // the site's original layout.
  const [revealAnimations, setRevealAnimations] = useState(false)
  const liveEditorRef = useRef<ReturnType<typeof attachLiveEditor> | null>(null)

  const toggleInteractionMode = (newMode: 'edit' | 'interact') => {
    setInteractionMode(newMode)
    if (liveEditorRef.current) {
      liveEditorRef.current.updateOptions({ mode: newMode })
    }
  }

  const toggleRevealAnimations = () => {
    setRevealAnimations((prev) => {
      const next = !prev
      if (liveEditorRef.current) {
        liveEditorRef.current.updateOptions({ revealAnimations: next })
      }
      return next
    })
  }

  const selectedNativeElRef = useRef<HTMLElement | null>(null)
  const [selectedNativeEl, setSelectedNativeEl] = useState<HTMLElement | null>(null)
  const [nativeStyleRevision, setNativeStyleRevision] = useState(0)
  const [cssRules, setCssRules] = useState<string>('')
  const [customCss, setCustomCss] = useState<string>('')
  const customStyleRef = useRef<HTMLStyleElement | null>(null)

  const [liveUrl, setLiveUrl] = useState<string>(sourceUrl || '')

  useEffect(() => {
    if (sourceUrl) setLiveUrl(sourceUrl)
  }, [sourceUrl])

  const liveWebviewRef = useRef<any>(null)

  const handleLiveBack = useCallback(() => {
    if (liveWebviewRef.current && typeof liveWebviewRef.current.goBack === 'function') {
      try { liveWebviewRef.current.goBack() } catch {}
    } else {
      const iframe = liveIframeRef.current
      if (iframe && iframe.contentWindow) {
        try { iframe.contentWindow.history.back() } catch {}
      }
    }
  }, [])

  const handleLiveForward = useCallback(() => {
    if (liveWebviewRef.current && typeof liveWebviewRef.current.goForward === 'function') {
      try { liveWebviewRef.current.goForward() } catch {}
    } else {
      const iframe = liveIframeRef.current
      if (iframe && iframe.contentWindow) {
        try { iframe.contentWindow.history.forward() } catch {}
      }
    }
  }, [])

  const handleLiveReload = useCallback(async () => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.clearCache === 'function') {
        await window.electronAPI.clearCache()
      }
    } catch {}
    if (liveWebviewRef.current && typeof liveWebviewRef.current.reloadIgnoringCache === 'function') {
      try { liveWebviewRef.current.reloadIgnoringCache() } catch {
        try { liveWebviewRef.current.reload() } catch {}
      }
    } else if (liveWebviewRef.current && typeof liveWebviewRef.current.reload === 'function') {
      try { liveWebviewRef.current.reload() } catch {}
    } else {
      const iframe = liveIframeRef.current
      if (iframe && iframe.contentWindow) {
        try { iframe.contentWindow.location.reload() } catch {}
      }
    }
  }, [])

  const handleNavigateLiveUrl = useCallback((targetUrl: string) => {
    let target = targetUrl.trim()
    if (!target) return
    if (!/^https?:\/\//i.test(target)) {
      target = 'https://' + target
    }
    setLiveUrl(target)
    if (liveWebviewRef.current && typeof liveWebviewRef.current.loadURL === 'function') {
      try { liveWebviewRef.current.loadURL(target) } catch {}
    } else {
      const iframe = liveIframeRef.current
      if (iframe) {
        iframe.src = target
      }
    }
  }, [])

  useEffect(() => {
    const webview = liveWebviewRef.current
    if (!webview) return

    const handleNav = (e: any) => {
      if (e.url) setLiveUrl(e.url)
    }

    webview.addEventListener('did-navigate', handleNav)
    webview.addEventListener('did-navigate-in-page', handleNav)
    return () => {
      try {
        webview.removeEventListener('did-navigate', handleNav)
        webview.removeEventListener('did-navigate-in-page', handleNav)
      } catch {}
    }
  }, [workspaceTab])

  // ── Compute CSS rules for selected element (DevTools-style) ──
  const refreshCssRules = useCallback((el: HTMLElement | null) => {
    if (!el) { setCssRules(''); return }
    const win = el.ownerDocument.defaultView
    if (!win) { setCssRules(''); return }

    const lines: string[] = []

    // 1. Inline styles
    const inlineStyle = el.getAttribute('style')
    if (inlineStyle && inlineStyle.trim()) {
      lines.push('/* element.style */')
      lines.push(`element.style {`)
      inlineStyle.split(';').filter(s => s.trim()).forEach(s => {
        lines.push(`  ${s.trim()};`)
      })
      lines.push('}')
      lines.push('')
    }

    // 2. Matched CSS rules from stylesheets
    try {
      const sheets = el.ownerDocument.styleSheets
      for (let s = 0; s < sheets.length; s++) {
        let rules: CSSRuleList
        try { rules = sheets[s].cssRules } catch { continue }
        for (let r = 0; r < rules.length; r++) {
          const rule = rules[r] as CSSStyleRule
          if (!rule.selectorText) continue
          try {
            if (el.matches(rule.selectorText)) {
              lines.push(`/* ${sheets[s].href ? new URL(sheets[s].href!).pathname.split('/').pop() : 'inline stylesheet'} */`)
              lines.push(`${rule.selectorText} {`)
              for (let p = 0; p < rule.style.length; p++) {
                const prop = rule.style[p]
                const val = rule.style.getPropertyValue(prop)
                const prio = rule.style.getPropertyPriority(prop)
                lines.push(`  ${prop}: ${val}${prio ? ' !important' : ''};`)
              }
              lines.push('}')
              lines.push('')
            }
          } catch {}
        }
      }
    } catch {}

    setCssRules(lines.join('\n'))
  }, [])

  useEffect(() => {
    refreshCssRules(selectedNativeEl)
  }, [selectedNativeEl, refreshCssRules])

  const handleInspectorCssChange = useCallback((newCss: string) => {
    setCssRules(newCss)
    const doc = liveIframeRef.current?.contentDocument
    if (doc && doc.documentElement) {
      const updatedHtml = doc.documentElement.outerHTML
      sessionStorage.setItem('fullforce_captured_html', updatedHtml)
    }
  }, [])

  // ── Apply custom CSS to native iframe ──
  const applyCustomCss = useCallback((css: string) => {
    setCustomCss(css)
    const doc = liveIframeRef.current?.contentDocument
    if (!doc) return
    if (!customStyleRef.current) {
      const style = doc.createElement('style')
      style.id = '__custom-user-css'
      doc.head.appendChild(style)
      customStyleRef.current = style
    }
    customStyleRef.current.textContent = css
  }, [])

  const styleTimerRef = useRef<any>(null)

  const handleNativeStyleChange = useCallback((prop: string, val: string, isFinalCommit = true) => {
    const el = selectedNativeElRef.current
    if (!el) return
    if (val === '' || val === 'none') {
      el.style.removeProperty(prop)
    } else {
      el.style.setProperty(prop, val, 'important')
    }

    refreshCssRules(el)

    if (isFinalCommit) {
      clearTimeout(styleTimerRef.current)
      styleTimerRef.current = setTimeout(() => {
        const currentDoc = liveIframeRef.current?.contentDocument
        if (currentDoc && currentDoc.documentElement) {
          const updatedHtml = currentDoc.documentElement.outerHTML
          sessionStorage.setItem('fullforce_captured_html', updatedHtml)
        }
        pushHistoryStep('Change Style', `${prop}: ${val}`)
      }, 150)
    }
  }, [pushHistoryStep, refreshCssRules])

  const syncStyleToNativeElement = useCallback((comp: any, propObj?: any) => {
    const nativeEl = selectedNativeElRef.current
    if (!nativeEl) return

    // 1. Extract property name and value if propObj passed
    let propName = ''
    let propVal: any = ''
    if (propObj) {
      if (typeof propObj === 'string') {
        propName = propObj
      } else if (propObj.getProperty) {
        propName = propObj.getProperty()
      } else if (propObj.get) {
        propName = propObj.get('property') || ''
      }

      if (typeof propObj === 'object' && propObj !== null) {
        if (propObj.getFullValue) {
          propVal = propObj.getFullValue()
        } else if (propObj.getValue) {
          propVal = propObj.getValue()
        } else if (propObj.get) {
          propVal = propObj.get('value')
        }
      }
    }

    if (propName && propVal != null) {
      const valStr = String(propVal).trim()
      if (valStr === '' || valStr === 'none') {
        nativeEl.style.removeProperty(propName)
      } else {
        nativeEl.style.setProperty(propName, valStr, 'important')
      }
    }

    // 2. Sync all component model styles
    if (comp && comp.getStyle) {
      const styles = comp.getStyle() || {}
      for (const [prop, val] of Object.entries(styles)) {
        if (val != null && String(val).trim() !== '') {
          nativeEl.style.setProperty(prop, String(val), 'important')
        }
      }
    }
  }, [])

  // ── Native iframe load handler — attaches liveEditorBridge for selection & editing ──
  const handleNativeIframeLoad = useCallback(() => {
    const iframe = liveIframeRef.current
    if (!iframe || !iframe.contentDocument) return
    const doc = iframe.contentDocument
    nativeIframeLoadedRef.current = true

    // Mark editor as ready & store initial DOM snapshot for Undo/Redo
    isEditorReadyRef.current = true
    if (doc.body && nativeDomSnapshotsRef.current.length === 0) {
      nativeDomSnapshotsRef.current = [doc.body.innerHTML]
    }

    // Stamp data-npath on every element for reliable layers↔native matching
    const stampPaths = (el: Element, prefix: string) => {
      el.setAttribute('data-npath', prefix)
      const children = el.children
      for (let i = 0; i < children.length; i++) {
        stampPaths(children[i], prefix + '/' + i)
      }
    }
    if (doc.body) stampPaths(doc.body, 'B')

    // Trigger synthetic scroll and resize inside iframe content window for on-scroll JS triggers
    if (iframe.contentWindow) {
      try {
        iframe.contentWindow.dispatchEvent(new Event('scroll'))
        iframe.contentWindow.dispatchEvent(new Event('resize'))
      } catch {}
    }

    // Hotkey handler inside native iframe: Ctrl+A, Spacebar panning, and Undo/Redo
    const handleIframeKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      // 1. Ctrl + A: Prevent whole-page selection highlight when not in an editable element
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (!isEditable) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }

      // 2. Spacebar: blur focused elements and activate panning without triggering button clicks
      if (e.code === 'Space') {
        if (!isEditable) {
          e.preventDefault()
          const active = doc.activeElement as HTMLElement
          if (active) active.blur()
          if (!isSpacePressedRef.current) {
            isSpacePressedRef.current = true
            doc.body.style.cursor = 'grab'
            document.body.style.cursor = 'grab'
            liveEditorRef.current?.setPaused(true)
          }
        }
        return
      }

      // 3. Ctrl+Z (Undo) and Ctrl+Y / Ctrl+Shift+Z (Redo)
      if (isEditable) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        jumpToHistoryIndex(Math.max(0, historyIndexRef.current - 1))
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
      ) {
        e.preventDefault()
        jumpToHistoryIndex(Math.min(historySteps.length - 1, historyIndexRef.current + 1))
      }
    }
    doc.addEventListener('keydown', handleIframeKeyDown)

    // Spacebar keyup inside iframe — without this, isSpacePressedRef stays true forever
    const handleIframeKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false
        doc.body.style.cursor = ''
        document.body.style.cursor = ''
        liveEditorRef.current?.setPaused(false)
      }
    }
    doc.addEventListener('keyup', handleIframeKeyUp)

    // Ctrl+scroll zoom inside iframe
    const handleIframeWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const dir = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current + dir))
      applyZoomRef.current(nextZoom)
    }
    doc.addEventListener('wheel', handleIframeWheel, { passive: false })

    // Middle-mouse & Space+click pan inside iframe — delegates to shared pan session
    const handleIframePanDown = (e: MouseEvent) => {
      const isMiddle = e.button === 1
      const isSpaceLeft = e.button === 0 && isSpacePressedRef.current
      if (!isMiddle && !isSpaceLeft) return
      e.preventDefault()
      e.stopPropagation()
      startPanSessionRef.current(e)
    }
    const handleIframeAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    doc.addEventListener('mousedown', handleIframePanDown, true)
    doc.addEventListener('auxclick', handleIframeAuxClick, true)

    // Attach live editor bridge to the NATIVE iframe for direct selection & editing
    const live = attachLiveEditor(doc, {
      mode: interactionMode,
      revealAnimations,
      zoom: zoomRef.current,
      onSelect: (_info, el) => {
        selectedNativeElRef.current = el
        setSelectedNativeEl(el)
        setNativeStyleRevision((r) => r + 1)
        if (el) {
          selectingFromNativeRef.current = true
            const editor = editorRef.current
            if (editor) {
              const wrapper = editor.getWrapper()
              const comp = findGrapesComponentForNativeEl(wrapper, el)
              if (comp) {
                // Walk up all parent components and set open: true so all parent layers expand in Layers panel
                let curr = comp.parent ? comp.parent() : null
                while (curr) {
                  if (curr.set) curr.set('open', true)
                  curr = curr.parent ? curr.parent() : null
                }
                editor.select(comp)

                // Force LayerManager to re-render expanded tree and scroll selected layer into view
                setTimeout(() => {
                  try {
                    if (editor.LayerManager && (editor.LayerManager as any).render) {
                      ;(editor.LayerManager as any).render()
                    }
                  } catch {}
                  const layerEl = document.querySelector('#layers-container .gjs-selected') as HTMLElement
                  if (layerEl) {
                    layerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                  }
                }, 60)
              }
            }
          setTimeout(() => {
            selectingFromNativeRef.current = false
          }, 200)
        }
      },
      onChange: () => {
        const currentDoc = liveIframeRef.current?.contentDocument
        if (currentDoc && currentDoc.documentElement) {
          const updatedHtml = currentDoc.documentElement.outerHTML
          sessionStorage.setItem('fullforce_captured_html', updatedHtml)
        }
        pushHistoryStep('edit', 'Updated page element', 'edit')
      }
    })
    liveEditorRef.current = live
  }, [interactionMode, revealAnimations, pushHistoryStep])

  // ── Editor lifecycle ──────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    setFontsAttempted(false)
    setMissingFonts([])
    const editor = initEditor(containerRef.current, html, {
      onMissingFonts: (fonts) => setMissingFonts(fonts)
    })
    editorRef.current = editor

    // Register Escape keymap directly in GrapesJS core keymaps
    try {
      if (editor.Keymaps) {
        editor.Keymaps.add('core:deselect-component', 'escape', (ed: any) => {
          ed.select(null)
          setSelectedComponent(null)
        })
      }
    } catch (_) {}

    const updateLayerCount = () => {
      try {
        const wrapper = editor.getWrapper()
        let total = 0
        const count = (c: any) => {
          total++
          if (c && c.components) {
            c.components().each((child: any) => count(child))
          }
        }
        if (wrapper) count(wrapper)
        setLayerCount(total)
      } catch {
        setLayerCount(0)
      }
    }

    isEditorReadyRef.current = false

    // Force initial 1920x1200 frame sizing immediately on load
    editor.on('load', () => {
      applyDimensions(1920, 1200)
      updateLayerCount()
      updateLayersDisplayMode(editor, layerDisplayMode)

      // Attach Escape key listener directly to GrapesJS iframe window & document in capture mode
      try {
        const gFrame = editor.Canvas?.getFrameEl() as HTMLIFrameElement
        if (gFrame && gFrame.contentWindow) {
          const frameWin = gFrame.contentWindow
          const frameDoc = gFrame.contentDocument || frameWin.document
          const handleFrameEscape = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape' || ev.code === 'Escape') {
              const target = ev.target as HTMLElement
              const isEdit = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
              if (!isEdit) {
                ev.preventDefault()
                ev.stopPropagation()
                const sel: any = (editor as any).getSelected()
                if (sel && typeof sel.deselect === 'function') sel.deselect()
                if (typeof (editor as any).select === 'function') (editor as any).select(undefined as any)
                setSelectedComponent(null)
              }
            }
          }
          frameWin.addEventListener('keydown', handleFrameEscape, true)
          if (frameDoc) frameDoc.addEventListener('keydown', handleFrameEscape, true)
        }
      } catch (_) {}

      // Stamp data-npath on GrapesJS components to match native iframe paths
      const stampCompPaths = (comp: any, prefix: string) => {
        if (comp.addAttributes) comp.addAttributes({ 'data-npath': prefix })
        else if (comp.set) comp.set('attributes', { ...comp.get('attributes'), 'data-npath': prefix })
        const children = comp.components ? comp.components() : null
        if (children) {
          let elemIdx = 0
          children.each((child: any) => {
            const isElem = child.get && child.get('tagName') && child.get('type') !== 'textnode'
            if (isElem) {
              stampCompPaths(child, prefix + '/' + elemIdx)
              elemIdx++
            } else {
              stampCompPaths(child, prefix + '/t')
            }
          })
        }
      }
      const wrapper = editor.getWrapper()
      if (wrapper) {
        stampCompPaths(wrapper, 'B')
      }

      // Reset History stack to clean Initial Snapshot state
      const initialStep: HistoryStep = {
        id: 'step-0',
        action: 'Initial Snapshot',
        detail: 'Original page capture',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        iconType: 'init'
      }
      setHistorySteps([initialStep])
      setHistoryIndex(0)
      historyIndexRef.current = 0
      setTimeout(() => {
        isEditorReadyRef.current = true
      }, 250)
    })
    const timer = setTimeout(() => {
      applyDimensions(1920, 1200)
      updateLayerCount()
    }, 150)

    // Map to cache component styles to detect real style property changes vs click selections
    const lastCompStyles = new Map<any, string>()

    editor.on('component:selected', (comp) => {
      setSelectedComponent(comp)
      isSelectingRef.current = true
      // Cache style snapshot AFTER GrapesJS finishes populating computed styles
      setTimeout(() => {
        if (comp && comp.getStyle) {
          try {
            lastCompStyles.set(comp, JSON.stringify(comp.getStyle()))
          } catch {}
        }
        isSelectingRef.current = false
      }, 350)
    })
    editor.on('component:deselected', () => setSelectedComponent(null))

    // Helper to check if a component is internal GrapesJS UI (toolbar, selection box, wrapper)
    const isInternalGjsComp = (comp: any) => {
      if (!comp) return true
      const classes = comp.get ? comp.get('classes')?.toString() || '' : ''
      const type = comp.get ? comp.get('type') : ''
      const name = comp.getName ? comp.getName() : ''
      if (
        classes.includes('gjs-') ||
        type === 'wrapper' ||
        comp.get?.('selectable') === false ||
        name === 'Wrapper' ||
        name === 'Canvas'
      ) {
        return true
      }
      return false
    }

    const getCompLabel = (comp: any) => {
      if (!comp) return 'element'
      const tag = comp.get ? (comp.get('tagName') || '').toLowerCase() : ''
      const id = comp.get ? comp.get('attributes')?.id : ''
      const name = comp.getName ? comp.getName() : ''
      const rawText = comp.get ? (comp.get('content') || '').toString().trim() : ''
      const textSnippet = rawText && rawText.length < 24 && !rawText.includes('<') ? `"${rawText}"` : ''

      if (textSnippet) return `${textSnippet} (${tag || 'text'})`
      if (id) return `<${tag || 'element'}#${id}>`
      if (name && name.toLowerCase() !== 'default' && name.toLowerCase() !== 'wrapper') return `${name} (${tag || 'elem'})`
      return `<${tag || 'element'}>`
    }

    // ── Diff-Based Style Change Tracker ──
    let styleTimer: any = null
    const checkAndTrackStyleChange = (comp: any, propName?: string) => {
      if (!comp || isInternalGjsComp(comp) || isSelectingRef.current) return
      let currentStyleJson = '{}'
      try {
        currentStyleJson = JSON.stringify(comp.getStyle ? comp.getStyle() : {})
      } catch {}

      const previousStyleJson = lastCompStyles.get(comp)
      if (previousStyleJson !== undefined && previousStyleJson === currentStyleJson) {
        // No style properties actually changed (just a selection click!)
        return
      }

      lastCompStyles.set(comp, currentStyleJson)
      clearTimeout(styleTimer)
      styleTimer = setTimeout(() => {
        if (isSelectingRef.current) return
        const label = getCompLabel(comp)
        const detail = propName ? `${label} (${propName})` : label
        pushHistoryRef.current('Change Style', detail, 'style')
      }, 200)
    }

    // 0. Layers Tree -> Native Canvas Syncing
    //    Only runs when user clicks a layer (selectingFromNativeRef is false).
    //    Skipped when selection came from native iframe click (to prevent loop).
    editor.on('component:selected', (comp: any) => {
      if (selectingFromNativeRef.current || !comp) return
      const doc = liveIframeRef.current?.contentDocument
      if (!doc) return

      const nativeEl = findNativeElForGrapesComponent(doc, comp)
      if (nativeEl) {
        selectedNativeElRef.current = nativeEl
        setSelectedNativeEl(nativeEl)
        // Visually highlight in the native iframe (blue outline + toolbar)
        if (liveEditorRef.current) {
          liveEditorRef.current.selectElement(nativeEl)
        }
        try {
          nativeEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } catch {}
      }
    })

    // 1. Text Editing (captures inline RTE typing, content updates, and blur)
    editor.on('rte:disable', (comp: any) => {
      const target = comp || editor.getSelected()
      if (target && !isInternalGjsComp(target)) {
        pushHistoryRef.current('Edit Text', getCompLabel(target), 'edit')
      }
    })
    editor.on('component:update:content', (comp: any) => {
      if (!isInternalGjsComp(comp)) {
        pushHistoryRef.current('Edit Text', getCompLabel(comp), 'edit')
      }
    })

    // 2. Style Changes from GrapesJS (if any)
    editor.on('styleManager:change', (prop: any) => {
      const selected = editor.getSelected()
      const propName = typeof prop === 'string' ? prop : prop?.getProperty ? prop.getProperty() : prop?.get?.('property') || ''
      if (selected) {
        checkAndTrackStyleChange(selected, propName)
      }
    })

    // 3. Move / Drag Elements
    let isDraggingElement = false
    editor.on('component:drag:start', () => {
      isDraggingElement = true
    })
    editor.on('component:drag:end', (comp: any) => {
      isDraggingElement = false
      const target = comp || editor.getSelected()
      if (target && !isInternalGjsComp(target)) {
        pushHistoryRef.current('Move Element', getCompLabel(target), 'move')
      }
    })

    // 4. Add / Remove Elements
    editor.on('component:add', (comp: any) => {
      updateLayerCount()
      if (isInternalGjsComp(comp)) return
      if (isDraggingElement) {
        pushHistoryRef.current('Move Element', getCompLabel(comp), 'move')
      } else {
        pushHistoryRef.current('Add Element', getCompLabel(comp), 'add')
      }
    })

    editor.on('component:remove', (comp: any) => {
      updateLayerCount()
      if (isInternalGjsComp(comp) || isDraggingElement) return
      pushHistoryRef.current('Remove Element', getCompLabel(comp), 'remove')
    })

    // 5. Ctrl + Z (Undo) & Ctrl + Y (Redo) Synchronization
    editor.on('undo', () => {
      if (isJumpingHistoryRef.current) return
      isJumpingHistoryRef.current = true
      setHistoryIndex((prevIdx) => {
        const nextIdx = Math.max(0, prevIdx - 1)
        historyIndexRef.current = nextIdx
        return nextIdx
      })
      setTimeout(() => {
        isJumpingHistoryRef.current = false
      }, 50)
    })

    editor.on('redo', () => {
      if (isJumpingHistoryRef.current) return
      isJumpingHistoryRef.current = true
      setHistorySteps((steps) => {
        setHistoryIndex((prevIdx) => {
          const nextIdx = Math.min(steps.length - 1, prevIdx + 1)
          historyIndexRef.current = nextIdx
          return nextIdx
        })
        return steps
      })
      setTimeout(() => {
        isJumpingHistoryRef.current = false
      }, 50)
    })

    return () => {
      isEditorReadyRef.current = false
      clearTimeout(timer)
      // Invalidate the shared reference before destroy() tears down the model.
      // Children must never observe an editor whose wrapper no longer exists.
      if (editorRef.current === editor) {
        editorRef.current = null
      }
      try {
        editor.destroy()
      } finally {
        // GrapesJS 0.23.x leaves a debounced ClassTagsView check queued after
        // destroy(). It calls these public methods after the internal model has
        // been released, so leave safe tombstone methods on this stale object.
        const staleEditor = editor as any
        staleEditor.getSelected = () => undefined
        staleEditor.getSelectedAll = () => []
      }
    }
  }, [html])

  // ── Preset buttons ────────────────────────────
  const switchPreset = (preset: DevicePreset) => {
    setActivePreset(preset)
    setMode('preset')
    const { w, h } = PRESETS[preset]
    setVpWidth(w)
    setVpHeight(h)
    applyDimensions(w, h)
  }

  const selectDevtoolsPreset = (p: DevtoolsPreset) => {
    setVpWidth(p.w)
    setVpHeight(p.h)
    if (p.w === 1920 && p.h === 1200) {
      setActivePreset('Desktop')
      setMode('preset')
    } else if (p.w === 1199 && p.h === 768) {
      setActivePreset('Tablet')
      setMode('preset')
    } else if (p.w === 329 && p.h === 767) {
      setActivePreset('Mobile')
      setMode('preset')
    } else {
      setMode('free')
    }
    applyDimensions(p.w, p.h)
  }

  // ── Free-transform mode ───────────────────────
  const enterFreeMode = () => {
    setMode('free')
    setActivePreset('Desktop') // deselect presets visually
    applyDimensions(vpWidth, vpHeight)
  }

  // ── Custom dimension inputs ───────────────────
  const commitWidth = (val: string) => {
    const n = parseInt(val, 10)
    if (!n || n < 100) return
    setVpWidth(n)
    setMode('free')
    applyDimensions(n, vpHeight)
  }

  const commitHeight = (val: string) => {
    const n = parseInt(val, 10)
    if (!n || n < 100) return
    setVpHeight(n)
    setMode('free')
    applyDimensions(vpWidth, n)
  }

  const swapDimensions = () => {
    const newW = vpHeight
    const newH = vpWidth
    setVpWidth(newW)
    setVpHeight(newH)
    setMode('free')
    applyDimensions(newW, newH)
  }

  // ── Canva / Photoshop 2D Transform Canvas Panning Engine (Middle Mouse + Spacebar Drag) ──
  const panOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const isSpacePressedRef = useRef(false)
  const zoomRef = useRef(zoom)
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  const updateNativeTransform = useCallback((panX: number, panY: number, zoomLevel: number) => {
    const nativeWrap = liveIframeRef.current?.parentElement
    if (nativeWrap) {
      nativeWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel / 100})`
      nativeWrap.style.transformOrigin = 'top left'
      nativeWrap.style.transition = 'none'
    }
    const liveWrap = liveWebviewRef.current?.parentElement
    if (liveWrap) {
      liveWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel / 100})`
      liveWrap.style.transformOrigin = 'top left'
      liveWrap.style.transition = 'none'
    }
    const frameEl = editorRef.current?.Canvas?.getFrameEl()
    const wrapperEl = frameEl?.parentElement || (document.querySelector('.gjs-frame-wrapper') as HTMLElement)
    if (wrapperEl) {
      wrapperEl.style.transform = `translate(${panX}px, ${panY}px)`
      wrapperEl.style.transition = 'none'
    }
  }, [])

  useEffect(() => { vpWidthRef.current = vpWidth }, [vpWidth])
  useEffect(() => { vpHeightRef.current = vpHeight }, [vpHeight])

  const updateCanvasPanTransform = useCallback((x: number, y: number) => {
    // Clamp pan so the content can't be fully off screen
    const wrap = canvasWrapRef.current
    if (wrap) {
      const vw = wrap.clientWidth
      const vh = wrap.clientHeight
      const scale = zoomRef.current / 100
      const cw = (vpWidthRef.current || 1920) * scale
      const ch = (vpHeightRef.current || 1200) * scale
      // Keep at least 200px of content visible in each axis
      const margin = 200
      x = Math.max(-cw + margin, Math.min(vw - margin, x))
      y = Math.max(-ch + margin, Math.min(vh - margin, y))
    }
    panOffsetRef.current = { x, y }
    updateNativeTransform(x, y, zoomRef.current)
  }, [updateNativeTransform])

  // ── Zoom ──────────────────────────────────────
  const applyZoom = useCallback((level: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
    setZoom(clamped)
    editorRef.current?.Canvas?.setZoom(clamped)
    updateNativeTransform(panOffsetRef.current.x, panOffsetRef.current.y, clamped)
    liveEditorRef.current?.setZoom(clamped)
    bdRedrawRef.current?.()
  }, [updateNativeTransform])

  const applyZoomRef = useRef(applyZoom)
  useEffect(() => { applyZoomRef.current = applyZoom }, [applyZoom])

  const zoomIn = () => applyZoom(zoom + ZOOM_STEP)
  const zoomOut = () => applyZoom(zoom - ZOOM_STEP)
  const zoomFit = () => {
    applyZoom(100)
    updateCanvasPanTransform(0, 0)
  }

  // ── Ctrl+scroll zoom on the canvas area (outer wrapper only; iframe handled in handleNativeIframeLoad) ───────
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const dir = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current + dir))
      applyZoom(nextZoom)
    }

    const outer = canvasWrapRef.current
    if (outer) outer.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      if (outer) outer.removeEventListener('wheel', onWheel)
    }
  }, [applyZoom])

  // ── Global IPC Escape key listener (captures Escape across ALL native & GrapesJS frames) ──
  useEffect(() => {
    if (typeof window.electronAPI?.onGlobalEscape === 'function') {
      const handleEscape = () => {
        const active = document.activeElement as HTMLElement
        const isEditable = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || active.tagName === 'SELECT')
        if (isEditable) return

        const ed: any = editorRef.current
        if (ed) {
          try {
            const sel: any = ed.getSelected()
            if (sel) {
              if (typeof sel.set === 'function') {
                sel.set('status', '')
                sel.set('active', false)
                sel.set('selected', false)
              }
              if (typeof sel.deselect === 'function') sel.deselect()
            }
            if (typeof ed.select === 'function') {
              ed.select([])
              ed.select(undefined as any)
            }
            if (ed.Canvas) {
              if (typeof ed.Canvas.clearSelection === 'function') {
                ed.Canvas.clearSelection()
              }
              const toolsEl = ed.Canvas.getToolsEl ? ed.Canvas.getToolsEl() : null
              if (toolsEl) {
                const toolbars = toolsEl.querySelectorAll('.gjs-toolbar, .gjs-highlighter, .gjs-badge')
                toolbars.forEach((el: HTMLElement) => { el.style.display = 'none' })
              }
            }
            if (typeof ed.trigger === 'function') {
              ed.trigger('component:deselected', sel)
              ed.trigger('component:toggled')
            }
          } catch (err) {
            console.error('[Global Escape] Deselect error:', err)
          }
        }
        setSelectedComponent(null)
        if (bdLockedRef.current) {
          bdLockedRef.current = null
        }
        try {
          window.getSelection()?.removeAllRanges()
          const gFrame = editorRef.current?.Canvas?.getFrameEl() as HTMLIFrameElement
          if (gFrame && gFrame.contentWindow) {
            gFrame.contentWindow.getSelection()?.removeAllRanges()
          }
        } catch (_) {}
      }

      return window.electronAPI.onGlobalEscape(handleEscape)
    }
  }, [])

  // Handle Spacebar key state, Escape key deselect, & Ctrl+A override
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('.edit-beta-root')) return
      const target = e.target as HTMLElement
      const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT')

      // 0. Escape Key: Exit out of element selection & clear inspector highlights
      if (e.key === 'Escape' || e.code === 'Escape') {
        if (!isEditable) {
          const ed: any = editorRef.current
          if (ed) {
            try {
              const sel: any = ed.getSelected()
              if (sel) {
                if (typeof sel.set === 'function') {
                  sel.set('status', '')
                  sel.set('active', false)
                  sel.set('selected', false)
                }
                if (typeof sel.deselect === 'function') sel.deselect()
              }
              if (typeof ed.select === 'function') {
                ed.select([])
                ed.select(undefined as any)
              }
              if (ed.Canvas) {
                if (typeof ed.Canvas.clearSelection === 'function') {
                  ed.Canvas.clearSelection()
                }
                const toolsEl = ed.Canvas.getToolsEl ? ed.Canvas.getToolsEl() : null
                if (toolsEl) {
                  const toolbars = toolsEl.querySelectorAll('.gjs-toolbar, .gjs-highlighter, .gjs-badge')
                  toolbars.forEach((el: HTMLElement) => { el.style.display = 'none' })
                }
              }
              if (typeof ed.trigger === 'function') {
                ed.trigger('component:deselected', sel)
                ed.trigger('component:toggled')
              }
            } catch (err) {
              console.error('[Escape Key] GrapesJS deselect error:', err)
            }
          }
          setSelectedComponent(null)
          if (bdLockedRef.current) {
            bdLockedRef.current = null
          }
          try {
            window.getSelection()?.removeAllRanges()
            const gFrame = editorRef.current?.Canvas?.getFrameEl() as HTMLIFrameElement
            if (gFrame && gFrame.contentWindow) {
              gFrame.contentWindow.getSelection()?.removeAllRanges()
            }
          } catch (_) {}
        }
      }

      // 1. Ctrl + A: Prevent whole-page highlight unless typing in an editable field
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (!isEditable) {
          e.preventDefault()
        }
        return
      }

      // 2. Spacebar: blur active button so spacebar doesn't trigger button clicks
      if (e.code === 'Space') {
        const active = document.activeElement as HTMLElement
        if (active && (active.tagName === 'BUTTON' || active.tagName === 'A' || active.getAttribute('role') === 'button')) {
          active.blur()
        }
        if (!isEditable) {
          e.preventDefault()
          if (!isSpacePressedRef.current) {
            isSpacePressedRef.current = true
            document.body.style.cursor = 'grab'
            liveEditorRef.current?.setPaused(true)
            if (liveWebviewRef.current) liveWebviewRef.current.style.pointerEvents = 'none'
          }
        }
      }

      // 3. Ctrl+Z (Undo) and Ctrl+Y / Ctrl+Shift+Z (Redo)
      if (!isEditable) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          jumpToHistoryIndex(Math.max(0, historyIndexRef.current - 1))
        } else if (
          (e.ctrlKey || e.metaKey) &&
          (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))
        ) {
          e.preventDefault()
          jumpToHistoryIndex(Math.min(historySteps.length - 1, historyIndexRef.current + 1))
        }
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (document.querySelector('.edit-beta-root')) return
      if (e.code === 'Space') {
        isSpacePressedRef.current = false
        document.body.style.cursor = ''
        liveEditorRef.current?.setPaused(false)
        if (liveWebviewRef.current) liveWebviewRef.current.style.pointerEvents = ''
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    // Forward iframe key events so pressing Escape inside the website frame also exits selection
    let iframeWin: Window | null = null
    try {
      const gFrame = editorRef.current?.Canvas?.getFrameEl() as HTMLIFrameElement
      if (gFrame && gFrame.contentWindow) {
        iframeWin = gFrame.contentWindow
        iframeWin.addEventListener('keydown', onKeyDown)
        iframeWin.addEventListener('keyup', onKeyUp)
      }
    } catch (_) {}

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      if (iframeWin) {
        try {
          iframeWin.removeEventListener('keydown', onKeyDown)
          iframeWin.removeEventListener('keyup', onKeyUp)
        } catch (_) {}
      }
    }
  }, [])

  // Handle Middle Mouse Drag & Spacebar + Left Mouse Drag
  // Uses a single shared "pan session" so only one drag can be active at a time.
  const panSessionRef = useRef<{
    startX: number; startY: number; startPanX: number; startPanY: number
    onMove: (ev: MouseEvent) => void; cleanup: () => void
  } | null>(null)

  const startPanSession = useCallback((e: MouseEvent) => {
    // Kill any leaked previous session first
    if (panSessionRef.current) panSessionRef.current.cleanup()

    // screenX/screenY share one coordinate space across the parent window and
    // same-origin iframe. clientX/clientY do not, which caused a jump and
    // intermittent drag loss when a pan began inside the rendered page.
    const startX = e.screenX
    const startY = e.screenY
    const startPanX = panOffsetRef.current.x
    const startPanY = panOffsetRef.current.y

    document.body.style.cursor = 'grabbing'
    liveEditorRef.current?.setPaused(true)
    if (liveIframeRef.current) liveIframeRef.current.style.pointerEvents = 'none'
    if (liveWebviewRef.current) liveWebviewRef.current.style.pointerEvents = 'none'
    const gFrame = editorRef.current?.Canvas?.getFrameEl()
    if (gFrame) gFrame.style.pointerEvents = 'none'

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const dx = ev.screenX - startX
      const dy = ev.screenY - startY
      updateCanvasPanTransform(startPanX + dx, startPanY + dy)
    }

    const cleanup = () => {
      panSessionRef.current = null
      document.body.style.cursor = isSpacePressedRef.current ? 'grab' : ''
      if (!isSpacePressedRef.current) liveEditorRef.current?.setPaused(false)
      if (liveIframeRef.current) liveIframeRef.current.style.pointerEvents = ''
      if (liveWebviewRef.current) liveWebviewRef.current.style.pointerEvents = ''
      const gf = editorRef.current?.Canvas?.getFrameEl()
      if (gf) gf.style.pointerEvents = ''
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('blur', onCancel)
    }

    const onUp = (ev: MouseEvent) => {
      // Accept any button release to be safe — avoid leaked sessions
      cleanup()
    }

    const onCancel = () => cleanup()

    panSessionRef.current = { startX, startY, startPanX, startPanY, onMove, cleanup }

    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('blur', onCancel)
  }, [updateCanvasPanTransform])

  const startPanSessionRef = useRef(startPanSession)
  useEffect(() => { startPanSessionRef.current = startPanSession }, [startPanSession])

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const isMiddleMouse = e.button === 1
      const isSpaceLeftClick = e.button === 0 && isSpacePressedRef.current

      if (!isMiddleMouse && !isSpaceLeftClick) return

      // Edit owns one pan transform for both its host canvas and its
      // out-of-process webview. Let that workspace handle the gesture instead
      // of starting the legacy Layout/Live pan session against hidden frames.
      if ((e.target as Element | null)?.closest?.('.edit-beta-root')) return

      // Don't intercept middle-click on panel inputs (used for scrub-to-adjust values)
      if (isMiddleMouse && !isSpaceLeftClick) {
        const target = e.target as HTMLElement
        if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.closest('.panel-right') || target.closest('.panel-left'))) {
          return
        }
      }

      e.preventDefault()
      e.stopPropagation()
      startPanSessionRef.current(e)
    }

    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('auxclick', onAuxClick, true)

    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      // Clean up any leaked pan session
      if (panSessionRef.current) panSessionRef.current.cleanup()
    }
  }, [])

  // ── Track canvas frame continuously for guide positioning ──
  // Uses requestAnimationFrame to follow panning, scrolling, zoom, and resize.
  // Only sets state when values actually change to avoid unnecessary re-renders.
  useEffect(() => {
    let raf: number
    let lastKey = ''
    const track = () => {
      const f = getCanvasFrame()
      if (f) {
        const key = `${Math.round(f.left)},${Math.round(f.top)},${Math.round(f.width)},${Math.round(f.height)}`
        if (key !== lastKey) {
          lastKey = key
          setCanvasFrame(f)
        }
      }
      raf = requestAnimationFrame(track)
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [getCanvasFrame])

  // ── Figma Design Overlay: Clipboard Paste Handler ──────────────────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Don't intercept paste if user is typing in an input/textarea
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }

      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) return
          const reader = new FileReader()
          reader.onload = () => {
            const imgData = reader.result as string
            setOverlayImage(imgData, 'Figma Design')
            setFigmaCardDismissed(false)
            setFigmaSplitOpen(true)
            setFigmaViewMode('png')
            setOverlayVisible(true)
            setOverlayMode('side-by-side')
            setOverlayPanelOpen(true)
          }
          reader.readAsDataURL(blob)
          return
        }
      }
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [setOverlayImage])

  // Figma overlay file upload handler
  const handleOverlayFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const imgData = reader.result as string
      setOverlayImage(imgData, 'Figma Design')
      setFigmaCardDismissed(false)
      setFigmaSplitOpen(true)
      setFigmaViewMode('png')
      setOverlayVisible(true)
      setOverlayMode('side-by-side')
      setOverlayPanelOpen(true)
    }
    reader.readAsDataURL(file)
    e.target.value = '' // reset so same file can be re-uploaded
  }

  const removeOverlay = () => {
    setOverlayImage(null)
    setOverlayVisible(false)
    setOverlayPanelOpen(false)
  }

  // Close overlay dropdown on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (overlayDropdownRef.current && !overlayDropdownRef.current.contains(e.target as Node)) {
        setOverlayPanelOpen(false)
      }
    }
    if (overlayPanelOpen) {
      document.addEventListener('mousedown', onClick)
    }
    return () => document.removeEventListener('mousedown', onClick)
  }, [overlayPanelOpen])

  // ── Track iframe scroll position for Figma overlay sync ──
  useEffect(() => {
    if (!overlayImage || !overlayVisible) return

    let raf: number
    let lastScrollY = -1

    const getScrollY = (): number => {
      const nativeFrame = liveIframeRef.current
      if (!nativeFrame) return 0
      try {
        const win = nativeFrame.contentWindow
        const doc = nativeFrame.contentDocument || win?.document

        // 1. Primary: Standard window scrollY / pageYOffset (supported by 99% of modern site layouts)
        if (win) {
          if (typeof win.scrollY === 'number' && win.scrollY > 0) return win.scrollY
          if (typeof win.pageYOffset === 'number' && win.pageYOffset > 0) return win.pageYOffset
        }

        // 2. Secondary: Document element & body scrollTop (for standard & legacy DOMs)
        if (doc) {
          if (doc.documentElement && doc.documentElement.scrollTop > 0) return doc.documentElement.scrollTop
          if (doc.body && doc.body.scrollTop > 0) return doc.body.scrollTop
        }

        // 3. Fallback: Scrollable container elements (#page, #app, #root, main, .wrapper, etc.)
        if (doc) {
          const scrollable = doc.querySelectorAll('main, #app, #root, #page, .site, .wrapper, [style*="overflow"]')
          for (let i = 0; i < scrollable.length; i++) {
            const st = scrollable[i].scrollTop
            if (st > 0) return st
          }
        }
      } catch {}
      return 0
    }

    const updateScroll = () => {
      const sy = getScrollY()
      if (sy !== lastScrollY) {
        lastScrollY = sy
        setIframeScrollY(sy)
      }
    }

    // Attach passive scroll listeners directly to iframe window & document
    const nativeFrame = liveIframeRef.current
    let iframeWin: Window | null = null
    let iframeDoc: Document | null = null

    try {
      iframeWin = nativeFrame?.contentWindow || null
      iframeDoc = nativeFrame?.contentDocument || iframeWin?.document || null

      if (iframeWin) iframeWin.addEventListener('scroll', updateScroll, { passive: true })
      if (iframeDoc) iframeDoc.addEventListener('scroll', updateScroll, { passive: true })
    } catch {}

    // Continuous animation frame loop to catch smooth scrolling, momentum, and dynamic script scrolls
    const loop = () => {
      updateScroll()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      try {
        if (iframeWin) iframeWin.removeEventListener('scroll', updateScroll)
        if (iframeDoc) iframeDoc.removeEventListener('scroll', updateScroll)
      } catch {}
    }
  }, [overlayImage, overlayVisible, html])

  // Forward wheel scrolling from canvas container into iframe so scrolling works anywhere on canvas
  useEffect(() => {
    if (!overlayImage || !overlayVisible) return
    const inner = canvasInnerRef.current
    if (!inner) return

    const onCanvasWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return // Allow Ctrl+Scroll for zoom
      const win = liveIframeRef.current?.contentWindow
      if (win) {
        try {
          win.scrollBy({ top: e.deltaY, behavior: 'auto' })
        } catch {}
      }
    }

    inner.addEventListener('wheel', onCanvasWheel, { passive: true })
    return () => inner.removeEventListener('wheel', onCanvasWheel)
  }, [overlayImage, overlayVisible])

  // ── Track native canvas frame wrapper position for free transform ──────
  useEffect(() => {
    if (mode !== 'free') {
      setFrameRect(null)
      return
    }
    const wrapEl = canvasWrapRef.current
    if (!wrapEl) return

    let raf: number
    const track = () => {
      const frameWrapper = liveIframeRef.current?.parentElement || editorRef.current?.Canvas.getFrameEl()?.parentElement
      if (!frameWrapper || !wrapEl) { raf = requestAnimationFrame(track); return }

      const wrapRect = wrapEl.getBoundingClientRect()
      const fRect = frameWrapper.getBoundingClientRect()

      setFrameRect({
        top: fRect.top - wrapRect.top,
        left: fRect.left - wrapRect.left,
        width: fRect.width,
        height: fRect.height
      })
      raf = requestAnimationFrame(track)
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  // ── Free-transform drag handles ───────────────
  const dragRef = useRef<{
    edge: 'right' | 'bottom' | 'left' | 'top'
    startX: number; startY: number
    startW: number; startH: number
  } | null>(null)

  const onHandleMouseDown = (
    edge: 'right' | 'bottom' | 'left' | 'top',
    e: React.MouseEvent
  ) => {
    e.preventDefault()
    dragRef.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startW: vpWidth,
      startH: vpHeight
    }

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      let newW = d.startW
      let newH = d.startH
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY

      if (d.edge === 'right') newW = Math.max(200, d.startW + dx)
      if (d.edge === 'left') newW = Math.max(200, d.startW - dx)
      if (d.edge === 'bottom') newH = Math.max(200, d.startH + dy)
      if (d.edge === 'top') newH = Math.max(200, d.startH - dy)

      setVpWidth(Math.round(newW))
      setVpHeight(Math.round(newH))
      applyDimensions(Math.round(newW), Math.round(newH))
    }

    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Missing fonts ─────────────────────────────
  const handleLoadFonts = async () => {
    const editor = editorRef.current
    if (!editor || missingFonts.length === 0) return
    setLoadingFonts(true)
    try {
      const stillMissing = await loadMissingFonts(editor, missingFonts)
      setMissingFonts(stillMissing)
      setFontsAttempted(true)
    } finally {
      setLoadingFonts(false)
    }
  }

  // ── Panel resize (with Pointer-Events Suppressor & Smooth Throttle) ──
  const onPanelResizeStart = (side: 'left' | 'right' | 'bottom' | 'figma', e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    panelDragRef.current = {
      side,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: side === 'left' ? leftPanelWidth : side === 'right' ? rightPanelWidth : figmaSplitWidth,
      startHeight: bottomSheetHeight
    }

    document.body.classList.add('is-panel-resizing')
    document.body.style.cursor = side === 'bottom' ? 'row-resize' : 'col-resize'

    // Suppress pointer events on ALL iframes and webviews in the document during resize drag!
    const allIframes = document.querySelectorAll('iframe, webview')
    allIframes.forEach((el: any) => {
      try { el.style.pointerEvents = 'none' } catch (_) {}
    })

    let rafId = 0
    let latestX = e.clientX
    let latestY = e.clientY

    const onMove = (ev: MouseEvent) => {
      latestX = ev.clientX
      latestY = ev.clientY

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0
          const d = panelDragRef.current
          if (!d) return

          if (d.side === 'bottom') {
            const dy = latestY - d.startY
            const rawHeight = d.startHeight - dy

            // Hard-drag collapse threshold: dragging down below 70px snaps panel closed
            if (rawHeight < 70) {
              setBottomSheetOpen(false)
              setBottomSheetHeight(300)
              onUp()
              return
            }

            const newHeight = Math.max(120, Math.min(850, rawHeight))
            setBottomSheetHeight(newHeight)
          } else if (d.side === 'left') {
            const dx = latestX - d.startX
            const rawWidth = d.startWidth + dx

            // Hard-drag collapse threshold: dragging left below 90px snaps panel closed
            if (rawWidth < 90) {
              setLeftPanelOpen(false)
              setLeftPanelWidth(260)
              onUp()
              return
            }

            const newWidth = Math.max(180, Math.min(600, rawWidth))
            setLeftPanelWidth(newWidth)
          } else if (d.side === 'right') {
            const dx = latestX - d.startX
            const rawWidth = d.startWidth - dx

            // Hard-drag collapse threshold: dragging right below 90px snaps panel closed
            if (rawWidth < 90) {
              setRightPanelOpen(false)
              setRightPanelWidth(260)
              onUp()
              return
            }

            const newWidth = Math.max(180, Math.min(650, rawWidth))
            setRightPanelWidth(newWidth)
          } else if (d.side === 'figma') {
            const dx = latestX - d.startX
            const rawWidth = d.startWidth - dx

            if (rawWidth < 120) {
              setFigmaSplitOpen(false)
              setFigmaSplitWidth(550)
              onUp()
              return
            }

            const newWidth = Math.max(250, Math.min(1100, rawWidth))
            setFigmaSplitWidth(newWidth)
          }
        })
      }
    }

    const onUp = () => {
      panelDragRef.current = null
      document.body.classList.remove('is-panel-resizing')
      document.body.style.cursor = ''

      allIframes.forEach((el: any) => {
        try { el.style.pointerEvents = '' } catch (_) {}
      })

      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('blur', onUp)
    }

    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('blur', onUp)
  }

  // ── F5 / Ctrl+R hard refresh ───────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) {
        e.preventDefault()
        if (!resetting) handleReset()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Reset capture ─────────────────────────────
  const handleReset = async () => {
    setResetting(true)
    await onReset()
    setResetting(false)
  }

  // ── Ruler drawing ────────────────────────────
  const drawRuler = useCallback((
    canvas: HTMLCanvasElement | null,
    orientation: 'horizontal' | 'vertical'
  ) => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    ctx.fillStyle = '#1e1e1e'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = '#555'
    ctx.fillStyle = '#888'
    ctx.font = '9px sans-serif'
    ctx.lineWidth = 1

    const length = orientation === 'horizontal' ? w : h
    const scale = zoom / 100

    for (let px = 0; px < length; px++) {
      const logical = px / scale
      const roundedLogical = Math.round(logical)
      if (roundedLogical % 50 !== 0) continue
      const prevPx = px - 1
      if (prevPx >= 0 && Math.round(prevPx / scale) === roundedLogical) continue

      const isMajor = roundedLogical % 100 === 0
      ctx.beginPath()
      if (orientation === 'horizontal') {
        const tickH = isMajor ? 12 : 6
        ctx.moveTo(px + 0.5, h)
        ctx.lineTo(px + 0.5, h - tickH)
        ctx.stroke()
        if (isMajor) {
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.fillText(String(roundedLogical), px + 2, 2)
        }
      } else {
        const tickW = isMajor ? 12 : 6
        ctx.moveTo(w, px + 0.5)
        ctx.lineTo(w - tickW, px + 0.5)
        ctx.stroke()
        if (isMajor) {
          ctx.save()
          ctx.translate(2, px + 2)
          ctx.rotate(-Math.PI / 2)
          ctx.textAlign = 'right'
          ctx.textBaseline = 'top'
          ctx.fillText(String(roundedLogical), 0, 0)
          ctx.restore()
        }
      }
    }

    // Center snap marker (blue triangle)
    const center = length / 2
    ctx.fillStyle = '#4C8BF5'
    if (orientation === 'horizontal') {
      ctx.beginPath()
      ctx.moveTo(center, h)
      ctx.lineTo(center - 3, h - 6)
      ctx.lineTo(center + 3, h - 6)
      ctx.closePath()
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(w, center)
      ctx.lineTo(w - 6, center - 3)
      ctx.lineTo(w - 6, center + 3)
      ctx.closePath()
      ctx.fill()
    }

    // Border line
    ctx.strokeStyle = '#333'
    ctx.beginPath()
    if (orientation === 'horizontal') {
      ctx.moveTo(0, h - 0.5)
      ctx.lineTo(w, h - 0.5)
    } else {
      ctx.moveTo(w - 0.5, 0)
      ctx.lineTo(w - 0.5, h)
    }
    ctx.stroke()
  }, [zoom])

  // Draw rulers + redraw on resize
  useEffect(() => {
    if (!rulersOn) return
    const draw = () => {
      drawRuler(hRulerRef.current, 'horizontal')
      drawRuler(vRulerRef.current, 'vertical')
    }
    draw()
    const ro = new ResizeObserver(draw)
    if (canvasWrapRef.current) ro.observe(canvasWrapRef.current)
    return () => ro.disconnect()
  }, [rulersOn, zoom, drawRuler])

  // ── Drag-from-ruler to create guides (Photoshop-style) ──
  // Guides are stored as fractions (0–1) of the iframe content area.
  // This makes them responsive to zoom and device changes.
  const SNAP_THRESHOLD = 8

  const toFraction = (screenPx: number, frameOffset: number, frameDim: number): number => {
    return (screenPx - frameOffset) / frameDim
  }

  const snapCenter = (frac: number, frameDim: number): number => {
    const threshold = SNAP_THRESHOLD / frameDim
    return Math.abs(frac - 0.5) < threshold ? 0.5 : frac
  }

  // Top ruler → drag down → creates HORIZONTAL guide (axis 'x')
  const onHRulerMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!guidesOn) return
    e.preventDefault()
    const inner = canvasInnerRef.current
    if (!inner) return
    const frame = getCanvasFrame()
    if (!frame) return

    const iframe = editorRef.current?.Canvas.getFrameEl()
    if (iframe) iframe.style.pointerEvents = 'none'

    const innerRect = inner.getBoundingClientRect()
    let frac = toFraction(e.clientY - innerRect.top, frame.top, frame.height)
    frac = snapCenter(frac, frame.height)
    setDraggingGuide({ axis: 'x', position: frac })

    const onMove = (ev: MouseEvent) => {
      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) return
      let fr = toFraction(ev.clientY - rect.top, f.top, f.height)
      fr = snapCenter(fr, f.height)
      setDraggingGuide({ axis: 'x', position: fr })
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (iframe) iframe.style.pointerEvents = ''

      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) { setDraggingGuide(null); return }
      let fr = toFraction(ev.clientY - rect.top, f.top, f.height)
      fr = snapCenter(fr, f.height)

      if (fr > -0.05 && fr < 1.05) {
        setGuides((prev) => [...prev, { axis: 'x', position: Math.max(0, Math.min(1, fr)) }])
      }
      setDraggingGuide(null)
    }

    document.body.style.cursor = 'row-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Left ruler → drag right → creates VERTICAL guide (axis 'y')
  const onVRulerMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!guidesOn) return
    e.preventDefault()
    const inner = canvasInnerRef.current
    if (!inner) return
    const frame = getCanvasFrame()
    if (!frame) return

    const iframe = editorRef.current?.Canvas.getFrameEl()
    if (iframe) iframe.style.pointerEvents = 'none'

    const innerRect = inner.getBoundingClientRect()
    let frac = toFraction(e.clientX - innerRect.left, frame.left, frame.width)
    frac = snapCenter(frac, frame.width)
    setDraggingGuide({ axis: 'y', position: frac })

    const onMove = (ev: MouseEvent) => {
      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) return
      let fr = toFraction(ev.clientX - rect.left, f.left, f.width)
      fr = snapCenter(fr, f.width)
      setDraggingGuide({ axis: 'y', position: fr })
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (iframe) iframe.style.pointerEvents = ''

      const rect = inner.getBoundingClientRect()
      const f = getCanvasFrame()
      if (!f) { setDraggingGuide(null); return }
      let fr = toFraction(ev.clientX - rect.left, f.left, f.width)
      fr = snapCenter(fr, f.width)

      if (fr > -0.05 && fr < 1.05) {
        setGuides((prev) => [...prev, { axis: 'y', position: Math.max(0, Math.min(1, fr)) }])
      }
      setDraggingGuide(null)
    }

    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const removeGuide = (index: number) => {
    setGuides((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Ruler dropdown: close on outside click ──
  useEffect(() => {
    if (!rulerDropdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (rulerDropdownRef.current && !rulerDropdownRef.current.contains(e.target as Node)) {
        setRulerDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [rulerDropdownOpen])

  // ── Add guide layout (Photoshop-style grid) ──
  const addGuideLayout = () => {
    const frame = getCanvasFrame()
    if (!frame) return
    // Content dimensions at 100% zoom
    const contentW = frame.width / (zoom / 100)
    const contentH = frame.height / (zoom / 100)
    const newGuides: Guide[] = []

    const mFracW = contentW > 0 ? layoutMargin / contentW : 0
    const mFracH = contentH > 0 ? layoutMargin / contentH : 0

    if (layoutColumns > 1) {
      const usable = 1 - mFracW * 2
      const step = usable / layoutColumns
      for (let i = 1; i < layoutColumns; i++) {
        newGuides.push({ axis: 'y', position: mFracW + step * i })
      }
    }

    if (layoutRows > 1) {
      const usable = 1 - mFracH * 2
      const step = usable / layoutRows
      for (let i = 1; i < layoutRows; i++) {
        newGuides.push({ axis: 'x', position: mFracH + step * i })
      }
    }

    if (layoutMargin > 0) {
      newGuides.push({ axis: 'y', position: mFracW })
      newGuides.push({ axis: 'y', position: 1 - mFracW })
      newGuides.push({ axis: 'x', position: mFracH })
      newGuides.push({ axis: 'x', position: 1 - mFracH })
    }

    if (layoutClear) {
      setGuides(newGuides)
    } else {
      setGuides((prev) => [...prev, ...newGuides])
    }
    setGuidesOn(true)
    setGuidesAlwaysVisible(true)
    setAddGuidesOpen(false)
  }

  // ── Font Inspector ───────────────────────────
  const activateFontInspector = useCallback(() => {
    const iframeDoc = liveIframeRef.current?.contentDocument || editorRef.current?.Canvas.getFrameEl()?.contentDocument
    if (!iframeDoc) return

    // Clean up any previous badges/tooltip
    iframeDoc.querySelectorAll('.__fi-badge').forEach((el) => el.remove())
    const existingTooltip = iframeDoc.querySelector('.__fi-tooltip')
    if (existingTooltip) existingTooltip.remove()

    const TEXT_TAGS = ['H1','H2','H3','H4','H5','H6','P','SPAN','A','LI','BLOCKQUOTE','LABEL','BUTTON','TD','TH']

    // Inject badge style
    let styleEl = iframeDoc.querySelector('#__fi-styles') as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = iframeDoc.createElement('style')
      styleEl.id = '__fi-styles'
      iframeDoc.head.appendChild(styleEl)
    }
    styleEl.textContent = `
      .__fi-badge {
        position: absolute;
        top: 0;
        right: 0;
        background: rgba(0,0,0,0.75);
        color: #fff;
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 3px;
        pointer-events: none;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.3;
        white-space: nowrap;
      }
      .__fi-tooltip {
        position: absolute;
        background: #1a1a1a;
        color: #fff;
        font-size: 11px;
        padding: 6px 8px;
        border-radius: 4px;
        z-index: 9999999;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.5;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        border: 1px solid #333;
      }
      .__fi-tooltip-swatch {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        border: 1px solid rgba(255,255,255,0.3);
        vertical-align: middle;
        margin-right: 4px;
      }
    `

    const formatFontBadge = (cs: CSSStyleDeclaration): string => {
      const fontFamily = cs.fontFamily || ''
      const shortFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim() || 'Sans'
      const fontSize = cs.fontSize || ''
      const rawWeight = cs.fontWeight || ''

      let weightLabel = rawWeight
      if (rawWeight === '700' || rawWeight === 'bold') weightLabel = 'Bold (700)'
      else if (rawWeight === '400' || rawWeight === 'normal') weightLabel = '400'
      else if (rawWeight === '600') weightLabel = 'SemiBold (600)'

      return `${shortFont} | ${fontSize} | ${weightLabel}`
    }

    // Walk DOM and inject badges
    const elements = iframeDoc.querySelectorAll(TEXT_TAGS.join(','))
    const processedSet = new Set<Element>()

    elements.forEach((el) => {
      if (processedSet.has(el)) return
      processedSet.add(el)
      const htmlEl = el as HTMLElement
      const cs = iframeDoc.defaultView?.getComputedStyle(htmlEl)
      if (!cs) return

      const fontFamily = cs.fontFamily
      const shortFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim()
      if (!shortFont) return

      // Make the element position relative if static so badge can position absolutely
      const pos = cs.position
      if (pos === 'static') {
        htmlEl.style.position = 'relative'
        htmlEl.setAttribute('data-fi-was-static', 'true')
      }

      const badge = iframeDoc.createElement('span')
      badge.className = '__fi-badge'
      badge.textContent = formatFontBadge(cs)
      htmlEl.appendChild(badge)
    })

    // Also check divs with direct text content
    iframeDoc.querySelectorAll('div').forEach((el) => {
      if (processedSet.has(el)) return
      // Check if div has direct text nodes
      let hasDirectText = false
      el.childNodes.forEach((child) => {
        if (child.nodeType === 3 && child.textContent && child.textContent.trim().length > 0) {
          hasDirectText = true
        }
      })
      if (!hasDirectText) return
      processedSet.add(el)
      const htmlEl = el as HTMLElement
      const cs = iframeDoc.defaultView?.getComputedStyle(htmlEl)
      if (!cs) return
      const fontFamily = cs.fontFamily
      const shortFont = fontFamily.split(',')[0].replace(/['"]/g, '').trim()
      if (!shortFont) return
      const pos = cs.position
      if (pos === 'static') {
        htmlEl.style.position = 'relative'
        htmlEl.setAttribute('data-fi-was-static', 'true')
      }
      const badge = iframeDoc.createElement('span')
      badge.className = '__fi-badge'
      badge.textContent = formatFontBadge(cs)
      htmlEl.appendChild(badge)
    })

    // Create tooltip element
    const tooltip = iframeDoc.createElement('div')
    tooltip.className = '__fi-tooltip'
    tooltip.style.display = 'none'
    iframeDoc.body.appendChild(tooltip)

    // Hover handlers
    const onMouseOver = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || target.classList.contains('__fi-badge') || target.classList.contains('__fi-tooltip')) return
      const tagName = target.tagName
      const isTextEl = TEXT_TAGS.includes(tagName) ||
        (tagName === 'DIV' && (() => {
          let has = false
          target.childNodes.forEach((c) => { if (c.nodeType === 3 && c.textContent?.trim()) has = true })
          return has
        })())
      if (!isTextEl) return

      const cs = iframeDoc.defaultView?.getComputedStyle(target)
      if (!cs) return

      const rect = target.getBoundingClientRect()
      const tag = target.tagName.toLowerCase()
      const filteredClasses = Array.from(target.classList).filter(c => !c.startsWith('__fi-'))
      const cls = filteredClasses.length > 0
        ? '.' + filteredClasses.join('.')
        : ''
      const selector = tag + cls
      const dims = `${rect.width.toFixed(2)} \u00d7 ${rect.height.toFixed(2)}`
      const color = cs.color
      const fontSize = cs.fontSize
      const fontFamily = cs.fontFamily

      tooltip.innerHTML = `
        <div style="font-weight:600;margin-bottom:2px">${selector}</div>
        <div>${dims}</div>
        <div><span class="__fi-tooltip-swatch" style="background:${color}"></span>${color}</div>
        <div>${fontSize} ${fontFamily}</div>
      `
      tooltip.style.display = 'block'

      // Position the tooltip
      const scrollX = iframeDoc.defaultView?.scrollX || 0
      const scrollY = iframeDoc.defaultView?.scrollY || 0
      let tipX = rect.left + scrollX
      let tipY = rect.top + scrollY - tooltip.offsetHeight - 6
      if (tipY < scrollY) tipY = rect.bottom + scrollY + 6
      tooltip.style.left = tipX + 'px'
      tooltip.style.top = tipY + 'px'
    }

    const onMouseOut = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || target.classList.contains('__fi-tooltip')) return
      tooltip.style.display = 'none'
    }

    iframeDoc.addEventListener('mouseover', onMouseOver, true)
    iframeDoc.addEventListener('mouseout', onMouseOut, true)

    // Return cleanup function
    const cleanup = () => {
      iframeDoc.removeEventListener('mouseover', onMouseOver, true)
      iframeDoc.removeEventListener('mouseout', onMouseOut, true)
      iframeDoc.querySelectorAll('.__fi-badge').forEach((el) => el.remove())
      const tip = iframeDoc.querySelector('.__fi-tooltip')
      if (tip) tip.remove()
      const style = iframeDoc.querySelector('#__fi-styles')
      if (style) style.remove()
      // Restore position:static
      iframeDoc.querySelectorAll('[data-fi-was-static]').forEach((el) => {
        ;(el as HTMLElement).style.position = ''
        el.removeAttribute('data-fi-was-static')
      })
    }

    fontInspectorCleanupRef.current = cleanup
  }, [])

  const deactivateFontInspector = useCallback(() => {
    if (fontInspectorCleanupRef.current) {
      fontInspectorCleanupRef.current()
      fontInspectorCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    if (fontInspectorOn) {
      // Small delay to ensure iframe is loaded
      const timer = setTimeout(() => activateFontInspector(), 100)
      return () => clearTimeout(timer)
    } else {
      deactivateFontInspector()
    }
  }, [fontInspectorOn, activateFontInspector, deactivateFontInspector])

  // Clean up font inspector when editor changes
  useEffect(() => {
    return () => {
      deactivateFontInspector()
    }
  }, [html, deactivateFontInspector])

  const toggleFontInspector = () => {
    setFontInspectorOn((prev) => !prev)
  }

  // ── Keep bdOptsRef in sync and trigger redraw ──
  useEffect(() => {
    bdOptsRef.current = { showMargins, showPaddings, showDimensions, showGaps }
    if (boundariesOn && bdRedrawRef.current) {
      bdRedrawRef.current()
    }
  }, [showMargins, showPaddings, showDimensions, showGaps, boundariesOn])

  // ── Boundaries dropdown: close on outside click ──
  useEffect(() => {
    if (!boundariesDropdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (boundariesDropdownRef.current && !boundariesDropdownRef.current.contains(e.target as Node)) {
        setBoundariesDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [boundariesDropdownOpen])

  // ── Boundaries inspector ─────────────────────
  const activateBoundaries = useCallback(() => {
    const iframeDoc = liveIframeRef.current?.contentDocument || editorRef.current?.Canvas.getFrameEl()?.contentDocument
    if (!iframeDoc) return

    // Clean up any previous
    iframeDoc.querySelectorAll('.__bd-container').forEach((el) => el.remove())
    const oldStyle = iframeDoc.querySelector('#__bd-styles')
    if (oldStyle) oldStyle.remove()

    // Inject styles into iframe
    const styleEl = iframeDoc.createElement('style')
    styleEl.id = '__bd-styles'
    styleEl.textContent = `
      .__bd-margin { background: rgba(255, 165, 0, 0.15); }
      .__bd-padding { background: rgba(0, 200, 83, 0.15); }
      .__bd-content { background: rgba(76, 139, 245, 0.1); }
      .__bd-label {
        position: absolute;
        color: #fff;
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 2px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.4;
      }
      .__bd-dim-label { background: rgba(76, 139, 245, 0.9); }
      .__bd-margin-label { background: rgba(255, 165, 0, 0.9); }
      .__bd-padding-label { background: rgba(0, 200, 83, 0.9); color: #000; }
      .__bd-gap-label { background: rgba(255, 80, 80, 0.9); }
      .__bd-outline { position: absolute; pointer-events: none; border: 1px solid rgba(76, 139, 245, 0.6); z-index: 999998; }
    `
    iframeDoc.head.appendChild(styleEl)

    // Container for overlays
    const container = iframeDoc.createElement('div')
    container.className = '__bd-container'
    container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999998;'
    iframeDoc.body.appendChild(container)

    bdContainerRef.current = container
    bdDocRef.current = iframeDoc
    bdLockedRef.current = null
    bdHoveredRef.current = null

    const mkDiv = (cls: string, l: number, t: number, w: number, h: number) => {
      const d = iframeDoc.createElement('div')
      d.className = cls
      d.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:${Math.max(0, w)}px;height:${Math.max(0, h)}px;pointer-events:none;`
      container.appendChild(d)
    }

    const mkLabel = (cls: string, text: string, l: number, t: number) => {
      const d = iframeDoc.createElement('div')
      d.className = `__bd-label ${cls}`
      d.textContent = text
      const invScale = 100 / Math.max(1, zoomRef.current)
      d.style.cssText = `position:absolute;left:${l}px;top:${t}px;pointer-events:none;z-index:999999;transform:scale(${invScale});transform-origin:center center;`
      container.appendChild(d)
    }

    const drawBounds = (el: HTMLElement) => {
      const cs = iframeDoc.defaultView?.getComputedStyle(el)
      if (!cs) return
      const opts = bdOptsRef.current

      const rect = el.getBoundingClientRect()
      const sx = iframeDoc.defaultView?.scrollX || 0
      const sy = iframeDoc.defaultView?.scrollY || 0

      const mt = parseFloat(cs.marginTop) || 0
      const mr = parseFloat(cs.marginRight) || 0
      const mb = parseFloat(cs.marginBottom) || 0
      const ml = parseFloat(cs.marginLeft) || 0
      const pt = parseFloat(cs.paddingTop) || 0
      const pr = parseFloat(cs.paddingRight) || 0
      const pb = parseFloat(cs.paddingBottom) || 0
      const pl = parseFloat(cs.paddingLeft) || 0
      const bt = parseFloat(cs.borderTopWidth) || 0
      const brw = parseFloat(cs.borderRightWidth) || 0
      const bb = parseFloat(cs.borderBottomWidth) || 0
      const blw = parseFloat(cs.borderLeftWidth) || 0

      const x = rect.left + sx
      const y = rect.top + sy
      const w = rect.width
      const h = rect.height

      // Blue outline around element
      mkDiv('__bd-outline', x, y, w, h)

      if (opts.showMargins) {
        if (mt > 0) { mkDiv('__bd-margin', x, y - mt, w, mt); mkLabel('__bd-margin-label', String(Math.round(mt)), x + w / 2 - 8, y - mt + mt / 2 - 7) }
        if (mb > 0) { mkDiv('__bd-margin', x, y + h, w, mb); mkLabel('__bd-margin-label', String(Math.round(mb)), x + w / 2 - 8, y + h + mb / 2 - 7) }
        if (ml > 0) { mkDiv('__bd-margin', x - ml, y, ml, h); mkLabel('__bd-margin-label', String(Math.round(ml)), x - ml + ml / 2 - 8, y + h / 2 - 7) }
        if (mr > 0) { mkDiv('__bd-margin', x + w, y, mr, h); mkLabel('__bd-margin-label', String(Math.round(mr)), x + w + mr / 2 - 8, y + h / 2 - 7) }
      }

      if (opts.showPaddings) {
        const ix = x + blw
        const iy = y + bt
        const iw = w - blw - brw
        const ih = h - bt - bb
        if (pt > 0) { mkDiv('__bd-padding', ix, iy, iw, pt); mkLabel('__bd-padding-label', String(Math.round(pt)), ix + iw / 2 - 8, iy + pt / 2 - 7) }
        if (pb > 0) { mkDiv('__bd-padding', ix, iy + ih - pb, iw, pb); mkLabel('__bd-padding-label', String(Math.round(pb)), ix + iw / 2 - 8, iy + ih - pb + pb / 2 - 7) }
        if (pl > 0) { mkDiv('__bd-padding', ix, iy + pt, pl, ih - pt - pb); mkLabel('__bd-padding-label', String(Math.round(pl)), ix + pl / 2 - 8, iy + ih / 2 - 7) }
        if (pr > 0) { mkDiv('__bd-padding', ix + iw - pr, iy + pt, pr, ih - pt - pb); mkLabel('__bd-padding-label', String(Math.round(pr)), ix + iw - pr + pr / 2 - 8, iy + ih / 2 - 7) }
      }

      if (opts.showDimensions) {
        const cw = w - blw - brw - pl - pr
        const ch = h - bt - bb - pt - pb
        mkDiv('__bd-content', x + blw + pl, y + bt + pt, cw, ch)
        mkLabel('__bd-dim-label', `${Math.round(w)} \u00d7 ${Math.round(h)}`, x + w / 2 - 20, y - 18)
      }
    }

    const drawGapLines = (el1: HTMLElement, el2: HTMLElement) => {
      const r1 = el1.getBoundingClientRect()
      const r2 = el2.getBoundingClientRect()
      const sx = iframeDoc.defaultView?.scrollX || 0
      const sy = iframeDoc.defaultView?.scrollY || 0

      const cy1 = r1.top + r1.height / 2 + sy
      const cx1 = r1.left + r1.width / 2 + sx
      const cy2 = r2.top + r2.height / 2 + sy
      const cx2 = r2.left + r2.width / 2 + sx
      const midY = (cy1 + cy2) / 2
      const midX = (cx1 + cx2) / 2

      let hGap = 0, hStart = 0
      if (r2.left > r1.right) { hGap = r2.left - r1.right; hStart = r1.right + sx }
      else if (r1.left > r2.right) { hGap = r1.left - r2.right; hStart = r2.right + sx }

      let vGap = 0, vStart = 0
      if (r2.top > r1.bottom) { vGap = r2.top - r1.bottom; vStart = r1.bottom + sy }
      else if (r1.top > r2.bottom) { vGap = r1.top - r2.bottom; vStart = r2.bottom + sy }

      const mkLine = (l: number, t: number, lw: number, lh: number, dashed: boolean) => {
        const d = iframeDoc.createElement('div')
        d.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:${lw}px;height:${lh}px;pointer-events:none;z-index:999999;`
        if (lw > 0 && lh === 0) d.style.borderTop = dashed ? '1px dashed rgba(255,80,80,0.9)' : '1px solid rgba(255,80,80,0.9)'
        if (lh > 0 && lw === 0) d.style.borderLeft = dashed ? '1px dashed rgba(255,80,80,0.9)' : '1px solid rgba(255,80,80,0.9)'
        container.appendChild(d)
      }

      if (hGap > 0) {
        mkLine(hStart, midY, hGap, 0, true)
        mkLine(hStart, midY - 4, 0, 8, false)
        mkLine(hStart + hGap, midY - 4, 0, 8, false)
        mkLabel('__bd-gap-label', `${Math.round(hGap)}px`, hStart + hGap / 2 - 15, midY - 18)
      }

      if (vGap > 0) {
        mkLine(midX, vStart, 0, vGap, true)
        mkLine(midX - 4, vStart, 8, 0, false)
        mkLine(midX - 4, vStart + vGap, 8, 0, false)
        mkLabel('__bd-gap-label', `${Math.round(vGap)}px`, midX + 6, vStart + vGap / 2 - 7)
      }

      if (hGap === 0 && vGap === 0) {
        const dx = Math.abs(cx1 - cx2)
        const dy = Math.abs(cy1 - cy2)
        if (dx > 1) {
          mkLine(Math.min(cx1, cx2), midY, dx, 0, true)
          mkLabel('__bd-gap-label', `${Math.round(dx)}px`, Math.min(cx1, cx2) + dx / 2 - 15, midY - 18)
        }
        if (dy > 1) {
          mkLine(midX, Math.min(cy1, cy2), 0, dy, true)
          mkLabel('__bd-gap-label', `${Math.round(dy)}px`, midX + 6, Math.min(cy1, cy2) + dy / 2 - 7)
        }
      }
    }

    const redraw = () => {
      container.innerHTML = ''
      const locked = bdLockedRef.current
      const hovered = bdHoveredRef.current
      if (locked && !iframeDoc.contains(locked)) { bdLockedRef.current = null; return }
      if (locked) drawBounds(locked)
      if (hovered && hovered !== locked && iframeDoc.contains(hovered)) drawBounds(hovered)
      if (locked && hovered && hovered !== locked && iframeDoc.contains(hovered) && bdOptsRef.current.showGaps) {
        drawGapLines(locked, hovered)
      }
    }

    bdRedrawRef.current = redraw

    const onMouseOver = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || target.closest('.__bd-container') || target.tagName === 'HTML' || target.tagName === 'BODY') return
      bdHoveredRef.current = target
      redraw()
    }

    const onMouseOut = () => {
      bdHoveredRef.current = null
      redraw()
    }

    const onClick = (e: Event) => {
      const me = e as MouseEvent
      const target = me.target as HTMLElement
      if (!target || target.closest('.__bd-container') || target.tagName === 'HTML' || target.tagName === 'BODY') return
      if (me.shiftKey && bdLockedRef.current) {
        bdHoveredRef.current = target
      } else {
        bdLockedRef.current = target
        bdHoveredRef.current = null
      }
      redraw()
    }

    iframeDoc.addEventListener('mouseover', onMouseOver, true)
    iframeDoc.addEventListener('mouseout', onMouseOut, true)
    iframeDoc.addEventListener('click', onClick, true)

    boundariesCleanupRef.current = () => {
      iframeDoc.removeEventListener('mouseover', onMouseOver, true)
      iframeDoc.removeEventListener('mouseout', onMouseOut, true)
      iframeDoc.removeEventListener('click', onClick, true)
      container.remove()
      const style = iframeDoc.querySelector('#__bd-styles')
      if (style) style.remove()
      bdContainerRef.current = null
      bdDocRef.current = null
      bdLockedRef.current = null
      bdHoveredRef.current = null
      bdRedrawRef.current = null
    }
  }, [])

  const deactivateBoundaries = useCallback(() => {
    if (boundariesCleanupRef.current) {
      boundariesCleanupRef.current()
      boundariesCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    if (boundariesOn) {
      const timer = setTimeout(() => activateBoundaries(), 100)
      return () => clearTimeout(timer)
    } else {
      deactivateBoundaries()
    }
  }, [boundariesOn, activateBoundaries, deactivateBoundaries])

  useEffect(() => {
    return () => { deactivateBoundaries() }
  }, [html, deactivateBoundaries])

  // ── Color palette: scan all colors from iframe ──
  const rgbToHex = (r: number, g: number, b: number): string => {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  const parseColor = (c: string): string | null => {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'inherit' || c === 'initial') return null
    const rgbMatch = c.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/)
    if (rgbMatch) return rgbToHex(+rgbMatch[1], +rgbMatch[2], +rgbMatch[3])
    if (c.startsWith('#')) return c.length === 4
      ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
      : c.slice(0, 7).toLowerCase()
    return null
  }

  const scanPageColors = useCallback(() => {
    const iframeDoc = liveIframeRef.current?.contentDocument || editorRef.current?.Canvas?.getDocument()
    if (!iframeDoc) return
    const win = iframeDoc.defaultView
    if (!win) return

    const colorMap = new Map<string, number>()
    iframeDoc.querySelectorAll('*').forEach((el) => {
      const cs = win.getComputedStyle(el as HTMLElement)
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']) {
        const hex = parseColor(cs[prop as any])
        if (hex) {
          colorMap.set(hex, (colorMap.get(hex) || 0) + 1)
        }
      }
    })

    const bgHex = parseColor(win.getComputedStyle(iframeDoc.body).backgroundColor)
    if (bgHex) colorMap.set(bgHex, (colorMap.get(bgHex) || 0) + 100)

    const sorted = [...colorMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hex, count]) => ({ hex, count }))

    setPageColors(sorted)
  }, [])

  // ── Fonts palette: scan all font families from iframe ──
  const SYSTEM_FONTS_SET = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset', 'arial', 'helvetica', 'times new roman', 'georgia', 'verdana'])

  const scanPageFonts = useCallback(() => {
    const iframeDoc = liveIframeRef.current?.contentDocument || editorRef.current?.Canvas?.getDocument()
    if (!iframeDoc) return
    const win = iframeDoc.defaultView
    if (!win) return

    const fontMap = new Map<string, number>()
    iframeDoc.querySelectorAll('*').forEach((el) => {
      const cs = win.getComputedStyle(el as HTMLElement)
      if (!cs || !cs.fontFamily) return
      const primary = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
      if (primary && !SYSTEM_FONTS_SET.has(primary.toLowerCase())) {
        fontMap.set(primary, (fontMap.get(primary) || 0) + 1)
      }
    })

    const sorted = [...fontMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([family, count]) => ({ family, count }))

    setPageFonts(sorted)
  }, [])

  // Auto scan colors & fonts when page loads
  useEffect(() => {
    const timer = setTimeout(() => {
      scanPageColors()
      scanPageFonts()
    }, 2000)
    return () => clearTimeout(timer)
  }, [html, scanPageColors, scanPageFonts])

  const toggleColorSelection = (hex: string) => {
    setSelectedColors((prev) => {
      const next = new Set(prev)
      if (next.has(hex)) next.delete(hex)
      else next.add(hex)
      return next
    })
  }

  const toggleFontSelection = (family: string) => {
    setSelectedFonts((prev) => {
      const next = new Set(prev)
      if (next.has(family)) next.delete(family)
      else next.add(family)
      return next
    })
  }

  // Highlight elements using selected fonts
  useEffect(() => {
    const iframeDoc = liveIframeRef.current?.contentDocument || editorRef.current?.Canvas?.getDocument()
    if (!iframeDoc) return
    const win = iframeDoc.defaultView
    if (!win) return

    const oldOverlay = iframeDoc.getElementById('__font-highlight-overlay')
    if (oldOverlay) oldOverlay.remove()

    if (selectedFonts.size === 0) return

    const overlay = iframeDoc.createElement('div')
    overlay.id = '__font-highlight-overlay'
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999999;'
    iframeDoc.documentElement.appendChild(overlay)

    iframeDoc.querySelectorAll('*').forEach((el) => {
      const htmlEl = el as HTMLElement
      const cs = win.getComputedStyle(htmlEl)
      if (!cs || !cs.fontFamily) return
      const primary = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
      if (selectedFonts.has(primary)) {
        const rect = htmlEl.getBoundingClientRect()
        const sx = win.scrollX || 0
        const sy = win.scrollY || 0
        if (rect.width > 0 && rect.height > 0) {
          const box = iframeDoc.createElement('div')
          box.style.cssText = `
            position: absolute;
            left: ${rect.left + sx}px;
            top: ${rect.top + sy}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            outline: 2px solid #38bdf8;
            background: rgba(56, 189, 248, 0.12);
            pointer-events: none;
            z-index: 999999;
          `
          overlay.appendChild(box)
        }
      }
    })
  }, [selectedFonts])

  // ── Grayscale + color highlight effect ──
  // CSS filter on a parent always applies to all children — you can't "un-grayscale"
  // a child element. So we: (1) apply grayscale to <body>, (2) create a highlight
  // overlay as a sibling of <body> (child of <html>) that's OUTSIDE the filter,
  // with colored outlines showing which elements use the selected colors.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const iframeDoc = editor.Canvas.getDocument()
    if (!iframeDoc) return
    const win = iframeDoc.defaultView
    if (!win) return

    // Cleanup previous
    const oldOverlay = iframeDoc.getElementById('__color-highlight-overlay')
    if (oldOverlay) oldOverlay.remove()
    iframeDoc.body.style.removeProperty('filter')

    if (selectedColors.size === 0) return

    // 1. Grayscale the body (all content inside is desaturated)
    iframeDoc.body.style.setProperty('filter', 'grayscale(100%)', 'important')

    // 2. Create overlay container as child of <html>, sibling of <body> — NOT affected by body filter
    const overlay = iframeDoc.createElement('div')
    overlay.id = '__color-highlight-overlay'
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999999;'
    iframeDoc.documentElement.appendChild(overlay)

    // 3. Walk elements and create colored highlight boxes for matching ones
    const hexSet = selectedColors
    const COLOR_PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']
    const sx = win.scrollX || 0
    const sy = win.scrollY || 0

    iframeDoc.querySelectorAll('*').forEach((el) => {
      const htmlEl = el as HTMLElement
      if (htmlEl.tagName === 'SCRIPT' || htmlEl.tagName === 'STYLE' || htmlEl.tagName === 'LINK' || htmlEl.tagName === 'HEAD') return
      const cs = win.getComputedStyle(htmlEl)

      let matchedHex: string | null = null
      for (const prop of COLOR_PROPS) {
        const hex = parseColor(cs[prop as any])
        if (hex && hexSet.has(hex)) { matchedHex = hex; break }
      }

      if (matchedHex) {
        const rect = htmlEl.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        const highlight = iframeDoc.createElement('div')
        highlight.style.cssText = `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid ${matchedHex};background:${matchedHex}18;pointer-events:none;z-index:999999;border-radius:2px;`
        overlay.appendChild(highlight)
      }
    })

    // Also grayscale images that don't match
    iframeDoc.querySelectorAll('img, video, svg').forEach((el) => {
      const htmlEl = el as HTMLElement
      const cs = win.getComputedStyle(htmlEl)
      let hasMatch = false
      for (const prop of COLOR_PROPS) {
        const hex = parseColor(cs[prop as any])
        if (hex && hexSet.has(hex)) { hasMatch = true; break }
      }
      if (!hasMatch) {
        htmlEl.setAttribute('data-gs-img', '1')
      }
    })

    return () => {
      const ov = iframeDoc.getElementById('__color-highlight-overlay')
      if (ov) ov.remove()
      iframeDoc.body.style.removeProperty('filter')
      iframeDoc.querySelectorAll('[data-gs-img]').forEach((el) => {
        el.removeAttribute('data-gs-img')
      })
    }
  }, [selectedColors])

  return (
    <div className="editor-workspace">
      {/* ── Top toolbar ──────────────────────────── */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn" onClick={onNewCapture} title="Back to dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <span className="toolbar-url" title={sourceUrl}>
            {(() => { try { return new URL(sourceUrl).hostname } catch { return sourceUrl } })()}
          </span>
        </div>

        {/* Center: primary workspaces and viewport controls */}
        <div className="toolbar-center">
          <div className="workspace-tab-switcher">
            <button
              className={`workspace-tab-btn ${workspaceTab === 'editBeta' ? 'active' : ''}`}
              onClick={() => setWorkspaceTab('editBeta')}
              title="Edit the authenticated staging page directly in Chromium"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 13h3l7-7-3-3-7 7v3z" />
                <path d="M9 4l3 3" />
              </svg>
              Edit
            </button>
            <button
              className={`workspace-tab-btn ${workspaceTab === 'live' ? 'active' : ''}`}
              onClick={() => {
                setWorkspaceTab('live')
                toggleInteractionMode('interact')
              }}
              title="Live Mode: Pure website preview & native interaction"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 8s3-5.5 7-5.5S15 8 15 8s-3 5.5-7 5.5S1 8 1 8z" />
                <circle cx="8" cy="8" r="2.5" />
              </svg>
              Live
            </button>
            <button
              className={`workspace-tab-btn ${workspaceTab === 'audit' ? 'active' : ''}`}
              onClick={() => setWorkspaceTab('audit')}
              title="Audit"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3l2 2" />
              </svg>
              Audit
            </button>
            <button
              className={`workspace-tab-btn workspace-tab-icon-only ${workspaceTab === 'automate' ? 'active' : ''}`}
              onClick={() => setWorkspaceTab('automate')}
              title="Automate: compare the staging page with a live Figma frame"
              aria-label="Automate"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
                <path d="M14 6.5h3.5V10M10 17.5H6.5V14M17.5 10V8.5a2 2 0 0 0-2-2H14M6.5 14v1.5a2 2 0 0 0 2 2H10" />
                <path d="m8 6 1.2 1.2L12 4.5" />
              </svg>
            </button>
          </div>

          {(workspaceTab === 'editBeta' || workspaceTab === 'layout' || workspaceTab === 'live' || workspaceTab === 'audit') && (
            <div className="viewport-controls">
              {/* Interaction Mode Toggle: Edit Mode vs Interact Mode */}
              <div className="device-switcher" style={{ marginRight: 4 }}>
                <button
                  className={`device-btn ${interactionMode === 'edit' ? 'active' : ''}`}
                  onClick={() => toggleInteractionMode('edit')}
                  title="Edit Mode: Select & Edit Elements"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  className={`device-btn ${interactionMode === 'interact' ? 'active' : ''}`}
                  onClick={() => toggleInteractionMode('interact')}
                  title="Interact Mode: Plain Website Click & Navigation"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                    <path d="M13 13l6 6" />
                  </svg>
                </button>
              </div>

              {/* Reveal Animations & Hidden Headings Toggle */}
              <button
                className={`device-btn ${revealAnimations ? 'active' : ''}`}
                onClick={toggleRevealAnimations}
                title="Reveal On-Scroll Animations & Hidden Headings"
                style={{ marginRight: 4 }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>

              {/* Free-transform toggle */}
              <button
                className={`device-btn ${mode === 'free' ? 'active' : ''}`}
                onClick={enterFreeMode}
                title="Free transform"
              >
                {/* resize / free-transform icon */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </button>

              <div className="toolbar-divider" />

              {/* Device presets */}
              <div className="device-switcher">
                <button
                  className={`device-btn ${mode === 'preset' && activePreset === 'Desktop' ? 'active' : ''}`}
                  onClick={() => switchPreset('Desktop')}
                  title={`Desktop (${PRESETS.Desktop.label})`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <path d="M8 21h8m-4-4v4" />
                  </svg>
                </button>
                <button
                  className={`device-btn ${mode === 'preset' && activePreset === 'Tablet' ? 'active' : ''}`}
                  onClick={() => switchPreset('Tablet')}
                  title={`Tablet (${PRESETS.Tablet.label})`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="2" width="16" height="20" rx="2" />
                    <circle cx="12" cy="18" r="1" fill="currentColor" />
                  </svg>
                </button>
                <button
                  className={`device-btn ${mode === 'preset' && activePreset === 'Mobile' ? 'active' : ''}`}
                  onClick={() => switchPreset('Mobile')}
                  title={`Mobile (${PRESETS.Mobile.label})`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="2" width="12" height="20" rx="2" />
                    <circle cx="12" cy="18" r="1" fill="currentColor" />
                  </svg>
                </button>
              </div>

              <div className="toolbar-divider" />

              {/* Custom dimension inputs with DevTools presets caret dropdown */}
              <div className="dimension-inputs-wrap" ref={devtoolsDropdownRef}>
                <div className="dimension-inputs">
                  <label className="dim-label">W</label>
                  <input
                    className="dim-input"
                    type="number"
                    min={100}
                    value={vpWidth}
                    onChange={(e) => setVpWidth(Number(e.target.value))}
                    onBlur={(e) => commitWidth(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && commitWidth((e.target as HTMLInputElement).value)}
                  />
                  <button className="dim-swap" onClick={swapDimensions} title="Swap dimensions">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </button>
                  <label className="dim-label">H</label>
                  <input
                    className="dim-input"
                    type="number"
                    min={100}
                    value={vpHeight}
                    onChange={(e) => setVpHeight(Number(e.target.value))}
                    onBlur={(e) => commitHeight(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && commitHeight((e.target as HTMLInputElement).value)}
                  />
                  <button
                    className={`dim-caret-btn ${devtoolsDropdownOpen ? 'active' : ''}`}
                    onClick={() => setDevtoolsDropdownOpen((p) => !p)}
                    title="DevTools Device Presets"
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                      <path d="M2 4l4 4 4-4H2z" />
                    </svg>
                  </button>
                </div>

                {devtoolsDropdownOpen && (
                  <div className="devtools-preset-dropdown">
                    <div className="devtools-dd-header">Responsive</div>
                    <div className="devtools-dd-subheader">Standard</div>
                    <div className="devtools-dd-list">
                      {DEVTOOLS_PRESETS.map((preset, idx) => (
                        <button
                          key={idx}
                          className={`devtools-dd-item ${vpWidth === preset.w && vpHeight === preset.h ? 'active' : ''}`}
                          onClick={() => {
                            selectDevtoolsPreset(preset)
                            setDevtoolsDropdownOpen(false)
                          }}
                        >
                          <span className="preset-name">{preset.name}</span>
                          <span className="preset-dims">{preset.w} × {preset.h}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="toolbar-divider" />

              {/* Zoom controls */}
              <div className="zoom-controls">
                <button className="zoom-btn" onClick={zoomOut} title="Zoom out">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M3 8h10" />
                  </svg>
                </button>
                <button className="zoom-level" onClick={zoomFit} title="Reset to 100%">
                  {zoom}%
                </button>
                <button className="zoom-btn" onClick={zoomIn} title="Zoom in">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </button>
              </div>

              <div className="toolbar-divider" />

              {/* Ruler & guides dropdown */}
              <div className="ruler-dropdown-wrap" ref={rulerDropdownRef}>
                <button
                  className={`device-btn ${rulersOn || guides.length > 0 ? 'active' : ''}`}
                  onClick={() => setRulerDropdownOpen((p) => !p)}
                  title="Rulers & Guides"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="2" y="4" width="20" height="16" rx="1"/>
                    <path d="M6 4v4M10 4v6M14 4v4M18 4v6"/>
                  </svg>
                </button>
                {rulerDropdownOpen && (
                  <div className="ruler-dropdown">
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={rulersOn} onChange={(e) => setRulersOn(e.target.checked)} />
                      <span>Rulers</span>
                    </label>
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={guidesOn} onChange={(e) => setGuidesOn(e.target.checked)} />
                      <span>Guides</span>
                    </label>
                    <div className="ruler-dd-divider" />
                    <button className="ruler-dd-item" onClick={() => { setAddGuidesOpen(true); setRulerDropdownOpen(false) }}>
                      Add Guides...
                    </button>
                    <button
                      className="ruler-dd-item ruler-dd-danger"
                      onClick={() => { setGuides([]); setRulerDropdownOpen(false) }}
                      disabled={guides.length === 0}
                    >
                      Delete Guides
                    </button>
                    <div className="ruler-dd-divider" />
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={guidesAlwaysVisible} onChange={(e) => setGuidesAlwaysVisible(e.target.checked)} />
                      <span>Show Guides</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Font inspector toggle */}
              <button
                className={`device-btn ${fontInspectorOn ? 'active' : ''}`}
                onClick={toggleFontInspector}
                title="Font inspector"
              >
                <span style={{ fontSize: '13px', fontWeight: 600 }}>Aa</span>
              </button>

              {/* Boundaries (element inspection) dropdown */}
              <div className="ruler-dropdown-wrap" ref={boundariesDropdownRef}>
                <button
                  className={`device-btn ${boundariesOn ? 'active' : ''}`}
                  onClick={() => setBoundariesDropdownOpen((p) => !p)}
                  title="Boundaries"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="1"/>
                    <rect x="7" y="7" width="10" height="10" rx="0.5" strokeDasharray="2 2"/>
                  </svg>
                </button>
                {boundariesDropdownOpen && (
                  <div className="ruler-dropdown">
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={boundariesOn} onChange={(e) => setBoundariesOn(e.target.checked)} />
                      <span>Boundaries</span>
                    </label>
                    <div className="ruler-dd-divider" />
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={showMargins} onChange={(e) => setShowMargins(e.target.checked)} />
                      <span>Show Margins</span>
                    </label>
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={showPaddings} onChange={(e) => setShowPaddings(e.target.checked)} />
                      <span>Show Paddings</span>
                    </label>
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={showDimensions} onChange={(e) => setShowDimensions(e.target.checked)} />
                      <span>Show Dimensions</span>
                    </label>
                    <label className="ruler-dd-item ruler-dd-check">
                      <input type="checkbox" checked={showGaps} onChange={(e) => setShowGaps(e.target.checked)} />
                      <span>Show Gaps</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Monotone Settings Button */}
              {onOpenSettings && (
                <button
                  className="device-btn"
                  onClick={onOpenSettings}
                  title="Settings: Hotkeys, Snapshot Storage Directory, Theme Customization & Integrations"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              )}

              {/* Figma Design Overlay Dropdown */}
              <div className="ruler-dropdown-wrap" ref={overlayDropdownRef}>
                <button
                  className={`device-btn ${overlayImage && overlayLabel === 'Figma Design' ? 'active' : ''}`}
                  onClick={() => { setOverlayPanelOpen((p) => !p); setSnapshotPanelOpen(false); }}
                  title="Figma Design Overlay (Ctrl+V to paste Figma image)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="9" height="9" rx="1" />
                    <rect x="13" y="13" width="9" height="9" rx="1" />
                    <path d="M13 2h4a3 3 0 0 1 3 3v4" opacity="0.5" />
                    <path d="M2 13v4a3 3 0 0 0 3 3h4" opacity="0.5" />
                  </svg>
                </button>
                {overlayPanelOpen && (
                  <div className="ruler-dropdown overlay-dropdown" style={{ minWidth: 260 }}>
                    <div style={{ padding: '4px 10px 6px', fontSize: 11, fontWeight: 600, color: '#ffffff', borderBottom: '1px solid #27272a', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <img src={figmaIcon} alt="" width="14" height="14" />
                      <span>Figma Design Overlay</span>
                    </div>
                    <button
                      className="ruler-dd-item"
                      style={{ background: figmaSplitOpen ? '#7c3aed' : '#27272a', color: '#ffffff', fontWeight: 600, padding: '6px 10px', borderRadius: 6, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}
                      onClick={() => {
                        setFigmaSplitOpen((p) => {
                          const next = !p
                          if (next) setFigmaCardDismissed(false)
                          return next
                        })
                        setOverlayVisible(true)
                        setOverlayMode('side-by-side')
                        setOverlayPanelOpen(false)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="12" y1="3" x2="12" y2="21" />
                      </svg>
                      <span>{figmaSplitOpen ? 'Hide In-Canvas Figma Live Embed' : 'Embed Figma Live (Left Canvas)'}</span>
                    </button>
                    {storedFigmaUrl ? (
                      <>
                        <button
                          className="ruler-dd-item"
                          style={{ color: '#ffffff', fontWeight: 500, padding: '6px 10px', borderRadius: 6, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}
                          onClick={() => window.electronAPI.openExternal(storedFigmaUrl)}
                        >
                          <img src={figmaIcon} alt="Figma" width="14" height="14" style={{ objectFit: 'contain', filter: 'grayscale(100%)', opacity: 0.7 }} />
                          <span>Open Figma in Chrome ↗</span>
                        </button>
                        <button
                          className="ruler-dd-item"
                          style={{ color: '#a1a1aa', padding: '4px 10px', fontSize: 11, marginBottom: 6 }}
                          onClick={openFigmaModal}
                        >
                          Edit / Change Figma Link
                        </button>
                      </>
                    ) : (
                      <button
                        className="ruler-dd-item"
                        style={{ color: '#3b82f6', fontWeight: 600, padding: '6px 10px', borderRadius: 6, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}
                        onClick={openFigmaModal}
                      >
                        <img src={figmaIcon} alt="Figma" width="14" height="14" style={{ objectFit: 'contain' }} />
                        <span>+ Add Figma Link</span>
                      </button>
                    )}
                    <div className="ruler-dd-divider" />
                    {!overlayImage || overlayLabel !== 'Figma Design' ? (
                      <>
                        <div className="overlay-dd-hint">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                            <rect x="2" y="2" width="9" height="9" rx="1" />
                            <rect x="13" y="13" width="9" height="9" rx="1" />
                            <path d="M13 2h4a3 3 0 0 1 3 3v4" />
                            <path d="M2 13v4a3 3 0 0 0 3 3h4" />
                          </svg>
                          <span>Copy a layer as PNG in Figma,<br/>then <strong>Ctrl + V</strong> here</span>
                        </div>
                        <div className="ruler-dd-divider" />
                        <button
                          className="ruler-dd-item"
                          onClick={() => overlayFileRef.current?.click()}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          Upload Image...
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="overlay-dd-preview">
                          <img src={overlayImage} alt="Figma design overlay" />
                        </div>
                        <div className="ruler-dd-divider" />

                        <div className="overlay-dd-control">
                          <label>Opacity</label>
                          <div className="overlay-slider-row">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={overlayOpacity}
                              onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                              className="overlay-slider"
                            />
                            <span className="overlay-slider-val">{overlayOpacity}%</span>
                          </div>
                        </div>

                        <div className="ruler-dd-divider" />

                        <div className="overlay-dd-control">
                          <label>Mode</label>
                          <div className="overlay-mode-switcher">
                            {(['overlay', 'side-by-side', 'diff'] as const).map((m) => (
                              <button
                                key={m}
                                className={`overlay-mode-btn ${overlayMode === m ? 'active' : ''}`}
                                onClick={() => setOverlayMode(m)}
                              >
                                {m === 'overlay' ? 'Overlay' : m === 'side-by-side' ? 'Side' : 'Diff'}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="ruler-dd-divider" />

                        <label className="ruler-dd-item ruler-dd-check">
                          <input
                            type="checkbox"
                            checked={overlayVisible}
                            onChange={(e) => setOverlayVisible(e.target.checked)}
                          />
                          <span>Visible</span>
                        </label>

                        <div className="ruler-dd-divider" />

                        <button
                          className="ruler-dd-item"
                          onClick={() => overlayFileRef.current?.click()}
                        >
                          Replace Image...
                        </button>
                        <button
                          className="ruler-dd-item ruler-dd-danger"
                          onClick={removeOverlay}
                        >
                          Remove Figma Overlay
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Separate Site Snapshot Comparison Dropdown Button */}
              <div className="ruler-dropdown-wrap" ref={snapshotPanelDropdownRef}>
                <button
                  className={`device-btn ${overlayImage && overlayLabel === 'Site Snapshot' ? 'active' : ''}`}
                  onClick={() => { setSnapshotPanelOpen((p) => !p); setOverlayPanelOpen(false); }}
                  title="Compare Site Snapshots (Side-by-Side, Overlay, Diff)"
                  style={{ marginLeft: 4 }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="9" height="18" rx="2" />
                    <rect x="13" y="3" width="9" height="18" rx="2" />
                    <path d="M6 8h1M6 12h1M17 8h1M17 12h1" strokeWidth="2" />
                  </svg>
                </button>
                {snapshotPanelOpen && (
                  <div className="ruler-dropdown overlay-dropdown" style={{ minWidth: 280 }}>
                    <div style={{ padding: '4px 10px 6px', fontSize: 11, fontWeight: 600, color: '#ffffff', borderBottom: '1px solid #27272a', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                      <span>Site Snapshot Comparison</span>
                    </div>

                    {snapshots.filter((s) => s.type === 'image' && s.dataUrl).length > 0 ? (
                      <>
                        {/* 5 Monotone Icon Device Category Tabs */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 4px 6px', borderBottom: '1px solid #27272a', marginBottom: 6 }}>
                          {[
                            { key: 'all', label: 'All', icon: null },
                            { key: 'desktop', label: 'Desktop', icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg> },
                            { key: 'tablet', label: 'Tablet', icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="2" width="16" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" strokeWidth="2.5" /></svg> },
                            { key: 'phone', label: 'Phone', icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="2" width="12" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" strokeWidth="2.5" /></svg> },
                            { key: 'custom', label: 'Custom', icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg> }
                          ].map(({ key, label, icon }) => {
                            const count = snapshots.filter((s) => s.type === 'image' && s.dataUrl && (key === 'all' || getSnapshotCategory(s) === key)).length
                            const isSelected = snapshotCategoryFilter === key
                            return (
                              <button
                                key={key}
                                onClick={() => setSnapshotCategoryFilter(key as any)}
                                style={{
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 3,
                                  padding: '4px 2px',
                                  borderRadius: 4,
                                  fontSize: 9.5,
                                  fontWeight: isSelected ? 600 : 400,
                                  background: isSelected ? '#27272a' : 'transparent',
                                  color: isSelected ? '#ffffff' : '#a1a1aa',
                                  border: isSelected ? '1px solid #3f3f46' : '1px solid transparent',
                                  cursor: 'pointer',
                                  transition: 'all 0.12s ease'
                                }}
                                title={`${label} snapshots (${count})`}
                              >
                                {icon}
                                <span>{label}</span>
                                {count > 0 && <span style={{ fontSize: 8.5, opacity: 0.75 }}>({count})</span>}
                              </button>
                            )
                          })}
                        </div>

                        <div style={{ padding: '2px 10px 4px', fontSize: 9.5, color: '#a1a1aa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                          Select Snapshot ({snapshots.filter((s) => s.type === 'image' && s.dataUrl && (snapshotCategoryFilter === 'all' || getSnapshotCategory(s) === snapshotCategoryFilter)).length}):
                        </div>
                        <div style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 4 }}>
                          {snapshots
                            .filter((s) => s.type === 'image' && s.dataUrl && (snapshotCategoryFilter === 'all' || getSnapshotCategory(s) === snapshotCategoryFilter))
                            .map((snap) => (
                              <button
                                key={snap.id}
                                className="ruler-dd-item"
                                style={{
                                  color: '#ffffff',
                                  fontSize: 11,
                                  padding: '6px 10px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  background: overlayImage === snap.dataUrl ? 'rgba(76, 139, 245, 0.2)' : 'transparent',
                                  borderRadius: 4
                                }}
                                onClick={() => {
                                  setOverlayImage(snap.dataUrl!, 'Site Snapshot')
                                  setOverlayVisible(true)
                                }}
                              >
                                <span style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.85 }}>
                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                    <polyline points="21 15 16 10 5 21" />
                                  </svg>
                                  <span>{formatSnapshotTitle(snap)}</span>
                                </span>
                                <span style={{ fontSize: 9, color: '#a1a1aa', flexShrink: 0 }}>{snap.fileSizeFormatted}</span>
                              </button>
                            ))}
                          {snapshots.filter((s) => s.type === 'image' && s.dataUrl && (snapshotCategoryFilter === 'all' || getSnapshotCategory(s) === snapshotCategoryFilter)).length === 0 && (
                            <div style={{ padding: '12px 10px', textAlign: 'center', fontSize: 10, color: '#71717a' }}>
                              No snapshots in <strong>{snapshotCategoryFilter}</strong> category.
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="overlay-dd-hint" style={{ padding: '12px 10px' }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.5 }}>
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                          <circle cx="12" cy="13" r="4" />
                        </svg>
                        <span>No image snapshots yet.<br/>Use <strong>Create Snapshot</strong> to capture one.</span>
                      </div>
                    )}

                    {overlayImage && overlayLabel === 'Site Snapshot' && (
                      <>
                        <div className="ruler-dd-divider" />
                        <div className="overlay-dd-preview">
                          <img src={overlayImage} alt="Site snapshot comparison" />
                        </div>
                        <div className="ruler-dd-divider" />

                        <div className="overlay-dd-control">
                          <label>Opacity</label>
                          <div className="overlay-slider-row">
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={overlayOpacity}
                              onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                              className="overlay-slider"
                            />
                            <span className="overlay-slider-val">{overlayOpacity}%</span>
                          </div>
                        </div>

                        <div className="ruler-dd-divider" />

                        <div className="overlay-dd-control">
                          <label>Mode</label>
                          <div className="overlay-mode-switcher">
                            {(['overlay', 'side-by-side', 'diff'] as const).map((m) => (
                              <button
                                key={m}
                                className={`overlay-mode-btn ${overlayMode === m ? 'active' : ''}`}
                                onClick={() => setOverlayMode(m)}
                              >
                                {m === 'overlay' ? 'Overlay' : m === 'side-by-side' ? 'Side' : 'Diff'}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="ruler-dd-divider" />

                        <label className="ruler-dd-item ruler-dd-check">
                          <input
                            type="checkbox"
                            checked={overlayVisible}
                            onChange={(e) => setOverlayVisible(e.target.checked)}
                          />
                          <span>Visible</span>
                        </label>

                        <div className="ruler-dd-divider" />

                        <button
                          className="ruler-dd-item ruler-dd-danger"
                          onClick={removeOverlay}
                        >
                          Remove Snapshot Comparison
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              <input
                ref={overlayFileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleOverlayFileUpload}
              />

              <div className="toolbar-divider" />

              {/* Panel Toggle Group: Left, Bottom, Right */}
              <div className="panel-toggle-group" style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'rgba(0,0,0,0.3)', padding: 2, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }}>
                <button
                  className={`device-btn ${leftPanelOpen ? 'active' : ''}`}
                  onClick={() => setLeftPanelOpen((p) => !p)}
                  title="Toggle Left Panel (Layers & History)"
                  style={{ width: 28, height: 26, padding: 0 }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>

                <button
                  className={`device-btn ${bottomSheetOpen ? 'active' : ''}`}
                  onClick={() => setBottomSheetOpen((p) => !p)}
                  title="Toggle Bottom Panel (QA Tracker Spreadsheet)"
                  style={{ width: 28, height: 26, padding: 0 }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="3" y1="15" x2="21" y2="15" />
                  </svg>
                </button>

                <button
                  className={`device-btn ${rightPanelOpen ? 'active' : ''}`}
                  onClick={() => setRightPanelOpen((p) => !p)}
                  title="Toggle Right Panel (Selectors & Style)"
                  style={{ width: 28, height: 26, padding: 0 }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="15" y1="3" x2="15" y2="21" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="toolbar-right">
          <button
            className="toolbar-btn refresh-btn"
            onClick={() => workspaceTab === 'editBeta' ? editBetaRef.current?.reload() : handleReset()}
            disabled={workspaceTab !== 'editBeta' && resetting}
            title="Hard refresh (F5)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v6h6" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            <span>{workspaceTab !== 'editBeta' && resetting ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Floating Bottom Status Toast Notification */}
      {batchToast?.active && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 99999,
            background: batchToast.isComplete ? '#18181b' : '#09090b',
            color: '#ffffff',
            border: batchToast.isComplete ? '1px solid #22c55e' : '1px solid #3b82f6',
            borderRadius: 8,
            padding: '10px 18px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.01em'
          }}
        >
          {!batchToast.isComplete ? (
            <div
              style={{
                width: 14,
                height: 14,
                border: '2px solid rgba(59, 130, 246, 0.3)',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite'
              }}
            />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          <span>{batchToast.message}</span>
        </div>
      )}

      {/* ── Editor body (Canvas stays central, right panel switches between Edit and SEO Audit tools) ──────── */}
      <div className="editor-body">
        {leftPanelOpen && workspaceTab !== 'live' && workspaceTab !== 'editBeta' && workspaceTab !== 'automate' && (
          <div className="editor-panel panel-left" style={{ width: leftPanelWidth }}>
            {/* Collapsible Layers Section */}
            <div className={`accordion-section ${layersExpanded ? 'expanded' : 'collapsed'}`}>
              <div
                className="accordion-header"
                onClick={() => setLayersExpanded((p) => !p)}
                title="Click anywhere to toggle Layers"
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <div className="accordion-header-left">
                  <svg
                    className={`accordion-chevron ${layersExpanded ? 'open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span className="accordion-title">Layers</span>
                </div>

                <div className="accordion-header-right">
                  {/* Sleek Segmented Switch: MINIFIED vs VERBOSE */}
                  <div className="layer-mode-switch" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`layer-mode-btn ${layerDisplayMode === 'minified' ? 'active' : ''}`}
                      onClick={() => toggleLayerDisplayMode('minified')}
                      title="Minified mode: Displays simplified HTML element types (Div, Paragraph, Section)"
                    >
                      Minified
                    </button>
                    <button
                      className={`layer-mode-btn ${layerDisplayMode === 'verbose' ? 'active' : ''}`}
                      onClick={() => toggleLayerDisplayMode('verbose')}
                      title="Verbose mode: Displays full framework IDs, class names, and selectors (Elementor, WordPress)"
                    >
                      Verbose
                    </button>
                  </div>

                  <span className="accordion-badge">{layerCount}</span>
                </div>
              </div>
              <div className="accordion-content" style={{ display: layersExpanded ? 'block' : 'none' }}>
                <div id="layers-container" className="panel-content" />
              </div>
            </div>

            {/* Collapsible Snapshots Section */}
            <div className={`accordion-section ${snapshotsExpanded ? 'expanded' : 'collapsed'}`}>
              <div
                className="accordion-header"
                onClick={() => setSnapshotsExpanded((p) => !p)}
                title="Click anywhere to toggle Snapshots"
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <div className="accordion-header-left">
                  <svg
                    className={`accordion-chevron ${snapshotsExpanded ? 'open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span className="accordion-title">Snapshots</span>
                </div>
                <span className="accordion-badge">{snapshots.length}</span>
              </div>

              {snapshotsExpanded && (
                <div className="accordion-content snapshots-content" style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {snapshots.length > 0 ? (
                    snapshots.map((snap) => (
                      <div
                        key={snap.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 8px',
                          borderRadius: 4,
                          background: overlayImage === snap.dataUrl ? 'var(--accent-light)' : 'var(--bg-input)',
                          border: overlayImage === snap.dataUrl ? '1px solid var(--accent-color)' : '1px solid var(--border-color)',
                          cursor: 'pointer'
                        }}
                        onClick={() => {
                          if (snap.dataUrl) {
                            setOverlayImage(snap.dataUrl, 'Site Snapshot')
                            setOverlayVisible(true)
                          }
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, opacity: 0.8 }}>
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <polyline points="21 15 16 10 5 21" />
                          </svg>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {formatSnapshotTitle(snap)}
                            </div>
                            <div style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{snap.fileSizeFormatted}</div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => handleDeleteSnapshot(snap.id, e)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#71717a',
                            cursor: 'pointer',
                            padding: 2,
                            borderRadius: 3,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          title="Delete snapshot"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                        </button>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: '12px 8px', textAlign: 'center', fontSize: 10.5, color: '#71717a' }}>
                      No snapshots captured yet.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Collapsible CSS Inspector Section */}
            <div className={`accordion-section ${cssExpanded ? 'expanded' : 'collapsed'}`}>
              <div
                className="accordion-header"
                onClick={() => setCssExpanded((p) => !p)}
                title="Click anywhere to toggle Styles"
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <div className="accordion-header-left">
                  <svg
                    className={`accordion-chevron ${cssExpanded ? 'open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 18l6-6-6-6" />
                    <path d="M8 6l-6 6 6 6" />
                  </svg>
                  <span className="accordion-title">Styles</span>
                </div>
              </div>
              {cssExpanded && (
                <div className="accordion-content css-inspector-content">
                  {selectedNativeEl ? (
                    <>
                      <div className="css-inspector-tag" style={{ marginBottom: '8px', color: '#38bdf8', fontWeight: 600 }}>
                        {selectedNativeEl.tagName.toLowerCase()}
                        {selectedNativeEl.id ? `#${selectedNativeEl.id}` : ''}
                        {selectedNativeEl.className && typeof selectedNativeEl.className === 'string'
                          ? '.' + selectedNativeEl.className.split(/\s+/).filter(c => c && !c.startsWith('data-live-')).slice(0, 2).join('.')
                          : ''}
                      </div>
                      <CssInspectorEditor
                        selectedElement={selectedNativeEl}
                        initialCss={cssRules}
                        onCssChange={handleInspectorCssChange}
                      />
                    </>
                  ) : (
                    <div className="css-inspector-empty">Select an element to inspect</div>
                  )}
                </div>
              )}
            </div>

            {/* Collapsible Photoshop-Style History Section */}
            <div className={`accordion-section ${historyExpanded ? 'expanded' : 'collapsed'}`}>
              <div
                className="accordion-header"
                onClick={() => setHistoryExpanded((p) => !p)}
                title="Click to toggle History"
              >
                <div className="accordion-header-left">
                  <svg
                    className={`accordion-chevron ${historyExpanded ? 'open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M12 7v5l4 2" />
                  </svg>
                  <span className="accordion-title">History</span>
                </div>
                <span className="accordion-badge">{historySteps.length}</span>
              </div>

              {historyExpanded && (
                <div className="accordion-content history-content">
                  <div className="history-list">
                    {historySteps.map((step, idx) => {
                      const isActive = idx === historyIndex
                      const isFuture = idx > historyIndex
                      return (
                        <div
                          key={step.id}
                          className={`history-item ${isActive ? 'active' : ''} ${isFuture ? 'future' : ''}`}
                          onClick={() => jumpToHistoryIndex(idx)}
                          title={`Click to jump to "${step.action}"`}
                        >
                          <div className="history-item-icon">
                            {step.iconType === 'init' && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <path d="M12 8v8M8 12h8" />
                              </svg>
                            )}
                            {step.iconType === 'add' && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4C8BF5" strokeWidth="2">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </svg>
                            )}
                            {step.iconType === 'remove' && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#F85149" strokeWidth="2">
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </svg>
                            )}
                            {step.iconType === 'style' && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A371F7" strokeWidth="2">
                                <circle cx="12" cy="12" r="8" />
                                <path d="M12 2v20" />
                              </svg>
                            )}
                            {(step.iconType === 'edit' || step.iconType === 'move') && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3FB950" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            )}
                          </div>
                          <div className="history-item-body">
                            <div className="history-item-action">{step.action}</div>
                            {step.detail && <div className="history-item-detail">{step.detail}</div>}
                          </div>
                          <div className="history-item-time">{step.timestamp}</div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="history-footer">
                    <button
                      className="history-revert-btn"
                      onClick={revertToInitial}
                      disabled={historyIndex === 0}
                      title="Rollback to original initial capture state"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                      Revert to Initial
                    </button>
                  </div>
                </div>
              )}
            </div>


          </div>
        )}
        {leftPanelOpen && workspaceTab !== 'editBeta' && workspaceTab !== 'automate' && (
          <div className="panel-resize-handle" onMouseDown={(e) => onPanelResizeStart('left', e)} />
        )}

        {/* Canvas with optional rulers, guides, free-transform handles, and bottom resizable QA Spreadsheet */}
        <div className="editor-canvas-wrap" ref={canvasWrapRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden' }}>
          {/* Top Canvas Viewport area */}
          <div className="canvas-viewport-area" style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {workspaceTab === 'editBeta' && (
              <EditBetaWorkspace
                ref={editBetaRef}
                sourceUrl={sourceUrl}
                width={vpWidth}
                height={vpHeight}
                zoom={zoom}
                interactionMode={interactionMode}
                revealAnimations={revealAnimations}
                fontInspectorOn={fontInspectorOn}
                boundaries={{ enabled: boundariesOn, showMargins, showPaddings, showDimensions, showGaps }}
                leftPanelOpen={leftPanelOpen}
                rightPanelOpen={rightPanelOpen}
                rulersOn={rulersOn}
                guidesOn={guidesOn}
                guidesAlwaysVisible={guidesAlwaysVisible}
                guides={guides}
                viewportMode={mode}
                onViewportResize={(nextWidth, nextHeight) => {
                  vpWidthRef.current = nextWidth
                  vpHeightRef.current = nextHeight
                  setVpWidth(nextWidth)
                  setVpHeight(nextHeight)
                }}
                overlayImage={overlayImage}
                overlayVisible={overlayVisible}
                overlayOpacity={overlayOpacity}
                overlayMode={overlayMode}
                overlayLabel={overlayLabel}
                figmaImage={figmaImage}
                figmaUrl={storedFigmaUrl}
                figmaViewMode={figmaViewMode}
                figmaPanelVisible={!figmaCardDismissed && figmaSplitOpen}
                snapshotImage={snapshotImage}
                snapshotLabel={snapshotLabel}
                onFigmaViewModeChange={setFigmaViewMode}
                onOpenFigmaSettings={openFigmaModal}
                onCloseFigmaPanel={() => { setFigmaSplitOpen(false); setFigmaCardDismissed(true) }}
                onCloseSnapshotPanel={() => setSnapshotImage(null)}
                onThumbnailCaptured={project?.thumbnailUrl ? undefined : onThumbnailCaptured}
              />
            )}
            {workspaceTab === 'automate' && <AutomateWorkspace sourceUrl={sourceUrl} figmaUrl={storedFigmaUrl} projectId={activeProjectId} />}
            {/* Live Mode Browser Navigation Bar (Back, Forward, Refresh, URL Bar, Create Snapshot) */}
            {workspaceTab === 'live' && (
              <div
                className="live-browser-navbar"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 12px',
                  background: '#121214',
                  borderBottom: '1px solid #27272a',
                  zIndex: 20
                }}
              >
                {/* Left navigation controls: Back, Forward, Reload */}
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button
                    className="device-btn"
                    onClick={handleLiveBack}
                    title="Back (Alt + Left)"
                    style={{ width: 28, height: 28, padding: 0 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    className="device-btn"
                    onClick={handleLiveForward}
                    title="Forward (Alt + Right)"
                    style={{ width: 28, height: 28, padding: 0 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </button>
                  <button
                    className="device-btn"
                    onClick={handleLiveReload}
                    title="Reload page"
                    style={{ width: 28, height: 28, padding: 0 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 4v6h-6M1 20v-6h6" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                  </button>
                </div>

                {/* Middle: URL Input bar */}
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    background: '#18181b',
                    border: '1px solid #3f3f46',
                    borderRadius: '6px',
                    padding: '0 10px',
                    height: '28px'
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="2" style={{ marginRight: 8, flexShrink: 0 }}>
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <input
                    type="text"
                    value={liveUrl}
                    onChange={(e) => setLiveUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleNavigateLiveUrl((e.target as HTMLInputElement).value)}
                    placeholder="Enter website URL..."
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      color: '#f4f4f5',
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      outline: 'none'
                    }}
                  />
                </div>

                {/* Far Right: Sleek Monotone White/Black Create Snapshot Split Button */}
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }} ref={snapshotDropdownRef}>
                  <button
                    className="create-snapshot-white-btn"
                    onClick={() => handleCreateSnapshot('image')}
                    disabled={snapshotCreating}
                    title="Create Visual Image Snapshot of page"
                    style={{
                      background: '#ffffff',
                      color: '#09090b',
                      fontWeight: 600,
                      fontSize: 12,
                      padding: '0 14px',
                      height: 28,
                      width: 'auto',
                      minWidth: 'auto',
                      borderRadius: '6px 0 0 6px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      border: 'none',
                      cursor: snapshotCreating ? 'wait' : 'pointer',
                      whiteSpace: 'nowrap',
                      boxSizing: 'border-box'
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#09090b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    <span>{snapshotCreating ? 'Capturing...' : 'Create Snapshot'}</span>
                  </button>
                  <button
                    className="create-snapshot-arrow-btn"
                    onClick={() => setSnapshotDropdownOpen((p) => !p)}
                    disabled={snapshotCreating}
                    title="Select Snapshot Mode"
                    style={{
                      background: '#e4e4e7',
                      color: '#09090b',
                      width: 24,
                      minWidth: 24,
                      height: 28,
                      padding: 0,
                      borderRadius: '0 6px 6px 0',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: 'none',
                      borderLeft: '1px solid #d4d4d8',
                      cursor: snapshotCreating ? 'wait' : 'pointer',
                      flexShrink: 0
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#09090b" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {snapshotDropdownOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: 4,
                        width: 290,
                        background: '#18181b',
                        border: '1px solid #3f3f46',
                        borderRadius: 8,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                        zIndex: 100,
                        padding: 8
                      }}
                    >
                      <div style={{ padding: '2px 4px 6px', fontSize: 10.5, fontWeight: 700, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Snapshot Mode:
                      </div>

                      <button
                        className="ruler-dd-item"
                        onClick={() => handleCreateSnapshot('image')}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 4 }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginTop: 2, flexShrink: 0 }}>
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <polyline points="21 15 16 10 5 21" />
                        </svg>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 11, color: '#ffffff' }}>Visual Image Snapshot</div>
                          <div style={{ fontSize: 9.5, color: '#a1a1aa' }}>Current Viewport ({vpWidth}×{vpHeight})</div>
                        </div>
                      </button>

                      <button
                        className="ruler-dd-item"
                        onClick={() => handleCreateSnapshot('html')}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 4 }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginTop: 2, flexShrink: 0 }}>
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 11, color: '#ffffff' }}>Interactive HTML Snapshot</div>
                          <div style={{ fontSize: 9.5, color: '#a1a1aa' }}>Preserves interactive DOM elements & code</div>
                        </div>
                      </button>

                      <div className="ruler-dd-divider" style={{ margin: '8px 0' }} />

                      {/* Multi-Breakpoints Batch Section */}
                      <div style={{ padding: '2px 4px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: '#ffffff', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                          Multi-Device Breakpoints
                        </span>
                        <span style={{ fontSize: 9, color: '#a1a1aa' }}>({selectedMultiBreakpoints.length} selected)</span>
                      </div>

                      {/* Quick Selection Pills */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 4px 6px' }}>
                        {[
                          { label: 'All', fn: () => setSelectedMultiBreakpoints(DEVTOOLS_PRESETS.map((p) => p.name)) },
                          { label: 'Desktop', fn: () => setSelectedMultiBreakpoints(DEVTOOLS_PRESETS.filter((p) => (p.w >= 1024)).map((p) => p.name)) },
                          { label: 'Tablet', fn: () => setSelectedMultiBreakpoints(DEVTOOLS_PRESETS.filter((p) => (p.w >= 600 && p.w < 1024)).map((p) => p.name)) },
                          { label: 'Mobile', fn: () => setSelectedMultiBreakpoints(DEVTOOLS_PRESETS.filter((p) => (p.w < 600)).map((p) => p.name)) },
                          { label: 'Clear', fn: () => setSelectedMultiBreakpoints([]) }
                        ].map(({ label, fn }) => (
                          <button
                            key={label}
                            onClick={fn}
                            style={{
                              padding: '2px 5px',
                              fontSize: 8.5,
                              fontWeight: 600,
                              background: '#27272a',
                              color: '#d4d4d8',
                              border: '1px solid #3f3f46',
                              borderRadius: 3,
                              cursor: 'pointer'
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      <div style={{ maxHeight: 150, overflowY: 'auto', padding: '2px 4px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {DEVTOOLS_PRESETS.map((preset) => {
                          const isChecked = selectedMultiBreakpoints.includes(preset.name)
                          return (
                            <label
                              key={preset.name}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '3px 6px',
                                borderRadius: 4,
                                background: isChecked ? 'rgba(76, 139, 245, 0.15)' : 'transparent',
                                cursor: 'pointer',
                                fontSize: 10.5,
                                color: '#e4e4e7'
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedMultiBreakpoints((prev) => [...prev, preset.name])
                                    } else {
                                      setSelectedMultiBreakpoints((prev) => prev.filter((n) => n !== preset.name))
                                    }
                                  }}
                                />
                                <span>{preset.name}</span>
                              </div>
                              <span style={{ fontSize: 9, color: '#a1a1aa' }}>{preset.w}×{preset.h}</span>
                            </label>
                          )
                        })}
                      </div>

                      <button
                        onClick={handleCaptureMultiBreakpoints}
                        disabled={selectedMultiBreakpoints.length === 0 || snapshotCreating}
                        style={{
                          marginTop: 8,
                          width: '100%',
                          padding: '6px 10px',
                          background: selectedMultiBreakpoints.length > 0 ? '#3b82f6' : '#27272a',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: selectedMultiBreakpoints.length > 0 ? 'pointer' : 'not-allowed',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                        <span>Capture Selected Breakpoints ({selectedMultiBreakpoints.length})</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Floating edge dock buttons when panels are collapsed */}
            {!leftPanelOpen && workspaceTab !== 'automate' && (
              <button
                className="panel-dock-btn dock-left"
                onClick={() => setLeftPanelOpen(true)}
                title="Expand Left Panel (Layers & History)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="13 17 18 12 13 7" />
                  <polyline points="6 17 11 12 6 7" />
                </svg>
                <span>Layers & History</span>
              </button>
            )}

            {!rightPanelOpen && workspaceTab !== 'automate' && (
              <button
                className="panel-dock-btn dock-right"
                onClick={() => setRightPanelOpen(true)}
                title="Expand Right Panel (Selectors & Style)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="11 17 6 12 11 7" />
                  <polyline points="18 17 13 12 18 7" />
                </svg>
                <span>Style & Selectors</span>
              </button>
            )}

            {!bottomSheetOpen && workspaceTab !== 'automate' && (
              <button
                className="panel-dock-btn dock-bottom"
                onClick={() => setBottomSheetOpen(true)}
                title="Expand QA Tracker Spreadsheet"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3FB950" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="3" y1="15" x2="21" y2="15" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
                <span>QA Master Tracker</span>
              </button>
            )}
            {/* Horizontal ruler */}
            {rulersOn && (
              <div className="ruler-h-container">
                <div className="ruler-corner" />
                <canvas
                  ref={hRulerRef}
                  className="ruler-h"
                  onMouseDown={onHRulerMouseDown}
                />
              </div>
            )}

            <div className="canvas-with-vruler">
              {/* Vertical ruler */}
              {rulersOn && (
                <canvas
                  ref={vRulerRef}
                  className="ruler-v"
                  onMouseDown={onVRulerMouseDown}
                />
              )}

              <div className="canvas-inner" ref={canvasInnerRef} style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
                {missingFonts.length > 0 && (
                  <div className={`font-notice ${fontsAttempted ? 'font-notice-warn' : ''}`}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4m0 4h.01" />
                    </svg>
                    <span className="font-notice-text">
                      {fontsAttempted ? 'Fonts not found: ' : 'Missing fonts: '}
                      <strong>{missingFonts.join(', ')}</strong>
                    </span>
                    {!fontsAttempted && (
                      <button
                        className="font-notice-btn font-notice-load"
                        onClick={handleLoadFonts}
                        disabled={loadingFonts}
                      >
                        {loadingFonts ? 'Loading...' : 'Load Fonts'}
                      </button>
                    )}
                    <button
                      className="font-notice-btn font-notice-dismiss"
                      onClick={() => { setMissingFonts([]); setFontsAttempted(false) }}
                      title="Dismiss"
                    >
                      &times;
                    </button>
                  </div>
                )}
                {mode === 'free' && frameRect && (
                  <div
                    className="ft-overlay"
                    style={{
                      top: frameRect.top,
                      left: frameRect.left,
                      width: frameRect.width,
                      height: frameRect.height
                    }}
                  >
                    <div className="ft-handle ft-top" onMouseDown={(e) => onHandleMouseDown('top', e)} />
                    <div className="ft-handle ft-right" onMouseDown={(e) => onHandleMouseDown('right', e)} />
                    <div className="ft-handle ft-bottom" onMouseDown={(e) => onHandleMouseDown('bottom', e)} />
                    <div className="ft-handle ft-left" onMouseDown={(e) => onHandleMouseDown('left', e)} />
                  </div>
                )}

                {/* GrapesJS canvas — hidden behind native iframe, provides style manager/layers/selectors */}
                <div className="editor-canvas" ref={containerRef} style={{ opacity: 0, pointerEvents: 'none', position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />

                {/* Native overlay iframe — renders captured HTML 100% natively for Layout & Audit tabs */}
                <div
                  className="native-canvas-wrap"
                  style={{
                    position: 'relative',
                    width: vpWidth,
                    height: vpHeight,
                    margin: '0 auto',
                    overflow: 'hidden',
                    display: workspaceTab === 'live' || workspaceTab === 'editBeta' ? 'none' : 'block'
                  }}
                >
                  <iframe
                    ref={liveIframeRef}
                    srcDoc={html}
                    onLoad={handleNativeIframeLoad}
                    style={{
                      width: `${vpWidth}px`,
                      height: `${vpHeight}px`,
                      border: 'none',
                      background: '#fff',
                      display: 'block'
                    }}
                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                    title="Native page preview"
                  />
                </div>

                {/* Live stays mounted and shares the login/capture session. */}
                <div
                    className="live-browser-wrap"
                    style={{
                      position: 'relative',
                      width: `${vpWidth}px`,
                      height: `${vpHeight}px`,
                      margin: '0 auto',
                      overflow: 'hidden',
                      background: '#fff',
                      display: workspaceTab === 'live' ? 'block' : 'none'
                    }}
                  >
                    <webview
                      ref={liveWebviewRef}
                      src={liveUrl || sourceUrl}
                      style={{
                        width: '100%',
                        height: '100%',
                        border: 'none',
                        background: '#fff'
                      }}
                      allowpopups={true}
                    />
                </div>

                {/* ── IN-CANVAS 3-WAY SIDE-BY-SIDE / OVERLAY / DIFF ── */}
                {canvasFrame && (
                  <>
                    {/* LEFT PANEL: Standard Desktop Figma Live App / Reference PNG */}
                    {!figmaCardDismissed && (storedFigmaUrl || figmaImage || figmaSplitOpen) && overlayMode === 'side-by-side' && (
                      <div
                        className="figma-overlay-side"
                        style={{
                          left: canvasFrame.left - canvasFrame.width - 24,
                          top: canvasFrame.top,
                          width: canvasFrame.width,
                          height: canvasFrame.height,
                          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                          borderRadius: 8,
                          overflow: 'visible',
                          background: '#18181b',
                          display: 'flex',
                          flexDirection: 'column',
                          border: '1px solid rgba(255,255,255,0.12)'
                        }}
                      >
                        {/* Sleek Mini Floating Tooltip Pill ABOVE Frame */}
                        <div
                          style={{
                            position: 'absolute',
                            top: -34,
                            left: 0,
                            height: 26,
                            padding: '3px 8px 3px 6px',
                            background: 'rgba(20, 20, 24, 0.88)',
                            backdropFilter: 'blur(12px)',
                            WebkitBackdropFilter: 'blur(12px)',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            borderRadius: 20,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            zIndex: 10
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 500, color: '#e4e4e7' }}>
                            <img src={figmaIcon} alt="Figma" width="12" height="12" style={{ width: 12, height: 12, objectFit: 'contain' }} />
                            <span>{storedFigmaUrl && figmaImage ? 'Figma Design' : storedFigmaUrl ? 'Figma Live App' : 'Figma PNG Reference'}</span>
                          </div>

                          {/* Toggle between Live App & PNG if both exist */}
                          {storedFigmaUrl && figmaImage && (
                            <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: 1, gap: 1 }}>
                              <button
                                style={{ padding: '1px 6px', fontSize: 10, border: 'none', borderRadius: 9, cursor: 'pointer', background: figmaViewMode === 'live' ? 'rgba(255,255,255,0.2)' : 'transparent', color: figmaViewMode === 'live' ? '#fff' : '#a1a1aa', fontWeight: figmaViewMode === 'live' ? 600 : 400 }}
                                onClick={() => setFigmaViewMode('live')}
                              >
                                Live App
                              </button>
                              <button
                                style={{ padding: '1px 6px', fontSize: 10, border: 'none', borderRadius: 9, cursor: 'pointer', background: figmaViewMode === 'png' ? 'rgba(255,255,255,0.2)' : 'transparent', color: figmaViewMode === 'png' ? '#fff' : '#a1a1aa', fontWeight: figmaViewMode === 'png' ? 600 : 400 }}
                                onClick={() => setFigmaViewMode('png')}
                              >
                                PNG
                              </button>
                            </div>
                          )}

                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 2 }}>
                            {storedFigmaUrl && (
                              <>
                                <button
                                  style={{ padding: '2px 8px', fontSize: 10, background: 'rgba(255,255,255,0.1)', color: '#e4e4e7', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 12, cursor: 'pointer', fontWeight: 500 }}
                                  onClick={() => {
                                    const doLogin = async () => {
                                      if (typeof (window.electronAPI as any)?.figmaLoginWindow === 'function') {
                                        await (window.electronAPI as any).figmaLoginWindow(storedFigmaUrl)
                                        setTimeout(() => {
                                          try { figmaWebviewRef.current?.reload() } catch {}
                                        }, 500)
                                      } else {
                                        window.open(storedFigmaUrl || 'https://figma.com/login', '_blank', 'width=1024,height=768')
                                      }
                                    }
                                    doLogin()
                                  }}
                                  title="Sign in to Figma with your Google Account"
                                >
                                  Sign In
                                </button>
                                <button
                                  style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.08)', color: '#a1a1aa', border: 'none', borderRadius: '50%', cursor: 'pointer' }}
                                  onClick={() => window.electronAPI.openExternal(storedFigmaUrl)}
                                  title="Open in external browser / Detach"
                                >
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                  </svg>
                                </button>
                              </>
                            )}
                            <button
                              style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.08)', color: '#a1a1aa', border: 'none', borderRadius: '50%', cursor: 'pointer' }}
                              onClick={openFigmaModal}
                              title="Edit Figma Link or Upload PNG"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </button>
                            <button
                              style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: '#a1a1aa', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}
                              onClick={() => {
                                setFigmaSplitOpen(false)
                                setFigmaCardDismissed(true)
                              }}
                              title="Close Figma Panel"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

                        {/* Standard Desktop Viewport Content matching Center Site */}
                        <div className="figma-overlay-side-content" style={{ width: canvasFrame.width, height: canvasFrame.height, background: '#1e1e1e', position: 'relative', overflow: 'hidden', borderRadius: 8 }}>
                          {(storedFigmaUrl && (figmaViewMode === 'live' || !figmaImage)) ? (
                            <webview
                              ref={figmaWebviewRef}
                              src={storedFigmaUrl}
                              partition="persist:figma"
                              style={{
                                width: '100%',
                                height: '100%',
                                border: 'none',
                                background: '#1e1e1e'
                              }}
                              useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                              allowpopups
                            />
                          ) : figmaImage ? (
                            <img
                              src={figmaImage}
                              alt="Figma Design PNG"
                              draggable={false}
                              style={{ transform: `translateY(-${iframeScrollY * (zoom / 100)}px)`, width: '100%' }}
                            />
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, textAlign: 'center', color: '#a1a1aa' }}>
                              <img src={figmaIcon} alt="Figma" width="32" height="32" style={{ marginBottom: 12, opacity: 0.6 }} />
                              <div style={{ color: '#ffffff', fontWeight: 600, fontSize: 13, marginBottom: 4 }}>No Figma Link or PNG Connected</div>
                              <div style={{ fontSize: 11, color: '#a1a1aa', maxWidth: 240, marginBottom: 14 }}>Connect a Figma design URL or upload a PNG image to inspect designs side-by-side.</div>
                              <button
                                style={{ background: '#7c3aed', color: '#ffffff', fontWeight: 600, fontSize: 11, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer' }}
                                onClick={() => {
                                  setFigmaCardDismissed(false)
                                  openFigmaModal()
                                }}
                              >
                                + Connect Figma Link / Upload PNG
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* RIGHT PANEL: Site Snapshot */}
                    {snapshotImage && overlayMode === 'side-by-side' && (
                      <div
                        className="figma-overlay-side"
                        style={{
                          left: canvasFrame.left + canvasFrame.width + 24,
                          top: canvasFrame.top,
                          width: canvasFrame.width,
                          height: canvasFrame.height,
                          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
                          borderRadius: 8,
                          overflow: 'visible',
                          background: '#18181b',
                          display: 'flex',
                          flexDirection: 'column',
                          border: '1px solid rgba(255,255,255,0.12)'
                        }}
                      >
                        {/* Sleek Mini Floating Tooltip Pill ABOVE Frame */}
                        <div
                          style={{
                            position: 'absolute',
                            top: -34,
                            left: 0,
                            height: 26,
                            padding: '3px 8px 3px 6px',
                            background: 'rgba(20, 20, 24, 0.88)',
                            backdropFilter: 'blur(12px)',
                            WebkitBackdropFilter: 'blur(12px)',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            borderRadius: 20,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            zIndex: 10
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 500, color: '#e4e4e7' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                            <span>Site Snapshot {snapshotLabel && snapshotLabel !== 'Site Snapshot' ? `(${snapshotLabel})` : ''}</span>
                          </div>
                          <button
                            style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: '#a1a1aa', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}
                            onClick={() => setSnapshotImage(null)}
                            title="Close Snapshot Panel"
                          >
                            ✕
                          </button>
                        </div>

                        {/* Exact Viewport Card Content matching Center Site */}
                        <div className="figma-overlay-side-content" style={{ width: canvasFrame.width, height: canvasFrame.height, background: '#fff', position: 'relative', overflow: 'hidden', borderRadius: 8 }}>
                          <img
                            src={snapshotImage}
                            alt="Site Snapshot"
                            draggable={false}
                            style={{ transform: `translateY(-${iframeScrollY * (zoom / 100)}px)`, width: '100%' }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Single fallback side-by-side if legacy overlayImage exists without figmaImage or snapshotImage */}
                    {overlayImage && !figmaImage && !snapshotImage && overlayMode === 'side-by-side' && (
                      <div
                        className="figma-overlay-side"
                        style={{
                          left: canvasFrame.left + canvasFrame.width + 24,
                          top: canvasFrame.top,
                          width: canvasFrame.width,
                          height: canvasFrame.height,
                        }}
                      >
                        <div className="figma-overlay-side-label">{overlayLabel}</div>
                        <img
                          src={overlayImage}
                          alt=""
                          draggable={false}
                          style={{ transform: `translateY(-${iframeScrollY * (zoom / 100)}px)` }}
                        />
                      </div>
                    )}

                    {/* Opacity Overlay Mode (Figma or Snapshot) */}
                    {overlayMode === 'overlay' && (snapshotImage || figmaImage || overlayImage) && (
                      <div
                        className="figma-overlay-img"
                        style={{
                          left: canvasFrame.left,
                          top: canvasFrame.top,
                          width: canvasFrame.width,
                          height: canvasFrame.height,
                          opacity: overlayOpacity / 100,
                        }}
                      >
                        <img
                          src={snapshotImage || figmaImage || overlayImage!}
                          alt=""
                          draggable={false}
                          style={{ transform: `translateY(-${iframeScrollY * (zoom / 100)}px)` }}
                        />
                      </div>
                    )}

                    {/* Difference Blend Mode */}
                    {overlayMode === 'diff' && (snapshotImage || figmaImage || overlayImage) && (
                      <div
                        className="figma-overlay-img figma-overlay-diff"
                        style={{
                          left: canvasFrame.left,
                          top: canvasFrame.top,
                          width: canvasFrame.width,
                          height: canvasFrame.height,
                        }}
                      >
                        <img
                          src={snapshotImage || figmaImage || overlayImage!}
                          alt=""
                          draggable={false}
                          style={{ transform: `translateY(-${iframeScrollY * (zoom / 100)}px)` }}
                        />
                      </div>
                    )}
                  </>
                )}

                {/* Guides overlay — positioned to match iframe, so guides scale with zoom */}
                {canvasFrame && (
                  <div className="guides-overlay" style={{
                    left: canvasFrame.left,
                    top: canvasFrame.top,
                    width: canvasFrame.width,
                    height: canvasFrame.height,
                  }}>
                    {guidesOn && guides.map((g, i) => (
                      <div
                        key={i}
                        className={`guide-line guide-${g.axis}`}
                        style={g.axis === 'x'
                          ? { top: `${g.position * 100}%`, left: -canvasFrame.left, width: `calc(100% + ${canvasFrame.left}px + ${canvasFrame.left}px)`, opacity: guidesAlwaysVisible ? 1 : 0 }
                          : { left: `${g.position * 100}%`, top: -canvasFrame.top, height: `calc(100% + ${canvasFrame.top}px + ${canvasFrame.top}px)`, opacity: guidesAlwaysVisible ? 1 : 0 }
                        }
                        onDoubleClick={() => removeGuide(i)}
                      />
                    ))}
                    {draggingGuide && (
                      <div
                        className={`guide-line guide-${draggingGuide.axis}`}
                        style={draggingGuide.axis === 'x'
                          ? { top: `${draggingGuide.position * 100}%`, left: -canvasFrame.left, width: `calc(100% + ${canvasFrame.left}px + ${canvasFrame.left}px)` }
                          : { left: `${draggingGuide.position * 100}%`, top: -canvasFrame.top, height: `calc(100% + ${canvasFrame.top}px + ${canvasFrame.top}px)` }
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Bottom Resizable QA Spreadsheet (Mock Sheets & Google Mastersheet) */}
          {bottomSheetOpen && (workspaceTab === 'editBeta' || workspaceTab === 'layout' || workspaceTab === 'audit') && (
            <>
              <div
                className="panel-resize-handle-v"
                onMouseDown={(e) => onPanelResizeStart('bottom', e)}
                title="Drag up/down to resize QA Tracker Spreadsheet"
              />
              <div className="bottom-sheet-panel" style={{ height: bottomSheetMaximized ? 'calc(100% - 40px)' : bottomSheetHeight, maxHeight: 'calc(100% - 40px)' }}>
                <div className="bottom-sheet-header">
                  <div className="bottom-sheet-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3FB950" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="3" y1="15" x2="21" y2="15" />
                      <line x1="9" y1="3" x2="9" y2="21" />
                      <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                    <span>QA Master Tracker</span>

                    {/* 2 Tabs: Mock Sheets & Mastersheet */}
                    <div className="sheet-tab-switcher">
                      <button
                        className={`sheet-tab-btn ${activeSheetTab === 'mock' ? 'active' : ''}`}
                        onClick={() => setActiveSheetTab('mock')}
                      >
                        Mock Sheets
                      </button>
                      <button
                        className={`sheet-tab-btn ${activeSheetTab === 'google' ? 'active' : ''}`}
                        onClick={() => setActiveSheetTab('google')}
                      >
                        Mastersheet
                      </button>
                    </div>
                  </div>

                  <div className="bottom-sheet-actions">
                    {activeSheetTab === 'google' && googleSheetsUrl && !isEditingGoogleUrl && (
                      <button
                        className="bottom-sheet-link-btn"
                        onClick={() => { setTempGoogleUrl(googleSheetsUrl); setIsEditingGoogleUrl(true) }}
                        title="Edit Google Sheets URL"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                        <span>Change Link</span>
                      </button>
                    )}
                    <button
                      className="bottom-sheet-btn"
                      onClick={() => {
                        if (googleSheetsUrl) {
                          let targetUrl = googleSheetsUrl.trim()
                          if (targetUrl.includes('docs.google.com/spreadsheets')) {
                            if (targetUrl.includes('hl=')) {
                              targetUrl = targetUrl.replace(/hl=[a-zA-Z-]+/g, 'hl=en')
                            } else {
                              const sep = targetUrl.includes('?') ? '&' : '?'
                              targetUrl = `${targetUrl}${sep}hl=en`
                            }
                          }
                          if (typeof window.electronAPI?.openDetachedWindow === 'function') {
                            window.electronAPI.openDetachedWindow(targetUrl, 'QA Master Tracker')
                          } else {
                            window.open(targetUrl, '_blank', 'width=1280,height=850,top=100,left=100,resizable=yes')
                          }
                        } else {
                          setActiveSheetTab('google')
                          setIsEditingGoogleUrl(true)
                        }
                      }}
                      title="Detach QA Master Tracker to standalone native window (Dual Monitors)"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </button>
                    <button
                      className="bottom-sheet-btn"
                      onClick={() => setBottomSheetMaximized((m) => !m)}
                      title={bottomSheetMaximized ? "Restore spreadsheet height" : "Maximize spreadsheet height"}
                    >
                      {bottomSheetMaximized ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="4 14 10 14 10 20" />
                          <polyline points="20 10 14 10 14 4" />
                          <polyline points="14 4 14 10 20 10" />
                          <polyline points="10 20 10 14 4 14" />
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="15 3 21 3 21 9" />
                          <polyline points="9 21 3 21 3 15" />
                          <line x1="21" y1="3" x2="14" y2="10" />
                          <line x1="3" y1="21" x2="10" y2="14" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="bottom-sheet-btn"
                      onClick={() => setBottomSheetOpen(false)}
                      title="Collapse spreadsheet"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="bottom-sheet-body">
                  {activeSheetTab === 'mock' ? (
                    <Workbook data={defaultQaSheetData} showToolbar={true} />
                  ) : (
                    isEditingGoogleUrl || !googleSheetsUrl ? (
                      <div className="google-sheet-input-container">
                        <div className="google-sheet-input-card">
                          <div className="google-sheet-icon-wrap">
                            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#3FB950" strokeWidth="1.5">
                              <rect x="3" y="3" width="18" height="18" rx="2" />
                              <line x1="3" y1="9" x2="21" y2="9" />
                              <line x1="3" y1="15" x2="21" y2="15" />
                              <line x1="9" y1="3" x2="9" y2="21" />
                              <line x1="15" y1="3" x2="15" y2="21" />
                            </svg>
                          </div>
                          <h3>Google Mastersheet URL</h3>
                          <p>Paste your Google Sheets link below or pull directly from a Monday.com ticket:</p>
                          <div className="google-sheet-input-row" style={{ marginBottom: 12 }}>
                            <input
                              ref={googleSheetInputRef}
                              type="url"
                              className="google-sheet-input"
                              placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                              value={tempGoogleUrl}
                              onChange={(e) => setTempGoogleUrl(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleSaveGoogleUrl()}
                              autoFocus
                            />
                            <button
                              className="google-sheet-save-btn"
                              onClick={() => handleSaveGoogleUrl()}
                              disabled={!tempGoogleUrl.trim()}
                            >
                              Connect Sheet
                            </button>
                          </div>

                          <button
                            onClick={() => openMondayTicketPicker('mastersheet')}
                            style={{
                              background: '#27272a',
                              border: '1px solid rgba(255,255,255,0.12)',
                              color: '#e4e4e7',
                              borderRadius: 6,
                              padding: '8px 14px',
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              margin: '0 auto',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            <img src={mondayIcon} alt="Monday" width="14" height="14" style={{ objectFit: 'contain' }} />
                            <span>Add from Monday Ticket</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      typeof window !== 'undefined' && (window as any).electronAPI ? (
                        React.createElement('webview', {
                          src: getGoogleSheetsEmbedUrl(googleSheetsUrl),
                          className: 'google-sheets-iframe',
                          allowpopups: 'true',
                          style: { width: '100%', height: '100%', border: 'none', background: '#ffffff' }
                        })
                      ) : (
                        <iframe
                          src={getGoogleSheetsEmbedUrl(googleSheetsUrl)}
                          className="google-sheets-iframe"
                          title="Google Mastersheet"
                          allow="clipboard-read; clipboard-write"
                        />
                      )
                    )
                  )}
                </div>
              </div>
            </>
          )}
        </div>


        {rightPanelOpen && workspaceTab !== 'live' && workspaceTab !== 'editBeta' && workspaceTab !== 'automate' && (
          <div className="panel-resize-handle" onMouseDown={(e) => onPanelResizeStart('right', e)} />
        )}

        {rightPanelOpen && workspaceTab !== 'live' && workspaceTab !== 'editBeta' && workspaceTab !== 'automate' && (
          <div className="editor-panel panel-right" style={{ width: workspaceTab === 'audit' ? Math.max(rightPanelWidth, 320) : rightPanelWidth }}>
          {/* Layout mode panel container — ALWAYS MOUNTED so GrapesJS never loses DOM container references */}
          <div className="layout-panel-wrap" style={{ display: workspaceTab === 'layout' ? 'flex' : 'none', flexDirection: 'column', height: '100%', width: '100%', overflowY: 'auto' }}>
            {/* 1. Collapsible Colors Section (Top of Right Panel) */}
            <div className={`accordion-section right-panel-accordion ${colorsExpanded ? 'expanded' : 'collapsed'}`}>
              <div className="accordion-header">
                <div
                  className="accordion-header-left"
                  onClick={() => setColorsExpanded((p) => !p)}
                  title="Click to toggle Colors"
                  style={{ cursor: 'pointer' }}
                >
                  <svg
                    className={`accordion-chevron ${colorsExpanded ? 'open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span className="accordion-title">Colors</span>
                </div>
                <div className="accordion-header-right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button className="color-scan-btn" onClick={scanPageColors} title="Rescan page colors">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>
                  {selectedColors.size > 0 && (
                    <button className="color-clear-btn" onClick={() => setSelectedColors(new Set())} title="Clear selection">
                      Clear
                    </button>
                  )}
                  <span className="accordion-badge">{pageColors.length}</span>
                </div>
              </div>
              {colorsExpanded && (
                <div className="accordion-content color-palette-content" style={{ padding: '8px' }}>
                  {pageColors.length === 0 ? (
                    <div className="color-palette-empty">No colors detected yet</div>
                  ) : (
                    <div className="color-palette-grid">
                      {pageColors.map(({ hex, count }) => (
                        <button
                          key={hex}
                          className={`color-swatch-btn ${selectedColors.has(hex) ? 'active' : ''}`}
                          onClick={() => toggleColorSelection(hex)}
                          title={`${hex} (${count} uses)`}
                        >
                          <span className="color-swatch-preview" style={{ background: hex }} />
                          <span className="color-swatch-hex">{hex}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 2. Collapsible Detected Fonts Section (Below Colors) */}
            <div className={`accordion-section right-panel-accordion ${fontsExpanded ? 'expanded' : 'collapsed'}`}>
              <div className="accordion-header">
                <div
                  className="accordion-header-left"
                  onClick={() => setFontsExpanded((p) => !p)}
                  title="Click to toggle Fonts"
                  style={{ cursor: 'pointer' }}
                >
                  <svg
                    className={`accordion-chevron ${fontsExpanded ? 'open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span className="accordion-title">Fonts</span>
                </div>
                <div className="accordion-header-right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button className="color-scan-btn" onClick={scanPageFonts} title="Rescan page fonts">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>
                  {selectedFonts.size > 0 && (
                    <button className="color-clear-btn" onClick={() => setSelectedFonts(new Set())} title="Clear selection">
                      Clear
                    </button>
                  )}
                  <span className="accordion-badge">{pageFonts.length}</span>
                </div>
              </div>
              {fontsExpanded && (
                <div className="accordion-content font-palette-content" style={{ padding: '8px' }}>
                  {pageFonts.length === 0 ? (
                    <div className="color-palette-empty">No web fonts detected yet</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {pageFonts.map(({ family, count }) => (
                        <button
                          key={family}
                          className={`font-swatch-btn ${selectedFonts.has(family) ? 'active' : ''}`}
                          onClick={() => toggleFontSelection(family)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: selectedFonts.has(family) ? 'var(--accent-color)' : 'var(--bg-input)',
                            color: selectedFonts.has(family) ? '#ffffff' : 'var(--text-primary)',
                            border: selectedFonts.has(family) ? '1px solid var(--accent-color)' : '1px solid var(--border-color)',
                            borderRadius: '4px',
                            padding: '5px 8px',
                            fontSize: '11px',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <span style={{ fontWeight: 600, fontFamily: `"${family}", sans-serif` }}>{family}</span>
                          <span style={{ fontSize: '10px', opacity: 0.7 }}>{count} uses</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 3. Selectors */}
            <div className="panel-header">Selectors</div>
            <div id="selector-container" className="panel-content" />

            {/* 4. Style Inspector */}
            <div className="panel-header">Style</div>
            <div className="panel-content">
              <NativeStylePanel
                selectedElement={selectedNativeEl}
                onStyleChange={handleNativeStyleChange}
                styleRevision={nativeStyleRevision}
              />
            </div>
          </div>

          {workspaceTab === 'audit' && (
            <div className="audit-panel-wrap" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
              <SeoAuditRightPanel
                html={html}
                sourceUrl={sourceUrl}
                editor={editorRef.current}
                selectedComponent={selectedComponent}
                iframeRef={liveIframeRef}
              />
            </div>
          )}
        </div>
      )}
      </div>

      {/* Add Guides dialog */}
      {addGuidesOpen && (
        <div className="add-guides-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setAddGuidesOpen(false) }}>
          <div className="add-guides-dialog">
            <div className="add-guides-title">New Guide Layout</div>
            <div className="add-guides-row">
              <label>Columns</label>
              <input
                type="number" min={0} max={50}
                value={layoutColumns}
                onChange={(e) => setLayoutColumns(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <div className="add-guides-row">
              <label>Rows</label>
              <input
                type="number" min={0} max={50}
                value={layoutRows}
                onChange={(e) => setLayoutRows(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <div className="add-guides-row">
              <label>Margin (px)</label>
              <input
                type="number" min={0}
                value={layoutMargin}
                onChange={(e) => setLayoutMargin(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <label className="add-guides-check">
              <input
                type="checkbox"
                checked={layoutClear}
                onChange={(e) => setLayoutClear(e.target.checked)}
              />
              <span>Clear existing guides</span>
            </label>
            <div className="add-guides-actions">
              <button className="add-guides-cancel" onClick={() => setAddGuidesOpen(false)}>Cancel</button>
              <button className="add-guides-ok" onClick={addGuideLayout}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* Monday Ticket Picker Overlay Dialog */}
      {mondayPickerOpen && (
        <div className="figma-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setMondayPickerOpen(false) }}>
          <div className="figma-modal-dialog" style={{ maxWidth: 480 }}>
            <div className="figma-modal-header">
              <div className="figma-modal-title-wrap">
                <div className="figma-logo-badge">
                  <img src={mondayIcon} alt="Monday" width="18" height="18" style={{ objectFit: 'contain' }} />
                </div>
                <div>
                  <h3>Select Monday.com Ticket</h3>
                  <p>Pull {mondayPickerTarget === 'mastersheet' ? 'Google Mastersheet' : 'Figma Reference'} directly from ticket:</p>
                </div>
              </div>
              <button className="figma-modal-close-btn" onClick={() => setMondayPickerOpen(false)}>
                ✕
              </button>
            </div>

            {/* Search Input Bar with Auto-Focus */}
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#a1a1aa"
                strokeWidth="2"
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>

              <input
                ref={mondaySearchInputRef}
                type="text"
                className="figma-input-field"
                placeholder="Search tickets by project, board, or status..."
                value={mondaySearchQuery}
                onChange={(e) => setMondaySearchQuery(e.target.value)}
                style={{ paddingLeft: 34, paddingRight: mondaySearchQuery ? 30 : 12, height: 36, fontSize: 12 }}
                autoFocus
              />

              {mondaySearchQuery && (
                <button
                  onClick={() => setMondaySearchQuery('')}
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'transparent',
                    border: 'none',
                    color: '#a1a1aa',
                    cursor: 'pointer',
                    fontSize: 12,
                    padding: '2px 6px'
                  }}
                >
                  ✕
                </button>
              )}
            </div>

            <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 16 }}>
              {loadingMondayTickets ? (
                <div style={{ textAlign: 'center', padding: 20, color: '#a1a1aa', fontSize: 12 }}>Loading Monday tickets...</div>
              ) : filteredMondayTickets.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 20, color: '#a1a1aa', fontSize: 12 }}>
                  {mondaySearchQuery ? `No tickets matching "${mondaySearchQuery}"` : 'No Monday tickets found. Make sure you are logged into Monday.com on the Dashboard.'}
                </div>
              ) : (
                filteredMondayTickets.map((ticket) => {
                  const targetUrl = mondayPickerTarget === 'mastersheet'
                    ? (ticket.googleSheetUrl || ticket.otherLinks?.find(l => l.url.includes('docs.google.com'))?.url)
                    : (ticket.figmaUrl || ticket.otherLinks?.find(l => l.url.includes('figma.com'))?.url)

                  return (
                    <div
                      key={ticket.id}
                      className="figma-ticket-item"
                      onClick={() => {
                        if (targetUrl) {
                          if (mondayPickerTarget === 'mastersheet') {
                            setGoogleSheetsUrl(targetUrl)
                            setTempGoogleUrl(targetUrl)
                            setIsEditingGoogleUrl(false)
                            localStorage.setItem(`qa_${activeProjectId}_google_sheet_url`, targetUrl)
                            if (project) {
                              window.electronAPI.saveProject({ ...project, googleSheetUrl: targetUrl })
                            }
                          } else {
                            setStoredFigmaUrl(targetUrl)
                            setFigmaInputVal(targetUrl)
                            localStorage.setItem(`qa_${activeProjectId}_figma_url`, targetUrl)
                            setFigmaViewMode('live')
                            setFigmaCardDismissed(false)
                            setOverlayMode('side-by-side')
                            if (project) {
                              window.electronAPI.saveProject({ ...project, figmaUrl: targetUrl })
                            }
                          }
                          setMondayPickerOpen(false)
                        }
                      }}
                      style={{ opacity: targetUrl ? 1 : 0.5, cursor: targetUrl ? 'pointer' : 'not-allowed' }}
                    >
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#f4f4f5' }}>{ticket.name}</div>
                        <div style={{ fontSize: 10, color: '#a1a1aa', display: 'flex', gap: 6, marginTop: 2 }}>
                          <span>{ticket.boardName}</span>
                          <span>•</span>
                          <span style={{ color: '#6161ff' }}>{targetUrl ? 'Link Found' : 'No Direct Link'}</span>
                        </div>
                      </div>
                      <span className="chip-badge" style={{ background: '#27272a', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                        {ticket.status}
                      </span>
                    </div>
                  )
                })
              )}
            </div>

            <div className="figma-footer-actions">
              <button className="figma-btn-cancel" onClick={() => loadMondayTicketsForPicker()}>
                Refresh Tickets
              </button>
              <button className="figma-btn-cancel" onClick={() => setMondayPickerOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Redesigned Figma Link / PNG Upload Dialog */}
      {figmaModalOpen && (
        <div className="figma-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setFigmaModalOpen(false) }}>
          <div className="figma-modal-dialog">
            {/* Header */}
            <div className="figma-modal-header">
              <div className="figma-modal-title-wrap">
                <div className="figma-logo-badge">
                  <img src={figmaIcon} alt="Figma" width="18" height="18" style={{ objectFit: 'contain' }} />
                </div>
                <div>
                  <h3>Figma Reference</h3>
                  <p>Attach live app URL, local PNG, or pull from Monday.com</p>
                </div>
              </div>
              <button className="figma-modal-close-btn" onClick={() => setFigmaModalOpen(false)}>
                ✕
              </button>
            </div>

            {/* Segmented Control Tabs */}
            <div className="figma-tabs-bar">
              <button
                className={`figma-tab-btn ${figmaModalTab === 'live' ? 'active' : ''}`}
                onClick={() => setFigmaModalTab('live')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                <span>Live Web URL</span>
              </button>

              <button
                className={`figma-tab-btn ${figmaModalTab === 'png' ? 'active' : ''}`}
                onClick={() => setFigmaModalTab('png')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <span>PNG Image</span>
              </button>

              <button
                className={`figma-tab-btn ${figmaModalTab === 'monday' ? 'active' : ''}`}
                onClick={() => {
                  setFigmaModalTab('monday')
                  loadMondayTicketsForPicker()
                }}
              >
                <img src={mondayIcon} alt="Monday" width="14" height="14" style={{ objectFit: 'contain' }} />
                <span>Monday Ticket</span>
              </button>
            </div>

            {/* Tab 1: Live Web URL */}
            {figmaModalTab === 'live' && (
              <div className="figma-tab-content">
                <label style={{ fontSize: 11, fontWeight: 600, color: '#a1a1aa', display: 'block', marginBottom: 8 }}>
                  FIGMA LIVE APP WEB URL
                </label>
                <div className="figma-input-wrap">
                  <svg className="figma-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  <input
                    type="url"
                    className="figma-input-field"
                    placeholder="https://figma.com/file/... or https://figma.com/design/..."
                    value={figmaInputVal}
                    onChange={(e) => setFigmaInputVal(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveFigmaModal()}
                    autoFocus
                  />
                </div>
                <p style={{ fontSize: 11, color: '#71717a', marginTop: 8 }}>
                  Renders an interactive live Figma file preview on the left side of your workspace.
                </p>
              </div>
            )}

            {/* Tab 2: PNG Image */}
            {figmaModalTab === 'png' && (
              <div className="figma-tab-content">
                <label style={{ fontSize: 11, fontWeight: 600, color: '#a1a1aa', display: 'block', marginBottom: 8 }}>
                  UPLOAD FIGMA DESIGN SCREENSHOT (PNG / WEBP)
                </label>
                
                <label className="figma-dropzone" style={{ display: 'block' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.5" style={{ marginBottom: 6 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#e4e4e7' }}>
                    {figmaImage ? 'Change Attached PNG Reference' : 'Click or Drag PNG Image Here'}
                  </div>
                  <div style={{ fontSize: 11, color: '#71717a', marginTop: 2 }}>Supports PNG, JPEG, WEBP files</div>

                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = (evt) => {
                        const dataUrl = evt.target?.result as string
                        if (dataUrl) {
                          setOverlayImage(dataUrl, 'Figma Design')
                          setFigmaViewMode('png')
                          setFigmaCardDismissed(false)
                          setOverlayMode('side-by-side')
                        }
                      }
                      reader.readAsDataURL(file)
                    }}
                  />
                </label>

                {figmaImage && (
                  <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: '#4ade80', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>✓ PNG Image Attached</span>
                    </div>
                    <button
                      onClick={() => setFigmaImage(null)}
                      style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: 11, cursor: 'pointer', fontWeight: 500 }}
                    >
                      Remove PNG
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Tab 3: Monday Ticket */}
            {figmaModalTab === 'monday' && (
              <div className="figma-tab-content">
                <label style={{ fontSize: 11, fontWeight: 600, color: '#a1a1aa', display: 'block', marginBottom: 8 }}>
                  PULL FIGMA REFERENCE FROM MONDAY TICKET
                </label>
                
                {/* Search Bar with Auto-Focus */}
                <div style={{ position: 'relative', marginBottom: 10 }}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#a1a1aa"
                    strokeWidth="2"
                    style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="figma-input-field"
                    placeholder="Search tickets by project, board, or status..."
                    value={mondaySearchQuery}
                    onChange={(e) => setMondaySearchQuery(e.target.value)}
                    style={{ paddingLeft: 32, paddingRight: mondaySearchQuery ? 28 : 10, height: 32, fontSize: 11 }}
                    autoFocus
                  />
                  {mondaySearchQuery && (
                    <button
                      onClick={() => setMondaySearchQuery('')}
                      style={{
                        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                        background: 'transparent', border: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: 11
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {loadingMondayTickets ? (
                    <div style={{ textAlign: 'center', padding: 14, color: '#a1a1aa', fontSize: 11 }}>Loading Monday tickets...</div>
                  ) : filteredMondayTickets.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 14, color: '#a1a1aa', fontSize: 11 }}>
                      {mondaySearchQuery ? `No tickets matching "${mondaySearchQuery}"` : 'No Monday tickets found with Figma links'}
                    </div>
                  ) : (
                    filteredMondayTickets.map((t) => {
                      const link = t.figmaUrl || t.otherLinks?.find(l => l.url.includes('figma.com'))?.url
                      return (
                        <div
                          key={t.id}
                          className="figma-ticket-item"
                          onClick={() => {
                            if (link) {
                              setStoredFigmaUrl(link)
                              setFigmaInputVal(link)
                              localStorage.setItem(`qa_${activeProjectId}_figma_url`, link)
                              setFigmaViewMode('live')
                              setFigmaCardDismissed(false)
                              setOverlayMode('side-by-side')
                              if (project) {
                                window.electronAPI.saveProject({ ...project, figmaUrl: link })
                              }
                            }
                          }}
                          style={{ opacity: link ? 1 : 0.4, cursor: link ? 'pointer' : 'not-allowed' }}
                        >
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#f4f4f5' }}>{t.name}</div>
                            <div style={{ fontSize: 9, color: '#a1a1aa' }}>{t.boardName}</div>
                          </div>
                          <span style={{ fontSize: 10, color: link ? '#3b82f6' : '#71717a', fontWeight: 600 }}>
                            {link ? 'Use Figma Link ↗' : 'No Figma Link'}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {/* Footer Buttons */}
            <div className="figma-footer-actions">
              {(storedFigmaUrl || figmaImage) && (
                <button
                  className="figma-btn-cancel"
                  onClick={() => {
                    clearFigmaModal()
                    setFigmaImage(null)
                  }}
                  style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)', marginRight: 'auto' }}
                >
                  Remove Reference
                </button>
              )}
              <button className="figma-btn-cancel" onClick={() => setFigmaModalOpen(false)}>
                Cancel
              </button>
              <button
                className="figma-btn-save"
                onClick={() => {
                  saveFigmaModal()
                  setFigmaCardDismissed(false)
                  setOverlayMode('side-by-side')
                }}
              >
                Save & Inspect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
