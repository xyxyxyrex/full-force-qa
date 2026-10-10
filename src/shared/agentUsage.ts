import type { AgentId } from './qaAgent'

export interface QuotaWindow {
  label: string
  usedPercent?: number
  remaining?: number
  limit?: number
  unit?: 'requests' | 'tokens' | 'USD'
  resetsAt?: number
  status?: 'allowed' | 'allowed_warning' | 'rejected'
}
export interface AgentQuota {
  agent: AgentId
  model?: string
  source: 'live' | 'observed' | 'unavailable'
  checkedAt: number
  windows: QuotaWindow[]
  note: string
  error?: boolean
  cached?: boolean
  link?: { label: string; url: string }
}
const escaped = (value: string) => value.replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/[\r\n]/g, ' ')
export function formatQuota(quota: AgentQuota): string {
  const lines = [`### ${escaped(quota.agent)} quota`, quota.model ? `Model: **${escaped(quota.model)}**` : '']
  if (quota.source !== 'unavailable') lines.push(`${quota.cached ? 'Cached check' : quota.source === 'observed' ? 'Last observed during a request' : 'Checked'}: ${new Date(quota.checkedAt).toLocaleString()}`)
  for (const window of quota.windows) {
    const values = [
      window.usedPercent !== undefined ? `${window.usedPercent}% used · ${Math.round(Math.max(0, 100 - window.usedPercent) * 100) / 100}% remaining` : '',
      window.remaining !== undefined ? `${window.unit === 'USD' ? '$' : ''}${window.remaining.toLocaleString()} remaining${window.unit && window.unit !== 'USD' ? ` ${window.unit}` : ''}${window.limit !== undefined ? ` of ${window.unit === 'USD' ? '$' : ''}${window.limit.toLocaleString()}` : ''}` : '',
      window.status ? window.status === 'rejected' ? 'Limit reached' : window.status === 'allowed_warning' ? 'Approaching limit' : 'Requests allowed' : '',
      window.resetsAt ? `resets ${new Date(window.resetsAt).toLocaleString()}` : '',
    ].filter(Boolean)
    lines.push(`- **${escaped(window.label)}:** ${values.join(' · ') || 'Remaining allowance not reported'}`)
  }
  lines.push(quota.note)
  if (quota.link) lines.push(`[${escaped(quota.link.label)}](${quota.link.url})`)
  lines.push(`Times use ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Use \`/quota --refresh\` to check again. Checking does not use model tokens.`)
  return lines.filter(Boolean).join('\n\n')
}
export function formatChatUsage(input: {
  session: { input: number; output: number; requests: number }
  turn: { input: number; output: number; requests: number }
  context: number
  usageReported: boolean
  budgetTokens: number
  executionTokens?: number
}): string {
  if (!input.usageReported) return '### Parity usage\n\nNo token usage has been reported in this chat yet. Some CLI versions do not report usage. This does not mean zero usage.\n\nUse `/quota` for provider allowance.'
  const count = (n: number) => n.toLocaleString()
  return `### Parity usage\n\nThis chat, across providers and retries:\n\n- **Total:** ${count(input.session.input + input.session.output)} tokens\n- **Input:** ${count(input.session.input)} · **Output:** ${count(input.session.output)}\n- **Usage reports:** ${count(input.session.requests)}\n- **Current/last request:** ${count(input.turn.input + input.turn.output)} tokens\n- **Latest input context:** ${count(input.context)} tokens${input.budgetTokens ? `\n- **Execution budget:** ${count(input.budgetTokens)} tokens${input.executionTokens !== undefined ? ` · ${count(input.executionTokens)} used` : ''}` : ''}\n\nReported usage only; activity outside Parity and unreported usage are not included. Tokens are not a subscription quota or a billing estimate. Use \`/quota\` for provider allowance.`
}
