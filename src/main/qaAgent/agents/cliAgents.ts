import { spawn } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { summarize, withHistory } from './common'
import { AgentError, type AgentEvent, type AgentProvider, type ProviderResult, type ProviderRun } from './types'

// Agent CLIs the person is already logged into (Claude Code, Codex, Antigravity CLI), so their
// subscription pays for the review. Each one runs headless in a private temporary folder with
// only Parity's tools attached over the local bridge. The bridge key never goes on a command
// line; it travels in the process environment (or, for Antigravity CLI, which cannot read headers
// from the environment, in a config file that exists only for the length of the run).

export interface BridgeAccess {
  mcpUrl: string
  token: string
}

export interface CliInvocation {
  args: string[]
  env: Record<string, string>
  stdin: string
  /** Working folder for the process; defaults to the run's private folder. */
  cwd?: string
  /** A file the agent's safety hook appends to on every tool call. If a tool ran and it is missing, the hook is not working and the run is stopped. */
  guardLog?: string
}

interface ParseState {
  text: string
  failed: string
  /** The last "result" line seen, if the CLI prints one. */
  finished: boolean
  /** Set when the run broke a safety rule; the run is stopped and this is shown. */
  violation: string
  /** Tool steps that have ended; used to check the safety hook ran. */
  toolsFinished: number
  usageSeen: boolean
  streamedSteps: Set<number>
  denied: string[]
}

export interface CliSpec {
  id: string
  label: string
  binary: string
  /** Builds the command for one conversation. `dir` is a private working folder. */
  invoke(input: { run: ProviderRun; bridge: BridgeAccess; dir: string; model?: string; homeDir?: string }): CliInvocation
  /** Turns one line of the CLI's output into events. */
  parse(line: string, emit: (event: AgentEvent) => void, state: ParseState): void
}

const CONVERSATION_LIMIT_MS = 45 * 60 * 1000
const KILL_GRACE_MS = 3000
const toolNames = (names: string[]) => names.map((name) => `mcp__parity__${name}`)

const redact = (text: string, token: string) => (token ? text.split(token).join('[key]') : text)
function tryJson(line: string): any | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try { return JSON.parse(trimmed) } catch { return null }
}
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).filter(Boolean).join('\n')
  return ''
}
const countImages = (content: unknown): number => (Array.isArray(content) ? content.filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'image').length : 0)

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* not supported on this system */ }
}

// ── Claude Code ─────────────────────────────────────────────────────────────────────

export const claudeCodeSpec: CliSpec = {
  id: 'claude-code',
  label: 'Claude Code',
  binary: 'claude',
  invoke({ run, bridge, dir, model }) {
    const mcpConfig = join(dir, 'mcp.json')
    const system = join(dir, 'system.md')
    // The ${…} placeholder is filled in by Claude Code from the environment, so the key is never written to disk.
    writePrivate(mcpConfig, JSON.stringify({ mcpServers: { parity: { type: 'http', url: bridge.mcpUrl, headers: { Authorization: 'Bearer ${PARITY_BRIDGE_KEY}' } } } }))
    writePrivate(system, run.system)
    return {
      args: [
        '-p',
        '--output-format', 'stream-json', '--verbose',
        '--mcp-config', mcpConfig, '--strict-mcp-config',
        '--tools', '',
        '--allowedTools', toolNames(run.tools).join(','),
        '--permission-mode', 'dontAsk',
        '--append-system-prompt-file', system,
        '--no-session-persistence',
        '--setting-sources', 'project',
        ...(model ? ['--model', model] : []),
      ],
      env: { PARITY_BRIDGE_KEY: bridge.token },
      stdin: run.task,
    }
  },
  parse(line, emit, state) {
    const message = tryJson(line)
    if (!message) return
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && block.text) { state.text = block.text; emit({ type: 'text', text: block.text }) }
        if (block.type === 'tool_use') emit({ type: 'tool', name: String(block.name).replace(/^mcp__parity__/, ''), args: block.input })
      }
    } else if (message.type === 'user') {
      for (const block of message.message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        emit({ type: 'tool-result', name: 'tool', isError: !!block.is_error, text: summarize(textOf(block.content)), images: countImages(block.content) })
      }
    } else if (message.type === 'result') {
      state.finished = true
      if (message.usage) emit({ type: 'usage', inputTokens: (message.usage.input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens ?? 0 })
      if (typeof message.result === 'string' && message.result) state.text = message.result
      if (message.is_error) state.failed = typeof message.result === 'string' && message.result ? message.result : 'Claude Code reported an error.'
    }
  },
}

// ── Codex ───────────────────────────────────────────────────────────────────────────
// Flags and event names follow OpenAI's published Codex CLI documentation. They have not
// been run against a real Codex install, so the parser ignores lines it does not recognise.

export const codexSpec: CliSpec = {
  id: 'codex',
  label: 'Codex',
  binary: 'codex',
  invoke({ run, bridge, model }) {
    const tools = JSON.stringify(run.tools)
    return {
      args: [
        'exec', '--json', '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '-c', 'approval_policy="never"',
        '-c', `mcp_servers.parity.url=${JSON.stringify(bridge.mcpUrl)}`,
        '-c', 'mcp_servers.parity.bearer_token_env_var="PARITY_BRIDGE_KEY"',
        '-c', `mcp_servers.parity.enabled_tools=${tools}`,
        '-c', 'mcp_servers.parity.tool_timeout_sec=300',
        '-c', 'mcp_servers.parity.startup_timeout_sec=30',
        ...(model ? ['--model', model] : []),
        '-',
      ],
      env: { PARITY_BRIDGE_KEY: bridge.token },
      // Codex has no separate system prompt flag, so the instructions lead the prompt.
      stdin: `${run.system}\n\n# Task\n${run.task}`,
    }
  },
  parse(line, emit, state) {
    const event = tryJson(line)
    if (!event) return
    const item = event.item
    if ((event.type === 'item.completed' || event.type === 'item.updated') && item?.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      state.text = item.text
      emit({ type: 'text', text: item.text })
    } else if (event.type === 'item.started' && item?.type === 'mcp_tool_call') {
      emit({ type: 'tool', name: String(item.tool ?? item.name ?? 'tool'), args: item.arguments })
    } else if (event.type === 'item.completed' && item?.type === 'mcp_tool_call') {
      const content = item.result?.content ?? item.result
      emit({ type: 'tool-result', name: String(item.tool ?? item.name ?? 'tool'), isError: item.status === 'failed' || !!item.error, text: summarize(textOf(content) || String(item.error?.message ?? '')), images: countImages(content) })
    } else if (event.type === 'turn.completed') {
      state.finished = true
      if (event.usage) emit({ type: 'usage', inputTokens: Number(event.usage.input_tokens) || 0, outputTokens: Number(event.usage.output_tokens) || 0 })
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      state.failed = String(event.error?.message ?? event.message ?? 'Codex reported an error.')
    }
  },
}

// ── Antigravity CLI (agy) ───────────────────────────────────────────────────────────
// Replaces Gemini CLI. Checked against agy 1.2.16 (`agy --help`, its documentation and live
// runs). Three facts shape this adapter:
//  - Headless runs refuse every tool that is not allowed in settings.json, and a refusal ends
//    the turn with no answer. Parity must therefore grant its own tools there.
//  - It reads its settings and MCP servers from ~/.gemini and cannot be pointed elsewhere. The
//    person's own files are never edited: the run gets a private HOME with only the sign-in
//    files linked in, its own settings (allow only Parity's tools) and its own MCP server.
//  - Some tools (web search) need no permission, so a PreToolUse hook denies everything except
//    Parity's tools. A hook that fails, fails closed; if it never runs the run is stopped.

const AGY_LOGIN_FILES = ['oauth_creds.json', 'google_accounts.json', 'installation_id']
const AGY_PERMISSION_FREE = ['finish', 'wait', 'wait_5_seconds']

const shellQuote = (value: string) => (process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`)

/** The script agy runs before every tool call. Plain Node, so Electron's own Node can run it. */
export function agyGuardScript(config: { server: string; tools: string[]; mcpDir: string; log: string }): string {
  return `const fs = require('fs'), path = require('path')
const CONFIG = ${JSON.stringify({ ...config, free: AGY_PERMISSION_FREE })}
let raw = ''
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let call = {}
  try { call = JSON.parse(raw).toolCall || {} } catch (error) { /* an unreadable call is denied below */ }
  const name = String(call.name || '')
  const args = call.args || {}
  let allowed = false
  if (name === 'call_mcp_tool') allowed = args.ServerName === CONFIG.server && CONFIG.tools.includes(args.ToolName)
  else if (name === 'view_file') {
    // agy describes MCP tools in small files it reads itself; nothing else may be read.
    try { const real = fs.realpathSync(String(args.AbsolutePath || '')); allowed = real.startsWith(CONFIG.mcpDir + path.sep) && real.endsWith('.json') } catch (error) { allowed = false }
  } else allowed = CONFIG.free.includes(name)
  try { fs.appendFileSync(CONFIG.log, name + ' ' + (allowed ? 'allow' : 'deny') + '\\n') } catch (error) { /* the run checks for this file */ }
  process.stdout.write(JSON.stringify(allowed ? { decision: 'ask' } : { decision: 'deny', reason: 'Parity only lets this agent use its own QA tools.' }))
})
`
}

function linkLoginFiles(realHome: string, homeDir: string): void {
  mkdirSync(join(homeDir, '.gemini'), { recursive: true })
  for (const file of AGY_LOGIN_FILES) {
    const source = join(realHome, '.gemini', file)
    if (!existsSync(source)) continue
    const target = join(homeDir, '.gemini', file)
    try { symlinkSync(source, target) } catch { try { copyFileSync(source, target); chmodSync(target, 0o600) } catch { /* sign-in then fails with agy's own message */ } }
  }
}

const agyToolName = (info: any): string => (info?.name === 'call_mcp_tool' ? String(info.parameters?.ToolName ?? 'tool') : String(info?.name ?? 'tool'))
// agy reads the description of each MCP tool from a file before first using it; that is plumbing, not something to show.
const isAgySchemaRead = (info: any): boolean => info?.name === 'view_file' && /[\\/]antigravity-cli[\\/]mcp[\\/]/.test(String(info.parameters?.AbsolutePath ?? ''))

export const antigravitySpec: CliSpec = {
  id: 'antigravity',
  label: 'Antigravity CLI',
  binary: 'agy',
  invoke({ run, bridge, dir, model, homeDir: realHome = homedir() }) {
    const root = realpathSync(dir)
    const home = join(root, 'home')
    const work = join(root, 'work')
    const mcpDir = join(home, '.gemini', 'antigravity-cli', 'mcp')
    const log = join(root, 'guard.log')
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(join(work, '.agents'), { recursive: true })
    linkLoginFiles(realHome, home)

    // agy does not expand variables in headers, so the key is written here, in a private folder that is deleted when the run ends.
    writePrivate(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { parity: { serverUrl: bridge.mcpUrl, headers: { Authorization: `Bearer ${bridge.token}` } } } }))
    writePrivate(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({
      trustedWorkspaces: [work],
      permissions: { allow: [...run.tools.map((tool) => `mcp(parity/${tool})`), `read_file(${mcpDir}/)`] },
    }))
    const guard = join(work, '.agents', 'guard.cjs')
    writePrivate(guard, agyGuardScript({ server: 'parity', tools: run.tools, mcpDir, log }))
    const runner = process.platform === 'win32' ? `set ELECTRON_RUN_AS_NODE=1&& ${shellQuote(process.execPath)} ${shellQuote(guard)}` : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(guard)}`
    writePrivate(join(work, '.agents', 'hooks.json'), JSON.stringify({ 'parity-guard': { PreToolUse: [{ matcher: '*', hooks: [{ command: runner, timeout: 10 }] }] } }))

    return {
      args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0', ...(model ? ['--model', model] : []), '-p='],
      env: { HOME: home, USERPROFILE: home },
      cwd: work,
      guardLog: log,
      // agy has no system prompt flag, so the instructions lead the message. Stdin keeps the text off the command line.
      stdin: `${JSON.stringify({ event: 'user', message: { content: `${run.system}\n\n# Task\n${run.task}` } })}\n`,
    }
  },
  parse(line, emit, state) {
    const event = tryJson(line)
    if (!event) return
    if (event.event === 'step_update') {
      const step = event.step_update ?? {}
      if (step.step_type === 'agent_response') {
        const text = typeof step.text_delta === 'string' ? step.text_delta : ''
        if (step.state === 'ACTIVE' && text) { state.streamedSteps.add(step.step_index); emit({ type: 'text', text, delta: true }) }
        else if (step.state === 'DONE') {
          if (text && !state.streamedSteps.has(step.step_index)) emit({ type: 'text', text: text.trim() })
          // Usage is per model call here; the final result repeats the running total.
          if (step.usage) { state.usageSeen = true; emit({ type: 'usage', inputTokens: (Number(step.usage.input_tokens) || 0) + (Number(step.usage.cache_read_tokens) || 0), outputTokens: Number(step.usage.output_tokens) || 0 }) }
        }
      } else if (step.step_type === 'tool') {
        const info = step.tool_info
        if (isAgySchemaRead(info)) { if (step.state !== 'ACTIVE') state.toolsFinished++; return }
        if (step.state === 'ACTIVE') emit({ type: 'tool', name: agyToolName(info), args: info?.name === 'call_mcp_tool' ? info.parameters?.Arguments : info?.parameters })
        else {
          state.toolsFinished++
          const failed = step.state === 'ERROR' || !!info?.error
          emit({ type: 'tool-result', name: agyToolName(info), isError: failed, text: summarize(String(failed ? info?.error?.message ?? 'The tool failed.' : info?.output ?? 'done')), images: 0 })
        }
      }
    } else if (event.event === 'result') {
      const result = event.result ?? {}
      state.finished = true
      if (!state.usageSeen && result.usage) emit({ type: 'usage', inputTokens: (Number(result.usage.input_tokens) || 0) + (Number(result.usage.cache_read_tokens) || 0), outputTokens: Number(result.usage.output_tokens) || 0 })
      const response = typeof result.response === 'string' ? result.response.trim() : ''
      if (response) state.text = response
      state.denied = Array.isArray(result.denied_actions) ? result.denied_actions.map((d: any) => String(d?.display_name ?? d?.action ?? 'a tool')) : []
      if (result.status === 'ERROR') state.failed = String(result.error || 'Antigravity CLI reported an error.')
      else if (result.status !== 'SUCCESS') state.failed = `Antigravity CLI ended with status ${String(result.status)}${result.error ? `: ${result.error}` : '.'}`
      else if (!response && state.denied.length) state.failed = `The agent tried to use ${[...new Set(state.denied)].join(', ')}, which Parity does not allow, and stopped before answering. Ask again, or use another agent.`
    }
  },
}

// ── Running one conversation ────────────────────────────────────────────────────────

export interface CliProviderOptions {
  /** Path of the executable; defaults to the spec's name on PATH. */
  binary?: string
  model?: string
  getBridge: () => BridgeAccess
  /** Where the person's own home folder is, for tests. */
  homeDir?: string
}

export function createCliProvider(spec: CliSpec, options: CliProviderOptions): AgentProvider {
  return {
    id: spec.id,
    label: spec.label,
    needsBridge: true,
    async run(chat: ProviderRun): Promise<ProviderResult> {
      const run = { ...chat, task: withHistory(chat.task, chat.history) }
      const bridge = options.getBridge()
      const dir = mkdtempSync(join(tmpdir(), 'parity-agent-'))
      try { chmodSync(dir, 0o700) } catch { /* not supported on this system */ }
      const state: ParseState = { text: '', failed: '', finished: false, violation: '', toolsFinished: 0, usageSeen: false, streamedSteps: new Set(), denied: [] }
      try {
        const invocation = spec.invoke({ run, bridge, dir, model: options.model, homeDir: options.homeDir })
        const emit = (event: AgentEvent) => run.emit(event)
        const outcome = await new Promise<{ code: number | null; aborted: boolean; timedOut: boolean; stderr: string }>((resolve, reject) => {
          const childEnv: NodeJS.ProcessEnv = { ...process.env, ...invocation.env }
          delete childEnv.ELECTRON_RUN_AS_NODE // set by some launchers; the agent CLIs must not inherit it
          const child = spawn(options.binary || spec.binary, invocation.args, { cwd: invocation.cwd ?? dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
          let stderr = ''
          let buffer = ''
          let aborted = false
          let timedOut = false
          const stop = () => {
            child.kill('SIGTERM')
            setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, KILL_GRACE_MS).unref()
          }
          const onAbort = () => { aborted = true; stop() }
          run.signal.addEventListener('abort', onAbort, { once: true })
          const limit = setTimeout(() => { timedOut = true; stop() }, CONVERSATION_LIMIT_MS)
          const handleLine = (line: string) => {
            try { spec.parse(line, emit, state) } catch { /* a line we cannot read is skipped */ }
            // A tool ran, so the safety hook must have run before it. If not, the agent is not being held to its allowed tools.
            if (invocation.guardLog && state.toolsFinished > 0 && !state.violation && !existsSync(invocation.guardLog)) {
              state.violation = `${spec.label} used a tool without Parity's safety check running, so the run was stopped.`
              stop()
            }
          }
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (chunk: string) => {
            buffer += chunk
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
          })
          child.stderr.setEncoding('utf8')
          child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
          child.once('error', (error: NodeJS.ErrnoException) => {
            clearTimeout(limit); run.signal.removeEventListener('abort', onAbort)
            reject(error.code === 'ENOENT' ? new AgentError(`${spec.label} is not installed (looked for "${options.binary || spec.binary}"). Install it and sign in, then try again.`) : new AgentError(error.message))
          })
          child.once('close', (code) => {
            clearTimeout(limit); run.signal.removeEventListener('abort', onAbort)
            if (buffer.trim()) handleLine(buffer)
            resolve({ code, aborted, timedOut, stderr })
          })
          child.stdin.on('error', () => { /* the process may exit before reading everything */ })
          child.stdin.end(invocation.stdin)
        })

        if (state.violation) throw new AgentError(state.violation)
        if (outcome.aborted) return { stopped: 'aborted', text: state.text }
        if (outcome.timedOut) throw new AgentError(`${spec.label} did not finish within 45 minutes and was stopped.`)
        if (state.failed) throw new AgentError(redact(`${spec.label}: ${state.failed}`, bridge.token))
        if (outcome.code !== 0 && !state.finished) {
          const detail = redact(outcome.stderr.trim().split('\n').slice(-6).join(' '), bridge.token)
          throw new AgentError(`${spec.label} stopped with an error${detail ? `: ${detail}` : ` (exit code ${outcome.code}).`} If you are not signed in, run it once in a terminal to sign in.`)
        }
        return { stopped: 'finished', text: state.text }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
