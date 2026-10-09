import { useEffect, useRef, useState } from 'react'
import type { Sheet } from '@fortune-sheet/core'
import { useAuditFindings } from './useAuditFindings'
import ManagedQaWorkbook from './ManagedQaWorkbook'
import './Organizer.css'
const blankManual:Sheet[]=[{id:'manual-qa-tracker',name:'QA Tracker',order:1,column:3,row:50,celldata:['Title','Description','Annotated URL'].map((v,c)=>({r:0,c,v:{v,m:v,bl:1}}))}]
export default function QaTrackerModal({projectKey,onClose}:{projectKey:string;onClose:()=>void}){
  const findings=useAuditFindings(projectKey);const key=`qa_${projectKey}_mock_sheet`;const dialog=useRef<HTMLDivElement>(null);const [google,setGoogle]=useState('')
  const read=()=>{try{const data=JSON.parse(localStorage.getItem(key)||'null');return Array.isArray(data)&&data.length?data:blankManual}catch{return blankManual}}
  const [manual,setManual]=useState<Sheet[]>(read)
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const changed=()=>setManual(read());window.addEventListener('parity:manual-tracker-changed',changed)
    const off=window.electronAPI.onAccountChanged?.(onClose)
    void window.electronAPI.getProjects?.().then(projects=>{const project=projects.find(p=>p.id===projectKey);if(project?.googleSheetUrl)setGoogle(project.googleSheetUrl)}).catch(()=>{})
    return()=>{window.removeEventListener('parity:manual-tracker-changed',changed);off?.();previous?.focus()}
  },[projectKey,onClose])
  return <div className="qa-tracker-backdrop" onPointerDown={e=>{if(e.target===e.currentTarget)onClose()}}><div ref={dialog} className="qa-tracker-dialog" role="dialog" aria-modal="true" aria-label="QA Master Tracker" onKeyDown={e=>{
    if(e.key==='Escape'){e.stopPropagation();onClose()}
    if(e.key==='Tab'){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],[contenteditable="true"]')||[]).filter(node=>node.offsetParent!==null);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
  }}><header><div><strong>QA Master Tracker</strong><small>{findings.snapshot?.projectName||'Loading project…'} · AI findings and manual sheets</small></div><div>{google&&<button onClick={()=>{try{const url=new URL(google);if(url.protocol==='https:'&&url.hostname==='docs.google.com')void window.electronAPI.openExternal(url.href)}catch{}}}>Open Google sheet</button>}<button aria-label="Close tracker" onClick={onClose}>Close</button></div></header>
    {findings.error&&<p className="qa-organizer-error" role="alert">{findings.error}<button onClick={()=>void findings.refresh()}>Retry</button></p>}
    {findings.loading?<div className="qa-organizer-loading" role="status" aria-label="Loading tracker"><i/><i/><i/></div>:findings.snapshot?<ManagedQaWorkbook snapshot={findings.snapshot} update={findings.update} manualSheets={manual} onManualChange={next=>{setManual(next);localStorage.setItem(key,JSON.stringify(next));window.dispatchEvent(new Event('parity:manual-tracker-changed'))}}/>:<p>Open the project to access its tracker.</p>}
  </div></div>
}
