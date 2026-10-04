import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '../../../shared/qaAgent'
import { createProvider, DEFAULT_AGENT_SETTINGS, DEFAULT_LOCAL_URL, describeAgents, listModels, normalizeSettings } from './registry'

describe('normalizeSettings', () => {
  it('returns the defaults for missing or broken input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_AGENT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_AGENT_SETTINGS)
    expect(normalizeSettings({ defaultAgent: 'skynet', effort: 'extreme', budgetTokens: -5, localBaseUrl: 'ftp://x', evidenceDays: 45, models: { codex: 42 } })).toEqual(DEFAULT_AGENT_SETTINGS)
  })

  it('keeps valid values and cleans them', () => {
    const settings = normalizeSettings({ defaultAgent: 'codex', effort: 'high', budgetTokens: 1_500_000.7, localBaseUrl: ' http://localhost:1234/v1/ ', models: { 'openai-api': '  gpt-test ', local: 'llava:13b', bogus: 'x' } })
    expect(settings).toMatchObject({ defaultAgent: 'codex', effort: 'high', budgetTokens: 1_500_001, localBaseUrl: 'http://localhost:1234/v1' })
    expect(settings.models['openai-api']).toBe('gpt-test')
    expect(settings.models.local).toBe('llava:13b')
    expect(settings.models['anthropic-api']).toBe(DEFAULT_AGENT_SETTINGS.models['anthropic-api'])
    expect('bogus' in settings.models).toBe(false)
  })

  it('keeps evidence settings to the offered lifetimes', () => {
    expect(normalizeSettings({ evidenceUploads: false, evidenceDays: 30 })).toMatchObject({ evidenceUploads: false, evidenceDays: 30 })
    expect(normalizeSettings({ evidenceUploads: 'no', evidenceDays: '365' })).toMatchObject({ evidenceUploads: true, evidenceDays: 365 })
    expect(DEFAULT_AGENT_SETTINGS).toMatchObject({ evidenceUploads: true, evidenceDays: 90 })
  })

  it('caps absurd budgets and long model names', () => {
    expect(normalizeSettings({ budgetTokens: 9e15 }).budgetTokens).toBe(50_000_000)
    expect(normalizeSettings({ models: { local: 'x'.repeat(500) } }).models.local).toHaveLength(120)
    expect(DEFAULT_AGENT_SETTINGS.localBaseUrl).toBe(DEFAULT_LOCAL_URL)
  })
})

describe('createProvider', () => {
  const deps = (settings = DEFAULT_AGENT_SETTINGS, keys: Partial<Record<AgentId, string>> = {}) => ({ settings, getKey: (id: AgentId) => keys[id] ?? null, getBridge: () => ({ mcpUrl: 'http://127.0.0.1:29849/mcp', token: 'k' }) })

  it('builds each kind of backend', () => {
    expect(createProvider('claude-code', deps())).toMatchObject({ id: 'claude-code', needsBridge: true })
    expect(createProvider('codex', deps())).toMatchObject({ id: 'codex', needsBridge: true })
    expect(createProvider('gemini-cli', deps())).toMatchObject({ id: 'gemini-cli', needsBridge: true })
    expect(createProvider('anthropic-api', deps(DEFAULT_AGENT_SETTINGS, { 'anthropic-api': 'sk-x' }))).toMatchObject({ id: 'anthropic-api' })
    const settings = normalizeSettings({ models: { 'openai-api': 'gpt-test', 'gemini-api': 'gemini-test', local: 'llava' } })
    expect(createProvider('openai-api', deps(settings, { 'openai-api': 'sk-o' }))).toMatchObject({ id: 'openai-api', label: 'OpenAI' })
    expect(createProvider('gemini-api', deps(settings, { 'gemini-api': 'g' }))).toMatchObject({ id: 'gemini-api', label: 'Gemini' })
    expect(createProvider('local', deps(settings))).toMatchObject({ id: 'local' })
  })

  it('says what is missing instead of failing later', () => {
    expect(() => createProvider('anthropic-api', deps())).toThrow(/Claude API key/)
    expect(() => createProvider('openai-api', deps())).toThrow(/OpenAI API key/)
    expect(() => createProvider('gemini-api', deps(DEFAULT_AGENT_SETTINGS, { 'gemini-api': 'g' }))).toThrow(/Choose a model/)
    expect(() => createProvider('local', deps())).toThrow(/Choose a local model/)
  })
})

describe.skipIf(process.platform === 'win32')('describeAgents', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-describe-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('tells which agents can be used right now', async () => {
    const claude = join(dir, 'claude')
    writeFileSync(claude, `#!/usr/bin/env node\nconst a = process.argv.slice(2); if (a[0] === '--version') console.log('2.0'); else console.log(JSON.stringify({ loggedIn: true }))`)
    chmodSync(claude, 0o755)
    const settings = normalizeSettings({ models: { 'openai-api': 'gpt-test' } })
    const agents = await describeAgents({ settings, getKey: (id) => (id === 'openai-api' ? 'sk' : null), cliPath: (id) => (id === 'claude-code' ? claude : join(dir, 'missing')) })
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]))
    expect(agents.map((a) => a.id)).toEqual(['claude-code', 'codex', 'gemini-cli', 'anthropic-api', 'openai-api', 'gemini-api', 'local'])
    expect(byId['claude-code']).toMatchObject({ kind: 'subscription', ready: true })
    expect(byId.codex).toMatchObject({ ready: false, detail: expect.stringContaining('Not found') })
    expect(byId['anthropic-api']).toMatchObject({ kind: 'api', ready: false, needsKey: true, hasKey: false, detail: 'Add your API key.' })
    expect(byId['openai-api']).toMatchObject({ ready: true, hasKey: true, model: 'gpt-test' })
    expect(byId.local).toMatchObject({ kind: 'local', ready: false })
  })
})

describe('listModels', () => {
  let server: Server
  let base: string
  const seen: Array<{ url: string; auth?: string; apiKey?: string }> = []
  beforeEach(async () => {
    seen.length = 0
    server = createServer((req, res) => {
      seen.push({ url: req.url || '', auth: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if ((req.url || '').startsWith('/v1/models') && req.headers['x-api-key']) res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Opus', created_at: '2026-01-01T00:00:00Z' }, { id: 'claude-haiku-4-5', type: 'model', display_name: 'Haiku', created_at: '2025-01-01T00:00:00Z' }], has_more: false, first_id: 'a', last_id: 'b' }))
      else res.end(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })

  it('lists a local server\'s models, sorted and de-duplicated, without a key', async () => {
    const settings = normalizeSettings({ localBaseUrl: `${base}/v1` })
    expect(await listModels('local', { settings, getKey: () => null })).toEqual({ models: ['alpha', 'zeta'] })
    expect(seen[0]).toMatchObject({ url: '/v1/models', auth: undefined })
  })

  it('lists Claude models with the key', async () => {
    const result = await listModels('anthropic-api', { settings: DEFAULT_AGENT_SETTINGS, getKey: () => 'sk-test' }, { anthropicBaseURL: base })
    expect(result).toEqual({ models: ['claude-opus-5-5', 'claude-haiku-4-5'] })
    expect(seen[0].apiKey).toBe('sk-test')
  })

  it('asks for a key first, and explains an unreachable server', async () => {
    expect(await listModels('openai-api', { settings: DEFAULT_AGENT_SETTINGS, getKey: () => null })).toEqual({ models: [], error: 'Add your API key first.' })
    expect(await listModels('anthropic-api', { settings: DEFAULT_AGENT_SETTINGS, getKey: () => null })).toEqual({ models: [], error: 'Add your API key first.' })
    const closed = normalizeSettings({ localBaseUrl: 'http://127.0.0.1:1/v1' })
    expect((await listModels('local', { settings: closed, getKey: () => null })).error).toContain('Is the server running?')
    expect(await listModels('claude-code', { settings: DEFAULT_AGENT_SETTINGS, getKey: () => null })).toEqual({ models: [] })
  })
})
