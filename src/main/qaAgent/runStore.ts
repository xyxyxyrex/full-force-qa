import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BREAKPOINTS, type Breakpoint } from '../../shared/designScale'
import type { DesignSlotMeta } from '../../shared/qaAgent'
import type { LiveCaptureResult } from './liveCapture'

// One folder per QA run under userData/qa-runs, holding the captures, the design copy,
// the section crops and the agent's drafts, so a run survives context compaction and can
// be re-read by any tool call.

export const RUN_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,40}-[0-9a-f]{4}$/
const DAY = 24 * 60 * 60 * 1000

export interface RunMeta {
  id: string
  projectKey: string
  projectName: string
  pageUrl: string
  createdAt: number
  touchedAt: number
}

export type LiveRecord = Omit<LiveCaptureResult, 'png'> & { capturedAt: number; design: DesignSlotMeta | null }

export interface PruneOptions {
  maxAgeDays?: number
  maxRuns?: number
  maxBytes?: number
  /** Runs touched more recently than this are never removed. */
  protectMs?: number
}

function atomicWrite(file: string, data: string | Buffer) {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, data)
  try { renameSync(temporary, file) } catch { rmSync(file, { force: true }); renameSync(temporary, file) }
}

function folderSize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? folderSize(path) : statSync(path).size
  }
  return total
}

export function createRunStore(root: string, now: () => number = () => Date.now()) {
  const dir = (id: string) => {
    if (!RUN_ID_PATTERN.test(id)) throw new Error('That is not a valid run id.')
    return join(root, id)
  }
  const bpDir = (id: string, breakpoint: Breakpoint) => {
    if (!BREAKPOINTS.includes(breakpoint)) throw new Error('Unknown breakpoint.')
    return join(dir(id), breakpoint)
  }
  const readMeta = (id: string): RunMeta | null => {
    try { return JSON.parse(readFileSync(join(dir(id), 'run.json'), 'utf8')) as RunMeta } catch { return null }
  }

  return {
    create(input: { projectKey: string; projectName: string; pageUrl: string }): RunMeta {
      const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      const slug = (input.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '')) || 'run'
      const id = `${stamp}-${slug}-${randomBytes(2).toString('hex')}`
      const meta: RunMeta = { id, projectKey: input.projectKey, projectName: input.projectName.slice(0, 120), pageUrl: input.pageUrl, createdAt: now(), touchedAt: now() }
      mkdirSync(dir(id), { recursive: true })
      atomicWrite(join(dir(id), 'run.json'), JSON.stringify(meta, null, 2))
      return meta
    },

    get: readMeta,

    touch(id: string): void {
      const meta = readMeta(id)
      if (meta) atomicWrite(join(dir(id), 'run.json'), JSON.stringify({ ...meta, touchedAt: now() }, null, 2))
    },

    /** Latest run for a project, newest first. */
    latest(projectKey: string): RunMeta | null {
      if (!existsSync(root)) return null
      const runs = readdirSync(root).filter((name) => RUN_ID_PATTERN.test(name)).map((name) => readMeta(name)).filter((meta): meta is RunMeta => !!meta && meta.projectKey === projectKey)
      return runs.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    },

    saveCapture(id: string, breakpoint: Breakpoint, capture: LiveCaptureResult, design: { png: Buffer; meta: DesignSlotMeta } | null): void {
      const folder = bpDir(id, breakpoint)
      mkdirSync(join(folder, 'crops'), { recursive: true })
      atomicWrite(join(folder, 'live.png'), capture.png)
      const { png: _png, ...rest } = capture
      const record: LiveRecord = { ...rest, capturedAt: now(), design: design?.meta ?? null }
      atomicWrite(join(folder, 'live.json'), JSON.stringify(record))
      if (design) atomicWrite(join(folder, 'design@1x.png'), design.png)
      else rmSync(join(folder, 'design@1x.png'), { force: true })
      this.touch(id)
    },

    readLive(id: string, breakpoint: Breakpoint): { png: Buffer; record: LiveRecord } | null {
      try {
        const folder = bpDir(id, breakpoint)
        return { png: readFileSync(join(folder, 'live.png')), record: JSON.parse(readFileSync(join(folder, 'live.json'), 'utf8')) as LiveRecord }
      } catch { return null }
    },

    readDesign(id: string, breakpoint: Breakpoint): Buffer | null {
      try { return readFileSync(join(bpDir(id, breakpoint), 'design@1x.png')) } catch { return null }
    },

    /** Where crops for a breakpoint are written so a tool can also return their paths. */
    cropsDir(id: string, breakpoint: Breakpoint): string {
      const folder = join(bpDir(id, breakpoint), 'crops')
      mkdirSync(folder, { recursive: true })
      return folder
    },

    saveDraft(id: string, breakpoint: Breakpoint, rows: unknown[]): void {
      const folder = join(dir(id), 'drafts')
      mkdirSync(folder, { recursive: true })
      atomicWrite(join(folder, `${breakpoint}.json`), JSON.stringify({ savedAt: now(), rows }, null, 2))
      this.touch(id)
    },

    readDrafts(id: string): Partial<Record<Breakpoint, unknown[]>> {
      const drafts: Partial<Record<Breakpoint, unknown[]>> = {}
      for (const breakpoint of BREAKPOINTS) {
        try { drafts[breakpoint] = (JSON.parse(readFileSync(join(dir(id), 'drafts', `${breakpoint}.json`), 'utf8')) as { rows: unknown[] }).rows } catch { /* none yet */ }
      }
      return drafts
    },

    /** Folder for files written when rows are finalized (rows.tsv, evidence images). */
    outputDir(id: string): string {
      const folder = join(dir(id), 'output')
      mkdirSync(folder, { recursive: true })
      return folder
    },

    prune(options: PruneOptions = {}): string[] {
      const { maxAgeDays = 14, maxRuns = 30, maxBytes = 2 * 1024 * 1024 * 1024, protectMs = 60 * 60 * 1000 } = options
      if (!existsSync(root)) return []
      const entries = readdirSync(root)
        .filter((name) => RUN_ID_PATTERN.test(name))
        .map((name) => ({ name, meta: readMeta(name) }))
        .map((entry) => ({ name: entry.name, touchedAt: entry.meta?.touchedAt ?? 0, bytes: folderSize(join(root, entry.name)) }))
        .sort((a, b) => b.touchedAt - a.touchedAt)
      const removed: string[] = []
      const protectedRun = (entry: { touchedAt: number }) => now() - entry.touchedAt < protectMs
      let kept = entries
      const drop = (entry: { name: string }) => { rmSync(join(root, entry.name), { recursive: true, force: true }); removed.push(entry.name) }
      for (const entry of kept.filter((e) => !protectedRun(e) && now() - e.touchedAt > maxAgeDays * DAY)) drop(entry)
      kept = kept.filter((e) => !removed.includes(e.name))
      for (const entry of kept.slice(maxRuns).filter((e) => !protectedRun(e))) drop(entry)
      kept = kept.filter((e) => !removed.includes(e.name))
      let total = kept.reduce((sum, e) => sum + e.bytes, 0)
      for (const entry of [...kept].reverse()) {
        if (total <= maxBytes) break
        if (protectedRun(entry)) continue
        drop(entry)
        total -= entry.bytes
      }
      return removed
    },
  }
}

export type RunStore = ReturnType<typeof createRunStore>
