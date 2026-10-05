import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod'
import { BRIDGE_VERSION, callTool, findTool, QA_TOOLS, type QaContext } from '../tools'
import { checkRequest, MAX_BODY_BYTES } from './guards'
import { QA_AGENT_PROMPT } from '../prompt'
import { createQaMcpHandler } from './mcp'

// The local bridge: `/mcp` for MCP clients (Claude Code, Codex, Antigravity CLI, …) and
// `/api/...` for the `parity` command. Both call the same tool registry.

export interface BridgeLogEntry {
  at: number
  method: string
  path: string
  status: number
  ms: number
  tool?: string
}

export interface BridgeOptions {
  getContext: () => QaContext
  getToken: () => string
  onRequest?: (entry: BridgeLogEntry) => void
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: 'The request is too large.' }
    chunks.push(chunk as Buffer)
  }
  if (!size) return { ok: true, value: {} }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) } } catch { return { ok: false, status: 400, message: 'The request body is not valid JSON.' } }
}

export function createBridgeServer(options: BridgeOptions) {
  let server: Server | null = null
  let listeningPort: number | null = null
  const mcp = toNodeHandler(createQaMcpHandler(options.getContext), { maxRequestBodySize: MAX_BODY_BYTES })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const method = req.method || 'GET'
    let path = '/'
    try { path = new URL(req.url || '/', 'http://bridge').pathname } catch { /* treated as unknown below */ }
    let tool: string | undefined
    const done = (status: number) => options.onRequest?.({ at: started, method, path, status, ms: Date.now() - started, tool })

    const verdict = checkRequest(
      { method, path, host: req.headers.host, origin: req.headers.origin as string | undefined, contentType: req.headers['content-type'], authorization: req.headers.authorization },
      listeningPort ?? 0,
      options.getToken(),
    )
    if (!verdict.ok) {
      if (verdict.status === 401) res.setHeader('WWW-Authenticate', 'Bearer')
      sendJson(res, verdict.status, { error: verdict.message })
      return done(verdict.status)
    }

    try {
      if (path === '/mcp') {
        await mcp(req, res)
        return done(res.statusCode)
      }
      if (path === '/api/status') {
        const reported = options.getContext().reportedContext()
        sendJson(res, 200, { ok: true, bridgeVersion: BRIDGE_VERSION, projectOpen: !!reported, project: reported?.project.name ?? null, page: reported?.pageUrl ?? null })
        return done(200)
      }
      if (path === '/api/prompt') {
        sendJson(res, 200, { prompt: QA_AGENT_PROMPT })
        return done(200)
      }
      if (path === '/api/tools') {
        sendJson(res, 200, { tools: QA_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: t.readOnly, agentAllowed: t.agentAllowed, inputSchema: z.toJSONSchema(t.input) })) })
        return done(200)
      }
      tool = path.slice('/api/tools/'.length)
      if (!findTool(tool)) {
        sendJson(res, 404, { error: `Unknown tool "${tool}".` })
        return done(404)
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { error: body.message })
        return done(body.status)
      }
      const args = body.value && typeof body.value === 'object' ? (body.value as { args?: unknown }).args : undefined
      const result = await callTool(tool, args ?? {}, options.getContext())
      sendJson(res, 200, {
        text: result.text,
        isError: !!result.isError,
        images: (result.images || []).map((image) => ({ mimeType: image.mimeType, caption: image.caption, file: image.file ?? null })),
      })
      return done(200)
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' })
      else res.end()
      return done(500)
    }
  }

  return {
    /** Listens on 127.0.0.1 only. Pass 0 for a free port (tests). Resolves with the port in use. */
    start(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        if (server) return reject(new Error('The bridge is already running.'))
        const instance = createServer((req, res) => { void handle(req, res) })
        instance.requestTimeout = 10 * 60 * 1000
        instance.once('error', (error) => { server = null; listeningPort = null; reject(error) })
        instance.listen(port, '127.0.0.1', () => {
          const address = instance.address()
          listeningPort = typeof address === 'object' && address ? address.port : port
          server = instance
          resolve(listeningPort)
        })
      })
    },
    stop(): Promise<void> {
      const instance = server
      server = null
      listeningPort = null
      return new Promise((resolve) => {
        if (!instance) return resolve()
        instance.close(() => resolve())
        instance.closeAllConnections?.()
      })
    },
    port: () => listeningPort,
    running: () => !!server,
  }
}

export type BridgeServer = ReturnType<typeof createBridgeServer>
