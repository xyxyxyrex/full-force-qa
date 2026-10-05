import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

// QA evidence images for the Parity app.
//   POST /qa-evidence?days=90&label=…   Parity account token + the image as the request body.
//                                       Stores it and answers with a link.
//   GET  /qa-evidence/<id>.<ext>        Serves the image to anyone who has the link, until it expires.
//   GET  /qa-evidence/<id>.json         What the Parity viewer page shows with it: the finding, the expiry and
//                                       the image address. Readable from any page (the viewer is on another site).
// Links cannot be listed or guessed (128-bit random ids), images cannot be overwritten, and expired
// or unknown ids all answer the same plain 404.

const BUCKET = 'qa-evidence'
const MAX_BYTES = 10 * 1024 * 1024
const HOURLY_UPLOAD_LIMIT = 300
const DEFAULT_DAYS = 90
const MAX_DAYS = 365
const EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }
const CONTENT_TYPE_FOR: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' }
const FILE_ROUTE = /\/([A-Za-z0-9_-]{22})\.(webp|png|jpg)$/
const DETAILS_ROUTE = /\/([A-Za-z0-9_-]{22})\.json$/

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders })
const notFound = () => json({ error: 'Not found.' }, 404)

function looksLikeImage(bytes: Uint8Array, contentType: string): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))
  if (contentType === 'image/png') return bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG'
  if (contentType === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (contentType === 'image/webp') return bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
  return false
}

function newId(): string {
  const random = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

Deno.serve(async request => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const url = new URL(request.url)

  if (request.method === 'GET') {
    const details = DETAILS_ROUTE.exec(url.pathname)
    if (details) {
      // The viewer page (another site) reads this, so it may be read from anywhere; it holds nothing the link does not already give.
      const viewerHeaders = { ...jsonHeaders, 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
      const { data: row } = await admin.from('qa_evidence').select('content_type, label, expires_at').eq('id', details[1]).maybeSingle()
      const extension = row ? EXTENSION[row.content_type] : undefined
      if (!row || !extension || !(new Date(row.expires_at).getTime() > Date.now())) return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: viewerHeaders })
      const base = Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '')
      return new Response(JSON.stringify({ id: details[1], label: row.label || '', contentType: row.content_type, expiresAt: row.expires_at, image: `${base}/functions/v1/qa-evidence/${details[1]}.${extension}` }), { status: 200, headers: viewerHeaders })
    }
    const match = FILE_ROUTE.exec(url.pathname)
    if (!match) return notFound()
    const [, id, extension] = match
    const { data: row } = await admin.from('qa_evidence').select('object_path, content_type, expires_at').eq('id', id).maybeSingle()
    if (!row || row.content_type !== CONTENT_TYPE_FOR[extension] || !(new Date(row.expires_at).getTime() > Date.now())) return notFound()
    const { data: file, error } = await admin.storage.from(BUCKET).download(row.object_path)
    if (error || !file) return notFound()
    return new Response(await file.arrayBuffer(), {
      status: 200,
      headers: {
        'Content-Type': row.content_type,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=300',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
    const { data: identity, error: authError } = await admin.auth.getUser(token)
    if (authError || !identity.user?.email_confirmed_at) return json({ error: 'Sign in with a verified email.' }, 401)
    const user = identity.user

    const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const extension = EXTENSION[contentType]
    if (!extension) return json({ error: 'Send a WebP, PNG or JPEG image.' }, 415)
    if (Number(request.headers.get('content-length') || 0) > MAX_BYTES) return json({ error: 'The image is larger than 10 MB.' }, 413)
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_BYTES) return json({ error: bytes.length ? 'The image is larger than 10 MB.' : 'The image is empty.' }, bytes.length ? 413 : 400)
    if (!looksLikeImage(bytes, contentType)) return json({ error: 'The file is not the image type it claims to be.' }, 400)

    const days = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(url.searchParams.get('days')) || DEFAULT_DAYS)))
    const label = (url.searchParams.get('label') || '').slice(0, 200)

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error: countError } = await admin.from('qa_evidence').select('id', { count: 'exact', head: true }).eq('auth_user_id', user.id).gte('created_at', since)
    if (countError) throw countError
    if ((count || 0) >= HOURLY_UPLOAD_LIMIT) return json({ error: 'Too many uploads this hour. Try again later.' }, 429)

    const id = newId()
    const objectPath = `${user.id}/${id}.${extension}`
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    const { error: uploadError } = await admin.storage.from(BUCKET).upload(objectPath, bytes, { contentType, upsert: false })
    if (uploadError) throw uploadError
    const { error: insertError } = await admin.from('qa_evidence').insert({ id, auth_user_id: user.id, object_path: objectPath, content_type: contentType, byte_size: bytes.length, label, expires_at: expiresAt })
    if (insertError) {
      await admin.storage.from(BUCKET).remove([objectPath])
      throw insertError
    }

    // Tidy a batch of expired images while we are here, so storage does not grow without a scheduled job.
    try {
      const { data: expired } = await admin.from('qa_evidence').select('id, object_path').lt('expires_at', new Date().toISOString()).limit(100)
      if (expired?.length) {
        await admin.storage.from(BUCKET).remove(expired.map((item: { object_path: string }) => item.object_path))
        await admin.from('qa_evidence').delete().in('id', expired.map((item: { id: string }) => item.id))
      }
    } catch { /* cleanup is best effort */ }

    return json({ url: `${Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '')}/functions/v1/qa-evidence/${id}.${extension}`, expiresAt }, 201)
  } catch {
    return json({ error: 'The image could not be saved. Try again.' }, 500)
  }
})
