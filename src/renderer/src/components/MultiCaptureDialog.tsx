import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import type { Project } from '../../../shared/types'
import type { Breakpoint } from '../../../shared/designScale'
import { QA_BATCH_MAX_PAGES } from '../../../shared/qaAgent'
import {
  deriveMultiCaptureName,
  findMultiCaptureDuplicate,
  normalizeMultiCaptureUrl,
  parseMultiCaptureInput,
  runMultiCaptureQueue,
} from '../utils/multiCapture'
import { createMultiCaptureRow, useMultiCaptureRows } from './useMultiCaptureRows'
import './MultiCaptureDialog.css'

interface Props {
  destinationId?: string
  destinationPath: string
  destinationExists: boolean
  existingProjects: Project[]
  ownerAtOpen: string | null
  onSaveProject: (project: Project, expectedOwner: string | null) => Promise<void>
  onProjectsChanged: () => void
  onClose: () => void
}

export default function MultiCaptureDialog({
  destinationId,
  destinationPath,
  destinationExists,
  existingProjects,
  ownerAtOpen,
  onSaveProject,
  onProjectsChanged,
  onClose,
}: Props) {
  const [bulkInput, setBulkInput] = useState('')
  const { rows, setRows, focusRowId, clearFocusRow, updateRow, appendParsed: appendParsedRows, addBlankRow } = useMultiCaptureRows()
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [saving, setSaving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [message, setMessage] = useState('')
  const [reviewOn, setReviewOn] = useState<Record<Breakpoint, boolean>>({ desktop: true, tablet: false, mobile: true })
  // After looking at each page, the agent also tests its links, buttons, menus and forms. Starts from the setting.
  const [testPages, setTestPages] = useState(true)
  const testTouched = useRef(false)
  useEffect(() => {
    void window.electronAPI.qaAgentsSettings().then(settings => { if (settings && !testTouched.current) setTestPages(settings.functionalChecks) }).catch(() => {})
  }, [])
  const [starting, setStarting] = useState(false)
  const [summary, setSummary] = useState<{ added: number; skipped: number; failed: number; stopped: number } | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef(false)
  const destinationExistsRef = useRef(destinationExists)
  destinationExistsRef.current = destinationExists

  const appendParsed = (input: string, replaceRowId?: string) => {
    if (!appendParsedRows(input, replaceRowId)) return
    setBulkInput('')
    setMessage('')
    setSummary(null)
  }

  useEffect(() => {
    const id = focusRowId
    if (!id) return
    clearFocusRow()
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLInputElement>(`[data-row-url="${id}"]`)?.focus())
  }, [clearFocusRow, focusRowId])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.querySelector<HTMLElement>('#multi-capture-paste')?.focus()
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, saving])

  const assessed = useMemo(() => rows.map((row, index) => {
    const validation = row.parseError ? { url: null, error: row.parseError } : normalizeMultiCaptureUrl(row.url)
    const duplicate = validation.url
      ? findMultiCaptureDuplicate(validation.url, index, rows.map(item => item.url), existingProjects.map(project => ({ url: project.stagingUrl, folderId: project.folderId, inTrash: project.inTrash })), destinationId)
      : null
    return { row, normalizedUrl: validation.url, error: validation.error, duplicate }
  }), [destinationId, existingProjects, rows])

  const nonEmpty = assessed.filter(item => item.row.url.trim())
  const invalidCount = nonEmpty.filter(item => !item.normalizedUrl).length
  const duplicateCount = skipDuplicates ? nonEmpty.filter(item => item.duplicate).length : 0
  const addableCount = nonEmpty.filter(item => item.normalizedUrl && (!skipDuplicates || !item.duplicate) && item.row.status !== 'saved').length

  const pasteIntoRow = (event: ClipboardEvent<HTMLInputElement>, rowId: string) => {
    const text = event.clipboardData.getData('text/plain')
    const parsed = parseMultiCaptureInput(text)
    if (parsed.length <= 1 && !parsed[0]?.error) return
    event.preventDefault()
    appendParsed(text, rowId)
  }

  /** Adds the ready rows as projects. Resolves false if it did not go through (stopped, folder gone, account changed). */
  const saveRows = async (): Promise<boolean> => {
    if (saving || invalidCount || !addableCount) return false
    if (!destinationExists) { setMessage('The destination folder no longer exists. Close this dialog and choose another location.'); return false }
    if (localStorage.getItem('parity_account_owner_key') !== ownerAtOpen) { setMessage('The active account changed. Close this dialog and try again.'); return false }

    const eligible = assessed.filter(item => item.normalizedUrl && (!skipDuplicates || !item.duplicate) && item.row.status !== 'saved')
    const skippedIds = new Set(skipDuplicates ? assessed.filter(item => item.duplicate && item.row.status !== 'saved').map(item => item.row.id) : [])
    if (skippedIds.size) setRows(current => current.map(row => skippedIds.has(row.id) ? { ...row, status: 'skipped', saveError: undefined } : row))

    stopRef.current = false
    setSaving(true)
    setStopping(false)
    setSummary(null)
    setMessage('')
    let added = 0
    let failed = 0
    const previouslyAdded = rows.filter(row => row.status === 'saved').length

    await runMultiCaptureQueue(eligible, async item => {
      if (!destinationExistsRef.current) {
        stopRef.current = true
        updateRow(item.row.id, { status: 'stopped', saveError: 'The destination folder no longer exists.' })
        return
      }
      if (localStorage.getItem('parity_account_owner_key') !== ownerAtOpen) {
        stopRef.current = true
        updateRow(item.row.id, { status: 'stopped', saveError: 'The active account changed.' })
        return
      }
      updateRow(item.row.id, { status: 'saving', saveError: undefined })
      const now = Date.now()
      const project: Project = {
        id: item.row.projectId,
        name: item.row.name.trim() || deriveMultiCaptureName(item.normalizedUrl!),
        adminUrl: '',
        stagingUrl: item.normalizedUrl!,
        folderId: destinationId,
        createdAt: now,
        lastOpenedAt: now,
      }
      try {
        await onSaveProject(project, ownerAtOpen)
        added += 1
        updateRow(item.row.id, { status: 'saved', saveError: undefined })
      } catch (error) {
        failed += 1
        updateRow(item.row.id, { status: 'failed', saveError: error instanceof Error ? error.message : 'Could not save this project.' })
      }
    }, () => stopRef.current, 3)

    const stoppedIds = new Set(eligible.filter(item => !['saved', 'failed'].includes(item.row.status)).map(item => item.row.id))
    if (stopRef.current) {
      setRows(current => current.map(row => stoppedIds.has(row.id) && !['saved', 'failed'].includes(row.status) ? { ...row, status: 'stopped' } : row))
    }
    if (added) onProjectsChanged()
    setSummary({ added: previouslyAdded + added, skipped: skippedIds.size, failed, stopped: stopRef.current ? Math.max(0, eligible.length - added - failed) : 0 })
    setSaving(false)
    setStopping(false)
    return !stopRef.current
  }

  // Every valid link in the list is a page to review, whether it was just saved, saved earlier or was a duplicate of a project that already exists.
  const reviewPages = nonEmpty.filter(item => item.normalizedUrl && !item.error).map(item => ({ url: item.normalizedUrl!, name: item.row.name.trim() || deriveMultiCaptureName(item.normalizedUrl!), projectId: item.row.projectId }))
  const chosenBreakpoints = (Object.keys(reviewOn) as Breakpoint[]).filter(breakpoint => reviewOn[breakpoint])
  const tooManyPages = reviewPages.length > QA_BATCH_MAX_PAGES
  const canReview = !saving && !starting && invalidCount === 0 && reviewPages.length > 0 && !tooManyPages && chosenBreakpoints.length > 0

  // Saves the new links as projects (as the primary button does), then has the QA agent review every page on its own.
  const saveAndReview = async () => {
    if (!canReview) return
    setStarting(true)
    setMessage('')
    try {
      if (addableCount > 0 && !(await saveRows())) return
      const result = await window.electronAPI.qaBatchStart({ pages: reviewPages, breakpoints: chosenBreakpoints, functional: testPages })
      if (!result.started) { setMessage(result.error); return }
      window.dispatchEvent(new Event('parity:open-qa-chat'))
      onClose()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The review could not be started.')
    } finally {
      setStarting(false)
    }
  }

  const stopAdding = () => {
    stopRef.current = true
    setStopping(true)
  }

  return <div className="multi-capture-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <div className="multi-capture-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="multi-capture-title">
      <header className="multi-capture-header">
        <div className="multi-capture-heading">
          <span className="multi-capture-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="3" y="13" width="8" height="7" rx="1.5"/><path d="M17 14v6m-3-3h6"/></svg></span>
          <div><h2 id="multi-capture-title">Multi-capture</h2><p>Save projects now. Pages are captured when opened.</p></div>
        </div>
        <button type="button" className="multi-capture-close" onClick={onClose} disabled={saving} aria-label="Close Multi-capture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header>

      <div className="multi-capture-destination"><span>Destination</span><strong>Home{destinationPath ? ` / ${destinationPath}` : ''}</strong></div>
      {!destinationExists && <div className="multi-capture-alert">The destination folder no longer exists.</div>}

      <section className="multi-capture-bulk">
        <label htmlFor="multi-capture-paste">Paste website links</label>
        <div className="multi-capture-paste-row">
          <textarea id="multi-capture-paste" value={bulkInput} onChange={event => setBulkInput(event.target.value)} placeholder={'Paste links separated by commas, spaces, tabs, or new lines'} disabled={saving} />
          <button type="button" onClick={() => appendParsed(bulkInput)} disabled={saving || !bulkInput.trim()}>Add links</button>
        </div>
      </section>

      <div className="multi-capture-list-head"><span>Website URL</span><span>Project name <i>optional</i></span><span>Status</span><span /></div>
      <div className="multi-capture-list">
        {assessed.map(({ row, error, duplicate }) => {
          const duplicateLabel = duplicate === 'batch' ? 'Repeated in this list' : duplicate === 'folder' ? 'Already in this folder' : ''
          const statusLabel = row.status === 'saving' ? 'Adding…' : row.status === 'saved' ? 'Added' : row.status === 'failed' ? 'Failed' : row.status === 'stopped' ? 'Not added' : row.status === 'skipped' || (skipDuplicates && duplicate) ? 'Skipped' : error ? 'Invalid' : row.url.trim() ? 'Ready' : 'Empty'
          return <div className={`multi-capture-row status-${row.status} ${error ? 'has-error' : ''}`} key={row.id}>
            <div className="multi-capture-field">
              <input data-row-url={row.id} value={row.url} onChange={event => updateRow(row.id, { url: event.target.value, parseError: undefined, status: 'idle', saveError: undefined })} onPaste={event => pasteIntoRow(event, row.id)} placeholder="example.com/page" disabled={saving || row.status === 'saved'} aria-label="Website URL" />
              {(error || row.saveError || (skipDuplicates && duplicateLabel)) && <small>{error || row.saveError || duplicateLabel}</small>}
            </div>
            <input value={row.name} onChange={event => updateRow(row.id, { name: event.target.value })} placeholder={row.url.trim() ? deriveMultiCaptureName(row.url) : 'Optional name'} disabled={saving || row.status === 'saved'} aria-label="Optional project name" />
            <span className={`multi-capture-status status-${statusLabel.toLowerCase().replace(/\s+/g, '-')}`}>{row.status === 'saving' && <i aria-hidden="true" />}{statusLabel}</span>
            <button type="button" className="multi-capture-remove" onClick={() => setRows(current => current.length === 1 ? [createMultiCaptureRow()] : current.filter(item => item.id !== row.id))} disabled={saving} aria-label={`Remove ${row.url || 'empty URL'} row`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></button>
          </div>
        })}
      </div>

      <button type="button" className="multi-capture-add-row" onClick={() => { addBlankRow(); setSummary(null) }} disabled={saving}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>Add URL</button>

      <div className="multi-capture-review">
        <span className="multi-capture-review-label">QA agent</span>
        {(['desktop', 'tablet', 'mobile'] as Breakpoint[]).map(breakpoint => <label key={breakpoint}><input type="checkbox" checked={reviewOn[breakpoint]} onChange={event => setReviewOn(current => ({ ...current, [breakpoint]: event.target.checked }))} disabled={saving || starting} />{breakpoint[0].toUpperCase() + breakpoint.slice(1)}</label>)}
        <label className="multi-capture-review-test"><input type="checkbox" checked={testPages} onChange={event => { testTouched.current = true; setTestPages(event.target.checked) }} disabled={saving || starting} />Also test links, forms and buttons</label>
        <small>Reviews each page by itself, with no design, on every ticked size{testPages ? ', then tests how it works' : ''}: {reviewPages.length * chosenBreakpoints.length} review{reviewPages.length * chosenBreakpoints.length === 1 ? '' : 's'} ({reviewPages.length} page{reviewPages.length === 1 ? '' : 's'} × {chosenBreakpoints.length} size{chosenBreakpoints.length === 1 ? '' : 's'}){testPages ? ` and ${reviewPages.length} test${reviewPages.length === 1 ? '' : 's'}` : ''}. {tooManyPages ? `Review at most ${QA_BATCH_MAX_PAGES} pages at once.` : 'Each review can use hundreds of thousands of tokens (about 500,000 on a small test page with a subscription agent), so a long list can use up a plan. Set a token limit in Settings → AI Agents.'}</small>
      </div>

      <footer className="multi-capture-footer">
        <div className="multi-capture-summary">
          <label><input type="checkbox" checked={skipDuplicates} onChange={event => { setSkipDuplicates(event.target.checked); setRows(current => current.map(row => row.status === 'skipped' ? { ...row, status: 'idle' } : row)); setSummary(null) }} disabled={saving} /> Skip duplicates</label>
          <span>{addableCount} ready{invalidCount ? ` · ${invalidCount} invalid` : ''}{duplicateCount ? ` · ${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'}` : ''}</span>
          {summary && <strong>{summary.added} added · {summary.skipped} skipped · {summary.failed} failed{summary.stopped ? ` · ${summary.stopped} stopped` : ''}</strong>}
          {message && <strong className="multi-capture-message">{message}</strong>}
        </div>
        <div className="multi-capture-actions">
          {saving ? <button type="button" className="multi-capture-secondary" onClick={stopAdding} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop adding'}</button> : <button type="button" className="multi-capture-secondary" onClick={onClose}>{summary && addableCount === 0 ? 'Done' : 'Cancel'}</button>}
          {(!summary || addableCount > 0 || saving) && <button type="button" className="multi-capture-primary" onClick={() => void saveRows()} disabled={saving || invalidCount > 0 || addableCount === 0 || !destinationExists}>{saving ? 'Adding…' : summary?.failed ? `Retry ${summary.failed} failed` : summary?.stopped ? `Resume ${addableCount}` : `Add ${addableCount} project${addableCount === 1 ? '' : 's'}`}</button>}
        
          <button type="button" className="multi-capture-review-button" onClick={() => void saveAndReview()} disabled={!canReview || !destinationExists}>{starting ? 'Starting…' : addableCount > 0 ? 'Save & review with QA agent' : 'Review with QA agent'}</button>
        </div>
      </footer>
    </div>
  </div>
}
