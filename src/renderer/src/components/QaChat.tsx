import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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
import { commandSuggestions, parseReviewArgs, parseQaCommand, parseQuotaArgs, qaCommandHelp } from '../../../shared/qaCommands'
import { formatChatUsage, formatQuota } from '../../../shared/agentUsage'
import './QaChat.css'
import ChatModelPicker from './qaChat/ChatModelPicker'
import { WorkspaceAction, WorkspaceResults } from './qaChat/WorkspaceCards'
import { useWorkspaceSuggestions } from './qaChat/useWorkspaceSuggestions'
import ChatIcon from './qaChat/ChatIcon'
import ResponsePending from './qaChat/ResponsePending'
import ChatImages from './qaChat/ChatImages'
import ComposerAdd from './qaChat/ComposerAdd'
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES } from '../../../shared/chatImages'
import AssistantAnswer from './qaChat/AssistantAnswer'

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

function Message({ message, chatId, openedAt, progressed, command, busy }: { message: ChatMessage; chatId: string | null; openedAt: number; progressed: () => void; command: (input: string) => void; busy: boolean }) {
  switch (message.kind) {
    case 'workspace-proposal': return <WorkspaceAction proposal={message.proposal}/>
    case 'workspace-result': return <WorkspaceResults {...message}/>
    case 'user': return <div className="qa-chat-msg user"><div className="qa-chat-bubble">{message.text}{!!message.attachments?.length && <ChatImages chatId={chatId} images={message.attachments}/>}</div></div>
    case 'assistant': return <AssistantAnswer message={message} openedAt={openedAt} progressed={progressed}/>
    case 'tool': return <div className="qa-chat-msg"><ToolCard message={message} /></div>
    case 'error': return <div className="qa-chat-msg"><div className="qa-chat-note error" role="alert">{message.text}<RetryButton id={message.retryId} blocked={message.retryBlocked} settings={/key|quota|budget|model|sign.?in|Settings/i.test(message.text)}/>{message.detail && <details><summary>Technical details</summary><pre>{message.detail}</pre></details>}</div></div>
    case 'findings': return <Findings key={message.timestamp || message.id} message={message}/>
    case 'usage': return <div className="qa-chat-msg"><div className="qa-chat-note usage">{message.text}</div></div>
    case 'status': return <div className="qa-chat-msg"><div className={`qa-chat-note${message.localCommand ? ' qa-command-report' : ''}`}><RichText text={message.text}/>{message.localCommand?.startsWith('/quota') && <button className="qa-quota-refresh" type="button" disabled={busy} onClick={() => command(`${message.localCommand!.replace(/\s+--refresh\b/g, '')} --refresh`)}><ChatIcon name="history" size={13}/>Check again</button>}</div></div>
    default: return null
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
  const tooltipId = useId()
  const [target, setTarget] = useState<QaTarget | null | undefined>(undefined)
  const running = useQaChat().running
  useEffect(() => {
    let alive = true
    let generation=0
    const load = () => {const version=++generation;void window.electronAPI.qaTarget().then((next) => { if (alive&&version===generation) setTarget(next) }).catch(() => { if (alive&&version===generation) setTarget(null) }) }
    load()
    const off=window.electronAPI.onAccountChanged?.(()=>{generation++;setTarget(null);load()})
    const timer = window.setInterval(load, 2500)
    return () => { alive = false;off?.();window.clearInterval(timer) }
  }, [running])
  if (target === undefined) return null
  if (!target) return <div className="qa-target"><p className="qa-target-none">Ask about Parity or search your workspace. Open a project to review its website.</p></div>
  return (
    <div className="qa-target" aria-label="What a review will use">
      <div className="qa-target-page"><span>Page</span><code title={target.pageUrl}>{target.pageId}</code></div>
      <div className="qa-target-designs">
        {BREAKPOINTS.map((bp) => {
          const slot = target.slots[bp]
          const label = BREAKPOINT_LABEL[bp]
          const description = slot
            ? `${label} design: ${slot.fileName ?? 'unnamed'} · ${slot.frameWidth}px frame, ${slot.scale}× export.`
            : `No ${label.toLowerCase()} design for this page yet. Add its Figma PNG in the Figma overlay panel; designs are kept per page.`
          return <div key={bp} className={`qa-target-design${slot ? '' : ' missing'}`} tabIndex={0} role="img" aria-label={`${label}: ${slot ? 'design available' : 'no design'}`} aria-describedby={`${tooltipId}-${bp}`}>
            <ChatIcon name={bp} size={20}/>
            {!slot && <span className="qa-target-unavailable"><ChatIcon name="unavailable" size={12}/></span>}
            <span className="qa-target-tooltip" id={`${tooltipId}-${bp}`} role="tooltip">{description}</span>
          </div>
        })}
      </div>
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
  const [commandNotice, setCommandNotice] = useState('')
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [showLatest, setShowLatest] = useState(false)
  const [addingImages, setAddingImages] = useState(false), [imageError, setImageError] = useState(''), [dragging, setDragging] = useState(false)
  useEffect(() => { setImageError(''); setDragging(false) }, [chat.chatId])
  const workspaceSuggestions=useWorkspaceSuggestions(input)
  const suggestions = [...commandSuggestions(input),...workspaceSuggestions]
  useEffect(() => { setCommandIndex(0) }, [input])
  useEffect(()=>{document.getElementById(`qa-command-${commandIndex}`)?.scrollIntoView({block:'nearest'})},[commandIndex])
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const openedAt = useRef(Date.now())
  const replyProgress = useCallback(() => { if (stuck.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [])
  const field = useRef<HTMLTextAreaElement>(null)
  const history = useRef<string[]>([])
  const historyIndex = useRef(-1)

  useLayoutEffect(() => { if (stuck.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [chat.messages, chat.running, chat.responding, chat.execution?.phase, chat.draft.attachments?.length])
  useEffect(() => { field.current?.focus() }, [])
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const running = chat.running || busy
  const attached = chat.draft.attachments || []
  const addImages = async (files: File[]) => {
    if (!files.length || addingImages) return
    if (attached.length + files.length > MAX_CHAT_IMAGES) { setImageError('Attach up to 4 images. Remove one before adding more.'); return }
    if (files.some(file => file.size > MAX_CHAT_IMAGE_BYTES)) { setImageError('Each image must be smaller than 10 MB.'); return }
    if (files.some(file => !/^image\/(png|jpeg|webp|gif)$/.test(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name))) { setImageError('Choose PNG, JPEG, WebP, or GIF images.'); return }
    const chatId = qaChat.ensureChat(), owner = localStorage.getItem('parity_account_owner_key')
    setAddingImages(true); setImageError('')
    try {
      const uploads = await Promise.all(files.map(async file => ({ name: file.name || 'Pasted image.png', bytes: new Uint8Array(await file.arrayBuffer()) })))
      if (owner !== localStorage.getItem('parity_account_owner_key') || chatId !== qaChat.getState().chatId) return
      const images = await window.electronAPI.qaChatImagesAdd({ chatId, ownerKey: owner, files: uploads })
      if (owner !== localStorage.getItem('parity_account_owner_key') || chatId !== qaChat.getState().chatId) return
      const draft = qaChat.getState().draft
      qaChat.setDraft(draft.input, draft.tab, [...(draft.attachments || []), ...images].slice(0, MAX_CHAT_IMAGES))
    } catch (cause) { if (owner === localStorage.getItem('parity_account_owner_key') && chatId === qaChat.getState().chatId) setImageError(cleanError(cause)) }
    finally { setAddingImages(false) }
  }

  const startReview = async (words: string[]) => {
    const result = await window.electronAPI.qaRunStart({...parseReviewArgs(words),chatId:qaChat.getState().chatId||undefined})
    if (!result.started) throw Object.assign(new Error(result.error), { retryId: result.retryId })
  }

  const submit = async (raw: string) => {
    if (addingImages) return
    if (busy && !/^\/(?:stop|usage)(?:\s|$)/.test(raw.trim())) return
    const images = qaChat.getState().draft.attachments || []
    const text = raw.trim() || (images.length ? 'Please inspect the attached images.' : '')
    if (!text) return
    if (images.length && text.startsWith('/')) { setImageError('Send images with a chat message. For /review designs, use the Figma overlay panel.'); return }
    const owner = localStorage.getItem('parity_account_owner_key')
    const draftChatId = qaChat.getState().chatId
    history.current.unshift(text)
    historyIndex.current = -1
    stuck.current = true
    setInput('')
    let head: string; let rest: string[]
    try { const command = parseQaCommand(text); [head, ...rest] = command ? [command.command, ...command.args] : text.split(/\s+/) } catch (cause) { qaChat.addError(cleanError(cause)); return }
    setCommandsOpen(false)
    if (head === '/usage') {
      const state = qaChat.getState()
      qaChat.addInfo(text, formatChatUsage({ ...state, executionTokens: state.execution?.tokens }))
      return
    }
    let reportChatId = draftChatId
    setBusy(true)
    try {
      if (head === '/quota') {
        const options = parseQuotaArgs(rest), chatId = qaChat.ensureChat()
        reportChatId = chatId
        setCommandNotice('Checking provider quota…')
        const result = await window.electronAPI.qaAgentQuota({ ...options, chatId, ownerKey: owner })
        if (owner !== localStorage.getItem('parity_account_owner_key') || chatId !== qaChat.getState().chatId) return
        qaChat.addInfo(text, formatQuota(result))
      } else if (head === '/help') { qaChat.addUserMessage(text); qaChat.addStatus(qaCommandHelp()) }
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
      } else if(head==='/agent') {
        window.dispatchEvent(new Event('parity:choose-chat-agent'))
      } else if(head.startsWith('/')) {
        qaChat.addUserMessage(text)
        const result=await window.electronAPI.qaWorkspaceCommand(text)
        if(result.text)qaChat.addStatus(result.text)
        if(result.search)qaChat.handle({type:'workspace-result',...result.search})
        if(result.proposal)qaChat.handle({type:'workspace-proposal',proposal:result.proposal})
      } else {
        qaChat.addUserMessage(text, images)
        const chatId = qaChat.getState().chatId
        const result = await window.electronAPI.qaChatSend(text, { chatId: chatId ?? undefined, attachmentIds: images.map(image => image.id) })
        if (owner !== localStorage.getItem('parity_account_owner_key') || chatId !== qaChat.getState().chatId) return
        if (!result.started) throw Object.assign(new Error(result.error), { retryId: result.retryId })
        const draft = qaChat.getState().draft
        if (images.length && JSON.stringify((draft.attachments || []).map(image => image.id)) === JSON.stringify(images.map(image => image.id))) qaChat.setDraft(draft.input, draft.tab, [])
      }
    } catch (cause) {
      if (owner !== localStorage.getItem('parity_account_owner_key')) return
      if (head === '/quota') {
        if (reportChatId === qaChat.getState().chatId) qaChat.addInfo(text, `### Quota check\n\n${cleanError(cause)}\n\nUse \`/quota --refresh\` to retry.`)
        return
      }
      if (images.length && draftChatId !== qaChat.getState().chatId) return
      if (images.length && !qaChat.getState().draft.input) { const draft = qaChat.getState().draft; qaChat.setDraft(raw, draft.tab) }
      qaChat.handle({ type: 'error', message: cleanError(cause), retryId: (cause as { retryId?: string })?.retryId })
    } finally {
      setCommandNotice('')
      setBusy(false)
      window.setTimeout(() => field.current?.focus(), 0)
    }
  }

  return (
    <section className="qa-chat" role="region" aria-label="QA agent chat">
      <header className="qa-chat-bar">
        <div className="qa-chat-title">
          <strong>Chat</strong>
        </div>
        <div className="qa-chat-actions">
          <button type="button" className="qa-chat-window-toggle" onClick={() => void changeWindow()} disabled={windowBusy} aria-label={detached ? 'Dock agent chat' : 'Detach agent chat'} title={detached ? 'Dock chat back in Parity' : 'Detach into a movable, resizable window'}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{detached ? <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M7 12h4m-2-2 2 2-2 2"/></> : <><path d="M14 3h7v7m0-7-9 9"/><path d="M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></>}</svg></button>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('parity:open-qa-history', { detail: { tab: 'chats' } }))} aria-label="History" title="Past chats and reviews"><ChatIcon name="history"/></button>
          <button type="button" onClick={() => void submit('/new')} disabled={chat.running} aria-label="New chat" title="New chat"><ChatIcon name="new-chat"/></button>
          <button type="button" onClick={onClose} aria-label="Close chat" title="Close (Ctrl+Shift+Q)"><ChatIcon name="close"/></button>
        </div>
      </header>
      {windowError && <div className="qa-chat-window-error" role="alert">{windowError}<button type="button" onClick={() => void changeWindow()}>Retry</button></div>}
      <div className="qa-chat-metabar"><TokenMeter />{commandNotice ? <span className="qa-command-progress" role="status">{commandNotice}</span> : <Activity execution={chat.execution} running={running}/>}</div>
      <div className="qa-agent-tabs" role="tablist" aria-label="QA agent views"><button role="tab" id="qa-tab-chat" aria-selected={tab==='chat'} aria-controls="qa-panel-chat" onClick={()=>setTab('chat')} onKeyDown={e=>{if(e.key==='ArrowRight'){setTab('findings');document.getElementById('qa-tab-findings')?.focus()}}}>Chat</button><button role="tab" id="qa-tab-findings" aria-selected={tab==='findings'} aria-controls="qa-panel-findings" onClick={()=>setTab('findings')} onKeyDown={e=>{if(e.key==='ArrowLeft'){setTab('chat');document.getElementById('qa-tab-chat')?.focus()}}}>Findings {!!organizer.snapshot?.findings.filter(item=>!item.mergedInto).length && <span>{organizer.snapshot.findings.filter(item=>!item.mergedInto).length}</span>}</button></div>
      {tab==='findings'&&<div id="qa-panel-findings" role="tabpanel" aria-labelledby="qa-tab-findings" className="qa-findings-panel"><AuditOrganizer {...organizer}/></div>}
      <div id="qa-panel-chat" role="tabpanel" aria-labelledby="qa-tab-chat" className="qa-chat-tab-panel" hidden={tab!=='chat'}>
      <ReviewTarget />

      <div
        className="qa-chat-body" ref={scroller}
        onScroll={(event) => { const el = event.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setShowLatest(!stuck.current) }}
      >
        {chat.messages.length === 0 && !running ? (
          <div className="qa-chat-empty">
            <h3>Ask about Parity</h3>
            <p>Search your workspace or review the open page.</p>
            <div className="qa-chat-suggestions">
              {SUGGESTIONS.map((suggestion) => <button key={suggestion.label} type="button" disabled={running} onClick={() => void submit(suggestion.send)}>{suggestion.label}</button>)}
            </div>
            <p className="qa-chat-hint">Use + for commands.</p>
          </div>
        ) : (() => {
          const groups: React.ReactNode[] = []
          for (let i = 0; i < chat.messages.length;) {
            const message = chat.messages[i]
            if (message.kind !== 'tool') { groups.push(<Message key={message.id} message={message} chatId={chat.chatId} openedAt={openedAt.current} progressed={replyProgress} command={text => void submit(text)} busy={busy}/>); i++; continue }
            const tools: Array<Extract<ChatMessage, {kind:'tool'}>> = []
            while (i < chat.messages.length && chat.messages[i].kind === 'tool') tools.push(chat.messages[i++] as Extract<ChatMessage, {kind:'tool'}>)
            groups.push(<details className="qa-tool-group" key={message.id}><summary>{tools.filter(tool => tool.pending).length ? 'Running' : 'Tool activity'} · {tools.length} tool{tools.length === 1 ? '' : 's'}{tools.some(tool => tool.isError) ? ' · failed step' : ''}</summary>{tools.map(tool => <Message key={tool.id} message={tool} chatId={chat.chatId} openedAt={openedAt.current} progressed={replyProgress} command={text => void submit(text)} busy={busy}/>)}</details>)
          }
          return groups
        })()}
        <ResponsePending running={chat.running || busy && !commandNotice} responding={chat.responding} switching={chat.switching} execution={chat.execution} toolsPending={chat.messages.some(message => message.kind === 'tool' && message.pending)}/>
      </div>

      {showLatest && <button type="button" className="qa-jump-latest" onClick={() => { stuck.current = true; setShowLatest(false); scroller.current?.scrollTo({top:scroller.current.scrollHeight}) }}>Jump to latest</button>}
      <ChatModelPicker/>
      <form className={`qa-chat-composer${dragging ? ' is-dragging' : ''}`} onSubmit={(event) => { event.preventDefault(); void submit(input) }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) } }} onDragLeave={event => { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX <= rect.left || event.clientX >= rect.right || event.clientY <= rect.top || event.clientY >= rect.bottom) setDragging(false) }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); void addImages([...event.dataTransfer.files]) } }}>
        {dragging && <span className="qa-composer-drop-label">Drop images to attach</span>}
        {!!attached.length && <div className="qa-composer-attachments"><ChatImages chatId={chat.chatId} images={attached} remove={id => { const draft = qaChat.getState().draft; qaChat.setDraft(draft.input, draft.tab, (draft.attachments || []).filter(image => image.id !== id)); setImageError('') }}/></div>}
        {addingImages && <small className="qa-composer-image-status" role="status">Adding images…</small>}
        {imageError && <p className="qa-composer-image-status" role="alert">{imageError}<button type="button" aria-label="Dismiss image error" onClick={() => setImageError('')}><ChatIcon name="close" size={12}/></button></p>}
        {commandsOpen && suggestions.length > 0 && <div className="qa-command-menu" role="listbox" id="qa-command-list" aria-label="Slash commands">{suggestions.map((item, index) => <button role="option" aria-selected={index === commandIndex} id={`qa-command-${index}`} type="button" key={item.value} onMouseDown={event => event.preventDefault()} onClick={() => { setInput(item.value); setCommandsOpen(false); field.current?.focus() }}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div>}
        <ComposerAdd adding={addingImages} opened={() => setCommandsOpen(false)} add={files => void addImages(files)} commands={() => { if (!input.startsWith('/')) setInput('/'); setCommandsOpen(true); field.current?.focus() }}/>
        <textarea
          ref={field} value={input} rows={1} spellCheck autoComplete="off"
          placeholder={chat.running ? 'Ask a follow-up…' : 'Ask about Parity…'}
          aria-label="Message the QA agent"
          onChange={(event) => { setInput(event.target.value); setCommandsOpen(event.target.value.startsWith('/')) }}
          onPaste={event => { const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void addImages(files) } }}
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
            else if (event.key === 'Escape' && (chat.running || commandNotice)) { event.preventDefault(); void window.electronAPI.qaRunStop() }
          }}
        />
        {chat.running || commandNotice
          ? <button type="button" className="qa-chat-send stop" onClick={() => void window.electronAPI.qaRunStop()} aria-label="Stop" title="Stop"><ChatIcon name="stop"/></button>
          : <button type="submit" className="qa-chat-send" disabled={(!input.trim() && !attached.length) || busy || addingImages} aria-label="Send" title="Send (Enter)"><ChatIcon name="send" size={18}/></button>}
      </form>
      </div>
    </section>
  )
}
