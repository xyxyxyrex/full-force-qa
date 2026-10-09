import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentId, AgentsOverview, QaBridgeStatus } from '../../../shared/qaAgent'
import type { TrackerFormat } from '../../../shared/trackerFormat'
import AgentIcon, { AGENT_NAMES } from './agents/AgentIcon'
import AgentConfiguration from './agents/AgentConfiguration'
import AgentsSkeleton from './agents/AgentsSkeleton'
import RemarkStyleSettings from './agents/RemarkStyleSettings'
import { useModelDiscovery } from './agents/useModelDiscovery'
import './AgentsPanel.css'

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : 'Something went wrong.').replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

type CliStatus = { installed: boolean; path: string; onPath: boolean; platform: string }

export default function AgentsPanel() {
  const [overview, setOverview] = useState<AgentsOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [viewedAgent, setViewedAgent] = useState<AgentId | null>(null)
  const discovery = useModelDiscovery()
  const alive = useRef(true)
  const mutations = useRef<Promise<unknown>>(Promise.resolve())
  const refreshVersion = useRef(0)
  const [auxErrors, setAuxErrors] = useState<Record<string, string>>({})
  // Serialize persistence so slower overview responses cannot overwrite newer settings.
  const mutate = async (work: () => Promise<AgentsOverview | null>) => {
    const task = mutations.current.catch(() => {}).then(async () => {
      refreshVersion.current++
      const next = await work()
      if (!next) throw new Error('Could not save these settings. Please try again.')
      if (alive.current) setOverview(next)
    })
    mutations.current = task
    await task
  }
  const [bridge, setBridge] = useState<QaBridgeStatus | null>(null)
  const [tracker, setTracker] = useState<TrackerFormat | null>(null)
  const [trackerText, setTrackerText] = useState('')
  const [trackerError, setTrackerError] = useState('')
  const [cli, setCli] = useState<CliStatus | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [copied, setCopied] = useState('')

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    setBusy('refresh'); setError('')
    try { const next = await window.electronAPI.qaAgentsOverview(); if (!next) throw new Error('Could not load agent settings. Please try again.'); if (alive.current && version === refreshVersion.current) setOverview(next) }
    catch (cause) { if (alive.current && version === refreshVersion.current) setError(cleanError(cause)) }
    finally { if (alive.current) setBusy('') }
  }, [])

  const loadAux = useCallback((name: string) => {
    setAuxErrors(previous => ({ ...previous, [name]: '' }))
    const work = name === 'bridge' ? window.electronAPI.qaBridgeStatus().then(value => { if (alive.current) setBridge(value) })
      : name === 'tracker' ? window.electronAPI.qaTrackerFormatGet().then(value => { if (alive.current) setTracker(value) })
      : window.electronAPI.qaCliStatus().then(value => { if (alive.current) setCli(value) })
    void work.catch(() => { if (alive.current) setAuxErrors(previous => ({ ...previous, [name]: 'Could not load this section.' })) })
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh()
    loadAux('bridge'); loadAux('tracker'); loadAux('cli')
    void window.electronAPI.accountStatus().then(status => { if (alive.current) setSignedIn(status.signedIn) }).catch(() => {})
    const off = window.electronAPI.onQaBridgeStatus(setBridge)
    return () => { alive.current = false; refreshVersion.current++; off() }
  }, [refresh, loadAux])
  const auxiliary = (name: string, loaded: boolean) => auxErrors[name]
    ? <p className="agents-warn" role="alert">{auxErrors[name]} <button className="agents-link" onClick={() => loadAux(name)}>Retry</button></p>
    : !loaded ? <div className="agents-skeleton-line field" role="status" aria-label="Loading section"/> : null

  const guard = async (name: string, work: () => Promise<void>) => {
    setBusy(name); setError('')
    try { await work() } catch (cause) { setError(cleanError(cause)) } finally { setBusy('') }
  }
  const save = (patch: Parameters<typeof window.electronAPI.qaAgentsSaveSettings>[0]) => guard('save', () => mutate(() => window.electronAPI.qaAgentsSaveSettings(patch)))
  const copy = (label: string, text: string) => { void navigator.clipboard.writeText(text).then(() => { setCopied(label); window.setTimeout(() => setCopied(''), 1500) }) }

  if (!overview) return error ? <section className="agents-panel"><p className="agents-alert" role="alert">{error}</p><button className="agents-button" onClick={() => void refresh()}>Retry</button></section> : <AgentsSkeleton />
  const { settings, agents, keyStorage } = overview
  const activeAgent = viewedAgent || settings.defaultAgent

  return (
    <section className="agents-panel">
      <header className="agents-header">
        <div>
          <h3>AI agents</h3>
          <p>Choose the agent that QAs your pages: how they look (against the Figma designs when you have them), how they work, and the SEO basics. It saves draft findings in your organizer. Review and edit them before sharing evidence.</p>
          <p className="agents-free-hint">No Claude, ChatGPT or Google plan? <b>Gemini</b> and <b>OpenRouter</b> give free keys: lighter runs, but no cost.</p>
        </div>
        <button type="button" className="agents-button" onClick={() => void refresh()} disabled={busy === 'refresh'}>{busy === 'refresh' ? 'Checking…' : 'Refresh'}</button>
      </header>
      {error && <div className="agents-alert" role="alert">{error}</div>}

      <div className="agents-setup">
        <nav className="agents-provider-list" aria-label="Agent providers">
          {agents.map(agent => <button type="button" key={agent.id} data-agent={agent.id} className={`agents-provider ${activeAgent === agent.id ? 'selected' : ''}`} aria-pressed={activeAgent === agent.id} onClick={() => setViewedAgent(agent.id)}>
            <AgentIcon id={agent.id}/><span className="agents-provider-text"><strong>{AGENT_NAMES[agent.id]}</strong><small>{agent.ready ? 'Ready' : 'Needs setup'}</small></span>
            {settings.defaultAgent === agent.id && <span className="agents-badge">Default</span>}
          </button>)}
        </nav>
        <div className="agents-config-stack">{agents.map(agent => <AgentConfiguration key={agent.id} agent={agent} settings={settings} active={activeAgent === agent.id} discovery={discovery.results[agent.id]} load={discovery.load} invalidate={discovery.invalidate} mutate={mutate}/>)}</div>
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
        <h4>Testing the page</h4>
        <p className="agents-muted">The agent has its own browser to click links, buttons and menus, fill forms in, and read console and network errors. It is signed in as you, stays on the site under review, and never opens WordPress admin, login or logout pages.</p>
        <div className="agents-switches">
          <label className="agents-switch">
            <input type="checkbox" checked={settings.functionalChecks} onChange={(event) => void save({ functionalChecks: event.target.checked })} />
            <span>Reviews also test links, buttons, menus and forms</span>
          </label>
          <label className="agents-switch">
            <input type="checkbox" checked={settings.allowSend} onChange={(event) => void save({ allowSend: event.target.checked })} />
            <span>Let the agent submit forms and send API requests</span>
          </label>
        </div>
        <p className={settings.allowSend ? 'agents-warn' : 'agents-muted'}>
          {settings.allowSend
            ? 'Forms the agent tests are really sent, and POST, PUT and DELETE requests reach the site, using made-up test data. Turn this on only for staging sites where test submissions are fine.'
            : 'Off: the agent fills forms in and checks their validation, but submissions and POST, PUT and DELETE requests are stopped. Reading pages and GET requests always work.'}
        </p>
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
          <p className="agents-warn">Uploading needs your Parity account. <button type="button" className="agents-link" onClick={() => window.dispatchEvent(new Event('parity:open-account'))}>Sign in</button>. Local evidence remains viewable, and you can still organize or copy findings.</p>
        )}
      </div>

      <RemarkStyleSettings value={settings.remarkStyle} save={style=>mutate(()=>window.electronAPI.qaAgentsSaveSettings({remarkStyle:style}))}/>
      <div className="agents-group">
        <h4>Tracker format</h4>
        {auxiliary('tracker', !!tracker)}
        <p className="agents-muted">Parity uses the standard tracker (Page Link, Section, Screenshot, Remarks, Priority and the rest) until you paste a different one. To change it, copy the header row and two or three example rows from the Google Sheet and paste them here. The agent fills only QA's columns. Remark style controls the wording; examples define column usage.</p>
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
        {auxiliary('bridge', !!bridge)}
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
        {auxiliary('cli', !!cli)}
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
