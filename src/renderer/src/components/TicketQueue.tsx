import { useEffect, useState } from 'react'
import type { Project, Ticket, TicketProvider, TicketStoreSnapshot } from '../../../shared/types'
import { extractTicketResources, linkProject, projectTicketRef, QA_STATUSES, sameTicket, ticketKey, TICKET_PROVIDERS, validateTicket } from '../../../shared/tickets'
import { refreshMondayTickets, saveTicket as persistTicket, syncTickets, ticketsChanged } from '../services/ticketService'
import './TicketQueue.css'

export function useTicketStore() {
  const [snapshot, setSnapshot] = useState<TicketStoreSnapshot | null>(null)
  useEffect(() => {
    let active = true, version = 0
    const load = () => { const request = ++version; void window.electronAPI.ticketsList().then(value => { if (active && request === version) setSnapshot(value) }).catch(() => { if (active && request === version) setSnapshot(null) }) }
    load(); window.addEventListener('parity:tickets-changed', load)
    const unsubscribe = window.electronAPI.onAccountChanged(() => { setSnapshot(null); load() })
    return () => { active = false; unsubscribe(); window.removeEventListener('parity:tickets-changed', load) }
  }, [])
  return snapshot
}
function newTicket(): Ticket {
  const id = crypto.randomUUID()
  return { id, source: { provider: 'opsmosis', connectionId: 'manual', externalId: id }, title: '', description: '', sourceStatus: '', sourceGroup: '', assignees: [], resources: { stagingUrl: '', adminUrl: '', otherLinks: [] }, progress: { active: true, qaStatus: 'To review' }, archived: false, createdAt: Date.now(), updatedAt: Date.now() }
}
export default function TicketQueue({ projects, folderId, initialTicketId, onOpenProject }: { projects: Project[]; folderId?: string; initialTicketId?: string; onOpenProject: (project: Project) => void }) {
  const snapshot = useTicketStore()
  const [search, setSearch] = useState(''), [provider, setProvider] = useState(''), [group, setGroup] = useState(''), [sourceStatus, setSourceStatus] = useState(''), [qaStatus, setQaStatus] = useState('')
  const [archived, setArchived] = useState(false), [draft, setDraft] = useState<Ticket | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [linking, setLinking] = useState<Ticket | null>(null), [projectId, setProjectId] = useState('')
  useEffect(() => {
    const retry = () => { void syncTickets() }
    retry(); const timer = window.setInterval(retry, 30000); window.addEventListener('online', retry)
    const off = window.electronAPI.onAccountChanged(() => { setDraft(null); setLinking(null); retry() })
    return () => { clearInterval(timer); window.removeEventListener('online', retry); off() }
  }, [])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ticket action failed.') } finally { setBusy(false) } }
  const ownerKey = snapshot?.ownerKey || ''
  const saveTicket = (ticket: Ticket) => persistTicket(ticket, ownerKey)
  const records = snapshot?.records || []
  const initialTicket = records.find(record => record.ticket.id === initialTicketId)?.ticket
  useEffect(() => {
    if (!initialTicket) return
    setSearch(initialTicket.title); setArchived(initialTicket.archived); setProvider(initialTicket.source.provider)
    document.querySelector('.ticket-queue')?.scrollIntoView({ block: 'start' })
  }, [initialTicket?.id])
  const createProject = async (ticket: Ticket) => {
    const project = linkProject({ id: crypto.randomUUID(), localOwnerKey: ownerKey, name: ticket.title, ...ticket.resources, folderId, createdAt: Date.now(), lastOpenedAt: Date.now() }, ticket)
    await window.electronAPI.saveProject(project, ownerKey)
    await saveTicket({ ...ticket, progress: { ...ticket.progress, active: true }, updatedAt: Date.now() })
    window.dispatchEvent(new Event('qa_projects_updated')); onOpenProject(project)
  }
  const visible = records.filter(({ ticket }) => ticket.archived === archived && (!provider || ticket.source.provider === provider) && (!group || ticket.sourceGroup === group) && (!sourceStatus || ticket.sourceStatus === sourceStatus) && (!qaStatus || ticket.progress.qaStatus === qaStatus) && `${ticket.title} ${ticket.description} ${ticket.source.externalId}`.toLowerCase().includes(search.toLowerCase()))
  const updateDraft = (values: Partial<Ticket>) => setDraft(value => value ? { ...value, ...values } : null)
  const updateResource = (key: keyof Ticket['resources'], value: string) => setDraft(current => current ? { ...current, resources: { ...current.resources, [key]: value } } : null)
  return <section className="dashboard-section ticket-ui ticket-queue">
    <div className="ticket-heading"><div><h2>Tickets</h2><p>Project intake and private QA progress</p></div><div className="ticket-actions">
      <button onClick={() => window.dispatchEvent(new Event('parity:open-integrations'))}>Integrations</button>
      <button disabled={!snapshot || busy} onClick={() => void run(refreshMondayTickets)}>Refresh Monday</button>
      <button disabled={!snapshot || busy} onClick={() => setDraft(newTicket())}>Add ticket</button>
    </div></div>
    {!snapshot ? <p>Sign in to your Parity account to use Tickets. <button onClick={() => window.dispatchEvent(new Event('parity:open-account'))}>Sign in</button></p> : <>
      <div className="ticket-filters"><input aria-label="Search tickets" placeholder="Search tickets…" value={search} onChange={event => setSearch(event.target.value)} />
        <select aria-label="Provider" value={provider} onChange={event => setProvider(event.target.value)}><option value="">All providers</option>{Object.entries(TICKET_PROVIDERS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select>
        <select aria-label="Source group" value={group} onChange={event => setGroup(event.target.value)}><option value="">All groups</option>{[...new Set(records.map(({ ticket }) => ticket.sourceGroup))].filter(Boolean).map(value => <option key={value}>{value}</option>)}</select>
        <select aria-label="Source status" value={sourceStatus} onChange={event => setSourceStatus(event.target.value)}><option value="">All source statuses</option>{[...new Set(records.map(({ ticket }) => ticket.sourceStatus))].filter(Boolean).map(value => <option key={value}>{value}</option>)}</select>
        <select aria-label="QA status" value={qaStatus} onChange={event => setQaStatus(event.target.value)}><option value="">All QA statuses</option>{QA_STATUSES.map(value => <option key={value}>{value}</option>)}</select>
        <label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />Archived</label>
      </div>
      <p className="ticket-sync-status">{snapshot.lastRefreshAt ? `Monday last refreshed ${new Date(snapshot.lastRefreshAt).toLocaleString()}. ` : ''}{records.filter(record => record.pending).length} changes awaiting sync. <button disabled={busy} onClick={() => void run(syncTickets)}>Sync now</button></p>
      {snapshot.refreshError && <p role="status" className="ticket-error">Monday refresh: {snapshot.refreshError} Cached tickets are retained.</p>}
      {snapshot.syncError && <p role="status" className="ticket-error">Saved on this device. {snapshot.syncError}</p>}
      {visible.length === 0 && <p>No matching tickets. Add an Opsmosis ticket manually or connect Monday in Integrations.</p>}
      <div className="ticket-grid">{visible.map(({ ticket, conflict, pending }) => {
        const linked = projects.filter(project => !project.inTrash && sameTicket(projectTicketRef(project, ticket.source.connectionId), ticket.source))
        return <article key={ticket.id} className="ticket-card">
          <div className="ticket-card-meta"><span>{TICKET_PROVIDERS[ticket.source.provider].label}{ticket.source.provider === 'opsmosis' ? ' · Manual intake' : ''}</span><span>{conflict ? 'Conflict' : pending ? 'Pending sync' : 'Synced'}</span></div>
          <h3>{ticket.title}</h3><p>{[ticket.sourceGroup, ticket.sourceStatus].filter(Boolean).join(' · ') || 'No source status'}</p>
          {ticket.description && <p className="ticket-description">{ticket.description}</p>}
          <label>Private QA status<select disabled={busy} value={ticket.progress.qaStatus} onChange={event => void run(() => saveTicket({ ...ticket, progress: { ...ticket.progress, qaStatus: event.target.value as Ticket['progress']['qaStatus'] }, updatedAt: Date.now() }))}>{QA_STATUSES.map(value => <option key={value}>{value}</option>)}</select></label>
          <label><input type="checkbox" checked={ticket.progress.active} disabled={busy} onChange={event => void run(() => saveTicket({ ...ticket, progress: { ...ticket.progress, active: event.target.checked }, updatedAt: Date.now() }))} />Active in project list</label>
          <div className="ticket-actions">{ticket.source.url && <button onClick={() => void window.electronAPI.openExternal(ticket.source.url!)}>Open original</button>}
            {ticket.source.provider !== 'monday' && <button onClick={() => setDraft(structuredClone(ticket))}>Edit details</button>}
            <button disabled={busy} onClick={() => void run(() => saveTicket({ ...ticket, archived: !ticket.archived, updatedAt: Date.now() }))}>{ticket.archived ? 'Restore' : 'Archive'}</button>
            <button disabled={busy} onClick={() => void run(() => createProject(ticket))}>{linked.length ? 'Create another page' : 'Create project'}</button>
            <button onClick={() => { setLinking(ticket); setProjectId('') }}>Link existing project</button>
          </div>
          {linked.map(project => <button className="ticket-project-link" key={project.id} onClick={() => onOpenProject(project)}>{project.name}</button>)}
          {conflict && <div className="ticket-conflict"><strong>Another device changed this ticket.</strong><p>Your draft is preserved. Cloud version: {conflict.ticket.title} · {conflict.ticket.progress.qaStatus}</p><details><summary>Compare versions</summary><pre>{JSON.stringify({ local: ticket, cloud: conflict.ticket }, null, 2)}</pre></details><div className="ticket-actions">{(['local', 'remote'] as const).map(choice => <button key={choice} disabled={busy} onClick={() => void run(async () => { await window.electronAPI.ticketsResolve(ticket.id, choice, ownerKey); ticketsChanged(); void syncTickets() })}>Keep {choice === 'local' ? 'my version' : 'cloud version'}</button>)}</div></div>}
        </article>
      })}</div>
    </>}
    {error && <p role="alert" className="ticket-error">{error}</p>}
    {draft && <div className="ticket-modal-backdrop"><form className="ticket-modal" role="dialog" aria-modal="true" aria-label="Ticket details" onSubmit={event => { event.preventDefault(); void run(async () => { const ticket = { ...draft, id: !records.some(record => record.ticket.id === draft.id) && draft.source.externalId !== draft.id ? ticketKey(draft.source) : draft.id, title: draft.title.trim(), updatedAt: Date.now() }; validateTicket(ticket); await saveTicket(ticket); setDraft(null) }) }}>
      <h3>{records.some(record => record.ticket.id === draft.id) ? 'Edit ticket' : 'Add ticket'}</h3>
      <label>Source<select disabled={records.some(record => record.ticket.id === draft.id)} value={draft.source.provider} onChange={event => updateDraft({ source: { ...draft.source, provider: event.target.value as TicketProvider } })}><option value="opsmosis">Opsmosis — manual intake</option><option value="manual">Manual / other platform</option></select></label>
      <label>Title<input required maxLength={500} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} /></label>
      <label>Original ticket URL<input type="url" value={draft.source.url || ''} onChange={event => updateDraft({ source: { ...draft.source, url: event.target.value || undefined } })} /></label>
      <label>External ticket ID (optional)<input disabled={records.some(record => record.ticket.id === draft.id)} value={draft.source.externalId === draft.id ? '' : draft.source.externalId} onChange={event => updateDraft({ source: { ...draft.source, externalId: event.target.value || draft.id } })} /></label>
      <label>Description / paste ticket details<textarea rows={4} value={draft.description} onChange={event => updateDraft({ description: event.target.value })} /></label>
      <button type="button" onClick={() => { const extracted = extractTicketResources(draft.description); updateDraft({ resources: { ...extracted, ...Object.fromEntries(Object.entries(draft.resources).filter(([key, value]) => key !== 'otherLinks' && !!value)), otherLinks: [...draft.resources.otherLinks, ...extracted.otherLinks.filter(link => !draft.resources.otherLinks.some(existing => existing.url === link.url))] } }) }}>Suggest links from pasted text</button>
      <p>Review the suggested fields before saving.</p>
      <div className="ticket-form-grid">{(['stagingUrl', 'adminUrl', 'figmaUrl', 'googleSheetUrl'] as const).map(key => <label key={key}>{({ stagingUrl: 'Staging URL', adminUrl: 'Admin URL', figmaUrl: 'Figma URL', googleSheetUrl: 'QA sheet URL' })[key]}<input type="url" value={draft.resources[key] || ''} onChange={event => updateResource(key, event.target.value)} /></label>)}
      <label>Source group<input value={draft.sourceGroup} onChange={event => updateDraft({ sourceGroup: event.target.value })} /></label><label>Source status<input value={draft.sourceStatus} onChange={event => updateDraft({ sourceStatus: event.target.value })} /></label></div>
      {draft.resources.otherLinks.map((link, index) => <label key={index}>Additional link<input type="url" value={link.url} onChange={event => updateDraft({ resources: { ...draft.resources, otherLinks: draft.resources.otherLinks.map((item, i) => i === index ? { ...item, url: event.target.value } : item) } })} /><button type="button" onClick={() => updateDraft({ resources: { ...draft.resources, otherLinks: draft.resources.otherLinks.filter((_, i) => i !== index) } })}>Remove</button></label>)}
      {error && <p role="alert" className="ticket-error">{error}</p>}<div className="ticket-actions"><button disabled={busy}>Save ticket</button><button type="button" disabled={busy} onClick={() => { setDraft(null); setError('') }}>Cancel</button></div>
    </form></div>}
    {linking && <div className="ticket-modal-backdrop"><div className="ticket-modal" role="dialog" aria-modal="true" aria-label="Link project"><h3>Link a project to {linking.title}</h3><label>Project<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.filter(project => !project.inTrash).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div className="ticket-actions"><button disabled={busy || !projectId} onClick={() => void run(async () => { const project = projects.find(item => item.id === projectId)!; if (project.ticketRef && !sameTicket(project.ticketRef, linking.source) && !window.confirm('Replace this project’s existing ticket link?')) return; await window.electronAPI.saveProject(linkProject(project, linking), ownerKey); window.dispatchEvent(new Event('qa_projects_updated')); setLinking(null) })}>Link project</button><button onClick={() => setLinking(null)}>Cancel</button></div></div></div>}
  </section>
}
