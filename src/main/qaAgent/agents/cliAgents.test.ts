import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCodeSpec, codexSpec, createCliProvider, geminiCliSpec, type CliSpec } from './cliAgents'
import type { AgentEvent, ProviderRun } from './types'

const TOKEN = 'FAKEKEY'.repeat(6) + 'abc'
const BRIDGE = { mcpUrl: 'http://127.0.0.1:29849/mcp', token: TOKEN }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parity-cli-agents-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in agent CLI: records how it was started, then prints the given lines and exits. */
function fakeCli(options: { lines?: string[]; stderr?: string; exitCode?: number; hangMs?: number }): { binary: string; record: () => any } {
  const binary = join(dir, 'fake-agent')
  const recordFile = join(dir, 'record.json')
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
let stdin = ''
process.stdin.on('data', (c) => { stdin += c })
process.stdin.on('end', () => {
  const cwd = process.cwd()
  const read = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8') } catch { return null } }
  fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd, stdin, env: { PARITY_BRIDGE_KEY: process.env.PARITY_BRIDGE_KEY || null, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null },
    mcp: read('mcp.json'), system: read('system.md'), gemini: read('.gemini/settings.json'), dirMode: fs.statSync(cwd).mode & 0o777 }))
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
const provider = (spec: CliSpec, binary: string, model?: string) => createCliProvider(spec, { binary, model, getBridge: () => BRIDGE })

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

describe.skipIf(process.platform === 'win32')('Gemini CLI adapter', () => {
  it('writes a private settings file with the server and key for the run only', async () => {
    const cli = fakeCli({ lines: [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Working on it.' }),
      JSON.stringify({ type: 'tool_use', tool_name: 'mcp_parity_capture_live', parameters: { breakpoint: 'desktop' } }),
      JSON.stringify({ type: 'tool_result', status: 'success', output: 'captured' }),
      JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 300, output_tokens: 20 } }),
    ] })
    const { run, events } = makeRun()
    const result = await provider(geminiCliSpec, cli.binary).run(run)
    expect(result).toEqual({ stopped: 'finished', text: 'Working on it.' })
    const rec = cli.record()
    expect(JSON.stringify(rec.argv)).not.toContain(TOKEN)
    expect(rec.argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--allowed-mcp-server-names', 'parity']))
    const settings = JSON.parse(rec.gemini)
    expect(settings.mcpServers.parity).toMatchObject({ httpUrl: BRIDGE.mcpUrl, headers: { Authorization: `Bearer ${TOKEN}` }, trust: true, includeTools: ['get_context', 'capture_live', 'save_draft'] })
    expect(existsSync(rec.cwd)).toBe(false)
    expect(events).toContainEqual({ type: 'tool', name: 'capture_live', args: { breakpoint: 'desktop' } })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 300, outputTokens: 20 })
  })
})

describe.skipIf(process.platform === 'win32')('running agent CLIs', () => {
  it('explains a missing executable', async () => {
    await expect(createCliProvider(codexSpec, { binary: join(dir, 'nope'), getBridge: () => BRIDGE }).run(makeRun().run)).rejects.toThrow(/Codex is not installed/)
  })

  it('reports a non-zero exit with the agent\'s error, without leaking the key', async () => {
    const cli = fakeCli({ lines: ['noise'], stderr: `auth failed for ${TOKEN}\nplease sign in`, exitCode: 2 })
    const error = await provider(geminiCliSpec, cli.binary).run(makeRun().run).catch((e) => e)
    expect(error.message).toContain('Gemini CLI stopped with an error')
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
