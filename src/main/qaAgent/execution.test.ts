import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QaExecution, ToolScheduler } from './execution'
import { createFakeContext } from './testSupport'
import type { ProviderRun } from './agents/types'
import type { QaRunEvent } from '../../shared/qaAgent'

let folder: string
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'parity-execution-')) })
afterEach(() => rmSync(folder, { recursive: true, force: true }))
function fixture() {
  const fake = createFakeContext(folder); const events: QaRunEvent[] = []; const controller = new AbortController()
  const execution = new QaExecution(join(folder, 'execution'), 'page-and-design', { kind: 'chat', message: 'Check this' })
  execution.begin(fake.context, controller.signal, event => events.push(event))
  return { ...fake, events, controller, execution, context: execution.wrapContext(fake.context) }
}
describe('execution checkpoints and output', () => {
  it('reuses immutable results while preserving every output character through paging', async () => {
    const f = fixture(); let calls = 0; const text = 'Finding details '.repeat(4000)
    const work = async () => { calls++; return { text } }
    const one = await f.execution.dispatch('get_section', { runId: 'r', section: 'S1' }, work)
    await f.execution.dispatch('get_section', { runId: 'r', section: 'S1' }, work)
    expect(calls).toBe(1); expect(one.text.length).toBeLessThan(text.length)
    const result = f.events.find(event => event.type === 'tool-result') as Extract<QaRunEvent, {type:'tool-result'}>
    let restored = ''; let offset: number | null = 0
    while (offset !== null) { const page = f.execution.readResult(result.resultId!, offset); restored += page.text; offset = page.nextOffset }
    expect(restored).toBe(text)
    expect(() => f.execution.readResult('../secret')).toThrow()
  })
  it('keeps completed stages and resumes a failed API checkpoint after reopening', async () => {
    const f = fixture(); let calls = 0
    const provider = { id: 'api', label: 'API', async run(run: ProviderRun) { calls++; if (run.task === 'failed' && !run.resume) { run.checkpoint?.({ completeMessages: ['saved'] }); throw new Error('connection failed') } return { stopped: 'finished' as const, text: 'done' } } }
    const run = (task: string): ProviderRun => ({ system: 'rules', task, tools: ['get_context'], signal: f.controller.signal, maxTurns: 5, emit: () => {}, call: async () => ({text:'ok'}) })
    const wrapped = f.execution.wrapProvider(provider)
    await wrapped.run(run('complete')); await expect(wrapped.run(run('failed'))).rejects.toThrow('connection')
    f.execution.finish()
    const loaded = QaExecution.load(join(folder, 'execution'), f.execution.state.id)!
    loaded.begin(f.context, f.controller.signal, () => {})
    await loaded.wrapProvider(provider).run(run('complete')); await loaded.wrapProvider(provider).run(run('failed'))
    expect(calls).toBe(3)
    expect(loaded.snapshot().attempt).toBe(2)
    expect(loaded.validate('different-page')).toContain('changed')
  })
  it('does not duplicate a saved draft or its findings when retried', async () => {
    const f = fixture(); let writes = 0
    const args = {runId:'r',breakpoint:'desktop',rows:[{cells:{Issue:'Heading'}}]}
    const work = async () => { writes++; return {text:'Saved'} }
    await f.execution.dispatch('save_draft', args, work); await f.execution.dispatch('save_draft', args, work)
    expect(writes).toBe(1)
    expect(f.events.filter(e => e.type === 'findings')).toHaveLength(1) // findings are not duplicated by a cached receipt
    const calls = f.events.filter(e => e.type === 'tool') as Array<Extract<QaRunEvent,{type:'tool'}>>
    expect(new Set(calls.map(call => call.callId)).size).toBe(2)
  })
  it('reuses run identity on subsequent attempts', () => {
    const f = fixture(); const input = {projectKey:'p',projectName:'Page',pageUrl:'https://example.test/'}
    const first = f.context.runs.create(input)
    f.execution.finish(); f.execution.begin(f.context, f.controller.signal, () => {})
    expect(f.execution.wrapContext(f.context).runs.create(input).id).toBe(first.id)
  })
  it('blocks replay when a site submission may have happened', async () => {
    const f = fixture(); f.context.allowSend = () => true
    f.execution.begin(f.context, f.controller.signal, () => {})
    await f.execution.dispatch('http_request', {method:'POST',url:'/submit'}, async () => ({text:'connection ended',isError:true}))
    expect(f.execution.validate('page-and-design')).toContain('Check result')
  })
  it('excludes already copied rows and maps a later approval back to its original row indices', async () => {
    const f = fixture()
    const request = {id:'a',runId:'r',projectName:'Page',pageUrl:'https://example.test/',columns:['Issue'],rows:[['Old finding']],severityCounts:{},evidence:[],warnings:[],uploadsEvidence:false}
    await f.context.approve(request); f.context.copyToClipboard('Old finding', '')
    const decision = await f.context.approve({...request,id:'b',rows:[['Old finding'],['New finding']]})
    expect(f.approvals[1].rows).toEqual([['New finding']])
    expect(decision.excludedRows).toEqual([0])
    f.context.copyToClipboard('New finding', ''); f.context.copyToClipboard('New finding', '')
    expect(f.clipboard).toHaveLength(2)
  })
  it('reuses successful uploads while retrying only failed evidence', async () => {
    const f = fixture(); let uploads = 0
    f.context.evidence = {unavailableReason:()=>null, upload:async items => { uploads++; return items[0].label==='bad' && uploads===2 ? [{error:'network'}] : [{url:'https://picture.test/'+uploads}] }}
    const ctx = f.execution.wrapContext(f.context)
    const items = ['good','bad'].map(label => ({name:label,data:Buffer.from(label),label,contentType:'image/webp'}))
    await ctx.evidence!.upload(items); await ctx.evidence!.upload(items)
    expect(uploads).toBe(3)
  })
})
describe('tool scheduling', () => {
  it('runs at most three reads and keeps an exclusive operation as a barrier', async () => {
    const scheduler = new ToolScheduler(); const signal = new AbortController().signal
    let active=0, maximum=0; const order:string[]=[]
    const work=(name:string)=>async()=>{ active++;maximum=Math.max(active,maximum);order.push(name);await new Promise(resolve=>setTimeout(resolve,5));active--;return name }
    await Promise.all([scheduler.run(true,work('r1'),signal),scheduler.run(true,work('r2'),signal),scheduler.run(true,work('r3'),signal),scheduler.run(true,work('r4'),signal),scheduler.run(false,work('action'),signal),scheduler.run(true,work('r5'),signal)])
    expect(maximum).toBe(3);expect(order).toEqual(['r1','r2','r3','r4','action','r5'])
  })
  it('cancels queued work promptly without waiting for the active operation', async () => {
    const scheduler=new ToolScheduler();const controller=new AbortController();let release!:()=>void
    const first=scheduler.run(false,()=>new Promise<void>(resolve=>{release=resolve}),controller.signal)
    const queued=scheduler.run(false,async()=>{throw new Error('should not run')},controller.signal)
    const rejection=expect(queued).rejects.toThrow('Stopped');await Promise.resolve();controller.abort();await rejection;release();await first
  })
})
