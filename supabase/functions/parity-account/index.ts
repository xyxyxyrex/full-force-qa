import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const SESSION_TTL_SECONDS = 15 * 60

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
}

type SessionClaims = {
  v: 1
  sub: string
  monday_user_id: string
  name: string
  email: string
  iat: number
  exp: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

function acceptedPublicKeys(): string[] {
  const keys = new Set<string>()
  const legacy = Deno.env.get('SUPABASE_ANON_KEY')?.trim()
  if (legacy) keys.add(legacy)
  try {
    const configured = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    for (const entry of Object.values(configured) as any[]) {
      const value = typeof entry === 'string' ? entry : entry?.key || entry?.value
      if (typeof value === 'string' && value.trim()) keys.add(value.trim())
    }
  } catch {}
  return [...keys]
}

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

async function signingKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('PARITY_DATA_SIGNING_SECRET')?.trim() || Deno.env.get('MONDAY_CLIENT_SECRET')?.trim()
  if (!secret) throw new Error('Parity account signing is not configured.')
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`parity-account-v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function issueSession(claims: SessionClaims): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'parity-account-v1' }))
  const payload = base64UrlEncode(JSON.stringify(claims))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(), new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${base64UrlEncode(signature)}`
}

async function verifySession(token: string): Promise<SessionClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid Parity account session.')
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))
  if (!timingSafeEqual(expected, base64UrlDecode(parts[2]))) throw new Error('Invalid Parity account session.')
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as SessionClaims
  const now = Math.floor(Date.now() / 1000)
  if (claims.v !== 1 || !/^monday:[0-9]+$/.test(claims.sub) || claims.exp <= now) throw new Error('Parity account session expired.')
  return claims
}

async function verifyMondayUser(accessToken: string): Promise<{ id: string; name: string; email: string }> {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: accessToken,
      'API-Version': '2026-07',
    },
    body: JSON.stringify({ query: 'query ParityAccountIdentity { me { id name email } }' }),
  })
  const body = await response.json().catch(() => null) as any
  const user = body?.data?.me
  if (!response.ok || body?.errors?.length || !user?.id) {
    throw new Error(body?.errors?.[0]?.message || 'Monday could not verify this account.')
  }
  return { id: String(user.id), name: String(user.name || ''), email: String(user.email || '') }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || ''
  return authorization.replace(/^Bearer\s+/i, '').trim()
}

function cleanObject(value: unknown, maxBytes: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object payload.')
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error('Payload is too large.')
  return JSON.parse(encoded)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: jsonHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  const suppliedKey = request.headers.get('apikey')?.trim() || ''
  if (!suppliedKey || !acceptedPublicKeys().includes(suppliedKey)) return json({ error: 'Invalid Supabase public key.' }, 401)

  try {
    const body = await request.json()
    const action = String(body?.action || '')
    const token = bearerToken(request)
    if (!token) return json({ error: 'Monday or Parity account authorization is required.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !serviceKey) return json({ error: 'Parity account storage is not configured.' }, 503)
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

    if (action === 'session') {
      const user = await verifyMondayUser(token)
      const ownerKey = `monday:${user.id}`
      const now = Math.floor(Date.now() / 1000)
      const claims: SessionClaims = { v: 1, sub: ownerKey, monday_user_id: user.id, name: user.name, email: user.email, iat: now, exp: now + SESSION_TTL_SECONDS }
      const { error } = await admin.from('parity_accounts').upsert({ owner_key: ownerKey, monday_user_id: user.id, display_name: user.name, email: user.email, updated_at: new Date().toISOString() }, { onConflict: 'owner_key' })
      if (error) throw error
      return json({ session_token: await issueSession(claims), expires_at: claims.exp * 1000, user: { ownerKey, mondayUserId: user.id, name: user.name, email: user.email } })
    }

    let claims: SessionClaims
    try {
      claims = await verifySession(token)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Invalid account session.' }, 401)
    }
    const ownerKey = claims.sub

    if (action === 'bootstrap') {
      const [stateResult, projectsResult, notesResult] = await Promise.all([
        admin.from('parity_user_state').select('data,updated_at').eq('owner_key', ownerKey).maybeSingle(),
        admin.from('parity_projects').select('data,updated_at').eq('owner_key', ownerKey).order('updated_at', { ascending: false }),
        admin.from('parity_notes').select('data,updated_at').eq('owner_key', ownerKey).order('updated_at', { ascending: false }),
      ])
      if (stateResult.error) throw stateResult.error
      if (projectsResult.error) throw projectsResult.error
      if (notesResult.error) throw notesResult.error
      return json({
        user: { ownerKey, mondayUserId: claims.monday_user_id, name: claims.name, email: claims.email },
        state: stateResult.data ? { ...stateResult.data.data, updatedAt: stateResult.data.updated_at } : null,
        projects: (projectsResult.data || []).map((row: any) => ({ ...row.data, cloudUpdatedAt: row.updated_at })),
        notes: (notesResult.data || []).map((row: any) => ({ ...row.data, cloudUpdatedAt: row.updated_at })),
      })
    }

    if (action === 'save_state') {
      const patch = cleanObject(body?.data, 512_000)
      const result = await admin.rpc('merge_parity_user_state', { p_owner_key: ownerKey, p_patch: patch })
      if (result.error) throw result.error
      return json({ success: true, updatedAt: result.data })
    }

    if (action === 'save_project') {
      const project = cleanObject(body?.project, 1_500_000)
      const projectId = String(project.id || '')
      if (!projectId || projectId.length > 200) throw new Error('Invalid project ID.')
      const result = await admin.from('parity_projects').upsert({ owner_key: ownerKey, project_id: projectId, data: project, updated_at: new Date().toISOString() }, { onConflict: 'owner_key,project_id' })
      if (result.error) throw result.error
      return json({ success: true })
    }

    if (action === 'delete_project') {
      const projectId = String(body?.projectId || '')
      const result = await admin.from('parity_projects').delete().eq('owner_key', ownerKey).eq('project_id', projectId)
      if (result.error) throw result.error
      return json({ success: true })
    }

    if (action === 'save_note') {
      const note = cleanObject(body?.note, 1_500_000)
      const noteId = String(note.id || '')
      if (!noteId || noteId.length > 200) throw new Error('Invalid note ID.')
      const result = await admin.from('parity_notes').upsert({ owner_key: ownerKey, note_id: noteId, data: note, updated_at: new Date().toISOString() }, { onConflict: 'owner_key,note_id' }).select('updated_at').single()
      if (result.error) throw result.error
      return json({ success: true, updatedAt: result.data.updated_at })
    }

    if (action === 'delete_note') {
      const noteId = String(body?.noteId || '')
      const result = await admin.from('parity_notes').delete().eq('owner_key', ownerKey).eq('note_id', noteId)
      if (result.error) throw result.error
      return json({ success: true })
    }

    return json({ error: 'Unsupported action.' }, 400)
  } catch (error) {
    console.error('[parity-account]', error)
    return json({ error: error instanceof Error ? error.message : 'Parity account request failed.' }, 500)
  }
})
