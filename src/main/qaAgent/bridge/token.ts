import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

// The bridge key lives in a file only the current user can read (on systems that support
// file modes), so the `parity` command and an MCP client's headers helper can read it.

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

function writeSecret(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try { chmodSync(dirname(file), 0o700) } catch { /* not supported here */ }
  const temporary = `${file}.tmp`
  writeFileSync(temporary, token, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temporary, 0o600) } catch { /* not supported here */ }
  try { renameSync(temporary, file) } catch { rmSync(file, { force: true }); renameSync(temporary, file) }
}

export function readToken(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim()
    return KEY_PATTERN.test(value) ? value : null
  } catch { return null }
}

/** Existing key, or a new random one. */
export function ensureToken(file: string): string {
  const existing = existsSync(file) ? readToken(file) : null
  if (existing) return existing
  const token = randomBytes(32).toString('base64url')
  writeSecret(file, token)
  return token
}

export function resetToken(file: string): string {
  const token = randomBytes(32).toString('base64url')
  writeSecret(file, token)
  return token
}
