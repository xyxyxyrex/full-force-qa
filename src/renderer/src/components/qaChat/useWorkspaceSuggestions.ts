import { useEffect,useState } from 'react'
import { tokenizeQaCommand } from '../../../../shared/qaCommands'
import type { WorkspaceKind } from '../../../../shared/parityWorkspace'
export function useWorkspaceSuggestions(input:string) {
  const [choices,setChoices]=useState<Array<{value:string;label:string;description:string}>>([])
  useEffect(()=>{
    let alive=true;setChoices([])
    const match=/^\/(open|move|rename|trash|restore|create)\s+/.exec(input);if(!match)return
    let words:string[];try{words=tokenizeQaCommand(input)}catch{return}
    const trailing=/\s$/.test(input),last=trailing?'':words.at(-1)||'',rawLast=/("[^"]*"|'[^']*'|[^\s]+)$/.exec(input),base=trailing?input:input.slice(0,rawLast?.index??input.length),command=words[0]
    let kind:WorkspaceKind|undefined
    if(command==='/trash'||command==='/restore')kind='project'
    else if(command==='/create'&&words.at(trailing?-1:-2)==='--folder')kind='folder'
    else if(command==='/move'&&words.length+(trailing?1:0)>=4)kind='folder'
    else if(['/open','/move','/rename'].includes(command)&&['project','folder','note','ticket','capture','finding'].includes(words[1])&&words.length+(trailing?1:0)===3)kind=words[1] as WorkspaceKind
    if(!kind)return
    const owner=localStorage.getItem('parity_account_owner_key'),timer=window.setTimeout(()=>{
      void window.electronAPI.workspaceSearch({kinds:[kind!],query:last,includeTrash:command==='/restore',limit:8}).then(result=>{
        if(!alive||owner!==localStorage.getItem('parity_account_owner_key'))return
        const records=command==='/restore'?result.records.filter(r=>r.inTrash):result.records
        setChoices(records.map(r=>({value:`${base}"${r.id.replace(/"/g,'\\"')}" `,label:r.title,description:r.breadcrumb})))
      }).catch(()=>{})
    },250)
    return()=>{alive=false;window.clearTimeout(timer)}
  },[input])
  return choices
}
