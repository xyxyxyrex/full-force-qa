import Anthropic from '@anthropic-ai/sdk'
import { AGENT_IDS, isAgentId, type AgentEffort, type AgentId, type AgentInfo, type AgentSettings } from '../../../shared/qaAgent'
import { ANTHROPIC_DEFAULT_MODEL, createAnthropicProvider } from './anthropic'
import { claudeCodeSpec, codexSpec, createCliProvider, geminiCliSpec, type BridgeAccess } from './cliAgents'
import { detectCli } from './detect'
import { createOpenAiCompatibleProvider } from './openaiCompatible'
import { AgentError, type AgentProvider } from './types'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1'

export const AGENT_LABELS: Record<AgentId, string> = {
  'claude-code': 'Claude Code (your Claude plan)',
  codex: 'Codex (your ChatGPT plan)',
  'gemini-cli': 'Gemini CLI (your Gemini plan)',
  'anthropic-api': 'Claude API key',
  'openai-api': 'OpenAI API key',
  'gemini-api': 'Gemini API key',
  local: 'Local model (Ollama, LM Studio)',
}
const KIND: Record<AgentId, AgentInfo['kind']> = { 'claude-code': 'subscription', codex: 'subscription', 'gemini-cli': 'subscription', 'anthropic-api': 'api', 'openai-api': 'api', 'gemini-api': 'api', local: 'local' }
const KEYED: AgentId[] = ['anthropic-api', 'openai-api', 'gemini-api']

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  defaultAgent: 'claude-code',
  models: { 'claude-code': '', codex: '', 'gemini-cli': '', 'anthropic-api': ANTHROPIC_DEFAULT_MODEL, 'openai-api': '', 'gemini-api': '', local: '' },
  effort: 'medium',
  localBaseUrl: DEFAULT_LOCAL_URL,
  budgetTokens: 0,
  evidenceUploads: true,
  evidenceDays: 90,
}

export const EVIDENCE_DAY_OPTIONS = [7, 30, 90, 180, 365]

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
    defaultAgent: isAgentId(source.defaultAgent) ? source.defaultAgent : DEFAULT_AGENT_SETTINGS.defaultAgent,
    models,
    effort,
    localBaseUrl,
    budgetTokens: Number.isFinite(budget) && budget >= 0 ? Math.min(Math.round(budget), 50_000_000) : 0,
    evidenceUploads: source.evidenceUploads === false ? false : true,
    evidenceDays: EVIDENCE_DAY_OPTIONS.includes(Number(source.evidenceDays)) ? Number(source.evidenceDays) : DEFAULT_AGENT_SETTINGS.evidenceDays,
  }
}

export interface RegistryDeps {
  settings: AgentSettings
  getKey(id: AgentId): string | null
  getBridge(): BridgeAccess
  /** Where to find each agent CLI, if not on PATH. */
  cliPath?(id: AgentId): string | undefined
}

export async function describeAgents(deps: Pick<RegistryDeps, 'settings' | 'getKey' | 'cliPath'>): Promise<AgentInfo[]> {
  const { settings } = deps
  const cliIds = ['claude-code', 'codex', 'gemini-cli'] as const
  const detections = await Promise.all(cliIds.map((id) => detectCli(id, deps.cliPath?.(id))))
  return AGENT_IDS.map((id): AgentInfo => {
    const base = { id, label: AGENT_LABELS[id], kind: KIND[id], model: settings.models[id], needsKey: KEYED.includes(id), hasKey: KEYED.includes(id) ? !!deps.getKey(id) : false }
    const cliIndex = (cliIds as readonly string[]).indexOf(id)
    if (cliIndex >= 0) {
      const found = detections[cliIndex]
      return { ...base, ready: found.installed && found.signedIn !== false, detail: found.detail }
    }
    if (id === 'local') return { ...base, ready: !!settings.models.local, detail: settings.models.local ? `${settings.localBaseUrl} · ${settings.models.local}` : 'Choose a model that can read pictures and use tools.' }
    if (!base.hasKey) return { ...base, ready: false, detail: 'Add your API key.' }
    return { ...base, ready: !!settings.models[id], detail: settings.models[id] ? settings.models[id] : 'Choose a model.' }
  })
}

export function createProvider(id: AgentId, deps: RegistryDeps): AgentProvider {
  const { settings } = deps
  const model = settings.models[id]
  switch (id) {
    case 'claude-code': return createCliProvider(claudeCodeSpec, { binary: deps.cliPath?.(id), model: model || undefined, getBridge: deps.getBridge })
    case 'codex': return createCliProvider(codexSpec, { binary: deps.cliPath?.(id), model: model || undefined, getBridge: deps.getBridge })
    case 'gemini-cli': return createCliProvider(geminiCliSpec, { binary: deps.cliPath?.(id), model: model || undefined, getBridge: deps.getBridge })
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
      return createOpenAiCompatibleProvider({ id, label: id === 'openai-api' ? 'OpenAI' : 'Gemini', baseUrl: id === 'openai-api' ? OPENAI_BASE_URL : GEMINI_BASE_URL, apiKey, model })
    }
    case 'local':
      if (!model) throw new AgentError('Choose a local model in Settings → AI Agents.')
      return createOpenAiCompatibleProvider({ id, label: 'Local model', baseUrl: settings.localBaseUrl, model })
  }
}

/** The models an API or local server offers, for the picker. Never throws. */
export async function listModels(id: AgentId, deps: Pick<RegistryDeps, 'settings' | 'getKey'>, overrides: { anthropicBaseURL?: string } = {}): Promise<{ models: string[]; error?: string }> {
  try {
    if (id === 'anthropic-api') {
      const apiKey = deps.getKey(id)
      if (!apiKey) return { models: [], error: 'Add your API key first.' }
      const client = new Anthropic({ apiKey, ...(overrides.anthropicBaseURL ? { baseURL: overrides.anthropicBaseURL } : {}) })
      const models: string[] = []
      for await (const model of client.models.list({ limit: 100 })) { models.push(model.id); if (models.length >= 100) break }
      return { models }
    }
    if (id === 'openai-api' || id === 'gemini-api' || id === 'local') {
      const base = id === 'openai-api' ? OPENAI_BASE_URL : id === 'gemini-api' ? GEMINI_BASE_URL : deps.settings.localBaseUrl
      const key = id === 'local' ? null : deps.getKey(id)
      if (id !== 'local' && !key) return { models: [], error: 'Add your API key first.' }
      const response = await fetch(`${base.replace(/\/+$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return { models: [], error: response.status === 401 || response.status === 403 ? 'The key was rejected.' : `The server answered ${response.status}.` }
      const body = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
      const names = (body.data ?? []).map((m) => m.id).filter((n): n is string => !!n)
      const fromGemini = (body.models ?? []).map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean)
      return { models: [...new Set([...names, ...fromGemini])].sort() }
    }
    return { models: [] }
  } catch (error: any) {
    if (error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message || '')) return { models: [], error: id === 'local' ? `Could not reach ${deps.settings.localBaseUrl}. Is the server running?` : 'Could not reach the server.' }
    return { models: [], error: error?.message || 'Could not load the model list.' }
  }
}
