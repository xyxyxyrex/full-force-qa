import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

let code: string
beforeAll(async () => {
  const source = readFileSync('supabase/functions/parity-account-v2/index.ts', 'utf8').replace(/import \{ createClient \} from [^\n]+/, 'const createClient = () => mockAdmin')
  code = (await transform(source, { loader: 'ts', format: 'cjs' })).code
})
function endpoint({ verified = true, valid = true }: { verified?: boolean; valid?: boolean } = {}) {
  let handler!: (request: Request) => Promise<Response>
  const row = { owner_key: 'parity:owner-a', auth_user_id: 'auth-a', display_name: 'A', email: 'a@example.test' }
  const lookup = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn(async () => ({ data: row })) }
  const mockAdmin = {
    auth: { getUser: vi.fn(async () => ({ data: { user: valid ? { id: 'auth-a', email: 'a@example.test', email_confirmed_at: verified ? '2026-09-21' : null } : null }, error: valid ? null : Error('expired') })) },
    from: vi.fn(() => lookup), rpc: vi.fn(async (name: string) => ({ data: name === 'initialize_parity_account' ? row : 'saved' })),
  }
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { me: { id: '7' } } })))
  runInNewContext(code, { mockAdmin, fetch, Response, TextEncoder, AbortSignal, Deno: { env: { get: () => 'configured' }, serve: (fn: typeof handler) => { handler = fn } } })
  const call = (body: object) => handler(new Request('https://local.test', { method: 'POST', headers: { authorization: 'Bearer verified-token' }, body: JSON.stringify(body) }))
  return { call, mockAdmin, lookup, fetch }
}
describe('versioned account endpoint isolation', () => {
  it.each([{ valid: false }, { verified: false }])('rejects expired or unverified identities before looking up ownership (%j)', async options => {
    const { call, mockAdmin } = endpoint(options)
    expect((await call({ action: 'status' })).status).toBe(401)
    expect(mockAdmin.from).not.toHaveBeenCalled()
  })
  it('resolves ownership from the verified Supabase user, ignoring caller-supplied owners', async () => {
    const { call, mockAdmin, lookup } = endpoint()
    expect((await call({ action: 'save_state', ownerKey: 'monday:victim', authUserId: 'victim', data: { folders: [] } })).status).toBe(200)
    expect(lookup.eq).toHaveBeenCalledWith('auth_user_id', 'auth-a')
    expect(mockAdmin.rpc).toHaveBeenCalledWith('merge_parity_user_state', { p_owner_key: 'parity:owner-a', p_patch: { folders: [] } })
  })
  it('requires fresh Monday proof for restoration and ignores an asserted Monday ID', async () => {
    const { call, mockAdmin, fetch } = endpoint()
    expect((await call({ action: 'initialize', mode: 'monday', mondayUserId: '7' })).status).toBe(400)
    expect(mockAdmin.rpc).not.toHaveBeenCalled()
    expect((await call({ action: 'initialize', mode: 'monday', mondayToken: 'fresh-token', mondayUserId: 'victim' })).status).toBe(200)
    expect(fetch).toHaveBeenCalledWith('https://api.monday.com/v2', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'fresh-token' }) }))
    expect(mockAdmin.rpc).toHaveBeenCalledWith('initialize_parity_account', expect.objectContaining({ p_auth_user_id: 'auth-a', p_monday_id: '7' }))
  })
  it('creates independent accounts without calling Monday', async () => {
    const { call, mockAdmin, fetch } = endpoint()
    expect((await call({ action: 'initialize', mode: 'new' })).status).toBe(200)
    expect(fetch).not.toHaveBeenCalled()
    expect(mockAdmin.rpc).toHaveBeenCalledWith('initialize_parity_account', expect.objectContaining({ p_monday_id: null }))
  })
})
