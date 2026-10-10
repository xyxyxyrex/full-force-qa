import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseWorkspaceLink } from '../../../../shared/parityWorkspace'
export function safeChatLink(href: string | undefined) {
  try { const url = new URL(href || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : null } catch { return null }
}
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return <div className="qa-code-block"><button type="button" onClick={event => {
    const text = event.currentTarget.parentElement?.querySelector('pre')?.textContent || ''
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }}>{copied ? 'Copied' : 'Copy code'}</button><pre>{children}</pre></div>
}
export default function RichText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url=>safeChatLink(url)||(parseWorkspaceLink(url)?url:'')} components={{
    a: ({ href, children }) => { const target=href&&parseWorkspaceLink(href);if(target)return <button className="qa-source-link" type="button" onClick={()=>void window.electronAPI.workspaceOpen(target).catch(()=>{})}>{children}</button>;const safe = safeChatLink(href); return safe ? <a href={safe} onClick={event => { event.preventDefault(); void window.electronAPI.openExternal(safe) }}>{children}</a> : <span>{children}</span> },
    img: ({ alt }) => <span className="qa-chat-image-note">{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="qa-markdown-table"><table>{children}</table></div>,
  }}>{text}</Markdown>
}
