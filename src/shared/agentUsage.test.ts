import { describe, expect, it } from 'vitest'
import { formatChatUsage, formatQuota } from './agentUsage'
describe('usage and quota display', () => {
  it('reports local totals without treating unknown usage as zero or subscription credit', () => {
    const input = { session: { input: 120, output: 30, requests: 2 }, turn: { input: 100, output: 20, requests: 1 }, context: 100, budgetTokens: 1000, executionTokens: 150, usageReported: true }
    expect(formatChatUsage(input)).toContain('150 tokens')
    expect(formatChatUsage(input)).toContain('across providers and retries')
    expect(formatChatUsage(input)).toContain('not a subscription quota')
    expect(formatChatUsage({ ...input, usageReported: false })).toContain('does not mean zero')
  })
  it('escapes names and retains zero headroom and observed source labels', () => {
    const output = formatQuota({ agent: 'codex', model: '[malicious](https://other.test)', checkedAt: 1, source: 'observed', windows: [{ label: '**window**', usedPercent: 100, remaining: 0, limit: 10, unit: 'requests' }], note: 'Observed' })
    expect(output).toContain('0% remaining')
    expect(output).toContain('0 remaining requests of 10')
    expect(output).toContain('Last observed')
    expect(output).toContain('\\[malicious\\]')
  })
})
