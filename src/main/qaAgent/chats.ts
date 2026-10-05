import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { QaChatListItem, QaStoredChat } from '../../shared/qaAgent'
import type { ChatTurn } from './agents/types'

// Saved QA chats: what the chat panel showed and what the agent remembered, one file per chat,
// so a chat can be reopened and carried on after Parity restarts.

export const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const MAX_MESSAGES = 400
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_CHATS = 100
const MAX_HISTORY = 40

type StoredFile = QaStoredChat & { history: ChatTurn[] }

const clamp = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
const count = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : 0)

export function createChatStore(root: string, now: () => number = () => Date.now()) {
  const file = (id: string) => {
    if (!CHAT_ID_PATTERN.test(id)) throw new Error('That is not a valid chat id.')
    return join(root, `${id}.json`)
  }
  const read = (id: string): StoredFile | null => {
    try {
      const parsed = JSON.parse(readFileSync(file(id), 'utf8')) as StoredFile
      return parsed?.version === 1 && parsed.id === id ? { ...parsed, messages: Array.isArray(parsed.messages) ? parsed.messages : [], history: Array.isArray(parsed.history) ? parsed.history : [] } : null
    } catch { return null }
  }

  function prune(): void {
    let names: string[] = []
    try { names = readdirSync(root).filter((name) => name.endsWith('.json')) } catch { return }
    if (names.length <= MAX_CHATS) return
    const byAge = names.map((name) => ({ name, at: statSync(join(root, name)).mtimeMs })).sort((a, b) => b.at - a.at)
    for (const old of byAge.slice(MAX_CHATS)) rmSync(join(root, old.name), { force: true })
  }

  return {
    list(): QaChatListItem[] {
      let names: string[] = []
      try { names = readdirSync(root).filter((name) => name.endsWith('.json')) } catch { return [] }
      return names
        .map((name) => read(name.slice(0, -5)))
        .filter((chat): chat is StoredFile => !!chat)
        .map((chat) => ({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messageCount: chat.messages.length, tokens: (chat.session?.input ?? 0) + (chat.session?.output ?? 0) }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    /** The chat as saved, with what the agent remembers. */
    load(id: string): StoredFile | null {
      return CHAT_ID_PATTERN.test(id) ? read(id) : null
    },

    /** Saves what the chat shows; `history` is what the agent remembers, kept from before when not given. */
    save(input: { id: unknown; title?: unknown; agentLabel?: unknown; messages?: unknown; session?: unknown }, history?: ChatTurn[]): StoredFile | null {
      const id = typeof input.id === 'string' && CHAT_ID_PATTERN.test(input.id) ? input.id : null
      if (!id) return null
      const previous = read(id)
      let messages = (Array.isArray(input.messages) ? input.messages : previous?.messages ?? [])
        .filter((message) => message && typeof message === 'object' && typeof (message as { kind?: unknown }).kind === 'string')
        .slice(-MAX_MESSAGES)
      const session = input.session && typeof input.session === 'object' ? input.session as Record<string, unknown> : null
      const chat: StoredFile = {
        version: 1, id,
        title: clamp(input.title, 120) || previous?.title || 'Chat',
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
        agentLabel: clamp(input.agentLabel, 120) || previous?.agentLabel,
        messages,
        session: session ? { input: count(session.input), output: count(session.output), requests: count(session.requests) } : previous?.session,
        history: (history ?? previous?.history ?? []).slice(-MAX_HISTORY),
      }
      // A chat with a very long transcript keeps its newest messages.
      while (messages.length > 1 && JSON.stringify(chat).length > MAX_FILE_BYTES) { messages = messages.slice(Math.ceil(messages.length / 4)); chat.messages = messages }
      mkdirSync(root, { recursive: true })
      const target = file(id)
      writeFileSync(`${target}.tmp`, JSON.stringify(chat), 'utf8')
      try { renameSync(`${target}.tmp`, target) } catch { rmSync(target, { force: true }); renameSync(`${target}.tmp`, target) }
      prune()
      return chat
    },

    remove(id: string): boolean {
      if (!CHAT_ID_PATTERN.test(id)) return false
      try { rmSync(file(id)); return true } catch { return false }
    },
  }
}

export type ChatStore = ReturnType<typeof createChatStore>
