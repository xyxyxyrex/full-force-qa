import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

let code: string
beforeAll(async () => {
  const source = readFileSync('supabase/functions/qa-evidence/index.ts', 'utf8').replace(/import \{ createClient \} from [^\n]+/, 'const createClient = () => mockAdmin')
  code = (await transform(source, { loader: 'ts', format: 'cjs' })).code
})

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9, 9, 9])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const VALID_ID = 'AbCdEfGhIjKlMnOpQrStUv'

interface Options { user?: { id: string; email_confirmed_at: string | null } | null; recentUploads?: number; uploadError?: boolean; insertError?: boolean; rows?: Array<Record<string, any>>; objects?: Record<string, Uint8Array> }

function endpoint(options: Options = {}) {
  const rows = new Map<string, Record<string, any>>((options.rows || []).map((row) => [row.id, row]))
  const objects = new Map<string, Uint8Array>(Object.entries(options.objects || {}))
  const log = { getUser: 0, uploads: [] as Array<{ path: string; contentType: string; size: number }>, removed: [] as string[], deleted: [] as string[], inserted: [] as Array<Record<string, any>> }
  const user = options.user === undefined ? { id: 'user-1', email_confirmed_at: '2026-01-01' } : options.user

  const builder = () => {
    const state = { op: 'select', filters: [] as Array<[string, string, any]>, head: false, count: false, limit: 0, insert: null as any, ids: null as any }
    const api: any = {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => { state.op = 'select'; state.count = opts?.count === 'exact'; state.head = !!opts?.head; return api },
      insert: (row: any) => { state.op = 'insert'; state.insert = row; return api },
      delete: () => { state.op = 'delete'; return api },
      eq: (c: string, v: any) => { state.filters.push(['eq', c, v]); return api },
      gte: (c: string, v: any) => { state.filters.push(['gte', c, v]); return api },
      lt: (c: string, v: any) => { state.filters.push(['lt', c, v]); return api },
      in: (_c: string, ids: string[]) => { state.ids = ids; return api },
      limit: (n: number) => { state.limit = n; return api },
      maybeSingle: async () => ({ data: [...rows.values()].find((row) => state.filters.every(([op, c, v]) => op !== 'eq' || row[c] === v)) ?? null }),
      then: (resolve: (value: unknown) => void) => {
        if (state.op === 'insert') {
          if (options.insertError) return resolve({ error: { message: 'insert failed' } })
          log.inserted.push(state.insert); rows.set(state.insert.id, state.insert); return resolve({ error: null })
        }
        if (state.op === 'delete') { for (const id of state.ids || []) { rows.delete(id); log.deleted.push(id) } return resolve({ error: null }) }
        if (state.count) return resolve({ count: options.recentUploads ?? 0, error: null })
        const expiredOnly = state.filters.find(([op, c]) => op === 'lt' && c === 'expires_at')
        const data = [...rows.values()].filter((row) => !expiredOnly || new Date(row.expires_at) < new Date(expiredOnly[2]))
        resolve({ data: state.limit ? data.slice(0, state.limit) : data, error: null })
      },
    }
    return api
  }
  const mockAdmin = {
    auth: { getUser: async () => { log.getUser++; return { data: { user }, error: user ? null : Error('expired') } } },
    from: () => builder(),
    storage: { from: () => ({
      upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => { if (options.uploadError) return { error: { message: 'boom' } }; objects.set(path, bytes); log.uploads.push({ path, contentType: opts.contentType, size: bytes.length }); return { error: null } },
      download: async (path: string) => (objects.has(path) ? { data: new Blob([objects.get(path)! as BlobPart]), error: null } : { data: null, error: { message: 'missing' } }),
      remove: async (paths: string[]) => { for (const path of paths) { objects.delete(path); log.removed.push(path) } return { error: null } },
    }) },
  }
  let handler!: (request: Request) => Promise<Response>
  runInNewContext(code, { mockAdmin, Response, Request, URL, URLSearchParams, Blob, TextEncoder, Uint8Array, Date, Math, Number, String, btoa, crypto, JSON, Promise, Deno: { env: { get: (name: string) => (name === 'SUPABASE_URL' ? 'https://proj.supabase.co/' : 'secret') }, serve: (fn: typeof handler) => { handler = fn } } })
  const upload = (body: Uint8Array | string, headers: Record<string, string> = {}, query = '') => handler(new Request(`https://proj.supabase.co/functions/v1/qa-evidence${query}`, { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'image/webp', ...headers }, body: body as BodyInit }))
  const get = (path: string) => handler(new Request(`https://proj.supabase.co/functions/v1/qa-evidence${path}`))
  return { upload, get, handler: (request: Request) => handler(request), log, rows, objects }
}

describe('qa-evidence uploads', () => {
  it('stores an image and answers with an unguessable link that expires', async () => {
    const { upload, log, rows } = endpoint()
    const response = await upload(WEBP, {}, '?days=30&label=Heading%20too%20small')
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.url).toMatch(/^https:\/\/proj\.supabase\.co\/functions\/v1\/qa-evidence\/[A-Za-z0-9_-]{22}\.webp$/)
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1)
    const id = /([A-Za-z0-9_-]{22})\.webp$/.exec(body.url)![1]
    expect(log.uploads).toEqual([{ path: `user-1/${id}.webp`, contentType: 'image/webp', size: WEBP.length }])
    expect(rows.get(id)).toMatchObject({ auth_user_id: 'user-1', object_path: `user-1/${id}.webp`, content_type: 'image/webp', byte_size: WEBP.length, label: 'Heading too small' })
  })

  it('gives every upload a different id, and clamps the lifetime', async () => {
    const { upload } = endpoint()
    const urls = await Promise.all([upload(WEBP), upload(WEBP), upload(WEBP, {}, '?days=99999')].map(async (p) => (await (await p).json())))
    expect(new Set(urls.map((u) => u.url)).size).toBe(3)
    expect((new Date(urls[2].expiresAt).getTime() - Date.now()) / 86_400_000).toBeLessThan(365.1)
    const short = await (await endpoint().upload(WEBP, {}, '?days=0')).json()
    expect((new Date(short.expiresAt).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(89) // 0 is not a valid lifetime; the default applies
  })

  it('requires a signed-in, verified account', async () => {
    for (const user of [null, { id: 'u', email_confirmed_at: null }]) {
      const { upload, log } = endpoint({ user })
      expect((await upload(WEBP)).status).toBe(401)
      expect(log.uploads).toHaveLength(0)
    }
  })

  it('accepts only real images of the claimed type, within the size limit', async () => {
    const { upload, log } = endpoint()
    expect((await upload(WEBP, { 'content-type': 'text/html' })).status).toBe(415)
    expect((await upload(WEBP, { 'content-type': 'image/svg+xml' })).status).toBe(415)
    expect((await upload('<script>alert(1)</script>', { 'content-type': 'image/png' })).status).toBe(400)
    expect((await upload(PNG, { 'content-type': 'image/webp' })).status).toBe(400)
    expect((await upload(new Uint8Array(0))).status).toBe(400)
    expect((await upload(WEBP, { 'content-length': String(11 * 1024 * 1024) })).status).toBe(413)
    expect((await upload(PNG, { 'content-type': 'image/png' })).status).toBe(201)
    expect(log.uploads).toHaveLength(1)
  })

  it('limits uploads per hour', async () => {
    const { upload, log } = endpoint({ recentUploads: 300 })
    expect((await upload(WEBP)).status).toBe(429)
    expect(log.uploads).toHaveLength(0)
  })

  it('hides internal errors and removes the image if its record cannot be saved', async () => {
    const failedUpload = endpoint({ uploadError: true })
    const response = await failedUpload.upload(WEBP)
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('boom')
    const failedInsert = endpoint({ insertError: true })
    expect((await failedInsert.upload(WEBP)).status).toBe(500)
    expect(failedInsert.log.removed).toHaveLength(1)
    expect(failedInsert.objects.size).toBe(0)
  })

  it('tidies expired images while uploading', async () => {
    const { upload, log, rows, objects } = endpoint({
      rows: [{ id: 'expiredexpiredexpiredAA', object_path: 'u/old.webp', content_type: 'image/webp', expires_at: '2020-01-01T00:00:00Z' }],
      objects: { 'u/old.webp': WEBP },
    })
    expect((await upload(WEBP)).status).toBe(201)
    expect(log.removed).toContain('u/old.webp'); expect(log.deleted).toContain('expiredexpiredexpiredAA')
    expect(rows.has('expiredexpiredexpiredAA')).toBe(false); expect(objects.has('u/old.webp')).toBe(false)
  })
})

describe('qa-evidence downloads', () => {
  const live = { id: VALID_ID, object_path: `user-1/${VALID_ID}.webp`, content_type: 'image/webp', expires_at: new Date(Date.now() + 86_400_000).toISOString() }

  it('serves a live image to anyone with the link, without needing an account, with private headers', async () => {
    const { get, log } = endpoint({ rows: [live], objects: { [live.object_path]: WEBP } })
    const response = await get(`/${VALID_ID}.webp`)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBP)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(log.getUser).toBe(0)
  })

  it('answers the same 404 for unknown, expired, malformed, wrong-type and missing-file links', async () => {
    const expired = { ...live, expires_at: '2020-01-01T00:00:00Z' }
    const cases: Array<[string, Options]> = [
      [`/${VALID_ID}.webp`, {}],
      [`/${VALID_ID}.webp`, { rows: [expired], objects: { [live.object_path]: WEBP } }],
      [`/${VALID_ID}.png`, { rows: [live], objects: { [live.object_path]: WEBP } }],
      [`/${VALID_ID}.webp`, { rows: [live] }],
      ['/short.webp', { rows: [live], objects: { [live.object_path]: WEBP } }],
      [`/${VALID_ID}.svg`, { rows: [live] }],
      [`/../${VALID_ID}.webp/..`, {}],
    ]
    const bodies = new Set<string>()
    for (const [path, options] of cases) {
      const response = await endpoint(options).get(path)
      expect(response.status, path).toBe(404)
      bodies.add(await response.text())
    }
    expect(bodies.size).toBe(1)
  })

  it('has no way to list images, and no other methods', async () => {
    const { get, handler } = endpoint({ rows: [live], objects: { [live.object_path]: WEBP } })
    expect((await get('')).status).toBe(404)
    expect((await get('/')).status).toBe(404)
    expect((await get('?list=1')).status).toBe(404)
    for (const method of ['PUT', 'DELETE', 'PATCH']) expect((await handler(new Request(`https://proj.supabase.co/functions/v1/qa-evidence/${VALID_ID}.webp`, { method }))).status).toBe(405)
  })
})
