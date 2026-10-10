/** A private catalog read must not become model-driven network payload without a person reviewing it. */
export function needsPrivateDataApproval(name:string,args:unknown,pageUrl?:string) {
  const value=args&&typeof args==='object'?args as Record<string,unknown>:{}
  if(['browser_type','browser_select','http_request'].includes(name))return true
  if(name==='browser_open'&&typeof value.url==='string') {try{return new URL(value.url,pageUrl).href!==pageUrl}catch{return true}}
  return false
}
