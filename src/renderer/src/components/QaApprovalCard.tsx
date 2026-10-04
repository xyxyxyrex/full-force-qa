import { useState } from 'react'
import type { ApprovalRequest } from '../../../shared/qaAgent'
import './QaApprovalCard.css'

interface Props {
  request: ApprovalRequest
  onDecide: (approved: boolean, note?: string) => void
}

/** Shown when an agent hands over rows: nothing is copied or uploaded until the person approves. */
export default function QaApprovalCard({ request, onDecide }: Props) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const decide = (approved: boolean) => {
    if (busy) return
    setBusy(true)
    onDecide(approved, approved ? undefined : note.trim() || undefined)
  }
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
            <h2 id="qa-approval-title">Copy {rowCount} row{rowCount === 1 ? '' : 's'} for the tracker?</h2>
            <small>{page}</small>
          </div>
        </header>

        {(severities.length > 0 || request.warnings.length > 0) && (
          <div className="qa-approval-notes">
            {severities.length > 0 && <div className="qa-approval-chips">{severities.map(([name, count]) => <span key={name}>{count} {name}</span>)}</div>}
            {request.warnings.map((warning, index) => <p key={index} className="qa-approval-warning">{warning}</p>)}
          </div>
        )}

        <div className="qa-approval-table-wrap">
          <table>
            <thead><tr><th>#</th>{request.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{request.rows.map((row, rowIndex) => (
              <tr key={rowIndex}><td>{rowIndex + 1}</td>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>

        {request.evidence.length > 0 && (
          <div className="qa-approval-evidence" aria-label="Evidence images">
            {request.evidence.map((item) => (
              <figure key={item.rowIndex}>
                <img src={item.thumbnail} alt={`Evidence for row ${item.rowIndex + 1}`} />
                <figcaption>Row {item.rowIndex + 1}</figcaption>
              </figure>
            ))}
          </div>
        )}

        <p className="qa-approval-effect">
          {request.uploadsEvidence
            ? 'Approving uploads the evidence images (their links go in the screenshot column) and copies the rows. Paste them into the sheet.'
            : 'Approving copies the rows to your clipboard. Paste them into the sheet.'}
        </p>

        <label className="qa-approval-note">
          <span>If you reject, tell the agent what to change (optional)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} placeholder="e.g. Row 3 is not a real issue; the design uses the same colour." />
        </label>

        <footer>
          <button type="button" className="qa-approval-secondary" onClick={() => decide(false)} disabled={busy}>Reject</button>
          <button type="button" className="qa-approval-primary" onClick={() => decide(true)} disabled={busy}>Approve &amp; copy</button>
        </footer>
      </div>
    </div>
  )
}
