import { useEffect, useRef, useState } from 'react'
import { AGENT_IDS, type AgentsOverview, type ChatAgentSelection } from '../../../../shared/qaAgent'
import AgentIcon, { AGENT_NAMES } from '../agents/AgentIcon'
import AgentModelPicker from '../agents/AgentModelPicker'
import { EMPTY_MODELS, useModelDiscovery } from '../agents/useModelDiscovery'
import { qaChat, useQaChat } from '../qaChatStore'
import '../AgentsPanel.css'

export default function ChatModelPicker() {
  const chat=useQaChat(), [overview,setOverview]=useState<AgentsOverview|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const box=useRef<HTMLDivElement>(null), discovery=useModelDiscovery()
  const alive=useRef(true),version=useRef(0)
  const load=()=>{const request=++version.current;void window.electronAPI.qaAgentsOverview().then(value=>{if(alive.current&&request===version.current)setOverview(value)}).catch(()=>{if(alive.current&&request===version.current)setError('Could not load agents. Open Settings → Agents or try again.')})}
  useEffect(()=>{load();const show=()=>setOpen(true);window.addEventListener('parity:choose-chat-agent',show);const outside=(e:PointerEvent)=>{if(!box.current?.contains(e.target as Node))setOpen(false)};document.addEventListener('pointerdown',outside);return()=>{window.removeEventListener('parity:choose-chat-agent',show);document.removeEventListener('pointerdown',outside)}},[])
  useEffect(()=>{load()},[chat.selectedAgentLabel])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;version.current++}},[])
  useEffect(()=>{AGENT_IDS.forEach(discovery.invalidate);load()},[chat.configVersion])
  const id=chat.selection?.agent||overview?.settings.defaultAgent||'codex', model=chat.selection?.model??overview?.settings.models[id]??''
  const agent=overview?.agents.find(a=>a.id===id)
  const choose=async(selection:ChatAgentSelection|null)=>{
    if(busy)return false;setBusy(true);setError('');try{const chatId=qaChat.ensureChat(), result=await window.electronAPI.qaChatSelection(chatId,selection);if(!alive.current||qaChat.getState().chatId!==chatId)return false;qaChat.handle({type:'chat-selection',chatId,selection:result.selection,label:result.label,switching:chat.running});return true}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not switch agents. Try again.');return false}finally{if(alive.current)setBusy(false)}
  }
  return <div className="qa-composer-models" ref={box} aria-label="Agent for this chat">
    <div className="qa-composer-model-row"><button type="button" className="qa-provider-trigger" aria-haspopup="listbox" aria-expanded={open} disabled={busy} onClick={()=>{setOpen(!open);load()}} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);load();window.setTimeout(()=>box.current?.querySelector<HTMLButtonElement>('.qa-provider-menu [aria-selected=true]')?.focus(),0)}}}><AgentIcon id={id}/><span>{AGENT_NAMES[id]}</span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
    {agent&&<AgentModelPicker key={id} agent={agent} value={model} state={discovery.results[id]||EMPTY_MODELS} load={()=>void discovery.load(id)} save={value=>choose({agent:id,model:value})} active disabled={busy}/>}
    </div>
    <div className="qa-composer-model-caption"><span>{chat.switching?'Switching · keeping completed work':chat.selection?'For this chat':'Settings default'}</span>{chat.selection&&<button type="button" disabled={busy} onClick={()=>void choose(null)}>Use Settings default</button>}</div>
    {open&&<div className="qa-provider-menu" role="listbox" aria-label="Choose chat agent" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false);box.current?.querySelector<HTMLButtonElement>('.qa-provider-trigger')?.focus()}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const buttons=[...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];const n=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(n+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus()}}}>
      {AGENT_IDS.map(agentId=>{const item=overview?.agents.find(a=>a.id===agentId);return <button role="option" type="button" aria-selected={id===agentId} key={agentId} disabled={busy} onClick={()=>{void choose({agent:agentId,model:overview?.settings.models[agentId]||''});setOpen(false)}}><AgentIcon id={agentId}/><span>{AGENT_NAMES[agentId]}<small>{item?.ready?'Connected':item?.detail||'Configure in Settings'}</small></span>{id===agentId&&<span aria-hidden="true">✓</span>}</button>})}
    </div>}
    {error&&<div role="alert" className="qa-action-error">{error}<button type="button" onClick={load}>Retry</button></div>}
  </div>
}
