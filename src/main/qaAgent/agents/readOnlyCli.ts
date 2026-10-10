import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'

/** Bounded metadata commands only. No model prompt, thread, bridge or review is started. */
export function readOnlyCli(options: {
  binary: string; args: string[]; timeoutMs?: number; signal?: AbortSignal
  start?: (send: (message: unknown) => void) => void
  line?: (line: string, send: (message: unknown) => void) => string | undefined
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('Cancelled.')); return }
    const dir = mkdtempSync(join(tmpdir(), 'parity-quota-'))
    const child = spawn(options.binary, options.args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
    let settled = false, buffer = '', output = '', size = 0
    const decoder = new StringDecoder('utf8')
    const kill = () => {
      child.stdin.destroy()
      if (!child.pid || child.exitCode !== null) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else {
        child.kill('SIGTERM')
        const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
        force.unref(); child.once('close', () => clearTimeout(force))
      }
    }
    const finish = (error?: Error, value = output) => {
      if (settled) return
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); kill()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error('Cancelled.'))
    const timer = setTimeout(() => finish(new Error('The quota check took too long. Retry after checking the CLI connection.')), options.timeoutMs ?? 20_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    const send = (value: unknown) => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n') }
    child.on('error', () => finish(new Error('The CLI was not found. Install or update it and sign in, then retry.')))
    child.stdin.on('error', () => finish(new Error('The CLI connection closed. Update the CLI and sign in, then retry.')))
    child.stderr.resume() // Do not return raw diagnostics, account details or credentials.
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) { finish(new Error('The CLI returned an unusable quota response.')); return }
      const text = decoder.write(chunk); output += text; buffer += text
      if (!options.line) return
      let end: number
      while (!settled && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try { const value = options.line(line, send); if (value !== undefined) finish(undefined, value) }
        catch { finish(new Error('Could not read quota. Update the CLI and sign in, then retry.')) }
      }
    })
    child.once('close', code => {
      if (!settled) finish(code === 0 && !options.line ? undefined : new Error('Could not read quota. Update the CLI and sign in, then retry.'))
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* process files may still be closing */ }
    })
    options.start?.(send)
  })
}
