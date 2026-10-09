import { useCallback, useEffect, useRef, useState } from 'react'
import type { FindingUpdate, OrganizerSnapshot } from '../../../../shared/qaOrganizer'
const clean = (cause: unknown) => (cause instanceof Error ? cause.message : 'Could not load findings.').replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
export function useAuditFindings(projectKey?: string) {
  const [snapshot,setSnapshot]=useState<OrganizerSnapshot|null>(null); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [saving,setSaving]=useState(false)
  const current=useRef(snapshot); current.current=snapshot; const generation=useRef(0); const alive=useRef(true); const queue=useRef<Promise<unknown>>(Promise.resolve()); const loadVersion=useRef(0)
  const saveError=useRef(false)
  const refresh=useCallback(async(manual=false)=>{
    if(manual){saveError.current=false;setError('')}
    const version=++loadVersion.current
    try { const next=await window.electronAPI.qaFindingsList?.(projectKey); if(alive.current&&version===loadVersion.current){const old=current.current;const same=old&&next&&old.projectKey===next.projectKey&&old.revision===next.revision&&old.projectName===next.projectName&&JSON.stringify(old.columns)===JSON.stringify(next.columns)&&JSON.stringify(old.choices)===JSON.stringify(next.choices);if(!same){current.current=next||null;setSnapshot(next||null)}if(!saveError.current)setError('')} }
    catch(cause){if(alive.current&&version===loadVersion.current)setError(clean(cause))}
    finally{if(alive.current)setLoading(false)}
  },[projectKey])
  useEffect(()=>{
    alive.current=true; generation.current++;saveError.current=false;current.current=null;setError('');setSnapshot(null);setLoading(true);void refresh()
    const off=window.electronAPI.onQaFindingsChanged?.(()=>void refresh()); const account=window.electronAPI.onAccountChanged?.(()=>{generation.current++;current.current=null;setSnapshot(null);setLoading(true);void refresh()})
    const timer=window.setInterval(()=>void refresh(),2500)
    return()=>{alive.current=false;generation.current++;loadVersion.current++;off?.();account?.();window.clearInterval(timer)}
  },[refresh])
  const update=useCallback((changes:FindingUpdate[], expectedRevision?:number)=>{
    const scope=generation.current;saveError.current=false;setSaving(true);setError('')
    const work=queue.current.catch(()=>{}).then(async()=>{
      if(scope!==generation.current)throw new Error('The project or account changed. Your edit was not saved.')
      const latest=current.current;if(!latest)throw new Error('Open a project to edit its findings.')
      if(expectedRevision!==undefined&&expectedRevision!==latest.revision)throw new Error('Findings changed while you were editing. Refresh and retry; your text is still available.')
      const result=await window.electronAPI.qaFindingsUpdate(latest.projectKey,latest.revision,changes)
      if(!result.success)throw new Error(result.error)
      if(alive.current&&scope===generation.current){loadVersion.current++;current.current=result.snapshot;setSnapshot(result.snapshot)}
      return true
    }).catch(cause=>{if(alive.current&&scope===generation.current){saveError.current=true;setError(clean(cause))}return false}).finally(()=>{if(alive.current)setSaving(false)})
    queue.current=work;return work
  },[])
  return {snapshot,loading,error,saving,refresh:()=>refresh(true),update}
}
