import { describe, expect, it, vi } from 'vitest'
import { bindMobileViewportScrollbar, isMobilePreview, type ScrollbarWebview } from './mobileViewportScrollbar'

function mockWebview() {
  let ready: (() => void) | undefined
  let keyNumber = 0
  const view = {
    insertCSS: vi.fn(async (_css: string) => `css-${++keyNumber}`),
    removeInsertedCSS: vi.fn(async () => {}),
    addEventListener: vi.fn((_type: 'dom-ready', listener: () => void) => { ready = listener }),
    removeEventListener: vi.fn(() => { ready = undefined }),
    getURL: () => 'https://example.test/',
    isLoading: () => false,
  }
  return { view, navigate: () => ready?.() }
}

describe('mobile preview scrollbar', () => {
  it('targets narrow viewports and keeps desktop webviews untouched', () => {
    expect(isMobilePreview(430)).toBe(true)
    expect(isMobilePreview(600)).toBe(true)
    expect(isMobilePreview(601)).toBe(false)
    const { view } = mockWebview()
    bindMobileViewportScrollbar(view, false)()
    expect(view.insertCSS).not.toHaveBeenCalled()
  })

  it('installs after navigation and removes its CSS when the viewport changes', async () => {
    const { view, navigate } = mockWebview()
    const cleanup = bindMobileViewportScrollbar(view, true)
    await Promise.resolve()
    expect(view.insertCSS).toHaveBeenCalledOnce()
    expect(view.insertCSS.mock.calls[0][0]).toContain('scrollbar-width: none')
    navigate()
    await Promise.resolve()
    expect(view.insertCSS).toHaveBeenCalledTimes(2)
    expect(view.removeInsertedCSS).toHaveBeenCalledWith('css-1')
    cleanup()
    expect(view.removeInsertedCSS).toHaveBeenCalledWith('css-2')
  })

  it('removes a late CSS insertion after the mobile preview closes', async () => {
    let resolveInsert!: (key: string) => void
    const { view } = mockWebview()
    view.insertCSS = vi.fn((_css: string) => new Promise<string>(resolve => { resolveInsert = resolve }))
    const cleanup = bindMobileViewportScrollbar(view as ScrollbarWebview, true)
    cleanup()
    resolveInsert('late-key')
    await Promise.resolve()
    expect(view.removeInsertedCSS).toHaveBeenCalledWith('late-key')
  })

  it('does not crash when a viewport or workspace switch detaches the webview first', async () => {
    const { view } = mockWebview()
    const cleanup = bindMobileViewportScrollbar(view, true)
    await Promise.resolve()
    view.removeInsertedCSS = vi.fn(() => {
      throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
    })

    expect(cleanup).not.toThrow()
    expect(cleanup).not.toThrow()
    expect(view.removeInsertedCSS).toHaveBeenCalledWith('css-1')
  })

  it('ignores CSS insertion when a webview detaches during navigation', () => {
    const { view } = mockWebview()
    view.insertCSS = vi.fn(() => {
      throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
    })

    const cleanup = bindMobileViewportScrollbar(view, true)
    expect(cleanup).not.toThrow()
  })

  it('ignores a late insertion whose CSS cannot be removed after detach', async () => {
    let resolveInsert!: (key: string) => void
    const { view } = mockWebview()
    view.insertCSS = vi.fn(() => new Promise<string>(resolve => { resolveInsert = resolve }))
    const cleanup = bindMobileViewportScrollbar(view, true)
    cleanup()
    view.removeInsertedCSS = vi.fn(() => {
      throw new Error('WebView detached')
    })

    resolveInsert('late-key')
    await Promise.resolve()
    expect(view.removeInsertedCSS).toHaveBeenCalledWith('late-key')
  })
})
