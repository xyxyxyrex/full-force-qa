import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAiCompatibleProvider, isDailyLimit, retryDelayMs, trimCarriedImages } from './openaiCompatible'
import { QuotaError, type AgentEvent, type ProviderRun } from './types'

interface Scripted { status?: number; body: unknown; delayMs?: number; headers?: Record<string, string>; sse?: string }
let server: Server
let baseUrl: string
let queue: Scripted[]
let requests: Array<{ url: string; headers: IncomingMessage['headers']; body: any }>

beforeEach(async () => {
  queue = []; requests = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      requests.push({ url: req.url || '', headers: req.headers, body: JSON.parse(raw) })
      const next = queue.shift() ?? { status: 500, body: { error: { message: 'no scripted response' } } }
      if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs))
      res.writeHead(next.status ?? 200, { 'Content-Type': next.sse ? 'text/event-stream' : 'application/json', ...next.headers })
      res.end(next.sse || JSON.stringify(next.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })

const reply = (message: Record<string, unknown>, finish = 'stop', usage = { prompt_tokens: 100, completion_tokens: 10 }) => ({ body: { choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage } })
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
const makeRun = (over: Partial<ProviderRun> = {}) => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const calls: Array<{ name: string; args: unknown }> = []
  const run: ProviderRun = {
    system: 'SYSTEM RUBRIC', task: 'Check desktop.', tools: ['get_context', 'capture_live'], maxTurns: 10, signal: controller.signal,
    call: async (name, args) => { calls.push({ name, args }); return { text: `result of ${name}`, images: [{ data: Buffer.from('JPEG'), mimeType: 'image/jpeg' as const, caption: 'Overview' }] } },
    emit: (event) => events.push(event), ...over,
  }
  return { run, events, calls, controller }
}
const provider = (over: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {}) => createOpenAiCompatibleProvider({ id: 'openai-api', label: 'OpenAI', baseUrl, apiKey: 'sk-test', model: 'gpt-test', ...over })

describe('openai-compatible provider', () => {
  it('streams a reply without duplicating its final answer', async () => {
    queue.push({body:null,sse:'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n'})
    const {run,events}=makeRun()
    expect(await provider().run(run)).toEqual({stopped:'finished',text:'Hello world'})
    expect(events.filter(e=>e.type==='text')).toEqual([{type:'text',text:'Hello ',delta:true},{type:'text',text:'world',delta:true}])
    expect(events.filter(e=>e.type==='usage')).toEqual([{type:'usage',inputTokens:10,outputTokens:2}])
  })
  it('falls back only after an explicit streaming rejection', async () => {
    queue.push({status:400,body:{error:{message:'streaming is not supported'}}},reply({content:'done'}))
    await provider().run(makeRun().run)
    expect(requests[0].body.stream).toBe(true);expect(requests[1].body.stream).toBeUndefined()
  })
  it('resumes the next completion with finished tool results rather than replaying tools', async () => {
    queue.push(reply({content:'Inspecting',tool_calls:[toolCall('c1','get_context',{})]},'tool_calls'),{status:401,body:{error:{message:'bad key'}}})
    let checkpoint:unknown
    const first=makeRun({checkpoint:value=>{checkpoint=value}})
    await expect(provider().run(first.run)).rejects.toThrow('rejected')
    expect(first.calls).toHaveLength(1)
    queue.push(reply({content:'Finished'}))
    const next=makeRun({resume:checkpoint})
    await provider().run(next.run)
    expect(next.calls).toHaveLength(0)
    expect(requests.at(-1)!.body.messages.filter((m:any)=>m.role==='tool')).toHaveLength(1)
    expect(requests.at(-1)!.body.messages.filter((m:any)=>m.role==='user' && m.content==='Check desktop.')).toHaveLength(1)
  })
  it('never executes an incomplete streamed tool request', async () => {
    queue.push({body:null,sse:'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_context","arguments":"{"}}]}}]}\n\n'})
    const {run,calls}=makeRun()
    await expect(provider().run(run)).rejects.toThrow('ended early')
    expect(calls).toHaveLength(0)
  })
  it('reduces repeated image payload bytes while retaining both tool results', async () => {
    queue.push(reply({tool_calls:[toolCall('a','get_context',{})]},'tool_calls'),reply({tool_calls:[toolCall('b','get_context',{})]},'tool_calls'),reply({content:'done'}))
    const image={data:Buffer.alloc(12000,18),mimeType:'image/jpeg' as const,caption:'Same evidence'}
    const {run}=makeRun({call:async()=>({text:'All measured values retained',images:[image]})})
    await provider().run(run)
    const payload=requests[2].body
    const images=payload.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content.filter((p:any)=>p.type==='image_url'):[])
    expect(images).toHaveLength(1)
    expect(payload.messages.filter((m:any)=>m.role==='tool')).toHaveLength(2)
    const repeated={...payload,messages:[...payload.messages,{role:'user',content:images}]}
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(repeated).length-15000)
  })
  it('runs the tool loop and returns pictures in a follow-up user message', async () => {
    queue.push(
      reply({ content: 'Capturing.', tool_calls: [toolCall('call_1', 'capture_live', { breakpoint: 'desktop' })] }, 'tool_calls', { prompt_tokens: 400, completion_tokens: 30 }),
      reply({ content: 'Done reviewing.' }),
    )
    const { run, events, calls } = makeRun()
    const result = await provider().run(run)
    expect(result).toEqual({ stopped: 'finished', text: 'Done reviewing.' })
    expect(calls).toEqual([{ name: 'capture_live', args: { breakpoint: 'desktop' } }])

    const first = requests[0]
    expect(first.url).toBe('/v1/chat/completions')
    expect(first.headers.authorization).toBe('Bearer sk-test')
    expect(first.body).toMatchObject({ model: 'gpt-test', tool_choice: 'auto' })
    expect(first.body.messages).toEqual([{ role: 'system', content: 'SYSTEM RUBRIC' }, { role: 'user', content: 'Check desktop.' }])
    expect(first.body.tools[1]).toMatchObject({ type: 'function', function: { name: 'capture_live' } })
    expect(first.body.tools[1].function.parameters.properties.breakpoint.enum).toEqual(['desktop', 'tablet', 'mobile'])
    expect(first.body.tools[1].function.parameters.$schema).toBeUndefined()

    const second = requests[1].body.messages
    expect(second[2]).toMatchObject({ role: 'assistant', content: 'Capturing.', tool_calls: [{ id: 'call_1' }] })
    expect(second[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result of capture_live\n(1 picture(s) follow or are already attached above.)' })
    expect(second[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'capture_live: Overview' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}` } }] })
    expect(second[4].carriesImages).toBeUndefined()
    expect(events.filter((e) => e.type === 'usage')[0]).toEqual({ type: 'usage', inputTokens: 400, outputTokens: 30 })
    expect(events).toContainEqual({ type: 'tool-result', callId: 'call_1', name: 'capture_live', isError: false, text: 'result of capture_live', images: 1 })
  })

  it('sends no Authorization header without a key (local servers)', async () => {
    queue.push(reply({ content: 'hi' }))
    await provider({ apiKey: undefined, id: 'local', label: 'Local model' }).run(makeRun().run)
    expect(requests[0].headers.authorization).toBeUndefined()
  })

  it('accepts tool arguments as an object and runs tool calls even when finish_reason says stop', async () => {
    queue.push(reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_context', arguments: {} } }] }, 'stop'), reply({ content: 'ok' }))
    const { run, calls } = makeRun()
    expect((await provider().run(run)).stopped).toBe('finished')
    expect(calls).toEqual([{ name: 'get_context', args: {} }])
  })

  it('tells the model when its arguments were not valid JSON, without running the tool', async () => {
    queue.push(reply({ content: '', tool_calls: [toolCall('c1', 'capture_live', '{"breakpoint": "desk')] }, 'tool_calls'), reply({ content: 'sorry' }))
    const { run, calls } = makeRun()
    await provider().run(run)
    expect(calls).toHaveLength(0)
    expect(requests[1].body.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('not valid JSON') })
  })

  it('explains the common failures', async () => {
    queue.push({ status: 401, body: { error: { message: 'bad key' } } })
    await expect(provider().run(makeRun().run)).rejects.toThrow(/rejected the API key/)
    queue.push({ status: 404, body: { error: { message: 'model not found' } } })
    await expect(provider().run(makeRun().run)).rejects.toThrow(/does not know the model "gpt-test"/)
    queue.push({ status: 400, body: { error: { message: 'registry.ollama.ai/library/llama3 does not support tools' } } })
    await expect(provider().run(makeRun().run)).rejects.toThrow(/does not support tool calling/)
    queue.push({ status: 400, body: { error: { message: 'this model does not support image input' } } })
    await expect(provider().run(makeRun().run)).rejects.toThrow(/cannot read pictures/)
    await expect(provider({ baseUrl: 'http://127.0.0.1:1/v1', label: 'Ollama' }).run(makeRun().run)).rejects.toThrow(/Could not reach Ollama/)
  })

  it('reports a content filter and a cut-off answer', async () => {
    queue.push(reply({ content: '' }, 'content_filter'))
    const refused = makeRun()
    expect((await provider().run(refused.run)).stopped).toBe('refused')
    queue.push(reply({ content: 'partial' }, 'length'))
    expect(await provider().run(makeRun().run)).toEqual({ stopped: 'failed', text: 'partial' })
  })

  it('stops at the turn limit and when aborted', async () => {
    for (let i = 0; i < 3; i++) queue.push(reply({ content: '', tool_calls: [toolCall(`c${i}`, 'get_context', {})] }, 'tool_calls'))
    expect((await provider().run(makeRun({ maxTurns: 3 }).run)).stopped).toBe('max-turns')
    const aborted = makeRun(); aborted.controller.abort()
    expect((await provider().run(aborted.run)).stopped).toBe('aborted')
    queue.push({ ...reply({ content: 'slow' }), delayMs: 3000 })
    const during = makeRun()
    setTimeout(() => during.controller.abort(), 150)
    expect((await provider().run(during.run)).stopped).toBe('aborted')
  })
})

describe('trimCarriedImages', () => {
  it('keeps pictures only in the newest picture messages', () => {
    const carrier = (n: number) => ({ role: 'user' as const, carriesImages: true, content: [{ type: 'text' as const, text: `c${n}` }, { type: 'image_url' as const, image_url: { url: 'data:x' } }] })
    const messages: any[] = [{ role: 'user', content: 'task' }]
    for (let i = 0; i < 5; i++) { messages.push({ role: 'assistant', content: null }); messages.push(carrier(i)) }
    trimCarriedImages(messages, 2)
    const carriers = messages.filter((m) => m.carriesImages)
    expect(carriers.map((m) => m.content.filter((p: any) => p.type === 'image_url').length)).toEqual([0, 0, 0, 1, 1])
    expect(carriers[0].content[1].text).toContain('picture removed')
  })
})

describe('openai-compatible provider chat history', () => {
  it('sends earlier chat turns after the system prompt and before the new message', async () => {
    queue.push(reply({ content: 'Same on mobile.' }))
    const { run } = makeRun({ task: 'And on mobile?', history: [{ role: 'user', text: 'How big is the hero heading?' }, { role: 'assistant', text: 'It is 28px on desktop.' }] })
    await provider().run(run)
    expect(requests[0].body.messages).toEqual([
      { role: 'system', content: 'SYSTEM RUBRIC' },
      { role: 'user', content: 'How big is the hero heading?' },
      { role: 'assistant', content: 'It is 28px on desktop.' },
      { role: 'user', content: 'And on mobile?' },
    ])
  })
})

describe('free tiers and rate limits', () => {
  const quick = (over: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {}) => provider({ maxWaitMs: 200, ...over })

  it('waits as long as the server asks, says so, and tries again', async () => {
    queue.push({ status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-min.' } }, headers: { 'retry-after': '0' } }, reply({ content: 'Done.' }))
    const { run, events } = makeRun()
    expect(await quick({ lite: true, label: 'OpenRouter' }).run(run)).toEqual({ stopped: 'finished', text: 'Done.' })
    expect(requests).toHaveLength(2)
    expect(events).toContainEqual({ type: 'status', message: 'OpenRouter is rate limiting (free tier). Waiting 1s, then trying again (1 of 3)…' })
  })

  it('retries an overloaded provider, and gives up after three tries', async () => {
    for (let i = 0; i < 4; i++) queue.push({ status: 503, body: { error: { message: 'Provider returned error' } } })
    await expect(quick().run(makeRun().run)).rejects.toThrow(/overloaded right now \(Provider returned error\)/)
    expect(requests).toHaveLength(4)
  })

  it('stops at once with a QuotaError when the daily allowance is used up', async () => {
    queue.push({ status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429 } } })
    const failure = await quick({ label: 'OpenRouter', dailyLimitHint: 'Come back tomorrow.' }).run(makeRun().run).catch((error) => error)
    expect(failure).toBeInstanceOf(QuotaError)
    expect(failure.message).toBe('Today\'s free requests on OpenRouter are used up. Come back tomorrow.')
    expect(requests).toHaveLength(1)
  })

  it('reads Gemini\'s list-shaped errors and its retryDelay', async () => {
    const quota = [{ error: { code: 429, message: 'You exceeded your current quota. Please retry in 0.05s.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] } }]
    queue.push({ status: 429, body: quota }, reply({ content: 'ok' }))
    expect((await quick({ label: 'Gemini' }).run(makeRun().run)).text).toBe('ok')
    queue.push({ status: 404, body: [{ error: { code: 404, message: 'models/gemini-nope is not found' } }] })
    await expect(quick({ label: 'Gemini', model: 'gemini-nope' }).run(makeRun().run)).rejects.toThrow('Gemini does not know the model "gemini-nope" (models/gemini-nope is not found)')
  })

  it('gives up when asked to wait far longer than a minute', async () => {
    queue.push({ status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '3600' } })
    await expect(quick({ lite: true }).run(makeRun().run)).rejects.toThrow(/wait about 60 minute\(s\).*free tier limit/)
    expect(requests).toHaveLength(1)
  })

  it('treats an error inside a 200 answer (OpenRouter) as the error it is', async () => {
    queue.push({ body: { error: { code: 502, message: 'Upstream error' } } }, reply({ content: 'recovered' }))
    expect((await quick().run(makeRun().run)).text).toBe('recovered')
    queue.push({ body: { error: { code: 401, message: 'No auth credentials found' } } })
    await expect(quick().run(makeRun().run)).rejects.toThrow(/rejected the API key/)
  })

  it('stops waiting when the person stops the run', async () => {
    queue.push({ status: 429, body: { error: { message: 'busy' } }, headers: { 'retry-after': '30' } })
    const during = makeRun()
    setTimeout(() => during.controller.abort(), 100)
    expect((await provider({ maxWaitMs: 60_000 }).run(during.run)).stopped).toBe('aborted')
  })

  it('sends extra headers and keeps fewer pictures on a free tier', async () => {
    for (let i = 0; i < 3; i++) queue.push(reply({ content: '', tool_calls: [toolCall(`c${i}`, 'capture_live', { breakpoint: 'desktop' })] }, 'tool_calls'))
    queue.push(reply({ content: 'done' }))
    await quick({ lite: true, headers: { 'X-Title': 'Parity' } }).run(makeRun().run)
    expect(requests[0].headers['x-title']).toBe('Parity')
    const pictures = requests[3].body.messages.filter((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))
    expect(pictures).toHaveLength(1) // identical evidence is attached once and remains available
    expect(quick({ lite: true }).lite).toBe(true)
    expect(quick().lite).toBe(false)
  })
})

describe('retryDelayMs and isDailyLimit', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries)
  it('reads every way a server says how long to wait', () => {
    expect(retryDelayMs(headers({ 'retry-after': '7' }), '')).toBe(7000)
    expect(retryDelayMs(headers({ 'retry-after': new Date(10_000).toUTCString() }), '', 4_000)).toBe(6000)
    expect(retryDelayMs(headers({ 'x-ratelimit-reset': String(1_800_000_030_000) }), '', 1_800_000_000_000)).toBe(30_000)
    expect(retryDelayMs(headers({}), '{"retryDelay": "37s"}')).toBe(37_000)
    expect(retryDelayMs(headers({}), 'Please retry in 2.5s.')).toBe(2500)
    expect(retryDelayMs(headers({}), 'busy')).toBeNull()
  })
  it('tells a daily quota from a per-minute one', () => {
    expect(isDailyLimit('Rate limit exceeded: free-models-per-day')).toBe(true)
    expect(isDailyLimit('Quota exceeded for metric: generate_content_free_tier_requests, limit: 250, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier')).toBe(true)
    expect(isDailyLimit('Rate limit exceeded: free-models-per-min')).toBe(false)
    expect(isDailyLimit('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')).toBe(false)
    expect(isDailyLimit('Rate limit exceeded: free-models-per-min. Add 10 credits to unlock 1000 free model requests per day')).toBe(false)
  })
})
