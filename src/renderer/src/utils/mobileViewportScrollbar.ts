// Mobile browsers use overlay scrollbars. Hide Electron's desktop scrollbar
// inside narrow page previews without disabling wheel, touch, or keyboard scroll.
const MOBILE_SCROLLBAR_CSS = `
  html, body { scrollbar-width: none !important; }
  html::-webkit-scrollbar, body::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
`

export const isMobilePreview = (width: number): boolean => width > 0 && width <= 600

export interface ScrollbarWebview {
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
  addEventListener(type: 'dom-ready', listener: () => void): void
  removeEventListener(type: 'dom-ready', listener: () => void): void
  getURL?(): string
  isLoading?(): boolean
}

export function bindMobileViewportScrollbar(view: ScrollbarWebview, mobile: boolean): () => void {
  if (!mobile) return () => {}

  let disposed = false
  let generation = 0
  let cssKey: string | null = null

  const remove = (key: string | null) => {
    if (!key) return
    // Electron throws synchronously if React has already detached the webview.
    // A rejected-promise handler alone cannot protect effect cleanup.
    try {
      void view.removeInsertedCSS(key).catch(() => {})
    } catch {}
  }

  const install = () => {
    const current = ++generation
    remove(cssKey)
    cssKey = null
    try {
      void view.insertCSS(MOBILE_SCROLLBAR_CSS).then(key => {
        if (disposed || current !== generation) remove(key)
        else cssKey = key
      }).catch(() => {})
    } catch {}
  }

  view.addEventListener('dom-ready', install)
  try {
    if (view.getURL?.() && !view.isLoading?.()) install()
  } catch {}

  return () => {
    disposed = true
    generation++
    view.removeEventListener('dom-ready', install)
    remove(cssKey)
    cssKey = null
  }
}
