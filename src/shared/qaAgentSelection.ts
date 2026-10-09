import type { AgentId, AgentSettings } from './qaAgent'

const NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  'anthropic-api': 'Claude', 'openai-api': 'OpenAI', 'gemini-api': 'Gemini',
  openrouter: 'OpenRouter', local: 'Custom server',
}

/** No discovery or provider process is needed to display the saved selection. */
export function agentSelection(settings: AgentSettings, agent = settings.defaultAgent) {
  const model = settings.models[agent]
  return {
    agent, model, label: `${NAMES[agent]}${model ? ` · ${model}` : ' · App default'}`,
    signature: JSON.stringify([agent, model, agent === 'local' ? settings.localBaseUrl : '',
      agent === 'anthropic-api' ? settings.effort : '', agent === 'gemini-api' ? settings.geminiBilling : false]),
  }
}
