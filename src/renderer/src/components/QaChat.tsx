import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BREAKPOINTS, isBreakpoint, type Breakpoint } from '../../../shared/designScale'
import { isAgentId, type AgentId, type QaTarget } from '../../../shared/qaAgent'
import { formatTokens, qaChat, tokenTotal, useQaChat, type ChatMessage } from './qaChatStore'
import './QaChat.css'

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const argsPreview = (value: unknown) => { const text = value === undefined ? '' : JSON.stringify(value) ?? ''; return text.length > 90 ? `${text.slice(0, 87)}…` : text }

const SUGGESTIONS = [
  { label: 'Review this page', send: '/review' },
  { label: 'Which designs are loaded?', send: 'Which designs are loaded for this page, and at what sizes?' },
  { label: 'Check the hero on mobile', send: 'Compare the hero section on mobile with the design and tell me what differs.' },
]

const HELP = [
  '/review [desktop] [tablet] [mobile] [--no-design]   review the open page and hand the rows over for approval.\n                                         With no design stored for the page (or --no-design) the agent judges the page on its own.',
  '/stop                                 stop what the agent is doing',
  '/new                                  start a new chat (the current one is kept in History)',
  '/history                              past chats and past reviews, with their screenshots',
  '/agents                               which agents are ready',
  '/help                                 show this list',
  'Anything else is sent to the agent as a message.',
].join('\n')

// Just enough formatting for an answer: paragraphs, lists, **bold**, `code` and code fences.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>
    return <Fragment key={index}>{part}</Fragment>
  })
}

export function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: ReactNode[] = []
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim().startsWith('```')) {
        const code: string[] = []
        i++
        while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++])
        i++
        out.push(<pre key={out.length}>{code.join('\n')}</pre>)
      } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line)
        const items: string[] = []
        while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
        const list = items.map((item, index) => <li key={index}>{inline(item)}</li>)
        out.push(ordered ? <ol key={out.length}>{list}</ol> : <ul key={out.length}>{list}</ul>)
      } else if (!line.trim()) {
        i++
      } else {
        const paragraph: string[] = []
        while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('```') && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) paragraph.push(lines[i++])
        out.push(<p key={out.length}>{paragraph.flatMap((l, index) => (index ? [<br key={`b${index}`} />, ...inline(l)] : inline(l)))}</p>)
      }
    }
    return out
  }, [text])
  return <>{blocks}</>
}

function ToolCard({ message }: { message: Extract<ChatMessage, { kind: 'tool' }> }) {
  const state = message.pending ? 'pending' : message.isError ? 'bad' : 'ok'
  return (
    <details className={`qa-chat-tool ${state}`}>
      <summary>
        <span className="qa-chat-tool-icon" aria-hidden="true">{message.pending ? '' : message.isError ? '✗' : '✓'}</span>
        <span className="qa-chat-tool-name">{message.name}</span>
        <span className="qa-chat-tool-args">{argsPreview(message.args)}</span>
      </summary>
      <div className="qa-chat-tool-body">
        {message.args !== undefined && <pre>{JSON.stringify(message.args, null, 2)}</pre>}
        {message.result !== undefined && <pre>{message.result}{message.images ? `\n(${message.images} picture${message.images === 1 ? '' : 's'} sent to the agent)` : ''}</pre>}
      </div>
    </details>
  )
}

function Message({ message }: { message: ChatMessage }) {
  switch (message.kind) {
    case 'user': return <div className="qa-chat-msg user"><div className="qa-chat-bubble">{message.text}</div></div>
    case 'assistant': return <div className="qa-chat-msg assistant"><div className="qa-chat-text"><RichText text={message.text} /></div></div>
    case 'tool': return <div className="qa-chat-msg"><ToolCard message={message} /></div>
    case 'error': return <div className="qa-chat-msg"><div className="qa-chat-note error" role="alert">{message.text}</div></div>
    case 'usage': return <div className="qa-chat-msg"><div className="qa-chat-note usage">{message.text}</div></div>
    default: return <div className="qa-chat-msg"><div className={`qa-chat-note${message.text.includes('\n') ? ' mono' : ''}`}>{message.text}</div></div>
  }
}

export function TokenMeter() {
  const chat = useQaChat()
  const total = tokenTotal(chat.session)
  const turn = tokenTotal(chat.turn)
  const title = chat.usageReported
    ? `This chat: ${chat.session.input.toLocaleString()} input + ${chat.session.output.toLocaleString()} output tokens over ${chat.session.requests} request${chat.session.requests === 1 ? '' : 's'}.\nLast message: ${turn.toLocaleString()} tokens.\nContext now: about ${chat.context.toLocaleString()} tokens.\nEvery request re-sends the conversation, so input counts add up faster than the text you see.${chat.budgetTokens ? `\nLimit per message: ${chat.budgetTokens.toLocaleString()} tokens (Settings → AI Agents).` : ''}`
    : 'Token usage appears after the agent answers. Some agent programs do not report it.'
  return (
    <span className="qa-chat-meter" title={title} aria-label={chat.usageReported ? `${total} tokens used this chat` : 'Token usage not reported yet'}>
      {chat.usageReported ? (
        <>
          <span><b>{formatTokens(total)}</b> tokens</span>
          <span className="qa-chat-meter-sub">{formatTokens(chat.session.input)} in · {formatTokens(chat.session.output)} out</span>
          {chat.running && <span className="qa-chat-meter-sub">+{formatTokens(turn)} now</span>}
          {chat.budgetTokens > 0 && chat.running && <span className="qa-chat-meter-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (turn / chat.budgetTokens) * 100)}%` }} /></span>}
        </>
      ) : <span className="qa-chat-meter-sub">tokens: —</span>}
    </span>
  )
}

const BREAKPOINT_LABEL: Record<Breakpoint, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' }

/** The page the agent will review and the designs stored for that page, so there is never a doubt about what it is looking at. */
export function ReviewTarget() {
  const [target, setTarget] = useState<QaTarget | null | undefined>(undefined)
  const running = useQaChat().running
  useEffect(() => {
    let alive = true
    const load = () => { void window.electronAPI.qaTarget().then((next) => { if (alive) setTarget(next) }).catch(() => { if (alive) setTarget(null) }) }
    load()
    const timer = window.setInterval(load, 2500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [running])
  if (target === undefined) return null
  if (!target) return <div className="qa-target"><p className="qa-target-none">No page is open. Open a project page and its designs show here.</p></div>
  const missing = BREAKPOINTS.filter((bp) => !target.slots[bp])
  return (
    <div className="qa-target" aria-label="What a review will use">
      <div className="qa-target-page"><span>Page</span><code title={target.pageUrl}>{target.pageId}</code></div>
      <div className="qa-target-designs">
        {BREAKPOINTS.map((bp) => {
          const slot = target.slots[bp]
          return slot ? (
            <figure key={bp} className="qa-target-design" title={`${BREAKPOINT_LABEL[bp]} design: ${slot.fileName ?? 'unnamed'} (${slot.frameWidth}px wide frame, ${slot.scale}x export)`}>
              {target.thumbnails[bp] ? <img src={target.thumbnails[bp]} alt={`${BREAKPOINT_LABEL[bp]} design`} /> : <span className="qa-target-noimg" />}
              <figcaption><b>{BREAKPOINT_LABEL[bp]}</b> {slot.frameWidth}px<small>{slot.fileName ?? 'unnamed'}</small></figcaption>
            </figure>
          ) : (
            <div key={bp} className="qa-target-design missing" title={`No ${BREAKPOINT_LABEL[bp]} design for this page`}>
              <span className="qa-target-noimg" />
              <figcaption><b>{BREAKPOINT_LABEL[bp]}</b><small>no design</small></figcaption>
            </div>
          )
        })}
      </div>
      {missing.length === BREAKPOINTS.length
        ? <p className="qa-target-warn">No designs for this page yet. Add the Figma PNGs in the Figma overlay panel; designs are kept per page.</p>
        : missing.length > 0 && <p className="qa-target-note">No {missing.map((bp) => BREAKPOINT_LABEL[bp].toLowerCase()).join(' or ')} design for this page, so {missing.length === 1 ? 'that breakpoint is' : 'those breakpoints are'} skipped in a review.</p>}
    </div>
  )
}

interface Props { onClose: () => void }

export default function QaChat({ onClose }: Props) {
  const chat = useQaChat()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const field = useRef<HTMLTextAreaElement>(null)
  const history = useRef<string[]>([])
  const historyIndex = useRef(-1)

  useLayoutEffect(() => { if (stuck.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [chat.messages])
  useEffect(() => { field.current?.focus() }, [])
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`
  }, [input])

  const running = chat.running || busy

  const startReview = async (words: string[]) => {
    let agent: AgentId | undefined
    let standalone = false
    const breakpoints: Breakpoint[] = []
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '--no-design') standalone = true
      else if (words[i] === '--agent') {
        const value = words[++i]
        if (!isAgentId(value)) throw new Error(`Unknown agent "${value || ''}". Type /agents to see the ids.`)
        agent = value
      } else if (isBreakpoint(words[i])) breakpoints.push(words[i] as Breakpoint)
      else throw new Error(`Unknown option "${words[i]}". Breakpoints are: ${BREAKPOINTS.join(', ')}.`)
    }
    const result = await window.electronAPI.qaRunStart({ agent, breakpoints: breakpoints.length ? breakpoints : undefined, ...(standalone ? { standalone } : {}) })
    if (!result.started) throw new Error(result.error)
  }

  const submit = async (raw: string) => {
    const text = raw.trim()
    if (!text) return
    history.current.unshift(text)
    historyIndex.current = -1
    stuck.current = true
    setInput('')
    const [head, ...rest] = text.split(/\s+/)
    setBusy(true)
    try {
      if (head === '/help') { qaChat.addUserMessage(text); qaChat.addStatus(HELP) }
      else if (head === '/history') window.dispatchEvent(new CustomEvent('parity:open-qa-history', { detail: { tab: rest[0] === 'chats' ? 'chats' : 'reviews' } }))
      else if (head === '/new') {
        if (chat.running) throw new Error('Stop the agent first.')
        await window.electronAPI.qaChatReset()
        qaChat.clear()
      } else if (head === '/stop') {
        if (!(await window.electronAPI.qaRunStop())) qaChat.addStatus('Nothing is running.')
      } else if (head === '/agents') {
        qaChat.addUserMessage(text)
        const overview = await window.electronAPI.qaAgentsOverview()
        if (!overview) throw new Error('Could not read the agent list.')
        qaChat.addStatus(overview.agents.map((agent) => `${agent.id === overview.settings.defaultAgent ? '*' : ' '} ${agent.id.padEnd(14)} ${agent.ready ? 'ready    ' : 'not ready'}  ${agent.detail}`).join('\n') + '\n(* = default. Change it in Settings → AI Agents.)')
      } else if (head === '/review') {
        qaChat.addUserMessage(text)
        await startReview(rest)
      } else {
        qaChat.addUserMessage(text)
        const result = await window.electronAPI.qaChatSend(text, { chatId: qaChat.getState().chatId ?? undefined })
        if (!result.started) throw new Error(result.error)
      }
    } catch (cause) {
      qaChat.addError(cleanError(cause))
    } finally {
      setBusy(false)
      window.setTimeout(() => field.current?.focus(), 0)
    }
  }

  return (
    <section className="qa-chat" role="region" aria-label="QA agent chat">
      <header className="qa-chat-bar">
        <div className="qa-chat-title">
          <strong>QA agent</strong>
          {chat.agentLabel && <span className="qa-chat-agent" title={chat.agentLabel}>{chat.agentLabel}</span>}
          {chat.running && <span className="qa-chat-running" role="status"><span /> Working</span>}
        </div>
        <div className="qa-chat-actions">
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('parity:open-qa-history', { detail: { tab: 'chats' } }))} title="Past chats and reviews">History</button>
          <button type="button" onClick={() => void submit('/new')} disabled={chat.running} title="New chat">New chat</button>
          <button type="button" onClick={onClose} aria-label="Close the QA chat" title="Close (Ctrl+Shift+Q)">×</button>
        </div>
      </header>
      <div className="qa-chat-metabar"><TokenMeter /></div>
      <ReviewTarget />

      <div
        className="qa-chat-body" ref={scroller}
        onScroll={(event) => { const el = event.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
      >
        {chat.messages.length === 0 ? (
          <div className="qa-chat-empty">
            <h3>Ask about this page</h3>
            <p>I compare the live staging page with your Figma designs, one breakpoint at a time, and draft rows for the tracker. You approve them before anything is copied.</p>
            <div className="qa-chat-suggestions">
              {SUGGESTIONS.map((suggestion) => <button key={suggestion.label} type="button" disabled={running} onClick={() => void submit(suggestion.send)}>{suggestion.label}</button>)}
            </div>
            <p className="qa-chat-hint">Type /help for commands.</p>
          </div>
        ) : chat.messages.map((message) => <Message key={message.id} message={message} />)}
        {chat.running && <div className="qa-chat-typing" aria-hidden="true"><span /><span /><span /></div>}
      </div>

      <form className="qa-chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(input) }}>
        <textarea
          ref={field} value={input} rows={1} spellCheck autoComplete="off"
          placeholder={chat.running ? 'The agent is working… you can type, then send when it is done' : 'Ask about this page, or /review'}
          aria-label="Message the QA agent"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!chat.running) void submit(input) }
            else if (event.key === 'ArrowUp' && !input && history.current.length) { event.preventDefault(); historyIndex.current = Math.min(history.current.length - 1, historyIndex.current + 1); setInput(history.current[historyIndex.current] ?? '') }
            else if (event.key === 'ArrowDown' && historyIndex.current >= 0) { event.preventDefault(); historyIndex.current -= 1; setInput(history.current[historyIndex.current] ?? '') }
            else if (event.key === 'Escape' && chat.running) { event.preventDefault(); void window.electronAPI.qaRunStop() }
          }}
        />
        {chat.running
          ? <button type="button" className="qa-chat-send stop" onClick={() => void window.electronAPI.qaRunStop()} aria-label="Stop">■ Stop</button>
          : <button type="submit" className="qa-chat-send" disabled={!input.trim() || busy} aria-label="Send">Send</button>}
      </form>
    </section>
  )
}
