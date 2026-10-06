import { BrowserWindow, session, type Session, type WebContents } from 'electron'
import { acquireDebugger, type DebuggerLease } from '../debuggerConnection'
import type { Breakpoint } from '../../shared/designScale'
import { userAgentFor, viewportHeightFor } from './captureSettings'
import { checkApiRequest, checkNavigation, checkRequest, linkCheckPlan, SEND_OFF_REASON } from './qaBrowserPolicy'
import { AUDIT_SCRIPT, BOX_SCRIPT, call, FOCUS_SCRIPT, LINKS_SCRIPT, SCROLL_SCRIPT, SELECT_SCRIPT, SEND_GUARD_SCRIPT, SNAPSHOT_SCRIPT, TARGET_SCRIPT } from './qaBrowserScripts'
import type { BrowserEvents, BrowserOpenInput, BrowserStep, HttpResult, LinkResult, PageAudit, QaBrowser } from './qaBrowserTypes'

// The agent's own browser: an offscreen window it can click, type into and scroll, on a session of
// its own (so its rules never touch the rest of Parity), with the person's login cookies for the
// site under review copied in. It stays on that site, never opens WordPress admin, login or logout,
// and sends no data unless the person allowed it (see qaBrowserPolicy.ts).

const PARTITION = 'parity-qa-browser'
const LOAD_TIMEOUT_MS = 30_000
const SETTLE_MS = 600
const IDLE_CLOSE_MS = 10 * 60 * 1000
const ELEMENT_LIMIT = 120
const MAX_EVENTS = 200
const LINK_LIMIT = 150
const LINK_CONCURRENCY = 6
const REQUEST_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 100 * 1024
const SEND_BINDING = '__parityBlockedSend'

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string; shift?: boolean }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  'Shift+Tab': { key: 'Tab', code: 'Tab', keyCode: 9, shift: true },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
}

interface OpenState {
  win: BrowserWindow
  contents: WebContents
  lease: DebuggerLease
  site: string
  allowSend: boolean
  runId: string
  breakpoint: Breakpoint
  events: BrowserEvents
  mainStatus?: number
  idle: NodeJS.Timeout | null
}

const emptyEvents = (): BrowserEvents => ({ console: [], requests: [], blocked: [], dialogs: [], popups: [], downloads: [] })
const push = <T,>(list: T[], item: T) => { list.push(item); if (list.length > MAX_EVENTS) list.shift() }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function eventsSince(events: BrowserEvents, mark: Record<keyof BrowserEvents, number>): BrowserEvents {
  return {
    console: events.console.slice(mark.console), requests: events.requests.slice(mark.requests), blocked: events.blocked.slice(mark.blocked),
    dialogs: events.dialogs.slice(mark.dialogs), popups: events.popups.slice(mark.popups), downloads: events.downloads.slice(mark.downloads),
  }
}
const markOf = (events: BrowserEvents) => ({ console: events.console.length, requests: events.requests.length, blocked: events.blocked.length, dialogs: events.dialogs.length, popups: events.popups.length, downloads: events.downloads.length })

export function createQaBrowser(): QaBrowser {
  let state: OpenState | null = null
  let qaSession: Session | null = null

  // One session for the agent's browser, set up once. Its request rules read the page that is open now.
  function browserSession(): Session {
    if (qaSession) return qaSession
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event, item) => {
      event.preventDefault()
      if (state) push(state.events.downloads, item.getURL())
    })
    ses.webRequest.onBeforeRequest((details, callback) => {
      const open = state
      if (!open) return callback({ cancel: true })
      const verdict = checkRequest({ method: details.method, url: details.url, resourceType: details.resourceType, site: open.site, allowSend: open.allowSend })
      if (verdict.allow) return callback({})
      if (details.webContentsId === open.contents.id || details.webContentsId === undefined) push(open.events.blocked, verdict.blocked)
      callback({ cancel: true })
    })
    ses.webRequest.onCompleted((details) => {
      const open = state
      if (!open || details.webContentsId !== open.contents.id) return
      if (details.resourceType === 'mainFrame') open.mainStatus = details.statusCode
      if (details.statusCode >= 400) push(open.events.requests, { method: details.method, url: details.url, status: details.statusCode, type: details.resourceType })
    })
    ses.webRequest.onErrorOccurred((details) => {
      const open = state
      if (!open || details.webContentsId !== open.contents.id) return
      // Requests Parity blocked are already listed as blocked; an aborted request is the page changing its mind.
      if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(details.error)) return
      push(open.events.requests, { method: details.method, url: details.url, error: details.error, type: details.resourceType })
    })
    qaSession = ses
    return ses
  }

  function requireOpen(): OpenState {
    if (!state || state.contents.isDestroyed()) throw new Error('No page is open in the agent\'s browser. Call browser_open first.')
    if (state.idle) clearTimeout(state.idle)
    state.idle = setTimeout(close, IDLE_CLOSE_MS)
    return state
  }

  async function evaluate<T>(open: OpenState, script: string, ...args: unknown[]): Promise<T> {
    return open.contents.executeJavaScript(call(script, ...args), true) as Promise<T>
  }

  async function screenshot(open: OpenState): Promise<Buffer> {
    try {
      const shot = await open.lease.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
      return Buffer.from(shot.data, 'base64')
    } catch {
      return (await open.contents.capturePage()).toJPEG(70)
    }
  }

  async function waitForLoad(contents: WebContents, timeoutMs: number): Promise<void> {
    if (!contents.isLoading()) return
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); contents.off('did-stop-loading', done); resolve() }
      const timer = setTimeout(done, timeoutMs)
      contents.on('did-stop-loading', done)
    })
  }

  /** Runs one action like a person would, waits for the page to settle, and says what changed. */
  async function step(action: (open: OpenState) => Promise<string | void>): Promise<BrowserStep> {
    const open = requireOpen()
    const mark = markOf(open.events)
    const before = open.contents.getURL()
    let navigating = false
    let blockedLoad = false
    const onStart = (event: any, url?: string, isInPlace?: boolean, isMainFrame?: boolean) => {
      const main = typeof event?.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame
      const sameDocument = typeof event?.isSameDocument === 'boolean' ? event.isSameDocument : isInPlace
      if (main && !sameDocument) navigating = true
      void url
    }
    // -20 is ERR_BLOCKED_BY_CLIENT: Parity's request rules stopped a page load.
    const onFail = (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean) => { if (isMainFrame && code === -20) blockedLoad = true }
    open.contents.on('did-start-navigation', onStart)
    open.contents.on('did-fail-load', onFail)
    let note: string | void
    try {
      note = await action(open)
      await sleep(350)
      if (navigating || open.contents.isLoading()) await waitForLoad(open.contents, 15_000)
      if (blockedLoad && open.contents.navigationHistory.canGoBack()) {
        // Leave Chromium's error page so the agent keeps the page it was testing.
        open.contents.navigationHistory.goBack()
        await sleep(350)
        await waitForLoad(open.contents, 15_000)
        note = [note, 'Parity blocked that page load, so the browser went back to the page before it.'].filter(Boolean).join(' ')
      }
      await sleep(SETTLE_MS)
    } finally {
      open.contents.off('did-start-navigation', onStart)
      open.contents.off('did-fail-load', onFail)
    }
    const snapshot = await evaluate<BrowserStep['snapshot']>(open, SNAPSHOT_SCRIPT, ELEMENT_LIMIT)
    return { snapshot, screenshot: await screenshot(open), navigated: snapshot.url !== before, status: open.mainStatus, events: eventsSince(open.events, mark), ...(note ? { note } : {}) }
  }

  async function mouseClick(open: OpenState, x: number, y: number): Promise<void> {
    await open.lease.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await open.lease.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await open.lease.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  async function key(open: OpenState, name: string): Promise<void> {
    const definition = KEYS[name]
    if (!definition) throw new Error(`Unknown key "${name}".`)
    const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, nativeVirtualKeyCode: definition.keyCode, modifiers: definition.shift ? 8 : 0 }
    await open.lease.send('Input.dispatchKeyEvent', { type: definition.text ? 'keyDown' : 'rawKeyDown', ...base, ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}) })
    await open.lease.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async function copyLoginCookies(ses: Session, pageUrl: string): Promise<void> {
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'serviceworkers', 'cachestorage'] }).catch(() => {})
    const origin = new URL(pageUrl).origin
    const cookies = await session.defaultSession.cookies.get({ url: origin }).catch(() => [])
    for (const cookie of cookies) {
      await ses.cookies.set({
        url: origin, name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
        ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}), ...(cookie.sameSite && cookie.sameSite !== 'unspecified' ? { sameSite: cookie.sameSite } : {}),
      }).catch(() => {})
    }
  }

  function close(): void {
    const open = state
    state = null
    if (!open) return
    if (open.idle) clearTimeout(open.idle)
    try { open.lease.release() } catch { /* already gone */ }
    if (!open.win.isDestroyed()) open.win.destroy()
  }

  return {
    get runId() { return state?.runId ?? null },
    get site() { return state?.site ?? null },
    get breakpoint() { return state?.breakpoint ?? null },

    async open(input: BrowserOpenInput): Promise<BrowserStep> {
      const verdict = checkNavigation(input.url, input.site)
      if (!verdict.allowed) throw new Error(`That page cannot be opened: ${verdict.reason}.`)
      close()
      const ses = browserSession()
      await copyLoginCookies(ses, input.url)
      const height = viewportHeightFor(input.width)
      const mobile = input.breakpoint !== 'desktop'
      const win = new BrowserWindow({
        show: false, width: input.width, height,
        webPreferences: { session: ses, offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
      })
      const contents = win.webContents
      const events = emptyEvents()
      contents.setWindowOpenHandler(({ url }) => { push(events.popups, url); return { action: 'deny' } })
      contents.on('will-navigate', (event, url) => {
        const target = typeof url === 'string' ? url : (event as unknown as { url: string }).url
        const check = checkNavigation(target, input.site)
        if (!check.allowed) { event.preventDefault(); push(events.blocked, { kind: 'navigation', method: 'GET', url: target, reason: check.reason }) }
      })
      contents.on('console-message', (event) => {
        const { level, message, sourceId } = event as unknown as { level: string; message: string; sourceId: string }
        if (level !== 'error' && level !== 'warning') return
        push(events.console, { level, message: String(message ?? '').slice(0, 300), source: String(sourceId ?? '').slice(0, 200) || undefined })
      })
      await contents.loadURL('about:blank')
      const lease = acquireDebugger(contents.id, 'qa-browser')
      state = { win, contents, lease, site: input.site, allowSend: input.allowSend, runId: input.runId, breakpoint: input.breakpoint, events, idle: null }
      lease.onMessage((method, params) => {
        if (method === 'Runtime.bindingCalled' && params?.name === SEND_BINDING) {
          push(events.blocked, { kind: 'form', method: 'POST', url: String(params.payload ?? '').slice(0, 500), reason: SEND_OFF_REASON })
          return
        }
        if (method !== 'Page.javascriptDialogOpening') return
        push(events.dialogs, { type: String(params?.type ?? 'alert'), message: String(params?.message ?? '').slice(0, 300) })
        void lease.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => {})
      })
      await lease.send('Page.enable')
      if (!input.allowSend) {
        await lease.send('Runtime.enable')
        await lease.send('Runtime.addBinding', { name: SEND_BINDING })
        await lease.send('Page.addScriptToEvaluateOnNewDocument', { source: SEND_GUARD_SCRIPT(SEND_BINDING) })
      }
      await lease.send('Emulation.setDeviceMetricsOverride', { width: input.width, height, deviceScaleFactor: 1, mobile, screenWidth: input.width, screenHeight: height })
      await lease.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 }).catch(() => {})
      const agent = userAgentFor(input.breakpoint)
      if (agent) await lease.send('Emulation.setUserAgentOverride', { userAgent: agent })
      return step(async (open) => {
        let failure = ''
        await Promise.race([
          open.contents.loadURL(input.url).catch((error: Error) => { failure = error.message }),
          sleep(LOAD_TIMEOUT_MS).then(() => { failure = failure || 'the page did not finish loading within 30 seconds' }),
        ])
        return failure && !/ERR_ABORTED/.test(failure) ? `Loading reported: ${failure}` : undefined
      })
    },

    snapshot: () => step(async () => undefined),

    click: (ref) => step(async (open) => {
      const target = await evaluate<{ x: number; y: number; covered: string | null; disabled: boolean; visible: boolean; error?: string }>(open, TARGET_SCRIPT, ref)
      if (target.error) throw new Error(`There is no element ${ref} on the page now. Take a new snapshot; the page may have changed.`)
      await mouseClick(open, target.x, target.y)
      const notes = [target.disabled ? `${ref} is disabled.` : '', target.covered ? `${ref} was covered by ${target.covered}, so the click landed on that.` : '']
      return notes.filter(Boolean).join(' ') || undefined
    }),

    type: (ref, text, options) => step(async (open) => {
      const focus = await evaluate<{ focused: boolean; editable: boolean; error?: string }>(open, FOCUS_SCRIPT, ref, options.clear)
      if (focus.error) throw new Error(`There is no element ${ref} on the page now. Take a new snapshot; the page may have changed.`)
      if (!focus.editable) throw new Error(`${ref} is not a text field.`)
      await open.lease.send('Input.insertText', { text })
      if (options.enter) await key(open, 'Enter')
      return focus.focused ? undefined : `${ref} could not be focused; the text may not have arrived.`
    }),

    select: (ref, value) => step(async (open) => {
      const result = await evaluate<{ chosen?: string; notSelect?: boolean; error?: string; options?: string[] }>(open, SELECT_SCRIPT, ref, value)
      if (result.error === 'missing') throw new Error(`There is no element ${ref} on the page now. Take a new snapshot.`)
      if (result.error === 'no-option') throw new Error(`${ref} has no option "${value}". Its options are: ${(result.options ?? []).join(', ')}.`)
      if (result.notSelect) {
        // A checkbox, radio button or custom control: choose it by clicking, as a person would.
        const target = await evaluate<{ x: number; y: number; error?: string }>(open, TARGET_SCRIPT, ref)
        if (target.error) throw new Error(`There is no element ${ref} on the page now.`)
        await mouseClick(open, target.x, target.y)
        return `${ref} is not a list, so it was clicked.`
      }
      return `Chose "${result.chosen}".`
    }),

    press: (name) => step(async (open) => { await key(open, name) }),

    async scroll(to) {
      const result = await step(async (open) => {
        const done = await evaluate<{ missing?: boolean }>(open, SCROLL_SCRIPT, to)
        if (done?.missing) throw new Error(`There is no element ${to} on the page now. Run the check or take a snapshot again; the page may have changed.`)
      })
      // Measured after the page settled, as in the screenshot, so it can box the finding.
      if (typeof to === 'string' && /^e\d+$/.test(to)) {
        const box = await evaluate<{ x: number; y: number; width: number; height: number } | null>(requireOpen(), BOX_SCRIPT, to)
        if (box) result.note = [result.note, `${to} is at x ${box.x}, y ${box.y}, ${box.width}×${box.height} in this view; use that as the live box of a finding's evidence.`].filter(Boolean).join(' ')
      }
      return result
    },

    back: () => step(async (open) => {
      if (!open.contents.navigationHistory.canGoBack()) return 'There is no earlier page in this browser.'
      open.contents.navigationHistory.goBack()
    }),

    allEvents: () => {
      const open = requireOpen()
      return eventsSince(open.events, { console: 0, requests: 0, blocked: 0, dialogs: 0, popups: 0, downloads: 0 })
    },

    async links(): Promise<LinkResult[]> {
      const open = requireOpen()
      const found = await evaluate<Array<{ href: string; resolved: string; text: string }>>(open, LINKS_SCRIPT)
      const unique = new Map<string, LinkResult>()
      for (const link of found) {
        const url = link.resolved || link.href
        const known = unique.get(url)
        if (known) { known.count++; continue }
        // "#" and "javascript:" are placeholders whatever the browser resolves them to.
        const raw = linkCheckPlan(link.href)
        const plan = raw === 'placeholder' || !/^https?:/i.test(link.resolved) ? raw : linkCheckPlan(link.resolved)
        unique.set(url, { url, text: link.text, plan, count: 1 })
      }
      const ses = browserSession()
      const queue = [...unique.values()].filter((link) => link.plan === 'check').slice(0, LINK_LIMIT)
      const check = async (link: LinkResult) => {
        try {
          let response = await ses.fetch(link.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) })
          if ([403, 405, 501].includes(response.status)) {
            response = await ses.fetch(link.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) })
            void response.body?.cancel().catch(() => {})
          }
          link.status = response.status
          if (response.url && response.url !== link.url) link.finalUrl = response.url
        } catch (error: any) {
          link.error = error?.name === 'TimeoutError' ? 'no answer within 10 seconds' : String(error?.message || 'could not be reached').slice(0, 120)
        }
      }
      for (let i = 0; i < queue.length; i += LINK_CONCURRENCY) await Promise.all(queue.slice(i, i + LINK_CONCURRENCY).map(check))
      return [...unique.values()]
    },

    async audit(): Promise<PageAudit> {
      return evaluate<PageAudit>(requireOpen(), AUDIT_SCRIPT)
    },

    read: (script, ...args) => evaluate(requireOpen(), script, ...args),

    async request(input): Promise<HttpResult> {
      const open = requireOpen()
      const url = new URL(input.url, open.contents.getURL()).toString()
      const verdict = checkApiRequest({ method: input.method, url, site: open.site, allowSend: open.allowSend })
      if (!verdict.allowed) throw new Error(`That request is not allowed: ${verdict.reason}`)
      const started = Date.now()
      const response = await browserSession().fetch(url, {
        method: input.method.toUpperCase(), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: input.headers, ...(input.body !== undefined && !['GET', 'HEAD'].includes(input.method.toUpperCase()) ? { body: input.body } : {}),
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => { if (/^(content-type|content-length|location|cache-control|allow|x-[a-z-]+|link|set-cookie|www-authenticate)$/i.test(name)) headers[name] = name.toLowerCase() === 'set-cookie' ? '(set)' : value.slice(0, 300) })
      return { status: response.status, statusText: response.statusText, headers, body: buffer.subarray(0, MAX_BODY_BYTES).toString('utf8'), truncated: buffer.length > MAX_BODY_BYTES, ms: Date.now() - started }
    },

    close,
  }
}
