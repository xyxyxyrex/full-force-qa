import { webContents as electronWebContents, type WebContents } from 'electron'

type DebuggerMessage = (method: string, params: any, sessionId?: string) => void
type DebuggerDetach = (reason: string) => void

interface Entry {
  target: WebContents
  owners: Set<string>
  attachedByManager: boolean
  messages: Set<DebuggerMessage>
  detaches: Set<DebuggerDetach>
  resumes: Set<() => void>
  exclusiveOwner?: string
  activeCommands: Map<string, number>
  stateWaiters: Set<() => void>
  onMessage: (_event: unknown, method: string, params: any, sessionId?: string) => void
  onDetach: (_event: unknown, reason: string) => void
}

const entries = new Map<number, Entry>()

export interface DebuggerLease {
  target: WebContents
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  onMessage(listener: DebuggerMessage): () => void
  onDetach(listener: DebuggerDetach): () => void
  onResume(listener: () => void): () => void
  beginExclusive(): Promise<() => void>
  release(): void
}

function notifyState(entry: Entry) {
  const waiters = [...entry.stateWaiters]
  entry.stateWaiters.clear()
  waiters.forEach(resolve => resolve())
}

async function waitForState(entry: Entry) {
  await new Promise<void>(resolve => entry.stateWaiters.add(resolve))
}

export function acquireDebugger(webContentsId: number, owner: string): DebuggerLease {
  const target = electronWebContents.fromId(webContentsId)
  if (!target || target.isDestroyed()) throw new Error('The inspected page is no longer available.')
  let entry = entries.get(webContentsId)
  if (!entry) {
    const attachedByManager = !target.debugger.isAttached()
    if (attachedByManager) target.debugger.attach('1.3')
    entry = {
      target,
      owners: new Set(),
      attachedByManager,
      messages: new Set(),
      detaches: new Set(),
      resumes: new Set(),
      activeCommands: new Map(),
      stateWaiters: new Set(),
      onMessage: (_event, method, params, sessionId) => {
        for (const listener of entry!.messages) listener(method, params, sessionId)
      },
      onDetach: (_event, reason) => {
        entries.delete(webContentsId)
        entry!.target.debugger.removeListener('message', entry!.onMessage)
        entry!.target.debugger.removeListener('detach', entry!.onDetach)
        entry!.exclusiveOwner = undefined
        notifyState(entry!)
        for (const listener of [...entry!.detaches]) listener(reason)
        entry!.messages.clear()
        entry!.detaches.clear()
        entry!.resumes.clear()
      },
    }
    target.debugger.on('message', entry.onMessage)
    target.debugger.on('detach', entry.onDetach)
    entries.set(webContentsId, entry)
  }
  entry.owners.add(owner)
  let released = false
  return {
    target,
    async send(method, params, sessionId) {
      while (entry!.exclusiveOwner && entry!.exclusiveOwner !== owner) await waitForState(entry!)
      entry!.activeCommands.set(owner, (entry!.activeCommands.get(owner) || 0) + 1)
      try { return await entry!.target.debugger.sendCommand(method, params, sessionId) as any }
      finally {
        const remaining = (entry!.activeCommands.get(owner) || 1) - 1
        if (remaining > 0) entry!.activeCommands.set(owner, remaining)
        else entry!.activeCommands.delete(owner)
        notifyState(entry!)
      }
    },
    onMessage(listener) { entry!.messages.add(listener); return () => entry?.messages.delete(listener) },
    onDetach(listener) { entry!.detaches.add(listener); return () => entry?.detaches.delete(listener) },
    onResume(listener) { entry!.resumes.add(listener); return () => entry?.resumes.delete(listener) },
    async beginExclusive() {
      while (entry!.exclusiveOwner && entry!.exclusiveOwner !== owner) await waitForState(entry!)
      entry!.exclusiveOwner = owner
      while ([...entry!.activeCommands].some(([activeOwner, count]) => activeOwner !== owner && count > 0)) await waitForState(entry!)
      let resumed = false
      return () => {
        if (resumed) return
        resumed = true
        if (entry?.exclusiveOwner === owner) entry.exclusiveOwner = undefined
        if (entry) {
          notifyState(entry)
          for (const listener of entry.resumes) listener()
        }
      }
    },
    release() {
      if (released) return
      released = true
      const current = entries.get(webContentsId)
      if (!current) return
      current.owners.delete(owner)
      current.activeCommands.delete(owner)
      if (current.exclusiveOwner === owner) current.exclusiveOwner = undefined
      notifyState(current)
      if (current.owners.size) return
      current.target.debugger.removeListener('message', current.onMessage)
      current.target.debugger.removeListener('detach', current.onDetach)
      entries.delete(webContentsId)
      if (current.attachedByManager && current.target.debugger.isAttached()) current.target.debugger.detach()
    },
  }
}
