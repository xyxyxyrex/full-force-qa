import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agyGuardScript, agyHookLauncher, agyReadRules, antigravitySpec, claudeCodeSpec, codexSpec, createCliProvider, sweepStaleAgentFolders, type CliSpec } from './cliAgents'
import type { AgentEvent, ProviderRun } from './types'

const TOKEN = 'FAKEKEY'.repeat(6) + 'abc'
const BRIDGE = { mcpUrl: 'http://127.0.0.1:29849/mcp', token: TOKEN }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-cli-agents-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in agent CLI: records how it was started, then prints the given lines and exits. */
function fakeCli(options: { lines?: string[]; stderr?: string; exitCode?: number; hangMs?: number; touchGuard?: boolean; agyLog?: string }): { binary: string; record: () => any } {
  const binary = join(dir, 'fake-agent')
  const recordFile = join(dir, 'record.json')
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
let stdin = ''
process.stdin.on('data', (c) => { stdin += c })
process.stdin.on('end', () => {
  const cwd = process.cwd()
  const read = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8') } catch { return null } }
  const readAbs = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
  fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd, stdin, env: { PARITY_BRIDGE_KEY: process.env.PARITY_BRIDGE_KEY || null, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null },
    mcp: read('mcp.json'), system: read('system.md'), dirMode: fs.statSync(cwd).mode & 0o777,
    home: process.env.HOME || null, hooks: read('.agents/hooks.json'),
    agyMcp: readAbs(path.join(process.env.HOME || '/nonexistent', '.gemini/config/mcp_config.json')), agySettings: readAbs(path.join(process.env.HOME || '/nonexistent', '.gemini/antigravity-cli/settings.json')),
    homeFiles: (() => { try { return fs.readdirSync(path.join(process.env.HOME, '.gemini')).sort() } catch { return [] } })() }))
  if (${JSON.stringify(options.touchGuard ?? false)}) fs.writeFileSync(path.join(path.dirname(cwd), 'guard.log'), 'call_mcp_tool allow\\n')
  if (${JSON.stringify(options.agyLog ?? '')}) { fs.mkdirSync(path.join(process.env.HOME, '.gemini/antigravity-cli'), { recursive: true }); fs.writeFileSync(path.join(process.env.HOME, '.gemini/antigravity-cli/cli.log'), ${JSON.stringify(options.agyLog ?? '')}) }
  const out = ${JSON.stringify(options.lines ?? [])}
  for (const line of out) process.stdout.write(line + '\\n')
  if (${JSON.stringify(options.stderr ?? '')}) process.stderr.write(${JSON.stringify(options.stderr ?? '')})
  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.hangMs ?? 0})
})
`)
  chmodSync(binary, 0o755)
  return { binary, record: () => JSON.parse(readFileSync(recordFile, 'utf8')) }
}

const makeRun = (over: Partial<ProviderRun> = {}) => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const run: ProviderRun = { system: 'SYSTEM RUBRIC', task: 'Run id: abc. Check desktop.', tools: ['get_context', 'capture_live', 'save_draft'], maxTurns: 20, signal: controller.signal, call: async () => ({ text: '' }), emit: (e) => events.push(e), ...over }
  return { run, events, controller }
}
const provider = (spec: CliSpec, binary: string, model?: string, homeDir?: string) => createCliProvider(spec, { binary, model, homeDir, getBridge: () => BRIDGE })

describe.skipIf(process.platform === 'win32')('Claude Code adapter', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Capturing.' }, { type: 'tool_use', id: 't1', name: 'mcp__parity__capture_live', input: { breakpoint: 'desktop' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'Run abc captured' }, { type: 'image', source: {} }] }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Saved the draft.' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Saved the draft.', usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 80 } }),
  ]

  it('starts with only the parity tools, keeps the key off the command line and disk, and maps its output', async () => {
    const cli = fakeCli({ lines })
    const { run, events } = makeRun()
    const result = await provider(claudeCodeSpec, cli.binary, 'sonnet').run(run)
    expect(result).toEqual({ stopped: 'finished', text: 'Saved the draft.' })

    const rec = cli.record()
    expect(rec.stdin).toBe('Run id: abc. Check desktop.')
    expect(rec.argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence']))
    expect(rec.argv[rec.argv.indexOf('--tools') + 1]).toBe('')
    expect(rec.argv[rec.argv.indexOf('--allowedTools') + 1]).toBe('mcp__parity__get_context,mcp__parity__capture_live,mcp__parity__save_draft')
    expect(rec.argv[rec.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(rec.argv[rec.argv.indexOf('--model') + 1]).toBe('sonnet')
    expect(JSON.stringify(rec.argv)).not.toContain(TOKEN)
    expect(rec.env.PARITY_BRIDGE_KEY).toBe(TOKEN)
    expect(rec.env.ELECTRON_RUN_AS_NODE).toBeNull()
    const mcp = JSON.parse(rec.mcp)
    expect(mcp.mcpServers.parity).toEqual({ type: 'http', url: BRIDGE.mcpUrl, headers: { Authorization: 'Bearer ${PARITY_BRIDGE_KEY}' } })
    expect(rec.mcp).not.toContain(TOKEN)
    expect(rec.system).toBe('SYSTEM RUBRIC')
    expect(rec.dirMode).toBe(0o700)
    expect(existsSync(rec.cwd)).toBe(false) // the private folder is removed afterwards

    expect(events).toContainEqual({ type: 'text', text: 'Capturing.' })
    expect(events).toContainEqual({ type: 'tool', name: 'capture_live', args: { breakpoint: 'desktop' } })
    expect(events).toContainEqual({ type: 'tool-result', name: 'tool', isError: false, text: 'Run abc captured', images: 1 })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 1500, outputTokens: 80 })
  })

  it('reports an error result with the agent\'s own words', async () => {
    const cli = fakeCli({ lines: [JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })], exitCode: 1 })
    await expect(provider(claudeCodeSpec, cli.binary).run(makeRun().run)).rejects.toThrow(/Not logged in/)
  })
})

describe.skipIf(process.platform === 'win32')('Codex adapter', () => {
  it('passes the MCP server and a read-only sandbox through -c overrides, with the key in the environment', async () => {
    const cli = fakeCli({ lines: [
      JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'parity', tool: 'capture_live', arguments: { breakpoint: 'desktop' } } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'capture_live', status: 'completed', result: { content: [{ type: 'text', text: 'captured' }, { type: 'image' }] } } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All done.' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 700, output_tokens: 60 } }),
    ] })
    const { run, events } = makeRun()
    const result = await provider(codexSpec, cli.binary, 'gpt-test').run(run)
    expect(result).toEqual({ stopped: 'finished', text: 'All done.' })
    const rec = cli.record()
    expect(rec.argv.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox'])
    expect(rec.argv[rec.argv.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(rec.argv).toContain('mcp_servers.parity.url="http://127.0.0.1:29849/mcp"')
    expect(rec.argv).toContain('mcp_servers.parity.bearer_token_env_var="PARITY_BRIDGE_KEY"')
    expect(rec.argv).toContain('mcp_servers.parity.enabled_tools=["get_context","capture_live","save_draft"]')
    expect(rec.argv).toContain('mcp_servers.parity.tool_timeout_sec=300')
    expect(rec.argv[rec.argv.length - 1]).toBe('-')
    expect(JSON.stringify(rec.argv)).not.toContain(TOKEN)
    expect(rec.env.PARITY_BRIDGE_KEY).toBe(TOKEN)
    expect(rec.stdin).toBe('SYSTEM RUBRIC\n\n# Task\nRun id: abc. Check desktop.')
    expect(events).toContainEqual({ type: 'tool', name: 'capture_live', args: { breakpoint: 'desktop' } })
    expect(events).toContainEqual({ type: 'tool-result', name: 'capture_live', isError: false, text: 'captured', images: 1 })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 700, outputTokens: 60 })
  })
})

const agyStep = (step: Record<string, unknown>) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', ...step } })
const agyResult = (result: Record<string, unknown>) => JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', ...result } })
const SCHEMA_READ = { name: 'view_file', parameters: { AbsolutePath: '/home/u/.gemini/antigravity-cli/mcp/parity/capture_live.json' } }

describe.skipIf(process.platform === 'win32')('Antigravity CLI adapter', () => {
  const lines = [
    JSON.stringify({ event: 'init', conversation_id: 'c1', init: { cwd: '/x', tools: ['call_mcp_tool'], permission_mode: 'request-review' } }),
    agyStep({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    agyStep({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Capturing.\n', usage: { input_tokens: 12000, output_tokens: 300, thinking_tokens: 200, cache_read_tokens: 100, total_tokens: 12300 } }),
    agyStep({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: SCHEMA_READ }),
    agyStep({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: SCHEMA_READ }),
    agyStep({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'parity', ToolName: 'capture_live', Arguments: { breakpoint: 'desktop' } } } }),
    agyStep({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'parity', ToolName: 'capture_live', Arguments: { breakpoint: 'desktop' } }, output: 'Run abc captured' } }),
    agyStep({ step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'Saved the draft.\n', usage: { input_tokens: 13000, output_tokens: 100, thinking_tokens: 40, cache_read_tokens: 0, total_tokens: 13100 } }),
    agyResult({ response: 'Saved the draft.\n', usage: { input_tokens: 25000, output_tokens: 400, cache_read_tokens: 100, total_tokens: 25400 } }),
  ]

  it('runs in a private home with only Parity\'s tools allowed, and keeps the key off the command line', async () => {
    const realHome = join(dir, 'realhome')
    mkdirSync(join(realHome, '.gemini'), { recursive: true })
    writeFileSync(join(realHome, '.gemini', 'oauth_creds.json'), '{"refresh_token":"r"}')
    writeFileSync(join(realHome, '.gemini', 'mcp-should-not-be-copied.json'), '{}')
    const cli = fakeCli({ lines, touchGuard: true })
    const { run, events } = makeRun({ system: 'SYSTEM RUBRIC', task: 'Run id: abc. Check desktop.' })
    const result = await provider(antigravitySpec, cli.binary, 'gemini-3.8-flash-high', realHome).run(run)
    expect(result).toEqual({ stopped: 'finished', text: 'Saved the draft.' })

    const rec = cli.record()
    expect(JSON.stringify(rec.argv)).not.toContain(TOKEN)
    expect(rec.argv).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0', '--model', 'gemini-3.8-flash-high', '-p='])
    // The prompt goes over stdin as one stream-json user message: instructions first, then the task.
    const message = JSON.parse(rec.stdin.trim())
    expect(message.event).toBe('user')
    expect(message.message.content).toBe('SYSTEM RUBRIC\n\n# Task\nRun id: abc. Check desktop.')
    // A private HOME: not the person's own, only the sign-in file linked, Parity's server and rules inside.
    expect(rec.home).not.toBe(realHome)
    expect(rec.homeFiles).toEqual(['antigravity-cli', 'config', 'oauth_creds.json'])
    expect(JSON.parse(rec.agyMcp).mcpServers.parity).toEqual({ serverUrl: BRIDGE.mcpUrl, headers: { Authorization: `Bearer ${TOKEN}` } })
    const settings = JSON.parse(rec.agySettings)
    expect(settings.trustedWorkspaces).toEqual([rec.cwd])
    expect(settings.permissions.allow).toEqual(['mcp(parity/get_context)', 'mcp(parity/capture_live)', 'mcp(parity/save_draft)', `read_file(${rec.home}/.gemini/antigravity-cli/mcp/)`, `read_file(${rec.home}/.gemini/antigravity-cli/brain/)`])
    const hooks = JSON.parse(rec.hooks)
    expect(hooks['parity-guard'].PreToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ command: expect.stringContaining('guard.cjs'), timeout: 30 }] })
    expect(existsSync(rec.cwd)).toBe(false)
    expect(existsSync(rec.home)).toBe(false)

    expect(events).toContainEqual({ type: 'text', text: 'Capturing.' })
    expect(events).toContainEqual({ type: 'tool', name: 'capture_live', args: { breakpoint: 'desktop' } })
    expect(events).toContainEqual({ type: 'tool-result', name: 'capture_live', isError: false, text: 'Run abc captured', images: 0 })
    expect(events.filter((e) => e.type === 'tool' || e.type === 'tool-result').every((e) => (e as { name: string }).name !== 'view_file')).toBe(true)
    // Usage is counted once per model call (the result repeats the running total).
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 12100, outputTokens: 300 }, { type: 'usage', inputTokens: 13000, outputTokens: 100 }])
  })

  it('does not copy the person\'s settings, rules or other agy files into the run', async () => {
    const realHome = join(dir, 'realhome2')
    mkdirSync(join(realHome, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(join(realHome, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ permissions: { allow: ['command(*)'] } }))
    const cli = fakeCli({ lines, touchGuard: true })
    await provider(antigravitySpec, cli.binary, undefined, realHome).run(makeRun().run)
    expect(JSON.stringify(JSON.parse(cli.record().agySettings))).not.toContain('command(')
  })

  it('shows streamed text once, and falls back to the final usage when no step reports any', async () => {
    const cli = fakeCli({ touchGuard: true, lines: [
      agyStep({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' }),
      agyStep({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'lo' }),
      agyStep({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Hello' }),
      agyResult({ response: 'Hello', usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 0, total_tokens: 520 } }),
    ] })
    const { run, events } = makeRun()
    expect((await provider(antigravitySpec, cli.binary).run(run)).text).toBe('Hello')
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Hel', delta: true }, { type: 'text', text: 'lo', delta: true }])
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 500, outputTokens: 20 }])
  })

  it('says which tool was refused when the agent stops without answering', async () => {
    const cli = fakeCli({ touchGuard: true, lines: [
      agyStep({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }),
      agyStep({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, error: { type: 'TOOL_ERROR', message: 'tool call denied by pre-tool hook' } } }),
      agyResult({ response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }),
    ] })
    const { run, events } = makeRun()
    const error = await provider(antigravitySpec, cli.binary).run(run).catch((e) => e)
    expect(error.message).toMatch(/tried to use RunCommand, which Parity does not allow/)
    expect(events).toContainEqual({ type: 'tool-result', name: 'run_command', isError: true, text: 'tool call denied by pre-tool hook', images: 0 })
  })

  it('reports an error status from agy', async () => {
    const cli = fakeCli({ touchGuard: true, lines: [agyResult({ status: 'ERROR', response: '', error: 'quota exceeded' })] })
    const error = await provider(antigravitySpec, cli.binary).run(makeRun().run).catch((e) => e)
    expect(error.message).toBe('Antigravity CLI: quota exceeded')
  })

  it('stops the run when a tool ran but the safety hook never did', async () => {
    const cli = fakeCli({ hangMs: 20_000, lines: [
      agyStep({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'search_web', tool_info: { name: 'search_web', parameters: { query: 'x' } } }),
      agyStep({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'search_web', tool_info: { name: 'search_web', parameters: { query: 'x' }, output: 'results' } }),
    ] })
    const started = Date.now()
    const error = await provider(antigravitySpec, cli.binary).run(makeRun().run).catch((e) => e)
    expect(error.message).toMatch(/without Parity's safety check running/)
    expect(Date.now() - started).toBeLessThan(8000)
  })

  it('says the safety hook could not run, and why, when a tool was blocked because the hook failed', async () => {
    const cli = fakeCli({
      hangMs: 20_000,
      agyLog: ['I1005 12:00:01.000000 12 hooks.go:10] running hook parity-guard', 'W1005 12:00:01.500000 12 hooks.go:44] hook timed out after 10s', 'I1005 12:00:02.000000 12 other.go:1] unrelated line'].join('\n'),
      lines: [
        agyStep({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: {} } }),
        agyStep({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: {}, error: { type: 'TOOL_ERROR', message: 'JSON hook "jsonhook__parity-guard_PreToolUse_0_0" failed: command failed: exit status 1, stderr: boom' } } }),
      ],
    })
    const error = await provider(antigravitySpec, cli.binary).run(makeRun().run).catch((e) => e)
    expect(error.message).toMatch(/was stopped because Parity's safety hook could not run/)
    expect(error.message).toContain('stderr: boom')
    expect(error.message).toContain('hook timed out after 10s') // from agy's own log
    expect(error.message).not.toContain('unrelated line')
    expect(error.message).not.toContain(TOKEN)
  })

  it('adds the last tool error to the plain stop message too', async () => {
    const cli = fakeCli({ hangMs: 20_000, lines: [
      agyStep({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'parity', ToolName: 'capture_live' } } }),
      agyStep({ step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'parity', ToolName: 'capture_live' }, error: { type: 'TOOL_ERROR', message: 'server parity is not connected' } } }),
    ] })
    const error = await provider(antigravitySpec, cli.binary).run(makeRun().run).catch((e) => e)
    expect(error.message).toMatch(/used a tool without Parity's safety check running/)
    expect(error.message).toContain('Details: server parity is not connected')
  })
})

describe.skipIf(process.platform === 'win32')('Antigravity safety hook', () => {
  const decide = (call: unknown, extra: { mcpDir?: string } = {}) => {
    const log = join(dir, 'guard.log')
    const script = join(dir, 'guard.cjs')
    const mcpDir = extra.mcpDir ?? join(dir, 'home', '.gemini', 'antigravity-cli', 'mcp')
    writeFileSync(script, agyGuardScript({ server: 'parity', tools: ['get_context', 'capture_live'], mcpDir, brainDir: join(dirname(mcpDir), 'brain'), log }))
    const out = spawnSync(process.execPath, [script], { input: JSON.stringify({ toolCall: call }), encoding: 'utf8' })
    return { output: JSON.parse(out.stdout), logged: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }
  const denied = { decision: 'deny', reason: expect.stringContaining('only lets this agent use its own QA tools') }

  it('lets only Parity\'s own tools through and writes to its log every time', () => {
    expect(decide({ name: 'call_mcp_tool', args: { ServerName: 'parity', ToolName: 'capture_live' } }).output).toEqual({ decision: 'ask' })
    expect(decide({ name: 'call_mcp_tool', args: { ServerName: 'parity', ToolName: 'finalize_rows' } }).output).toEqual(denied)
    expect(decide({ name: 'call_mcp_tool', args: { ServerName: 'other', ToolName: 'capture_live' } }).output).toEqual(denied)
    for (const name of ['run_command', 'search_web', 'read_url_content', 'write_to_file', 'open_browser_url', 'schedule', 'invoke_subagent', 'generate_image']) expect(decide({ name, args: {} }).output).toEqual(denied)
    expect(decide({ name: 'finish', args: {} }).output).toEqual({ decision: 'ask' })
    expect(readFileSync(join(dir, 'guard.log'), 'utf8')).toContain('call_mcp_tool allow')
    expect(readFileSync(join(dir, 'guard.log'), 'utf8')).toContain('search_web deny')
  })

  it('lets agy read only the tool description files in its own MCP folder', () => {
    const mcpDir = join(dir, 'home', '.gemini', 'antigravity-cli', 'mcp')
    mkdirSync(join(mcpDir, 'parity'), { recursive: true })
    writeFileSync(join(mcpDir, 'parity', 'capture_live.json'), '{}')
    writeFileSync(join(mcpDir, 'parity', 'notes.txt'), 'x')
    writeFileSync(join(dir, 'secret.json'), '{}')
    expect(decide({ name: 'view_file', args: { AbsolutePath: join(mcpDir, 'parity', 'capture_live.json') } }).output).toEqual({ decision: 'ask' })
    expect(decide({ name: 'view_file', args: { AbsolutePath: join(mcpDir, 'parity', 'notes.txt') } }).output).toEqual(denied)
    expect(decide({ name: 'view_file', args: { AbsolutePath: join(dir, 'secret.json') } }).output).toEqual(denied)
    expect(decide({ name: 'view_file', args: { AbsolutePath: join(mcpDir, '..', '..', '..', 'secret.json') } }).output).toEqual(denied)
    expect(decide({ name: 'view_file', args: { AbsolutePath: join(mcpDir, 'missing.json') } }).output).toEqual(denied)
  })

  it('lets agy read a large tool result it saved to a file, and nothing else in its working folder', () => {
    const brain = join(dir, 'home', '.gemini', 'antigravity-cli', 'brain', 'conv-1')
    mkdirSync(join(brain, '.system_generated', 'steps', '4'), { recursive: true })
    mkdirSync(join(brain, '.system_generated', 'logs'), { recursive: true })
    writeFileSync(join(brain, '.system_generated', 'steps', '4', 'output.txt'), 'saved result')
    writeFileSync(join(brain, '.system_generated', 'steps', '4', 'other.txt'), 'x')
    writeFileSync(join(brain, '.system_generated', 'logs', 'transcript_full.jsonl'), '{}')
    writeFileSync(join(brain, 'notes.txt'), 'x')
    const view = (path: string) => decide({ name: 'view_file', args: { AbsolutePath: path } }).output
    expect(view(join(brain, '.system_generated', 'steps', '4', 'output.txt'))).toEqual({ decision: 'ask' })
    // The pictures a tool returns are saved as media files for the model to look at.
    writeFileSync(join(brain, '.system_generated', 'steps', '4', 'media_0.jpg'), 'jpeg')
    writeFileSync(join(brain, '.system_generated', 'steps', '4', 'media_12.webp'), 'webp')
    writeFileSync(join(brain, '.system_generated', 'steps', '4', 'media_0.sh'), 'x')
    writeFileSync(join(brain, '.system_generated', 'steps', '4', 'media_x.jpg'), 'x')
    expect(view(join(brain, '.system_generated', 'steps', '4', 'media_0.jpg'))).toEqual({ decision: 'ask' })
    expect(view(join(brain, '.system_generated', 'steps', '4', 'media_12.webp'))).toEqual({ decision: 'ask' })
    expect(view(join(brain, '.system_generated', 'steps', '4', 'media_0.sh'))).toEqual(denied)
    expect(view(join(brain, '.system_generated', 'steps', '4', 'media_x.jpg'))).toEqual(denied)
    expect(view(join(brain, '.system_generated', 'steps', '4', 'other.txt'))).toEqual(denied)
    expect(view(join(brain, '.system_generated', 'logs', 'transcript_full.jsonl'))).toEqual(denied)
    expect(view(join(brain, 'notes.txt'))).toEqual(denied)
    // The same file name somewhere else is not allowed.
    mkdirSync(join(dir, 'elsewhere', '.system_generated', 'steps', '1'), { recursive: true })
    writeFileSync(join(dir, 'elsewhere', '.system_generated', 'steps', '1', 'output.txt'), 'x')
    expect(view(join(dir, 'elsewhere', '.system_generated', 'steps', '1', 'output.txt'))).toEqual(denied)
  })

  it('denies a call it cannot read', () => {
    const script = join(dir, 'guard2.cjs')
    writeFileSync(script, agyGuardScript({ server: 'parity', tools: [], mcpDir: dir, brainDir: join(dir, 'brain'), log: join(dir, 'guard2.log') }))
    expect(JSON.parse(spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' }).stdout)).toEqual(denied)
  })
})

describe.skipIf(process.platform === 'win32')('running agent CLIs', () => {
  it('explains a missing executable', async () => {
    await expect(createCliProvider(codexSpec, { binary: join(dir, 'nope'), getBridge: () => BRIDGE }).run(makeRun().run)).rejects.toThrow(/Codex is not installed/)
  })

  it('reports a non-zero exit with the agent\'s error, without leaking the key', async () => {
    const cli = fakeCli({ lines: ['noise'], stderr: `auth failed for ${TOKEN}\nplease sign in`, exitCode: 2 })
    const error = await provider(claudeCodeSpec, cli.binary).run(makeRun().run).catch((e) => e)
    expect(error.message).toContain('Claude Code stopped with an error')
    expect(error.message).toContain('please sign in')
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toContain('[key]')
  })

  it('tolerates lines it cannot read', async () => {
    const cli = fakeCli({ lines: ['not json', '{broken', JSON.stringify({ type: 'result', is_error: false, result: 'fine' })] })
    expect((await provider(claudeCodeSpec, cli.binary).run(makeRun().run)).text).toBe('fine')
  })

  it('stops the process when aborted', async () => {
    const cli = fakeCli({ lines: [], hangMs: 20_000 })
    const { run, controller } = makeRun()
    setTimeout(() => controller.abort(), 400)
    const started = Date.now()
    expect((await provider(claudeCodeSpec, cli.binary).run(run)).stopped).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(8000)
  })
})

describe.skipIf(process.platform === 'win32')('chat history for agent CLIs', () => {
  it('puts the earlier chat in front of the new message as a transcript', async () => {
    const fake = fakeCli({ lines: [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })] })
    const { run } = makeRun({ task: 'And on mobile?', history: [{ role: 'user', text: 'How big is the hero heading?' }, { role: 'assistant', text: 'It is 28px on desktop.' }] })
    await provider(claudeCodeSpec, fake.binary).run(run)
    const { stdin } = fake.record()
    expect(stdin).toContain('Analyst: How big is the hero heading?')
    expect(stdin).toContain('You: It is 28px on desktop.')
    expect(stdin.endsWith("The analyst's new message:\nAnd on mobile?")).toBe(true)
  })

  it('leaves a first message untouched', async () => {
    const fake = fakeCli({ lines: [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })] })
    await provider(claudeCodeSpec, fake.binary).run(makeRun({ task: 'Hello' }).run)
    expect(fake.record().stdin).toBe('Hello')
  })
})

describe('sweepStaleAgentFolders', () => {
  it('removes old private run folders, keeps recent ones and leaves other folders alone', () => {
    const old = join(dir, 'parity-agent-old')
    const recent = join(dir, 'parity-agent-recent')
    const other = join(dir, 'something-else')
    for (const folder of [old, recent, other]) mkdirSync(join(folder, 'home'), { recursive: true })
    writeFileSync(join(old, 'home', 'mcp_config.json'), '{"key":"secret"}')
    const longAgo = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(old, longAgo, longAgo)
    utimesSync(other, longAgo, longAgo)
    expect(sweepStaleAgentFolders(10 * 60 * 1000, dir)).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
  it('does nothing when the folder cannot be read', () => {
    expect(sweepStaleAgentFolders(0, join(dir, 'missing'))).toBe(0)
  })
})

describe('Antigravity hook on Windows', () => {
  const exe = 'C:\\Program Files\\Parity\\Parity.exe'

  it('uses a command with no quotes or spaces, because agy runs it with cmd /c and Go escapes quotes in a way cmd cannot read', () => {
    const { command, batch } = agyHookLauncher('win32', exe, 'C:\\Users\\Jane Smith\\AppData\\Local\\Temp\\parity-agent-x\\work\\.agents\\guard.cjs')
    expect(command).toBe('.\\guard.cmd')
    expect(command).toMatch(/^[^\s"']+$/)
    expect(command).not.toContain('Program Files')
    expect(command).not.toContain('Jane Smith')
    // The batch file does the quoting itself, finds the script next to it, and runs the app as plain Node.
    expect(batch?.name).toBe('guard.cmd')
    expect(batch?.content.split('\r\n')).toEqual(['@echo off', 'chcp 65001 >nul', 'set ELECTRON_RUN_AS_NODE=1', `"${exe}" "%~dp0guard.cjs"`, ''])
  })

  it('escapes a percent sign in the app\'s path, which a batch file would read as a variable', () => {
    expect(agyHookLauncher('win32', 'C:\\Apps\\100%\\Parity.exe', 'x').batch?.content).toContain('"C:\\Apps\\100%%\\Parity.exe" "%~dp0guard.cjs"')
  })

  it('keeps the inline command for Unix', () => {
    const { command, batch } = agyHookLauncher('linux', '/opt/Parity App/parity', '/tmp/it\'s/guard.cjs')
    expect(batch).toBeUndefined()
    expect(command).toBe("ELECTRON_RUN_AS_NODE=1 '/opt/Parity App/parity' '/tmp/it'\\''s/guard.cjs'")
  })

  it('grants the read permissions with both slash styles on Windows, one on Unix', () => {
    expect(agyReadRules('win32', ['C:\\t\\home\\mcp', 'C:\\t\\home\\brain'])).toEqual([
      'read_file(C:\\t\\home\\mcp\\)', 'read_file(C:/t/home/mcp/)', 'read_file(C:\\t\\home\\brain\\)', 'read_file(C:/t/home/brain/)',
    ])
    expect(agyReadRules('linux', ['/t/home/mcp'])).toEqual(['read_file(/t/home/mcp/)'])
  })

  it('writes the batch file next to hooks.json and points hooks.json at it when run on Windows', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    const folder = mkdtempSync(join(dir, 'win-'))
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      antigravitySpec.invoke({ run: makeRun().run, bridge: BRIDGE, dir: folder, homeDir: join(dir, 'no-home') })
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
    const work = join(realpathSync(folder), 'work', '.agents')
    const hooks = JSON.parse(readFileSync(join(work, 'hooks.json'), 'utf8'))
    expect(hooks['parity-guard'].PreToolUse[0].hooks[0]).toEqual({ command: '.\\guard.cmd', timeout: 30 })
    expect(readFileSync(join(work, 'guard.cmd'), 'utf8')).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(existsSync(join(work, 'guard.cjs'))).toBe(true)
    const settings = JSON.parse(readFileSync(join(realpathSync(folder), 'home', '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))
    expect(settings.permissions.allow.filter((rule: string) => rule.startsWith('read_file(')).length).toBe(4) // two folders, two slash styles
  })
})
