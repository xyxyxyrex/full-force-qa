import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAiCompatibleProvider, trimCarriedImages } from './openaiCompatible'
import type { AgentEvent, ProviderRun } from './types'

interface Scripted { status?: number; body: unknown; delayMs?: number }
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
      res.writeHead(next.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(next.body))
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
    expect(second[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result of capture_live\n(1 picture(s) follow in the next message.)' })
    expect(second[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'capture_live: Overview' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}` } }] })
    expect(second[4].carriesImages).toBeUndefined()
    expect(events.filter((e) => e.type === 'usage')[0]).toEqual({ type: 'usage', inputTokens: 400, outputTokens: 30 })
    expect(events).toContainEqual({ type: 'tool-result', name: 'capture_live', isError: false, text: 'result of capture_live', images: 1 })
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
