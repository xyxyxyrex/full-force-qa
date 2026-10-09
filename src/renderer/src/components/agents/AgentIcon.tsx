import type { AgentId } from '../../../../shared/qaAgent'
import claude from '../../assets/agent-icons/claude.svg'
import claudecode from '../../assets/agent-icons/claudecode.svg'
import openai from '../../assets/agent-icons/openai.svg'
import gemini from '../../assets/agent-icons/gemini.svg'
import antigravity from '../../assets/agent-icons/antigravity.svg'
import openrouter from '../../assets/agent-icons/openrouter.svg'
import deepseek from '../../assets/agent-icons/deepseek.svg'
import qwen from '../../assets/agent-icons/qwen.svg'
import meta from '../../assets/agent-icons/meta.svg'
import mistral from '../../assets/agent-icons/mistral.svg'

export const AGENT_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  'anthropic-api': 'Claude API', 'openai-api': 'OpenAI API', 'gemini-api': 'Gemini',
  openrouter: 'OpenRouter', local: 'Custom server',
}
const providerMarks: Partial<Record<AgentId, string>> = { 'claude-code': claudecode, codex: openai, antigravity, 'anthropic-api': claude, 'openai-api': openai, 'gemini-api': gemini, openrouter }
const families: Array<[RegExp, string]> = [[/claude|sonnet|opus|haiku/i, claude], [/gemini|gemma|^google\//i, gemini], [/^openai\/|^gpt-|^o\d/i, openai], [/deepseek/i, deepseek], [/qwen/i, qwen], [/llama|^meta[/-]/i, meta], [/mistral|ministral|codestral|pixtral/i, mistral]]
export default function AgentIcon({ id, model }: { id: AgentId; model?: string }) {
  const mark = (model && families.find(([pattern]) => pattern.test(model))?.[1]) || providerMarks[id]
  return mark ? <span className="agents-icon" aria-hidden="true" style={{ maskImage: `url(${JSON.stringify(mark)})`, WebkitMaskImage: `url(${JSON.stringify(mark)})` }} />
    : <svg className="agents-icon-server" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" strokeLinecap="round"/></svg>
}
