import { beforeEach, describe, expect, it } from 'vitest'
import { formatTokens, qaChat, tokenTotal } from './qaChatStore'

const feed = (...events: Parameters<typeof qaChat.handle>[0][]) => events.forEach((event) => qaChat.handle(event))
const kinds = () => qaChat.getState().messages.map((m) => m.kind)

beforeEach(() => qaChat.reset())

describe('qaChatStore', () => {
  it('keeps an unsent message and active view through streaming and model switches', () => {
    qaChat.setDraft('Not sent yet', 'findings')
    feed({ type: 'started', agent: 'gemini-api', label: 'Gemini' }, { type: 'text', text: 'Live reply', delta: true }, { type: 'agent-selected', agent: 'codex', label: 'Codex' }, { type: 'finished' })
    expect(qaChat.getState().draft).toEqual({ input: 'Not sent yet', tab: 'findings' })
    qaChat.clear()
    expect(qaChat.getState().draft).toEqual({ input: '', tab: 'chat' })
  })
  it('updates the saved selection live while retaining the transcript and token counts', () => {
    qaChat.addUserMessage('Keep this conversation')
    feed({ type: 'started', agent: 'gemini-api', label: 'Gemini' }, { type: 'usage', inputTokens: 10, outputTokens: 2 },
      { type: 'agent-selected', agent: 'codex', model: 'gpt-5.6-sol', label: 'Codex · gpt-5.6-sol' })
    expect(qaChat.getState().agentLabel).toBe('Gemini') // The retiring attempt is still running.
    feed({ type: 'finished' })
    expect(qaChat.getState()).toMatchObject({ agentLabel: 'Codex · gpt-5.6-sol', session: { input: 10, output: 2 } })
    expect(qaChat.getState().messages[0]).toMatchObject({ text: 'Keep this conversation' })
    qaChat.restore({ version: 1, id: 'chat-old', title: 'Old chat', createdAt: 1, updatedAt: 1, messages: [], agentLabel: 'Old Gemini' })
    expect(qaChat.getState().agentLabel).toBe('Codex · gpt-5.6-sol')
    qaChat.clear()
    expect(qaChat.getState().agentLabel).toBe('Codex · gpt-5.6-sol')
  })
  it('matches out-of-order results by call and attempt rather than tool name', () => {
    feed({ type:'tool',name:'get_section',args:{section:'S1'},callId:'c1',attemptId:'a'}, { type:'tool',name:'get_section',args:{section:'S2'},callId:'c2',attemptId:'a'},
      {type:'tool-result',name:'get_section',callId:'c2',attemptId:'a',text:'Second',images:0,isError:false})
    expect(qaChat.getState().messages[0]).toMatchObject({pending:true})
    expect(qaChat.getState().messages[1]).toMatchObject({pending:false,result:'Second'})
    feed({type:'finished'})
    expect(qaChat.getState().messages[0]).toMatchObject({cancelled:true})
  })
  it('does not duplicate a streamed reply when the final text repeats it', () => {
    feed({type:'text',text:'Hello ',delta:true},{type:'text',text:'world',delta:true},{type:'text',text:'Hello world'})
    expect(qaChat.getState().messages).toHaveLength(1)
  })
  it('updates a saved finding set so evidence cannot refer to an older draft', () => {
    const event={type:'findings' as const,runId:'r',pageUrl:'https://example.test',breakpoint:'desktop',area:'visual'}
    feed({...event,rows:[{cells:{Issue:'old'}}]},{...event,rows:[{cells:{Issue:'new'}}]})
    expect(qaChat.getState().messages).toHaveLength(1)
    expect(qaChat.getState().messages[0]).toMatchObject({rows:[{cells:{Issue:'new'}}]})
  })
  it('joins streamed pieces into one assistant message, and starts a new one after a tool call', () => {
    feed(
      { type: 'started', agent: 'a', label: 'Agent' },
      { type: 'text', text: 'Looking ', delta: true }, { type: 'text', text: 'now.', delta: true },
      { type: 'tool', name: 'capture_live', args: { breakpoint: 'desktop' } },
      { type: 'text', text: 'Done.', delta: true },
    )
    const messages = qaChat.getState().messages
    expect(messages.map((m) => m.kind)).toEqual(['assistant', 'tool', 'assistant'])
    expect(messages[0]).toMatchObject({ text: 'Looking now.' })
    expect(messages[2]).toMatchObject({ text: 'Done.' })
  })

  it('fills the matching pending tool card with its result', () => {
    feed(
      { type: 'tool', name: 'get_section', args: { section: 'S1' } },
      { type: 'tool', name: 'get_section', args: { section: 'S2' } },
      { type: 'tool-result', name: 'get_section', isError: false, text: 'Section S1', images: 2 },
    )
    const [first, second] = qaChat.getState().messages as Array<{ pending: boolean; result?: string; images?: number }>
    expect(first).toMatchObject({ pending: false, result: 'Section S1', images: 2 })
    expect(second.pending).toBe(true)
  })

  it('adds up tokens for the session and the current message, and tracks the context size', () => {
    feed(
      { type: 'started', agent: 'a', label: 'Agent', budgetTokens: 5000 },
      { type: 'usage', inputTokens: 1000, outputTokens: 200 }, { type: 'usage', inputTokens: 2000, outputTokens: 300 },
      { type: 'finished' },
    )
    let state = qaChat.getState()
    expect(state).toMatchObject({ usageReported: true, context: 2000, budgetTokens: 5000, running: false })
    expect(state.session).toEqual({ input: 3000, output: 500, requests: 2 })
    expect(state.messages[state.messages.length - 1]).toMatchObject({ kind: 'usage', text: '3,500 tokens · 3,000 in, 500 out · 2 requests' })

    feed({ type: 'started', agent: 'a', label: 'Agent' }, { type: 'usage', inputTokens: 100, outputTokens: 10 })
    state = qaChat.getState()
    expect(tokenTotal(state.turn)).toBe(110)
    expect(tokenTotal(state.session)).toBe(3610)
  })

  it('writes no usage line when the agent reported nothing, and stops pending tool cards at the end', () => {
    feed({ type: 'started', agent: 'a', label: 'Agent' }, { type: 'tool', name: 'capture_live', args: {} }, { type: 'finished' })
    expect(kinds()).toEqual(['tool'])
    expect(qaChat.getState()).toMatchObject({ usageReported: false, running: false })
    expect((qaChat.getState().messages[0] as { pending: boolean }).pending).toBe(false)
  })

  it('shows errors and run summaries, and "new chat" clears the transcript and counts', () => {
    feed({ type: 'error', message: 'No key' }, { type: 'done', message: 'Copied 3 rows.' }, { type: 'usage', inputTokens: 5, outputTokens: 5 })
    expect(kinds()).toEqual(['error', 'status'])
    qaChat.clear()
    expect(qaChat.getState()).toMatchObject({ messages: [], usageReported: false })
    expect(qaChat.getState().session).toEqual({ input: 0, output: 0, requests: 0 })
  })
})

describe('formatTokens', () => {
  it('keeps numbers short', () => {
    expect([0, 999, 1000, 1234, 9999, 12_345, 99_999, 100_000, 999_999, 1_250_000].map(formatTokens)).toEqual(['0', '999', '1k', '1.2k', '10k', '12k', '100k', '100k', '1000k', '1.3M'])
  })
})
