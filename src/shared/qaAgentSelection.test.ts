import { expect, it } from 'vitest'
import { normalizeSettings } from '../main/qaAgent/agents/registry'
import { agentSelection } from './qaAgentSelection'

it('identifies provider/model switches without restarting for unrelated settings', () => {
  const settings = normalizeSettings({ defaultAgent: 'codex', models: { codex: 'gpt-5.6-sol' } })
  const selection = agentSelection(settings)
  expect(selection.label).toBe('Codex · gpt-5.6-sol')
  expect(agentSelection({ ...settings, evidenceDays: 7 }).signature).toBe(selection.signature)
  expect(agentSelection({ ...settings, models: { ...settings.models, codex: 'other' } }).signature).not.toBe(selection.signature)
  expect(agentSelection({ ...settings, defaultAgent: 'local' }).signature).not.toBe(selection.signature)
  expect(agentSelection({ ...settings, defaultAgent: 'local' }, 'codex').signature).toBe(selection.signature)
})
