import { folderBreadcrumb, planWorkspaceChanges, projectRecord, WORKSPACE_KINDS } from '../../../src/shared/parityWorkspace.ts'
const UUID=/^[a-f\d-]{36}$/i
export async function workspaceAction(admin:any,owner:string,action:string,body:any):Promise<any> {
  const rpc=async(name:string,args:any)=>{const{data,error}=await admin.rpc(name,args);if(error)throw error;return data}
  if(action==='workspace_snapshot')return rpc('parity_workspace_snapshot',{p_owner_key:owner})
  if(action==='workspace_search') {
    const q=body.query||{};if(typeof q.query!=='undefined'&&(typeof q.query!=='string'||q.query.length>500))throw new Error('Use a shorter search.')
    const kinds=Array.isArray(q.kinds)?q.kinds.filter((v:string)=>WORKSPACE_KINDS.includes(v as any)):[]
    const result=await rpc('search_parity_workspace',{p_owner_key:owner,p_query:q.query||'',p_kinds:kinds,p_from:Number.isFinite(q.from)?q.from:null,p_to:Number.isFinite(q.to)?q.to:null,p_date_field:['created','captured','opened'].includes(q.dateField)?q.dateField:'created',p_include_trash:q.includeTrash===true,p_offset:Math.max(0,Math.min(5000,Math.floor(q.offset||0))),p_limit:Math.max(1,Math.min(50,Math.floor(q.limit||20)))})
    const{data:state,error}=await admin.from('parity_user_state').select('data').eq('owner_key',owner).maybeSingle();if(error)throw error
    const folders=state?.data?.folders||[]
    result.records=result.records.map((r:any)=>{let breadcrumb='Home';try{breadcrumb=folderBreadcrumb(folders,r.kind==='folder'?r.id:r.folderId)}catch{breadcrumb='Missing folder'}delete r.folderId;if(r.url){try{const url=new URL(r.url);url.username='';url.password='';r.url=url.href}catch{delete r.url}}return{...r,breadcrumb}})
    return result
  }
  if(action==='workspace_detail') {
    if(typeof body.id!=='string'||!body.id||body.id.length>200)throw new Error('Invalid record ID.')
    if(body.kind==='folder') {const snapshot=await rpc('parity_workspace_snapshot',{p_owner_key:owner});const f=snapshot.folders.find((f:any)=>f.id===body.id);if(!f)throw new Error('Record unavailable.');return{record:{...f,breadcrumb:folderBreadcrumb(snapshot.folders,f.id)}}}
    if(body.kind==='capture') {const{data,error}=await admin.from('parity_capture_activity').select('event_id,project_id,url,engine,completed_at').eq('owner_key',owner).eq('event_id',body.id).maybeSingle();if(error)throw error;if(!data)throw new Error('Record unavailable.');return{record:data}}
    const tables:Record<string,string>={project:'parity_projects',note:'parity_notes',ticket:'parity_tickets'},columns:Record<string,string>={project:'project_id',note:'note_id',ticket:'ticket_id'}
    if(!tables[body.kind])throw new Error('Unsupported record type.')
    const{data,error}=await admin.from(tables[body.kind]).select('data').eq('owner_key',owner).eq(columns[body.kind],body.id).maybeSingle();if(error)throw error;if(!data)throw new Error('Record unavailable.')
    const d=data.data
    // The assistant never receives credentials, captured HTML, raw file paths, or arbitrary note HTML.
    if(body.kind==='project') {const{data:state}=await admin.from('parity_user_state').select('data').eq('owner_key',owner).maybeSingle();return{record:projectRecord(d,state?.data?.folders||[],'cloud')}}
    if(body.kind==='note')return{record:{id:d.id,title:d.title,plainText:d.plainText,tags:d.tags,createdAt:d.createdAt,updatedAt:d.updatedAt,attachments:(d.attachments||[]).map((a:any)=>({id:a.id,name:a.name,mimeType:a.mimeType}))}}
    return{record:{id:d.id,title:d.title,description:d.description,sourceStatus:d.sourceStatus,sourceGroup:d.sourceGroup,progress:d.progress,createdAt:d.createdAt}}
  }
  if(action==='workspace_record_capture') {
    const a=body.activity;if(!a||!UUID.test(a.id)||typeof a.projectId!=='string'||typeof a.url!=='string'||a.url.length>8000||!/^https?:\/\//i.test(a.url)||typeof a.engine!=='string'||a.engine.length>40||!Number.isSafeInteger(a.completedAt)||a.completedAt<=0||a.completedAt>Date.now()+60000)throw new Error('Invalid capture activity.')
    const{error}=await admin.from('parity_capture_activity').upsert({owner_key:owner,event_id:a.id,project_id:a.projectId,url:a.url,engine:a.engine,completed_at:a.completedAt},{onConflict:'owner_key,event_id',ignoreDuplicates:true});if(error)throw error;return{success:true}
  }
  if(action==='workspace_operation_status') {if(!UUID.test(body.operationId))throw new Error('Invalid operation ID.');const{data,error}=await admin.from('parity_workspace_operations').select('result').eq('owner_key',owner).eq('operation_id',body.operationId).maybeSingle();if(error)throw error;return data?.result||{pending:false}}
  if(action==='workspace_apply') {
    if(!UUID.test(body.operationId)||!Number.isSafeInteger(body.revision)||!Number.isSafeInteger(body.createdAt)||body.createdAt<=0)throw new Error('Invalid reviewed operation.')
    const bytes=new TextEncoder().encode(JSON.stringify({operations:body.operations,createdAt:body.createdAt,revision:body.revision}));const digest=await crypto.subtle.digest('SHA-256',bytes);const requestHash=Array.from(new Uint8Array(digest)).map(v=>v.toString(16).padStart(2,'0')).join('')
    const{data:prior,error:priorError}=await admin.from('parity_workspace_operations').select('request_hash,result').eq('owner_key',owner).eq('operation_id',body.operationId).maybeSingle();if(priorError)throw priorError
    if(prior){if(prior.request_hash!==requestHash)throw new Error('Operation ID was already used.');return prior.result}
    const snapshot=await rpc('parity_workspace_snapshot',{p_owner_key:owner});if(snapshot.revision!==body.revision)throw new Error('The workspace changed. Request a refreshed preview before applying.')
    const plan=planWorkspaceChanges(snapshot,body.operations,body.createdAt)
    return rpc('apply_parity_workspace_changes',{p_owner_key:owner,p_operation_id:body.operationId,p_request_hash:requestHash,p_revision:body.revision,p_folders:plan.snapshot.folders,p_projects:plan.projects})
  }
  return null
}
