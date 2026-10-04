import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureToken, readToken, resetToken } from './token'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-token-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bridge key', () => {
  it('creates a 256-bit URL-safe key once and keeps it', () => {
    const file = join(dir, 'qa-agent', 'token')
    const first = ensureToken(file)
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(ensureToken(file)).toBe(first)
    expect(readToken(file)).toBe(first)
  })

  it('replaces it on reset', () => {
    const file = join(dir, 'token')
    const first = ensureToken(file)
    const second = resetToken(file)
    expect(second).not.toBe(first)
    expect(readToken(file)).toBe(second)
  })

  it('regenerates a damaged key file', () => {
    const file = join(dir, 'token')
    writeFileSync(file, 'short')
    expect(readToken(file)).toBeNull()
    expect(ensureToken(file)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it.skipIf(process.platform === 'win32')('is readable only by its owner', () => {
    const file = join(dir, 'qa-agent', 'token')
    ensureToken(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'qa-agent')).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(dir, 'qa-agent'))).toEqual(['token'])
  })
})
