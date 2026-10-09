import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCliModels } from './modelDiscovery'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-model-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }) })
function fixture(body: string) {
  const script = join(dir, 'cli.cjs')
  const log = join(dir, 'requests.jsonl')
  writeFileSync(script, `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));
    const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    require('readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');${body}});`)
  return { binary: process.execPath, prefixArgs: [script], timeoutMs: 15_000 }
}
const requests = () => readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
async function stopped() {
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
  for (let i = 0; i < 200; i++) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Discovery process remained alive')
}
describe('CLI model discovery', { timeout: 20_000 }, () => {
  it('reads Claude metadata, preserving aliases, without an inference prompt', async () => {
    const options = fixture(`out({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{models:[{value:'default',displayName:'Default'},{value:'sonnet',displayName:'Sonnet',description:'Balanced'},{value:'opus[1m]',displayName:'Opus'}]}}})`)
    expect(await discoverCliModels('claude-code', options)).toEqual({ models: ['sonnet', 'opus[1m]'], options: [{ id: 'sonnet', label: 'Sonnet', description: 'Balanced' }, { id: 'opus[1m]', label: 'Opus' }] })
    expect(requests()).toEqual([{ type: 'control_request', request_id: 'parity-models', request: { subtype: 'initialize' } }])
    await stopped()
  })
  it('initializes Codex, follows cursors, and keeps only visible unique models', async () => {
    const options = fixture(`if(request.method==='initialize')out({id:request.id,result:{}});
      if(request.method==='model/list')out({id:request.id,result:request.params.cursor?{data:[{id:'b',model:'gpt-b',displayName:'B'},{model:'gpt-a'}],nextCursor:null}:{data:[{id:'a',model:'gpt-a',displayName:'A',isDefault:true},{model:'hidden',hidden:true}],nextCursor:'page2'}});`)
    const result = await discoverCliModels('codex', options)
    expect(result.models).toEqual(['gpt-a', 'gpt-b'])
    expect(result.recommended).toBe('gpt-a')
    expect(requests().map(r => r.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
    expect(requests()[3].params.cursor).toBe('page2')
    await stopped()
  })
  it('stops repeated pagination cursors', async () => {
    const options = fixture(`if(request.id)out({id:request.id,result:request.method==='initialize'?{}:{data:[],nextCursor:'same'}})`)
    expect((await discoverCliModels('codex', options)).error).toContain('Could not load')
    expect(requests()).toHaveLength(4)
    await stopped()
  })
  it('bounds hung processes and terminates them', async () => {
    const options = fixture('')
    expect((await discoverCliModels('codex', { ...options, timeoutMs: 3000 })).error).toContain('too long')
    await stopped()
  })
  it('provides a fallback for missing installations', async () => {
    expect((await discoverCliModels('codex', { binary: join(dir, 'missing.exe') })).error).toContain('App default')
  })
  it('handles malformed protocol responses without exposing raw output', async () => {
    const options = fixture(`process.stdout.write('not json\\n');out(null);out({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{models:'bad'}}})`)
    expect(await discoverCliModels('claude-code', options)).toMatchObject({ models: [], error: expect.stringContaining('Update the CLI') })
    await stopped()
  })
  it('handles signed-out or unsupported protocol errors', async () => {
    const options = fixture(`out({id:request.id,error:{message:'private-account-detail'}})`)
    const result = await discoverCliModels('codex', options)
    expect(result.error).toContain('sign in')
    expect(result.error).not.toContain('private-account-detail')
    await stopped()
  })
  it('settles when the CLI exits before responding', async () => {
    const options = fixture('process.exit(1)')
    expect((await discoverCliModels('claude-code', options)).error).toContain('custom model')
    await stopped()
  })
})
