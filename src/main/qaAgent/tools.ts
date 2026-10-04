import { randomUUID } from 'crypto'
import { statSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join } from 'path'
import sharp from 'sharp'
import * as z from 'zod'
import { BREAKPOINTS, type Breakpoint } from '../../shared/designScale'
import type { ApprovalRequest, ApprovalDecision, DesignPutOptions, DesignPutResponse, DesignSlotMeta, DesignSlots, ReportedContext } from '../../shared/qaAgent'
import { buildHtml, buildRows, buildTsv, screenshotColumn, type TrackerFormat } from '../../shared/trackerFormat'
import { planChunks } from './chunks'
import { formatSectionNodes } from './formatNodes'
import { cropJpeg, placeholderJpeg, renderEvidence, renderOverview, thumbnailJpeg, type Rect } from './imageOps'
import type { LiveCaptureOptions, LiveCaptureResult } from './liveCapture'
import type { RunStore } from './runStore'

// The QA tools, defined once. The in-app agent, the local MCP endpoint and the `parity`
// command all call these same definitions; only `finalize_rows` has side effects and it
// waits for a person to approve the rows in Parity.

export const BRIDGE_VERSION = 1
const DEFAULT_WIDTH: Record<Breakpoint, number> = { desktop: 1440, tablet: 834, mobile: 390 }
const MAX_DESIGN_FILE_BYTES = 100 * 1024 * 1024
const DESIGN_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export interface ToolImage {
  data: Buffer
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  /** One line telling the reader what the picture shows. */
  caption: string
  /** Where the same picture was saved, for readers that cannot take inline images. */
  file?: string
}

export interface ToolResult {
  text: string
  images?: ToolImage[]
  isError?: boolean
}

export interface EvidenceUploader {
  /** Why uploads are unavailable (not signed in, not set up), or null when they work. */
  unavailableReason(): string | null
  upload(items: Array<{ name: string; data: Buffer; contentType: string; label: string }>): Promise<Array<{ url?: string; error?: string }>>
}

export interface QaContext {
  now(): number
  reportedContext(): ReportedContext | null
  designs: {
    list(projectKey: string): DesignSlots
    put(projectKey: string, bytes: Uint8Array, options: DesignPutOptions): Promise<DesignPutResponse>
    /** The design resized so one image pixel is one CSS pixel. */
    readNormalized(projectKey: string, breakpoint: Breakpoint): Promise<Buffer | null>
  }
  runs: RunStore
  capture(options: LiveCaptureOptions): Promise<LiveCaptureResult>
  trackerFormat(): TrackerFormat | null
  readLocalFile(path: string): Promise<Buffer>
  approve(request: ApprovalRequest): Promise<ApprovalDecision>
  copyToClipboard(text: string, html: string): void
  evidence?: EvidenceUploader
  onProgress?(message: string): void
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  input: S
  /** No side effects outside Parity's own run folders. */
  readOnly: boolean
  /** Whether headless agent runs may call it; tools that read arbitrary local files are for the person only. */
  agentAllowed: boolean
  run(args: z.infer<S>, context: QaContext): Promise<ToolResult>
}

const defineTool = <S extends z.ZodObject>(tool: ToolDefinition<S>): ToolDefinition<S> => tool

const breakpointSchema = z.enum(['desktop', 'tablet', 'mobile']).describe('Which design to compare: desktop, tablet or mobile.')
const runIdSchema = z.string().min(8).max(80).describe('The runId returned by capture_live.')
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
const evidenceSchema = z.object({
  breakpoint: breakpointSchema,
  section: z.string().regex(/^S\d+$/).optional().describe('Section id such as S3, used when no live area is given.'),
  design: rectSchema.optional().describe('The issue area on the design, in CSS px (design px divided by the export scale).'),
  live: rectSchema.optional().describe('The issue area on the live page, in CSS px.'),
  caption: z.string().max(200).optional(),
})
const rowSchema = z.object({
  cells: z.record(z.string(), z.coerce.string()).describe('Cell text keyed by tracker column name.'),
  evidence: evidenceSchema.optional(),
})

const fail = (text: string): ToolResult => ({ text, isError: true })

export function pagePathOf(url: string): string | undefined {
  try { return new URL(url).pathname || '/' } catch { return undefined }
}

const describeSlot = (slot: DesignSlotMeta | undefined) =>
  slot ? { frameWidth: slot.frameWidth, frameHeight: slot.frameHeight, exportScale: slot.scale, pixelSize: `${slot.pixelWidth}x${slot.pixelHeight}`, file: slot.fileName ?? null, forPage: slot.pagePath ?? null, confidence: slot.confidence } : null

function requireContext(context: QaContext): ReportedContext | string {
  const reported = context.reportedContext()
  if (!reported) return 'No project is open in Parity. Open the project and its staging page, then try again.'
  return reported
}

function loadRun(context: QaContext, runId: string, reported: ReportedContext): { ok: true; pageUrl: string } | { ok: false; error: string } {
  let meta
  try { meta = context.runs.get(runId) } catch { meta = null }
  if (!meta) return { ok: false, error: `There is no run "${runId}". Call capture_live first and use the runId it returns.` }
  if (meta.projectKey !== reported.projectKey) return { ok: false, error: 'That run belongs to a different project than the one open in Parity.' }
  return { ok: true, pageUrl: meta.pageUrl }
}

function suggestDesignRange(live: { top: number; bottom: number }, liveHeight: number, designHeight: number): { top: number; bottom: number } {
  if (!liveHeight || !designHeight) return live
  const k = designHeight / liveHeight
  return { top: Math.round(live.top * k), bottom: Math.round(live.bottom * k) }
}

async function sizeOf(image: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(image).metadata()
  return { width: meta.width || 0, height: meta.height || 0 }
}

// ── get_context ─────────────────────────────────────────────────────────────────────

const getContext = defineTool({
  name: 'get_context',
  title: 'Get QA context',
  description: 'Shows what is open in Parity: the project and page, which Figma designs are stored per breakpoint, the tracker format, and the latest run. Call this first.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  async run(_args, context) {
    const reported = context.reportedContext()
    const format = context.trackerFormat()
    const slots = reported ? context.designs.list(reported.projectKey) : {}
    const latest = reported ? context.runs.latest(reported.projectKey) : null
    const notes: string[] = []
    if (!reported) notes.push('No project is open in Parity.')
    else {
      const page = pagePathOf(reported.pageUrl)
      for (const bp of BREAKPOINTS) {
        const slot = slots[bp]
        if (slot?.pagePath && page && slot.pagePath !== page) notes.push(`The ${bp} design was added for ${slot.pagePath} but the open page is ${page}. Check it is the right design.`)
      }
      if (!BREAKPOINTS.some((bp) => slots[bp])) notes.push('No designs are stored. Add the Figma PNGs in the Figma overlay panel, or call set_design.')
    }
    if (!format) notes.push('The tracker format is not set. In Parity: Settings → AI Agents → paste the tracker header row and a few example rows.')
    const evidenceReason = context.evidence ? context.evidence.unavailableReason() : 'Evidence uploads are not set up.'
    const info = {
      bridgeVersion: BRIDGE_VERSION,
      project: reported ? { name: reported.project.name, stagingUrl: reported.project.stagingUrl } : null,
      openPage: reported ? { url: reported.pageUrl, workspace: reported.workspaceTab, breakpointInView: reported.breakpoint, viewport: reported.viewport } : null,
      designs: { desktop: describeSlot(slots.desktop), tablet: describeSlot(slots.tablet), mobile: describeSlot(slots.mobile) },
      tracker: format ? { columns: format.columns, screenshotColumn: screenshotColumn(format), exampleRows: format.examples } : null,
      evidenceUploads: evidenceReason ? { available: false, reason: evidenceReason } : { available: true },
      latestRun: latest ? { runId: latest.id, page: latest.pageUrl } : null,
      notes,
    }
    return { text: JSON.stringify(info, null, 2) }
  },
})

// ── set_design ──────────────────────────────────────────────────────────────────────

const setDesign = defineTool({
  name: 'set_design',
  title: 'Store a design image',
  description: 'Stores a Figma export (PNG, JPEG or WebP) from a file on this computer as the design for a breakpoint. Without a breakpoint it is assigned by its width.',
  input: z.object({
    path: z.string().min(1).max(1000).describe('Absolute path of the image file.'),
    breakpoint: breakpointSchema.optional(),
  }),
  readOnly: false,
  agentAllowed: false,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    if (!isAbsolute(args.path)) return fail('Give the absolute path of the image file.')
    if (!DESIGN_EXTENSIONS.has(extname(args.path).toLowerCase())) return fail('Only .png, .jpg, .jpeg and .webp images can be stored.')
    let bytes: Buffer
    try {
      if (statSync(args.path).size > MAX_DESIGN_FILE_BYTES) return fail('That image is over 100 MB.')
      bytes = await context.readLocalFile(args.path)
    } catch {
      return fail('That file could not be read.')
    }
    const result = await context.designs.put(reported.projectKey, bytes, { fileName: basename(args.path), pagePath: pagePathOf(reported.pageUrl), target: args.breakpoint ?? 'auto' })
    if (!result.success) return fail(result.error)
    const slot = result.slots[result.assigned]
    return { text: `${result.unchanged ? 'Already stored' : 'Stored'} as the ${result.assigned} design: ${slot?.frameWidth}px wide frame, export scale ${slot?.scale}x${slot?.confidence === 'low' ? ' (the scale is a guess; check it in Parity)' : ''}.` }
  },
})

// ── capture_live ────────────────────────────────────────────────────────────────────

async function overviewResult(context: QaContext, runId: string, breakpoint: Breakpoint, part: number): Promise<ToolResult> {
  const live = context.runs.readLive(runId, breakpoint)
  if (!live) return fail(`Run ${runId} has no ${breakpoint} capture yet. Call capture_live first.`)
  const design = context.runs.readDesign(runId, breakpoint)
  const parts = await renderOverview({ width: live.record.width, design, live: live.png, sections: live.record.sections })
  if (part < 1 || part > parts.length) return fail(`The overview has ${parts.length} part(s); ask for a part between 1 and ${parts.length}.`)
  const chosen = parts[part - 1]
  const file = join(context.runs.cropsDir(runId, breakpoint), `overview-${part}.jpg`)
  writeFileSync(file, chosen.jpeg)
  const more = parts.length > 1 ? ` This is part ${part} of ${parts.length}; the page is tall, so call get_overview with the other parts.` : ''
  return {
    text: `Overview of the ${breakpoint} page: design on the left (y ruler in CSS px), live on the right with red section boxes S1, S2, … Both columns use one scale (1 px here = ${(1 / chosen.scale).toFixed(1)} CSS px), covering y ${chosen.yFrom}–${chosen.yTo}.${more}`,
    images: [{ data: chosen.jpeg, mimeType: 'image/jpeg', caption: `Overview ${breakpoint}, y ${chosen.yFrom}-${chosen.yTo}`, file }],
  }
}

const captureLive = defineTool({
  name: 'capture_live',
  title: 'Capture the live page',
  description: 'Captures the staging page open in Parity at the design\'s width for a breakpoint, reads its computed values, finds its sections (S1, S2, …) and returns an overview picture. The first call starts a run; pass its runId to later calls.',
  input: z.object({
    breakpoint: breakpointSchema,
    runId: z.string().min(8).max(80).optional().describe('Reuse a run to capture another breakpoint of the same page.'),
    refresh: z.boolean().optional().describe('Capture again even if this breakpoint was already captured in the run.'),
  }),
  readOnly: true,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)

    let runId = args.runId
    let pageUrl = reported.pageUrl
    if (runId) {
      const run = loadRun(context, runId, reported)
      if (!run.ok) return fail(run.error)
      pageUrl = run.pageUrl // a run stays bound to the page it started on
    } else {
      runId = context.runs.create({ projectKey: reported.projectKey, projectName: reported.project.name, pageUrl }).id
    }

    const existing = context.runs.readLive(runId, args.breakpoint)
    const slot = context.designs.list(reported.projectKey)[args.breakpoint]
    const width = slot?.frameWidth ?? DEFAULT_WIDTH[args.breakpoint]
    const lines: string[] = []

    if (!existing || args.refresh) {
      let capture: LiveCaptureResult
      try {
        capture = await context.capture({ url: pageUrl, breakpoint: args.breakpoint, width, onProgress: context.onProgress })
      } catch (error: any) {
        return fail(`The page could not be captured: ${error?.message || 'unknown error'}`)
      }
      const designPng = slot ? await context.designs.readNormalized(reported.projectKey, args.breakpoint) : null
      context.runs.saveCapture(runId, args.breakpoint, capture, slot && designPng ? { png: designPng, meta: slot } : null)
    } else {
      lines.push('This breakpoint was already captured in this run; showing it again (use refresh to capture anew).')
    }

    const stored = context.runs.readLive(runId, args.breakpoint)!
    const record = stored.record
    const designPng = context.runs.readDesign(runId, args.breakpoint)
    const designHeight = designPng ? (await sizeOf(designPng)).height : 0
    if (!slot) lines.push(`No ${args.breakpoint} design is stored, so the page was captured at ${width}px. Add the design in Parity (Figma overlay panel) to compare.`)

    lines.unshift(`Run ${runId} · ${args.breakpoint} · ${record.finalUrl}`)
    lines.push(`Live page: ${record.width}px wide, ${record.documentHeight}px tall (${record.capturedHeight}px captured, ${record.tiles} screens, ${record.mode}). Browser window height ${record.viewportHeight}px. Coordinates below are CSS px.`)
    if (designPng && slot) lines.push(`Design: ${slot.frameWidth}px wide frame (${slot.scale}x export), ${designHeight}px tall in CSS px.`)
    if (record.truncated) lines.push('NOTE: the capture is cut short; the bottom of the page is not included.')
    if (record.warnings.length) lines.push('Warnings:', ...record.warnings.map((warning) => `- ${warning}`))
    lines.push('Sections (live page):')
    for (const section of record.sections) {
      const live = { top: section.top, bottom: section.top + section.height }
      const suggested = designPng ? suggestDesignRange(live, record.capturedHeight, designHeight) : null
      lines.push(`- ${section.id} "${section.label}" y ${live.top}–${live.bottom}${section.bgFixed ? ' (fixed background)' : ''}${suggested ? ` · design y ≈ ${suggested.top}–${suggested.bottom} (proportional guess; correct it from the overview)` : ''}`)
    }
    if (!record.sections.length) lines.push('- (none found; the page has no recognisable top-level blocks)')
    lines.push('Next: look at the overview, then call get_section for each section with the design y range you matched to it.')

    const overview = await overviewResult(context, runId, args.breakpoint, 1)
    return { text: lines.join('\n'), images: overview.images }
  },
})

const getOverview = defineTool({
  name: 'get_overview',
  title: 'Get the overview picture',
  description: 'Returns the side-by-side overview (design left, live right with section boxes) for a captured breakpoint. Very tall pages have several parts.',
  input: z.object({ runId: runIdSchema, breakpoint: breakpointSchema, part: z.number().int().min(1).max(12).optional() }),
  readOnly: true,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    const run = loadRun(context, args.runId, reported)
    if (!run.ok) return fail(run.error)
    return overviewResult(context, args.runId, args.breakpoint, args.part ?? 1)
  },
})

// ── get_section ─────────────────────────────────────────────────────────────────────

const getSection = defineTool({
  name: 'get_section',
  title: 'Get a section to compare',
  description: 'Returns the design crop and the live crop of one section at full detail, plus that section\'s computed values (font, size, colour, spacing). Give the design y range you matched to the section; tall sections come in parts.',
  input: z.object({
    runId: runIdSchema,
    breakpoint: breakpointSchema,
    section: z.string().regex(/^S\d+$/).describe('Section id from capture_live, such as S3.'),
    designTop: z.number().min(0).optional().describe('Top of the matching design area, in CSS px. Defaults to a proportional guess.'),
    designBottom: z.number().min(1).optional(),
    part: z.number().int().min(1).max(30).optional().describe('Which part of a tall section (default 1).'),
    cropX: z.number().min(0).optional().describe('For frames wider than 1568px: left edge of a 1:1 band.'),
    cropWidth: z.number().min(100).max(1568).optional(),
  }),
  readOnly: true,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    const run = loadRun(context, args.runId, reported)
    if (!run.ok) return fail(run.error)
    const live = context.runs.readLive(args.runId, args.breakpoint)
    if (!live) return fail(`Run ${args.runId} has no ${args.breakpoint} capture. Call capture_live first.`)
    const section = live.record.sections.find((candidate) => candidate.id === args.section)
    if (!section) return fail(`There is no section ${args.section}. The sections are: ${live.record.sections.map((s) => s.id).join(', ') || 'none'}.`)

    const designPng = context.runs.readDesign(args.runId, args.breakpoint)
    const designHeight = designPng ? (await sizeOf(designPng)).height : 0
    const liveRange = { top: section.top, bottom: section.top + section.height }
    let designRange: { top: number; bottom: number } | null = null
    let designSource = ''
    if (designPng) {
      if (args.designTop !== undefined && args.designBottom !== undefined) {
        if (args.designBottom <= args.designTop) return fail('designBottom must be greater than designTop.')
        designRange = { top: Math.round(args.designTop), bottom: Math.round(Math.min(args.designBottom, designHeight)) }
        designSource = 'as given'
      } else {
        const remembered = context.runs.readSectionRanges(args.runId, args.breakpoint)[section.id]
        designRange = remembered ? { top: remembered.designTop, bottom: remembered.designBottom } : suggestDesignRange(liveRange, live.record.capturedHeight, designHeight)
        designSource = remembered ? 'as chosen earlier' : 'proportional guess, so check that both pictures show the same content'
      }
      context.runs.saveSectionRange(args.runId, args.breakpoint, section.id, { designTop: designRange.top, designBottom: designRange.bottom })
    }

    const plan = planChunks({ width: live.record.width, live: liveRange, design: designRange })
    const part = args.part ?? 1
    if (part > plan.length) return fail(`Section ${section.id} has ${plan.length} part(s); ask for a part between 1 and ${plan.length}.`)
    const chunk = plan[part - 1]
    const scale = chunk.scale
    const band = args.cropWidth ? { x: Math.round(args.cropX ?? 0), width: Math.round(args.cropWidth), scale: 1 } : { x: 0, width: live.record.width, scale }

    const folder = context.runs.cropsDir(args.runId, args.breakpoint)
    const images: ToolImage[] = []
    const stem = `${section.id}-p${part}`
    if (designPng && chunk.design) {
      const jpeg = await cropJpeg(designPng, { x: band.x, y: chunk.design.top, width: band.width, height: chunk.design.bottom - chunk.design.top }, band.scale)
      const data = jpeg ?? await placeholderJpeg(400, 80, 'The design has nothing at this height')
      const file = join(folder, `${stem}-design.jpg`)
      writeFileSync(file, data)
      images.push({ data, mimeType: 'image/jpeg', caption: `Design, y ${chunk.design.top}–${chunk.design.bottom}`, file })
    }
    const liveJpeg = await cropJpeg(live.png, { x: band.x, y: chunk.live.top, width: band.width, height: chunk.live.bottom - chunk.live.top }, band.scale)
    const liveData = liveJpeg ?? await placeholderJpeg(400, 80, 'The capture has nothing at this height')
    const liveFile = join(folder, `${stem}-live.jpg`)
    writeFileSync(liveFile, liveData)
    images.push({ data: liveData, mimeType: 'image/jpeg', caption: `Live, y ${chunk.live.top}–${chunk.live.bottom}`, file: liveFile })

    const styles = formatSectionNodes(live.record.nodes, section.id, 80, chunk.live)
    const lines = [
      `Section ${section.id} "${section.label}" · ${args.breakpoint} · part ${part} of ${plan.length}`,
      `Live y ${chunk.live.top}–${chunk.live.bottom}${section.bgFixed ? ' (fixed background)' : ''}${designRange && chunk.design ? ` · design y ${chunk.design.top}–${chunk.design.bottom} (${designSource})` : ''}.`,
      designPng ? `Image 1 is the design, image 2 is the live page${args.cropWidth ? `, a 1:1 band x ${band.x}–${band.x + band.width}` : ''}.` : 'There is no design for this breakpoint, so only the live page is shown.',
      `Scale 1 : ${(1 / band.scale).toFixed(2)}. To get a CSS y position from a picture: chunkTop + imageY / ${band.scale.toFixed(3)}.`,
      designPng ? 'Design pixel sizes are estimates from the picture; the live values below are exact.' : '',
      `Computed values on the live page (${styles.lines.length} of ${styles.total} elements in this part${styles.omitted ? `, ${styles.omitted} more not listed` : ''}):`,
      ...styles.lines,
      `Saved crops: ${images.map((image) => image.file).join(', ')}`,
    ].filter(Boolean)
    return { text: lines.join('\n'), images }
  },
})

// ── save_draft ──────────────────────────────────────────────────────────────────────

const saveDraft = defineTool({
  name: 'save_draft',
  title: 'Save draft rows',
  description: 'Saves the issues found for one breakpoint in the run folder, so they survive a long conversation, and checks them against the tracker\'s columns.',
  input: z.object({ runId: runIdSchema, breakpoint: breakpointSchema, rows: z.array(rowSchema).max(60) }),
  readOnly: true,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    const run = loadRun(context, args.runId, reported)
    if (!run.ok) return fail(run.error)
    const format = context.trackerFormat()
    if (format && args.rows.length) {
      const checked = buildRows(format, args.rows.map((row) => row.cells))
      if (!checked.ok) return fail(checked.error)
    }
    context.runs.saveDraft(args.runId, args.breakpoint, args.rows)
    return { text: `Saved ${args.rows.length} draft row(s) for ${args.breakpoint} in run ${args.runId}.` }
  },
})

// ── finalize_rows ───────────────────────────────────────────────────────────────────

const SEVERITY_HEADER = /severity|priority|impact/i

async function renderRowEvidence(context: QaContext, runId: string, row: z.infer<typeof rowSchema>, index: number): Promise<{ data: Buffer; caption: string } | null> {
  const evidence = row.evidence
  if (!evidence) return null
  const live = context.runs.readLive(runId, evidence.breakpoint)
  if (!live) return null
  const design = context.runs.readDesign(runId, evidence.breakpoint)
  let liveRect: Rect | undefined = evidence.live
  if (!liveRect && evidence.section) {
    const section = live.record.sections.find((s) => s.id === evidence.section)
    if (section) liveRect = { x: 0, y: section.top, width: live.record.width, height: Math.min(section.height, 700) }
  }
  if (!liveRect && !evidence.design) return null
  const caption = (evidence.caption || Object.values(row.cells)[0] || `Row ${index + 1}`).slice(0, 160)
  const data = await renderEvidence({
    design, live: live.png, designRect: evidence.design, liveRect,
    header: { design: `Design · ${evidence.breakpoint} ${live.record.design?.frameWidth ?? ''}px`.trim(), live: `Live · ${live.record.width}px · ${new URL(live.record.finalUrl).pathname}` },
    caption,
  }).catch(() => null)
  return data ? { data, caption } : null
}

const finalizeRows = defineTool({
  name: 'finalize_rows',
  title: 'Hand over the rows',
  description: 'Shows the drafted rows to the person in Parity for approval. If they approve, the evidence images are uploaded (when set up) and the rows are copied to the clipboard in tracker column order, ready to paste into the sheet. Waits for the decision.',
  input: z.object({
    runId: runIdSchema,
    rows: z.array(rowSchema).min(1).max(60),
    uploadEvidence: z.boolean().optional().describe('Set false to copy the rows without uploading evidence images.'),
  }),
  readOnly: false,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    const run = loadRun(context, args.runId, reported)
    if (!run.ok) return fail(run.error)
    const format = context.trackerFormat()
    if (!format) return fail('The tracker format is not set. In Parity: Settings → AI Agents → paste the tracker header row and a few example rows.')
    const built = buildRows(format, args.rows.map((row) => row.cells))
    if (!built.ok) return fail(built.error)

    const output = context.runs.outputDir(args.runId)
    const stamp = String(context.now())
    const evidenceFiles: Array<{ rowIndex: number; data: Buffer; caption: string; file: string }> = []
    for (const [index, row] of args.rows.entries()) {
      const rendered = await renderRowEvidence(context, args.runId, row, index)
      if (!rendered) continue
      const file = join(output, `evidence-${stamp}-row-${String(index + 1).padStart(2, '0')}.webp`)
      writeFileSync(file, rendered.data)
      evidenceFiles.push({ rowIndex: index, data: rendered.data, caption: rendered.caption, file })
    }

    const wantsUpload = args.uploadEvidence !== false && evidenceFiles.length > 0
    const uploadProblem = !wantsUpload ? null : context.evidence ? context.evidence.unavailableReason() : 'Evidence uploads are not set up yet.'
    const shotColumn = screenshotColumn(format)
    const willUpload = wantsUpload && !uploadProblem && !!shotColumn
    const warnings = [...built.warnings]
    if (wantsUpload && uploadProblem) warnings.push(`Evidence images were not uploaded: ${uploadProblem} The screenshot column is left empty.`)
    if (wantsUpload && !uploadProblem && !shotColumn) warnings.push('Evidence images were not uploaded because no screenshot column was found in the tracker header.')

    const severityColumn = format.columns.find((name) => SEVERITY_HEADER.test(name))
    const severityIndex = severityColumn ? format.columns.indexOf(severityColumn) : -1
    const severityCounts: Record<string, number> = {}
    if (severityIndex >= 0) for (const row of built.rows) { const key = row[severityIndex].trim() || '(blank)'; severityCounts[key] = (severityCounts[key] || 0) + 1 }

    const thumbnails = await Promise.all(evidenceFiles.map(async (item) => ({ rowIndex: item.rowIndex, caption: item.caption, thumbnail: `data:image/jpeg;base64,${(await thumbnailJpeg(item.data)).toString('base64')}` })))
    const decision = await context.approve({
      id: randomUUID(), runId: args.runId, projectName: reported.project.name, pageUrl: run.pageUrl,
      columns: format.columns, rows: built.rows, severityCounts, evidence: thumbnails, warnings, uploadsEvidence: willUpload,
    })
    if (!decision.approved) {
      return { text: `The person did not approve these rows${decision.note ? `. Their note: ${decision.note}` : '.'} Nothing was copied or uploaded. Revise the rows and call finalize_rows again.` }
    }

    const rows = built.rows.map((row) => [...row])
    const outcome: string[] = []
    if (willUpload && shotColumn) {
      const column = format.columns.indexOf(shotColumn)
      const results = await context.evidence!.upload(evidenceFiles.map((item) => ({ name: basename(item.file), data: item.data, contentType: 'image/webp', label: item.caption })))
      let uploaded = 0
      results.forEach((result, i) => {
        if (result.url) { rows[evidenceFiles[i].rowIndex][column] = result.url; uploaded++ }
        else outcome.push(`Row ${evidenceFiles[i].rowIndex + 1}: evidence not uploaded (${result.error || 'unknown error'}).`)
      })
      outcome.unshift(`Uploaded ${uploaded} of ${evidenceFiles.length} evidence image(s) and put their links in "${shotColumn}".`)
    } else if (evidenceFiles.length) {
      const reason = args.uploadEvidence === false ? 'Uploads were turned off for this run.' : uploadProblem ?? 'No screenshot column was found in the tracker header.'
      outcome.push(`Evidence images were not uploaded: ${reason} They were saved on this computer: ${output}`)
    }

    const tsv = buildTsv(rows)
    context.copyToClipboard(tsv, buildHtml(rows))
    const tsvPath = join(output, `rows-${stamp}.tsv`)
    writeFileSync(tsvPath, tsv, 'utf8')
    return {
      text: [`Approved. Copied ${rows.length} row(s) to the clipboard in tracker column order; paste them into the sheet.`, ...outcome, ...warnings.filter((w) => !w.startsWith('Evidence images were not uploaded')), `A copy of the rows is saved at ${tsvPath}.`].join('\n'),
    }
  },
})

export const QA_TOOLS = [getContext, setDesign, captureLive, getOverview, getSection, saveDraft, finalizeRows] as const

export type QaToolName = (typeof QA_TOOLS)[number]['name']

export function findTool(name: string): ToolDefinition | undefined {
  return QA_TOOLS.find((tool) => tool.name === name) as unknown as ToolDefinition | undefined
}

/** Runs a tool by name with untrusted input: validates it, and turns any failure into an error result. */
export async function callTool(name: string, rawArgs: unknown, context: QaContext): Promise<ToolResult> {
  const tool = findTool(name)
  if (!tool) return fail(`Unknown tool "${name}". The tools are: ${QA_TOOLS.map((t) => t.name).join(', ')}.`)
  const parsed = tool.input.safeParse(rawArgs ?? {})
  if (!parsed.success) return fail(`Invalid input for ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`)
  try {
    return await tool.run(parsed.data, context)
  } catch (error: any) {
    return fail(`${name} failed: ${error?.message || 'unknown error'}`)
  }
}
