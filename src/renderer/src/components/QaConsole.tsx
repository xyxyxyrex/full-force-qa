import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BREAKPOINTS, isBreakpoint, type Breakpoint } from '../../../shared/designScale'
import { isAgentId, type AgentId, type QaRunEvent } from '../../../shared/qaAgent'
import './QaConsole.css'

type Kind = 'input' | 'info' | 'text' | 'tool' | 'ok' | 'bad' | 'status' | 'error' | 'done'
interface Line { id: number; kind: Kind; text: string; images?: Array<{ dataUrl: string; caption: string }> }

const HELP = [
  'qa run [desktop] [tablet] [mobile] [--agent <id>]   review the open page against its designs',
  'qa stop                                              stop the review that is running',
  'agents                                               which agents are ready',
  'context                                              what is open, which designs are stored, the tracker columns',
  'tool <name> [json]                                   call a tool by hand, for example: tool capture_live {"breakpoint":"desktop"}',
  'tracker                                              show the tracker columns',
  'clear                                                clear this screen',
  'help                                                 show this list',
].join('\n')

const preview = (value: unknown) => { const text = JSON.stringify(value) ?? ''; return text.length > 200 ? `${text.slice(0, 197)}…` : text }
const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

interface Props { open: boolean; onClose: () => void }

export default function QaConsole({ open, onClose }: Props) {
  const [lines, setLines] = useState<Line[]>([{ id: 0, kind: 'info', text: 'QA console. Type "help" for commands, or "qa run" to review the open page.' }])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const history = useRef<string[]>([])
  const historyIndex = useRef(-1)
  const nextId = useRef(1)
  const lastWasDelta = useRef(false)
  const tokens = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const add = useCallback((kind: Kind, text: string, images?: Line['images']) => {
    lastWasDelta.current = false
    setLines((current) => [...current, { id: nextId.current++, kind, text, images }].slice(-600))
  }, [])

  // Events arrive even while the drawer is closed, so the transcript is complete when it is opened.
  useEffect(() => {
    void window.electronAPI.qaRunActive().then(setRunning)
    return window.electronAPI.onQaRunEvent((event: QaRunEvent) => {
      switch (event.type) {
        case 'started': tokens.current = 0; setRunning(true); add('status', `Started with ${event.label}.`); break
        case 'status': add('status', event.message); break
        case 'text':
          if (event.delta && lastWasDelta.current) {
            setLines((current) => { const last = current[current.length - 1]; return last?.kind === 'text' ? [...current.slice(0, -1), { ...last, text: last.text + event.text }] : current })
          } else {
            setLines((current) => [...current, { id: nextId.current++, kind: 'text' as Kind, text: event.text }].slice(-600))
          }
          lastWasDelta.current = !!event.delta
          break
        case 'tool': add('tool', `▸ ${event.name} ${preview(event.args)}`); break
        case 'tool-result': add(event.isError ? 'bad' : 'ok', `${event.isError ? '✗' : '✓'} ${event.text.split('\n')[0]}${event.images ? ` (${event.images} picture${event.images === 1 ? '' : 's'})` : ''}`); break
        case 'usage': tokens.current += event.inputTokens + event.outputTokens; break
        case 'error': add('error', event.message); break
        case 'done': add('done', `${event.message}${tokens.current ? `\n(${tokens.current.toLocaleString()} tokens)` : ''}`); break
        case 'finished': setRunning(false); break
      }
    })
  }, [add])

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [lines, open])
  useEffect(() => { if (open) window.setTimeout(() => inputRef.current?.focus(), 50) }, [open])

  const execute = useCallback(async (command: string) => {
    const words = command.trim().split(/\s+/).filter(Boolean)
    if (!words.length) return
    add('input', `> ${command.trim()}`)
    const [head, ...rest] = words
    try {
      if (head === 'help') add('info', HELP)
      else if (head === 'clear') setLines([])
      else if (head === 'agents') {
        const overview = await window.electronAPI.qaAgentsOverview()
        if (!overview) throw new Error('Could not read the agent list.')
        add('info', overview.agents.map((agent) => `${agent.id === overview.settings.defaultAgent ? '*' : ' '} ${agent.id.padEnd(14)} ${agent.ready ? 'ready    ' : 'not ready'}  ${agent.detail}`).join('\n') + '\n(* = default. Change it in Settings → AI Agents.)')
      } else if (head === 'tracker') {
        const format = await window.electronAPI.qaTrackerFormatGet()
        add('info', format ? `Tracker columns: ${format.columns.join(' | ')}` : 'No tracker format yet. Paste it in Settings → AI Agents.')
      } else if (head === 'context') {
        const result = await window.electronAPI.qaCallTool('get_context', {})
        add(result.isError ? 'bad' : 'info', result.text)
      } else if (head === 'tool') {
        if (!rest[0]) throw new Error('Usage: tool <name> [json]')
        let args: unknown = {}
        const raw = command.trim().slice(command.trim().indexOf(rest[0]) + rest[0].length).trim()
        if (raw) { try { args = JSON.parse(raw) } catch { throw new Error('The arguments must be valid JSON.') } }
        const result = await window.electronAPI.qaCallTool(rest[0], args)
        add(result.isError ? 'bad' : 'info', result.text, result.images.map((image) => ({ dataUrl: image.dataUrl, caption: image.caption })))
      } else if (head === 'qa' && rest[0] === 'stop') {
        add('info', (await window.electronAPI.qaRunStop()) ? 'Stopping…' : 'No review is running.')
      } else if (head === 'qa' && rest[0] === 'run') {
        let agent: AgentId | undefined
        const breakpoints: Breakpoint[] = []
        const args = rest.slice(1)
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--agent') {
            const value = args[++i]
            if (!isAgentId(value)) throw new Error(`Unknown agent "${value || ''}". Type "agents" to see the ids.`)
            agent = value
          } else if (isBreakpoint(args[i])) breakpoints.push(args[i] as Breakpoint)
          else throw new Error(`Unknown option "${args[i]}". Breakpoints are: ${BREAKPOINTS.join(', ')}.`)
        }
        const result = await window.electronAPI.qaRunStart({ agent, breakpoints: breakpoints.length ? breakpoints : undefined })
        if (!result.started) add('error', result.error)
        else setRunning(true)
      } else add('error', `Unknown command "${head}". Type "help".`)
    } catch (cause) {
      add('error', cleanError(cause))
    }
  }, [add])

  const hint = useMemo(() => (running ? 'A review is running. Type "qa stop" to stop it.' : 'Type a command'), [running])

  return (
    <div className="qa-console" hidden={!open} role="region" aria-label="QA console">
      <div className="qa-console-bar">
        <strong>QA console</strong>
        {running && <span className="qa-console-running"><span /> Review running</span>}
        <span className="qa-console-spacer" />
        {running && <button type="button" onClick={() => void execute('qa stop')}>Stop</button>}
        <button type="button" onClick={() => setLines([])} title="Clear">Clear</button>
        <button type="button" onClick={onClose} aria-label="Close the QA console">×</button>
      </div>
      <div className="qa-console-body" ref={scroller} onClick={() => inputRef.current?.focus()}>
        {lines.map((line) => (
          <div key={line.id} className={`qa-line ${line.kind}`}>
            <pre>{line.text}</pre>
            {line.images && line.images.length > 0 && <div className="qa-images">{line.images.map((image, index) => <figure key={index}><img src={image.dataUrl} alt={image.caption} /><figcaption>{image.caption}</figcaption></figure>)}</div>}
          </div>
        ))}
      </div>
      <form className="qa-console-input" onSubmit={(event) => { event.preventDefault(); const value = input; if (!value.trim()) return; history.current.unshift(value); historyIndex.current = -1; setInput(''); void execute(value) }}>
        <span aria-hidden="true">&gt;</span>
        <input
          ref={inputRef} value={input} placeholder={hint} spellCheck={false} autoComplete="off"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') { event.preventDefault(); historyIndex.current = Math.min(history.current.length - 1, historyIndex.current + 1); setInput(history.current[historyIndex.current] ?? '') }
            else if (event.key === 'ArrowDown') { event.preventDefault(); historyIndex.current = Math.max(-1, historyIndex.current - 1); setInput(history.current[historyIndex.current] ?? '') }
            else if (event.key === 'l' && event.ctrlKey) { event.preventDefault(); setLines([]) }
          }}
        />
      </form>
    </div>
  )
}
