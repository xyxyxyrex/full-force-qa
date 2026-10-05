import { useEffect, useMemo, useState } from 'react'
import type { ApprovalRequest } from '../../../shared/qaAgent'
import { rowView, type TrackerFormat } from '../../../shared/trackerFormat'
import './QaApprovalCard.css'

interface Props {
  request: ApprovalRequest
  onDecide: (approved: boolean, note?: string) => void
}

const severityClass = (value: string) => (/high|critical|major|urgent|p1/i.test(value) ? 'high' : /med/i.test(value) ? 'medium' : /low|minor|p3/i.test(value) ? 'low' : 'other')

function shortLink(link: string): string {
  try { const url = new URL(link); return `${url.pathname}${url.search}` || url.host } catch { return link }
}

/** Shown when an agent hands over rows: nothing is copied or uploaded until the person approves. */
export default function QaApprovalCard({ request, onDecide }: Props) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [zoomed, setZoomed] = useState<{ src: string; caption: string } | null>(null)
  const decide = (approved: boolean) => {
    if (busy) return
    setBusy(true)
    onDecide(approved, approved ? undefined : note.trim() || undefined)
  }
  useEffect(() => {
    if (!zoomed) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setZoomed(null) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoomed])

  const format = useMemo<TrackerFormat>(() => ({ version: 1, columns: request.columns, examples: [] }), [request.columns])
  const views = useMemo(() => request.rows.map((row) => rowView(format, row)), [format, request.rows])
  const evidence = useMemo(() => new Map(request.evidence.map((item) => [item.rowIndex, item])), [request.evidence])
  const severities = Object.entries(request.severityCounts)
  const rowCount = request.rows.length
  let page = request.pageUrl
  try { page = new URL(request.pageUrl).pathname || request.pageUrl } catch { /* show as given */ }

  return (
    <div className="qa-approval-backdrop" role="dialog" aria-modal="true" aria-labelledby="qa-approval-title">
      <div className="qa-approval">
        <header>
          <div>
            <span className="qa-approval-eyebrow">QA agent · {request.projectName}</span>
            <h2 id="qa-approval-title">Copy {rowCount} finding{rowCount === 1 ? '' : 's'} for the tracker?</h2>
            <small>{page}</small>
          </div>
          <div className="qa-approval-view" role="group" aria-label="View">
            <button type="button" className={!sheet ? 'active' : ''} aria-pressed={!sheet} onClick={() => setSheet(false)}>Findings</button>
            <button type="button" className={sheet ? 'active' : ''} aria-pressed={sheet} onClick={() => setSheet(true)}>Sheet rows</button>
          </div>
        </header>

        {(severities.length > 0 || request.warnings.length > 0) && (
          <div className="qa-approval-notes">
            {severities.length > 0 && <div className="qa-approval-chips">{severities.map(([name, count]) => <span key={name} className={`sev-${severityClass(name)}`}>{count} {name}</span>)}</div>}
            {request.warnings.map((warning, index) => <p key={index} className="qa-approval-warning">{warning}</p>)}
          </div>
        )}

        {sheet ? (
          <div className="qa-approval-table-wrap">
            <table>
              <thead><tr><th>#</th>{request.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>{request.rows.map((row, rowIndex) => (
                <tr key={rowIndex}><td>{rowIndex + 1}</td>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
          <ol className="qa-findings">
            {views.map((view, index) => {
              const shot = evidence.get(index)
              return (
                <li key={index} className="qa-finding">
                  <div className="qa-finding-head">
                    <span className="qa-finding-number">{index + 1}</span>
                    <strong className="qa-finding-title">{view.title || `Finding ${index + 1}`}</strong>
                    {view.badges.map((badge) => <span key={badge.label} className={`qa-badge ${badge.kind === 'severity' ? `sev-${severityClass(badge.value)}` : 'display'}`} title={badge.label}>{badge.value}</span>)}
                  </div>
                  {view.body && view.body !== view.title && <p className="qa-finding-body">{view.body}</p>}
                  {view.link && <small className="qa-finding-link" title={view.link}>{shortLink(view.link)}</small>}
                  {view.extras.length > 0 && <dl className="qa-finding-extras">{view.extras.map((extra) => <div key={extra.label}><dt>{extra.label}</dt><dd>{extra.value}</dd></div>)}</dl>}
                  {shot ? (
                    <figure className="qa-finding-shot">
                      <button type="button" onClick={() => setZoomed({ src: shot.thumbnail, caption: shot.caption })} aria-label={`Enlarge the picture for finding ${index + 1}`}>
                        <img src={shot.thumbnail} alt={`Design and live page for finding ${index + 1}`} />
                      </button>
                      <figcaption>{shot.caption || 'Design (left) and live page (right)'} · click to enlarge</figcaption>
                    </figure>
                  ) : <p className="qa-finding-noshot">No picture for this finding.</p>}
                </li>
              )
            })}
          </ol>
        )}

        <p className="qa-approval-effect">
          {request.uploadsEvidence
            ? 'Approving uploads the pictures (their links go in the screenshot column) and copies the rows. Paste them into the sheet.'
            : 'Approving copies the rows to your clipboard. Paste them into the sheet.'}
        </p>

        <footer>
          <label className="qa-approval-note">
            <span className="sr-only">If you reject, tell the agent what to change (optional)</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={1} maxLength={500} aria-label="Note to the agent if you reject" placeholder="If you reject: tell the agent what to change (optional), e.g. Finding 3 is not a real issue" />
          </label>
          <button type="button" className="qa-approval-secondary" onClick={() => decide(false)} disabled={busy}>Reject</button>
          <button type="button" className="qa-approval-primary" onClick={() => decide(true)} disabled={busy}>Approve &amp; copy</button>
        </footer>
      </div>

      {zoomed && (
        <div className="qa-lightbox" role="dialog" aria-label="Enlarged picture" onClick={() => setZoomed(null)}>
          <img src={zoomed.src} alt={zoomed.caption || 'Enlarged picture'} />
          <span>{zoomed.caption} · click or press Esc to close</span>
        </div>
      )}
    </div>
  )
}
