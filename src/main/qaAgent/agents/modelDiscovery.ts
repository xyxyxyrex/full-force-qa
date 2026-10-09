import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import type { AgentModelList, AgentModelOption } from '../../../shared/qaAgent'

/** Metadata-only CLI sessions: never send a user prompt or start a thread/turn. */
export function discoverCliModels(
  id: 'claude-code' | 'codex',
  options: { binary?: string; prefixArgs?: string[]; timeoutMs?: number } = {},
): Promise<AgentModelList> {
  const label = id === 'codex' ? 'Codex' : 'Claude Code'
  const advice = `Could not load ${label} models. Update the CLI and sign in, then refresh models. You can still use App default or a custom model.`
  return new Promise((resolve) => {
    let dir: string
    try { dir = mkdtempSync(join(tmpdir(), 'parity-models-')) } catch { resolve({ models: [], error: advice }); return }
    const args = id === 'codex' ? ['app-server'] : [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence', '--setting-sources', 'project',
    ]
    const child = spawn(options.binary || (id === 'codex' ? 'codex' : 'claude'), [...(options.prefixArgs || []), ...args], {
      cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    })
    let settled = false
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    let received = 0
    let requestId = 1
    let pageCount = 0
    const cursors = new Set<string>()
    const models = new Map<string, AgentModelOption>()
    let recommended: string | undefined
    const clean = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* process may still be closing */ } }
    const stop = () => {
      child.stdin.destroy()
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => child.kill())
        } else {
          child.kill('SIGTERM')
          const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
          force.unref()
          child.once('close', () => clearTimeout(force))
        }
      }
    }
    const finish = (result: AgentModelList) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      resolve(result)
    }
    const fail = () => finish({ models: [], error: advice })
    const timer = setTimeout(() => finish({ models: [], error: `${label} took too long to list models. Try Refresh models, or use App default.` }), options.timeoutMs ?? 20_000)
    const send = (value: unknown) => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n') }
    const complete = () => finish({ models: [...models.keys()], options: [...models.values()], ...(recommended ? { recommended } : {}), ...(!models.size ? { error: advice } : {}) })
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stderr.resume() // Never surface raw CLI output (it can contain account information).
    child.once('close', () => { if (!settled) fail(); clean() })
    child.stdout.on('data', (data: Buffer) => {
      received += data.length
      if (received > 2_000_000) { fail(); return }
      buffer += decoder.write(data)
      let end: number
      while (!settled && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let message: any
        try { message = JSON.parse(line) } catch { continue }
        if (!message || typeof message !== 'object') continue
        if (id === 'claude-code') {
          if (message.type !== 'control_response' || message.response?.request_id !== 'parity-models') continue
          const response = message.response
          if (response.subtype !== 'success' || !Array.isArray(response.response?.models)) { fail(); return }
          for (const model of response.response.models) {
            if (!model || typeof model !== 'object') continue
            if (typeof model.value !== 'string' || !model.value || model.value === 'default') continue
            models.set(model.value, { id: model.value, label: typeof model.displayName === 'string' ? model.displayName : model.value, ...(typeof model.description === 'string' ? { description: model.description } : {}) })
          }
          complete()
        } else {
          if (message.id !== requestId) continue
          if (message.error || !message.result) { fail(); return }
          if (requestId === 1) {
            send({ method: 'initialized', params: {} })
            send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false } })
            continue
          }
          if (!Array.isArray(message.result.data)) { fail(); return }
          for (const model of message.result.data) {
            if (!model || typeof model !== 'object') continue
            const name = model.model || model.id
            if (typeof name !== 'string' || !name || model.hidden) continue
            models.set(name, { id: name, label: typeof model.displayName === 'string' ? model.displayName : name, ...(typeof model.description === 'string' ? { description: model.description } : {}) })
            if (model.isDefault) recommended = name
          }
          const cursor = message.result.nextCursor
          if (cursor) {
            if (typeof cursor !== 'string' || cursors.has(cursor) || ++pageCount >= 30) { fail(); return }
            cursors.add(cursor)
            send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } })
          } else complete()
        }
      }
    })
    if (id === 'codex') send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'parity_models', version: '1.0.0' } } })
    else send({ type: 'control_request', request_id: 'parity-models', request: { subtype: 'initialize' } })
  })
}
