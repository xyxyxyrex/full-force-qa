import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QaChatListItem, QaHandOverRecord, QaHistoryPicture, QaRunDetail, QaRunListItem } from '../../../shared/qaAgent'
import { rowView, type RowView, type TrackerFormat } from '../../../shared/trackerFormat'
import { FindingCard, PageHeading, PictureLightbox, shortLink, type FindingPicture } from './QaFindings'
import { qaChat, useQaChat } from './qaChatStore'
import './QaHistory.css'

// Past reviews and past chats. Reviews show every run: what was handed over (approved, rejected or
// left undecided) and what the agent drafted, each finding with its screenshot.

export type HistoryTab = 'reviews' | 'chats'

const when = (time: number) => new Date(time).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** A finding whose picture is fetched once it scrolls into view, so a long run does not load everything at once. */
function LazyFinding({ runId, pictureRef, index, view, link, excluded, onZoom, scroller }: {
  runId: string
  pictureRef: QaHistoryPicture | null
  index: number
  view: RowView
  link?: string
  excluded?: boolean
  onZoom: (picture: FindingPicture) => void
  scroller: HTMLElement | null
}) {
  const holder = useRef<HTMLLIElement>(null)
  const [picture, setPicture] = useState<FindingPicture | 'loading' | null>(pictureRef ? 'loading' : null)
  useEffect(() => {
    if (!pictureRef || !holder.current) return
    let cancelled = false
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      void window.electronAPI.qaHistoryPicture(runId, pictureRef).then((src) => {
        if (!cancelled) setPicture(src ? { src, caption: view.title } : null)
      }).catch(() => { if (!cancelled) setPicture(null) })
    }, { root: scroller, rootMargin: '400px' })
    observer.observe(holder.current)
    return () => { cancelled = true; observer.disconnect() }
  }, [runId, pictureRef, scroller, view.title])
  return (
    <FindingCard cardRef={holder} index={index} view={view} picture={picture} link={link} excluded={excluded} onZoom={onZoom} />
  )
}

function HandOverSection({ runId, record, onZoom, scroller, onCopied }: { runId: string; record: QaHandOverRecord; onZoom: (picture: FindingPicture) => void; scroller: HTMLElement | null; onCopied: (message: string) => void }) {
  const format = useMemo<TrackerFormat>(() => ({ version: 1, columns: record.columns, examples: [] }), [record.columns])
  const evidence = useMemo(() => new Map(record.evidence.map((item) => [item.rowIndex, item.file])), [record.evidence])
  const excluded = new Set(record.excludedRows ?? [])
  const pageCount = new Set((record.rowPages ?? []).map((page) => page.url)).size
  const status = record.status === 'approved'
    ? `Approved · ${plural(record.copiedRows ?? record.rows.length, 'row')} copied${excluded.size ? ` · ${excluded.size} left out` : ''}`
    : record.status === 'rejected' ? `Rejected${record.note ? `: “${record.note}”` : ''}` : 'Not decided (Parity was closed or the request timed out)'
  const copy = async () => {
    const count = await window.electronAPI.qaHistoryCopy(runId, record.stamp)
    onCopied(count ? `Copied ${plural(count, 'row')} to the clipboard, exactly as before. Paste them into the sheet.` : 'Those rows could not be copied.')
  }
  return (
    <section className="qa-history-section">
      <header>
        <div>
          <strong className={`qa-history-status ${record.status}`}>{status}</strong>
          <small>{when(record.createdAt)} · {plural(record.rows.length, 'finding')}{pageCount > 1 ? ` from ${pageCount} pages` : ''}</small>
        </div>
        {record.status === 'approved' && (record.copiedRows ?? record.rows.length) > 0 && <button type="button" onClick={() => void copy()}>Copy rows again</button>}
      </header>
      <ol className="qa-findings qa-history-list">
        {record.rows.map((row, index) => {
          const page = record.rowPages?.[index]
          const startsPage = pageCount > 1 && !!page && page.url !== record.rowPages?.[index - 1]?.url
          const file = evidence.get(index)
          return (
            <Fragment key={index}>
              {startsPage && page && <PageHeading name={page.name} url={page.url} count={record.rowPages!.filter((other) => other.url === page.url).length} />}
              <LazyFinding runId={runId} index={index} view={rowView(format, row)} pictureRef={file ? { kind: 'handover', file } : null} link={record.links?.[String(index)]} excluded={excluded.has(index)} onZoom={onZoom} scroller={scroller} />
            </Fragment>
          )
        })}
      </ol>
    </section>
  )
}

function ReviewDetail({ runId, onChanged, onDeleted }: { runId: string; onChanged: () => void; onDeleted: () => void }) {
  const [detail, setDetail] = useState<QaRunDetail | null | undefined>(undefined)
  const [zoomed, setZoomed] = useState<FindingPicture | null>(null)
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const load = useCallback(() => { void window.electronAPI.qaHistoryDetail(runId).then(setDetail).catch(() => setDetail(null)) }, [runId])
  useEffect(() => { setDetail(undefined); setConfirmDelete(false); setNotice(''); load() }, [load])
  const draftFormat = useMemo<TrackerFormat | null>(() => (detail ? { version: 1, columns: detail.columns, examples: [] } : null), [detail])

  if (detail === undefined) return <div className="qa-history-empty">Loading…</div>
  if (!detail) return <div className="qa-history-empty">This run is no longer on this computer.</div>
  const { run } = detail
  const pin = async () => { await window.electronAPI.qaHistoryPin(run.id, !run.pinned); load(); onChanged() }
  const remove = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (await window.electronAPI.qaHistoryDelete(run.id)) onDeleted()
    else setNotice('The run could not be deleted (the agent may still be working).')
  }
  return (
    <div className="qa-history-detail" ref={setScroller}>
      <header className="qa-history-detail-head">
        <div>
          <h3>{run.projectName}</h3>
          <small title={run.pageUrl}>{shortLink(run.pageUrl)} · {when(run.createdAt)}{run.breakpoints.length ? ` · ${run.breakpoints.join(', ')}` : ''}</small>
        </div>
        <div className="qa-history-actions">
          <button type="button" onClick={() => void window.electronAPI.qaHistoryOpenFolder(run.id)}>Open folder</button>
          <button type="button" className={run.pinned ? 'active' : ''} aria-pressed={run.pinned} onClick={() => void pin()} title={run.pinned ? 'Kept: the automatic clean-up leaves it alone' : 'Keep this run: the automatic clean-up (after 14 days) leaves it alone'}>{run.pinned ? 'Kept' : 'Keep'}</button>
          <button type="button" className="danger" onClick={() => void remove()}>{confirmDelete ? 'Delete for good?' : 'Delete'}</button>
        </div>
      </header>
      {notice && <p className="qa-history-notice" role="status">{notice}</p>}
      {!run.pinned && <p className="qa-history-hint">Runs are removed automatically after 14 days. Press Keep to hold on to this one.</p>}
      {detail.handovers.map((record) => <HandOverSection key={record.stamp} runId={run.id} record={record} onZoom={setZoomed} scroller={scroller} onCopied={setNotice} />)}
      {detail.drafts.length > 0 && (
        <section className="qa-history-section">
          <header><div><strong className="qa-history-status draft">Drafted by the agent</strong><small>Findings as the agent saved them for each size, before any hand-over: from looking at the page, then from testing it.</small></div></header>
          {detail.drafts.map((group) => (
            <Fragment key={`${group.area ?? 'visual'}-${group.breakpoint}`}>
              <h4 className="qa-history-breakpoint">{group.breakpoint[0].toUpperCase() + group.breakpoint.slice(1)}{group.area === 'functional' ? ' · testing links, buttons and forms' : ''} · {plural(group.rows.length, 'finding')}</h4>
              <ol className="qa-findings qa-history-list">
                {group.rows.map((row, index) => <LazyFinding key={index} runId={run.id} index={index} view={rowView(draftFormat!, row.cells)} pictureRef={row.hasPicture ? { kind: 'draft', breakpoint: group.breakpoint, index, ...(group.area ? { area: group.area } : {}) } : null} onZoom={setZoomed} scroller={scroller} />)}
              </ol>
            </Fragment>
          ))}
        </section>
      )}
      {!detail.handovers.length && !detail.drafts.length && <div className="qa-history-empty">The agent did not write any findings in this run.</div>}
      <PictureLightbox picture={zoomed} onClose={() => setZoomed(null)} />
    </div>
  )
}

function Reviews() {
  const [runs, setRuns] = useState<QaRunListItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const load = useCallback(() => {
    void window.electronAPI.qaHistoryList().then((list) => {
      setRuns(list)
      setSelected((current) => (current && list.some((run) => run.id === current) ? current : list[0]?.id ?? null))
    }).catch(() => setRuns([]))
  }, [])
  useEffect(load, [load])
  const shown = (runs ?? []).filter((run) => !query.trim() || `${run.projectName} ${run.pageUrl}`.toLowerCase().includes(query.trim().toLowerCase()))
  if (runs === null) return <div className="qa-history-empty">Loading…</div>
  if (!runs.length) return <div className="qa-history-empty">No reviews yet. Runs appear here as soon as the agent captures a page.</div>
  return (
    <div className="qa-history-split">
      <aside className="qa-history-runs">
        <input type="search" placeholder="Filter by page or project" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter reviews" />
        <ul>
          {shown.map((run) => {
            const approved = run.handovers.filter((item) => item.status === 'approved').reduce((sum, item) => sum + (item.copied ?? item.rows), 0)
            return (
              <li key={run.id}>
                <button type="button" className={run.id === selected ? 'active' : ''} onClick={() => setSelected(run.id)}>
                  <span className="qa-history-run-title">{run.projectName}{run.pinned ? <span className="qa-history-kept" title="Kept"> · kept</span> : null}</span>
                  <span className="qa-history-run-page" title={run.pageUrl}>{shortLink(run.pageUrl)}</span>
                  <span className="qa-history-run-meta">
                    {when(run.createdAt)}
                    {approved > 0 && <i className="ok">{approved} copied</i>}
                    {run.handovers.some((item) => item.status === 'rejected') && <i className="bad">rejected</i>}
                    {run.drafted > 0 && <i>{run.drafted} drafted</i>}
                    {!approved && !run.drafted && !run.handovers.length && <i>no findings</i>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>
      {selected ? <ReviewDetail key={selected} runId={selected} onChanged={load} onDeleted={() => { setSelected(null); load() }} /> : <div className="qa-history-empty">Pick a run.</div>}
    </div>
  )
}

function Chats({ onOpened }: { onOpened: () => void }) {
  const [chats, setChats] = useState<QaChatListItem[] | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const running = useQaChat().running
  const current = useQaChat().chatId
  const load = useCallback(() => { void window.electronAPI.qaChatsList().then(setChats).catch(() => setChats([])) }, [])
  useEffect(load, [load])
  const open = async (id: string) => {
    const chat = await window.electronAPI.qaChatsOpen(id)
    if (!chat) { setNotice('That chat could not be opened (the agent may still be working).'); return }
    qaChat.restore(chat)
    window.dispatchEvent(new Event('parity:open-qa-chat'))
    onOpened()
  }
  const remove = async (id: string) => {
    if (confirm !== id) { setConfirm(id); return }
    await window.electronAPI.qaChatsDelete(id)
    if (id === current) qaChat.clear()
    setConfirm(null)
    load()
  }
  if (chats === null) return <div className="qa-history-empty">Loading…</div>
  if (!chats.length) return <div className="qa-history-empty">No saved chats yet. Chats are saved as you talk to the agent.</div>
  return (
    <div className="qa-history-chats">
      {notice && <p className="qa-history-notice" role="status">{notice}</p>}
      {running && <p className="qa-history-hint">The agent is working; open another chat when it is done.</p>}
      <ul>
        {chats.map((chat) => (
          <li key={chat.id} className={chat.id === current ? 'current' : ''}>
            <div>
              <strong>{chat.title}</strong>
              <small>{when(chat.updatedAt)} · {plural(chat.messageCount, 'message')}{chat.tokens ? ` · ${chat.tokens.toLocaleString()} tokens` : ''}{chat.id === current ? ' · open now' : ''}</small>
            </div>
            <button type="button" onClick={() => void open(chat.id)} disabled={running}>Open</button>
            <button type="button" className="danger" onClick={() => void remove(chat.id)}>{confirm === chat.id ? 'Delete for good?' : 'Delete'}</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function QaHistory({ initialTab, onClose }: { initialTab: HistoryTab; onClose: () => void }) {
  const [tab, setTab] = useState<HistoryTab>(initialTab)
  useEffect(() => setTab(initialTab), [initialTab])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('.qa-lightbox')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="qa-history-backdrop" role="dialog" aria-modal="true" aria-label="QA history" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="qa-history">
        <header className="qa-history-head">
          <div className="qa-history-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'reviews'} className={tab === 'reviews' ? 'active' : ''} onClick={() => setTab('reviews')}>Past reviews</button>
            <button type="button" role="tab" aria-selected={tab === 'chats'} className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>Chats</button>
          </div>
          <button type="button" className="qa-history-close" onClick={onClose} aria-label="Close history">×</button>
        </header>
        {tab === 'reviews' ? <Reviews /> : <Chats onOpened={onClose} />}
      </div>
    </div>
  )
}
