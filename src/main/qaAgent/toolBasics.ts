import * as z from 'zod'
import type { Breakpoint } from '../../shared/designScale'
import type { ReportedContext } from '../../shared/qaAgent'
import type { QaContext } from './tools'

// The pieces every QA tool is made of, shared by the visual tools (tools.ts) and the browser tools
// (browserTools.ts).

export const DEFAULT_WIDTH: Record<Breakpoint, number> = { desktop: 1440, tablet: 834, mobile: 390 }

export interface ToolImage {
  data: Buffer
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  /** One line telling the reader what the picture shows. */
  caption: string
  /** Where the same picture was saved, for readers that cannot take inline images. */
  file?: string
}

export interface ToolResult {
  text: string
  images?: ToolImage[]
  isError?: boolean
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  input: S
  /** No side effects outside Parity's own run folders. */
  readOnly: boolean
  /** Whether headless agent runs may call it; tools that read arbitrary local files are for the person only. */
  agentAllowed: boolean
  run(args: z.infer<S>, context: QaContext): Promise<ToolResult>
}

export const defineTool = <S extends z.ZodObject>(tool: ToolDefinition<S>): ToolDefinition<S> => tool

export const fail = (text: string): ToolResult => ({ text, isError: true })

export function requireContext(context: QaContext): ReportedContext | string {
  const reported = context.reportedContext()
  if (!reported) return 'No project is open in Parity. Open the project and its staging page, then try again.'
  return reported
}

export function loadRun(context: QaContext, runId: string, reported: ReportedContext): { ok: true; pageUrl: string } | { ok: false; error: string } {
  let meta
  try { meta = context.runs.get(runId) } catch { meta = null }
  if (!meta) return { ok: false, error: `There is no run "${runId}". Call capture_live first and use the runId it returns.` }
  if (meta.projectKey !== reported.projectKey) return { ok: false, error: 'That run belongs to a different project than the one open in Parity.' }
  return { ok: true, pageUrl: meta.pageUrl }
}
