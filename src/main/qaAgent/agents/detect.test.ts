import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectCli } from './detect'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-detect-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fake = (script: string) => {
  const file = join(dir, 'fake')
  writeFileSync(file, `#!/usr/bin/env node\n${script}`)
  chmodSync(file, 0o755)
  return file
}

describe.skipIf(process.platform === 'win32')('detectCli', () => {
  it('reports a missing CLI with advice', async () => {
    expect(await detectCli('codex', join(dir, 'nope'))).toMatchObject({ installed: false, signedIn: null, detail: expect.stringContaining('Not found') })
  })

  it('reads Claude Code\'s version and sign-in state', async () => {
    const signedIn = fake(`const a = process.argv.slice(2); if (a[0] === '--version') console.log('2.1.284 (Claude Code)'); else if (a[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))`)
    expect(await detectCli('claude-code', signedIn)).toEqual({ installed: true, version: '2.1.284 (Claude Code)', signedIn: true, detail: '2.1.284 (Claude Code) · signed in (claude.ai)' })
    const signedOut = fake(`const a = process.argv.slice(2); if (a[0] === '--version') console.log('2.1.284'); else console.log(JSON.stringify({ loggedIn: false }))`)
    expect(await detectCli('claude-code', signedOut)).toMatchObject({ installed: true, signedIn: false, detail: expect.stringContaining('not signed in') })
    const unreadable = fake(`const a = process.argv.slice(2); if (a[0] === '--version') console.log('2.1.284'); else console.log('???')`)
    expect(await detectCli('claude-code', unreadable)).toMatchObject({ installed: true, signedIn: null })
  })

  it('uses the exit code of "codex login status"', async () => {
    const ok = fake(`const a = process.argv.slice(2); if (a[0] === '--version') console.log('codex-cli 0.9'); else process.exit(0)`)
    expect(await detectCli('codex', ok)).toMatchObject({ installed: true, signedIn: true, version: 'codex-cli 0.9' })
    const out = fake(`const a = process.argv.slice(2); if (a[0] === '--version') console.log('codex-cli 0.9'); else process.exit(1)`)
    expect(await detectCli('codex', out)).toMatchObject({ installed: true, signedIn: false, detail: expect.stringContaining('codex login') })
  })

  it('cannot tell for Gemini CLI unless it finds a key or login', async () => {
    const gemini = fake(`console.log('0.4.1')`)
    const saved = { a: process.env.GEMINI_API_KEY, b: process.env.GOOGLE_API_KEY }
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY
    try {
      const result = await detectCli('gemini-cli', gemini)
      expect(result.installed).toBe(true)
      expect([true, null]).toContain(result.signedIn) // true only when this computer already has a Gemini login file
      process.env.GEMINI_API_KEY = 'x'
      expect((await detectCli('gemini-cli', gemini)).signedIn).toBe(true)
    } finally {
      if (saved.a === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.a
      if (saved.b === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = saved.b
    }
  })
})
