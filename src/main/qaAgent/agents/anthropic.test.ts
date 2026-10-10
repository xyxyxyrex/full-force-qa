import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAnthropicProvider, trimOldImages } from './anthropic'
import type { AgentEvent, ProviderRun } from './types'
import type { ToolResult } from '../tools'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
interface Scripted { blocks: Block[]; stop: string; inputTokens?: number; outputTokens?: number; status?: number; delayMs?: number; headers?: Record<string, string> }

let server: Server
let baseURL: string
let queue: Scripted[]
let requests: Array<{ headers: IncomingMessage['headers']; body: any }>

const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

beforeEach(async () => {
  queue = []; requests = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) })
      const next = queue.shift()
      if (!next) { res.writeHead(500); return res.end('{"type":"error","error":{"type":"api_error","message":"no scripted response"}}') }
      if (next.status && next.status >= 400) {
        res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers })
        return res.end(JSON.stringify({ type: 'error', error: { type: next.status === 401 ? 'authentication_error' : 'api_error', message: 'nope' } }))
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...next.headers })
      sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: next.inputTokens ?? 100, output_tokens: 1 } } })
      if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs))
      next.blocks.forEach((block, index) => {
        if (block.type === 'text') {
          sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
        } else {
          sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
          const json = JSON.stringify(block.input)
          const mid = Math.floor(json.length / 2)
          for (const part of [json.slice(0, mid), json.slice(mid)]) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } })
        }
        sse(res, 'content_block_stop', { type: 'content_block_stop', index })
      })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: next.stop, stop_sequence: null }, usage: { output_tokens: next.outputTokens ?? 20 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })

const makeRun = (over: Partial<ProviderRun> = {}) => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const calls: Array<{ name: string; args: unknown }> = []
  const run: ProviderRun = {
    system: 'SYSTEM RUBRIC', task: 'Run id: abc. Check the desktop breakpoint now.', tools: ['get_context', 'capture_live'], maxTurns: 10, signal: controller.signal,
    call: async (name, args): Promise<ToolResult> => { calls.push({ name, args }); return { text: `result of ${name}`, images: [{ data: Buffer.from('JPEGDATA'), mimeType: 'image/jpeg', caption: 'Overview' }] } },
    emit: (event) => events.push(event), ...over,
  }
  return { run, events, calls, controller }
}
const provider = (over: Partial<Parameters<typeof createAnthropicProvider>[0]> = {}) => createAnthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5-5', effort: 'medium', baseURL, ...over })

describe('anthropic provider', () => {
  it('retains observed API headroom on both successful and rate-limited responses', async () => {
    const headers = { 'anthropic-ratelimit-input-tokens-remaining': '0', 'anthropic-ratelimit-input-tokens-limit': '1000' }
    queue.push({ blocks: [{ type: 'text', text: 'Done.' }], stop: 'end_turn', headers })
    const first = makeRun()
    await provider().run(first.run)
    expect(first.events.filter(event => event.type === 'quota-observed')).toEqual([expect.objectContaining({ quota: expect.objectContaining({ windows: [expect.objectContaining({ remaining: 0, limit: 1000 })] }) })])
    // The SDK can retry 429s; feed each response the same headers.
    queue.push(...Array.from({ length: 3 }, () => ({ blocks: [], stop: 'end_turn', status: 429, headers: { ...headers, 'retry-after': '0' } })))
    const failed = makeRun()
    await expect(provider().run(failed.run)).rejects.toThrow('rate limiting')
    expect(failed.events.filter(event => event.type === 'quota-observed')).toEqual([expect.objectContaining({ quota: expect.objectContaining({ windows: [expect.objectContaining({ remaining: 0 })] }) })])
  })
  it('includes user attachments directly in the request', async () => {
    queue.push({ blocks: [{ type: 'text', text: 'I see the screenshot.' }], stop: 'end_turn' })
    const { run } = makeRun({ images: [{ data: Buffer.from('IMAGE'), mimeType: 'image/webp', caption: 'Screenshot' }] })
    await provider().run(run)
    expect(requests[0].body.messages[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'SU1BR0U=' } })
  })
  it('runs the tool loop: sends tools, executes calls, returns pictures to the model', async () => {
    queue.push(
      { blocks: [{ type: 'text', text: 'Capturing now.' }, { type: 'tool_use', id: 'toolu_1', name: 'capture_live', input: { breakpoint: 'desktop', runId: 'abc' } }], stop: 'tool_use', inputTokens: 500, outputTokens: 40 },
      { blocks: [{ type: 'text', text: 'All done.' }], stop: 'end_turn', inputTokens: 900, outputTokens: 10 },
    )
    const { run, events, calls } = makeRun()
    const result = await provider().run(run)
    expect(result).toEqual({ stopped: 'finished', text: 'All done.' })
    expect(calls).toEqual([{ name: 'capture_live', args: { breakpoint: 'desktop', runId: 'abc' } }])

    const first = requests[0]
    expect(first.headers['x-api-key']).toBe('sk-test')
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', system: 'SYSTEM RUBRIC', stream: true, output_config: { effort: 'medium' } })
    expect(first.body.messages).toEqual([{ role: 'user', content: 'Run id: abc. Check the desktop breakpoint now.' }])
    expect(first.body.tools.map((t: { name: string }) => t.name)).toEqual(['get_context', 'capture_live'])
    const schema = first.body.tools[1].input_schema
    expect(schema.type).toBe('object'); expect(schema.$schema).toBeUndefined()
    expect(schema.properties.breakpoint.enum).toEqual(['desktop', 'tablet', 'mobile'])

    const second = requests[1].body.messages
    expect(second[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Capturing now.' }, { type: 'tool_use', id: 'toolu_1', name: 'capture_live', input: { breakpoint: 'desktop', runId: 'abc' } }] })
    expect(second[2].role).toBe('user')
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false })
    expect(second[2].content[0].content).toEqual([
      { type: 'text', text: 'result of capture_live' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('JPEGDATA').toString('base64') } },
    ])

    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Capturing now.', delta: true }, { type: 'text', text: 'All done.', delta: true }])
    expect(events).toContainEqual({ type: 'tool', callId: 'toolu_1', name: 'capture_live', args: { breakpoint: 'desktop', runId: 'abc' } })
    expect(events).toContainEqual({ type: 'tool-result', callId: 'toolu_1', name: 'capture_live', isError: false, text: 'result of capture_live', images: 1 })
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 500, outputTokens: 40 }, { type: 'usage', inputTokens: 900, outputTokens: 10 }])
  })

  it('marks failed tools as errors for the model', async () => {
    queue.push({ blocks: [{ type: 'tool_use', id: 't1', name: 'capture_live', input: { breakpoint: 'desktop' } }], stop: 'tool_use' }, { blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn' })
    const { run } = makeRun({ call: async () => ({ text: 'The page could not be captured.', isError: true }) })
    await provider().run(run)
    expect(requests[1].body.messages[2].content[0]).toMatchObject({ is_error: true })
  })

  it('leaves the effort setting out for Haiku models', async () => {
    queue.push({ blocks: [{ type: 'text', text: 'x' }], stop: 'end_turn' })
    await provider({ model: 'claude-haiku-4-5' }).run(makeRun().run)
    expect(requests[0].body.output_config).toBeUndefined()
    expect(requests[0].body.model).toBe('claude-haiku-4-5')
  })

  it('reports a refusal and a cut-off answer without pretending they finished', async () => {
    queue.push({ blocks: [{ type: 'text', text: '' }], stop: 'refusal' })
    const refused = makeRun()
    expect((await provider().run(refused.run)).stopped).toBe('refused')
    expect(refused.events.some((e) => e.type === 'error' && e.message.includes('declined'))).toBe(true)
    queue.push({ blocks: [{ type: 'text', text: 'partial' }], stop: 'max_tokens' })
    const cut = makeRun()
    expect(await provider().run(cut.run)).toEqual({ stopped: 'failed', text: 'partial' })
  })

  it('turns a rejected key into a clear message', async () => {
    queue.push({ blocks: [], stop: 'end_turn', status: 401 })
    await expect(provider().run(makeRun().run)).rejects.toThrow(/rejected the API key/)
  })

  it('stops at the turn limit', async () => {
    for (let i = 0; i < 3; i++) queue.push({ blocks: [{ type: 'tool_use', id: `t${i}`, name: 'get_context', input: {} }], stop: 'tool_use' })
    const result = await provider().run(makeRun({ maxTurns: 3 }).run)
    expect(result.stopped).toBe('max-turns')
    expect(requests).toHaveLength(3)
  })

  it('stops when aborted before or during a request', async () => {
    const before = makeRun(); before.controller.abort()
    expect((await provider().run(before.run)).stopped).toBe('aborted')
    expect(requests).toHaveLength(0)
    queue.push({ blocks: [{ type: 'text', text: 'slow' }], stop: 'end_turn', delayMs: 3000 })
    const during = makeRun()
    setTimeout(() => during.controller.abort(), 150)
    expect((await provider().run(during.run)).stopped).toBe('aborted')
  })
})

describe('trimOldImages', () => {
  const turn = (id: string): Anthropic.MessageParam => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `r ${id}` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }] })
  const imagesIn = (m: Anthropic.MessageParam) => ((m.content as Anthropic.ToolResultBlockParam[])[0].content as Anthropic.ContentBlockParam[]).filter((p) => p.type === 'image').length

  it('keeps pictures only in the newest turns', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'task' }]
    for (let i = 0; i < 6; i++) { messages.push({ role: 'assistant', content: [{ type: 'text', text: 'a' }] }); messages.push(turn(`t${i}`)) }
    trimOldImages(messages, 3)
    const results = messages.filter((m) => m.role === 'user' && Array.isArray(m.content))
    expect(results.map(imagesIn)).toEqual([0, 0, 0, 1, 1, 1])
    const old = (results[0].content as Anthropic.ToolResultBlockParam[])[0].content as Anthropic.TextBlockParam[]
    expect(old[1].text).toContain('picture removed')
    expect(messages[0].content).toBe('task')
  })

  it('is safe to run again and leaves text results alone', () => {
    const messages: Anthropic.MessageParam[] = [turn('a'), turn('b')]
    trimOldImages(messages, 1); trimOldImages(messages, 1)
    expect(messages.map(imagesIn)).toEqual([0, 1])
  })
})

describe('anthropic provider chat history', () => {
  it('sends earlier chat turns before the new message', async () => {
    queue.push({ blocks: [{ type: 'text', text: 'Yes, the heading is 28px.' }], stop: 'end_turn' })
    const { run } = makeRun({ task: 'And on mobile?', history: [{ role: 'user', text: 'How big is the hero heading?' }, { role: 'assistant', text: 'It is 28px on desktop.' }] })
    const result = await provider().run(run)
    expect(result.text).toBe('Yes, the heading is 28px.')
    expect(requests[0].body.messages).toEqual([
      { role: 'user', content: 'How big is the hero heading?' },
      { role: 'assistant', content: 'It is 28px on desktop.' },
      { role: 'user', content: 'And on mobile?' },
    ])
  })
})
