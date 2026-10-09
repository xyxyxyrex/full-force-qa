import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BREAKPOINTS, isBreakpoint, type Breakpoint } from '../../../shared/designScale'
import { type QaTarget } from '../../../shared/qaAgent'
import { formatTokens, qaChat, tokenTotal, useQaChat, type ChatMessage } from './qaChatStore'
import RichText from './qaChat/RichText'
export { default as RichText } from './qaChat/RichText'
import Activity from './qaChat/Activity'
import RetryButton from './qaChat/RetryButton'
import Findings from './qaChat/Findings'
import AuditOrganizer from './qaChat/AuditOrganizer'
import { useAuditFindings } from './qaChat/useAuditFindings'
import { commandSuggestions, parseReviewArgs, parseQaCommand, qaCommandHelp } from '../../../shared/qaCommands'
import './QaChat.css'

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const TOOL_LABELS: Record<string, string> = { get_context: 'Read page context', capture_live: 'Capture page', get_overview: 'Inspect overview', get_section: 'Inspect section', save_draft: 'Save findings', finalize_rows: 'Prepare approval', read_result: 'Read saved output', browser_open: 'Open page', browser_click: 'Click element', browser_type: 'Fill field', browser_snapshot: 'Inspect page', check_contrast: 'Check contrast', check_layout: 'Check layout', check_text: 'Check copy', seo_check: 'Check SEO' }
const toolTarget = (value: unknown) => {
  const args = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return [args.breakpoint, args.section, args.ref, args.url].filter(item => typeof item === 'string').join(' · ').slice(0, 90)
}

const SUGGESTIONS = [
  { label: 'Review this page', send: '/review' },
  { label: 'Test links and forms', send: 'Test the links, buttons, menus and forms on this page and tell me what does not work.' },
  { label: 'Check copy, contrast and layout', send: 'Open this page in your browser and check the copy, contrast and layout (desktop, then mobile). Tell me what a visitor would notice.' },
  { label: 'SEO check', send: 'Run the SEO checks on this page and tell me what to fix before launch.' },
]

function ToolCard({ message }: { message: Extract<ChatMessage, { kind: 'tool' }> }) {
  const [full, setFull] = useState('')
  const [nextOffset, setNextOffset] = useState<number | null>(0)
  const [loadError, setLoadError] = useState('')
  const state = message.pending ? 'pending' : message.cancelled ? 'cancelled' : message.isError ? 'bad' : 'ok'
  return (
    <details className={`qa-chat-tool ${state}`}>
      <summary>
        <span className="qa-chat-tool-icon" aria-hidden="true">{message.pending ? '' : message.isError ? '✗' : '✓'}</span>
        <span className="qa-chat-tool-name">{TOOL_LABELS[message.name] || message.name.replace(/_/g, ' ')}</span>
        <span className="qa-chat-tool-args">{toolTarget(message.args)}</span>
      </summary>
      <div className="qa-chat-tool-body">
        <small>{message.pending ? 'Running' : message.cancelled ? 'Cancelled' : message.isError ? 'Failed' : 'Succeeded'}{message.timestamp && message.finishedAt ? ` \u00b7 ${((message.finishedAt - message.timestamp) / 1000).toFixed(1)}s` : ''}</small>
        <RetryButton id={message.retryId}/>
        {message.resultId && message.executionId && <button type="button" className="qa-tool-full-result" onClick={() => {
          void window.electronAPI.qaExecutionResult(`${message.executionId}/${message.resultId}`, nextOffset || 0).then(result => { if (result) { setFull(previous => previous + result.text); setNextOffset(result.nextOffset) } else setLoadError('This saved output is no longer available.') }).catch(() => setLoadError('Could not load this saved output. Try again.'))
        }} disabled={nextOffset === null}>{full ? nextOffset === null ? 'Full output loaded' : 'Load more output' : 'View saved output'}</button>}
        {full && <pre>{full}</pre>}{loadError && <small role="alert">{loadError}</small>}
        {message.args !== undefined && <pre>{JSON.stringify(message.args, null, 2)}</pre>}
        {message.result !== undefined && <pre>{message.result}{message.images ? `\n(${message.images} picture${message.images === 1 ? '' : 's'} sent to the agent)` : ''}</pre>}
      </div>
    </details>
  )
}

function Message({ message }: { message: ChatMessage }) {
  switch (message.kind) {
    case 'user': return <div className="qa-chat-msg user"><div className="qa-chat-bubble">{message.text}</div></div>
    case 'assistant': return <div className="qa-chat-msg assistant"><div className="qa-chat-text"><RichText text={message.text} /><button className="qa-answer-copy" type="button" onClick={() => void navigator.clipboard.writeText(message.text).catch(() => {})}>Copy answer</button></div></div>
    case 'tool': return <div className="qa-chat-msg"><ToolCard message={message} /></div>
    case 'error': return <div className="qa-chat-msg"><div className="qa-chat-note error" role="alert">{message.text}<RetryButton id={message.retryId} blocked={message.retryBlocked} settings={/key|quota|budget|model|sign.?in|Settings/i.test(message.text)}/>{message.detail && <details><summary>Technical details</summary><pre>{message.detail}</pre></details>}</div></div>
    case 'findings': return <Findings key={message.timestamp || message.id} message={message}/>
    case 'usage': return <div className="qa-chat-msg"><div className="qa-chat-note usage">{message.text}</div></div>
    default: return <div className="qa-chat-msg"><div className="qa-chat-note"><RichText text={message.text}/></div></div>
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

interface Props { onClose: () => void; detached?: boolean }

export default function QaChat({ onClose, detached = false }: Props) {
  const chat = useQaChat()
  const organizer = useAuditFindings()
  const { input, tab } = chat.draft
  const setInput = (value: string) => qaChat.setDraft(value, qaChat.getState().draft.tab)
  const setTab = (value: 'chat' | 'findings') => qaChat.setDraft(qaChat.getState().draft.input, value)
  const [windowBusy, setWindowBusy] = useState(false)
  const [windowError, setWindowError] = useState('')
  const changeWindow = async () => {
    if (windowBusy) return
    setWindowBusy(true); setWindowError('')
    try { if (!(await (detached ? window.electronAPI.qaWindowDock() : window.electronAPI.qaWindowDetach()))) throw new Error('Could not open the agent window. Try again.') }
    catch (error) { setWindowError(cleanError(error)) }
    finally { setWindowBusy(false) }
  }
  const [busy, setBusy] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [showLatest, setShowLatest] = useState(false)
  const suggestions = commandSuggestions(input)
  useEffect(() => { setCommandIndex(0) }, [input])
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
    const result = await window.electronAPI.qaRunStart(parseReviewArgs(words))
    if (!result.started) throw Object.assign(new Error(result.error), { retryId: result.retryId })
  }

  const submit = async (raw: string) => {
    const text = raw.trim()
    if (!text) return
    history.current.unshift(text)
    historyIndex.current = -1
    stuck.current = true
    setInput('')
    let head: string; let rest: string[]
    try { const command = parseQaCommand(text); [head, ...rest] = command ? [command.command, ...command.args] : text.split(/\s+/) } catch (cause) { qaChat.addError(cleanError(cause)); return }
    setCommandsOpen(false)
    setBusy(true)
    try {
      if (head === '/help') { qaChat.addUserMessage(text); qaChat.addStatus(qaCommandHelp()) }
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
        qaChat.addStatus('### Agents\n\n' + overview.agents.map(agent => `- **${agent.id}** ${agent.ready ? 'ready' : 'not ready'}${agent.id === overview.settings.defaultAgent ? ' · default' : ''} — ${agent.detail}`).join('\n'))
      } else if (head === '/review') {
        qaChat.addUserMessage(text)
        await startReview(rest)
      } else {
        qaChat.addUserMessage(text)
        const result = await window.electronAPI.qaChatSend(text, { chatId: qaChat.getState().chatId ?? undefined })
        if (!result.started) throw Object.assign(new Error(result.error), { retryId: result.retryId })
      }
    } catch (cause) {
      qaChat.handle({ type: 'error', message: cleanError(cause), retryId: (cause as { retryId?: string })?.retryId })
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

        </div>
        <div className="qa-chat-actions">
          <button type="button" className="qa-chat-window-toggle" onClick={() => void changeWindow()} disabled={windowBusy} aria-label={detached ? 'Dock agent chat' : 'Detach agent chat'} title={detached ? 'Dock chat back in Parity' : 'Detach into a movable, resizable window'}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{detached ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M7 12h4m-2-2 2 2-2 2"/></> : <><path d="M14 3h7v7m0-7-9 9"/><path d="M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></>}</svg></button>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('parity:open-qa-history', { detail: { tab: 'chats' } }))} title="Past chats and reviews">History</button>
          <button type="button" onClick={() => void submit('/new')} disabled={chat.running} title="New chat">New chat</button>
          <button type="button" onClick={onClose} aria-label="Close the QA chat" title="Close (Ctrl+Shift+Q)">×</button>
        </div>
      </header>
      {windowError && <div className="qa-chat-window-error" role="alert">{windowError}<button type="button" onClick={() => void changeWindow()}>Retry</button></div>}
      <div className="qa-chat-metabar"><TokenMeter /><Activity execution={chat.execution} running={running}/></div>
      <div className="qa-agent-tabs" role="tablist" aria-label="QA agent views"><button role="tab" id="qa-tab-chat" aria-selected={tab==='chat'} aria-controls="qa-panel-chat" onClick={()=>setTab('chat')} onKeyDown={e=>{if(e.key==='ArrowRight'){setTab('findings');document.getElementById('qa-tab-findings')?.focus()}}}>Chat</button><button role="tab" id="qa-tab-findings" aria-selected={tab==='findings'} aria-controls="qa-panel-findings" onClick={()=>setTab('findings')} onKeyDown={e=>{if(e.key==='ArrowLeft'){setTab('chat');document.getElementById('qa-tab-chat')?.focus()}}}>Findings <span>{organizer.snapshot?.findings.filter(item=>!item.mergedInto).length||0}</span></button></div>
      {tab==='findings'&&<div id="qa-panel-findings" role="tabpanel" aria-labelledby="qa-tab-findings" className="qa-findings-panel"><AuditOrganizer {...organizer}/></div>}
      <div id="qa-panel-chat" role="tabpanel" aria-labelledby="qa-tab-chat" className="qa-chat-tab-panel" hidden={tab!=='chat'}>
      <ReviewTarget />

      <div
        className="qa-chat-body" ref={scroller}
        onScroll={(event) => { const el = event.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setShowLatest(!stuck.current) }}
      >
        {chat.messages.length === 0 ? (
          <div className="qa-chat-empty">
            <h3>Ask about this page</h3>
            <p>I check the live staging page (against your Figma designs when you have them), test its links and forms, measure contrast, layout, copy and SEO, and save drafts in your organizer. Review them in Findings, or open the tracker to edit them.</p>
            <div className="qa-chat-suggestions">
              {SUGGESTIONS.map((suggestion) => <button key={suggestion.label} type="button" disabled={running} onClick={() => void submit(suggestion.send)}>{suggestion.label}</button>)}
            </div>
            <p className="qa-chat-hint">Type /help for commands.</p>
          </div>
        ) : (() => {
          const groups: React.ReactNode[] = []
          for (let i = 0; i < chat.messages.length;) {
            const message = chat.messages[i]
            if (message.kind !== 'tool') { groups.push(<Message key={message.id} message={message}/>); i++; continue }
            const tools: Array<Extract<ChatMessage, {kind:'tool'}>> = []
            while (i < chat.messages.length && chat.messages[i].kind === 'tool') tools.push(chat.messages[i++] as Extract<ChatMessage, {kind:'tool'}>)
            groups.push(<details className="qa-tool-group" key={message.id}><summary>{tools.filter(tool => tool.pending).length ? 'Running' : 'Tool activity'} · {tools.length} tool{tools.length === 1 ? '' : 's'}{tools.some(tool => tool.isError) ? ' · failed step' : ''}</summary>{tools.map(tool => <Message key={tool.id} message={tool}/>)}</details>)
          }
          return groups
        })()}
      </div>

      {showLatest && <button type="button" className="qa-jump-latest" onClick={() => { stuck.current = true; setShowLatest(false); scroller.current?.scrollTo({top:scroller.current.scrollHeight}) }}>Jump to latest</button>}
      <form className="qa-chat-composer" onSubmit={(event) => { event.preventDefault(); void submit(input) }}>
        {commandsOpen && suggestions.length > 0 && <div className="qa-command-menu" role="listbox" id="qa-command-list" aria-label="Slash commands">{suggestions.map((item, index) => <button role="option" aria-selected={index === commandIndex} id={`qa-command-${index}`} type="button" key={item.value} onMouseDown={event => event.preventDefault()} onClick={() => { setInput(item.value); setCommandsOpen(false); field.current?.focus() }}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div>}
        <button type="button" className="qa-command-toggle" aria-label="Show slash commands" title="Commands" onClick={() => { if (!input.startsWith('/')) setInput('/'); setCommandsOpen(!commandsOpen); field.current?.focus() }}>/</button>
        <textarea
          ref={field} value={input} rows={1} spellCheck autoComplete="off"
          placeholder={chat.running ? 'The agent is working… you can type, then send when it is done' : 'Ask about this page, or /review'}
          aria-label="Message the QA agent"
          onChange={(event) => { setInput(event.target.value); setCommandsOpen(event.target.value.startsWith('/')) }}
          aria-controls={commandsOpen ? 'qa-command-list' : undefined} aria-expanded={commandsOpen && suggestions.length > 0} aria-activedescendant={commandsOpen ? `qa-command-${commandIndex}` : undefined}
          onKeyDown={(event) => {
            if (commandsOpen && suggestions.length && !event.nativeEvent.isComposing) {
              if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setCommandIndex(index => Math.max(0, Math.min(suggestions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return }
              if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); setInput(suggestions[commandIndex].value); setCommandsOpen(false); return }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCommandsOpen(false); return }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!chat.running || input.trim() === '/stop') void submit(input) }
            else if (event.key === 'ArrowUp' && !input && history.current.length) { event.preventDefault(); historyIndex.current = Math.min(history.current.length - 1, historyIndex.current + 1); setInput(history.current[historyIndex.current] ?? '') }
            else if (event.key === 'ArrowDown' && historyIndex.current >= 0) { event.preventDefault(); historyIndex.current -= 1; setInput(history.current[historyIndex.current] ?? '') }
            else if (event.key === 'Escape' && chat.running) { event.preventDefault(); void window.electronAPI.qaRunStop() }
          }}
        />
        {chat.running
          ? <button type="button" className="qa-chat-send stop" onClick={() => void window.electronAPI.qaRunStop()} aria-label="Stop">■ Stop</button>
          : <button type="submit" className="qa-chat-send" disabled={!input.trim() || busy} aria-label="Send">Send</button>}
      </form>
      </div>
    </section>
  )
}
