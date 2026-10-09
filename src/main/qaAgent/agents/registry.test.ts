import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '../../../shared/qaAgent'
import { createProvider, DEFAULT_AGENT_SETTINGS, DEFAULT_LOCAL_URL, describeAgents, listModels, normalizeSettings, pickOpenRouterModels, recommendedModel, usesFreeTier } from './registry'

describe('normalizeSettings', () => {
  it('moves a saved choice of Gemini CLI over to Antigravity CLI and drops its model', () => {
    const settings = normalizeSettings({ defaultAgent: 'gemini-cli', models: { 'gemini-cli': 'gemini-2.5-pro', 'openai-api': 'gpt-test' } })
    expect(settings.defaultAgent).toBe('antigravity')
    expect(settings.models.antigravity).toBe('')
    expect(settings.models['openai-api']).toBe('gpt-test')
    expect(Object.keys(settings.models)).not.toContain('gemini-cli')
  })

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

  it('keeps sending off unless it was turned on, and functional checks on unless turned off', () => {
    expect(DEFAULT_AGENT_SETTINGS).toMatchObject({ allowSend: false, functionalChecks: true })
    expect(normalizeSettings({ allowSend: 'yes', functionalChecks: 0 })).toMatchObject({ allowSend: false, functionalChecks: true })
    expect(normalizeSettings({ allowSend: true, functionalChecks: false })).toMatchObject({ allowSend: true, functionalChecks: false })
  })

  it('keeps Gemini on the free tier unless billing was turned on', () => {
    expect(DEFAULT_AGENT_SETTINGS.geminiBilling).toBe(false)
    expect(normalizeSettings({ geminiBilling: 'yes' }).geminiBilling).toBe(false)
    expect(normalizeSettings({ geminiBilling: true }).geminiBilling).toBe(true)
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
    expect(createProvider('antigravity', deps())).toMatchObject({ id: 'antigravity', needsBridge: true })
    expect(createProvider('anthropic-api', deps(DEFAULT_AGENT_SETTINGS, { 'anthropic-api': 'sk-x' }))).toMatchObject({ id: 'anthropic-api' })
    const settings = normalizeSettings({ models: { 'openai-api': 'gpt-test', 'gemini-api': 'gemini-test', local: 'llava' } })
    expect(createProvider('openai-api', deps(settings, { 'openai-api': 'sk-o' }))).toMatchObject({ id: 'openai-api', label: 'OpenAI' })
    expect(createProvider('gemini-api', deps(settings, { 'gemini-api': 'g' }))).toMatchObject({ id: 'gemini-api', label: 'Gemini' })
    expect(createProvider('local', deps(settings))).toMatchObject({ id: 'local' })
  })

  it('keeps free tiers lighter: Gemini without billing and OpenRouter\'s free models', () => {
    const free = normalizeSettings({ models: { 'gemini-api': 'gemini-flash-latest', openrouter: 'google/gemma-4-31b-it:free', 'openai-api': 'gpt-test' } })
    expect(createProvider('gemini-api', deps(free, { 'gemini-api': 'g' }))).toMatchObject({ lite: true })
    expect(createProvider('openrouter', deps(free, { openrouter: 'or' }))).toMatchObject({ id: 'openrouter', label: 'OpenRouter', lite: true })
    expect(createProvider('openai-api', deps(free, { 'openai-api': 'o' }))).toMatchObject({ lite: false })
    const paid = normalizeSettings({ geminiBilling: true, models: { 'gemini-api': 'gemini-pro-latest', openrouter: 'anthropic/claude-opus-5.5' } })
    expect(createProvider('gemini-api', deps(paid, { 'gemini-api': 'g' }))).toMatchObject({ lite: false })
    expect(createProvider('openrouter', deps(paid, { openrouter: 'or' }))).toMatchObject({ lite: false })
    expect(usesFreeTier('openrouter', normalizeSettings({ models: { openrouter: 'openrouter/free' } }))).toBe(true)
    expect(usesFreeTier('claude-code', free)).toBe(false)
  })

  it('says what is missing instead of failing later', () => {
    expect(() => createProvider('anthropic-api', deps())).toThrow(/Claude API key/)
    expect(() => createProvider('openai-api', deps())).toThrow(/OpenAI API key/)
    expect(() => createProvider('gemini-api', deps(DEFAULT_AGENT_SETTINGS, { 'gemini-api': 'g' }))).toThrow(/Choose a model/)
    expect(() => createProvider('openrouter', deps())).toThrow(/free OpenRouter key/)
    expect(() => createProvider('openrouter', deps(DEFAULT_AGENT_SETTINGS, { openrouter: 'or' }))).toThrow(/List models shows the free ones/)
    expect(() => createProvider('local', deps())).toThrow(/Choose a local model/)
  })
})

describe('recommendedModel', () => {
  it('picks Gemini\'s Flash alias, else the newest stable Flash, and nothing for paid keys', () => {
    expect(recommendedModel('gemini-api', ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest'])).toBe('gemini-flash-latest')
    expect(recommendedModel('gemini-api', ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3-pro'])).toBe('gemini-2.5-flash')
    expect(recommendedModel('gemini-api', ['gemini-3-pro'])).toBeUndefined()
    expect(recommendedModel('openrouter', ['newest:free', 'older:free'])).toBe('newest:free')
    expect(recommendedModel('openai-api', ['gpt-test'])).toBeUndefined()
  })
})

describe('pickOpenRouterModels', () => {
  it('keeps the free models that read pictures and call tools, newest first', () => {
    const model = (id: string, created: number, over: Record<string, unknown> = {}) => ({ id, created, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'tool_choice'], ...over })
    expect(pickOpenRouterModels([
      model('old/vision:free', 1),
      model('new/vision:free', 3),
      model('text/only:free', 2, { architecture: { input_modalities: ['text'] } }),
      model('no/tools:free', 2, { supported_parameters: ['temperature'] }),
      model('paid/model', 4, { pricing: { prompt: '0.000003', completion: '0.000015' } }),
      model('zero/priced', 2),
      { id: 'broken' },
    ])).toEqual(['new/vision:free', 'zero/priced', 'old/vision:free'])
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
    expect(agents.map((a) => a.id)).toEqual(['claude-code', 'codex', 'antigravity', 'anthropic-api', 'openai-api', 'gemini-api', 'openrouter', 'local'])
    expect(byId['claude-code']).toMatchObject({ kind: 'subscription', ready: true })
    expect(byId.codex).toMatchObject({ ready: false, detail: expect.stringContaining('Not found') })
    expect(byId['anthropic-api']).toMatchObject({ kind: 'api', ready: false, needsKey: true, hasKey: false, detail: 'Add your API key.' })
    expect(byId['openai-api']).toMatchObject({ ready: true, hasKey: true, model: 'gpt-test' })
    expect(byId.local).toMatchObject({ kind: 'local', ready: false, needsKey: true, keyOptional: true })
    expect(byId['gemini-api']).toMatchObject({ kind: 'free', ready: false, lite: true, keyUrl: expect.stringContaining('aistudio.google.com'), detail: expect.stringContaining('free API key') })
    expect(byId.openrouter).toMatchObject({ kind: 'free', needsKey: true, keyUrl: expect.stringContaining('openrouter.ai') })
  })
})

describe('describeAgents for free keys', () => {
  it('explains the free tier once a key and model are set', async () => {
    const settings = normalizeSettings({ models: { 'gemini-api': 'gemini-flash-latest', openrouter: 'google/gemma-4-31b-it:free' } })
    const agents = await describeAgents({ settings, getKey: (id) => (id === 'gemini-api' || id === 'openrouter' ? 'k' : null), cliPath: () => join(tmpdir(), 'parity-no-such-cli') })
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]))
    expect(byId['gemini-api']).toMatchObject({ ready: true, lite: true, detail: 'gemini-flash-latest · free tier: about 10 requests a minute, so runs are lighter' })
    expect(byId.openrouter).toMatchObject({ ready: true, lite: true, detail: expect.stringContaining('50 requests a day') })
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
      if ((req.url || '').startsWith('/api/v1/models')) res.end(JSON.stringify({ data: [
        { id: 'meta/vision:free', created: 2, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
        { id: 'meta/text:free', created: 3, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'] },
      ] }))
      else if ((req.url || '').startsWith('/v1/models') && req.headers['x-api-key']) res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Opus', created_at: '2026-01-01T00:00:00Z' }, { id: 'claude-haiku-4-5', type: 'model', display_name: 'Haiku', created_at: '2025-01-01T00:00:00Z' }], has_more: false, first_id: 'a', last_id: 'b' }))
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

  it('sends a local or custom server\'s optional key', async () => {
    const settings = normalizeSettings({ localBaseUrl: `${base}/v1` })
    await listModels('local', { settings, getKey: (id) => (id === 'local' ? 'gsk-custom' : null) })
    expect(seen[0].auth).toBe('Bearer gsk-custom')
  })

  it('lists only OpenRouter\'s free models that can run a review, without needing a key', async () => {
    expect(await listModels('openrouter', { settings: DEFAULT_AGENT_SETTINGS, getKey: () => null }, { openrouterBaseURL: `${base}/api/v1` })).toEqual({ models: ['meta/vision:free'], recommended: 'meta/vision:free' })
    expect(seen[0]).toMatchObject({ url: '/api/v1/models', auth: undefined })
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
    expect(await listModels('claude-code', { settings: DEFAULT_AGENT_SETTINGS, getKey: () => null, cliPath: () => '/parity-missing-cli' })).toMatchObject({ models: [], error: expect.stringContaining('App default') })
  })
})
