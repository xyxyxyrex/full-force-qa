import { useCallback, useEffect, useState } from 'react'
import type { AgentId, AgentInfo, AgentsOverview, QaBridgeStatus } from '../../../shared/qaAgent'
import type { TrackerFormat } from '../../../shared/trackerFormat'
import './AgentsPanel.css'

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : 'Something went wrong.').replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

const KIND_NOTE: Record<AgentInfo['kind'], string> = {
  subscription: 'Uses the app you are already signed in to, so your plan pays for it.',
  api: 'Uses your own API key and is billed by the provider.',
  local: 'Runs on a model on this computer. It must read pictures and use tools.',
}

type CliStatus = { installed: boolean; path: string; onPath: boolean; platform: string }

export default function AgentsPanel() {
  const [overview, setOverview] = useState<AgentsOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [keyDrafts, setKeyDrafts] = useState<Partial<Record<AgentId, string>>>({})
  const [models, setModels] = useState<Partial<Record<AgentId, { list: string[]; error?: string }>>>({})
  const [bridge, setBridge] = useState<QaBridgeStatus | null>(null)
  const [tracker, setTracker] = useState<TrackerFormat | null>(null)
  const [trackerText, setTrackerText] = useState('')
  const [trackerError, setTrackerError] = useState('')
  const [cli, setCli] = useState<CliStatus | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [copied, setCopied] = useState('')

  const refresh = useCallback(async () => {
    setBusy('refresh')
    try { setOverview(await window.electronAPI.qaAgentsOverview()) } catch (cause) { setError(cleanError(cause)) } finally { setBusy('') }
  }, [])

  useEffect(() => {
    void refresh()
    void window.electronAPI.qaBridgeStatus().then(setBridge)
    void window.electronAPI.qaTrackerFormatGet().then(setTracker)
    void window.electronAPI.qaCliStatus().then(setCli)
    void window.electronAPI.accountStatus().then((status) => setSignedIn(status.signedIn)).catch(() => setSignedIn(null))
    return window.electronAPI.onQaBridgeStatus(setBridge)
  }, [refresh])

  const guard = async (name: string, work: () => Promise<void>) => {
    setBusy(name); setError('')
    try { await work() } catch (cause) { setError(cleanError(cause)) } finally { setBusy('') }
  }
  const save = (patch: Parameters<typeof window.electronAPI.qaAgentsSaveSettings>[0]) => guard('save', async () => { const next = await window.electronAPI.qaAgentsSaveSettings(patch); if (next) setOverview(next) })
  const copy = (label: string, text: string) => { void navigator.clipboard.writeText(text).then(() => { setCopied(label); window.setTimeout(() => setCopied(''), 1500) }) }

  if (!overview) return <section className="agents-panel"><p className="agents-muted">{error || 'Loading…'}</p></section>
  const { settings, agents, keyStorage } = overview

  return (
    <section className="agents-panel">
      <header className="agents-header">
        <div>
          <h3>AI agents</h3>
          <p>Choose what compares the live page with the Figma designs. The agent only drafts rows; you approve them before anything is copied.</p>
        </div>
        <button type="button" className="agents-button" onClick={() => void refresh()} disabled={busy === 'refresh'}>{busy === 'refresh' ? 'Checking…' : 'Refresh'}</button>
      </header>
      {error && <div className="agents-alert" role="alert">{error}</div>}

      <div className="agents-list">
        {agents.map((agent) => {
          const selected = settings.defaultAgent === agent.id
          const list = models[agent.id]
          return (
            <div key={agent.id} className={`agents-card ${selected ? 'selected' : ''}`}>
              <label className="agents-card-head">
                <input type="radio" name="default-agent" checked={selected} onChange={() => void save({ defaultAgent: agent.id })} />
                <span className="agents-card-title">{agent.label}</span>
                <span className={`agents-dot ${agent.ready ? 'ready' : 'idle'}`} aria-label={agent.ready ? 'Ready' : 'Not ready'} />
              </label>
              <p className="agents-detail">{agent.detail}</p>
              <p className="agents-muted">{KIND_NOTE[agent.kind]}</p>

              {agent.needsKey && (
                <div className="agents-row">
                  {agent.hasKey ? (
                    <>
                      <span className="agents-muted">API key saved</span>
                      <button type="button" className="agents-link" onClick={() => void guard('key', async () => { const next = await window.electronAPI.qaAgentsClearKey(agent.id); if (next) setOverview(next) })}>Remove</button>
                    </>
                  ) : (
                    <>
                      <input type="password" autoComplete="off" spellCheck={false} placeholder="Paste your API key" value={keyDrafts[agent.id] || ''} onChange={(event) => setKeyDrafts({ ...keyDrafts, [agent.id]: event.target.value })} />
                      <button type="button" className="agents-button" disabled={!keyDrafts[agent.id]} onClick={() => void guard('key', async () => {
                        const result = await window.electronAPI.qaAgentsSetKey(agent.id, keyDrafts[agent.id] || '')
                        if (result && 'error' in result) setError(result.error)
                        else if (result) { setOverview(result); setKeyDrafts({ ...keyDrafts, [agent.id]: '' }) }
                      })}>Save key</button>
                    </>
                  )}
                </div>
              )}

              {agent.id === 'local' && (
                <label className="agents-field"><span>Server address</span>
                  <input type="text" defaultValue={settings.localBaseUrl} spellCheck={false} onBlur={(event) => { if (event.target.value.trim() !== settings.localBaseUrl) void save({ localBaseUrl: event.target.value }) }} />
                </label>
              )}

              <div className="agents-row">
                <label className="agents-field grow"><span>{agent.kind === 'subscription' ? 'Model (optional)' : 'Model'}</span>
                  <input type="text" list={`models-${agent.id}`} defaultValue={settings.models[agent.id]} placeholder={agent.kind === 'subscription' ? "the app's default" : 'choose a model'} spellCheck={false}
                    onBlur={(event) => { if (event.target.value.trim() !== settings.models[agent.id]) void save({ models: { [agent.id]: event.target.value } }) }} />
                  <datalist id={`models-${agent.id}`}>{(list?.list || []).map((name) => <option key={name} value={name} />)}</datalist>
                </label>
                {agent.kind !== 'subscription' && (
                  <button type="button" className="agents-button" onClick={() => void guard('models', async () => { const result = await window.electronAPI.qaAgentsModels(agent.id); setModels({ ...models, [agent.id]: { list: result.models, error: result.error } }) })}>List models</button>
                )}
              </div>
              {list?.error && <p className="agents-warn">{list.error}</p>}
              {list && !list.error && <p className="agents-muted">{list.list.length} models found. Pick one in the box above.</p>}
            </div>
          )
        })}
      </div>
      {keyStorage !== 'secure' && <p className="agents-warn">{keyStorage === 'weak' ? 'This computer has no system keyring, so API keys are only lightly protected. Prefer an agent that uses your signed-in app.' : 'This computer has no secure place to keep an API key, so keys cannot be saved. Use an agent that uses your signed-in app.'}</p>}

      <div className="agents-group">
        <h4>Run limits</h4>
        <div className="agents-row">
          <label className="agents-field"><span>Effort (Claude API)</span>
            <select value={settings.effort} onChange={(event) => void save({ effort: event.target.value as 'low' | 'medium' | 'high' })}>
              <option value="low">Low: fastest</option><option value="medium">Medium</option><option value="high">High: most careful</option>
            </select>
          </label>
          <label className="agents-field"><span>Stop after this many tokens (0 = no limit)</span>
            <input type="number" min={0} step={100000} defaultValue={settings.budgetTokens} onBlur={(event) => { const value = Math.max(0, Number(event.target.value) || 0); if (value !== settings.budgetTokens) void save({ budgetTokens: value }) }} />
          </label>
        </div>
      </div>

      <div className="agents-group">
        <h4>Evidence screenshots</h4>
        <p className="agents-muted">For each issue, Parity can upload a picture of the design next to the live page with the problem boxed, and put its link in the tracker's screenshot column. Anyone with a link can see that picture until it expires; nothing else is public.</p>
        <label className="agents-switch">
          <input type="checkbox" checked={settings.evidenceUploads} onChange={(event) => void save({ evidenceUploads: event.target.checked })} />
          <span>Upload evidence pictures and add their links</span>
        </label>
        <div className="agents-row">
          <label className="agents-field"><span>Links work for</span>
            <select value={settings.evidenceDays} disabled={!settings.evidenceUploads} onChange={(event) => void save({ evidenceDays: Number(event.target.value) })}>
              {[7, 30, 90, 180, 365].map((days) => <option key={days} value={days}>{days === 365 ? '1 year' : `${days} days`}</option>)}
            </select>
          </label>
        </div>
        {settings.evidenceUploads && signedIn === false && (
          <p className="agents-warn">Uploading needs your Parity account. <button type="button" className="agents-link" onClick={() => window.dispatchEvent(new Event('parity:open-account'))}>Sign in</button>. Without it, rows are still copied and the screenshot column stays empty.</p>
        )}
      </div>

      <div className="agents-group">
        <h4>Tracker format</h4>
        <p className="agents-muted">Parity uses the standard tracker (Page Link, Section, Screenshot, Remarks, Priority and the rest) until you paste a different one. To change it, copy the header row and two or three example rows from the Google Sheet and paste them here. The agent fills only QA's columns and copies the tone of your examples.</p>
        {tracker && <div className="agents-chips" aria-label="Current tracker columns">{tracker.columns.map((name) => <span key={name}>{name}</span>)}</div>}
        <textarea rows={4} spellCheck={false} placeholder={'Page\tIssue\tExpected\tScreenshot\tSeverity\nHome\tHeading too small\t32px\thttps://…\tHigh'} value={trackerText} onChange={(event) => { setTrackerText(event.target.value); setTrackerError('') }} />
        {trackerError && <p className="agents-warn">{trackerError}</p>}
        <div className="agents-row">
          <button type="button" className="agents-button primary" disabled={!trackerText.trim()} onClick={() => void guard('tracker', async () => {
            const result = await window.electronAPI.qaTrackerFormatSave(trackerText)
            if (result.ok) { setTracker(result.format); setTrackerText('') } else setTrackerError(result.error)
          })}>Save tracker format</button>
          {tracker && <button type="button" className="agents-link" onClick={() => void guard('tracker', async () => { await window.electronAPI.qaTrackerFormatClear(); setTracker(await window.electronAPI.qaTrackerFormatGet()) })}>Use the standard tracker</button>}
        </div>
      </div>

      <div className="agents-group">
        <h4>Local bridge</h4>
        <p className="agents-muted">Lets agent apps and the <code>parity</code> command use the same tools as the in-app console. It only accepts connections from this computer and needs a key. It is off unless you turn it on (a review that uses an agent app turns it on just for that run).</p>
        {bridge && (
          <>
            <label className="agents-switch">
              <input type="checkbox" checked={bridge.enabled} onChange={(event) => void guard('bridge', async () => { const next = await window.electronAPI.qaBridgeSetEnabled(event.target.checked); if (next) setBridge(next) })} />
              <span>{bridge.running ? `On · port ${bridge.port}` : bridge.enabled ? 'Starting…' : 'Off'}</span>
            </label>
            {bridge.error && <p className="agents-warn">{bridge.error}</p>}
            {bridge.running && (
              <div className="agents-kv">
                <div><span>MCP address</span><code>{bridge.mcpUrl}</code><button type="button" className="agents-link" onClick={() => copy('url', bridge.mcpUrl)}>{copied === 'url' ? 'Copied' : 'Copy'}</button></div>
                <div><span>Key</span><code>{bridge.keyHint || 'not created yet'}</code><button type="button" className="agents-link" onClick={() => void guard('bridge', async () => { const next = await window.electronAPI.qaBridgeResetKey(); if (next) setBridge(next) })}>Reset key</button></div>
                <div><span>Key file</span><code>{bridge.keyFile}</code><button type="button" className="agents-link" onClick={() => copy('file', bridge.keyFile)}>{copied === 'file' ? 'Copied' : 'Copy'}</button></div>
                <p className="agents-muted">Send the key as <code>Authorization: Bearer &lt;key&gt;</code>. The <code>parity</code> command reads the key file for you.</p>
              </div>
            )}
            {bridge.recent.length > 0 && (
              <ul className="agents-log" aria-label="Recent bridge requests">
                {bridge.recent.slice(0, 5).map((entry, index) => <li key={`${entry.at}-${index}`}><span>{new Date(entry.at).toLocaleTimeString()}</span><span>{entry.method} {entry.tool ? entry.tool : entry.path}</span><span className={entry.status >= 400 ? 'bad' : ''}>{entry.status}</span></li>)}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="agents-group">
        <h4>The <code>parity</code> command</h4>
        <p className="agents-muted">A terminal command for the same tools: <code>parity context</code>, <code>parity capture desktop</code>, <code>parity section …</code>. Any agent that can run shell commands can use it. Run <code>parity --help</code> for the list.</p>
        {cli && (
          <div className="agents-row">
            <button type="button" className="agents-button" onClick={() => void guard('cli', async () => { const next = await window.electronAPI.qaCliInstall(); if (next) setCli(next) })}>{cli.installed ? 'Reinstall command' : 'Install command'}</button>
            <span className="agents-muted">{cli.installed ? `Installed at ${cli.path}${cli.onPath ? '' : '. That folder is not on your PATH yet, so add it to use the command from anywhere.'}` : `Adds ${cli.path}.`}</span>
          </div>
        )}
      </div>
    </section>
  )
}
