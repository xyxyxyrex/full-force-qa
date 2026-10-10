import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { BRIDGE_VERSION, callTool, QA_TOOLS, type QaContext, type ToolResult } from '../tools'

// The QA tools as an MCP server. Each request builds a fresh server over the same shared
// context (the transport is stateless), so nothing session-specific is kept here.

export function toMcpResult(result: ToolResult) {
  return {
    content: [
      { type: 'text' as const, text: result.text },
      ...(result.images || []).map((image) => ({ type: 'image' as const, data: image.data.toString('base64'), mimeType: image.mimeType })),
    ],
    isError: !!result.isError,
  }
}

export function createQaMcpHandler(getContext: () => QaContext, onError?: (error: Error) => void) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'parity', version: String(BRIDGE_VERSION) })
    const context=getContext()
    for (const tool of QA_TOOLS) {
      if(context.agentAccess&&!tool.agentAllowed||context.allowedTools&&!context.allowedTools.has(tool.name))continue
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: tool.name === 'capture_live' },
        },
        async (args: unknown) => toMcpResult(await callTool(tool.name, args, getContext())),
      )
    }
    return server
  }, { onerror: onError })
}
