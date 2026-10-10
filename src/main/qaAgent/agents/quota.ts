import { createHash } from 'crypto'
import type { AgentId, AgentSettings } from '../../../shared/qaAgent'
import type { AgentQuota, QuotaWindow } from '../../../shared/agentUsage'
import { readOnlyCli } from './readOnlyCli'

const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const label = (value: unknown, fallback: string) => typeof value === 'string' && value ? value.replace(/[\x00-\x1f]/g, ' ').slice(0, 90) : fallback
const reset = (value: unknown) => { const n = numeric(value); return n !== undefined && n > 0 ? n * 1000 : undefined }
const snapshot = (agent: AgentId, windows: QuotaWindow[], source: AgentQuota['source'], note: string, now = Date.now()): AgentQuota => ({ agent, windows, source, note, checkedAt: now })

export function parseCodexQuota(input: unknown, now = Date.now()): AgentQuota {
  const result = record(input), buckets = record(result.rateLimitsByLimitId)
  const entries = Object.keys(buckets).length ? Object.entries(buckets) : result.rateLimits ? [['codex', result.rateLimits]] : []
  const windows: QuotaWindow[] = []
  for (const [id, raw] of entries.slice(0, 30)) {
    const bucket = record(raw)
    for (const key of ['primary', 'secondary']) {
      const window = record(bucket[key]), used = numeric(window.usedPercent), minutes = numeric(window.windowDurationMins)
      if (used === undefined || used > 100) continue
      const duration = minutes === undefined ? key : minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`
      windows.push({ label: `${label(bucket.limitName, label(id, 'Codex'))} · ${duration} window`, usedPercent: used, resetsAt: reset(window.resetsAt) })
    }
  }
  return snapshot('codex', windows, windows.length ? 'live' : 'unavailable', windows.length ? 'Account allowance reported by Codex. These windows can include activity outside Parity.' : 'Codex did not report an allowance. Sign in with a ChatGPT account; API-key-only sessions may not expose subscription quota.', now)
}

export async function readCodexQuota(options: { binary?: string; prefixArgs?: string[]; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AgentQuota> {
  let initialized = false
  const text = await readOnlyCli({ binary: options.binary || 'codex', args: [...(options.prefixArgs || []), 'app-server'], timeoutMs: options.timeoutMs, signal: options.signal,
    start: send => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'parity_quota', title: 'Parity', version: '1.0.0' } } }),
    line: (line, send) => {
      let message: any; try { message = JSON.parse(line) } catch { return }
      if (!message || ![1, 2].includes(message.id)) return
      if (message.error || !message.result) throw new Error('Quota protocol rejected')
      if (message.id === 1 && !initialized) {
        initialized = true; send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/rateLimits/read' })
      } else if (message.id === 2 && initialized) return JSON.stringify(message.result)
    },
  })
  return parseCodexQuota(JSON.parse(text))
}

export function parseClaudeQuota(value: unknown, now = Date.now()): AgentQuota | null {
  const info = record(value)
  const status = ['allowed', 'allowed_warning', 'rejected'].includes(info.status) ? info.status as QuotaWindow['status'] : undefined
  if (!status) return null
  const utilization = numeric(info.utilization)
  const windows: QuotaWindow[] = [{ label: label(info.rateLimitType, 'Subscription limit'), status,
    ...(utilization !== undefined && utilization <= 1 ? { usedPercent: Math.round(utilization * 10000) / 100 } : {}), resetsAt: reset(info.resetsAt) }]
  return snapshot('claude-code', windows, 'observed', 'Last subscription status reported by Claude Code. Headless versions may omit remaining percentages. For a fresh account view, run /usage in an interactive Claude Code session.', now)
}

/** Only parse explicitly labelled remaining values; never guess what an unlabeled percentage means. */
export function parseAntigravityQuota(text: string, now = Date.now()): AgentQuota {
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const windows: QuotaWindow[] = []
  const remainingHeader = /model[^\n]*(?:remaining|left)/i.test(plain)
  for (const line of plain.split(/\r?\n/)) {
    const model = /\b((?:gemini|claude|gpt)[a-z0-9 ._()/-]{0,70}?)(?=\s{2,}|[│|:]|\s+(?:remaining|left)\b)/i.exec(line)?.[1]?.trim()
    if (!model) continue
    const percentage = /(?:remaining|left)\s*:?\s*(\d+(?:\.\d+)?)%/i.exec(line) || (remainingHeader ? /(\d+(?:\.\d+)?)%/.exec(line) : null)
    if (!percentage || Number(percentage[1]) > 100) continue
    const date = /\b\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})\b/.exec(line)?.[0]
    const parsedDate = date ? Date.parse(date) : NaN
    windows.push({ label: model, usedPercent: Math.round((100 - Number(percentage[1])) * 100) / 100, ...(Number.isFinite(parsedDate) ? { resetsAt: parsedDate } : {}) })
  }
  return snapshot('antigravity', windows.slice(0, 50), windows.length ? 'live' : 'unavailable', windows.length ? 'Model allowance reported by Antigravity CLI; includes usage outside Parity.' : 'This CLI version did not return a readable quota report. Run /usage or /quota in an interactive agy session, or update the CLI.', now)
}

export function parseOpenRouterQuota(input: unknown, now = Date.now()): AgentQuota {
  const data = record(record(input).data), windows: QuotaWindow[] = []
  const remaining = numeric(data.limit_remaining), limit = numeric(data.limit)
  if (remaining !== undefined) windows.push({ label: 'API key spending allowance', remaining, limit, unit: 'USD' })
  const daily = record(data.free_model_daily_requests)
  if (numeric(daily.remaining) !== undefined) windows.push({ label: 'Free model daily allowance', remaining: daily.remaining, limit: numeric(daily.limit), unit: 'requests' })
  return snapshot('openrouter', windows, windows.length ? 'live' : 'unavailable', windows.length ? 'Allowance for this API key; not the total account credit balance. Provider-specific limits can also apply.' : 'OpenRouter did not report a bounded allowance for this key. An unset spending limit is not unlimited account credit.', now)
}

export function quotaFromHeaders(agent: AgentId, model: string, headers: Headers, now = Date.now()): AgentQuota | null {
  if (!['openai-api', 'anthropic-api', 'local', 'openrouter'].includes(agent)) return null
  const windows: QuotaWindow[] = []
  const prefix = agent === 'anthropic-api' ? 'anthropic-ratelimit-' : 'x-ratelimit-'
  const resetTime = (raw: string | null) => {
    if (!raw) return undefined
    if (/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(raw)) {
      let ms = 0
      for (const match of raw.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(match[1]) * ({ ms: 1, h: 3600000, m: 60000, s: 1000 }[match[2]] || 0)
      return now + ms
    }
    const date = Date.parse(raw); return Number.isFinite(date) ? date : undefined
  }
  for (const unit of ['requests', 'tokens', 'input-tokens', 'output-tokens'] as const) {
    const field = (name: string) => agent === 'anthropic-api' ? `${prefix}${unit}-${name}` : `${prefix}${name}-${unit}`
    const raw = headers.get(field('remaining'))
    if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw) || numeric(Number(raw)) === undefined) continue
    const limitRaw = headers.get(field('limit'))
    windows.push({ label: `${unit.replace(/-/g, ' ')} rate limit`, remaining: Number(raw), ...(limitRaw && /^\d+(?:\.\d+)?$/.test(limitRaw) && numeric(Number(limitRaw)) !== undefined ? { limit: Number(limitRaw) } : {}), unit: unit === 'requests' ? 'requests' : 'tokens', resetsAt: resetTime(headers.get(field('reset'))) })
  }
  return windows.length ? { ...snapshot(agent, windows, 'observed', 'Rate-limit headroom from the latest API response. This is not a monthly budget or total subscription allowance.', now), model } : null
}

const links: Partial<Record<AgentId, AgentQuota['link']>> = {
  'claude-code': { label: 'Claude usage settings', url: 'https://claude.ai/settings/usage' },
  antigravity: { label: 'Antigravity quota help', url: 'https://antigravity.google/docs/cli/commands/usage' },
  'gemini-api': { label: 'View Gemini limits in AI Studio', url: 'https://aistudio.google.com/usage' },
  'openai-api': { label: 'OpenAI usage dashboard', url: 'https://platform.openai.com/usage' },
  'anthropic-api': { label: 'Claude API usage dashboard', url: 'https://platform.claude.com/usage' },
  openrouter: { label: 'OpenRouter activity', url: 'https://openrouter.ai/activity' },
}
const fallback: Record<AgentId, string> = {
  codex: 'Sign in with a ChatGPT account using codex login, update the CLI, and retry.',
  'claude-code': 'Claude Code has no documented zero-prompt quota query in headless mode. Run /usage in an interactive Claude Code session. Parity shows subscription notices when the CLI reports them during actual work.',
  antigravity: 'Run /usage in an interactive agy session to check your model allowance.',
  'gemini-api': 'Gemini API does not expose remaining project quota through the chat endpoint. Check AI Studio; usage outside Parity also counts against project limits.',
  'openai-api': 'Remaining rate-limit headroom appears here after an API response reports it. Check the provider dashboard for spending and account limits.',
  'anthropic-api': 'Remaining rate-limit headroom appears here after an API response reports it. Check the provider dashboard for spending and account limits.',
  openrouter: 'Add an OpenRouter key in Settings, then retry. Key allowance and account credits are different.',
  local: 'This server does not report quota headroom. Any limits are controlled by your server; Parity does not assume it is unlimited.',
}

export const quotaScope = (owner: string, agent: AgentId, settings: AgentSettings, key?: string | null) => createHash('sha256').update(JSON.stringify([owner, agent, settings.models[agent], agent === 'local' ? settings.localBaseUrl : '', key || ''])).digest('hex')

export function createQuotaService(deps: { codex?: typeof readCodexQuota; cli?: typeof readOnlyCli; fetch?: typeof fetch; now?: () => number } = {}) {
  const cache = new Map<string, AgentQuota>(), observed = new Map<string, AgentQuota>()
  const pending = new Map<string, { promise: Promise<AgentQuota>; controller: AbortController }>()
  const now = deps.now || Date.now
  const bound = (map: Map<string, AgentQuota>) => { while (map.size > 100) map.delete(map.keys().next().value!) }
  return {
    observe(scope: string, value: AgentQuota) { observed.set(scope, structuredClone(value)); cache.delete(scope); bound(observed) },
    cancel() { const active = pending.size > 0; pending.forEach(value => value.controller.abort()); return active },
    clear() { pending.forEach(value => value.controller.abort()); pending.clear(); cache.clear(); observed.clear() },
    async read(scope: string, agent: AgentId, model: string, key?: string | null, refresh = false): Promise<AgentQuota> {
      const stored = cache.get(scope)
      if (!refresh && stored && now() - stored.checkedAt < 30_000 && stored.windows.every(window => !window.resetsAt || window.resetsAt > now())) return { ...structuredClone(stored), cached: true }
      if (pending.has(scope)) return pending.get(scope)!.promise
      const controller = new AbortController()
      const promise = (async () => {
        let value: AgentQuota
        try {
          if (agent === 'codex') value = await (deps.codex || readCodexQuota)({ signal: controller.signal })
          else if (agent === 'antigravity') value = parseAntigravityQuota(await (deps.cli || readOnlyCli)({ binary: 'agy', args: ['-p', '/usage'], signal: controller.signal }), now())
          else if (agent === 'openrouter' && key) {
            const response = await (deps.fetch || fetch)('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) })
            if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'OpenRouter rejected the key. Update it in Settings and retry.' : 'OpenRouter could not report quota. Retry shortly.')
            value = parseOpenRouterQuota(await response.json(), now())
          } else {
            const latest = observed.get(scope)
            const windows = latest && now() - latest.checkedAt < 300_000 ? latest.windows.filter(w => !w.resetsAt || w.resetsAt > now()) : []
            value = windows.length && latest ? { ...structuredClone(latest), windows } : snapshot(agent, [], 'unavailable', fallback[agent], now())
          }
        } catch (error) {
          value = { ...snapshot(agent, [], 'unavailable', `${error instanceof Error && /^(The CLI|The quota|Could not read quota|OpenRouter)/.test(error.message) ? error.message : 'Could not check quota. Check your connection and retry.'} ${fallback[agent]}`, now()), error: true }
        }
        value = { ...value, model, ...(links[agent] ? { link: links[agent] } : {}) }
        if (controller.signal.aborted) throw new Error('The quota check was cancelled.')
        cache.set(scope, value); bound(cache)
        return structuredClone(value)
      })()
      pending.set(scope, { promise, controller })
      try { return await promise } finally { if (pending.get(scope)?.promise === promise) pending.delete(scope) }
    },
  }
}
