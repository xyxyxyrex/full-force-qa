import * as z from 'zod'
import { findTool, type ToolImage, type ToolResult } from '../tools'
import type { ChatTurn } from './types'

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema for the tool's input, without the $schema marker. */
  schema: Record<string, unknown>
}

export function toolSchemas(names: string[]): ToolSchema[] {
  return names.map((name) => {
    const tool = findTool(name)
    if (!tool) throw new Error(`Unknown tool "${name}".`)
    const { $schema: _marker, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>
    return { name: tool.name, description: tool.description, schema }
  })
}

/** Keeps pictures from older steps out of the conversation: only the newest few turns keep theirs. */
export const KEEP_IMAGE_TURNS = 3

export const imagePlaceholder = (image: Pick<ToolImage, 'caption'>) => `[picture removed to save space: ${image.caption}]`

/** A short line for the console about what a tool returned. */
export const summarize = (text: string) => (text.length > 240 ? `${text.slice(0, 237)}…` : text)

/** For agents that take one prompt (the CLIs): the earlier chat goes in front of the newest message as a transcript. */
export function withHistory(task: string, history?: ChatTurn[]): string {
  if (!history?.length) return task
  const transcript = history.map((turn) => `${turn.role === 'user' ? 'Analyst' : 'You'}: ${turn.text}`).join('\n\n')
  return `Earlier in this chat (your tool results are not repeated; call the tools again if you need them):\n\n${transcript}\n\nThe analyst's new message:\n${task}`
}

export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  return name === 'AbortError' || name === 'APIUserAbortError' || (error as { code?: string })?.code === 'ABORT_ERR'
}

export type { ToolResult, ToolImage }
