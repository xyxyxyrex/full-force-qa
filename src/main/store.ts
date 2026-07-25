import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { Project } from '../shared/types'

const STORE_FILE = () => join(app.getPath('userData'), 'projects.json')

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
  const idx = projects.findIndex((p) => p.id === project.id)
  if (idx >= 0) {
    projects[idx] = project
  } else {
    projects.push(project)
  }
  writeAll(projects)
}

export function deleteProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id))
}
