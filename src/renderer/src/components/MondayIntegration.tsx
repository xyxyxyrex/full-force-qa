import { useEffect, useState } from 'react'
import { fetchMondayMetadataApi, loadMondayPreferences, saveMondayPreferences, type MondayMetadata, type MondaySyncPreferences } from '../utils/mondayApi'
import { supabaseUrl, supabaseAnonKey } from '../../../shared/supabaseClient'
import { refreshMondayTickets } from '../services/ticketService'

export default function MondayIntegration() {
  const [connected, setConnected] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [token, setToken] = useState('')
  const [metadata, setMetadata] = useState<MondayMetadata | null>(null)
  const [preferences, setPreferences] = useState<MondaySyncPreferences>(() => loadMondayPreferences() || { boardIds: [], assignmentMode: 'me', userIds: [] })
  const config = { supabaseUrl, supabaseAnonKey }
  const load = async () => { const status = await window.electronAPI.mondayStatus(); setConnected(status.connected); if (status.connected) setMetadata(await fetchMondayMetadataApi()) }
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Monday connection failed.') } finally { setBusy(false) } }
  useEffect(() => { void run(load) }, [])
  const connect = async (personal = false) => {
    const result = personal ? await window.electronAPI.mondaySetPersonalToken(token, config) : await window.electronAPI.mondayLogin(config)
    if (!result.success) throw new Error(result.error)
    setToken(''); await load(); window.dispatchEvent(new Event('parity:monday-connected'))
  }
  return <section className="ticket-ui"><h3>Monday.com</h3><p>Optional ticket connection. Opsmosis and other sources support manual intake from Tickets.</p>
    {error && <p role="alert" className="ticket-error">{error}</p>}
    {!connected ? <><button disabled={busy} onClick={() => void run(() => connect())}>Connect Monday.com</button><details><summary>Personal API token</summary><label>Token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label><button disabled={busy || !token.trim()} onClick={() => void run(() => connect(true))}>Connect with token</button></details></> : <>
      <p>Connected as {metadata?.me.name}</p>
      {metadata && <><fieldset><legend>Boards</legend><div className="ticket-source-options">{metadata.boards.map(board => <label key={board.id}><input type="checkbox" checked={preferences.boardIds.includes(board.id)} onChange={event => setPreferences(value => ({ ...value, boardIds: event.target.checked ? [...value.boardIds, board.id] : value.boardIds.filter(id => id !== board.id) }))} />{board.name}</label>)}</div></fieldset>
      <label>Assignment<select value={preferences.assignmentMode} onChange={event => setPreferences(value => ({ ...value, assignmentMode: event.target.value as MondaySyncPreferences['assignmentMode'] }))}><option value="me">Assigned to me</option><option value="all">All accessible items</option><option value="users">Selected people</option></select></label>
      {preferences.assignmentMode === 'users' && <fieldset><legend>People</legend><div className="ticket-source-options">{metadata.users.map(person => <label key={person.id}><input type="checkbox" checked={preferences.userIds.includes(person.id)} onChange={event => setPreferences(value => ({ ...value, userIds: event.target.checked ? [...value.userIds, person.id] : value.userIds.filter(id => id !== person.id) }))} />{person.name}</label>)}</div></fieldset>}
      <button disabled={busy || !preferences.boardIds.length} onClick={() => void run(async () => { saveMondayPreferences(preferences); await refreshMondayTickets() })}>Save sources and refresh</button></>}
      <button disabled={busy} onClick={() => void run(async () => { await window.electronAPI.mondayDisconnect(config); setConnected(false); setMetadata(null); window.dispatchEvent(new Event('parity:monday-disconnected')) })}>Disconnect Monday</button>
    </>}
  </section>
}
