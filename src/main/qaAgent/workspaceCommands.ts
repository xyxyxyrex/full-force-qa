import { randomUUID } from 'crypto'
import { parseQaCommand } from '../../shared/qaCommands'
import { PARITY_GUIDE } from '../../shared/parityGuide'
import { WORKSPACE_KINDS, folderBreadcrumb, type WorkspaceKind, type WorkspaceOperation, type WorkspaceQuery } from '../../shared/parityWorkspace'
import { deriveMultiCaptureName, normalizeMultiCaptureUrl, parseMultiCaptureInput } from '../../shared/multiCapture'
import type { QaContext } from './tools'

export async function runWorkspaceCommand(input:string,context:QaContext) {
  const parsed=parseQaCommand(input);if(!parsed)throw new Error('Choose a slash command.')
  const {command,args}=parsed;const workspace=context.workspace
  if(command==='/context')return {text:JSON.stringify(context.appContext?.()||{},null,2)}
  if(command==='/about'){if(args.length>1||!PARITY_GUIDE[args[0]||'overview'])throw new Error('Choose a Parity topic from /about suggestions.');return{text:PARITY_GUIDE[args[0]||'overview']}}
  if(!workspace)throw new Error('Workspace management is unavailable.')
  const kinds:Record<string,WorkspaceKind[]>={'/projects':['project'],'/folders':['folder'],'/captures':['capture'],'/findings':['finding'],'/notes':['note'],'/tickets':['ticket']}
  if(command==='/search'||kinds[command]){
    const query:WorkspaceQuery={kinds:kinds[command]};const words:string[]=[]
    for(let i=0;i<args.length;i++){if(args[i]==='--date'){query.date=args[++i];if(!query.date)throw new Error('Enter a date after --date.')}else if(args[i]==='--offset'){const n=Number(args[++i]);if(!Number.isInteger(n)||n<0||n>5000)throw new Error('Use an offset between 0 and 5000.');query.offset=n}else if(/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(args[i])&&command==='/captures')query.date=args[i];else if(args[i].startsWith('--'))throw new Error(`Unknown option ${args[i]}.`);else words.push(args[i])}
    query.query=words.join(' ');if(command==='/captures')query.dateField='captured'
    return {search:await workspace.search(query)}
  }
  async function resolve(kind:WorkspaceKind,name:string) {
    if(!name)throw new Error(`Enter a ${kind} name or ID.`)
    if(kind==='project'||kind==='folder'){const snapshot=await workspace!.snapshot(),entries=kind==='project'?snapshot.projects:snapshot.folders;const exact=entries.filter(e=>e.id===name||e.name.toLocaleLowerCase()===name.toLocaleLowerCase()||(kind==='folder'&&folderBreadcrumb(snapshot.folders,e.id).toLocaleLowerCase()===name.toLocaleLowerCase()));if(exact.length!==1)throw new Error(exact.length?'More than one item has this name. Use its ID or folder breadcrumb.':'No matching item. Search first and use the returned ID.');return{id:exact[0].id,kind}}
    const results=await workspace!.search({kinds:[kind],query:name,limit:50,includeTrash:true}),exact=results.records.filter(r=>r.id===name||r.title.toLocaleLowerCase()===name.toLocaleLowerCase());if(exact.length!==1)throw new Error('Search first and use a unique item name or ID.');return{kind,id:exact[0].id,projectId:exact[0].projectId}
  }
  const destination=async(name?:string)=>!name||/^home$/i.test(name)?undefined:(await resolve('folder',name)).id
  if(command==='/open'){if(args.length!==2||!WORKSPACE_KINDS.includes(args[0] as WorkspaceKind))throw new Error('Use /open project|folder|note|ticket|finding|capture "name or ID".');await workspace.open(await resolve(args[0] as WorkspaceKind,args[1]));return{text:'Opened in Parity.'}}
  const operations:WorkspaceOperation[]=[]
  if(command==='/create'){
    const kind=args[0];const words:string[]=[];let parent:string|undefined,name:string|undefined
    for(let i=1;i<args.length;i++){if(args[i]==='--folder'){if(!args[i+1])throw new Error('Choose a destination folder.');parent=await destination(args[++i])}else if(args[i]==='--name'){name=args[++i];if(!name)throw new Error('Enter a name.')}else if(args[i].startsWith('--'))throw new Error(`Unknown option ${args[i]}.`);else words.push(args[i])}
    if(kind==='folder'){if(words.length!==1)throw new Error('Use /create folder "name" [--folder "parent"].');operations.push({type:'create-folder',id:randomUUID(),name:words[0],parentId:parent})}
    else if(kind==='project'){const entries=parseMultiCaptureInput(words.join(' '));if(!entries.length)throw new Error('Paste at least one website link.');for(const entry of entries){const normalized=normalizeMultiCaptureUrl(entry.value);if(entry.error||!normalized.url)throw new Error(entry.error||normalized.error||'Invalid URL.');operations.push({type:'create-project',id:randomUUID(),url:normalized.url,name:name||deriveMultiCaptureName(normalized.url),folderId:parent})}}
    else throw new Error('Choose /create project or /create folder.')
  }else if(command==='/rename'||command==='/move'){
    if(args.length!==3||!['project','folder'].includes(args[0]))throw new Error(`Use ${command} project|folder "name or ID" "${command==='/move'?'destination folder':'new name'}".`)
    const target=await resolve(args[0] as 'project'|'folder',args[1]);if(command==='/rename')operations.push({type:'rename',kind:args[0] as 'project'|'folder',id:target.id,name:args[2]});else operations.push({type:'move',kind:args[0] as 'project'|'folder',id:target.id,folderId:await destination(args[2])})
  }else if(command==='/trash'||command==='/restore'){if(args.length!==1)throw new Error(`Use ${command} "project name or ID".`);operations.push({type:command==='/trash'?'trash':'restore',id:(await resolve('project',args[0])).id})}
  else throw new Error('This command is handled by the chat controls.')
  return {proposal:await workspace.propose(operations,'Review workspace changes')}
}
