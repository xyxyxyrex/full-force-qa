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
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.setAttribute('data-theme', theme)
}
