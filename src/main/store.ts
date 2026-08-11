import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import type { AutomateRunSummary, FindingTriageMap, FindingTriageState, Project } from '../shared/types'

let activeOwnerKey: string | null = null

const LEGACY_STORE_FILE = () => join(app.getPath('userData'), 'projects.json')
const ACTIVE_OWNER_FILE = () => join(app.getPath('userData'), 'active-project-owner.txt')
const LEGACY_CLAIM_FILE = () => join(app.getPath('userData'), 'legacy-projects-claimed.txt')

function ownerHash(ownerKey: string): string {
  return createHash('sha256').update(ownerKey).digest('hex').slice(0, 24)
}

function currentOwnerKey(): string | null {
  if (activeOwnerKey) return activeOwnerKey
  try {
    const stored = readFileSync(ACTIVE_OWNER_FILE(), 'utf8').trim()
    if (/^monday:[0-9]+$/.test(stored)) activeOwnerKey = stored
  } catch {}
  return activeOwnerKey
}

const STORE_FILE = () => {
  const ownerKey = currentOwnerKey()
  return ownerKey
    ? join(app.getPath('userData'), `projects-${ownerHash(ownerKey)}.json`)
    : LEGACY_STORE_FILE()
}

export function setProjectOwner(ownerKey: string): void {
  if (!/^monday:[0-9]+$/.test(ownerKey)) throw new Error('Invalid Monday project owner.')
  activeOwnerKey = ownerKey
  writeFileSync(ACTIVE_OWNER_FILE(), ownerKey, 'utf8')

  const ownerFile = STORE_FILE()
  if (existsSync(ownerFile)) return
  const legacyFile = LEGACY_STORE_FILE()
  const claimFile = LEGACY_CLAIM_FILE()
  if (existsSync(legacyFile) && !existsSync(claimFile)) {
    try {
      const legacyProjects = JSON.parse(readFileSync(legacyFile, 'utf8'))
      writeFileSync(ownerFile, JSON.stringify(Array.isArray(legacyProjects) ? legacyProjects : [], null, 2), 'utf8')
      writeFileSync(claimFile, ownerHash(ownerKey), 'utf8')
      return
    } catch {}
  }
  writeFileSync(ownerFile, '[]', 'utf8')
}

export function getProjectOwner(): string | null {
  return currentOwnerKey()
}

function readAll(): Project[] {
  const file = STORE_FILE()
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
}

function writeAll(projects: Project[]): void {
  writeFileSync(STORE_FILE(), JSON.stringify(projects, null, 2), 'utf-8')
}

export function getProjects(): Project[] {
  return readAll().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

export function saveProject(project: Project): void {
  const projects = readAll()
  const nextProject = { ...project, updatedAt: project.updatedAt || Date.now() }
  const idx = projects.findIndex((p) => p.id === project.id)
  if (idx >= 0) {
    projects[idx] = nextProject
  } else {
    projects.push(nextProject)
  }
  writeAll(projects)
}

export function deleteProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id))
}

// ── Automate finding triage ────────────────────────────────────────────────
// Keyed by project id → finding id (a stable hash, not a Figma node id or array
// index), so "accept" / "false positive" survive both a re-run and a designer
// restructuring the file.

const TRIAGE_FILE = () => join(app.getPath('userData'), 'automate-triage.json')

function readTriageAll(): Record<string, FindingTriageMap> {
  const file = TRIAGE_FILE()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
}

function writeTriageAll(data: Record<string, FindingTriageMap>): void {
  writeFileSync(TRIAGE_FILE(), JSON.stringify(data, null, 2), 'utf-8')
}

export function getFindingTriage(projectId: string): FindingTriageMap {
  return readTriageAll()[projectId] || {}
}

export function setFindingTriage(projectId: string, findingId: string, state: FindingTriageState | null): void {
  const all = readTriageAll()
  const project = { ...(all[projectId] || {}) }
  if (state) {
    project[findingId] = { state, at: Date.now() }
  } else {
    delete project[findingId]
  }
  all[projectId] = project
  writeTriageAll(all)
}

// ── Automate run history ───────────────────────────────────────────────────
// Keyed by project id → frame id. Capped per frame so this stays a lightweight
// trend record, not a growing log — the images and full findings never touch disk.

const RUNS_FILE = () => join(app.getPath('userData'), 'automate-runs.json')
const MAX_RUNS_PER_FRAME = 30

function readRunsAll(): Record<string, Record<string, AutomateRunSummary[]>> {
  const file = RUNS_FILE()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
}

function writeRunsAll(data: Record<string, Record<string, AutomateRunSummary[]>>): void {
  writeFileSync(RUNS_FILE(), JSON.stringify(data, null, 2), 'utf-8')
}

export function getAutomateRuns(projectId: string, frameId: string): AutomateRunSummary[] {
  return (readRunsAll()[projectId]?.[frameId] || []).sort((a, b) => b.at - a.at)
}

export function saveAutomateRun(projectId: string, run: AutomateRunSummary): void {
  const all = readRunsAll()
  const project = { ...(all[projectId] || {}) }
  const runs = [...(project[run.frameId] || []), run].sort((a, b) => b.at - a.at).slice(0, MAX_RUNS_PER_FRAME)
  project[run.frameId] = runs
  all[projectId] = project
  writeRunsAll(all)
}
