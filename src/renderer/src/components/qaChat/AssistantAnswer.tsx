import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../qaChatStore'
import RichText from './RichText'
import ChatIcon from './ChatIcon'
import { useTypedReply } from './useTypedReply'

export default function AssistantAnswer({ message, openedAt, progressed }: {
  message: Extract<ChatMessage, { kind: 'assistant' }>
  openedAt: number
  progressed: () => void
}) {
  const text = useTypedReply(message.text, (message.receivedAt || 0) >= openedAt)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<number>()
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) window.clearTimeout(timer.current) } }, [])
  useLayoutEffect(progressed, [text, progressed])
  const copyAnswer = async () => {
    try { await navigator.clipboard.writeText(message.text); if (!alive.current) return; setCopy('copied') }
    catch { if (!alive.current) return; setCopy('error') }
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopy('idle'), 1500)
  }
  const label = copy === 'copied' ? 'Answer copied' : copy === 'error' ? 'Copy failed. Try again' : 'Copy answer'
  return <div className="qa-chat-msg assistant"><div className="qa-chat-text" aria-busy={text !== message.text}>
    <div className="qa-answer-content"><RichText text={text}/></div>
    <button className="qa-answer-copy" type="button" aria-label={label} title={label} onClick={() => void copyAnswer()}><ChatIcon name={copy === 'copied' ? 'check' : 'copy'} size={14}/></button>
  </div></div>
}
