import { createHash, timingSafeEqual } from 'crypto'

// Request checks for the local bridge, cheapest first. Pure so the whole matrix can be tested.
// The bridge is for programs on this computer: a web page must never be able to reach it, even
// through the browser (cross-site requests, DNS rebinding), so any Origin header is refused.

export const MAX_BODY_BYTES = 1024 * 1024

export interface GuardInput {
  method: string
  path: string
  host: string | undefined
  origin: string | undefined
  contentType: string | undefined
  authorization: string | undefined
}

export type GuardResult = { ok: true } | { ok: false; status: number; message: string }

const sha = (value: string) => createHash('sha256').update(value).digest()

export function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization || !token) return false
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
  if (!match) return false
  return timingSafeEqual(sha(match[1]), sha(token))
}

export function isKnownRoute(method: string, path: string): boolean {
  if (path === '/mcp') return method === 'POST'
  if (path === '/api/status' || path === '/api/tools' || path === '/api/prompt') return method === 'GET'
  if (/^\/api\/tools\/[a-z_]+$/.test(path)) return method === 'POST'
  return false
}

export function checkRequest(input: GuardInput, port: number, token: string): GuardResult {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!input.host || !allowedHosts.includes(input.host.toLowerCase())) return { ok: false, status: 421, message: 'Wrong host.' }
  if (input.origin !== undefined) return { ok: false, status: 403, message: 'Browser requests are not allowed.' }
  const known = isKnownRoute(input.method, input.path)
  const exists = isKnownRoute('GET', input.path) || isKnownRoute('POST', input.path)
  if (!exists) return { ok: false, status: 404, message: 'Not found.' }
  if (!known) return { ok: false, status: 405, message: 'Method not allowed.' }
  if (input.method === 'POST' && !/^application\/json(\s*;.*)?$/i.test(input.contentType || '')) return { ok: false, status: 415, message: 'Send application/json.' }
  if (!tokenMatches(input.authorization, token)) return { ok: false, status: 401, message: 'Missing or wrong key.' }
  return { ok: true }
}
