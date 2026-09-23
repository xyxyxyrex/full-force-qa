import { BrowserWindow, dialog, ipcMain, session, shell, type WebContents } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, extname, join, relative, resolve, sep } from 'path'
import type {
  AuditExportFailure,
  AuditExportKind,
  AuditExportPayload,
  AuditExportProgress,
  AuditExportResource,
  AuditExportResult,
  AuditExportScanRequest,
  AuditExportScanResult,
  AuditMediaPreviewResult,
  AuditMediaRequest,
  AuditMediaSaveResult,
  AuditResourceKind
} from '../shared/auditExport'
import { kindFromUrl, resolveResourceUrl } from './auditCaptureContext'
import { capturedResourceCandidates, safeResourceReferer } from './resourceReferrer'
export { buildAuditCaptureContext } from './auditCaptureContext'

const REVIEW_FILE_COUNT = 100
const REVIEW_BYTES = 250 * 1024 * 1024
const PLAN_TTL_MS = 10 * 60 * 1000
const MAX_RESOURCES = 5_000
const MAX_MEDIA_PREVIEW_BYTES = 24 * 1024 * 1024

interface ExportPlan extends AuditExportScanResult {
  senderId: number
  expiresAt: number
  payload: AuditExportPayload
}

interface ExportJob {
  senderId: number
  cancelled: boolean
  controllers: Set<AbortController>
}

const plans = new Map<string, ExportPlan>()
const jobs = new Map<string, ExportJob>()
const exportedFolders = new Set<string>()
const savedMediaFiles = new Map<string, number>()

async function fetchCapturedAsset(url: string, pageUrl: string, options: RequestInit): Promise<Response> {
  const candidates = capturedResourceCandidates(url, pageUrl)
  let lastError: unknown
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const headers = new Headers(options.headers)
    const referer = safeResourceReferer(candidate, pageUrl)
    if (referer) headers.set('Referer', referer)
    else headers.delete('Referer')
    try {
      const response = await session.defaultSession.fetch(candidate, { ...options, headers })
      if (response.ok || index === candidates.length - 1) return response
      try { await response.body?.cancel() } catch {}
    } catch (error) {
      lastError = error
      if (index === candidates.length - 1) throw error
    }
  }
  throw lastError || new Error('The captured asset could not be fetched.')
}

function resourcesForKind(kind: AuditExportKind, payload: AuditExportPayload): AuditExportResource[] {
  if (kind === 'images') return payload.resources.filter((item) => item.kind === 'image')
  if (kind === 'assets') return payload.resources.filter((item) => item.kind !== 'image')
  if (kind === 'media') return payload.resources.filter((item) => ['image', 'video', 'audio'].includes(item.kind))
  if (kind === 'bundle') return payload.resources
  return []
}

function dedupeResources(resources: AuditExportResource[]): AuditExportResource[] {
  const seen = new Set<string>()
  return resources.filter((resource) => {
    const key = resource.inlineContent ? `inline:${createHash('sha1').update(resource.inlineContent).digest('hex')}` : resource.url
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_RESOURCES)
}

function dataUrlBuffer(url: string): { bytes: Buffer; mimeType?: string } | null {
  const match = /^data:([^,]*),(.*)$/s.exec(url)
  if (!match) return null
  try {
    const isBase64 = /(?:^|;)base64(?:;|$)/i.test(match[1])
    return {
      bytes: isBase64 ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]), 'utf8'),
      mimeType: match[1].split(';')[0] || undefined
    }
  } catch { return null }
}

async function fetchSize(url: string, referer: string): Promise<{ size: number | null; contentType?: string }> {
  if (url.startsWith('data:')) {
    const parsed = dataUrlBuffer(url)
    return { size: parsed?.bytes.length ?? null, contentType: parsed?.mimeType }
  }
  if (!/^https?:/i.test(url)) return { size: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetchCapturedAsset(url, referer, {
      method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'follow',
      headers: { Accept: '*/*' }, signal: controller.signal
    })
    const value = Number(response.headers.get('content-length'))
    return { size: Number.isFinite(value) && value >= 0 ? value : null, contentType: response.headers.get('content-type') || undefined }
  } catch { return { size: null } }
  finally { clearTimeout(timer) }
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return `"${text.replace(/"/g, '""')}"`
}

function csv<T extends object>(headers: Array<keyof T & string>, rows: T[]): string {
  return '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n')
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.normalize('NFKD').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[. -]+|[. -]+$/g, '').slice(0, 100)
  return cleaned || fallback
}

function extensionFor(mimeType: string | undefined, url: string, kind: AuditResourceKind): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
    'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'application/json': '.json',
    'font/woff': '.woff', 'font/woff2': '.woff2', 'font/ttf': '.ttf', 'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a'
  }
  const normalized = mimeType?.split(';')[0].trim().toLowerCase()
  if (normalized && map[normalized]) return map[normalized]
  try {
    const ext = extname(new URL(url).pathname).slice(0, 12)
    if (/^\.[a-z0-9]+$/i.test(ext)) return ext.toLowerCase()
  } catch {}
  return kind === 'image' ? '.img' : kind === 'video' ? '.video' : kind === 'audio' ? '.audio' : kind === 'stylesheet' ? '.css' : kind === 'script' ? '.js' : kind === 'font' ? '.font' : '.bin'
}

function validateMediaRequest(request: AuditMediaRequest): AuditExportResource {
  if (!request || !request.resource || !['image', 'video', 'audio'].includes(request.resource.kind)) throw new Error('Invalid media resource.')
  if (!/^https?:\/\//i.test(request.refererUrl) || request.refererUrl.length > 4096) throw new Error('Invalid captured page URL.')
  const resource = request.resource
  if (typeof resource.url !== 'string' || resource.url.length > MAX_MEDIA_PREVIEW_BYTES * 2 ||
      !/^(?:https?:\/\/|data:|blob:|inline-svg:|canvas:)/i.test(resource.url)) throw new Error('Unsupported media URL.')
  if (resource.inlineContent != null && (resource.kind !== 'image' || resource.mimeType !== 'image/svg+xml' ||
      Buffer.byteLength(resource.inlineContent, 'utf8') > MAX_MEDIA_PREVIEW_BYTES)) throw new Error('Invalid inline media.')
  return resource
}

function mediaMimeType(resource: AuditExportResource, responseMime?: string | null): string {
  const given = (responseMime || resource.mimeType || '').split(';')[0].trim().toLowerCase()
  if (/^(?:image|video|audio)\//.test(given)) return given
  const extension = extensionFor(undefined, resource.url, resource.kind)
  const byExtension: Record<string, string> = {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg'
  }
  return byExtension[extension] || ''
}

async function previewMedia(resource: AuditExportResource, referer: string): Promise<AuditMediaPreviewResult> {
  if (resource.url.startsWith('canvas:')) return { error: 'Canvas pixels were not saved in this capture.' }
  if (resource.url.startsWith('blob:')) return { error: 'This blob URL expired when the original page closed.' }
  if (resource.inlineContent != null || resource.url.startsWith('data:')) {
    const bytes = resource.inlineContent != null ? Buffer.from(resource.inlineContent, 'utf8') : dataUrlBuffer(resource.url)?.bytes
    if (!bytes) return { error: 'The saved data URL is invalid.' }
    if (bytes.length > MAX_MEDIA_PREVIEW_BYTES) return { error: 'This media file is too large for an in-app preview.' }
    const mimeType = mediaMimeType(resource, resource.inlineContent != null ? 'image/svg+xml' : dataUrlBuffer(resource.url)?.mimeType)
    if (!mimeType) return { error: 'This media format cannot be previewed.' }
    return { dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType, bytes: bytes.length, finalUrl: resource.url }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetchCapturedAsset(resource.url, referer, {
      credentials: 'include', cache: 'no-store', redirect: 'follow',
      headers: { Accept: 'image/*,video/*,audio/*,*/*' }, signal: controller.signal
    })
    if (!response.ok) return { error: `Media request returned HTTP ${response.status}.` }
    if (/^(?:text\/html|application\/json)/i.test(response.headers.get('content-type') || '')) return { error: 'The server returned a page instead of media. The resource may require authentication.' }
    const mimeType = mediaMimeType(resource, response.headers.get('content-type'))
    if (!mimeType) return { error: 'The server did not return a previewable media type.' }
    const knownSize = Number(response.headers.get('content-length'))
    if (knownSize > MAX_MEDIA_PREVIEW_BYTES) return { error: 'This media file is too large for an in-app preview.', finalUrl: response.url || resource.url, mimeType, bytes: knownSize }
    const reader = response.body?.getReader()
    if (!reader) return { error: 'The media response had no body.' }
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MEDIA_PREVIEW_BYTES) {
        await reader.cancel()
        return { error: 'This media file is too large for an in-app preview.', finalUrl: response.url || resource.url, mimeType, bytes: total }
      }
      chunks.push(Buffer.from(value))
    }
    return { dataUrl: `data:${mimeType};base64,${Buffer.concat(chunks, total).toString('base64')}`, finalUrl: response.url || resource.url, mimeType, bytes: total }
  } catch (error) { return { error: error instanceof Error ? error.message : 'Media preview failed.' } }
  finally { clearTimeout(timer) }
}

function uniqueFilePath(directory: string, requestedName: string): string {
  const ext = extname(requestedName)
  const stem = safeSegment(basename(requestedName, ext), 'resource')
  let candidate = join(directory, `${stem}${ext}`)
  let suffix = 2
  while (existsSync(candidate)) candidate = join(directory, `${stem}-${suffix++}${ext}`)
  const resolvedDirectory = resolve(directory) + sep
  if (!resolve(candidate).startsWith(resolvedDirectory)) throw new Error('Unsafe export path.')
  return candidate
}

function uniqueDirectoryPath(directory: string, requestedName: string): string {
  const name = safeSegment(requestedName, 'parity-audit-export')
  let candidate = join(directory, name)
  let suffix = 2
  while (existsSync(candidate)) candidate = join(directory, `${name}-${suffix++}`)
  const resolvedDirectory = resolve(directory) + sep
  if (!resolve(candidate).startsWith(resolvedDirectory)) throw new Error('Unsafe export path.')
  return candidate
}

function atomicWrite(path: string, data: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.part`
  writeFileSync(temporary, data)
  try { renameSync(temporary, path) }
  catch (error) { try { unlinkSync(temporary) } catch {}; throw error }
}

function emitProgress(sender: WebContents, progress: AuditExportProgress): void {
  if (!sender.isDestroyed()) sender.send('audit-export:progress', progress)
}

async function fetchResource(resource: AuditExportResource, referer: string, job: ExportJob): Promise<{ bytes: Buffer; mimeType?: string; finalUrl: string }> {
  if (resource.inlineContent != null) return { bytes: Buffer.from(resource.inlineContent, 'utf8'), mimeType: resource.mimeType, finalUrl: resource.url }
  const data = dataUrlBuffer(resource.url)
  if (data) return { ...data, finalUrl: resource.url }
  if (resource.url.startsWith('blob:')) throw new Error('Blob URLs expire with the captured document.')
  if (!/^https?:/i.test(resource.url)) throw new Error('Unsupported resource protocol.')
  const controller = new AbortController()
  job.controllers.add(controller)
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetchCapturedAsset(resource.url, referer, {
      credentials: 'include', cache: 'no-store', redirect: 'follow',
      headers: { Accept: '*/*' }, signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') || resource.mimeType,
      finalUrl: response.url || resource.url
    }
  } finally {
    clearTimeout(timer)
    job.controllers.delete(controller)
  }
}

async function probeLink(url: string, referer: string, job: ExportJob): Promise<{ status?: number; finalUrl?: string; error?: string }> {
  if (!/^https?:/i.test(url)) return {}
  const controller = new AbortController()
  job.controllers.add(controller)
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const requestHeaders: Record<string, string> = {}
    const safeReferer = safeResourceReferer(url, referer)
    if (safeReferer) requestHeaders.Referer = safeReferer
    let response = await session.defaultSession.fetch(url, { method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'follow', headers: requestHeaders, signal: controller.signal })
    if (response.status === 405 || response.status === 501) response = await session.defaultSession.fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow', headers: { ...requestHeaders, Range: 'bytes=0-0' }, signal: controller.signal })
    return { status: response.status, finalUrl: response.url || url }
  } catch (error) { return { error: error instanceof Error ? error.message : 'Link check failed.' } }
  finally { clearTimeout(timer); job.controllers.delete(controller) }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '')
}

function summaryMarkdown(payload: AuditExportPayload): string {
  return `# Parity Audit Export\n\n- URL: ${payload.sourceUrl}\n- Exported: ${new Date().toISOString()}\n- Title: ${payload.seo.title || 'Missing'}\n- Description: ${payload.seo.description || 'Missing'}\n- Headings: ${payload.seo.headings.length}\n- Links: ${payload.links.length}\n- Resources: ${payload.resources.length}\n`
}

async function runExport(sender: WebContents, plan: ExportPlan, baseDirectory: string): Promise<AuditExportResult> {
  const jobId = randomUUID()
  const job: ExportJob = { senderId: sender.id, cancelled: false, controllers: new Set() }
  jobs.set(jobId, job)
  const failures: AuditExportFailure[] = []
  let downloaded = 0
  let skipped = 0
  let host = 'page'
  try { host = new URL(plan.payload.sourceUrl).hostname.replace(/^www\./, '') || host } catch {}
  const folderName = `parity-audit-${safeSegment(host, 'page')}-${timestamp()}-${plan.kind}`
  const folder = uniqueDirectoryPath(baseDirectory, folderName)
  mkdirSync(folder, { recursive: true })
  emitProgress(sender, { jobId, kind: plan.kind, phase: 'preparing', completed: 0, total: plan.fileCount })

  const writeJson = (name: string, value: unknown) => { atomicWrite(join(folder, name), JSON.stringify(value, null, 2)); downloaded++ }
  const writeText = (name: string, value: string) => { atomicWrite(join(folder, name), value); downloaded++ }
  const wants = (kind: AuditExportKind) => plan.kind === kind || plan.kind === 'bundle'

  if (plan.kind === 'bundle') {
    writeText('page.html', plan.payload.html)
    writeJson('audit-report.json', plan.payload.report)
    writeText('summary.md', summaryMarkdown(plan.payload))
  }
  if (wants('text')) {
    writeText('content.txt', plan.payload.visibleText)
    writeText('content.md', plan.payload.markdown)
    writeJson('text-inventory.json', plan.payload.text)
    writeText('text-inventory.csv', csv(['text', 'visible', 'tag', 'headingLevel', 'selector', 'linkUrl'], plan.payload.text))
  }
  if (wants('seo-data')) {
    if (plan.kind === 'seo-data') writeJson('audit-report.json', plan.payload.report)
    writeJson('seo-data.json', plan.payload.seo)
    writeJson('structured-data.json', plan.payload.seo.structuredData)
    writeText('seo-summary.md', summaryMarkdown(plan.payload))
  }
  if (wants('links')) {
    const checked: Array<Record<string, unknown>> = []
    for (let index = 0; index < plan.payload.links.length; index++) {
      if (job.cancelled) break
      const link = plan.payload.links[index]
      const probe = await probeLink(link.resolvedUrl, plan.payload.sourceUrl, job)
      checked.push({ ...link, status: probe.status, finalUrl: probe.finalUrl || link.resolvedUrl, error: probe.error || '' })
      emitProgress(sender, { jobId, kind: plan.kind, phase: 'downloading', completed: index + 1, total: plan.payload.links.length, current: link.resolvedUrl })
    }
    writeJson('links.json', checked)
    writeText('links.csv', csv(['originalUrl', 'resolvedUrl', 'anchorText', 'selector', 'rel', 'target', 'external', 'status', 'finalUrl', 'error'], checked))
  }

  const selected = dedupeResources(resourcesForKind(plan.kind, plan.payload))
  const allResourceUsages = resourcesForKind(plan.kind, plan.payload)
  const usagesByUrl = new Map<string, Array<{ source: string; selector?: string; descriptor?: string }>>()
  for (const resource of allResourceUsages) {
    const usages = usagesByUrl.get(resource.url) || []
    usages.push({ source: resource.source, selector: resource.selector, descriptor: resource.descriptor })
    usagesByUrl.set(resource.url, usages)
  }
  const resourceRows: Array<Record<string, unknown>> = []
  const queue = [...selected]
  const queued = new Set(queue.map((item) => item.url))
  for (let index = 0; index < queue.length; index++) {
    if (job.cancelled) break
    const resource = queue[index]
    emitProgress(sender, { jobId, kind: plan.kind, phase: 'downloading', completed: index, total: queue.length, current: resource.url })
    try {
      const response = await fetchResource(resource, plan.payload.sourceUrl, job)
      const extension = extensionFor(response.mimeType, response.finalUrl, resource.kind)
      let rawName = `resource-${index + 1}${extension}`
      try { rawName = `${safeSegment(basename(new URL(response.finalUrl).pathname, extname(new URL(response.finalUrl).pathname)), `resource-${index + 1}`)}${extension}` } catch {}
      const directory = join(folder, resource.kind === 'image' ? 'images' : 'assets')
      mkdirSync(directory, { recursive: true })
      const filePath = uniqueFilePath(directory, rawName)
      atomicWrite(filePath, response.bytes)
      downloaded++
      resourceRows.push({ requestedUrl: resource.url, finalUrl: response.finalUrl, kind: resource.kind, source: resource.source, selector: resource.selector || '', descriptor: resource.descriptor || '', usages: usagesByUrl.get(resource.url) || [{ source: resource.source }], mimeType: response.mimeType || '', bytes: response.bytes.length, localFile: relative(folder, filePath) })

      if (resource.kind === 'stylesheet' && queue.length < MAX_RESOURCES) {
        const css = response.bytes.toString('utf8')
        const dependency = /(?:@import\s+(?:url\()?|url\()\s*(['"]?)([^'"\)\s;]+)\1\s*\)?/gi
        let match: RegExpExecArray | null
        while ((match = dependency.exec(css))) {
          const dependencyUrl = resolveResourceUrl(match[2], response.finalUrl)
          if (!dependencyUrl || queued.has(dependencyUrl) || dependencyUrl.startsWith('data:')) continue
          queued.add(dependencyUrl)
          queue.push({ url: dependencyUrl, kind: kindFromUrl(dependencyUrl), source: `CSS dependency of ${resource.url}` })
        }
      }
    } catch (error) {
      if (job.cancelled) break
      const message = error instanceof Error ? error.message : 'Download failed.'
      failures.push({ url: resource.url, source: resource.source, message })
      resourceRows.push({ requestedUrl: resource.url, finalUrl: '', kind: resource.kind, source: resource.source, selector: resource.selector || '', descriptor: resource.descriptor || '', usages: usagesByUrl.get(resource.url) || [{ source: resource.source }], mimeType: '', bytes: '', localFile: '', error: message })
    }
  }
  if (selected.length || queue.length) {
    writeJson('resources.json', resourceRows)
    writeText('resources.csv', csv(['requestedUrl', 'finalUrl', 'kind', 'source', 'selector', 'descriptor', 'usages', 'mimeType', 'bytes', 'localFile', 'error'], resourceRows))
  }

  emitProgress(sender, { jobId, kind: plan.kind, phase: 'writing', completed: downloaded, total: Math.max(plan.fileCount, downloaded + 2) })
  writeJson('capture-metadata.json', {
    sourceUrl: plan.payload.sourceUrl,
    exportedAt: new Date().toISOString(),
    kind: plan.kind,
    coverage: plan.coverage,
    warnings: plan.warnings,
    captureContext: plan.payload.captureContext || null,
    status: job.cancelled ? 'cancelled' : failures.length ? 'partial' : 'complete'
  })
  writeJson('errors.json', failures)
  skipped = Math.max(0, plan.fileCount - downloaded - failures.length)
  exportedFolders.add(resolve(folder))
  emitProgress(sender, { jobId, kind: plan.kind, phase: job.cancelled ? 'cancelled' : 'complete', completed: downloaded, total: queue.length || plan.fileCount })
  return { success: !job.cancelled, cancelled: job.cancelled, jobId, folderPath: folder, downloaded, skipped, failed: failures }
}

function validateScanRequest(request: AuditExportScanRequest): void {
  if (!request || !['images', 'text', 'links', 'seo-data', 'assets', 'media', 'bundle'].includes(request.kind)) throw new Error('Invalid audit export kind.')
  if (!request.payload || typeof request.payload.html !== 'string' || request.payload.html.length > 50 * 1024 * 1024) throw new Error('Invalid audit export payload.')
  if (typeof request.payload.sourceUrl !== 'string' || request.payload.resources.length > MAX_RESOURCES) throw new Error('Audit export contains too many resources.')
}

export function registerAuditExportHandlers(): void {
  ipcMain.handle('audit-export:scan', async (event, request: AuditExportScanRequest): Promise<AuditExportScanResult> => {
    validateScanRequest(request)
    for (const [key, value] of plans) if (value.expiresAt < Date.now()) plans.delete(key)
    const resources = dedupeResources(resourcesForKind(request.kind, request.payload))
    let knownBytes = 0
    let unknownSizeCount = 0
    for (let index = 0; index < resources.length; index += 8) {
      const results = await Promise.all(resources.slice(index, index + 8).map((resource) => resource.inlineContent
        ? Promise.resolve({ size: Buffer.byteLength(resource.inlineContent), contentType: resource.mimeType })
        : fetchSize(resource.url, request.payload.sourceUrl)))
      for (const result of results) result.size == null ? unknownSizeCount++ : knownBytes += result.size
    }
    const generatedFiles = request.kind === 'text' ? 6 : request.kind === 'links' ? 4 : request.kind === 'seo-data' ? 6 : request.kind === 'bundle' ? 16 : resources.length ? 4 : 2
    const fileCount = resources.length + generatedFiles
    const requiresPreFreezeContext = request.kind === 'assets' || request.kind === 'media' || request.kind === 'seo-data' || request.kind === 'bundle'
    const coverage = !requiresPreFreezeContext || request.payload.captureContext?.complete ? 'complete' : 'partial'
    const warnings = coverage === 'partial' ? ['This legacy capture has no pre-freeze audit context. Removed scripts and structured data may be absent.'] : []
    const result: AuditExportScanResult = {
      planId: randomUUID(), kind: request.kind, fileCount, knownBytes, unknownSizeCount,
      reviewRequired: fileCount > REVIEW_FILE_COUNT || knownBytes > REVIEW_BYTES,
      coverage, warnings
    }
    plans.set(result.planId, { ...result, senderId: event.sender.id, expiresAt: Date.now() + PLAN_TTL_MS, payload: request.payload })
    return result
  })

  ipcMain.handle('audit-export:start', async (event, planId: string): Promise<AuditExportResult> => {
    const plan = plans.get(planId)
    if (!plan || plan.expiresAt < Date.now() || plan.senderId !== event.sender.id) return { success: false, downloaded: 0, skipped: 0, failed: [], error: 'The export plan expired. Scan the page again.' }
    plans.delete(planId)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Choose Audit Export Destination', properties: ['openDirectory', 'createDirectory'] }
    const selected = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
    if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true, downloaded: 0, skipped: 0, failed: [] }
    const existingJobIds = new Set(jobs.keys())
    try { return await runExport(event.sender, plan, selected.filePaths[0]) }
    catch (error) { return { success: false, downloaded: 0, skipped: 0, failed: [], error: error instanceof Error ? error.message : 'Audit export failed.' } }
    finally {
      for (const [jobId, job] of jobs) if (!existingJobIds.has(jobId) && job.senderId === event.sender.id) jobs.delete(jobId)
    }
  })

  ipcMain.handle('audit-export:cancel', (event, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job || job.senderId !== event.sender.id) return { success: false }
    job.cancelled = true
    for (const controller of job.controllers) controller.abort()
    return { success: true }
  })

  ipcMain.handle('audit-export:open-folder', async (_event, folderPath: string) => {
    const resolvedPath = typeof folderPath === 'string' ? resolve(folderPath) : ''
    if (!resolvedPath || !exportedFolders.has(resolvedPath) || !existsSync(resolvedPath)) return { success: false, error: 'This export folder is no longer available.' }
    const error = await shell.openPath(resolvedPath)
    return error ? { success: false, error } : { success: true }
  })

  ipcMain.handle('audit-media:preview', async (_event, request: AuditMediaRequest): Promise<AuditMediaPreviewResult> => {
    try { return await previewMedia(validateMediaRequest(request), request.refererUrl) }
    catch (error) { return { error: error instanceof Error ? error.message : 'Media preview failed.' } }
  })

  ipcMain.handle('audit-media:save', async (event, request: AuditMediaRequest): Promise<AuditMediaSaveResult> => {
    try {
      const resource = validateMediaRequest(request)
      if (resource.url.startsWith('blob:') || resource.url.startsWith('canvas:')) return { error: 'This media was not retained in the captured page.' }
      let stem = 'captured-media'
      try { stem = safeSegment(basename(new URL(resource.url).pathname, extname(new URL(resource.url).pathname)), stem) } catch {
        if (resource.url.startsWith('inline-svg:')) stem = safeSegment(resource.url, 'inline-svg')
      }
      const defaultPath = `${stem}${extensionFor(resource.mimeType, resource.url, resource.kind)}`
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = { title: 'Save Captured Media', defaultPath }
      const selected = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
      if (selected.canceled || !selected.filePath) return { cancelled: true }
      const job: ExportJob = { senderId: event.sender.id, cancelled: false, controllers: new Set() }
      const response = await fetchResource(resource, request.refererUrl, job)
      if (/^(?:text\/html|application\/json)/i.test(response.mimeType || '')) return { error: 'The server returned a page instead of media. The resource may require authentication.' }
      atomicWrite(selected.filePath, response.bytes)
      savedMediaFiles.set(resolve(selected.filePath), event.sender.id)
      while (savedMediaFiles.size > 100) savedMediaFiles.delete(savedMediaFiles.keys().next().value!)
      return { filePath: selected.filePath }
    } catch (error) { return { error: error instanceof Error ? error.message : 'Unable to save media.' } }
  })

  ipcMain.handle('audit-media:reveal', (event, filePath: string) => {
    const resolvedPath = typeof filePath === 'string' ? resolve(filePath) : ''
    if (!resolvedPath || savedMediaFiles.get(resolvedPath) !== event.sender.id || !existsSync(resolvedPath)) return { success: false, error: 'This saved media file is no longer available.' }
    shell.showItemInFolder(resolvedPath)
    return { success: true }
  })
}
