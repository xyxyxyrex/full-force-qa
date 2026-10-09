import type { AgentModelList } from '../../../shared/qaAgent'
import { normalizeRemarkStyle } from '../../../shared/remarkStyle'
import { discoverCliModels } from './modelDiscovery'
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_IDS, isAgentId, type AgentEffort, type AgentId, type AgentInfo, type AgentSettings } from '../../../shared/qaAgent'
import { ANTHROPIC_DEFAULT_MODEL, createAnthropicProvider } from './anthropic'
import { antigravitySpec, claudeCodeSpec, codexSpec, createCliProvider, type BridgeAccess } from './cliAgents'
import { detectCli, listAntigravityModels } from './detect'
import { createOpenAiCompatibleProvider } from './openaiCompatible'
import { AgentError, type AgentProvider } from './types'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1'

export const AGENT_LABELS: Record<AgentId, string> = {
  'claude-code': 'Claude Code (your Claude plan)',
  codex: 'Codex (your ChatGPT plan)',
  antigravity: 'Antigravity CLI (your Google plan)',
  'anthropic-api': 'Claude API key',
  'openai-api': 'OpenAI API key',
  'gemini-api': 'Gemini API key (free tier)',
  openrouter: 'OpenRouter (free models)',
  local: 'Local or custom server (Ollama, LM Studio, any OpenAI-compatible API)',
}
const KIND: Record<AgentId, AgentInfo['kind']> = { 'claude-code': 'subscription', codex: 'subscription', antigravity: 'subscription', 'anthropic-api': 'api', 'openai-api': 'api', 'gemini-api': 'free', openrouter: 'free', local: 'local' }
const KEYED: AgentId[] = ['anthropic-api', 'openai-api', 'gemini-api', 'openrouter']
/** Where a free key comes from. */
export const KEY_URLS: Partial<Record<AgentId, string>> = {
  'gemini-api': 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
}

const OPENROUTER_DAILY_HINT = 'OpenRouter allows 50 free requests a day (1,000 a day once the account has bought $10 of credit). They come back the next day; until then, pick another agent in Settings → AI Agents.'
const GEMINI_DAILY_HINT = 'Gemini\'s free requests come back at midnight Pacific time. Until then, pick another model or agent in Settings → AI Agents, or turn on billing for the key\'s Google project.'

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  remarkStyle: normalizeRemarkStyle(null),
  defaultAgent: 'claude-code',
  models: { 'claude-code': '', codex: '', antigravity: '', 'anthropic-api': ANTHROPIC_DEFAULT_MODEL, 'openai-api': '', 'gemini-api': '', openrouter: '', local: '' },
  effort: 'medium',
  localBaseUrl: DEFAULT_LOCAL_URL,
  budgetTokens: 0,
  evidenceUploads: true,
  evidenceDays: 90,
  allowSend: false,
  functionalChecks: true,
  geminiBilling: false,
}

export const EVIDENCE_DAY_OPTIONS = [7, 30, 90, 180, 365]

/** OpenRouter's free models end in ":free"; "openrouter/free" picks one of them. */
export const isFreeOpenRouterModel = (model: string) => /:free$/i.test(model) || model === 'openrouter/free'

/** Whether runs with this agent are kept lighter because its model is on a free tier. */
export function usesFreeTier(id: AgentId, settings: AgentSettings): boolean {
  if (id === 'openrouter') return isFreeOpenRouterModel(settings.models.openrouter)
  if (id === 'gemini-api') return !settings.geminiBilling
  return false
}

/** Reads settings from untrusted storage, falling back to defaults field by field. */
export function normalizeSettings(raw: unknown): AgentSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AgentSettings, unknown>>
  const models = { ...DEFAULT_AGENT_SETTINGS.models }
  if (source.models && typeof source.models === 'object') {
    for (const id of AGENT_IDS) {
      const value = (source.models as Record<string, unknown>)[id]
      if (typeof value === 'string') models[id] = value.trim().slice(0, 120)
    }
  }
  const effort = (['low', 'medium', 'high'] as const).includes(source.effort as AgentEffort) ? (source.effort as AgentEffort) : DEFAULT_AGENT_SETTINGS.effort
  const budget = Number(source.budgetTokens)
  let localBaseUrl = DEFAULT_LOCAL_URL
  if (typeof source.localBaseUrl === 'string') {
    try {
      const url = new URL(source.localBaseUrl.trim())
      if (url.protocol === 'http:' || url.protocol === 'https:') localBaseUrl = url.toString().replace(/\/+$/, '')
    } catch { /* keep the default */ }
  }
  return {
    remarkStyle: normalizeRemarkStyle(source.remarkStyle),
    // Gemini CLI was replaced by Antigravity CLI; a saved choice of it moves over.
    defaultAgent: source.defaultAgent === 'gemini-cli' ? 'antigravity' : isAgentId(source.defaultAgent) ? source.defaultAgent : DEFAULT_AGENT_SETTINGS.defaultAgent,
    models,
    effort,
    localBaseUrl,
    budgetTokens: Number.isFinite(budget) && budget >= 0 ? Math.min(Math.round(budget), 50_000_000) : 0,
    evidenceUploads: source.evidenceUploads === false ? false : true,
    evidenceDays: EVIDENCE_DAY_OPTIONS.includes(Number(source.evidenceDays)) ? Number(source.evidenceDays) : DEFAULT_AGENT_SETTINGS.evidenceDays,
    // Sending is only on when it was turned on; anything else keeps it off.
    allowSend: source.allowSend === true,
    functionalChecks: source.functionalChecks === false ? false : true,
    geminiBilling: source.geminiBilling === true,
  }
}

export interface RegistryDeps {
  settings: AgentSettings
  getKey(id: AgentId): string | null
  getBridge(): BridgeAccess
  /** Where to find each agent CLI, if not on PATH. */
  cliPath?(id: AgentId): string | undefined
}

function freeDetail(id: AgentId, settings: AgentSettings): string {
  const model = settings.models[id]
  if (id === 'openrouter') return isFreeOpenRouterModel(model) ? `${model} · free: 50 requests a day (1,000 with $10 of credit), so runs are lighter` : `${model} · a paid model, billed to your OpenRouter credit`
  return settings.geminiBilling ? `${model} · billing on` : `${model} · free tier: about 10 requests a minute, so runs are lighter`
}

export async function describeAgents(deps: Pick<RegistryDeps, 'settings' | 'getKey' | 'cliPath'>): Promise<AgentInfo[]> {
  const { settings } = deps
  const cliIds = ['claude-code', 'codex', 'antigravity'] as const
  const detections = await Promise.all(cliIds.map((id) => detectCli(id, deps.cliPath?.(id))))
  return AGENT_IDS.map((id): AgentInfo => {
    const takesKey = KEYED.includes(id) || id === 'local'
    const base = {
      id, label: AGENT_LABELS[id], kind: KIND[id], model: settings.models[id],
      needsKey: takesKey, ...(id === 'local' ? { keyOptional: true } : {}), hasKey: takesKey ? !!deps.getKey(id) : false,
      lite: usesFreeTier(id, settings), ...(KEY_URLS[id] ? { keyUrl: KEY_URLS[id] } : {}),
    }
    const cliIndex = (cliIds as readonly string[]).indexOf(id)
    if (cliIndex >= 0) {
      const found = detections[cliIndex]
      return { ...base, ready: found.installed && found.signedIn !== false, detail: found.detail }
    }
    if (id === 'local') return { ...base, ready: !!settings.models.local, detail: settings.models.local ? `${settings.localBaseUrl} · ${settings.models.local}` : 'Choose a model that can read pictures and use tools.' }
    const free = KIND[id] === 'free'
    if (!base.hasKey) return { ...base, ready: false, detail: free ? 'Add your free API key (no card needed), then list the models.' : 'Add your API key.' }
    if (!settings.models[id]) return { ...base, ready: false, detail: free ? 'List the models and choose one.' : 'Choose a model.' }
    return { ...base, ready: true, detail: free ? freeDetail(id, settings) : settings.models[id] }
  })
}

export function createProvider(id: AgentId, deps: RegistryDeps): AgentProvider {
  const { settings } = deps
  const model = settings.models[id]
  switch (id) {
    case 'claude-code': return createCliProvider(claudeCodeSpec, { binary: deps.cliPath?.(id), model: model || undefined, getBridge: deps.getBridge })
    case 'codex': return createCliProvider(codexSpec, { binary: deps.cliPath?.(id), model: model || undefined, getBridge: deps.getBridge })
    case 'antigravity': return createCliProvider(antigravitySpec, { binary: deps.cliPath?.(id), model: model || undefined, getBridge: deps.getBridge })
    case 'anthropic-api': {
      const apiKey = deps.getKey(id)
      if (!apiKey) throw new AgentError('Add your Claude API key in Settings → AI Agents.')
      return createAnthropicProvider({ apiKey, model: model || ANTHROPIC_DEFAULT_MODEL, effort: settings.effort })
    }
    case 'openai-api':
    case 'gemini-api': {
      const apiKey = deps.getKey(id)
      if (!apiKey) throw new AgentError(`Add your ${id === 'openai-api' ? 'OpenAI' : 'Gemini'} API key in Settings → AI Agents.`)
      if (!model) throw new AgentError('Choose a model in Settings → AI Agents.')
      return id === 'openai-api'
        ? createOpenAiCompatibleProvider({ id, label: 'OpenAI', baseUrl: OPENAI_BASE_URL, apiKey, model })
        : createOpenAiCompatibleProvider({ id, label: 'Gemini', baseUrl: GEMINI_BASE_URL, apiKey, model, lite: usesFreeTier(id, settings), dailyLimitHint: GEMINI_DAILY_HINT })
    }
    case 'openrouter': {
      const apiKey = deps.getKey(id)
      if (!apiKey) throw new AgentError('Add your free OpenRouter key in Settings → AI Agents.')
      if (!model) throw new AgentError('Choose an OpenRouter model in Settings → AI Agents (List models shows the free ones).')
      return createOpenAiCompatibleProvider({ id, label: 'OpenRouter', baseUrl: OPENROUTER_BASE_URL, apiKey, model, headers: { 'X-Title': 'Parity' }, lite: usesFreeTier(id, settings), dailyLimitHint: OPENROUTER_DAILY_HINT })
    }
    case 'local':
      if (!model) throw new AgentError('Choose a local model in Settings → AI Agents.')
      return createOpenAiCompatibleProvider({ id, label: 'Local model', baseUrl: settings.localBaseUrl, apiKey: deps.getKey(id) ?? undefined, model })
  }
}

interface OpenRouterModel {
  id?: string
  created?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
}

/** OpenRouter's free models that can read pictures and call tools, which a review needs. Newest first. */
export function pickOpenRouterModels(models: OpenRouterModel[]): string[] {
  const free = (model: OpenRouterModel) => isFreeOpenRouterModel(model.id ?? '') || (model.pricing?.prompt === '0' && model.pricing?.completion === '0')
  return models
    .filter((model) => model.id && free(model) && model.architecture?.input_modalities?.includes('image') && model.supported_parameters?.includes('tools'))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((model) => model.id!)
}

/** Gemini lists embedding, image, speech and video models too; only chat models can run a review. */
const isGeminiChatModel = (name: string) => /gemini|gemma/i.test(name) && !/embedding|imagen|image-generation|tts|audio|live|veo|aqa/i.test(name)

/**
 * A first choice for a free key, so it works without knowing the model names: on Gemini the Flash
 * alias (Flash is what the free tier allows most of; Pro allows little or nothing), on OpenRouter the
 * newest free model that can run a review.
 */
export function recommendedModel(id: AgentId, models: string[]): string | undefined {
  if (id === 'openrouter') return models[0]
  if (id !== 'gemini-api') return undefined
  if (models.includes('gemini-flash-latest')) return 'gemini-flash-latest'
  const flash = models.filter((name) => /^gemini-[\d.]+-flash$/.test(name))
  return flash.sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)))[0] ?? models.find((name) => /flash/.test(name) && !/lite|preview|exp|thinking/.test(name))
}

/** The models an API or local server offers, for the picker. Never throws. */
export async function listModels(id: AgentId, deps: Pick<RegistryDeps, 'settings' | 'getKey' | 'cliPath'>, overrides: { anthropicBaseURL?: string; openrouterBaseURL?: string } = {}): Promise<AgentModelList> {
  const listed = await readModels(id, deps, overrides)
  const recommended = listed.error ? undefined : recommendedModel(id, listed.models)
  return recommended ? { ...listed, recommended } : listed
}

async function readModels(id: AgentId, deps: Pick<RegistryDeps, 'settings' | 'getKey' | 'cliPath'>, overrides: { anthropicBaseURL?: string; openrouterBaseURL?: string }): Promise<AgentModelList> {
  try {
    if (id === 'codex' || id === 'claude-code') return await discoverCliModels(id, { binary: deps.cliPath?.(id) })
    if (id === 'antigravity') return await listAntigravityModels(deps.cliPath?.(id))
    if (id === 'anthropic-api') {
      const apiKey = deps.getKey(id)
      if (!apiKey) return { models: [], error: 'Add your API key first.' }
      const client = new Anthropic({ apiKey, ...(overrides.anthropicBaseURL ? { baseURL: overrides.anthropicBaseURL } : {}) })
      const models: string[] = []
      for await (const model of client.models.list({ limit: 100 })) { models.push(model.id); if (models.length >= 100) break }
      return { models }
    }
    if (id === 'openrouter') {
      // The list is public, and free models come and go every few weeks, so it is always read live.
      const response = await fetch(`${(overrides.openrouterBaseURL ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return { models: [], error: `OpenRouter answered ${response.status}.` }
      const models = pickOpenRouterModels(((await response.json()) as { data?: OpenRouterModel[] }).data ?? [])
      return models.length ? { models } : { models: [], error: 'OpenRouter lists no free model that can read pictures and use tools right now. Try again later, or use a Gemini key.' }
    }
    if (id === 'openai-api' || id === 'gemini-api' || id === 'local') {
      const base = id === 'openai-api' ? OPENAI_BASE_URL : id === 'gemini-api' ? GEMINI_BASE_URL : deps.settings.localBaseUrl
      const key = deps.getKey(id)
      if (id !== 'local' && !key) return { models: [], error: 'Add your API key first.' }
      const response = await fetch(`${base.replace(/\/+$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return { models: [], error: response.status === 401 || response.status === 403 ? 'The key was rejected.' : `The server answered ${response.status}.` }
      const body = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
      const names = (body.data ?? []).map((m) => m.id).filter((n): n is string => !!n)
      const fromGemini = (body.models ?? []).map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean)
      const all = [...new Set([...names, ...fromGemini])].sort()
      return { models: id === 'gemini-api' ? [...new Set(all.map((name) => name.replace(/^models\//, '')))].filter(isGeminiChatModel) : all }
    }
    return { models: [] }
  } catch (error: any) {
    if (error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message || '')) return { models: [], error: id === 'local' ? `Could not reach ${deps.settings.localBaseUrl}. Is the server running?` : 'Could not reach the server.' }
    return { models: [], error: error?.message || 'Could not load the model list.' }
  }
}
