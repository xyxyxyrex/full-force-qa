import { useState } from 'react'
import type { AgentId, AgentInfo, AgentSettings, AgentsOverview } from '../../../../shared/qaAgent'
import AgentIcon, { AGENT_NAMES } from './AgentIcon'
import AgentModelPicker from './AgentModelPicker'
import { EMPTY_MODELS, type ModelDiscoveryState } from './useModelDiscovery'

type Patch = Parameters<typeof window.electronAPI.qaAgentsSaveSettings>[0]
const NOTES: Record<AgentInfo['kind'], string> = {
  subscription: 'Uses your signed-in app. Your existing plan covers the review.',
  api: 'Uses your API key. Usage is billed by the provider.',
  free: 'Free keys support lighter reviews within provider limits. No AI plan or card needed.',
  local: 'Connect Ollama, LM Studio, or an OpenAI-compatible server. Choose a model that reads images and uses tools.',
}
export default function AgentConfiguration({ agent, settings, active, discovery, load, invalidate, mutate }: {
  agent: AgentInfo; settings: AgentSettings; active: boolean; discovery?: ModelDiscoveryState
  load: (id: AgentId) => void; invalidate: (id: AgentId) => void
  mutate: (work: () => Promise<AgentsOverview | null>) => Promise<void>
}) {
  const [keyDraft, setKeyDraft] = useState('')
  const [server, setServer] = useState(settings.localBaseUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const guard = async (work: () => Promise<void>): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setError(''); setFeedback('')
    try { await work(); setFeedback('Saved'); return true }
    catch (cause) { setError((cause instanceof Error ? cause.message : 'Could not save. Try again.').replace(/^Error invoking remote method '[^']+': Error:\s*/, '')); return false }
    finally { setBusy(false) }
  }
  const save = (patch: Patch) => guard(() => mutate(() => window.electronAPI.qaAgentsSaveSettings(patch)))
  return <div className="agents-config" hidden={!active} aria-label={`${AGENT_NAMES[agent.id]} settings`}>
    <header className="agents-config-heading"><AgentIcon id={agent.id}/><div><h4>{AGENT_NAMES[agent.id]}</h4><span className="agents-muted">{agent.kind === 'subscription' ? 'Signed-in app' : agent.kind === 'local' ? 'Your endpoint' : 'API connection'}</span></div>{agent.lite && <span className="agents-badge">Free tier</span>}</header>
    <p className="agents-detail">{agent.detail}</p><p className="agents-muted">{NOTES[agent.kind]}</p>
    <div className="agents-default-row"><button type="button" className="agents-button" disabled={busy || settings.defaultAgent === agent.id} onClick={() => void save({ defaultAgent: agent.id })}>{settings.defaultAgent === agent.id ? 'Default agent' : 'Use as default'}</button><span className="agents-muted" role="status">{busy ? 'Saving…' : feedback}</span></div>
    {error && <p className="agents-alert" role="alert">{error}</p>}
    {agent.needsKey && <div className="agents-credentials">
      <span className="agents-field-label">API key{agent.keyOptional ? ' · optional' : ''}</span>
      {agent.hasKey ? <div className="agents-row"><span className="agents-muted">API key saved</span><button className="agents-link" disabled={busy} onClick={() => void guard(async () => { invalidate(agent.id); await mutate(() => window.electronAPI.qaAgentsClearKey(agent.id)); invalidate(agent.id) })}>Remove</button></div>
        : <div className="agents-row"><input type="password" aria-label={`${AGENT_NAMES[agent.id]} API key`} autoComplete="off" spellCheck={false} placeholder={agent.keyOptional ? 'Only if the server needs one' : 'Paste your API key'} value={keyDraft} onChange={event => setKeyDraft(event.target.value)}/><button className="agents-button" disabled={busy || !keyDraft.trim()} onClick={() => void guard(async () => {
          invalidate(agent.id)
          await mutate(async () => { const next = await window.electronAPI.qaAgentsSetKey(agent.id, keyDraft); if (next && 'error' in next) throw new Error(next.error); return next })
          setKeyDraft(''); invalidate(agent.id)
        })}>Save key</button></div>}
      {agent.keyUrl && <button className="agents-link agents-key-help" onClick={() => void window.electronAPI.openExternal(agent.keyUrl!)}>Get a free key ↗</button>}
    </div>}
    {agent.id === 'local' && <div className="agents-row"><label className="agents-field grow"><span>Server address</span><input type="text" value={server} spellCheck={false} onChange={event => setServer(event.target.value)}/></label><button className="agents-button" disabled={busy || !server.trim() || server.trim() === settings.localBaseUrl} onClick={() => void guard(async () => { invalidate(agent.id); await mutate(() => window.electronAPI.qaAgentsSaveSettings({ localBaseUrl: server.trim() })); invalidate(agent.id) })}>Save address</button></div>}
    <AgentModelPicker agent={agent} value={settings.models[agent.id]} state={discovery || EMPTY_MODELS} active={active} disabled={busy} load={() => load(agent.id)} save={async model => { return save({ models: { [agent.id]: model } }) }}/>
    {agent.id === 'openrouter' && <p className="agents-muted">Lists free models that support images and tools.</p>}
    {agent.id === 'gemini-api' && <label className="agents-switch"><input type="checkbox" disabled={busy} checked={settings.geminiBilling} onChange={event => void save({ geminiBilling: event.target.checked })}/><span>Billing is enabled for this Google project</span></label>}
  </div>
}
