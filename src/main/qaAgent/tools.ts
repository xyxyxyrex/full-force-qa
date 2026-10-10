import { randomUUID } from 'crypto'
import { statSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join } from 'path'
import sharp from 'sharp'
import * as z from 'zod'
import { BREAKPOINTS, type Breakpoint } from '../../shared/designScale'
import type { ApprovalRequest, ApprovalDecision, DesignPutOptions, DesignPutResponse, DesignSlotMeta, DesignSlots, ReportedContext, QaHandOverRecord } from '../../shared/qaAgent'
import { buildHtml, buildRows, buildTsv, rowView, screenshotColumn, trackerColumnGuide, type TrackerFormat } from '../../shared/trackerFormat'
import { designKeyOf, pageIdOf } from '../../shared/designKey'
import { planChunks } from './chunks'
import { formatSectionNodes } from './formatNodes'
import { cropJpeg, placeholderJpeg, renderEvidence, renderOverview, thumbnailJpeg, type Rect } from './imageOps'
import type { LiveCaptureOptions, LiveCaptureResult } from './liveCapture'
import type { RunStore } from './runStore'
import { DEFAULT_WIDTH, defineTool, fail, loadRun, requireContext, type ToolDefinition, type ToolImage, type ToolResult } from './toolBasics'
import { BROWSER_TOOLS } from './browserTools'
import type { QaBrowser } from './qaBrowserTypes'
import { readResultTool } from './execution'
import type { RemarkStyle } from '../../shared/remarkStyle'
import type { WorkspaceService } from '../workspaceService'
import type { WorkspaceProposal } from '../../shared/parityWorkspace'
import { WORKSPACE_TOOLS } from './workspaceTools'
import { readChatImages } from './chatImageTool'

export type { ToolDefinition, ToolImage, ToolResult }

// The QA tools, defined once. The in-app agent, the local MCP endpoint and the `parity`
// command all call these same definitions; only `finalize_rows` has side effects and it
// waits for a person to approve the rows in Parity.

export const BRIDGE_VERSION = 1
const MAX_DESIGN_FILE_BYTES = 100 * 1024 * 1024
const DESIGN_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])



export interface EvidenceUploader {
  /** Why uploads are unavailable (not signed in, not set up), or null when they work. */
  unavailableReason(): string | null
  upload(items: Array<{ name: string; data: Buffer; contentType: string; label: string }>): Promise<Array<{ url?: string; error?: string }>>
}

export interface QaContext {
  chatImages?(ids: string[]): Promise<ToolImage[]>
  workspace?: WorkspaceService
  workspaceProposal?(proposal: WorkspaceProposal): void
  appContext?(): unknown
  assertAccess?(): void
  agentAccess?: boolean
  allowedTools?: Set<string>
  authorizeTool?(name:string,args:unknown):Promise<void>
  now(): number
  reportedContext(): ReportedContext | null
  /**
   * Makes `reportedContext()` answer with this page until set to null. A batch review uses it so that agents
   * reaching the tools over the bridge (agent CLIs) also see the page being reviewed, not the one that happens to be open.
   */
  setTarget?(target: ReportedContext | null): void
  designs: {
    list(projectKey: string): DesignSlots
    put(projectKey: string, bytes: Uint8Array, options: DesignPutOptions): Promise<DesignPutResponse>
    /** The design resized so one image pixel is one CSS pixel. */
    readNormalized(projectKey: string, breakpoint: Breakpoint): Promise<Buffer | null>
  }
  runs: RunStore
  capture(options: LiveCaptureOptions): Promise<LiveCaptureResult>
  trackerFormat(): TrackerFormat | null
  remarkStyle?(): RemarkStyle
  organizer?: {
    save(runId: string, breakpoint: Breakpoint, rows: DraftRow[], area: 'visual' | 'functional'): Promise<DraftRow[]>
    finalize(entries: HandOverEntry[]): Promise<string[]>
  }
  readLocalFile(path: string): Promise<Buffer>
  approve(request: ApprovalRequest): Promise<ApprovalDecision>
  copyToClipboard(text: string, html: string): void
  evidence?: EvidenceUploader
  onProgress?(message: string): void
  /** The agent's own browser, for testing the page like a visitor. */
  browser?: QaBrowser
  /** Whether the person lets the agent submit forms and send API requests on the site under review. */
  allowSend?(): boolean
  dispatchTool?(name: string, args: unknown, work: () => Promise<ToolResult>): Promise<ToolResult>
  readResult?(id: string, offset: number): { text: string; total: number; nextOffset: number | null }
}



const breakpointSchema = z.enum(['desktop', 'tablet', 'mobile']).describe('Which design to compare: desktop, tablet or mobile.')
const runIdSchema = z.string().min(8).max(80).describe('The runId returned by capture_live.')
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
const evidenceSchema = z.object({
  breakpoint: breakpointSchema,
  section: z.string().regex(/^S\d+$/).optional().describe('Section id such as S3, used when no live area is given.'),
  screenshot: z.string().regex(/^B\d{1,4}$/).optional().describe('A screenshot from the agent\'s browser, such as B3, for a finding seen while testing; live is then the area in that screenshot.'),
  design: rectSchema.optional().describe('The issue area on the design, in CSS px (design px divided by the export scale).'),
  live: rectSchema.optional().describe('The issue area on the live page, in CSS px.'),
  caption: z.string().max(200).optional(),
})
const rowSchema = z.object({
  findingId: z.string().uuid().optional(),
  sourceFindingIds: z.array(z.string().uuid()).max(120).optional().describe('Keep the IDs returned by save_draft. When merging breakpoints, include every source finding ID.'),
  cells: z.record(z.string(), z.coerce.string()).describe('Cell text keyed by tracker column name.'),
  evidence: evidenceSchema.optional(),
})


export function pagePathOf(url: string): string | undefined {
  try { return new URL(url).pathname || '/' } catch { return undefined }
}

/** Designs belong to one page of a project; this is where the open page's designs are kept. */
const designsKey = (reported: ReportedContext) => designKeyOf(reported.projectKey, reported.pageUrl)

const describeSlot = (slot: DesignSlotMeta | undefined) =>
  slot ? { frameWidth: slot.frameWidth, frameHeight: slot.frameHeight, exportScale: slot.scale, pixelSize: `${slot.pixelWidth}x${slot.pixelHeight}`, file: slot.fileName ?? null, forPage: slot.pagePath ?? null, confidence: slot.confidence } : null



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
  description: 'Shows what is open in Parity: the project and page, which Figma designs (optional) are stored per breakpoint, the tracker format, and the latest run. Call this first.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  async run(_args, context) {
    const reported = context.reportedContext()
    const format = context.trackerFormat()
    const slots = reported ? context.designs.list(designsKey(reported)) : {}
    const latest = reported ? context.runs.latest(reported.projectKey) : null
    const notes: string[] = []
    if (!reported) notes.push('No project is open in Parity.')
    else {
      // Designs are kept per page, so these are the open page's own; there is nothing to mismatch.
      // Designs are optional: without one the page is judged on its own. Never a reason to ask the person.
      if (!BREAKPOINTS.some((bp) => slots[bp])) notes.push(`No designs are stored for this page (${pageIdOf(reported.pageUrl) ?? reported.pageUrl}), so review it on its own. That is fine; do not ask for a design.`)
    }
    if (!format) notes.push('The tracker format is not set. In Parity: Settings → AI Agents → paste the tracker header row and a few example rows.')
    const evidenceReason = context.evidence ? context.evidence.unavailableReason() : 'Evidence uploads are not set up.'
    const info = {
      bridgeVersion: BRIDGE_VERSION,
      project: reported ? { name: reported.project.name, stagingUrl: reported.project.stagingUrl } : null,
      openPage: reported ? { url: reported.pageUrl, workspace: reported.workspaceTab, breakpointInView: reported.breakpoint, viewport: reported.viewport } : null,
      designsAreFor: reported ? (pageIdOf(reported.pageUrl) ?? reported.pageUrl) : null,
      designs: { desktop: describeSlot(slots.desktop), tablet: describeSlot(slots.tablet), mobile: describeSlot(slots.mobile) },
      tracker: format ? { columns: format.columns, screenshotColumn: screenshotColumn(format), columnGuide: trackerColumnGuide(format, context.remarkStyle?.()), exampleRows: format.examples } : null,
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
    const result = await context.designs.put(designsKey(reported), bytes, { fileName: basename(args.path), pagePath: pageIdOf(reported.pageUrl) ?? undefined, target: args.breakpoint ?? 'auto' })
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
    // A run stays on the page it started on, and so do the designs it compares with.
    const designPageKey = designKeyOf(reported.projectKey, pageUrl)
    const slot = context.designs.list(designPageKey)[args.breakpoint]
    const width = slot?.frameWidth ?? DEFAULT_WIDTH[args.breakpoint]
    const lines: string[] = []

    if (!existing || args.refresh) {
      let capture: LiveCaptureResult
      try {
        capture = await context.capture({ url: pageUrl, breakpoint: args.breakpoint, width, onProgress: context.onProgress })
      } catch (error: any) {
        return fail(`The page could not be captured: ${error?.message || 'unknown error'}`)
      }
      const designPng = slot ? await context.designs.readNormalized(designPageKey, args.breakpoint) : null
      context.runs.saveCapture(runId, args.breakpoint, capture, slot && designPng ? { png: designPng, meta: slot } : null)
    } else {
      lines.push('This breakpoint was already captured in this run; showing it again (use refresh to capture anew).')
    }

    const stored = context.runs.readLive(runId, args.breakpoint)!
    const record = stored.record
    const designPng = context.runs.readDesign(runId, args.breakpoint)
    const designHeight = designPng ? (await sizeOf(designPng)).height : 0
    if (!slot) lines.push(`No ${args.breakpoint} design is stored, so the page was captured at ${width}px. Judge it on its own.`)

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
  description: 'Saves the issues found for one breakpoint in the run folder, so they survive a long conversation, and checks them against the tracker\'s columns. Saving again for the same breakpoint and area replaces the earlier rows. Use area "functional" for what you found by testing the page in your browser.',
  input: z.object({
    runId: runIdSchema,
    breakpoint: breakpointSchema,
    rows: z.array(rowSchema).max(60),
    area: z.enum(['visual', 'functional']).optional().describe('visual (default): from looking at the page. functional: from testing it in your browser.'),
  }),
  readOnly: true,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    const run = loadRun(context, args.runId, reported)
    if (!run.ok) return fail(run.error)
    const format = context.trackerFormat()
    if (format && args.rows.length) {
      const checked = buildRows(format, args.rows.map((row) => row.cells), { remarkStyle: context.remarkStyle?.() })
      if (!checked.ok) return fail(checked.error)
    }
    // A browser screenshot named as evidence must exist, or the finding would have no picture.
    const missing = [...new Set(args.rows.flatMap((row) => (row.evidence?.screenshot && !context.runs.readBrowserShot(args.runId, row.evidence.screenshot) ? [row.evidence.screenshot] : [])))]
    if (missing.length) return fail(`Run ${args.runId} has no browser screenshot ${missing.join(', ')}. Name a screenshot from a browser result of this run.`)
    const area = args.area ?? 'visual'
    const safeRows = args.rows.map(row => ({ ...row, cells: Object.fromEntries(Object.entries(row.cells).map(([key,value])=>[key, /priority|severity|impact/i.test(key) ? '' : value])) }))
    const rows = context.organizer ? await context.organizer.save(args.runId, args.breakpoint, safeRows, area) : safeRows
    context.runs.saveDraft(args.runId, args.breakpoint, rows, area)
    return { text: `Saved ${rows.length} ${area === 'functional' ? 'functional ' : ''}draft row(s) for ${args.breakpoint} in run ${args.runId}.${context.organizer ? `\nFinding IDs: ${JSON.stringify(rows.map(row => ({ findingId: row.findingId, sourceFindingIds: row.sourceFindingIds })))}` : ''}` }
  },
})

// ── finalize_rows ───────────────────────────────────────────────────────────────────

const SEVERITY_HEADER = /severity|priority|impact/i
// Wide enough to read the design and live pictures side by side on the approval card.
const APPROVAL_PREVIEW_WIDTH = 1100
const BATCH_PREVIEW_WIDTH = 640

/** The evidence picture for a drafted row: the design and live crops with the issue boxed. Also used by Past reviews. */
export async function renderRowEvidence(runs: RunStore, runId: string, row: z.infer<typeof rowSchema>, index: number): Promise<{ data: Buffer; caption: string } | null> {
  const evidence = row.evidence
  if (!evidence) return null
  if (evidence.screenshot) {
    // A finding from testing the page: the browser's screenshot, with the issue boxed when an area was given.
    const shot = runs.readBrowserShot(runId, evidence.screenshot)
    if (!shot) return null
    const caption = (evidence.caption || Object.values(row.cells)[0] || `Row ${index + 1}`).slice(0, 160)
    const data = await renderEvidence({ design: null, live: shot, liveRect: evidence.live, header: { design: '', live: `Live · ${evidence.breakpoint} · while testing (${evidence.screenshot})` }, caption }).catch(() => null)
    return data ? { data, caption } : null
  }
  const live = runs.readLive(runId, evidence.breakpoint)
  if (!live) return null
  const design = runs.readDesign(runId, evidence.breakpoint)
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

export type DraftRow = z.infer<typeof rowSchema>

export interface HandOverEntry {
  proof?: { data: Buffer; caption: string }
  /** The run whose captures this row's evidence is cut from. */
  runId: string
  row: DraftRow
  /** The page the row is about, when rows from several pages are handed over together. */
  page?: { name: string; url: string }
}

/** What an evidence picture is about, shown on the viewer page: the section, the finding and where it shows. */
export function evidenceLabel(format: TrackerFormat, row: string[], fallback: string): string {
  const view = rowView(format, row)
  const where = view.badges.find((badge) => badge.kind === 'display')?.value
  const text = [view.title, view.body && view.body !== view.title ? view.body : ''].filter(Boolean).join(': ')
  return ((text ? `${text}${where ? ` (${where})` : ''}` : fallback) || fallback).replace(/\s+/g, ' ').trim().slice(0, 200)
}

export interface HandOverInput {
  copyRows?: boolean
  projectName: string
  pageUrl: string
  /** The run whose folder receives the evidence pictures and the copy of the rows. */
  outputRunId: string
  entries: HandOverEntry[]
  uploadEvidence?: boolean
  /** More than the default when a batch of pages is handed over at once. */
  maxRows?: number
}

/** Shows the rows for approval; on approval uploads the evidence, copies the rows and saves a copy. */
export async function handOverRows(context: QaContext, input: HandOverInput): Promise<ToolResult> {
  if (context.organizer) {
    const format = context.trackerFormat()
    if (!format) return fail('The tracker format is not set.')
    const built = buildRows(format, input.entries.map(entry=>entry.row.cells), { maxRows: input.maxRows, remarkStyle: context.remarkStyle?.() })
    if (!built.ok) return fail(built.error)
    const ids = await context.organizer.finalize(input.entries.map(entry=>({...entry,row:{...entry.row,cells:Object.fromEntries(Object.entries(entry.row.cells).map(([key,value])=>[key,/priority|severity|impact/i.test(key)?'':value]))}})))
    return { text: `Saved ${ids.length} finding(s) in the project organizer. Review them in Findings or open the QA Master Tracker.\nFinding IDs: ${JSON.stringify(ids)}` }
  }
  const format = context.trackerFormat()
  if (!format) return fail('The tracker format is not set. In Parity: Settings → AI Agents → paste the tracker header row and a few example rows.')
  const built = buildRows(format, input.entries.map((entry) => entry.row.cells), { maxRows: input.maxRows, remarkStyle: context.remarkStyle?.(), manual:input.copyRows===false })
  if (!built.ok) return fail(built.error)

  const output = context.runs.outputDir(input.outputRunId)
  const stamp = String(context.now())
  const evidenceFiles: Array<{ rowIndex: number; data: Buffer; caption: string; file: string }> = []
  for (const [index, entry] of input.entries.entries()) {
    const rendered = entry.proof || await renderRowEvidence(context.runs, entry.runId, entry.row, index)
    if (!rendered) continue
    const file = join(output, `evidence-${stamp}-row-${String(index + 1).padStart(2, '0')}.webp`)
    writeFileSync(file, rendered.data)
    evidenceFiles.push({ rowIndex: index, data: rendered.data, caption: rendered.caption, file })
  }

  const wantsUpload = input.uploadEvidence !== false && evidenceFiles.length > 0
  const uploadProblem = !wantsUpload ? null : context.evidence ? context.evidence.unavailableReason() : 'Evidence uploads are not set up yet.'
  const shotColumn = screenshotColumn(format)
  const willUpload = wantsUpload && !uploadProblem && !!shotColumn
  const warnings = [...built.warnings]
  if (wantsUpload && uploadProblem) warnings.push(`Evidence images were not uploaded: ${uploadProblem} The screenshot column is left empty.`)
  if (wantsUpload && !uploadProblem && !shotColumn) warnings.push('Evidence images were not uploaded because no screenshot column was found in the tracker header.')

  const severityColumn = format.columns.find((name) => SEVERITY_HEADER.test(name))
  const severityIndex = severityColumn ? format.columns.indexOf(severityColumn) : -1
  const severityCounts: Record<string, number> = {}
  if (severityIndex >= 0) for (const row of built.rows) { const key = row[severityIndex].trim(); if (key) severityCounts[key] = (severityCounts[key] || 0) + 1 }

  // A big batch is previewed smaller, so the card does not need tens of megabytes of pictures.
  const previewWidth = input.entries.length > 40 ? BATCH_PREVIEW_WIDTH : APPROVAL_PREVIEW_WIDTH
  const thumbnails = await Promise.all(evidenceFiles.map(async (item) => ({ rowIndex: item.rowIndex, caption: item.caption, thumbnail: `data:image/jpeg;base64,${(await thumbnailJpeg(item.data, previewWidth)).toString('base64')}` })))
  const pages = input.entries.map((entry) => entry.page)
  const shownRows = built.rows.map((row) => row.map((cell) => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell)))
  // Every hand-over is kept in the run, whatever the decision, so it can be looked at again later.
  const record: QaHandOverRecord = {
    ...(input.entries.some(entry=>entry.row.findingId)?{findingIds:input.entries.map(entry=>entry.row.findingId||'')}:{}),
    version: 1, stamp, createdAt: context.now(), status: 'pending', projectName: input.projectName, pageUrl: input.pageUrl,
    columns: format.columns, rows: shownRows, evidence: evidenceFiles.map((item) => ({ rowIndex: item.rowIndex, file: basename(item.file), caption: item.caption })),
    ...(pages.some(Boolean) ? { rowPages: pages.map((page) => page ?? { name: input.projectName, url: input.pageUrl }) } : {}),
  }
  const saveRecord = () => { try { writeFileSync(join(output, `handover-${stamp}.json`), JSON.stringify(record, null, 2), 'utf8') } catch { /* history is a convenience; the hand-over goes on */ } }
  saveRecord()
  const decision = await context.approve({
    ...(input.copyRows===false?{action:'share' as const}:{}),
    id: randomUUID(), runId: input.outputRunId, projectName: input.projectName, pageUrl: input.pageUrl,
    // The card shows what the agent wrote; the apostrophe that keeps a cell from being read as a formula is only for the clipboard.
    columns: format.columns, rows: shownRows, severityCounts, evidence: thumbnails, warnings, uploadsEvidence: willUpload,
    ...(pages.some(Boolean) ? { rowPages: pages.map((page) => page ?? { name: input.projectName, url: input.pageUrl }) } : {}),
  })
  record.decidedAt = context.now()
  record.note = decision.note
  if (!decision.approved) {
    record.status = 'rejected'
    saveRecord()
    return { text: `The person did not approve these rows${decision.note ? `. Their note: ${decision.note}` : '.'} Nothing was copied or uploaded. Revise the rows and call finalize_rows again.` }
  }

  // Rows the person left out are neither copied nor uploaded.
  const excluded = [...new Set((decision.excludedRows ?? []).filter((index) => Number.isInteger(index) && index >= 0 && index < built.rows.length))].sort((a, b) => a - b)
  const keptIndexes = built.rows.map((_, index) => index).filter((index) => !excluded.includes(index))
  record.status = 'approved'
  record.excludedRows = excluded
  if (!keptIndexes.length) {
    record.copiedRows = 0
    saveRecord()
    return { text: 'The person approved but left out every row, so nothing was copied or uploaded.' }
  }
  const position = new Map(keptIndexes.map((original, index) => [original, index]))
  const rows = keptIndexes.map((index) => [...built.rows[index]])
  const keptEvidence = evidenceFiles.filter((item) => position.has(item.rowIndex))
  const outcome: string[] = []
  if (excluded.length) outcome.push(`The person left out ${excluded.length} row(s): ${excluded.map((index) => index + 1).join(', ')}.`)
  if (willUpload && shotColumn && keptEvidence.length) {
    const column = format.columns.indexOf(shotColumn)
    const results = await context.evidence!.upload(keptEvidence.map((item) => ({ name: basename(item.file), data: item.data, contentType: 'image/webp', label: evidenceLabel(format, built.rows[item.rowIndex], item.caption) })))
    let uploaded = 0
    record.links = {}
    results.forEach((result, i) => {
      const original = keptEvidence[i].rowIndex
      if (result.url) { rows[position.get(original)!][column] = result.url; record.links![String(original)] = result.url; uploaded++ }
      else outcome.push(`Row ${original + 1}: evidence not uploaded (${result.error || 'unknown error'}).`)
    })
    outcome.unshift(`Uploaded ${uploaded} of ${keptEvidence.length} evidence image(s) and put their links in "${shotColumn}".`)
  } else if (keptEvidence.length) {
    const reason = input.uploadEvidence === false ? 'Uploads were turned off for this run.' : uploadProblem ?? 'No screenshot column was found in the tracker header.'
    outcome.push(`Evidence images were not uploaded: ${reason} They were saved on this computer: ${output}`)
  }

  const tsv = buildTsv(rows)
  if (input.copyRows !== false) context.copyToClipboard(tsv, buildHtml(rows))
  const tsvPath = join(output, `rows-${stamp}.tsv`)
  writeFileSync(tsvPath, tsv, 'utf8')
  record.copiedRows = input.copyRows === false ? 0 : rows.length
  saveRecord()
  return {
    text: [input.copyRows === false ? `Approved. Shared evidence for ${rows.length} finding(s).` : `Approved. Copied ${rows.length} row(s) to the clipboard in tracker column order; paste them into the sheet.`, ...outcome, ...warnings.filter((w) => !w.startsWith('Evidence images were not uploaded')), `A copy of the rows is saved at ${tsvPath}.`].join('\n'),
  }
}

const finalizeRows = defineTool({
  name: 'finalize_rows',
  title: 'Organize the findings',
  description: 'Saves and consolidates the final findings in the project organizer. Include sourceFindingIds from save_draft when merging rows. Saving locally needs no approval and does not upload evidence or change the clipboard.',
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
    return handOverRows(context, {
      projectName: reported.project.name, pageUrl: run.pageUrl, outputRunId: args.runId,
      entries: args.rows.map((row) => ({ runId: args.runId, row })), uploadEvidence: args.uploadEvidence,
    })
  },
})

export const QA_TOOLS = [getContext, setDesign, captureLive, getOverview, getSection, saveDraft, finalizeRows, readResultTool, readChatImages, ...BROWSER_TOOLS, ...WORKSPACE_TOOLS] as const

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
    context.assertAccess?.()
    if (context.agentAccess && !tool.agentAllowed) return fail('This tool is available only through Parity’s user interface.')
    if(context.allowedTools&&!context.allowedTools.has(name))return fail('This tool is not permitted in the active request.')
    const work = async () => { context.assertAccess?.(); await context.authorizeTool?.(name,parsed.data);context.assertAccess?.(); const result=await tool.run(parsed.data, context); context.assertAccess?.(); return result }
    return context.dispatchTool ? await context.dispatchTool(name, parsed.data, work) : await work()
  } catch (error: any) {
    return fail(`${name} failed: ${error?.message || 'unknown error'}`)
  }
}
