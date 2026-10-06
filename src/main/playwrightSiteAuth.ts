import { session, type WebContents } from 'electron'
import type { Browser, BrowserContext, BrowserContextOptions, Response } from 'playwright'
import { rememberedSiteCredentials, requestSiteAuthentication } from './httpAuth'

/** Use the engine's challenge handling; never inject an Authorization header into page requests. */
export async function openAuthenticatedComparison(browser: Browser, url: string, options: BrowserContextOptions, requester: WebContents, initialize?: (context: BrowserContext) => Promise<void>) {
  let origin = new URL(url).origin
  let login = rememberedSiteCredentials(session.defaultSession, url)
  const abort = new AbortController()
  const cancel = () => abort.abort()
  browser.once('disconnected', cancel)
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (abort.signal.aborted) throw new Error('Comparison was cancelled.')
      const context = await browser.newContext({ ...options, ...(login ? { httpCredentials: { ...login, origin } } : {}) })
      try {
        await initialize?.(context)
        const page = await context.newPage()
        let challenge: Response | null = null
        page.on('response', response => {
          if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() && response.status() === 401) challenge = response
        })
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(error => {
          if (challenge) return challenge
          throw error
        })
        if (response?.status() !== 401 || !response.headers()['www-authenticate']) return { context, page, response }
        const header = response.headers()['www-authenticate']
        origin = new URL(response.url()).origin
        await context.close()
        if (attempt === 3) throw new Error('The server did not accept your credentials. Check the username and password, then capture again.')
        const value = await requestSiteAuthentication(session.defaultSession, {
          origin, realm: /realm="([^"]*)"/i.exec(header)?.[1] ?? '', scheme: header.split(/\s/)[0].toLowerCase(), isProxy: false, retry: !!login,
        }, requester, abort.signal)
        if (!value || abort.signal.aborted) throw new Error('Site sign-in was cancelled. Capture again when you are ready to sign in.')
        login = value
      } catch (error) { await context.close().catch(() => {}); throw error }
    }
    throw new Error('Unable to sign in to the site.')
  } finally { browser.removeListener('disconnected', cancel) }
}
