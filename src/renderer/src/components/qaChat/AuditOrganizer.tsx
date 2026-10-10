import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AuditFinding, FindingReview, OrganizerSnapshot, FindingUpdate } from '../../../../shared/qaOrganizer'
import { PictureLightbox, shortLink, type FindingPicture } from '../QaFindings'
import RichText from './RichText'
import { REVIEW_LABELS } from './findingSheet'
import './Organizer.css'
import ChatIcon from './ChatIcon'
function FindingItem({item,snapshot,selected,toggle,update}:{item:AuditFinding;snapshot:OrganizerSnapshot;selected:boolean;toggle:()=>void;update:(changes:FindingUpdate[],revision?:number)=>Promise<boolean>}){
  const [draft,setDraft]=useState(item.cells);const [baseRevision,setBaseRevision]=useState(snapshot.revision);const [dirty,setDirty]=useState(false);const [picture,setPicture]=useState<FindingPicture|null>(null);const [zoom,setZoom]=useState<FindingPicture|null>(null);const [loading,setLoading]=useState(false);const [pictureIndex,setPictureIndex]=useState(0)
  useEffect(()=>{if(!dirty)setDraft(item.cells)},[item.cells,dirty])
  const change=(column:string,value:string)=>{if(!dirty)setBaseRevision(snapshot.revision);setDraft(previous=>({...previous,[column]:value}));setDirty(true)}
  const priority=snapshot.columns.find(column=>/priority|severity|impact/i.test(column));const status=snapshot.columns.find(column=>/^status$/i.test(column));const remark=snapshot.columns.find(column=>/^(remarks|issue|description|finding|comment)s?$/i.test(column))||'Remarks'
  const load=(index=pictureIndex)=>{if((picture&&index===pictureIndex)||!item.evidence||loading)return;setPictureIndex(index);setLoading(true);void window.electronAPI.qaFindingsPicture(snapshot.projectKey,item.id,index).then(setPicture).catch(()=>setPicture(null)).finally(()=>setLoading(false))}
  return <article className={`qa-organizer-item ${item.review}`}><div className="qa-organizer-item-top"><input type="checkbox" aria-label={`Select finding ${item.cells.Section||item.id}`} checked={selected} onChange={toggle}/><span className="qa-organizer-state">{REVIEW_LABELS[item.review]}</span><small>{[...new Set(item.sources.map(s=>s.breakpoint))].join(' · ')}</small></div>
    <details onToggle={event=>{if(event.currentTarget.open)load()}}><summary><strong>{item.cells.Section||'Finding'}</strong><div className="qa-organizer-remark"><RichText text={item.cells[remark]||''}/></div></summary><div className="qa-organizer-edit"><label>Section<input value={draft.Section||''} onChange={e=>change('Section',e.target.value)}/></label><label>{remark}<textarea rows={3} value={draft[remark]||''} onChange={e=>change(remark,e.target.value)}/></label>
      {[priority,status].filter((column):column is string=>!!column).map(column=><label key={column}>{column}{snapshot.choices?.[column]?<select value={draft[column]||''} onChange={e=>change(column,e.target.value)}><option value="">Not set</option>{snapshot.choices[column].map(value=><option key={value}>{value}</option>)}</select>:<input value={draft[column]||''} onChange={e=>change(column,e.target.value)}/>}</label>)}
      {dirty&&<div className="qa-organizer-actions"><button onClick={()=>{const changes=Object.fromEntries(Object.entries(draft).filter(([key,value])=>item.cells[key]!==value));void update([{id:item.id,cells:changes}],baseRevision).then(ok=>{if(ok)setDirty(false)})}}>Save changes</button><button onClick={()=>{setDraft(item.cells);setDirty(false)}}>Cancel</button></div>}
      {loading?<span role="status">Loading evidence…</span>:picture?<button className="qa-organizer-picture" onClick={()=>setZoom(picture)} aria-label="Enlarge finding evidence"><img src={picture.src} alt={picture.caption||'Annotated evidence'}/></button>:<small>{item.evidence?'Evidence is unavailable.':'No screenshot needed for this finding.'}</small>}
      <div className="qa-organizer-actions">{(item.evidenceSet||[]).map((_image,index)=><button key={index} aria-pressed={pictureIndex===index} onClick={()=>load(index)}>Evidence {index+1}</button>)}</div><small className="qa-organizer-provenance">Audit {item.sources.map(s=>s.runId).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}</small><div className="qa-organizer-actions">{(['accepted','dismissed','draft'] as FindingReview[]).filter(state=>state!==item.review).map(review=><button key={review} onClick={()=>void update([{id:item.id,review}])}>{review==='accepted'?'Accept':review==='dismissed'?'Dismiss':'Restore to draft'}</button>)}</div></div></details>
<PictureLightbox picture={zoom} onClose={()=>setZoom(null)}/>
  </article>
}
function OrganizerActions({ busy, onImport, onRefresh }: { busy: boolean; onImport: () => void; onRefresh: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const show = () => {
    setOpen(true)
    window.setTimeout(() => root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(), 0)
  }
  return <div className="qa-organizer-more" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="qa-organizer-icon" aria-label="More findings actions" title="More actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); show() } }}><ChatIcon name="more"/></button>
    {open && <div className="qa-organizer-menu" id={menuId} role="menu" aria-label="Findings actions">
      <button type="button" role="menuitem" disabled={busy} onClick={() => { setOpen(false); trigger.current?.focus(); onImport() }}><ChatIcon name="import"/>Import past findings</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { setOpen(false); trigger.current?.focus(); onRefresh() }}><ChatIcon name="refresh"/>Refresh</button>
    </div>}
  </div>
}

export default function AuditOrganizer({ snapshot, loading, error, saving, refresh, update }: { snapshot: OrganizerSnapshot | null; loading: boolean; error: string; saving: boolean; refresh: () => Promise<void>; update: (changes: FindingUpdate[], revision?: number) => Promise<boolean> }) {
  const [query, setQuery] = useState(''), [page, setPage] = useState(''), [run, setRun] = useState(''), [bp, setBp] = useState(''), [kind, setKind] = useState(''), [review, setReview] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false), [selected, setSelected] = useState<Set<string>>(new Set()), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [noticeError, setNoticeError] = useState(false)
  const filterId = useId()
  const items = snapshot?.findings.filter(f => !f.mergedInto) || []
  const filterCount = [page, run, bp, kind, review].filter(Boolean).length
  const clearFilters = () => { setPage(''); setRun(''); setBp(''); setKind(''); setReview('') }
  useEffect(() => { setSelected(new Set()); clearFilters(); setQuery(''); setFiltersOpen(false); setNotice(''); setNoticeError(false) }, [snapshot?.projectKey])
  useEffect(() => {
    if (!notice || noticeError) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice, noticeError])
  const visible = useMemo(() => items.filter(item => (!page || item.pageUrl === page) && (!run || item.sources.some(s => s.runId === run)) && (!bp || item.sources.some(s => s.breakpoint === bp)) && (!review || item.review === review) && (!kind || (kind === 'suggestion') === /ENHANCEMENT|Suggestion:/i.test(Object.values(item.cells).join(' '))) && (!query || Object.values(item.cells).join(' ').toLowerCase().includes(query.toLowerCase()))), [items, page, run, bp, review, kind, query])
  const ids = visible.filter(item => selected.has(item.id)).map(item => item.id)
  const action = async (work: () => Promise<{ success: boolean; error?: string; count?: number }>) => {
    setBusy(true); setNotice(''); setNoticeError(false)
    try { const result = await work(); setNoticeError(!result.success); setNotice(result.success ? result.count ? `Copied ${result.count} row${result.count === 1 ? '' : 's'}.` : 'Done.' : result.error || 'Could not complete this action.'); await refresh() }
    catch (cause) { setNoticeError(true); setNotice((cause as Error).message) }
    finally { setBusy(false) }
  }
  if (loading) return <div className="qa-organizer-loading" role="status" aria-label="Loading findings"><i/><i/><i/></div>
  if (!snapshot) return <div className="qa-organizer-empty"><p>{error || 'Open a project to organize its audit findings.'}</p><button onClick={() => void refresh()}>Retry</button></div>
  return <div className={`qa-organizer${items.length ? '' : ' is-empty'}`}>
    <header>
      <strong title={snapshot.projectName}>{snapshot.projectName}</strong>
      <div className="qa-organizer-header-actions">
        <button type="button" className="qa-organizer-icon" aria-label="Open in tracker" title="Open in tracker" onClick={() => window.dispatchEvent(new CustomEvent('parity:open-ai-tracker', { detail: { projectKey: snapshot.projectKey } }))}><ChatIcon name="tracker"/></button>
        <OrganizerActions busy={busy || saving} onImport={() => void action(() => window.electronAPI.qaFindingsImport(snapshot.projectKey))} onRefresh={() => void refresh()}/>
      </div>
    </header>
    {!!items.length && <>
      <div className="qa-organizer-search-row">
        <div className="qa-organizer-search"><ChatIcon name="search" size={14}/><input type="search" aria-label="Search findings" placeholder="Search findings…" value={query} onChange={event => setQuery(event.target.value)}/></div>
        <button type="button" className={`qa-organizer-filter-toggle${filterCount ? ' active' : ''}`} aria-label={filterCount ? `Filter findings (${filterCount} active)` : 'Filter findings'} title="Filters" aria-expanded={filtersOpen} aria-controls={filterId} onClick={() => setFiltersOpen(!filtersOpen)}><ChatIcon name="filter"/>{!!filterCount && <span>{filterCount}</span>}</button>
      </div>
      {filtersOpen && <div className="qa-organizer-filter-panel" id={filterId} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFiltersOpen(false); document.getElementById(filterId)?.previousElementSibling?.querySelector<HTMLButtonElement>('.qa-organizer-filter-toggle')?.focus() } }}>
        <div className="qa-organizer-filters">
          <label>Page<select aria-label="Filter findings by page" value={page} onChange={event => setPage(event.target.value)}><option value="">All pages</option>{[...new Set(items.map(item => item.pageUrl))].map(value => <option key={value} value={value}>{shortLink(value)}</option>)}</select></label>
          <label>Audit<select aria-label="Filter findings by audit" value={run} onChange={event => setRun(event.target.value)}><option value="">All audits</option>{[...new Set(items.flatMap(item => item.sources.map(source => source.runId)))].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Breakpoint<select aria-label="Filter findings by breakpoint" value={bp} onChange={event => setBp(event.target.value)}><option value="">All breakpoints</option>{['desktop', 'tablet', 'mobile'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Type<select aria-label="Filter findings by type" value={kind} onChange={event => setKind(event.target.value)}><option value="">All types</option><option value="defect">Defects</option><option value="suggestion">Suggestions</option></select></label>
          <label>Review state<select aria-label="Filter findings by review" value={review} onChange={event => setReview(event.target.value)}><option value="">All review states</option>{Object.entries(REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        {!!filterCount && <button type="button" className="qa-organizer-text-action" onClick={clearFilters}>Clear filters</button>}
      </div>}
    </>}
    {(error || notice) && <p className={error || noticeError ? 'qa-organizer-error' : 'qa-organizer-notice'} role={error || noticeError ? 'alert' : 'status'}>{error || notice} {error && <button onClick={() => void refresh()}>Refresh</button>}</p>}
    {!!items.length && <div className="qa-organizer-selection">
      <label>{!!visible.length && <input type="checkbox" aria-label="Select all visible findings" checked={ids.length === visible.length} onChange={event => setSelected(event.target.checked ? new Set(visible.map(item => item.id)) : new Set())}/>} {ids.length ? `${ids.length} selected` : `${visible.length}${query || filterCount ? ` of ${items.length}` : ''} finding${visible.length === 1 ? '' : 's'}`}</label>
      {saving ? <small role="status">Saving…</small> : !error && <small className="qa-organizer-save-state" aria-label="Saved locally" title="Saved locally"><ChatIcon name="check" size={12}/></small>}
    </div>}
    {!!ids.length && <div className="qa-organizer-actions bulk">{(['accepted', 'dismissed', 'draft'] as FindingReview[]).map(state => <button key={state} disabled={busy || saving} onClick={() => void update(ids.map(id => ({ id, review: state })))}>{state === 'accepted' ? 'Accept' : state === 'dismissed' ? 'Dismiss' : 'Restore'}</button>)}<button disabled={busy} onClick={() => void action(() => window.electronAPI.qaFindingsCopy(snapshot.projectKey, ids))}>Copy rows</button><button disabled={busy} onClick={() => void action(() => window.electronAPI.qaFindingsShare(snapshot.projectKey, ids))}>Share evidence</button></div>}
    <div className="qa-organizer-list">
      {!visible.length ? <div className="qa-organizer-empty"><ChatIcon name="tracker" size={24}/><strong>{items.length ? 'No matching findings' : 'No findings yet'}</strong><p>{items.length ? 'Try another search or clear your filters.' : 'Run an audit in Chat. Findings save here automatically.'}</p>{!!items.length && <button type="button" className="qa-organizer-text-action" onClick={() => { clearFilters(); setQuery('') }}>Clear search and filters</button>}</div> : [...new Set(visible.map(item => item.pageUrl))].map(url => <section key={url}><h4 title={url}>{shortLink(url)}<small>{visible.filter(item => item.pageUrl === url).length}</small></h4>{visible.filter(item => item.pageUrl === url).sort((a, b) => b.createdAt - a.createdAt).map(item => <FindingItem key={item.id} item={item} snapshot={snapshot} selected={selected.has(item.id)} toggle={() => setSelected(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })} update={update}/>)}</section>)}
    </div>
  </div>
}
