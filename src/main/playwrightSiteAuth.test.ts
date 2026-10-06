import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
const mocks = vi.hoisted(() => ({ request: vi.fn(), remembered: vi.fn(), session: {} }))
vi.mock('electron', () => ({ session: { defaultSession: mocks.session } }))
vi.mock('./httpAuth', () => ({ requestSiteAuthentication: mocks.request, rememberedSiteCredentials: mocks.remembered }))
import { openAuthenticatedComparison } from './playwrightSiteAuth'

const requester = {} as Electron.WebContents
function fixture(statuses: number[], url = 'https://stage.test/') {
  const contexts: any[] = []
  const browser = Object.assign(new EventEmitter(), { newContext: vi.fn(async (options: unknown) => {
    const status = statuses.shift() ?? 200
    const response = { status: () => status, url: () => url, headers: () => status === 401 ? { 'www-authenticate': 'Basic realm="Staging"' } : {} }
    const page = { on: vi.fn(), goto: vi.fn(async () => response) }
    const context = { options, page, close: vi.fn(async () => {}), newPage: vi.fn(async () => page) }
    contexts.push(context)
    return context
  }) })
  return { browser: browser as any, contexts }
}

beforeEach(() => { vi.resetAllMocks() })
describe('authenticated engine navigation', () => {
  it('leaves public pages unchanged', async () => {
    const { browser, contexts } = fixture([200])
    await openAuthenticatedComparison(browser, 'https://stage.test/', { viewport: { width: 430, height: 932 } }, requester)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(contexts[0].options.httpCredentials).toBeUndefined()
  })
  it('prompts after a challenge and recreates the context with exact-origin credentials and saved cookies', async () => {
    const { browser, contexts } = fixture([401, 200])
    mocks.request.mockResolvedValue({ username: 'reviewer', password: 'secret' })
    const initialize = vi.fn(async () => {})
    const result = await openAuthenticatedComparison(browser, 'https://stage.test/', { storageState: { cookies: [], origins: [] } }, requester, initialize)
    expect(mocks.request.mock.calls[0][1]).toMatchObject({ origin: 'https://stage.test', realm: 'Staging', retry: false })
    expect(contexts[0].close).toHaveBeenCalled()
    expect(contexts[1].options.httpCredentials).toEqual({ origin: 'https://stage.test', username: 'reviewer', password: 'secret' })
    expect(contexts[1].options.storageState).toEqual({ cookies: [], origins: [] })
    expect(contexts[1].options.extraHTTPHeaders).toBeUndefined()
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(result.response!.status()).toBe(200)
  })
  it('reuses credentials only with an explicit origin restriction', async () => {
    mocks.remembered.mockReturnValue({ username: 'r', password: 'p' })
    const { browser, contexts } = fixture([200])
    await openAuthenticatedComparison(browser, 'https://stage.test:8443/', {}, requester)
    expect(contexts[0].options.httpCredentials.origin).toBe('https://stage.test:8443')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('shows retry feedback when remembered credentials are rejected', async () => {
    mocks.remembered.mockReturnValue({ username: 'r', password: 'old' })
    mocks.request.mockResolvedValue({ username: 'r', password: 'new' })
    const { browser } = fixture([401, 200])
    await openAuthenticatedComparison(browser, 'https://stage.test/', {}, requester)
    expect(mocks.request.mock.calls[0][1].retry).toBe(true)
  })
  it('stops on cancellation without capturing the sign-in page', async () => {
    mocks.request.mockResolvedValue(null)
    const { browser, contexts } = fixture([401])
    await expect(openAuthenticatedComparison(browser, 'https://stage.test/', {}, requester)).rejects.toThrow('cancelled')
    expect(contexts).toHaveLength(1)
    expect(contexts[0].close).toHaveBeenCalled()
  })
  it('bounds rejected credential retries', async () => {
    mocks.request.mockResolvedValue({ username: 'r', password: 'wrong' })
    const { browser, contexts } = fixture([401, 401, 401, 401])
    await expect(openAuthenticatedComparison(browser, 'https://stage.test/', {}, requester)).rejects.toThrow('did not accept')
    expect(mocks.request).toHaveBeenCalledTimes(3)
    expect(contexts).toHaveLength(4)
  })
  it('aborts the authentication prompt if the browser is closed', async () => {
    const { browser } = fixture([401])
    mocks.request.mockImplementation((_session, _challenge, _requester, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(null))
      browser.emit('disconnected')
    }))
    await expect(openAuthenticatedComparison(browser, 'https://stage.test/', {}, requester)).rejects.toThrow('cancelled')
    expect(browser.listenerCount('disconnected')).toBe(0)
  })
})
