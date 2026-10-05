import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChatStore } from './chats'

let root: string
let clock: number
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'parity-chats-')); clock = 1_800_000_000_000 })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const store = () => createChatStore(join(root, 'chats'), () => ++clock)
const message = (text: string) => ({ id: 1, kind: 'user', text })

describe('saved chats', () => {
  it('saves what the chat shows and what the agent remembers, and lists chats newest first', () => {
    const chats = store()
    chats.save({ id: 'chat-aaaaaaaa', title: 'How big is the hero heading?', messages: [message('How big is the hero heading?'), { id: 2, kind: 'assistant', text: '28px' }], session: { input: 1000, output: 50, requests: 1 } }, [{ role: 'user', text: 'How big is the hero heading?' }, { role: 'assistant', text: '28px' }])
    chats.save({ id: 'chat-bbbbbbbb', title: 'Review', messages: [message('/review')] })
    expect(chats.list()).toEqual([
      { id: 'chat-bbbbbbbb', title: 'Review', createdAt: expect.any(Number), updatedAt: expect.any(Number), messageCount: 1, tokens: 0 },
      { id: 'chat-aaaaaaaa', title: 'How big is the hero heading?', createdAt: expect.any(Number), updatedAt: expect.any(Number), messageCount: 2, tokens: 1050 },
    ])
    const loaded = chats.load('chat-aaaaaaaa')!
    expect(loaded.history).toEqual([{ role: 'user', text: 'How big is the hero heading?' }, { role: 'assistant', text: '28px' }])
    expect(loaded.messages).toHaveLength(2)
  })

  it('keeps what the agent remembers when only the transcript is saved again', () => {
    const chats = store()
    chats.save({ id: 'chat-aaaaaaaa', messages: [message('a')] }, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }])
    const created = chats.load('chat-aaaaaaaa')!.createdAt
    chats.save({ id: 'chat-aaaaaaaa', messages: [message('a'), message('c')] })
    const loaded = chats.load('chat-aaaaaaaa')!
    expect(loaded.history).toHaveLength(2)
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.createdAt).toBe(created)
    expect(loaded.title).toBe('Chat')
  })

  it('refuses ids that could leave the folder, and drops messages that are not messages', () => {
    const chats = store()
    for (const id of ['../escape', 'a/b/c/d/e/f', 'short', '', 42]) expect(chats.save({ id, messages: [] })).toBeNull()
    expect(chats.load('../../etc/passwd')).toBeNull()
    expect(chats.remove('../x')).toBe(false)
    const saved = chats.save({ id: 'chat-cccccccc', messages: [message('ok'), 'text', null, { no: 'kind' }] })!
    expect(saved.messages).toEqual([message('ok')])
  })

  it('keeps the newest 400 messages and 40 remembered turns', () => {
    const chats = store()
    const saved = chats.save({ id: 'chat-dddddddd', messages: Array.from({ length: 450 }, (_, i) => message(`m${i}`)) }, Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: `t${i}` })))!
    expect(saved.messages).toHaveLength(400)
    expect((saved.messages[0] as { text: string }).text).toBe('m50')
    expect(saved.history).toHaveLength(40)
  })

  it('deletes a chat, and keeps at most 100', () => {
    const chats = store()
    chats.save({ id: 'chat-eeeeeeee', messages: [message('x')] })
    expect(chats.remove('chat-eeeeeeee')).toBe(true)
    expect(chats.list()).toEqual([])
    for (let i = 0; i < 103; i++) {
      chats.save({ id: `chat-${String(i).padStart(8, '0')}`, messages: [message(String(i))] })
      utimesSync(join(root, 'chats', `chat-${String(i).padStart(8, '0')}.json`), new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000))
    }
    chats.save({ id: 'chat-00000102', messages: [message('newest')] })
    expect(readdirSync(join(root, 'chats')).filter((name) => name.endsWith('.json'))).toHaveLength(100)
    expect(chats.load('chat-00000000')).toBeNull() // the oldest went
  })
})
