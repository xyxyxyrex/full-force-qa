import { spawn } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { summarize } from './common'
import { AgentError, type AgentEvent, type AgentProvider, type ProviderResult, type ProviderRun } from './types'

// Agent CLIs the person is already logged into (Claude Code, Codex, Gemini CLI), so their
// subscription pays for the review. Each one runs headless in a private temporary folder with
// only Parity's tools attached over the local bridge. The bridge key never goes on a command
// line; it travels in the process environment (or, for Gemini CLI, which cannot read headers
// from the environment, in a settings file that exists only for the length of the run).

export interface BridgeAccess {
  mcpUrl: string
  token: string
}

export interface CliInvocation {
  args: string[]
  env: Record<string, string>
  stdin: string
}

interface ParseState {
  text: string
  failed: string
  /** The last "result" line seen, if the CLI prints one. */
  finished: boolean
}

export interface CliSpec {
  id: string
  label: string
  binary: string
  /** Builds the command for one conversation. `dir` is a private working folder. */
  invoke(input: { run: ProviderRun; bridge: BridgeAccess; dir: string; model?: string }): CliInvocation
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

// ── Gemini CLI ──────────────────────────────────────────────────────────────────────
// As with Codex, built from the published documentation and not yet run against a real install.

export const geminiCliSpec: CliSpec = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  binary: 'gemini',
  invoke({ run, bridge, dir, model }) {
    mkdirSync(join(dir, '.gemini'), { recursive: true })
    // Gemini CLI does not read header values from the environment, so the key sits in this
    // settings file, which is private to the user and deleted when the run ends.
    writePrivate(join(dir, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { parity: { httpUrl: bridge.mcpUrl, headers: { Authorization: `Bearer ${bridge.token}` }, trust: true, includeTools: run.tools, timeout: 300000 } },
    }))
    return {
      args: ['--output-format', 'stream-json', '--approval-mode', 'default', '--allowed-mcp-server-names', 'parity', ...(model ? ['--model', model] : []), '--prompt', ' '],
      env: {},
      stdin: `${run.system}\n\n# Task\n${run.task}`,
    }
  },
  parse(line, emit, state) {
    const event = tryJson(line)
    if (!event) return
    if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string' && event.content) {
      state.text = event.content
      emit({ type: 'text', text: event.content })
    } else if (event.type === 'tool_use') {
      emit({ type: 'tool', name: String(event.tool_name ?? 'tool').replace(/^mcp_parity_/, ''), args: event.parameters })
    } else if (event.type === 'tool_result') {
      emit({ type: 'tool-result', name: 'tool', isError: event.status === 'error', text: summarize(String(event.output ?? '')), images: 0 })
    } else if (event.type === 'result') {
      state.finished = true
      const stats = event.stats
      if (stats) emit({ type: 'usage', inputTokens: Number(stats.input_tokens ?? stats.input) || 0, outputTokens: Number(stats.output_tokens ?? stats.output) || 0 })
      if (event.status === 'error') state.failed = String(event.error?.message ?? 'Gemini CLI reported an error.')
    }
  },
}

// ── Running one conversation ────────────────────────────────────────────────────────

export interface CliProviderOptions {
  /** Path of the executable; defaults to the spec's name on PATH. */
  binary?: string
  model?: string
  getBridge: () => BridgeAccess
}

export function createCliProvider(spec: CliSpec, options: CliProviderOptions): AgentProvider {
  return {
    id: spec.id,
    label: spec.label,
    needsBridge: true,
    async run(run: ProviderRun): Promise<ProviderResult> {
      const bridge = options.getBridge()
      const dir = mkdtempSync(join(tmpdir(), 'parity-agent-'))
      try { chmodSync(dir, 0o700) } catch { /* not supported on this system */ }
      const state: ParseState = { text: '', failed: '', finished: false }
      try {
        const invocation = spec.invoke({ run, bridge, dir, model: options.model })
        const emit = (event: AgentEvent) => run.emit(event)
        const outcome = await new Promise<{ code: number | null; aborted: boolean; timedOut: boolean; stderr: string }>((resolve, reject) => {
          const childEnv: NodeJS.ProcessEnv = { ...process.env, ...invocation.env }
          delete childEnv.ELECTRON_RUN_AS_NODE // set by some launchers; the agent CLIs must not inherit it
          const child = spawn(options.binary || spec.binary, invocation.args, { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
          const handleLine = (line: string) => { try { spec.parse(line, emit, state) } catch { /* a line we cannot read is skipped */ } }
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
