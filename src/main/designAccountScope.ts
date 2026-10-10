import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { projectOfDesignKey } from '../shared/designKey'

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
function read(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
function projectIds(file: string): string[] {
  const value = read(file)
  return Array.isArray(value) ? value.flatMap(item => typeof item?.id === 'string' ? [item.id] : []) : []
}
function write(file: string, value: unknown) {
  writeFileSync(file + '.tmp', JSON.stringify(value))
  renameSync(file + '.tmp', file)
}
const designDirectory = (key: string) => `${key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'project'}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`

/** Retain legacy assets; migrate only when managed project files establish one unambiguous owner. */
export function scopedDesignRoot(userData: string, owner: string): string {
  const legacy = join(userData, 'designs'), scope = hash(owner)
  const root = join(legacy, 'accounts', scope), marker = join(root, 'migrated-v1.json')
  mkdirSync(root, { recursive: true })
  if (existsSync(marker)) return root
  const ownedFile = `projects-${scope}.json`
  const files = readdirSync(userData).filter(name => /^projects-[a-f\d]{24}\.json$/.test(name))
  const owners = new Map<string, Set<string>>()
  const owned = projectIds(join(userData, ownedFile))
  for (const file of files) {
    for (const id of projectIds(join(userData, file))) {
      const values = owners.get(id) || new Set<string>()
      values.add(file)
      owners.set(id, values)
    }
  }
  const ledgerFile = join(legacy, 'legacy-owners.json')
  const stored = read(ledgerFile)
  const ledger: Record<string, string> = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, string> : {}
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'accounts') continue
    const source = join(legacy, entry.name), meta = read(join(source, 'meta.json'))
    if (!meta || typeof meta !== 'object') continue
    const metaKey = (meta as { key?: unknown }).key
    const key = typeof metaKey === 'string' ? metaKey : owned.find(id => designDirectory(id) === entry.name)
    if (!key || designDirectory(key) !== entry.name) continue
    const project = projectOfDesignKey(key), known = owners.get(project)
    if (!owned.includes(project) || known?.size !== 1 || !known.has(ownedFile)) continue
    if (ledger[entry.name] && ledger[entry.name] !== scope) continue
    const destination = join(root, entry.name)
    mkdirSync(destination, { recursive: true })
    for (const file of readdirSync(source, { withFileTypes: true })) {
      if (file.isFile() && !file.isSymbolicLink() && /^(meta\.json|(desktop|tablet|mobile)(@1x)?\.png)$/.test(file.name)) {
        copyFileSync(join(source, file.name), join(destination, file.name))
      }
    }
    ledger[entry.name] = scope
  }
  write(ledgerFile, ledger)
  write(marker, { owner: scope })
  return root
}
