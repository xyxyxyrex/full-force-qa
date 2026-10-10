import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentProvider, ProviderResult, ProviderRun } from './agents/types'
import { CHAT_TOOLS, MAX_CHAT_HISTORY, runChatTurn } from './chat'
import { QA_AGENT_PROMPT } from './prompt'
import { createFakeContext, type FakeContext } from './testSupport'

let root: string
let fake: FakeContext
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'parity-chat-')); fake = createFakeContext(root) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const fakeProvider = (script: (run: ProviderRun) => Promise<ProviderResult> | ProviderResult) => {
  const runs: ProviderRun[] = []
  const provider: AgentProvider = { id: 'fake', label: 'Fake', run: async (run) => { runs.push(run); return script(run) } }
  return { provider, runs }
}
const turn = (provider: AgentProvider, message: string, over: Partial<Parameters<typeof runChatTurn>[1]> = {}) => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const promise = runChatTurn({ context: fake.context, provider }, { message, history: [], signal: controller.signal, emit: (e) => events.push(e), ...over })
  return { promise, events, controller }
}

describe('runChatTurn', () => {
  it('lets CLI agents inspect owned images through the bridge without unused inline payloads', async () => {
    const image = { id: 'a1111111-1111-4111-8111-111111111111', name: 'Screenshot.webp', width: 40, height: 20, bytes: 10, mimeType: 'image/webp' as const }
    let reads = 0
    fake.context.chatImages = async () => { reads++; return [{ data: Buffer.from('IMAGE'), mimeType: 'image/webp', caption: image.name }] }
    const { provider } = fakeProvider(async run => {
      expect(run.images).toBeUndefined()
      expect(run.attachments).toEqual([image])
      expect(run.task).toContain(image.id)
      expect(reads).toBe(0)
      expect((await run.call('read_chat_images', { ids: [image.id] })).images).toHaveLength(1)
      return { stopped: 'finished', text: 'Inspected through the bridge.' }
    })
    provider.needsBridge = true
    await turn(provider, 'Inspect this screenshot.', { attachments: [image] }).promise
    expect(reads).toBe(1)
  })
  it('passes attached images to the provider while saving references rather than binary payloads', async () => {
    const image = { id: 'a1111111-1111-4111-8111-111111111111', name: 'Screenshot.webp', width: 40, height: 20, bytes: 10, mimeType: 'image/webp' as const }
    fake.context.chatImages = async ids => { expect(ids).toEqual([image.id]); return [{ data: Buffer.from('IMAGE'), mimeType: 'image/webp', caption: image.name }] }
    const { provider, runs } = fakeProvider(async run => {
      expect((await run.call('read_chat_images', { ids: [image.id] })).images).toHaveLength(1)
      return { stopped: 'finished', text: 'The screenshot shows a heading.' }
    })
    const result = await turn(provider, 'What is wrong here?', { attachments: [image] }).promise
    expect(runs[0].images?.[0].data.toString()).toBe('IMAGE')
    expect(runs[0].task).toContain(image.id)
    expect(result.history[0]).toEqual({ role: 'user', text: 'What is wrong here?', attachments: [image] })
    expect(JSON.stringify(result.history)).not.toContain('base64')
    await turn(provider, 'What about its spacing?', { history: result.history }).promise
    expect(runs[1].history?.[0].images?.[0].data.toString()).toBe('IMAGE')
  })
  it('sends the message with the earlier chat and the chat prompt, and remembers the answer', async () => {
    const { provider, runs } = fakeProvider(() => ({ stopped: 'finished', text: 'It is 28px.' }))
    const history = [{ role: 'user' as const, text: 'hi' }, { role: 'assistant' as const, text: 'hello' }]
    const result = await turn(provider, 'How big is the heading?', { history }).promise
    expect(runs[0]).toMatchObject({ task: 'How big is the heading?', history, tools: CHAT_TOOLS })
    expect(runs[0].system).toContain('Parity’s assistant'); expect(runs[0].system).toContain('qa-review'); expect(runs[0].system.length).toBeLessThan(QA_AGENT_PROMPT.length)
    expect(result.history).toEqual([...history, { role: 'user', text: 'How big is the heading?' }, { role: 'assistant', text: 'It is 28px.' }])
    expect(result.stopped).toBe('finished')
  })

  it('is a QA agent, not only a design comparer: it can test the page and never asks for a design', () => {
    expect(CHAT_TOOLS).toEqual(expect.arrayContaining(['browser_open', 'browser_click', 'browser_type', 'check_links', 'page_audit', 'http_request', 'save_draft', 'finalize_rows']))
    expect(QA_AGENT_PROMPT).toContain('A design is optional')
    expect(QA_AGENT_PROMPT).toContain('Never ask the person for a Figma file')
    expect(QA_AGENT_PROMPT).toContain('ENHANCEMENT (QA)')
    expect(QA_AGENT_PROMPT).toContain('area "functional"')
  })

  it('lets the agent use read-only tools and the approval-gated one, but not set_design', async () => {
    const { provider } = fakeProvider(async (run) => {
      const ok = await run.call('get_context', {})
      const denied = await run.call('set_design', { path: '/etc/passwd' })
      expect(denied.isError).toBe(true)
      expect(denied.text).toMatch(/not available in this chat/)
      return { stopped: 'finished', text: ok.isError ? 'context failed' : 'ok' }
    })
    expect((await turn(provider, 'hello').promise).history[1].text).toBe('ok')
  })

  it('stops the message when it goes over the token budget', async () => {
    const { provider } = fakeProvider(async (run) => {
      run.emit({ type: 'usage', inputTokens: 900, outputTokens: 200 })
      return { stopped: run.signal.aborted ? 'aborted' : 'finished', text: '' }
    })
    const { promise, events } = turn(provider, 'review everything', { budgetTokens: 1000 })
    const result = await promise
    expect(result.stopped).toBe('budget')
    expect(events.some((e) => e.type === 'error' && /more than 1,000 tokens/.test(e.message))).toBe(true)
    expect(result.history[1].text).toBe('(stopped before answering)')
  })

  it('passes a stop from the person on to the agent', async () => {
    const { provider } = fakeProvider((run) => new Promise((resolve) => run.signal.addEventListener('abort', () => resolve({ stopped: 'aborted', text: 'partial' }))))
    const { promise, controller } = turn(provider, 'long task')
    controller.abort()
    expect((await promise).stopped).toBe('aborted')
  })

  it('keeps only the newest part of a long chat', async () => {
    const { provider } = fakeProvider(() => ({ stopped: 'finished', text: 'ok' }))
    const history = Array.from({ length: MAX_CHAT_HISTORY }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), text: `m${i}` }))
    const result = await turn(provider, 'next', { history }).promise
    expect(result.history).toHaveLength(MAX_CHAT_HISTORY)
    expect(result.history[MAX_CHAT_HISTORY - 2]).toEqual({ role: 'user', text: 'next' })
  })

  it('passes agent errors up so the caller can show them', async () => {
    const { provider } = fakeProvider(() => { throw new Error('No key') })
    await expect(turn(provider, 'hi').promise).rejects.toThrow('No key')
  })
})
