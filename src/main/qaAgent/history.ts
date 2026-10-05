import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { BREAKPOINTS, type Breakpoint } from '../../shared/designScale'
import type { QaHandOverRecord, QaHistoryPicture, QaRunDetail, QaRunListItem } from '../../shared/qaAgent'
import { buildHtml, buildRows, parseTsv, screenshotColumn, type TrackerFormat } from '../../shared/trackerFormat'
import { thumbnailJpeg } from './imageOps'
import type { DraftArea, RunMeta, RunStore } from './runStore'
import { renderRowEvidence, type DraftRow } from './tools'

// Past reviews: what each run captured, drafted and handed over, with its pictures. Hand-overs are
// read from their records; runs from before records existed are rebuilt from the rows that were
// copied and the evidence pictures saved next to them.

const HANDOVER_FILE = /^handover-(\d+)\.json$/
const ROWS_FILE = /^rows-(\d+)\.tsv$/
const EVIDENCE_FILE = /^evidence-(\d+)-row-(\d+)\.webp$/
export const HISTORY_PICTURE_WIDTH = 1100

const unapostrophe = (cell: string) => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell)

export function createRunHistory(deps: { runs: RunStore; trackerFormat: () => TrackerFormat | null }) {
  const { runs } = deps
  const outputDir = (id: string) => join(runs.folder(id), 'output')
  const outputFiles = (id: string): string[] => { try { return readdirSync(outputDir(id)) } catch { return [] } }

  function legacyRecord(meta: RunMeta, stamp: string, files: string[]): QaHandOverRecord | null {
    let text: string
    try { text = readFileSync(join(outputDir(meta.id), `rows-${stamp}.tsv`), 'utf8') } catch { return null }
    const pasted = parseTsv(text)
    const rows = pasted.map((row) => row.map(unapostrophe))
    const width = Math.max(0, ...rows.map((row) => row.length))
    const format = deps.trackerFormat()
    const columns = format && format.columns.length === width ? format.columns : Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
    const evidence = files.flatMap((file) => {
      const match = EVIDENCE_FILE.exec(file)
      return match && match[1] === stamp ? [{ rowIndex: Number(match[2]) - 1, file, caption: '' }] : []
    })
    const shot = format && columns === format.columns ? screenshotColumn(format) : null
    const shotIndex = shot ? columns.indexOf(shot) : -1
    const links: Record<string, string> = {}
    if (shotIndex >= 0) rows.forEach((row, index) => { if (/^https?:\/\//.test(row[shotIndex] ?? '')) links[String(index)] = row[shotIndex] })
    return { version: 1, stamp, createdAt: Number(stamp) || meta.createdAt, status: 'approved', projectName: meta.projectName, pageUrl: meta.pageUrl, columns, rows, evidence, links, copiedRows: rows.length }
  }

  function handovers(meta: RunMeta): QaHandOverRecord[] {
    const files = outputFiles(meta.id)
    const records: QaHandOverRecord[] = []
    for (const file of files) {
      if (!HANDOVER_FILE.test(file)) continue
      try {
        const record = JSON.parse(readFileSync(join(outputDir(meta.id), file), 'utf8')) as QaHandOverRecord
        if (record?.version === 1 && Array.isArray(record.rows) && Array.isArray(record.columns)) records.push(record)
      } catch { /* a damaged record is skipped */ }
    }
    const recorded = new Set(records.map((record) => record.stamp))
    for (const file of files) {
      const match = ROWS_FILE.exec(file)
      if (!match || recorded.has(match[1])) continue
      const legacy = legacyRecord(meta, match[1], files)
      if (legacy) records.push(legacy)
    }
    return records.sort((a, b) => b.createdAt - a.createdAt)
  }

  const draftsOf = (id: string, area: DraftArea = 'visual') => runs.readDrafts(id, area) as Partial<Record<Breakpoint, DraftRow[]>>
  const draftCount = (drafts: Partial<Record<Breakpoint, DraftRow[]>>) => BREAKPOINTS.reduce((sum, breakpoint) => sum + (drafts[breakpoint]?.length ?? 0), 0)

  function summary(meta: RunMeta): QaRunListItem {
    const folder = runs.folder(meta.id)
    return {
      id: meta.id, projectName: meta.projectName, pageUrl: meta.pageUrl, createdAt: meta.createdAt, pinned: meta.pinned === true,
      breakpoints: BREAKPOINTS.filter((breakpoint) => existsSync(join(folder, breakpoint, 'live.json'))),
      drafted: draftCount(draftsOf(meta.id)) + draftCount(draftsOf(meta.id, 'functional')),
      handovers: handovers(meta).map((record) => ({ stamp: record.stamp, status: record.status, rows: record.rows.length, ...(record.copiedRows !== undefined ? { copied: record.copiedRows } : {}) })),
    }
  }

  return {
    list(): QaRunListItem[] {
      return runs.list().map(summary)
    },

    detail(id: string): QaRunDetail | null {
      const meta = runs.get(id)
      if (!meta) return null
      const format = deps.trackerFormat()
      const drafts = draftsOf(id)
      const functional = draftsOf(id, 'functional')
      const keys = [...new Set([drafts, functional].flatMap((byBreakpoint) => BREAKPOINTS.flatMap((breakpoint) => (byBreakpoint[breakpoint] ?? []).flatMap((row) => Object.keys(row?.cells ?? {})))))]
      const columns = format?.columns ?? keys
      const toCells = (row: DraftRow): string[] => {
        if (format) {
          const built = buildRows(format, [row.cells], { maxRows: 1 })
          if (built.ok) return built.rows[0].map(unapostrophe)
        }
        return columns.map((column) => String(row.cells?.[column] ?? ''))
      }
      return {
        run: summary(meta),
        handovers: handovers(meta),
        drafts: [
          ...BREAKPOINTS.filter((breakpoint) => drafts[breakpoint]?.length).map((breakpoint) => ({ breakpoint, rows: drafts[breakpoint]!.map((row) => ({ cells: toCells(row), hasPicture: !!row?.evidence })) })),
          ...BREAKPOINTS.filter((breakpoint) => functional[breakpoint]?.length).map((breakpoint) => ({ breakpoint, area: 'functional' as const, rows: functional[breakpoint]!.map((row) => ({ cells: toCells(row), hasPicture: !!row?.evidence })) })),
        ],
        columns,
      }
    },

    /** A picture as a JPEG data URL, or null when it does not exist. */
    async picture(id: string, ref: QaHistoryPicture): Promise<string | null> {
      if (!runs.get(id)) return null
      let image: Buffer | null = null
      if (ref.kind === 'handover') {
        if (!EVIDENCE_FILE.test(ref.file)) return null
        try { image = readFileSync(join(outputDir(id), ref.file)) } catch { return null }
      } else {
        if (!BREAKPOINTS.includes(ref.breakpoint) || !Number.isInteger(ref.index) || ref.index < 0) return null
        const row = draftsOf(id, ref.area === 'functional' ? 'functional' : 'visual')[ref.breakpoint]?.[ref.index]
        if (!row) return null
        image = (await renderRowEvidence(runs, id, row, ref.index))?.data ?? null
      }
      if (!image) return null
      try { return `data:image/jpeg;base64,${(await thumbnailJpeg(image, HISTORY_PICTURE_WIDTH)).toString('base64')}` } catch { return null }
    },

    /** The rows that were copied in a hand-over, exactly as they were pasted, for copying again. */
    copiedRows(id: string, stamp: string): { text: string; html: string; count: number } | null {
      if (!runs.get(id) || !/^\d+$/.test(stamp)) return null
      try {
        const text = readFileSync(join(outputDir(id), `rows-${stamp}.tsv`), 'utf8')
        const rows = parseTsv(text)
        // The same text and table as the first copy, so a pasted cell is never read as a formula.
        return { text, html: buildHtml(rows), count: rows.length }
      } catch { return null }
    },
  }
}

export type RunHistory = ReturnType<typeof createRunHistory>
