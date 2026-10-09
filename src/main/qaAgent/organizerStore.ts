import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Breakpoint } from '../../shared/designScale'
import type { AuditFinding, FindingSource, FindingUpdate, OrganizerSnapshot } from '../../shared/qaOrganizer'
import { plainRemark } from '../../shared/remarkStyle'
import type { TrackerFormat } from '../../shared/trackerFormat'
import type { DraftRow } from './tools'
import type { RunMeta } from './runStore'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = (text: string) => plainRemark(text).trim().replace(/\s+/g, ' ')
const pageCells = (cells:Record<string,string>, meta:RunMeta, format:TrackerFormat) => {
  const column=format.columns.find(name=>/^page\b.*(link|url)|^url$|^link$/i.test(name))
  return column ? {...cells,[column]:meta.pageUrl} : {...cells}
}
const sameIssue = (a: Record<string,string>, b: Record<string,string>) => {
  const left=a.Remarks||a.Issue||a.Description; const right=b.Remarks||b.Issue||b.Description
  return left&&right ? normalize(left)===normalize(right)&&normalize(a.Section||'')===normalize(b.Section||'') : hash(a)===hash(b)
}
export interface OrganizerProof { data: Buffer; caption: string }

export function createOrganizerStore(root: string, now = Date.now) {
  const folder = (owner: string, project: string) => join(root, hash(owner), hash(project))
  function read(owner: string, projectKey: string, projectName: string, format: TrackerFormat): OrganizerSnapshot {
    const file = join(folder(owner, projectKey), 'findings.json')
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as OrganizerSnapshot : { projectKey, projectName, revision: 0, columns: format.columns, findings: [] }
    if (saved.projectKey !== projectKey || !Array.isArray(saved.findings) || !Number.isInteger(saved.revision)) throw new Error('The saved findings could not be read. Keep the file and retry.')
    return { ...saved, projectName, columns: [...new Set([...format.columns, ...saved.columns,...saved.findings.flatMap(item=>Object.keys(item.cells))])], choices: format.choices }
  }
  function write(owner: string, snapshot: OrganizerSnapshot) {
    const dir = folder(owner, snapshot.projectKey); mkdirSync(dir, { recursive: true })
    const file = join(dir, 'findings.json'); writeFileSync(file + '.tmp', JSON.stringify(snapshot, null, 2)); renameSync(file + '.tmp', file)
  }
  function proof(owner: string, project: string, value?: OrganizerProof) {
    if (!value) return undefined
    const dir = join(folder(owner, project), 'evidence'); mkdirSync(dir, { recursive: true })
    const file = createHash('sha256').update(value.data).digest('hex') + '.webp'
    if (!existsSync(join(dir, file))) writeFileSync(join(dir, file), value.data)
    return { file, caption: value.caption }
  }
  function save(owner: string, meta: RunMeta, breakpoint: Breakpoint, rows: DraftRow[], area: FindingSource['area'], format: TrackerFormat, proofs: Array<OrganizerProof | undefined> = []) {
    const snapshot = read(owner, meta.projectKey, meta.projectName, format)
    const source: FindingSource = { runId: meta.id, breakpoint, area }
    const saved = rows.map((row, index) => {
      const key = hash({ source, page: meta.pageUrl, cells: row.cells, evidence: row.evidence })
      let item = row.findingId ? snapshot.findings.find(f => f.id === row.findingId && f.pageUrl === meta.pageUrl && f.sources.some(s => s.runId === meta.id)) : undefined
      item ||= snapshot.findings.find(f => f.sourceKeys.includes(key))
      if (item?.mergedInto) item = snapshot.findings.find(f => f.id === item!.mergedInto) || item
      if (!item) {
        item = { id: randomUUID(), projectKey: meta.projectKey, projectName: meta.projectName, pageUrl: meta.pageUrl,
          cells: pageCells(row.cells,meta,format), sources: [source], sourceKeys: [key], review: 'draft', edited: [], createdAt: now(), updatedAt: now(), evidence: proof(owner, meta.projectKey, proofs[index]) }
        snapshot.findings.push(item)
      } else if (!item.sourceKeys.includes(key)) {
        // Re-saves may update untouched drafts, but never a user's changes or a reviewed item.
        if (item.review === 'draft') for (const [column, value] of Object.entries(row.cells)) if (!item.edited.includes(column)) item.cells[column] = value
        item.sourceKeys.push(key)
        if (!item.sources.some(s => hash(s) === hash(source))) item.sources.push(source)
        item.evidence ||= proof(owner, meta.projectKey, proofs[index]); item.updatedAt = now()
      }
      return { ...row, findingId: item.id, sourceFindingIds: [item.id] }
    })
    if (rows.length) { snapshot.revision++; write(owner, snapshot) }
    return { snapshot, rows: saved }
  }
  function reconcile(owner: string, entries: Array<{ meta: RunMeta; row: DraftRow }>, format: TrackerFormat, proofs: Array<OrganizerProof | undefined> = []) {
    const ids: string[] = []
    for (const [index, {meta, row}] of entries.entries()) {
      const snapshot = read(owner, meta.projectKey, meta.projectName, format)
      const requested = [...new Set([...(row.sourceFindingIds || []), ...(row.findingId ? [row.findingId] : [])])]
      const matches = snapshot.findings.filter(f => f.pageUrl === meta.pageUrl && !f.mergedInto && (requested.length ? requested.includes(f.id) : f.sources.some(s => s.runId === meta.id) && sameIssue(f.cells, row.cells)))
      if (requested.some(id => !snapshot.findings.some(f => f.id === id && f.pageUrl === meta.pageUrl && f.sources.some(s=>s.runId===meta.id)))) throw new Error('A source finding belongs to another project, page, or audit. Refresh the findings and retry.')
      if (!matches.length) {
        const bp = row.evidence?.breakpoint || 'desktop'
        ids.push(save(owner, meta, bp, [row], 'visual', format, [proofs[index]]).rows[0].findingId!)
        continue
      }
      // Reviewed/edited source rows stay separate so a merge cannot erase a human decision.
      const protectedRows = matches.filter(f => f.edited.length || f.review !== 'draft')
      const untouched = matches.filter(f => !protectedRows.includes(f))
      ids.push(...protectedRows.map(f => f.id))
      const target = untouched[0]
      if (target) {
        target.cells = pageCells(row.cells,meta,format); target.evidence ||= proof(owner, meta.projectKey, proofs[index]); target.updatedAt = now()
        const pictures=[...(target.evidenceSet||[]),...(target.evidence?[target.evidence]:[])]
        for (const other of untouched.slice(1)) { other.mergedInto = target.id; target.sourceKeys.push(...other.sourceKeys); target.sources.push(...other.sources);pictures.push(...(other.evidenceSet||[]),...(other.evidence?[other.evidence]:[])) }
        target.evidenceSet=pictures.filter((picture,index,array)=>array.findIndex(v=>v.file===picture.file)===index)
        target.sourceKeys = [...new Set(target.sourceKeys)]; target.sources = target.sources.filter((s,i,a) => a.findIndex(v=>hash(v)===hash(s))===i)
        ids.push(target.id); snapshot.revision++; write(owner, snapshot)
      }
    }
    return [...new Set(ids)]
  }
  function update(owner: string, project: string, projectName: string, revision: number, changes: FindingUpdate[], format: TrackerFormat) {
    const snapshot = read(owner, project, projectName, format)
    if (snapshot.revision !== revision) throw new Error('Findings changed while you were editing. Refresh and retry; your text is still available.')
    if (!changes.length || changes.length > 500) throw new Error('Select between 1 and 500 findings.')
    for (const change of changes) {
      const item = snapshot.findings.find(f => f.id === change.id && !f.mergedInto)
      if (!item) throw new Error('That finding is no longer available. Refresh and retry.')
      if (change.review !== undefined && !['draft','accepted','dismissed'].includes(change.review)) throw new Error('Choose Draft, Accepted, or Dismissed.')
      for (const [column, value] of Object.entries(change.cells || {})) {
        if (!snapshot.columns.includes(column) || typeof value !== 'string' || value.length > 5000 || /[\u0000-\u0008]/.test(value)) throw new Error('That cell value is not valid.')
        if (format.choices?.[column] && value && !format.choices[column].includes(value)) throw new Error(`Choose a valid option for ${column}.`)
        item.cells[column] = value; item.edited = [...new Set([...item.edited, column])]
      }
      if (change.review) item.review = change.review
      item.updatedAt = now()
    }
    snapshot.revision++; write(owner, snapshot); return snapshot
  }
  function picture(owner: string, project: string, id: string, format: TrackerFormat, index=0) {
    const finding = read(owner, project, '', format).findings.find(f=>f.id===id)
    const images=finding?.evidenceSet?.length?finding.evidenceSet:finding?.evidence?[finding.evidence]:[]
    const evidence=Number.isInteger(index)&&index>=0?images[index]:undefined
    if (!evidence || !/^[a-f0-9]{64}\.webp$/.test(evidence.file)) return null
    return { data: readFileSync(join(folder(owner, project), 'evidence', evidence.file)), caption: evidence.caption }
  }
  return { read, save, reconcile, update, picture }
}
