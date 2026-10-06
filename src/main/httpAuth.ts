import { app, ipcMain, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { SiteAuthRequest, SiteCredentials } from '../shared/httpAuth'

type Challenge = Omit<SiteAuthRequest, 'id'>
type Pending = { request: SiteAuthRequest; session: Session; contents?: WebContents; resolve: (value: SiteCredentials | null) => void }
let getWindow: (() => BrowserWindow | null) | undefined
let openPrompt: ((contents?: WebContents) => BrowserWindow) | undefined
let promptWindow: BrowserWindow | null = null
let closingPrompt = false
const queue: Pending[] = []
let credentials = new WeakMap<Session, Map<string, SiteCredentials>>()
const waiting = new Map<number, number>()
const waited = new Map<number, number>()
const attempts = new Map<number, Set<string>>()
const trackedContents = new WeakSet<WebContents>()
const authenticatedSessions = new Set<Session>()
const cancellations = new EventEmitter()

const key = (value: Challenge) => `${value.isProxy ? 'proxy' : 'site'}:${value.origin}:${value.scheme}:${value.realm}`
const publish = () => {
  if (closingPrompt) return
  if (openPrompt && queue.length && !promptWindow) {
    promptWindow = openPrompt(queue[0].contents)
    const current = promptWindow
    current.on('closed', () => {
      if (promptWindow !== current) return
      promptWindow = null; closingPrompt = true
      for (const item of [...queue]) finish(item.request.id, null)
      closingPrompt = false
    })
  }
  if (!queue.length && promptWindow && !promptWindow.isDestroyed()) {
    const previous = promptWindow; promptWindow = null
    previous.webContents.send('site-auth:request', null)
    // Let the credential IPC reply reach its renderer before disposing that renderer.
    setTimeout(() => { if (!previous.isDestroyed()) previous.close() }, 50)
    return
  }
  const window = promptWindow ?? getWindow?.()
  if (window && !window.isDestroyed()) window.webContents.send('site-auth:request', queue[0]?.request ?? null)
}

export function rememberedSiteCredentials(session: Session, url: string): SiteCredentials | undefined {
  const origin = new URL(url).origin
  // Never reuse credentials for another port, protocol, origin, or a proxy.
  const entries = credentials.get(session)
  if (!entries) return
  for (const [scope, value] of entries) if (scope.startsWith(`site:${origin}:`)) return { ...value }
}

export function requestSiteAuthentication(session: Session, challenge: Challenge, contents?: WebContents, signal?: AbortSignal): Promise<SiteCredentials | null> {
  const window = getWindow?.()
  if (!window || window.isDestroyed() || contents?.isDestroyed() || signal?.aborted) return Promise.resolve(null)
  if (challenge.retry) {
    credentials.get(session)?.delete(key(challenge))
  }
  authenticatedSessions.add(session)
  const started = Date.now()
  if (contents) waiting.set(contents.id, (waiting.get(contents.id) ?? 0) + 1)
  return new Promise(resolve => {
    const pending: Pending = { request: { ...challenge, id: randomUUID() }, session, contents, resolve: value => {
      contents?.removeListener('destroyed', cancel)
      signal?.removeEventListener('abort', cancel)
      if (contents) {
        const count = (waiting.get(contents.id) ?? 1) - 1
        if (count) waiting.set(contents.id, count); else waiting.delete(contents.id)
        if (!contents.isDestroyed()) waited.set(contents.id, (waited.get(contents.id) ?? 0) + Date.now() - started)
      }
      resolve(value)
    } }
    const cancel = () => finish(pending.request.id, null)
    contents?.once('destroyed', cancel)
    signal?.addEventListener('abort', cancel, { once: true })
    queue.push(pending)
    publish()
  })
}

function finish(id: string, value: SiteCredentials | null): boolean {
  const index = queue.findIndex(item => item.request.id === id)
  if (index < 0) return false
  const [pending] = queue.splice(index, 1)
  if (value) {
    let entries = credentials.get(pending.session)
    if (!entries) { entries = new Map(); credentials.set(pending.session, entries) }
    entries.set(key(pending.request), { ...value })
    if (!pending.request.isProxy && pending.session !== session.defaultSession) {
      let shared = credentials.get(session.defaultSession)
      if (!shared) { shared = new Map(); credentials.set(session.defaultSession, shared) }
      shared.set(key(pending.request), { ...value })
    }
  }
  pending.resolve(value)
  if (!value && pending.contents && !pending.contents.isDestroyed()) cancellations.emit(String(pending.contents.id))
  // Parallel viewports for the same protection space share one user response.
  for (const peer of [...queue]) {
    if (peer.session === pending.session && key(peer.request) === key(pending.request) && peer.request.retry === pending.request.retry) finish(peer.request.id, value)
  }
  publish()
  return true
}

export function clearSiteAuthentication(): void {
  credentials = new WeakMap()
  for (const pending of [...queue]) finish(pending.request.id, null)
  attempts.clear()
  for (const ses of authenticatedSessions) void ses.clearAuthCache().catch(() => {})
  authenticatedSessions.clear()
}

export const siteAuthenticationWait = (contents: WebContents): number => waited.get(contents.id) ?? 0

export class SiteAuthenticationCancelledError extends Error {
  constructor() { super('Sign-in was cancelled. Capture again when you are ready to sign in.'); this.name = 'SiteAuthenticationCancelledError' }
}

/** User input is not network time. Keep the load deadline paused during authentication. */
export function withSiteAuthenticationTimeout<T>(task: Promise<T>, contents: WebContents, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let remaining = ms, last = Date.now()
    const cleanup = () => { clearInterval(timer); cancellations.removeListener(String(contents.id), cancel) }
    const cancel = () => { cleanup(); reject(new SiteAuthenticationCancelledError()) }
    const timer = setInterval(() => {
      const now = Date.now()
      if (!waiting.has(contents.id)) remaining -= now - last
      last = now
      if (remaining <= 0 || contents.isDestroyed()) { cleanup(); reject(new Error(message)) }
    }, 100)
    cancellations.once(String(contents.id), cancel)
    task.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export function registerSiteAuthentication(window: () => BrowserWindow | null, prompt?: (contents?: WebContents) => BrowserWindow): void {
  getWindow = window
  openPrompt = prompt
  const trusted = (sender: WebContents) => sender === (promptWindow ?? getWindow?.())?.webContents
  ipcMain.handle('site-auth:pending', event => trusted(event.sender) ? queue[0]?.request ?? null : null)
  ipcMain.handle('site-auth:respond', (event, id: string, value: SiteCredentials | null) => {
    if (!trusted(event.sender) || id !== queue[0]?.request.id) return false
    if (value !== null && (typeof value?.username !== 'string' || typeof value?.password !== 'string' || !value.username.trim() || value.username.length > 1024 || value.password.length > 4096)) return false
    return finish(id, value === null ? null : { username: value.username.trim(), password: value.password })
  })
  app.on('login', (event, contents, details, info, callback) => {
    event.preventDefault()
    let origin: string
    try { origin = info.isProxy ? `http://${info.host}:${info.port}` : new URL(details.url).origin } catch { callback(); return }
    if (!contents || contents.isDestroyed()) { callback(); return }
    const challenge: Challenge = { origin, realm: info.realm, scheme: info.scheme, isProxy: info.isProxy, retry: false }
    let seen = attempts.get(contents.id)
    if (!seen) { seen = new Set(); attempts.set(contents.id, seen) }
    if (!trackedContents.has(contents)) {
      trackedContents.add(contents)
      contents.once('destroyed', () => { attempts.delete(contents.id); waiting.delete(contents.id); waited.delete(contents.id) })
      contents.on('did-finish-load', () => attempts.delete(contents.id))
    }
    challenge.retry = seen.has(key(challenge))
    seen.add(key(challenge))
    if (challenge.retry && !info.isProxy) credentials.get(session.defaultSession)?.delete(key(challenge))
    authenticatedSessions.add(contents.session)
    const cached = !challenge.retry && !info.isProxy ? (credentials.get(contents.session)?.get(key(challenge)) ?? credentials.get(session.defaultSession)?.get(key(challenge))) : undefined
    if (cached) { callback(cached.username, cached.password); return }
    void requestSiteAuthentication(contents.session, challenge, contents).then(value => {
      if (value && !contents.isDestroyed()) callback(value.username, value.password); else callback()
    })
  })
  app.on('before-quit', clearSiteAuthentication)
}
