import { describe, expect, it } from 'vitest'
import { checkRequest, isKnownRoute, tokenMatches, type GuardInput } from './guards'

const TOKEN = 'k'.repeat(43)
const PORT = 29849
const ok: GuardInput = { method: 'POST', path: '/mcp', host: `127.0.0.1:${PORT}`, origin: undefined, contentType: 'application/json', authorization: `Bearer ${TOKEN}` }
const check = (over: Partial<GuardInput>) => checkRequest({ ...ok, ...over }, PORT, TOKEN)
const status = (over: Partial<GuardInput>) => { const r = check(over); return r.ok ? 200 : r.status }

describe('tokenMatches', () => {
  it('accepts only the exact bearer key', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(tokenMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false)
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false)
    expect(tokenMatches('Basic abc', TOKEN)).toBe(false)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
    expect(tokenMatches(`Bearer ${TOKEN}`, '')).toBe(false)
  })
})

describe('isKnownRoute', () => {
  it('lists the allowed method and path pairs', () => {
    expect(isKnownRoute('POST', '/mcp')).toBe(true)
    expect(isKnownRoute('GET', '/mcp')).toBe(false)
    expect(isKnownRoute('GET', '/api/status')).toBe(true)
    expect(isKnownRoute('GET', '/api/tools')).toBe(true)
    expect(isKnownRoute('GET', '/api/prompt')).toBe(true)
    expect(isKnownRoute('POST', '/api/prompt')).toBe(false)
    expect(isKnownRoute('POST', '/api/tools/get_context')).toBe(true)
    expect(isKnownRoute('POST', '/api/tools/../etc')).toBe(false)
    expect(isKnownRoute('POST', '/api/tools/')).toBe(false)
  })
})

describe('checkRequest', () => {
  it('lets a correct request through', () => {
    expect(check({})).toEqual({ ok: true })
    expect(check({ host: `localhost:${PORT}` })).toEqual({ ok: true })
    expect(status({ method: 'GET', path: '/api/status', contentType: undefined })).toBe(200)
    expect(status({ contentType: 'application/json; charset=utf-8' })).toBe(200)
  })

  it('refuses a wrong or missing Host (DNS rebinding) before anything else', () => {
    expect(status({ host: 'evil.test' })).toBe(421)
    expect(status({ host: `127.0.0.1:${PORT + 1}` })).toBe(421)
    expect(status({ host: undefined })).toBe(421)
    expect(status({ host: `evil.test:${PORT}`, authorization: undefined })).toBe(421)
  })

  it('refuses any browser request, with or without the key', () => {
    expect(status({ origin: 'https://evil.test' })).toBe(403)
    expect(status({ origin: 'http://127.0.0.1:29849' })).toBe(403)
    expect(status({ origin: 'null' })).toBe(403)
    expect(status({ origin: '' })).toBe(403)
  })

  it('answers unknown paths with 404 and wrong methods with 405 (so a preflight gets no CORS)', () => {
    expect(status({ path: '/' })).toBe(404)
    expect(status({ path: '/mcp/extra' })).toBe(404)
    expect(status({ method: 'OPTIONS' })).toBe(405)
    expect(status({ method: 'GET' })).toBe(405)
    expect(status({ method: 'DELETE' })).toBe(405)
    expect(status({ method: 'POST', path: '/api/status' })).toBe(405)
  })

  it('requires JSON for POST', () => {
    expect(status({ contentType: 'text/plain' })).toBe(415)
    expect(status({ contentType: undefined })).toBe(415)
    expect(status({ contentType: 'application/jsonx' })).toBe(415)
  })

  it('requires the bearer key last', () => {
    expect(status({ authorization: undefined })).toBe(401)
    expect(status({ authorization: 'Bearer wrong' })).toBe(401)
  })

  it('has no lockout: many bad keys do not stop a correct one', () => {
    for (let i = 0; i < 100; i++) check({ authorization: `Bearer bad${i}` })
    expect(check({})).toEqual({ ok: true })
  })
})
