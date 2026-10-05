import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Finds out whether an agent CLI is installed and signed in, without starting a review.

export interface CliDetection {
  installed: boolean
  version: string
  /** true or false when we can tell, null when this CLI offers no way to check. */
  signedIn: boolean | null
  detail: string
}

function run(binary: string, args: string[], timeoutMs = 6000): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv }, (error, stdout) => {
      const code = error ? ((error as NodeJS.ErrnoException).code as unknown as number | string) : 0
      if (code === 'ENOENT') return resolve({ code: null, stdout: '', missing: true })
      resolve({ code: typeof code === 'number' ? code : error ? 1 : 0, stdout: String(stdout || ''), missing: false })
    })
  })
}

const firstLine = (text: string) => text.trim().split('\n')[0]?.trim().slice(0, 80) || ''

export async function detectCli(id: 'claude-code' | 'codex' | 'antigravity', binary?: string): Promise<CliDetection> {
  const exe = binary || (id === 'claude-code' ? 'claude' : id === 'codex' ? 'codex' : 'agy')
  const version = await run(exe, ['--version'])
  if (version.missing) return { installed: false, version: '', signedIn: null, detail: `Not found. Install ${exe} and sign in, then refresh.` }
  const versionText = firstLine(version.stdout)

  if (id === 'claude-code') {
    const auth = await run(exe, ['auth', 'status'])
    try {
      const parsed = JSON.parse(auth.stdout)
      const signedIn = parsed.loggedIn === true
      return { installed: true, version: versionText, signedIn, detail: signedIn ? `${versionText} · signed in (${parsed.authMethod || 'account'})` : `${versionText} · not signed in. Run "claude" once to sign in.` }
    } catch { return { installed: true, version: versionText, signedIn: null, detail: `${versionText} · sign-in status unknown` } }
  }
  if (id === 'codex') {
    const status = await run(exe, ['login', 'status'])
    const signedIn = status.code === 0
    return { installed: true, version: versionText, signedIn, detail: signedIn ? `${versionText} · signed in` : `${versionText} · not signed in. Run "codex login" once.` }
  }
  // Antigravity CLI has no status command; look for the file it keeps its sign-in in.
  const signedIn = existsSync(join(homedir(), '.gemini', 'oauth_creds.json')) ? true : null
  return { installed: true, version: versionText, signedIn, detail: signedIn ? `agy ${versionText} · signed in` : `agy ${versionText} · sign-in status unknown. Run "agy" once to sign in.` }
}

/** The models `agy models` lists, one "slug<TAB>Name" per line. Never throws. */
export async function listAntigravityModels(binary?: string): Promise<{ models: string[]; error?: string }> {
  const result = await run(binary || 'agy', ['models'], 20_000)
  if (result.missing) return { models: [], error: 'agy was not found. Install Antigravity CLI first.' }
  const models = result.stdout.split('\n').map((line) => line.split('\t')[0].trim()).filter((slug) => /^[a-z0-9][a-z0-9._-]*$/i.test(slug) && !/^fetching/i.test(slug))
  return models.length ? { models } : { models: [], error: 'Could not list models. Is agy signed in? Run "agy" once in a terminal.' }
}
