import type { AppTheme, AppSettings, AppHotkeys } from '../../../shared/types'

export const DEFAULT_HOTKEYS: AppHotkeys = {
  quickSave: 'Ctrl + S',
  undo: 'Ctrl + Z',
  redo: 'Ctrl + Shift + Z',
  deselect: 'Escape',
  panMode: 'Space',
  zoomIn: 'Ctrl + =',
  zoomOut: 'Ctrl + -',
  resetZoom: 'Ctrl + 0',
  toggleRulers: 'Alt + R',
  toggleGuides: 'Alt + G',
  toggleBoundaries: 'Alt + B',
  cycleFontInspector: 'Alt + F',
  toggleLeftPanel: 'Ctrl + Shift + 1',
  toggleBottomPanel: 'Ctrl + Shift + 2',
  toggleRightPanel: 'Ctrl + Shift + 3',
  viewportDesktop: 'Alt + Shift + 1',
  viewportTablet: 'Alt + Shift + 2',
  viewportMobile: 'Alt + Shift + 3',
  toggleCanvasMode: 'Alt + Shift + M',
  workspaceEdit: 'Alt + 1',
  workspaceLive: 'Alt + 2',
  workspaceAudit: 'Alt + 3',
  workspaceAutomate: 'Alt + 4',
  toggleInteractionMode: 'Alt + I',
  activateEyedropper: 'Alt + E',
  toggleAnnotate: 'Shift + A',
  annotationSelect: 'V',
  annotationBox: 'B',
  annotationArrow: 'A',
  annotationRectangle: 'R',
  annotationCircle: 'C',
  annotationPen: 'P',
  annotationText: 'T',
  annotationBlur: 'U',
  toggleRecording: 'Alt + Shift + R',
  generateItems: 'Alt + Shift + G'
}

export type HotkeyDefinitionGroup = 'General' | 'Inspection' | 'Panels' | 'Viewports' | 'Workspaces' | 'Annotate'

export const HOTKEY_DEFINITIONS: Array<{
  key: keyof AppHotkeys
  label: string
  description: string
  group: HotkeyDefinitionGroup
}> = [
  { key: 'quickSave', label: 'Quick save', description: 'Persist the current editable page state', group: 'General' },
  { key: 'undo', label: 'Undo', description: 'Move one step backward in workspace history', group: 'General' },
  { key: 'redo', label: 'Redo', description: 'Move one step forward in workspace history', group: 'General' },
  { key: 'deselect', label: 'Deselect', description: 'Clear the current element or annotation selection', group: 'General' },
  { key: 'panMode', label: 'Pan canvas', description: 'Hold while dragging to pan the canvas', group: 'General' },
  { key: 'zoomIn', label: 'Zoom in', description: 'Increase canvas zoom', group: 'General' },
  { key: 'zoomOut', label: 'Zoom out', description: 'Decrease canvas zoom', group: 'General' },
  { key: 'resetZoom', label: 'Reset zoom', description: 'Return canvas zoom and pan to 100%', group: 'General' },
  { key: 'toggleRulers', label: 'Toggle rulers', description: 'Show or hide canvas rulers', group: 'Inspection' },
  { key: 'toggleGuides', label: 'Toggle guides', description: 'Show or hide alignment guides', group: 'Inspection' },
  { key: 'toggleBoundaries', label: 'Toggle boundaries', description: 'Enable or disable element boundaries', group: 'Inspection' },
  { key: 'cycleFontInspector', label: 'Cycle font inspector', description: 'Selected element, all elements, then off', group: 'Inspection' },
  { key: 'toggleLeftPanel', label: 'Toggle left panel', description: 'Show or hide annotations, layers, and history', group: 'Panels' },
  { key: 'toggleBottomPanel', label: 'Toggle bottom panel', description: 'Show or hide the QA spreadsheet', group: 'Panels' },
  { key: 'toggleRightPanel', label: 'Toggle right panel', description: 'Show or hide styles and audit tools', group: 'Panels' },
  { key: 'viewportDesktop', label: 'Desktop viewport', description: 'Switch to the desktop template', group: 'Viewports' },
  { key: 'viewportTablet', label: 'Tablet viewport', description: 'Switch to the tablet template', group: 'Viewports' },
  { key: 'viewportMobile', label: 'Mobile viewport', description: 'Switch to the mobile template', group: 'Viewports' },
  { key: 'toggleCanvasMode', label: 'Single / multi canvas', description: 'Toggle single and multi-device canvas modes', group: 'Viewports' },
  { key: 'workspaceEdit', label: 'Open Edit workspace', description: 'Switch to direct editing', group: 'Workspaces' },
  { key: 'workspaceLive', label: 'Open Live workspace', description: 'Switch to the interactive live page', group: 'Workspaces' },
  { key: 'workspaceAudit', label: 'Open Audit workspace', description: 'Switch to QA audit tools', group: 'Workspaces' },
  { key: 'workspaceAutomate', label: 'Open Automate workspace', description: 'Switch to automated comparison', group: 'Workspaces' },
  { key: 'toggleInteractionMode', label: 'Edit / interact mode', description: 'Toggle page editing and native interaction', group: 'Workspaces' },
  { key: 'activateEyedropper', label: 'Eyedropper mode', description: 'Inspect hovered element colors and copy their HEX value', group: 'Inspection' },
  { key: 'toggleAnnotate', label: 'Toggle Annotate', description: 'Open or close the annotation toolbar', group: 'Annotate' },
  { key: 'annotationSelect', label: 'Select tool', description: 'Use element and annotation selection', group: 'Annotate' },
  { key: 'annotationBox', label: 'Selection box tool', description: 'Draw a dashed selection box', group: 'Annotate' },
  { key: 'annotationArrow', label: 'Arrow tool', description: 'Draw an arrow annotation', group: 'Annotate' },
  { key: 'annotationRectangle', label: 'Rectangle tool', description: 'Draw a rectangle annotation', group: 'Annotate' },
  { key: 'annotationCircle', label: 'Circle tool', description: 'Draw a circular annotation', group: 'Annotate' },
  { key: 'annotationPen', label: 'Pen tool', description: 'Draw a freehand annotation', group: 'Annotate' },
  { key: 'annotationText', label: 'Text tool', description: 'Place a text annotation', group: 'Annotate' },
  { key: 'annotationBlur', label: 'Blur tool', description: 'Redact an area', group: 'Annotate' },
  { key: 'toggleRecording', label: 'Start / stop recording', description: 'Toggle before-and-after change recording', group: 'Annotate' },
  { key: 'generateItems', label: 'Generate items', description: 'Open the ephemeral-link expiry picker', group: 'Annotate' }
]

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'parity',
  snapshotDirectory: 'Default (App Storage Path)',
  autoPurgeTrashDays: 14,
  captureDpiScale: 1,
  captureTimeoutMs: 5000,
  defaultViewport: 'Desktop (1920×1200)',
  mondaySyncIntervalMinutes: 15,
  hotkeys: DEFAULT_HOTKEYS
}

export const THEME_LIST: Array<{ id: AppTheme; name: string; description: string; previewBg: string; previewAccent: string }> = [
  { id: 'parity', name: 'Parity', description: 'The default Ink and Paper workspace with neutral Slate controls', previewBg: '#1c2321', previewAccent: '#8a918e' },
  { id: 'dark', name: 'Dark Sleek', description: 'Monotone obsidian dark theme with blue accents', previewBg: '#121214', previewAccent: '#3b82f6' },
  { id: 'light', name: 'Light Clean', description: 'Crisp high-contrast light theme for bright spaces', previewBg: '#f8fafc', previewAccent: '#2563eb' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', description: 'Warm pastel dark theme with mauve highlights', previewBg: '#1e1e2e', previewAccent: '#cba6f7' },
  { id: 'nord', name: 'Nordic Frost', description: 'Arctic blue tone palette inspired by Scandinavian cold', previewBg: '#2e3440', previewAccent: '#88c0d0' },
  { id: 'cyberpunk-gold', name: 'Cyberpunk Gold', description: 'Neon obsidian with vibrant yellow gold accents', previewBg: '#0f0f14', previewAccent: '#eab308' },
  { id: 'tokyo-night', name: 'Tokyo Night', description: 'Deep purple-blue night palette with neon cyan accents', previewBg: '#1a1b26', previewAccent: '#7aa2f7' },
  { id: 'dracula', name: 'Dracula Pro', description: 'Vibrant gothic dark theme with pink & purple accents', previewBg: '#282a36', previewAccent: '#ff79c6' },
  { id: 'synthwave-84', name: 'Synthwave \'84', description: 'Retro 80s neon purple & hot pink glowing theme', previewBg: '#262335', previewAccent: '#ff7edb' },
  { id: 'github-dark', name: 'GitHub Dark', description: 'Official high-contrast dark palette from GitHub', previewBg: '#0d1117', previewAccent: '#2f81f7' },
  { id: 'rose-pine', name: 'Rosé Pine', description: 'Soho vibes dark palette with muted rose & gold', previewBg: '#191724', previewAccent: '#ebbcba' },
  { id: 'monokai-pro', name: 'Monokai Pro', description: 'Classic warm dark theme with bright orange/yellow accents', previewBg: '#2d2a2e', previewAccent: '#ff6188' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', description: 'Retro warm earthy dark theme with amber gold accents', previewBg: '#282828', previewAccent: '#fabd2f' },
  { id: 'solarized-dark', name: 'Solarized Dark', description: 'Precision cyan dark theme based on Solarized color science', previewBg: '#002b36', previewAccent: '#2aa198' },
  { id: 'emerald-abyss', name: 'Emerald Abyss', description: 'Deep oceanic dark theme with vibrant emerald green', previewBg: '#061e19', previewAccent: '#10b981' },
  { id: 'one-dark-pro', name: 'One Dark Pro', description: 'Atom classic dark theme with soft blue & magenta', previewBg: '#21252b', previewAccent: '#61afef' },
  { id: 'sunset-crimson', name: 'Sunset Crimson', description: 'Vibrant velvet dark theme with ruby red & coral accents', previewBg: '#180d14', previewAccent: '#f43f5e' },
  { id: 'oled-black', name: 'OLED Pitch Black', description: 'Pure true black palette with electric blue highlights', previewBg: '#000000', previewAccent: '#0066ff' },
  { id: 'nord-deep', name: 'Nord Deep', description: 'Deeper midnight arctic navy & frosted blue', previewBg: '#1a1e24', previewAccent: '#81a1c1' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', description: 'Soothing warm pastel light theme', previewBg: '#eff1f5', previewAccent: '#8839ef' },
  { id: 'rose-gold', name: 'Rose Gold', description: 'Luxury dark titanium with warm rose gold accents', previewBg: '#1c191a', previewAccent: '#e0a96d' },
  { id: 'cyberpunk-neon', name: 'Cyberpunk Neon', description: 'High-voltage neon magenta and cyan night palette', previewBg: '#0c0b10', previewAccent: '#ff0055' },
  { id: 'midnight-amethyst', name: 'Midnight Amethyst', description: 'Royal deep violet & glowing lavender palette', previewBg: '#140c1e', previewAccent: '#a855f7' },
  { id: 'emerald-forest', name: 'Emerald Forest', description: 'Lush dark pine forest green palette', previewBg: '#081711', previewAccent: '#34d399' },
  { id: 'cobalt-blue', name: 'Cobalt Blue', description: 'Deep rich navy blue with glowing cobalt highlights', previewBg: '#0a1428', previewAccent: '#38bdf8' },
  { id: 'solarized-light', name: 'Solarized Light', description: 'Warm parchment precision light palette', previewBg: '#fdf6e3', previewAccent: '#b58900' },
  { id: 'sepia-paper', name: 'Sepia Vintage', description: 'Classic warm sepia book paper palette', previewBg: '#f4ebd0', previewAccent: '#8c6d46' },
  { id: 'ayu-dark', name: 'Ayu Dark', description: 'Sleek charcoal dark theme with bright orange accents', previewBg: '#0f1419', previewAccent: '#ffb454' },
  { id: 'palenight', name: 'Palenight', description: 'Material soft indigo night palette', previewBg: '#292d3e', previewAccent: '#c792ea' },
  { id: 'synthwave-neon', name: 'Synthwave Neon', description: 'Bright 80s arcade neon green & hot pink palette', previewBg: '#13111c', previewAccent: '#00ffcc' },
  { id: 'horizon-dark', name: 'Horizon Dark', description: 'Warm reddish dark space palette with coral gold', previewBg: '#1c1e26', previewAccent: '#e95678' },
  { id: 'dracula-vampire', name: 'Dracula Crimson', description: 'Ultra rich blood crimson dark gothic theme', previewBg: '#1a090d', previewAccent: '#ff2a5f' },
  { id: 'github-light', name: 'GitHub Light', description: 'Official crisp high-contrast light theme from GitHub', previewBg: '#ffffff', previewAccent: '#0969da' },
  { id: 'monochrome-dark', name: 'Monochrome Dark', description: 'Minimalist pure grayscale dark theme', previewBg: '#121212', previewAccent: '#e5e5e5' },
  { id: 'monochrome-light', name: 'Monochrome Light', description: 'Minimalist pure grayscale light theme', previewBg: '#f5f5f5', previewAccent: '#171717' },
  { id: 'ocean-breeze', name: 'Ocean Breeze', description: 'Cool cyan & turquoise aquatic dark theme', previewBg: '#0d1f2d', previewAccent: '#00f2fe' },
  { id: 'amber-terminal', name: 'Amber CRT', description: 'Classic retro CRT amber phosphor dark theme', previewBg: '#100c00', previewAccent: '#ffb000' }
]

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('qa_app_settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        hotkeys: { ...DEFAULT_HOTKEYS, ...(parsed.hotkeys || {}) }
      }
    }
  } catch (_) {}
  return DEFAULT_SETTINGS
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem('qa_app_settings', JSON.stringify(settings))
  } catch (_) {}
  applyTheme(settings.theme)
  window.dispatchEvent(new CustomEvent('parity:account-state-dirty', { detail: { settings } }))
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export function readThemeAccentColor(): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return THEME_LIST[0].previewAccent
  }
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() ||
    THEME_LIST[0].previewAccent
  )
}
