import { Fragment, useMemo, useState } from 'react'
import type { ApprovalRequest } from '../../../shared/qaAgent'
import { rowView, type TrackerFormat } from '../../../shared/trackerFormat'
import { FindingCard, PageHeading, PictureLightbox, shortLink, type FindingPicture } from './QaFindings'
import './QaApprovalCard.css'

interface Props {
  request: ApprovalRequest
  onDecide: (approved: boolean, note?: string, excludedRows?: number[]) => void
}

/** Shown when an agent hands over rows: nothing is copied or uploaded until the person approves. */
export default function QaApprovalCard({ request, onDecide }: Props) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [zoomed, setZoomed] = useState<FindingPicture | null>(null)
  // Findings the person left out: they are neither copied nor uploaded.
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set())
  const toggle = (index: number) => setExcluded((current) => {
    const next = new Set(current)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })

  const rowCount = request.rows.length
  const keptCount = rowCount - excluded.size
  const decide = (approved: boolean) => {
    if (busy || (approved && keptCount === 0)) return
    setBusy(true)
    onDecide(approved, approved ? undefined : note.trim() || undefined, approved && excluded.size ? [...excluded].sort((a, b) => a - b) : undefined)
  }

  const format = useMemo<TrackerFormat>(() => ({ version: 1, columns: request.columns, examples: [] }), [request.columns])
  const views = useMemo(() => request.rows.map((row) => rowView(format, row)), [format, request.rows])
  const evidence = useMemo(() => new Map(request.evidence.map((item) => [item.rowIndex, item])), [request.evidence])
  const severities = Object.entries(request.severityCounts)
  // Findings from several pages are shown under a heading per page.
  const pageCount = new Set((request.rowPages ?? []).map((page) => page.url)).size
  const page = shortLink(request.pageUrl)
  const countLabel = excluded.size ? `${keptCount} of ${rowCount} findings` : `${rowCount} finding${rowCount === 1 ? '' : 's'}`

  return (
    <div className="qa-approval-backdrop" role="dialog" aria-modal="true" aria-labelledby="qa-approval-title">
      <div className="qa-approval">
        <header>
          <div>
            <span className="qa-approval-eyebrow">QA agent · {request.projectName}</span>
            <h2 id="qa-approval-title">Copy {countLabel}{pageCount > 1 ? ` from ${pageCount} pages` : ''} for the tracker?</h2>
            <small>{pageCount > 1 ? 'Several pages, grouped below' : page}{excluded.size ? ` · ${excluded.size} left out` : ''}</small>
          </div>
          <div className="qa-approval-view" role="group" aria-label="View">
            <button type="button" className={!sheet ? 'active' : ''} aria-pressed={!sheet} onClick={() => setSheet(false)}>Findings</button>
            <button type="button" className={sheet ? 'active' : ''} aria-pressed={sheet} onClick={() => setSheet(true)}>Sheet rows</button>
          </div>
        </header>

        {(severities.length > 0 || request.warnings.length > 0) && (
          <div className="qa-approval-notes">
            {severities.length > 0 && <div className="qa-approval-chips">{severities.map(([name, count]) => <span key={name}>{count} {name}</span>)}</div>}
            {request.warnings.map((warning, index) => <p key={index} className="qa-approval-warning">{warning}</p>)}
          </div>
        )}

        {sheet ? (
          <div className="qa-approval-table-wrap">
            <table>
              <thead><tr><th>#</th>{request.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>{request.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={excluded.has(rowIndex) ? 'excluded' : ''}><td>{rowIndex + 1}</td>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
          <ol className="qa-findings">
            {views.map((view, index) => {
              const shot = evidence.get(index)
              const rowPage = request.rowPages?.[index]
              const startsPage = pageCount > 1 && !!rowPage && rowPage.url !== request.rowPages?.[index - 1]?.url
              return (
                <Fragment key={index}>
                  {startsPage && rowPage && <PageHeading name={rowPage.name} url={rowPage.url} count={request.rowPages!.filter((other) => other.url === rowPage.url).length} />}
                  <FindingCard
                    index={index} view={view}
                    picture={shot ? { src: shot.thumbnail, caption: shot.caption } : null}
                    excluded={excluded.has(index)} onToggleExcluded={() => toggle(index)} onZoom={setZoomed}
                  />
                </Fragment>
              )
            })}
          </ol>
        )}

        <p className="qa-approval-effect">
          {keptCount === 0
            ? 'Every finding is left out. Put one back, or reject.'
            : request.action==='share' ? request.uploadsEvidence ? 'Approving uploads the selected evidence and adds its links to your saved findings.' : 'Uploads are unavailable. The evidence stays saved locally.' : request.uploadsEvidence
              ? 'Approving uploads the pictures (their links go in the screenshot column) and copies the rows. Paste them into the sheet.'
              : 'Approving copies the rows to your clipboard. Paste them into the sheet.'}
        </p>

        <footer>
          <label className="qa-approval-note">
            <span className="sr-only">If you reject, tell the agent what to change (optional)</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={1} maxLength={500} aria-label="Note to the agent if you reject" placeholder="If you reject: tell the agent what to change (optional), e.g. Finding 3 is not a real issue" />
          </label>
          <button type="button" className="qa-approval-secondary" onClick={() => decide(false)} disabled={busy}>Reject</button>
          <button type="button" className="qa-approval-primary" onClick={() => decide(true)} disabled={busy || keptCount === 0}>{request.action==='share'?'Approve & share':excluded.size ? `Approve & copy ${keptCount}` : 'Approve & copy'}</button>
        </footer>
      </div>

      <PictureLightbox picture={zoomed} onClose={() => setZoomed(null)} />
    </div>
  )
}
