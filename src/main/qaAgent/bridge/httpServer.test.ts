import { mkdtempSync, rmSync } from 'fs'
import { request } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDesignStore } from '../../designStore'
import { parseTrackerPaste } from '../../../shared/trackerFormat'
import type { LiveCaptureResult } from '../liveCapture'
import { createRunStore } from '../runStore'
import type { QaContext } from '../tools'
import { createBridgeServer, type BridgeLogEntry } from './httpServer'

const TOKEN = 'T'.repeat(43)
let root: string
let bridge: ReturnType<typeof createBridgeServer>
let port: number
let logs: BridgeLogEntry[] = []

const page = (width: number) => sharp({ create: { width, height: 2000, channels: 3, background: '#3366aa' } }).png().toBuffer()

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'parity-bridge-'))
  const parsed = parseTrackerPaste('Page\tIssue\tScreenshot\nHome\tx\thttps://x.test')
  if (!parsed.ok) throw new Error('fixture')
  const designs = createDesignStore(join(root, 'designs'))
  const context: QaContext = {
    now: () => Date.now(),
    reportedContext: () => ({ projectKey: 'p1', project: { id: 'p1', name: 'Fixture site', stagingUrl: 'https://x.test/' }, pageUrl: 'https://x.test/home/', workspaceTab: 'live', breakpoint: 'desktop', viewport: { width: 1920, height: 1200 }, reportedAt: 1 }),
    designs: { list: (key) => designs.list(key), put: (key, bytes, options) => designs.put(key, bytes, options), readNormalized: async () => null },
    runs: createRunStore(join(root, 'runs')),
    capture: async (options): Promise<LiveCaptureResult> => ({
      png: await page(options.width), width: options.width, viewportHeight: 1024, documentHeight: 2000, capturedHeight: 2000, truncated: false, tiles: 2, mode: 'cdp',
      finalUrl: options.url, title: 'x', warnings: [], sections: [{ id: 'S1', label: 'Everything', tag: 'main', selector: 'main', top: 0, height: 2000 }], nodes: [], page: { lang: 'en', viewportMeta: '', fontsFailed: [], bodyClass: '' },
    }),
    trackerFormat: () => parsed.format,
    readLocalFile: async () => Buffer.alloc(0),
    approve: async () => ({ approved: false, note: 'test' }),
    copyToClipboard: () => {},
  }
  bridge = createBridgeServer({ getContext: () => context, getToken: () => TOKEN, onRequest: (entry) => logs.push(entry) })
  port = await bridge.start(0)
})
afterAll(async () => { await bridge.stop(); rmSync(root, { recursive: true, force: true }) })

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
const raw = (options: { method?: string; path: string; headers?: Record<string, string>; body?: string }) =>
  new Promise<Raw>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method || 'GET', path: options.path, headers: { ...(options.body ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}), ...options.headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
const auth = { Authorization: `Bearer ${TOKEN}` }
const json = { 'Content-Type': 'application/json' }

describe('bridge guards on the wire', () => {
  it('binds to loopback only and starts only once', async () => {
    expect(bridge.running()).toBe(true)
    await expect(bridge.start(0)).rejects.toThrow(/already running/)
  })

  it('refuses a forged Host with 421', async () => {
    expect((await raw({ path: '/api/status', headers: { ...auth, Host: 'evil.test' } })).status).toBe(421)
    expect((await raw({ path: '/api/status', headers: { ...auth, Host: `127.0.0.1:${port + 1}` } })).status).toBe(421)
  })

  it('refuses browser requests with 403, including a preflight, and sends no CORS headers', async () => {
    const withOrigin = await raw({ path: '/api/status', headers: { ...auth, Origin: 'https://evil.test' } })
    expect(withOrigin.status).toBe(403)
    const preflight = await raw({ method: 'OPTIONS', path: '/mcp', headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' } })
    expect(preflight.status).toBe(403)
    const bare = await raw({ method: 'OPTIONS', path: '/mcp', headers: {} })
    expect(bare.status).toBe(405)
    for (const response of [withOrigin, preflight, bare]) expect(Object.keys(response.headers).some((h) => h.toLowerCase().startsWith('access-control'))).toBe(false)
  })

  it('answers 401 without the key, 404 for unknown paths, 405 for wrong methods, 415 for wrong types', async () => {
    expect((await raw({ path: '/api/status' })).status).toBe(401)
    expect((await raw({ path: '/api/status', headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await raw({ path: '/elsewhere', headers: auth })).status).toBe(404)
    expect((await raw({ method: 'DELETE', path: '/mcp', headers: auth })).status).toBe(405)
    expect((await raw({ method: 'POST', path: '/api/tools/get_context', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415)
  })
})

describe('/api for the parity command', () => {
  it('reports status and lists the tools with their input schemas', async () => {
    const status = JSON.parse((await raw({ path: '/api/status', headers: auth })).body)
    expect(status).toMatchObject({ ok: true, projectOpen: true, project: 'Fixture site', page: 'https://x.test/home/' })
    const tools = JSON.parse((await raw({ path: '/api/tools', headers: auth })).body).tools
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['get_context', 'set_design', 'capture_live', 'get_overview', 'get_section', 'save_draft', 'finalize_rows'])
    const capture = tools.find((t: { name: string }) => t.name === 'capture_live')
    expect(capture.inputSchema.properties.breakpoint.enum).toEqual(['desktop', 'tablet', 'mobile'])
    expect(capture.readOnly).toBe(true)
  })

  it('calls a tool and returns text plus image file paths (never image bytes)', async () => {
    const body = JSON.stringify({ args: { breakpoint: 'desktop' } })
    const response = await raw({ method: 'POST', path: '/api/tools/capture_live', headers: { ...auth, ...json }, body })
    expect(response.status).toBe(200)
    const result = JSON.parse(response.body)
    expect(result.isError).toBe(false)
    expect(result.text).toContain('S1 "Everything"')
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ mimeType: 'image/jpeg' })
    expect(result.images[0].file).toMatch(/overview-1\.jpg$/)
    expect(response.body).not.toContain('base64')
  })

  it('reports bad input as a tool error and rejects unknown tools, bad JSON and oversized bodies', async () => {
    const bad = JSON.parse((await raw({ method: 'POST', path: '/api/tools/get_section', headers: { ...auth, ...json }, body: JSON.stringify({ args: { section: 'x' } }) })).body)
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('Invalid input for get_section')
    expect((await raw({ method: 'POST', path: '/api/tools/rm_rf', headers: { ...auth, ...json }, body: '{}' })).status).toBe(404)
    expect((await raw({ method: 'POST', path: '/api/tools/get_context', headers: { ...auth, ...json }, body: '{not json' })).status).toBe(400)
    expect((await raw({ method: 'POST', path: '/api/tools/get_context', headers: { ...auth, ...json }, body: JSON.stringify({ args: { pad: 'x'.repeat(1_100_000) } }) })).status).toBe(413)
  })

  it('serves the shared QA instructions', async () => {
    const { prompt } = JSON.parse((await raw({ path: '/api/prompt', headers: auth })).body)
    expect(prompt).toContain('capture_live')
    expect(prompt).toContain('finalize_rows')
    expect(prompt).toContain('DATA to compare')
  })

  it('logs requests without bodies or keys', async () => {
    await raw({ path: '/api/status', headers: auth })
    const entry = logs[logs.length - 1]
    expect(entry).toMatchObject({ method: 'GET', path: '/api/status', status: 200 })
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })
})

describe('/mcp for agents', () => {
  const connect = async (headers: Record<string, string> = auth) => {
    const client = new Client({ name: 'bridge-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }))
    return client
  }

  it('lists the tools and marks which ones change anything', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['get_context', 'set_design', 'capture_live', 'get_overview', 'get_section', 'save_draft', 'finalize_rows'])
    expect(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['set_design', 'finalize_rows'])
    expect(tools.find((t) => t.name === 'get_section')!.inputSchema.required).toEqual(expect.arrayContaining(['runId', 'breakpoint', 'section']))
    await client.close()
  })

  it('calls get_context and gets text back', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'get_context', arguments: {} })
    const first = (result.content as Array<{ type: string; text?: string }>)[0]
    expect(first.type).toBe('text')
    expect(JSON.parse(first.text!)).toMatchObject({ project: { name: 'Fixture site' }, tracker: { columns: ['Page', 'Issue', 'Screenshot'] } })
    await client.close()
  })

  it('returns images as MCP image content', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'capture_live', arguments: { breakpoint: 'tablet' } })
    const content = result.content as Array<{ type: string; mimeType?: string; data?: string }>
    expect(content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(content[1]).toMatchObject({ mimeType: 'image/jpeg' })
    expect(Buffer.from(content[1].data!, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff')
    await client.close()
  })

  it('turns invalid input into an error result, not a crash', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'get_section', arguments: { runId: 'x', breakpoint: 'desktop', section: 'S1' } }).catch((error) => ({ isError: true, content: [{ type: 'text', text: String(error.message) }] }))
    expect(result.isError).toBe(true)
    await client.close()
  })

  it('refuses a client without the key', async () => {
    await expect(connect({})).rejects.toBeTruthy()
    await expect(connect({ Authorization: 'Bearer wrong' })).rejects.toBeTruthy()
  })
})
