import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { NoteDocument, Project, ProjectFolder } from '../shared/types'
import { folderBreadcrumb, matchesWorkspaceRecord, planWorkspaceChanges, projectRecord, selectWorkspaceRecords, workspaceDateRange, workspaceRecordLink, type CaptureActivity, type WorkspaceApplyResult, type WorkspaceNavigation, type WorkspaceOperation, type WorkspaceProposal, type WorkspaceQuery, type WorkspaceRecord, type WorkspaceSnapshot } from '../shared/parityWorkspace'

interface Options {
  root: string; owner(): string | null; fence(): () => void; projects(): Project[]; saveProject(project: Project): void
  request(action: string, payload?: Record<string,unknown>): Promise<any>
  localRecords?(): WorkspaceRecord[]; detailLocal?(kind: string,id: string,projectId?: string): unknown
  changed(snapshot: WorkspaceSnapshot): void; navigate(target: WorkspaceNavigation): void; now?(): number
}
interface Cached { folders: ProjectFolder[]; revision: number; captures: CaptureActivity[]; pendingCaptures: CaptureActivity[]; records: WorkspaceRecord[]; notes?:Record<string,{note:Partial<NoteDocument>;pending:boolean}> }
interface StoredProposal { owner: string; proposal: WorkspaceProposal; operations: WorkspaceOperation[]; fingerprint: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const safeError = (error: unknown) => error instanceof Error ? error.message : 'The account service is unavailable. Check your connection and try again.'

export function createWorkspaceService(options: Options) {
  const now = options.now || Date.now
  const owner = () => { const value = options.owner(); if (!value) throw new Error('Sign in to Parity to search or manage your workspace.'); return value }
  const file = (key: string, name: string) => join(options.root, hash(key), `${name}.json`)
  const read = <T>(key: string,name: string,fallback: T): T => { try { return JSON.parse(readFileSync(file(key,name),'utf8')) as T } catch { return fallback } }
  const write = (key: string,name: string,value: unknown) => { const path = file(key,name); mkdirSync(join(options.root,hash(key)),{recursive:true}); writeFileSync(path+'.tmp',JSON.stringify(value)); renameSync(path+'.tmp',path) }
  const cache = (key: string): Cached => read(key,'catalog',{ folders:[],revision:0,captures:[],pendingCaptures:[],records:[] })
  const localSnapshot = (key: string): WorkspaceSnapshot => { const c=cache(key); return {projects:options.projects(),folders:c.folders,revision:c.revision} }
  const fingerprint = (snapshot: WorkspaceSnapshot) => hash({ revision:snapshot.revision,folders:snapshot.folders,projects:snapshot.projects.map(p=>({id:p.id,updatedAt:p.updatedAt,folderId:p.folderId,name:p.name,inTrash:p.inTrash})) })
  const requireProposal = (id: string): StoredProposal => { if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid proposal ID.'); const key=owner(), saved=read<StoredProposal|null>(key,`proposal-${id}`,null); if (!saved || saved.owner!==key) throw new Error('This action is not available in this account.'); return saved }
  async function snapshot(refresh = true): Promise<WorkspaceSnapshot> {
    const key=owner(), assert=options.fence()
    if (!refresh) return localSnapshot(key)
    const result=await options.request('workspace_snapshot'); assert()
    if (!Array.isArray(result.projects)||!Array.isArray(result.folders)||!Number.isInteger(result.revision)) throw new Error('Update the Parity account service to enable workspace management.')
    const c=cache(key); c.folders=result.folders; c.revision=result.revision; write(key,'catalog',c)
    const localById=new Map(options.projects().map(p=>[p.id,p]))
    for(const p of result.projects) { const local=localById.get(p.id); if(!local||(p.updatedAt||0)>=(local.updatedAt||0)) options.saveProject({...local,...p,folderId:p.folderId,deletedAt:p.deletedAt,thumbnailUrl:local?.thumbnailUrl||p.thumbnailUrl}) }
    return { projects:options.projects(),folders:c.folders,revision:c.revision }
  }
  function localRecords(key: string): WorkspaceRecord[] {
    const c=cache(key), projects=options.projects()
    return [
      ...projects.map(p=>projectRecord(p,c.folders,'cached')),
      ...c.folders.map(f=>({kind:'folder' as const,id:f.id,title:f.name,breadcrumb:folderBreadcrumb(c.folders,f.id),createdAt:f.createdAt,source:'cached' as const})),
      ...c.captures.filter(a=>projects.some(p=>p.id===a.projectId)).map(a=>({kind:'capture' as const,id:a.id,projectId:a.projectId,title:projects.find(p=>p.id===a.projectId)!.name,url:a.url,breadcrumb:'Capture history',capturedAt:a.completedAt,excerpt:`${a.engine} capture`,inTrash:!!projects.find(p=>p.id===a.projectId)?.inTrash,source:'cached' as const})),
      ...Object.values(c.notes||{}).map(({note})=>({kind:'note' as const,id:note.id!,title:note.title||'Untitled note',breadcrumb:'Notes',excerpt:note.plainText,createdAt:note.createdAt,updatedAt:note.updatedAt,source:'cached' as const})),
      ...(options.localRecords?.()||[]),
    ]
  }
  async function search(input: WorkspaceQuery) {
    const key=owner(), assert=options.fence(); const query={...input}
    if(query.date) Object.assign(query,workspaceDateRange(query.date))
    if(query.date && !query.dateField) query.dateField=query.kinds?.includes('capture')?'captured':'created'
    const count=Math.max(1,Math.min(50,query.limit||20)), offset=Math.max(0,Math.floor(query.offset||0))
    if(offset>5000) throw new Error('Narrow your search before requesting more results.')
    let source:'cloud'|'cached'='cloud', warning:string|undefined, remote:WorkspaceRecord[]=[]
    try {
      void flushCaptures().catch(()=>{});assert()
      for(let start=0;start<offset+count+1;start+=50) {
        const page=await options.request('workspace_search',{query:{...query,date:undefined,offset:start,limit:50}}); assert()
        if(!Array.isArray(page.records)) throw new Error('Workspace search is not available on the account service yet.')
        remote.push(...page.records.map((r:WorkspaceRecord)=>({...r,source:'cloud' as const})))
        if(page.nextOffset===null) break
      }
      const c=cache(key), lookup=new Map(c.records.map(r=>[`${r.kind}:${r.id}`,r])); remote.forEach(r=>lookup.set(`${r.kind}:${r.id}`,r)); c.records=[...lookup.values()].slice(-1000); write(key,'catalog',c)
    } catch(error) { assert(); source='cached'; warning=`Using this account’s cached records; cloud results may be missing. ${safeError(error)}`; remote=cache(key).records.map(r=>({...r,source:'cached'})) }
    assert()
    const merged=new Map<string,WorkspaceRecord>()
    remote.filter(r=>source==='cloud'||matchesWorkspaceRecord(r,query)).forEach(r=>merged.set(`${r.kind}:${r.id}`,r))
    localRecords(key).forEach(r=>{const prior=merged.get(`${r.kind}:${r.id}`);if(!prior||r.kind==='finding'||(r.updatedAt||0)>(prior.updatedAt||0)){if(matchesWorkspaceRecord(r,query))merged.set(`${r.kind}:${r.id}`,r);else if(prior&&(r.updatedAt||0)>(prior.updatedAt||0))merged.delete(`${r.kind}:${r.id}`)}})
    const result=selectWorkspaceRecords([...merged.values()],{...query,query:undefined,limit:count,offset})
    return {...result,records:result.records.map(r=>{const index=(r.excerpt||'').toLowerCase().indexOf((query.query||'').split(/\s+/)[0].toLowerCase());return {...r,excerpt:r.excerpt?.slice(Math.max(0,index-80),Math.max(0,index-80)+600),href:workspaceRecordLink(r)}}),source,warning,dateLabel:(query as WorkspaceQuery&{dateLabel?:string}).dateLabel}
  }
  async function detail(kind: string,id: string,projectId?: string,offset=0) {
    const key=owner(), assert=options.fence(); if(!id||id.length>200||offset<0||offset>1_000_000)throw new Error('Invalid record reference.')
    let value:unknown
    if(kind==='note'&&cache(key).notes?.[id]?.pending)value=cache(key).notes![id].note
    if(kind==='finding')value=options.detailLocal?.(kind,id,projectId)
    else if(kind==='capture')value=cache(key).captures.find(a=>a.id===id)
    if(value===undefined) {
      try { const result=await options.request('workspace_detail',{kind,id}); assert(); value=result.record; if(value)write(key,`detail-${hash([kind,id])}`,value) }
      catch(error) { assert(); if(kind==='project') { const p=options.projects().find(p=>p.id===id); if(p)value=projectRecord(p,cache(key).folders,'cached') }
        else if(kind==='folder')value=cache(key).folders.find(f=>f.id===id)
        else value=kind==='note'?cache(key).notes?.[id]?.note:options.detailLocal?.(kind,id,projectId)
        value ||= read(key,`detail-${hash([kind,id])}`,null)
        if(!value)throw error
      }
    }
    assert(); if(!value)throw new Error('This record is unavailable in the current account.')
    const content=typeof value==='string'?value:JSON.stringify(value), page=content.slice(offset,offset+16000)
    return {kind,id,projectId,content:page,total:content.length,nextOffset:offset+16000<content.length?offset+16000:null,untrusted:true}
  }
  async function propose(operations: WorkspaceOperation[], title='Workspace changes'): Promise<WorkspaceProposal> {
    const key=owner(), assert=options.fence(), current=await snapshot(); assert()
    const planned=planWorkspaceChanges(current,operations,now()), id=randomUUID()
    const proposal:WorkspaceProposal={id,title:title.slice(0,120),changes:planned.changes,status:'pending',revision:current.revision,createdAt:now()}
    const saved:StoredProposal={owner:key,proposal,operations,fingerprint:fingerprint(current)}
    write(key,`proposal-${id}`,saved); return proposal
  }
  const inFlight=new Map<string,Promise<WorkspaceApplyResult>>()
  async function applyWork(id:string):Promise<WorkspaceApplyResult> {
    const key=owner(), assert=options.fence(), saved=requireProposal(id)
    if(saved.proposal.status==='applied')return {success:true,proposal:saved.proposal,snapshot:localSnapshot(key)}
    if(saved.proposal.status==='cancelled')return {success:false,proposal:saved.proposal}
    try {
      // Resolve an uncertain result before attempting another mutation.
      if(saved.proposal.status==='uncertain'||saved.proposal.status==='applying') {
        const status=await options.request('workspace_operation_status',{operationId:id}); assert()
        if(status.snapshot) {const latest=await snapshot();assert();return complete(latest)}
        saved.proposal.status='pending'
      }
      const current=await snapshot(); assert()
      if(fingerprint(current)!==saved.fingerprint) throw new Error('The affected workspace changed. Request a refreshed preview before applying.')
      saved.proposal.status='applying'; saved.proposal.error=undefined; write(key,`proposal-${id}`,saved)
      let result:any
      try { result=await options.request('workspace_apply',{operationId:id,revision:saved.proposal.revision,operations:saved.operations,createdAt:saved.proposal.createdAt}) }
      catch(error) { assert();const status=(error as {status?:number})?.status;saved.proposal.status=status&&status>=400&&status<500?'failed':'uncertain';throw error }
      assert(); return complete(result.snapshot)
    } catch(error) {
      assert(); if(saved.proposal.status!=='uncertain')saved.proposal.status='failed'
      saved.proposal.error=saved.proposal.status==='uncertain'?'Check result before retrying. The account service did not confirm whether changes finished.':safeError(error)
      write(key,`proposal-${id}`,saved); return {success:false,proposal:saved.proposal}
    }
    function complete(value:WorkspaceSnapshot):WorkspaceApplyResult {
      assert(); if(!value||!Array.isArray(value.projects)||!Array.isArray(value.folders))throw new Error('The account service returned an invalid result.')
      const c=cache(key); c.folders=value.folders;c.revision=value.revision;write(key,'catalog',c)
      const localById=new Map(options.projects().map(p=>[p.id,p]))
      value.projects.forEach(p=>{const local=localById.get(p.id);if(!local||(p.updatedAt||0)>=(local.updatedAt||0))options.saveProject({...local,...p,folderId:p.folderId,deletedAt:p.deletedAt})});saved.proposal.status='applied';saved.proposal.error=undefined;write(key,`proposal-${id}`,saved)
      const current={...value,projects:options.projects()};options.changed(current);return {success:true,proposal:saved.proposal,snapshot:current}
    }
  }
  async function apply(id:string) { const key=`${owner()}:${id}`; if(inFlight.has(key))return inFlight.get(key)!; const job=applyWork(id);inFlight.set(key,job);try{return await job}finally{inFlight.delete(key)} }
  function cancel(id:string) {const saved=requireProposal(id);if(saved.proposal.status==='applying'||saved.proposal.status==='uncertain')throw new Error('Check the operation result before cancelling.');if(saved.proposal.status!=='applied'){saved.proposal.status='cancelled';write(saved.owner,`proposal-${id}`,saved)}return saved.proposal}
  async function refresh(id:string){const saved=requireProposal(id);if(['applied','applying','uncertain'].includes(saved.proposal.status))throw new Error('Check the existing action result before requesting another preview.');const proposal=await propose(saved.operations,saved.proposal.title);cancel(id);return proposal}
  async function open(target:WorkspaceNavigation) {
    const assert=options.fence();const result=await detail(target.kind,target.id,target.projectId);assert()
    if(target.kind==='project') {try{await snapshot()}catch{assert()}}
    if(target.kind==='capture'&&!target.projectId){const capture=JSON.parse(result.content);target={...target,projectId:capture.projectId||capture.project_id}}
    if(target.kind==='project'&&options.projects().find(p=>p.id===target.id)?.inTrash)throw new Error('Restore this project before opening it.')
    options.navigate(target);return {opened:true,kind:target.kind,id:target.id,capture:!!target.capture}
  }
  async function recordCapture(activity:CaptureActivity) {
    const url=new URL(activity.url);url.username='';url.password='';activity={...activity,url:url.href}
    const key=owner();if(!options.projects().some(p=>p.id===activity.projectId))throw new Error('Capture project does not belong to this account.')
    const c=cache(key);if(c.captures.some(a=>a.id===activity.id))return
    c.captures.push(activity);c.pendingCaptures.push(activity);write(key,'catalog',c);await flushCaptures()
  }
  async function flushCaptures() {
    const key=owner(), assert=options.fence(), c=cache(key)
    for(const activity of c.pendingCaptures) {
      assert()
      try {await options.request('workspace_record_capture',{activity});assert();const latest=cache(key);latest.pendingCaptures=latest.pendingCaptures.filter(a=>a.id!==activity.id);write(key,'catalog',latest)}catch(error){assert();break}
    }
  }
  function adopt(folders:ProjectFolder[],revision?:number) {const key=options.owner();if(!key)return;const c=cache(key);c.folders=folders;if(revision!==undefined)c.revision=revision;write(key,'catalog',c)}
  function noteMetadata(note:NoteDocument):Partial<NoteDocument>{if(!note||typeof note.id!=='string'||note.id.length>200||typeof note.plainText!=='string'||note.plainText.length>1_500_000)throw new Error('Invalid or oversized note.');return{id:note.id,title:note.title,plainText:note.plainText,tags:note.tags,createdAt:note.createdAt,updatedAt:note.updatedAt}}
  function cacheNote(note:NoteDocument,pending=true){const key=owner(),metadata=noteMetadata(note),c=cache(key);c.notes||={};if((c.notes[note.id]?.note.updatedAt||0)>(note.updatedAt||0))return;c.notes[note.id]={note:metadata,pending};write(key,'catalog',c)}
  function adoptNotes(notes:NoteDocument[]){if(!options.owner())return;const key=owner(),c=cache(key),ids=new Set(notes.map(n=>n.id));c.notes=Object.fromEntries(Object.entries(c.notes||{}).filter(([id,value])=>ids.has(id)||value.pending));for(const note of notes){if((c.notes[note.id]?.note.updatedAt||0)<=(note.updatedAt||0))c.notes[note.id]={note:noteMetadata(note),pending:false}}write(key,'catalog',c)}
  function forgetNote(id:string){const key=owner(),c=cache(key);if(c.notes)delete c.notes[id];c.records=c.records.filter(r=>r.kind!=='note'||r.id!==id);write(key,'catalog',c)}
  return {search,detail,snapshot,propose,apply,cancel,refresh,open,recordCapture,flushCaptures,adopt,cacheNote,adoptNotes,forgetNote,getProposal:(id:string)=>requireProposal(id).proposal}
}
export type WorkspaceService=ReturnType<typeof createWorkspaceService>
