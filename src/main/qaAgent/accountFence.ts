import type { QaContext } from './tools'
function guard<T extends object>(value:T,assert:()=>void):T {
  return new Proxy(value,{get(target,key){const item=Reflect.get(target,key);if(typeof item!=='function')return item;return(...args:unknown[])=>{assert();const result=item.apply(target,args);if(result&&typeof result.then==='function')return Promise.resolve(result).then(value=>{assert();return value});assert();return result}}})
}
/** Bind individual reads/writes as well as the final tool response to the original account epoch. */
export function fenceQaContext(context:QaContext,assert:()=>void):QaContext {
  return {...context,assertAccess:assert,runs:guard(context.runs,assert),designs:guard(context.designs,assert),
    organizer:context.organizer?guard(context.organizer,assert):undefined,evidence:context.evidence?guard(context.evidence,assert):undefined,
    readLocalFile:async path=>{assert();const result=await context.readLocalFile(path);assert();return result},
    capture:async options=>{assert();const result=await context.capture(options);assert();return result},
    approve:async request=>{assert();const decision=await context.approve(request);assert();return decision},
    copyToClipboard:(text,html)=>{assert();context.copyToClipboard(text,html)},
  }
}
