import type { AppTheme, AppSettings, AppHotkeys } from '../../../shared/types'

export const DEFAULT_HOTKEYS: AppHotkeys = {
  quickSave: 'Ctrl + S',
  undo: 'Ctrl + Z',
  redo: 'Ctrl + Y',
  toggleRulers: 'Ctrl + R',
  toggleBoundaries: 'Ctrl + B',
  resetZoom: 'Ctrl + 0',
  deselect: 'Escape',
  panMode: 'Space + Click'
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  snapshotDirectory: 'Default (App Storage Path)',
  autoPurgeTrashDays: 14,
  captureDpiScale: 1,
  captureTimeoutMs: 5000,
  defaultViewport: 'Desktop (1920×1200)',
  mondaySyncIntervalMinutes: 15,
  hotkeys: DEFAULT_HOTKEYS
}

export const THEME_LIST: Array<{ id: AppTheme; name: string; description: string; previewBg: string; previewAccent: string }> = [
  { id: 'dark', name: 'Dark Sleek', description: 'Monotone obsidian dark theme with blue accents', previewBg: '#121214', previewAccent: '#3b82f6' },
  { id: 'light', name: 'Light Clean', description: 'Crisp high-contrast light theme for bright spaces', previewBg: '#f8fafc', previewAccent: '#2563eb' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', description: 'Warm pastel dark theme with mauve highlights', previewBg: '#1e1e2e', previewAccent: '#cba6f7' },
  { id: 'nord', name: 'Nordic Frost', description: 'Arctic blue tone palette inspired by Scandinavian cold', previewBg: '#2e3440', previewAccent: '#88c0d0' },
  { id: 'cyberpunk-gold', name: 'Cyberpunk Gold', description: 'Neon obsidian with vibrant yellow gold accents', previewBg: '#0f0f14', previewAccent: '#eab308' },
  { id: 'tokyo-night', name: 'Tokyo Night', description: 'Deep purple-blue night palette with neon cyan accents', previewBg: '#1a1b26', previewAccent: '#7aa2f7' }
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
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.setAttribute('data-theme', theme)
}
