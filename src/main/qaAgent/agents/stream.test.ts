import { describe, expect, it } from 'vitest'
import { readCompletionStream } from './stream'
const response=(frames:unknown[])=>new Response(frames.map(frame=>'data: '+(typeof frame==='string'?frame:JSON.stringify(frame))+'\r\n\r\n').join(''),{headers:{'content-type':'text/event-stream'}})
describe('completion streams',()=>{
  it('streams text and assembles split tool arguments only after completion',async()=>{
    const text:string[]=[]
    const result=await readCompletionStream(response([
      {choices:[{delta:{content:'Checking '}}]}, {choices:[{delta:{content:'now.'}}]},
      {choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'get_section',arguments:'{"section"'}}]}}]},
      {choices:[{delta:{tool_calls:[{index:0,function:{arguments:':"S1"}'}}]},finish_reason:'tool_calls'}]},
      {choices:[],usage:{prompt_tokens:100,completion_tokens:20}},'[DONE]',
    ]),delta=>text.push(delta))
    expect(text).toEqual(['Checking ','now.']);expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"section":"S1"}')
    expect(result.usage.prompt_tokens).toBe(100)
  })
  it('rejects a dropped or malformed stream, preserving already visible text',async()=>{
    const text:string[]=[]
    await expect(readCompletionStream(response([{choices:[{delta:{content:'Partial'}}]}]),delta=>text.push(delta))).rejects.toThrow('ended early')
    expect(text).toEqual(['Partial'])
    await expect(readCompletionStream(response(['not-json']),()=>{})).rejects.toThrow('incomplete')
  })
})
