import { useEffect, useRef, useState } from 'react'
import type { WorkspaceProposal, WorkspaceRecord } from '../../../../shared/parityWorkspace'
import { qaChat } from '../qaChatStore'

export function WorkspaceAction({proposal:initial}:{proposal:WorkspaceProposal}) {
  const [proposal,setProposal]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const alive=useRef(true)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>setProposal(initial),[initial])
  useEffect(()=>{let alive=true;void window.electronAPI.workspaceProposal(initial.id).then(p=>{if(alive)setProposal(p)}).catch(()=>{if(alive){setError('This action is unavailable. Ask for a fresh preview.');setProposal(p=>({...p,status:'cancelled'}))}});return()=>{alive=false}},[initial.id])
  const update=(p:WorkspaceProposal)=>{if(!alive.current)return;setProposal(p);qaChat.handle({type:'workspace-proposal',proposal:p})}
  const apply=async()=>{setBusy(true);setError('');const chatId=qaChat.getState().chatId;try{const result=await window.electronAPI.workspaceApply(proposal.id);if(!alive.current||chatId!==qaChat.getState().chatId)return;update(result.proposal);if(result.success)qaChat.addStatus('Workspace changes applied.')}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not apply these changes.')}finally{if(alive.current)setBusy(false)}}
  const cancel=async()=>{setBusy(true);try{update(await window.electronAPI.workspaceCancel(proposal.id))}catch(e){setError(e instanceof Error?e.message:'Could not cancel.')}finally{setBusy(false)}}
  const stale=proposal.status==='failed'&&/changed|refreshed preview/i.test(proposal.error||'')
  const refresh=async()=>{setBusy(true);setError('');const chatId=qaChat.getState().chatId;try{const next=await window.electronAPI.workspaceRefresh(proposal.id);if(!alive.current||chatId!==qaChat.getState().chatId)return;update({...proposal,status:'cancelled',error:undefined});qaChat.handle({type:'workspace-proposal',proposal:next})}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not refresh the preview.')}finally{if(alive.current)setBusy(false)}}
  return <article className="qa-workspace-action" aria-label="Review workspace changes"><header><strong>{proposal.title}</strong><span>{proposal.status==='pending'?'Review before applying':proposal.status}</span></header>
    <ul>{proposal.changes.map((change,index)=><li key={index}><strong>{change.label}</strong>{change.before&&<small>{change.before} →</small>}<span>{change.after}</span></li>)}</ul>
    {(error||proposal.error)&&<p role="alert" className="qa-action-error">{error||proposal.error}</p>}
    {['pending','failed','uncertain','applying'].includes(proposal.status)&&<footer><button type="button" className="qa-action-primary" disabled={busy||!!error} onClick={()=>void(stale?refresh():apply())}>{busy?'Checking…':stale?'Refresh preview':proposal.status==='uncertain'||proposal.status==='applying'?'Check result':proposal.status==='failed'?'Retry':'Apply'}</button><button type="button" disabled={busy||proposal.status==='uncertain'||proposal.status==='applying'} onClick={()=>void cancel()}>Cancel</button></footer>}
  </article>
}
export function WorkspaceResults({records,nextOffset,warning,dateLabel}:{records:WorkspaceRecord[];nextOffset:number|null;warning?:string;dateLabel?:string}) {
  const [error,setError]=useState('')
  return <div className="qa-workspace-results">{dateLabel&&<small>{dateLabel}</small>}{warning&&<p>{warning}</p>}{!records.length&&<p>No matching records. Older projects may not have recorded capture dates.</p>}
    {records.map(record=><button type="button" key={`${record.kind}:${record.id}`} onClick={()=>void window.electronAPI.workspaceOpen({kind:record.kind,id:record.id,projectId:record.projectId}).catch(e=>setError(e instanceof Error?e.message:'Could not open this item.'))}><span className="qa-source-kind">{record.kind}</span><strong>{record.title}</strong><small>{record.breadcrumb} · {record.source}</small>{record.capturedAt&&<small>Captured {new Date(record.capturedAt).toLocaleString()}</small>}{record.createdAt&&<small>Created {new Date(record.createdAt).toLocaleString()}</small>}{record.excerpt&&<span>{record.excerpt}</span>}</button>)}
    {nextOffset!==null&&<small>More results available. Narrow the search or use --offset {nextOffset}.</small>}{error&&<p role="alert">{error}</p>}
  </div>
}
