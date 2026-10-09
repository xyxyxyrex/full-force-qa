import type { QaRunEvent } from './qaAgent'

export type QaChatWindowAction =
  | { type: 'user' | 'status' | 'error'; text: string }
  | { type: 'clear' }
  | { type: 'event'; event: QaRunEvent }
  | { type: 'draft'; input: string; tab: 'chat' | 'findings' }
  | { type: 'open'; view: 'history' | 'settings' | 'tracker'; tab?: 'chats' | 'reviews'; projectKey?: string }

// The host renderer owns the live transcript. The detached surface receives a mirror,
// so closing either view never starts another agent or counts usage twice.
export interface QaChatWindowSnapshot { chat: unknown; theme: string }
