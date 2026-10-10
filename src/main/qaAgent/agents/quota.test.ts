import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuotaService, parseAntigravityQuota, parseClaudeQuota, parseCodexQuota, parseOpenRouterQuota, quotaFromHeaders, quotaScope, readCodexQuota } from './quota'
import { DEFAULT_AGENT_SETTINGS } from './registry'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-quota-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }) })
const payload = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 2000001000 } }, other: { limitName: 'Another model', primary: { usedPercent: 50, windowDurationMins: 60 } } } }
const fixture = (body: string) => {
  const script = join(dir, 'cli.cjs')
  writeFileSync(script, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))},String(process.pid));const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');require('readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))},line+'\\n');${body}})`)
  return { binary: process.execPath, prefixArgs: [script] }
}
const stopped = async () => {
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Quota process remained alive')
}
describe('provider quota parsing', () => {
  it('handles multiple Codex windows and the older single-bucket shape, including zero usage', () => {
    expect(parseCodexQuota(payload, 1).windows).toHaveLength(3)
    expect(parseCodexQuota(payload, 1).windows[1]).toMatchObject({ usedPercent: 0, resetsAt: 2000001000000, label: 'codex · 7-day window' })
    expect(parseCodexQuota({ rateLimits: payload.rateLimitsByLimitId.codex }).windows).toHaveLength(2)
    expect(parseCodexQuota({ rateLimits: { primary: { usedPercent: '25' } } }).source).toBe('unavailable')
    expect(parseCodexQuota({ rateLimits: { primary: { usedPercent: Infinity } } }).windows).toHaveLength(0)
  })
  it('distinguishes Claude notices from optional utilization and does not invent percentages', () => {
    expect(parseClaudeQuota({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 2000000000 })?.windows[0]).toMatchObject({ status: 'allowed', resetsAt: 2000000000000 })
    expect(parseClaudeQuota({ status: 'allowed' })?.windows[0].usedPercent).toBeUndefined()
    expect(parseClaudeQuota({ status: 'allowed_warning', utilization: 0.91 })?.windows[0].usedPercent).toBe(91)
    expect(parseClaudeQuota({ status: 'rejected', utilization: 1 })?.windows[0].usedPercent).toBe(100)
    expect(parseClaudeQuota({ status: 'unknown', private_data: 'secret' })).toBeNull()
  })
  it('reads explicitly labelled Antigravity remaining percentages and never returns raw output', () => {
    const result = parseAntigravityQuota('\x1b[32mModel | Remaining | Reset\x1b[0m\nGemini 3.5 Flash | 82% | 2033-05-18T03:33:20Z\nprivate@example.test\nClaude Sonnet | 0% | unknown')
    expect(result.windows).toMatchObject([{ label: 'Gemini 3.5 Flash', usedPercent: 18, resetsAt: 2000000000000 }, { label: 'Claude Sonnet', usedPercent: 100 }])
    expect(JSON.stringify(result)).not.toContain('private@example.test')
    expect(parseAntigravityQuota('Gemini 3.5 Flash | 82%').source).toBe('unavailable')
  })
  it('preserves OpenRouter zero balances and treats unset limits as unavailable, not unlimited', () => {
    const result = parseOpenRouterQuota({ data: { limit_remaining: 0, limit: 10, free_model_daily_requests: { remaining: 0, limit: 50 }, label: 'secret-key', organization_id: 'private' } })
    expect(result.windows).toMatchObject([{ remaining: 0, limit: 10, unit: 'USD' }, { remaining: 0, limit: 50, unit: 'requests' }])
    expect(JSON.stringify(result)).not.toMatch(/secret-key|private/)
    expect(parseOpenRouterQuota({ data: { limit: null, limit_remaining: null } }).source).toBe('unavailable')
  })
  it('reads documented OpenAI and Anthropic headers, retaining zero and reset times', () => {
    const now = 1800000000000
    expect(quotaFromHeaders('openai-api', 'm', new Headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-reset-requests': '1m5s' }), now)?.windows[0]).toMatchObject({ remaining: 0, limit: 100, resetsAt: now + 65000 })
    expect(quotaFromHeaders('anthropic-api', 'm', new Headers({ 'anthropic-ratelimit-input-tokens-remaining': '1200', 'anthropic-ratelimit-input-tokens-reset': '2033-05-18T03:33:20Z' }), now)?.windows[0]).toMatchObject({ remaining: 1200, unit: 'tokens', resetsAt: 2000000000000 })
    expect(quotaFromHeaders('gemini-api', 'm', new Headers())).toBeNull()
    expect(quotaFromHeaders('openai-api', 'm', new Headers({ 'x-ratelimit-remaining-requests': '-1' }))).toBeNull()
  })
})
describe('zero-prompt quota processes', { timeout: 20000 }, () => {
  it('initializes Codex and reads only rate limits, then terminates its process', async () => {
    const options = fixture(`if(request.method==='initialize')out({id:request.id,result:{}});if(request.method==='account/rateLimits/read')out({id:request.id,result:${JSON.stringify(payload)}});`)
    expect((await readCodexQuota(options)).windows).toHaveLength(3)
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
    expect(JSON.stringify(calls)).not.toMatch(/thread\/|turn\/|model\/|prompt/)
    await stopped()
  })
  it('handles missing installations and private protocol errors safely', async () => {
    await expect(readCodexQuota({ binary: join(dir, 'missing.exe') })).rejects.toThrow('not found')
    const options = fixture("out({id:request.id,error:{message:'secret-token-and-account'}})")
    await expect(readCodexQuota(options)).rejects.toThrow('sign in')
    await stopped()
  })
  it('bounds hangs and kills cancelled checks', async () => {
    const options = fixture('')
    await expect(readCodexQuota({ ...options, timeoutMs: 1500 })).rejects.toThrow('too long')
    await stopped()
    const controller = new AbortController()
    const promise = readCodexQuota({ ...options, signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 300))
    controller.abort()
    await expect(promise).rejects.toThrow('Cancelled')
    await stopped()
  })
})
describe('account/config-scoped quota service', () => {
  it('caches and coalesces checks and supports explicit refresh without inference', async () => {
    const codex = vi.fn(async () => parseCodexQuota(payload, 1000))
    const service = createQuotaService({ codex, now: () => 1000 })
    await Promise.all([service.read('a', 'codex', 'm'), service.read('a', 'codex', 'm')])
    expect(codex).toHaveBeenCalledTimes(1)
    expect((await service.read('a', 'codex', 'm')).cached).toBe(true)
    await service.read('a', 'codex', 'm', undefined, true)
    expect(codex).toHaveBeenCalledTimes(2)
  })
  it('isolates owners, credentials, models and servers and expires observed headroom', async () => {
    let now = 1000
    const service = createQuotaService({ now: () => now })
    const a = quotaScope('a', 'openai-api', DEFAULT_AGENT_SETTINGS, 'secret-a')
    expect(a).not.toContain('secret-a')
    expect(a).not.toBe(quotaScope('b', 'openai-api', DEFAULT_AGENT_SETTINGS, 'secret-a'))
    expect(a).not.toBe(quotaScope('a', 'openai-api', DEFAULT_AGENT_SETTINGS, 'secret-b'))
    expect(a).not.toBe(quotaScope('a', 'openai-api', { ...DEFAULT_AGENT_SETTINGS, models: { ...DEFAULT_AGENT_SETTINGS.models, 'openai-api': 'different' } }, 'secret-a'))
    expect(quotaScope('a', 'local', DEFAULT_AGENT_SETTINGS)).not.toBe(quotaScope('a', 'local', { ...DEFAULT_AGENT_SETTINGS, localBaseUrl: 'https://other.test/v1' }))
    service.observe(a, { agent: 'openai-api', checkedAt: now, source: 'observed', windows: [{ label: 'Requests', remaining: 12, resetsAt: 2000 }], note: 'Observed' })
    expect((await service.read(a, 'openai-api', 'm')).windows[0].remaining).toBe(12)
    expect((await service.read('b', 'openai-api', 'm')).source).toBe('unavailable')
    now = 40000
    expect((await service.read(a, 'openai-api', 'm', undefined, true)).source).toBe('unavailable')
    service.clear()
    expect((await service.read(a, 'openai-api', 'm')).source).toBe('unavailable')
  })
  it('fetches only current OpenRouter key metadata and sanitizes failed checks', async () => {
    const fetcher = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ data: { limit_remaining: 12 } })))
    const service = createQuotaService({ fetch: fetcher as typeof fetch })
    const result = await service.read('key-scope', 'openrouter', 'm', 'secret-key')
    expect(fetcher.mock.calls[0]).toMatchObject(['https://openrouter.ai/api/v1/key', { redirect: 'error', headers: { Authorization: 'Bearer secret-key' } }])
    expect(result.windows[0].remaining).toBe(12)
    expect(JSON.stringify(result)).not.toContain('secret-key')
    const failure = createQuotaService({ fetch: async () => { throw new Error('private-token-and-account') } })
    expect(JSON.stringify(await failure.read('a', 'openrouter', 'm', 'key'))).not.toContain('private-token')
  })
  it('runs Antigravity usage separately and reports unsupported providers honestly', async () => {
    const cli = vi.fn(async (..._args: unknown[]) => 'Model | Remaining\nGemini Flash | 50%')
    const service = createQuotaService({ cli })
    expect((await service.read('a', 'antigravity', 'm')).windows[0].usedPercent).toBe(50)
    expect(cli.mock.calls[0]).toMatchObject([{ binary: 'agy', args: ['-p', '/usage'] }])
    expect((await service.read('b', 'claude-code', 'm')).source).toBe('unavailable')
    expect((await service.read('c', 'gemini-api', 'm')).note).toContain('AI Studio')
    expect(cli).toHaveBeenCalledTimes(1)
  })
  it('cancels checks on account change and rejects late replies', async () => {
    let complete!: (value: ReturnType<typeof parseCodexQuota>) => void
    const service = createQuotaService({ codex: () => new Promise(resolve => { complete = resolve }) })
    const promise = service.read('old-account', 'codex', 'm')
    const assertion = expect(promise).rejects.toThrow('cancelled')
    service.clear(); complete(parseCodexQuota(payload))
    await assertion
  })
})
