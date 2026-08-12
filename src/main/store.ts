import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import type { Project } from '../shared/types'

let activeOwnerKey: string | null = null

const LEGACY_STORE_FILE = () => join(app.getPath('userData'), 'projects.json')
const ACTIVE_OWNER_FILE = () => join(app.getPath('userData'), 'active-project-owner.txt')
const LEGACY_CLAIM_FILE = () => join(app.getPath('userData'), 'legacy-projects-claimed.txt')
const WORKSPACE_HTML_DIR = () => join(app.getPath('userData'), 'workspace-html')

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

function workspaceHtmlFile(tabId: string): string {
  const key = createHash('sha256').update(tabId).digest('hex')
  return join(WORKSPACE_HTML_DIR(), `${key}.html`)
}

export function loadWorkspaceHtml(tabId: string): string | null {
  try {
    const file = workspaceHtmlFile(tabId)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

export function saveWorkspaceHtml(tabId: string, html: string): void {
  const directory = WORKSPACE_HTML_DIR()
  mkdirSync(directory, { recursive: true })
  const file = workspaceHtmlFile(tabId)
  const temporaryFile = `${file}.tmp`
  writeFileSync(temporaryFile, html, 'utf8')
  try {
    renameSync(temporaryFile, file)
  } catch {
    try { unlinkSync(file) } catch {}
    renameSync(temporaryFile, file)
  }
}

export function deleteWorkspaceHtml(tabId: string): void {
  try { unlinkSync(workspaceHtmlFile(tabId)) } catch {}
}
