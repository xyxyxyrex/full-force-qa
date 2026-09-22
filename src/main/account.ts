import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { createServer, type Server } from 'http'
import { join } from 'path'
import type { AccountStatus, ParityAccountUser } from '../shared/types'
import { setProjectOwner } from './store'

declare const __PARITY_SUPABASE_URL__: string
declare const __PARITY_SUPABASE_KEY__: string
let client: SupabaseClient | undefined
let user: ParityAccountUser | undefined
let authId: string | undefined
let epoch = 0
let restoring: Promise<void> | undefined
let cancelGoogleLogin: ((reason: Error) => void) | undefined
const oauthStorage = new Map<string, string>()
const GOOGLE_OAUTH_PORT = 51848
export const GOOGLE_OAUTH_REDIRECT_URL = `http://127.0.0.1:${GOOGLE_OAUTH_PORT}/account/oauth/callback`
const sessionPath = () => join(app.getPath('userData'), 'parity-auth.bin')
const config = () => ({ url: process.env.VITE_SUPABASE_URL || __PARITY_SUPABASE_URL__, key: process.env.VITE_SUPABASE_ANON_KEY || __PARITY_SUPABASE_KEY__ })
function authClient() {
  if (!client) {
    const { url, key } = config()
    if (!url || !key) {
      const missing = [!url && 'VITE_SUPABASE_URL', !key && 'VITE_SUPABASE_ANON_KEY'].filter(Boolean).join(' and ')
      throw new Error(`Parity account service is not configured. Set ${missing} in the project .env, then fully restart the development app. Packaged apps must be rebuilt with these values.`)
    }
    client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storage: {
          getItem: key => oauthStorage.get(key) ?? null,
          setItem: (key, value) => { oauthStorage.set(key, value) },
          removeItem: key => { oauthStorage.delete(key) },
        },
      },
    })
  }
  return client
}
function publish() {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('account:changed')
}
async function persist() {
  const context = accountContext()
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure account storage is unavailable on this device.')
  const { data } = await authClient().auth.getSession()
  context.assert()
  if (data.session) writeFileSync(sessionPath(), safeStorage.encryptString(JSON.stringify({ session: data.session, user })))
}
export function accountOwner(): string | null { return user?.ownerKey || null }
export function accountAuthId(): string | undefined { return authId }
export function accountContext() {
  const generation = epoch; const ownerKey = accountOwner()
  return { ownerKey, assert: () => { if (epoch !== generation || accountOwner() !== ownerKey) throw new Error('The active account changed. Try again.'); } }
}
export async function restoreAccount(): Promise<void> {
  if (!restoring) restoring = (async () => {
    if (!existsSync(sessionPath()) || !safeStorage.isEncryptionAvailable()) return
    const generation = epoch
    try {
      const saved = JSON.parse(safeStorage.decryptString(readFileSync(sessionPath())))
      // Encrypted, previously verified identity allows local-only work while offline.
      if (saved.user?.authUserId && saved.user.authUserId === saved.session?.user?.id) {
        authId = saved.user.authUserId; user = saved.user; setProjectOwner(user!.ownerKey)
      }
      const { data, error } = await authClient().auth.setSession(saved.session)
      if (generation !== epoch) return
      if (error || !data.session) return
      authId = data.session.user.id
      if (saved.user?.authUserId === authId) { user = saved.user; setProjectOwner(user!.ownerKey) }
    } catch { /* Keep encrypted session for a future network retry. */ }
  })()
  await restoring
}
export async function accountRequest(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  const generation = epoch
  await restoreAccount()
  if (generation !== epoch) throw new Error('The active account changed.')
  const { data, error } = await authClient().auth.getSession()
  if (error || !data.session) throw new Error('Sign in to your Parity account.')
  let session = data.session
  if ((session.expires_at || 0) * 1000 < Date.now() + 60_000) {
    const refreshed = await authClient().auth.refreshSession()
    if (generation !== epoch) throw new Error('The active account changed.')
    if (refreshed.error || !refreshed.data.session) throw new Error('Your Parity session expired. Sign in again.')
    session = refreshed.data.session
    await persist()
  }
  if (generation !== epoch) throw new Error('The active account changed.')
  const { url, key } = config()
  const response = await fetch(`${url.replace(/\/$/, '')}/functions/v1/parity-account-v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ ...payload, action }), signal: AbortSignal.timeout(30000),
  })
  const result = await response.json() as any
  if (generation !== epoch) throw new Error('The active account changed.')
  if (!response.ok) throw new Error(result.error || `Account service returned ${response.status}.`)
  if (result.needsSetup && !['status', 'initialize'].includes(action)) throw new Error('Finish setting up your Parity workspace in Settings → Account.')
  return result
}
export async function getAccountStatus(): Promise<AccountStatus> {
  const context = accountContext()
  try {
    await restoreAccount()
    const { data } = await authClient().auth.getSession()
    context.assert()
    if (!data.session) return { signedIn: !!authId, needsSetup: !!authId && !user, user, error: authId ? 'Offline or expired session. Local changes are retained; reconnect or sign in again to sync.' : undefined }
    authId = data.session.user.id
    const generation = epoch
    const result = await accountRequest('status')
    if (generation !== epoch) throw new Error('The active account changed.')
    if (result.user) { user = result.user; setProjectOwner(user!.ownerKey); await persist() }
    return { signedIn: true, needsSetup: !!result.needsSetup, email: data.session.user.email, user }
  } catch (error) { return { signedIn: !!authId, needsSetup: !!authId && !user, user, error: error instanceof Error ? error.message : 'Account unavailable.' } }
}
async function acceptAccountSession(session: { user: { id: string } }): Promise<AccountStatus> {
  if (authId) throw new Error('Sign out before switching accounts.')
  const generation = ++epoch
  authId = session.user.id; user = undefined; setProjectOwner(null)
  restoring = Promise.resolve()
  await persist()
  if (generation !== epoch) throw new Error('Sign-in was cancelled.')
  const status = await getAccountStatus()
  publish()
  return status
}

function closeServer(server: Server): void {
  if (server.listening) server.close()
}

export async function loginWithGoogle(): Promise<AccountStatus> {
  if (authId) throw new Error('Sign out before switching accounts.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure account storage is unavailable.')
  if (cancelGoogleLogin) throw new Error('A Google sign-in is already in progress.')

  const { url, key } = config()
  const settingsResponse = await fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, {
    headers: { apikey: key },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!settingsResponse?.ok) throw new Error('Unable to reach the Parity account service. Check your connection and try again.')
  const settings = await settingsResponse.json() as { external?: { google?: boolean } }
  if (!settings.external?.google) throw new Error('Google sign-in is not enabled for this Parity environment. Enable the Google provider in Supabase Auth.')

  const startedAtEpoch = epoch
  let resolveCallback!: (code: string) => void
  let rejectCallback!: (reason: Error) => void
  const callback = new Promise<string>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
  let settled = false
  const settleError = (reason: Error) => {
    if (settled) return
    settled = true
    rejectCallback(reason)
  }
  cancelGoogleLogin = settleError
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', GOOGLE_OAUTH_REDIRECT_URL)
    if (request.method !== 'GET' || requestUrl.pathname !== '/account/oauth/callback') {
      response.writeHead(404).end()
      return
    }
    const oauthError = requestUrl.searchParams.get('error_description') || requestUrl.searchParams.get('error')
    const code = requestUrl.searchParams.get('code')
    response.writeHead(oauthError || !code ? 400 : 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    response.end(`<main style="font:16px system-ui;padding:40px;max-width:560px"><h1>${oauthError || !code ? 'Google sign-in failed' : 'Return to Parity'}</h1><p>${oauthError ? 'Return to Parity and try again.' : 'Parity is finishing your sign-in. You can close this window.'}</p></main>`)
    if (oauthError || !code) settleError(new Error(oauthError || 'Google did not return an authorization code.'))
    else if (!settled) { settled = true; resolveCallback(code) }
  })
  const timeout = setTimeout(() => settleError(new Error('Google sign-in timed out. Try again.')), 180_000)

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(GOOGLE_OAUTH_PORT, '127.0.0.1', () => resolve())
    })
    const { data, error } = await authClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: GOOGLE_OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error || !data.url) throw error || new Error('Supabase did not create a Google sign-in URL.')
    const authorizationUrl = new URL(data.url)
    const expectedOrigin = new URL(url).origin
    if (authorizationUrl.origin !== expectedOrigin || !authorizationUrl.pathname.endsWith('/auth/v1/authorize')) throw new Error('Supabase returned an invalid Google sign-in URL.')
    await shell.openExternal(data.url)
    const code = await callback
    if (epoch !== startedAtEpoch || authId) throw new Error('Sign-in was cancelled.')
    const { data: exchanged, error: exchangeError } = await authClient().auth.exchangeCodeForSession(code)
    if (exchangeError || !exchanged.session) throw exchangeError || new Error('Google sign-in could not be completed.')
    if (epoch !== startedAtEpoch || authId) throw new Error('Sign-in was cancelled.')
    return await acceptAccountSession(exchanged.session)
  } finally {
    clearTimeout(timeout)
    cancelGoogleLogin = undefined
    closeServer(server)
  }
}
export async function initializeAccount(mode: 'new' | 'monday', mondayToken?: string): Promise<AccountStatus> {
  const result = await accountRequest('initialize', { mode, mondayToken })
  user = result.user; setProjectOwner(user!.ownerKey)
  await persist(); publish()
  return { signedIn: true, needsSetup: false, user, email: user?.email }
}
export async function signOutAccount(): Promise<void> {
  cancelGoogleLogin?.(new Error('Sign-in was cancelled.'))
  ++epoch; user = undefined; authId = undefined; setProjectOwner(null)
  if (existsSync(sessionPath())) unlinkSync(sessionPath())
  const previous = client; client = undefined; restoring = Promise.resolve(); oauthStorage.clear()
  publish()
  if (previous) await previous.auth.signOut({ scope: 'local' }).catch(() => {})
}
export function assertAccountOwner(expected: string | null | undefined) {
  if (expected !== accountOwner()) throw new Error('The active account changed. Reopen this view.')
}
