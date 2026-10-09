/** Assemble a complete Chat Completions response; tool fragments are never executed. */
export async function readCompletionStream(response: Response, onText: (text: string) => void): Promise<any> {
  if (!response.body) throw new Error('The response stream was empty. Retry this message.')
  const reader = response.body.getReader(); const decoder = new TextDecoder()
  let buffer = ''; let content = ''; let finish: string | null = null; let usage: unknown; let ended = false
  const calls = new Map<number, any>()
  const frame = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') { ended = true; return }
    if (!data) return
    let event: any
    try { event = JSON.parse(data) } catch { throw new Error('The provider returned an incomplete response. Retry this message.') }
    if (event.error) throw Object.assign(new Error('The provider interrupted its response. Retry this message.'), { status: Number(event.error.code) || 502, body: JSON.stringify(event.error) })
    if (event.usage) usage = event.usage
    const choice = event.choices?.[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content) { content += delta.content; onText(delta.content) }
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0
      const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (part.id) call.id = part.id
      if (part.function?.name) call.function.name += part.function.name
      if (part.function?.arguments) call.function.arguments += part.function.arguments
      calls.set(index, call)
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 2_000_000 || content.length > 2_000_000) throw new Error('The provider response was too large.')
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) { frame(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1) }
      if (done) { if (buffer.trim()) frame(buffer.trim()); break }
    }
  } finally { reader.releaseLock() }
  if (!ended && !finish) throw new Error('The response connection ended early. Retry to continue.')
  if (!finish) throw new Error('The provider did not finish its response. Retry to continue.')
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
  for (const call of toolCalls) if (!call.id || !call.function.name) throw new Error('The provider returned an incomplete tool call. Retry to continue.')
  return { choices: [{ message: { content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage, streamed: true }
}
