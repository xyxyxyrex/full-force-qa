import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { BREAKPOINTS, isBreakpoint } from '../../shared/designScale'
import { liteBreakpoints } from './lite'
import { designKeyOf, pageIdOf } from '../../shared/designKey'
import { isAgentId, type AgentId, type AgentsOverview, type AgentSettings, type ApprovalDecision, type ApprovalRequest, type QaBatchStartOptions, type QaChatListItem, type QaChatSendOptions, type QaHistoryPicture, type QaRunDetail, type QaRunEvent, type QaRunListItem, type QaStoredChat, type QaTarget, type QaRunStartOptions, type QaRunStartResult, type QaToolCallResult, type ReportedContext } from '../../shared/qaAgent'
import { buildHtml, buildTsv, neutralizeFormula, screenshotColumn, isTrackerFormat, parseTrackerPaste, STANDARD_TRACKER, type TrackerFormat } from '../../shared/trackerFormat'
import { normalizeRemarkStyle, plainRemark, stylePrompt, type RemarkStyle } from '../../shared/remarkStyle'
import type { FindingUpdate, OrganizerResult } from '../../shared/qaOrganizer'
import { getProjectOwner, getProjects, saveProject } from '../store'
import { accountContext, accountOwner, accountRequest, onAccountChanged } from '../account'
import { createWorkspaceService, type WorkspaceService } from '../workspaceService'
import { cachedTickets } from '../ticketStore'
import { type WorkspaceQuery, type WorkspaceOperation, type WorkspaceRecord } from '../../shared/parityWorkspace'
import { type ChatAgentSelection } from '../../shared/qaAgent'
import { runWorkspaceCommand } from './workspaceCommands'
import { needsPrivateDataApproval } from './workspaceSecurity'
import { fenceQaContext } from './accountFence'
import { createChatImageStore } from './chatImages'
import type { ChatImage, ChatImageUpload } from '../../shared/chatImages'
import { createOrganizerStore } from './organizerStore'
import type { DesignStore } from '../designStore'
import { createEvidenceUploader } from './evidenceUpload'
import { captureLivePage } from './liveCapture'
import { runChatTurn } from './chat'
import { CHAT_ID_PATTERN, createChatStore } from './chats'
import { createRunHistory } from './history'
import { isReviewablePageUrl, MAX_BATCH_PAGES, runQaBatch, type BatchPage } from './batch'
import { runQa } from './runner'
import { createRunStore } from './runStore'
import { createQaBrowser } from './qaBrowser'
import { accountAccessToken, accountAuthId, parityPublicConfig } from '../account'
import { createProvider, describeAgents, listModels, normalizeSettings, usesFreeTier } from './agents/registry'
import { agentSelection } from '../../shared/qaAgentSelection'
import { createQuotaService, quotaScope } from './agents/quota'
import { sweepStaleAgentFolders } from './agents/cliAgents'
import type { AgentProvider, ChatTurn } from './agents/types'
import { createBridgeServer, type BridgeLogEntry } from './bridge/httpServer'
import { ensureToken, resetToken } from './bridge/token'
import { QaExecution } from './execution'
import { createHash, randomUUID } from 'crypto'
import { callTool, handOverRows, renderRowEvidence, type DraftRow, type QaContext, type ToolResult } from './tools'

// Electron wiring for the QA tools: the page the window reports, the approval handshake,
// clipboard, tracker format storage and the IPC entry points. The tools themselves live in
// tools.ts and do not import Electron.

const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_BRIDGE_PORT = 29849
const LOG_LIMIT = 50
const MAX_CHAT_MESSAGE = 4000
const clamp = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

interface Options {
  consumeCaptureReceipt?: (id:string) => Omit<import('../../shared/parityWorkspace').CaptureActivity,'projectId'>
  getMainWindow: () => BrowserWindow | null
  getChatWindow?: () => BrowserWindow | null
  getDesignStore: () => DesignStore
}

function toRendererResult(result: ToolResult): QaToolCallResult {
  return {
    text: result.text,
    isError: !!result.isError,
    images: (result.images || []).map((image) => ({ dataUrl: `data:${image.mimeType};base64,${image.data.toString('base64')}`, caption: image.caption, file: image.file })),
  }
}

export function registerQaAgent(options: Options): { context: () => QaContext; workspace: WorkspaceService; attachMainWindow: (window: BrowserWindow) => void } {
  const root = () => join(app.getPath('userData'), 'qa-agent')
  const chatImages = createChatImageStore(join(root(), 'chat-images'))
  const trackerFile = () => join(root(), 'tracker-format.json')
  const ownerKey = () => getProjectOwner() || accountAuthId() || 'local'
  const runFiles = createRunStore(join(app.getPath('userData'), 'qa-runs'))
  const ownedRun = (id:string) => { const meta=runFiles.get(id); if(!meta||meta.ownerKey!==ownerKey())throw new Error('This audit is unavailable in the current account.'); return meta }
  const runs: typeof runFiles = new Proxy(runFiles,{get(target,key){
    if(key==='create')return (input:Parameters<typeof runFiles.create>[0])=>target.create({...input,ownerKey:ownerKey()})
    if(key==='get')return (id:string)=>{try{return ownedRun(id)}catch{return null}}
    if(key==='list')return ()=>target.list().filter(meta=>meta.ownerKey===ownerKey())
    if(key==='latest')return (projectKey:string)=>target.list().find(meta=>meta.ownerKey===ownerKey()&&meta.projectKey===projectKey)||null
    if(key==='prune')return (input:import('./runStore').PruneOptions={})=>target.prune({...input,ownerKey:ownerKey()})
    const value=Reflect.get(target,key);if(typeof value!=='function')return value
    return (...args:any[])=>{if(typeof args[0]==='string')ownedRun(args[0]);return value.apply(target,args)}
  }})
  const organizer = createOrganizerStore(join(root(), 'organizer'))
  let appLocation: { workspace: string; folderId?: string; projectId?: string } = {workspace:'dashboard'}
  const workspace = createWorkspaceService({
    root:join(root(),'workspace'),owner:accountOwner,fence:()=>accountContext().assert,projects:getProjects,saveProject,request:accountRequest,
    changed:snapshot=>{for(const window of [options.getMainWindow(),options.getChatWindow?.()])if(window&&!window.isDestroyed())window.webContents.send('workspace:changed',{ownerKey:accountOwner(),snapshot})},
    navigate:target=>options.getMainWindow()?.webContents.send('workspace:navigate',{ownerKey:accountOwner(),target}),
    localRecords:()=>[
      ...getProjects().flatMap(project=>{try{return organizer.read(ownerKey(),project.id,project.name,readTrackerFormat()).findings.filter(f=>!f.mergedInto).map(f=>({kind:'finding' as const,id:f.id,projectId:project.id,title:f.cells.Section||'QA finding',breadcrumb:project.name,excerpt:plainRemark(f.cells.Remarks||f.cells.Issue||f.cells.Description||'').slice(0,600),url:f.pageUrl,createdAt:f.createdAt,updatedAt:f.updatedAt,inTrash:!!project.inTrash,source:'local' as const}))}catch{return[]}}),
      ...cachedTickets().map(t=>({kind:'ticket' as const,id:t.id,title:t.title,breadcrumb:t.sourceGroup||'Tickets',excerpt:t.description.slice(0,600),source:'cached' as const})),
    ],
    detailLocal:(kind,id,projectId)=>{if(kind==='finding'){const project=getProjects().find(p=>p.id===projectId);if(!project)throw new Error('The finding’s project is unavailable.');const finding=organizer.read(ownerKey(),project.id,project.name,readTrackerFormat()).findings.find(f=>f.id===id);if(!finding)return;return{id:finding.id,projectId:project.id,pageUrl:finding.pageUrl,cells:finding.cells,review:finding.review,sources:finding.sources,evidence:(finding.evidenceSet||[finding.evidence]).filter(Boolean).map(e=>({caption:e!.caption}))}}if(kind==='ticket'){const t=cachedTickets().find(t=>t.id===id);if(t)return{id:t.id,title:t.title,description:t.description,progress:t.progress,sourceStatus:t.sourceStatus}}},
  })
  const findingsChanged = (projectKey: string) => {
    const window = options.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('qa:findings:changed', { projectKey })
    const chat = options.getChatWindow?.()
    if (chat && !chat.isDestroyed()) chat.webContents.send('qa:findings:changed', { projectKey })
  }
  function organizerContext(owner: string): NonNullable<QaContext['organizer']> {
    const requireOwner = () => { if (owner !== ownerKey()) throw new Error('The account changed. Start a new audit in this account.') }
    const metaOf = (runId: string) => { requireOwner(); const meta = runs.get(runId); if (!meta || meta.ownerKey && meta.ownerKey !== owner) throw new Error('This audit belongs to another account or is no longer available.'); return meta }
    return {
      save: async (runId, bp, rows, area) => {
        const meta = metaOf(runId)
        const proofs = await Promise.all(rows.map((row,index)=>renderRowEvidence(runs, runId, row, index).then(value=>value || undefined)))
        requireOwner()
        const saved = organizer.save(owner, meta, bp, rows, area, readTrackerFormat(), proofs)
        findingsChanged(meta.projectKey); return saved.rows
      },
      finalize: async entries => {
        const values = entries.map(entry=>({ meta: metaOf(entry.runId), row: entry.row }))
        const proofs = await Promise.all(entries.map((entry,index)=>renderRowEvidence(runs,entry.runId,entry.row,index).then(value=>value || undefined)))
        requireOwner()
        const ids = organizer.reconcile(owner, values, readTrackerFormat(), proofs)
        for (const project of new Set(values.map(value=>value.meta.projectKey))) findingsChanged(project)
        return ids
      },
    }
  }
  try { runs.prune() } catch (error) { console.warn('[Parity QA] Could not prune old runs:', error) }

  // A run that was cut short (a crash, a power cut) can leave its private folder, with the bridge key, behind.
  try { sweepStaleAgentFolders() } catch { /* best effort */ }

  let reported: ReportedContext | null = null
  // While a batch review runs, the page it is on, so tools called over the bridge see it too.
  let batchTarget: ReportedContext | null = null
  let pendingApproval: { id: string; resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout } | null = null
  // The agent's own browser for testing links, buttons and forms. It closes after a review, a new
  // chat, ten idle minutes, or when Parity quits.
  const browser = createQaBrowser()
  app.on('before-quit', () => browser.close())

  const fromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const window = options.getMainWindow()
    return !!window && !window.isDestroyed() && event.senderFrame === window.webContents.mainFrame
  }

  const fromQaWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const chat = options.getChatWindow?.()
    return fromMainWindow(event) || !!chat && !chat.isDestroyed() && event.senderFrame === chat.webContents.mainFrame
  }

  // The standard tracker applies until the person pastes their own.
  function readTrackerFormat(): TrackerFormat {
    try {
      const parsed = JSON.parse(readFileSync(trackerFile(), 'utf8'))
      return isTrackerFormat(parsed) ? parsed : STANDARD_TRACKER
    } catch { return STANDARD_TRACKER }
  }

  function writeTrackerFormat(format: TrackerFormat): void {
    mkdirSync(root(), { recursive: true })
    const temporary = `${trackerFile()}.tmp`
    writeFileSync(temporary, JSON.stringify(format, null, 2), 'utf8')
    try { renameSync(temporary, trackerFile()) } catch { rmSync(trackerFile(), { force: true }); renameSync(temporary, trackerFile()) }
  }

  const resolveApproval = (decision: ApprovalDecision) => {
    if (!pendingApproval) return
    clearTimeout(pendingApproval.timer)
    const { resolve,id } = pendingApproval
    pendingApproval = null
    const window=options.getMainWindow();if(window&&!window.isDestroyed())window.webContents.send('qa:run:event',{type:'approval-cleared',id})
    resolve(decision)
  }

  const requestApproval = (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const window = options.getMainWindow()
    if (!window || window.isDestroyed()) return Promise.resolve({ approved: false, note: 'Parity\'s window is not open, so nobody could approve the rows.' })
    if (pendingApproval) return Promise.resolve({ approved: false, note: 'Another set of rows is already waiting for approval in Parity.' })
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => resolveApproval({ approved: false, note: 'Nobody approved the rows within 15 minutes.' }), APPROVAL_TIMEOUT_MS)
      pendingApproval = { id: request.id, resolve, timer }
      window.webContents.send('qa:approval-request', request)
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      window.flashFrame(true)
    })
  }

  let executionContext: QaContext | null = null
  const context: QaContext = {
    workspace,
    appContext:()=>({guideVersion:1,appVersion:app.getVersion(),...appLocation,project:reported?.project,page:reported?.pageUrl,capabilities:['search','help','open','propose changes'],signedIn:!!accountOwner()}),
    workspaceProposal:proposal=>sendRunEvent({type:'workspace-proposal',proposal}),
    now: () => Date.now(),
    reportedContext: () => batchTarget ?? reported,
    setTarget: (target) => { batchTarget = target },
    designs: {
      list: (projectKey) => options.getDesignStore().list(projectKey),
      put: (projectKey, bytes, putOptions) => options.getDesignStore().put(projectKey, bytes, putOptions),
      readNormalized: async (projectKey, breakpoint) => {
        const path = await options.getDesignStore().normalizedPath(projectKey, breakpoint)
        return path ? readFile(path) : null
      },
    },
    runs,
    capture: async(captureOptions)=>{const assert=accountContext().assert,target=batchTarget??reported;const result=await captureLivePage(captureOptions);assert();if(accountOwner()&&target&&getProjects().some(p=>p.id===target.project.id))void workspace.recordCapture({id:randomUUID(),projectId:target.project.id,url:result.finalUrl||captureOptions.url,engine:'electron-qa',completedAt:Date.now()}).catch(()=>{});return result},
    trackerFormat: readTrackerFormat,
    remarkStyle: () => normalizeRemarkStyle(readAgentSettings().remarkStyle),
    organizer: {
      save: (...args) => organizerContext(ownerKey()).save(...args),
      finalize: entries => organizerContext(ownerKey()).finalize(entries),
    },
    readLocalFile: (path) => readFile(path),
    approve: requestApproval,
    copyToClipboard: (text, html) => clipboard.write({ text, html }),
    browser,
    // Read on every request, so turning sending off takes effect the next time the browser opens a page.
    allowSend: () => readAgentSettings().allowSend,
    // The settings are read when an upload happens, so changing them takes effect straight away.
    evidence: createEvidenceUploader({
      settings: () => readAgentSettings(),
      isSignedIn: () => !!accountAuthId(),
      accessToken: accountAccessToken,
      config: parityPublicConfig,
    }),
  }

  // The renderer tells main which project and page are open. Only the app window may do so.
  ipcMain.on('qa:report-context', (event, value: unknown) => {
    if (!fromMainWindow(event)) return
    if (value === null) { reported = null; return }
    const v = value as Partial<ReportedContext> & { project?: Partial<ReportedContext['project']>; viewport?: { width?: number; height?: number } }
    const projectKey = clamp(v?.projectKey, 300)
    const pageUrl = clamp(v?.pageUrl, 2000)
    if (!projectKey || !/^https?:\/\//i.test(pageUrl)) { reported = null; return }
    if(accountOwner()&&!getProjects().some(p=>p.id===v.project?.id&&p.id===projectKey)){reported=null;return}
    reported = {
      projectKey,
      project: { id: clamp(v.project?.id, 300), name: clamp(v.project?.name, 200) || projectKey, stagingUrl: clamp(v.project?.stagingUrl, 2000) },
      pageUrl,
      workspaceTab: clamp(v.workspaceTab, 40),
      breakpoint: isBreakpoint(v.breakpoint) ? v.breakpoint : null,
      viewport: { width: Math.round(Number(v.viewport?.width) || 0), height: Math.round(Number(v.viewport?.height) || 0) },
      reportedAt: Date.now(),
    }
  })

  ipcMain.handle('qa:call-tool', async (event, name: unknown, args: unknown): Promise<QaToolCallResult> => {
    if (!fromQaWindow(event)) return { text: 'Not allowed.', isError: true, images: [] }
    if (typeof name !== 'string') return { text: 'A tool name is required.', isError: true, images: [] }
    return toRendererResult(await callTool(name, args, executionContext || fenceQaContext(context,accountContext().assert)))
  })
  ipcMain.on('workspace:location',(event,value)=>{if(!fromMainWindow(event)||!value||typeof value!=='object')return;appLocation={workspace:clamp(value.workspace,40)||'dashboard',folderId:clamp(value.folderId,200)||undefined,projectId:clamp(value.projectId,200)||undefined}})
  ipcMain.handle('workspace:search',(event,query:WorkspaceQuery)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');return workspace.search(query||{})})
  ipcMain.handle('workspace:snapshot',async(event,refresh=true)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');try{return await workspace.snapshot(refresh!==false)}catch{return workspace.snapshot(false)}})
  ipcMain.handle('workspace:propose',async(event,operations:WorkspaceOperation[],title:string)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');const proposal=await workspace.propose(operations,title);sendRunEvent({type:'workspace-proposal',proposal});return proposal})
  ipcMain.handle('workspace:apply',async(event,id:string)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');const result=await workspace.apply(id);sendRunEvent({type:'workspace-proposal',proposal:result.proposal});return result})
  ipcMain.handle('workspace:cancel',(event,id:string)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');const proposal=workspace.cancel(id);sendRunEvent({type:'workspace-proposal',proposal});return proposal})
  ipcMain.handle('workspace:refresh',async(event,id:string)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');const proposal=await workspace.refresh(id);sendRunEvent({type:'workspace-proposal',proposal:workspace.getProposal(id)});sendRunEvent({type:'workspace-proposal',proposal});return proposal})
  ipcMain.handle('workspace:proposal',(event,id:string)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');return workspace.getProposal(id)})
  ipcMain.handle('workspace:open',(event,target)=>{if(!fromQaWindow(event))throw new Error('Not allowed.');return workspace.open(target)})
  ipcMain.handle('qa:workspace-command',async(event,input:unknown)=>{if(!fromQaWindow(event)||typeof input!=='string'||input.length>12000)throw new Error('Invalid command.');return runWorkspaceCommand(input,context)})
  ipcMain.handle('workspace:mutate',async(event,operations:WorkspaceOperation[],expectedOwner:string)=>{
    if(!fromMainWindow(event)||expectedOwner!==accountOwner())throw new Error('The account changed. Reopen this view.')
    const proposal=await workspace.propose(operations,'Dashboard change'),result=await workspace.apply(proposal.id)
    if(!result.success)throw new Error(result.proposal.error||'The changes could not be saved.')
    return result.snapshot!
  })
  ipcMain.handle('workspace:record-capture',async(event,activity:unknown,expectedOwner:string|null)=>{
    if(!fromMainWindow(event)||!expectedOwner||expectedOwner!==accountOwner())return
    const a=activity as import('../../shared/parityWorkspace').CaptureActivity
    if(!a||typeof a.id!=='string'||!/^[a-f\d-]{36}$/i.test(a.id)||typeof a.url!=='string'||!/^https?:\/\//i.test(a.url)||typeof a.engine!=='string'||!Number.isSafeInteger(a.completedAt)||a.completedAt>Date.now()+60000)throw new Error('Invalid capture record.')
    if(!getProjects().some(p=>p.id===a.projectId))throw new Error('Capture project unavailable.')
    const receipt=options.consumeCaptureReceipt?.(a.id)
    if(!receipt)throw new Error('No successful capture receipt was supplied.')
    await workspace.recordCapture({...receipt,projectId:a.projectId})
  })

  // What the chat shows as the review target: the same page and designs the agent's tools will use.
  let targetThumbs: { signature: string; thumbnails: QaTarget['thumbnails'] } | null = null
  ipcMain.handle('qa:target:get', async (event): Promise<QaTarget | null> => {
    const assert=accountContext().assert
    const current = batchTarget ?? reported
    if (!fromQaWindow(event) || !current) return null
    const key = designKeyOf(current.projectKey, current.pageUrl)
    const slots = options.getDesignStore().list(key)
    // Thumbnails are only made again when the stored designs change.
    const signature = `${key}|${Object.values(slots).map((slot) => slot?.sha256).join(',')}`
    if (targetThumbs?.signature !== signature) {const result=await options.getDesignStore().listWithThumbnails(key);assert();targetThumbs = { signature, thumbnails: result.thumbnails }}
    assert()
    return { projectName: current.project.name, pageUrl: current.pageUrl, pageId: pageIdOf(current.pageUrl) ?? current.pageUrl, slots, thumbnails: targetThumbs.thumbnails }
  })

  ipcMain.handle('qa:approval-decision', (event, id: unknown, decision: unknown) => {
    if (!fromQaWindow(event) || !pendingApproval || id !== pendingApproval.id) return false
    const d = decision as Partial<ApprovalDecision>
    const excludedRows = Array.isArray(d?.excludedRows) ? d.excludedRows.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < 10_000).slice(0, 1000) : undefined
    resolveApproval({ approved: d?.approved === true, note: clamp(d?.note, 500) || undefined, ...(excludedRows?.length ? { excludedRows } : {}) })
    options.getMainWindow()?.flashFrame(false)
    return true
  })

  ipcMain.handle('qa:tracker-format:get', (event) => (fromQaWindow(event) ? readTrackerFormat() : null))
  ipcMain.handle('qa:tracker-format:save', (event, text: unknown) => {
    if (!fromQaWindow(event)) return { ok: false, error: 'Not allowed.' }
    if (typeof text !== 'string' || text.length > 200_000) return { ok: false, error: 'Paste the header row and a few example rows from the tracker.' }
    const parsed = parseTrackerPaste(text)
    if (parsed.ok) writeTrackerFormat(parsed.format)
    return parsed
  })
  ipcMain.handle('qa:tracker-format:clear', (event) => {
    if (!fromQaWindow(event)) return false
    rmSync(trackerFile(), { force: true })
    return true
  })

  // A closed or crashed window can no longer approve anything or be looked at.
  const attachMainWindow = (window: BrowserWindow) => {
    const release = () => { reported = null; resolveApproval({ approved: false, note: 'Parity\'s window closed before the rows were approved.' }) }
    window.webContents.on('render-process-gone', release)
    window.on('closed', release)
  }

  // ── Local bridge: off by default, on only when the person turns it on ───────────────
  const configFile = () => join(root(), 'config.json')
  const bridgeInfoFile = () => join(root(), 'bridge.json')
  const tokenFile = () => join(root(), 'token')
  const readConfig = (): { enabled: boolean; port: number } => {
    try {
      const value = JSON.parse(readFileSync(configFile(), 'utf8'))
      const port = Number(value.port)
      return { enabled: value.enabled === true, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_BRIDGE_PORT }
    } catch { return { enabled: false, port: DEFAULT_BRIDGE_PORT } }
  }
  const writeConfig = (config: { enabled: boolean; port: number }) => {
    mkdirSync(root(), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8')
  }

  const requestLog: BridgeLogEntry[] = []
  let bridgeError = ''
  let token = ''
  const scopedTokens=new Map<string,{owner:string;context:QaContext}>()
  const bridge = createBridgeServer({
    getContext: () => fenceQaContext({...context,workspace:undefined,agentAccess:true},accountContext().assert),
    getToken: () => token,
    resolveToken:key=>{const value=scopedTokens.get(key);return value?.owner===ownerKey()?value.context:null},
    onRequest: (entry) => {
      requestLog.push(entry)
      if (requestLog.length > LOG_LIMIT) requestLog.shift()
      pushStatus()
    },
  })

  const bridgeStatus = () => {
    const config = readConfig()
    const key = token || (existsSync(tokenFile()) ? ensureToken(tokenFile()) : '')
    return {
      enabled: config.enabled,
      running: bridge.running(),
      port: bridge.port() ?? config.port,
      error: bridgeError,
      keyHint: key ? `••••${key.slice(-4)}` : '',
      mcpUrl: `http://127.0.0.1:${bridge.port() ?? config.port}/mcp`,
      keyFile: tokenFile(),
      lastRequestAt: requestLog.length ? requestLog[requestLog.length - 1].at : null,
      recent: requestLog.slice(-20).reverse(),
    }
  }
  const pushStatus = () => {
    const window = options.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('qa:bridge:status-changed', bridgeStatus())
  }

  async function startBridge(): Promise<void> {
    bridgeError = ''
    if (bridge.running()) return
    token = ensureToken(tokenFile())
    const { port } = readConfig()
    try {
      const actual = await bridge.start(port)
      mkdirSync(root(), { recursive: true })
      writeFileSync(bridgeInfoFile(), JSON.stringify({ port: actual, pid: process.pid }), 'utf8')
    } catch (error: any) {
      bridgeError = error?.code === 'EADDRINUSE' || error?.code === 'EACCES'
        ? `Port ${port} is unavailable. Another program, or another Parity window, is using it.`
        : `The bridge could not start: ${error?.message || 'unknown error'}`
    }
  }
  async function stopBridge(): Promise<void> {
    await bridge.stop()
    rmSync(bridgeInfoFile(), { force: true })
  }

  ipcMain.handle('qa:bridge:status', (event) => (fromQaWindow(event) ? bridgeStatus() : null))
  ipcMain.handle('qa:bridge:set-enabled', async (event, enabled: unknown) => {
    if (!fromQaWindow(event)) return null
    const config = readConfig()
    writeConfig({ ...config, enabled: enabled === true })
    if (enabled === true) await startBridge()
    else { bridgeError = ''; await stopBridge() }
    pushStatus()
    return bridgeStatus()
  })
  ipcMain.handle('qa:bridge:reset-key', (event) => {
    if (!fromQaWindow(event)) return null
    token = resetToken(tokenFile())
    pushStatus()
    return bridgeStatus()
  })
  app.on('before-quit', () => { rmSync(bridgeInfoFile(), { force: true }) })

  // ── Agent choice, API keys and the review run ─────────────────────────────────────
  const agentsFile = () => join(root(), 'agents.json')
  const readAgentSettings = (): AgentSettings => {
    try { return normalizeSettings(JSON.parse(readFileSync(agentsFile(), 'utf8'))) } catch { return normalizeSettings(null) }
  }
  const writeAgentSettings = (settings: AgentSettings) => {
    mkdirSync(root(), { recursive: true })
    writeFileSync(agentsFile(), JSON.stringify(settings, null, 2), 'utf8')
  }
  const keyFile = (id: AgentId) => join(root(), `key-${id}.bin`)
  const getKey = (id: AgentId): string | null => {
    try {
      if (!existsSync(keyFile(id)) || !safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(readFileSync(keyFile(id))) || null
    } catch { return null }
  }
  const keyStorage = (): AgentsOverview['keyStorage'] => {
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
    try {
      const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
      if (backend === 'basic_text' || backend === 'unknown') return 'weak'
    } catch { /* not Linux */ }
    return 'secure'
  }
  const overview = async (): Promise<AgentsOverview> => {
    const settings = readAgentSettings()
    return { settings, agents: await describeAgents({ settings, getKey }), keyStorage: keyStorage() }
  }

  ipcMain.handle('qa:agents:overview', async (event) => (fromQaWindow(event) ? overview() : null))
  function findingsTarget(projectKey: unknown) {
    const project=getProjects().find(p=>p.id===projectKey)
    if(project)return {owner:ownerKey(),key:project.id,name:project.name}
    if(!accountOwner()&&reported&&projectKey===reported.projectKey)return {owner:ownerKey(),key:reported.projectKey,name:reported.project.name}
    throw new Error('This project is unavailable in the current account.')
  }
  ipcMain.handle('qa:findings:list', (event, projectKey?: unknown) => {
    if (!fromQaWindow(event) || !projectKey&&!reported) return null
    const target = findingsTarget(projectKey ?? reported?.projectKey)
    return organizer.read(target.owner, target.key, target.name, readTrackerFormat())
  })
  ipcMain.handle('qa:findings:update', (event, projectKey: unknown, revision: unknown, changes: unknown): OrganizerResult => {
    if (!fromQaWindow(event)) return { success: false, error: 'Not allowed.' }
    try {
      const target = findingsTarget(projectKey)
      if (!Number.isInteger(revision) || !Array.isArray(changes) || !changes.every(c=>c && typeof c.id === 'string' && (!c.cells || typeof c.cells === 'object'))) throw new Error('These changes are not valid.')
      const snapshot = organizer.update(target.owner, target.key, target.name, revision as number, changes as FindingUpdate[], readTrackerFormat())
      findingsChanged(target.key); return { success: true, snapshot }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Could not save these findings.' } }
  })
  ipcMain.handle('qa:findings:picture', (event, projectKey: unknown, id: unknown, index:unknown) => {
    if (!fromQaWindow(event) || typeof id !== 'string') return null
    const target = findingsTarget(projectKey); const picture = organizer.picture(target.owner, target.key, id, readTrackerFormat(), typeof index==='number'?index:0)
    return picture ? { src: `data:image/webp;base64,${picture.data.toString('base64')}`, caption: picture.caption } : null
  })
  ipcMain.handle('qa:findings:import', async (event, projectKey: unknown): Promise<OrganizerResult> => {
    if (!fromQaWindow(event)) return { success: false, error: 'Not allowed.' }
    try {
      const target = findingsTarget(projectKey)
      for (const meta of runs.list().filter(meta=>meta.projectKey===target.key && (!meta.ownerKey || meta.ownerKey===target.owner))) {
        for (const area of ['visual','functional'] as const) for (const bp of BREAKPOINTS) {
          const rows = runs.readDrafts(meta.id,area)[bp] as DraftRow[] | undefined
          if (rows?.length) await organizerContext(target.owner).save(meta.id,bp,rows,area)
        }
        const record=history.detail(meta.id)?.handovers[0]
        if(record){
          const existing=organizer.read(target.owner,target.key,target.name,readTrackerFormat())
          const imported=record.rows.flatMap((values,index)=>record.findingIds?.[index]&&existing.findings.some(item=>item.id===record.findingIds![index])?[]:[{meta,row:{cells:Object.fromEntries(record.columns.map((column,c)=>[column,values[c]||'']))},index}])
          const pictures=imported.map(entry=>{const reference=record.evidence.find(value=>value.rowIndex===entry.index);if(!reference||!/^[a-zA-Z0-9-]+\.webp$/.test(reference.file))return undefined;try{return{data:readFileSync(join(runs.outputDir(meta.id),reference.file)),caption:reference.caption}}catch{return undefined}})
          if(target.owner!==ownerKey())throw new Error('The account changed. Retry importing in the original account.')
          organizer.reconcile(target.owner,imported,readTrackerFormat(),pictures)
        }
      }
      findingsChanged(target.key)
      return { success: true, snapshot: organizer.read(target.owner,target.key,target.name,readTrackerFormat()) }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Could not import past findings.' } }
  })
  function selectedFindings(projectKey: unknown, ids: unknown) {
    const target = findingsTarget(projectKey)
    if (!Array.isArray(ids) || !ids.length || ids.length>500 || !ids.every(id=>typeof id==='string')) throw new Error('Select between 1 and 500 findings.')
    const snapshot = organizer.read(target.owner,target.key,target.name,readTrackerFormat())
    const selected = [...new Set(ids)].map(id=>snapshot.findings.find(f=>f.id===id && !f.mergedInto))
    if (selected.some(f=>!f)) throw new Error('Some selected findings changed. Refresh and select them again.')
    return { target, snapshot, items: selected as NonNullable<typeof selected[number]>[] }
  }
  ipcMain.handle('qa:findings:copy', (event, projectKey: unknown, ids: unknown) => {
    if (!fromQaWindow(event)) return { success: false, error: 'Not allowed.' }
    try {
      const {snapshot,items} = selectedFindings(projectKey,ids)
      const rows = items.map(item=>snapshot.columns.map(column=>neutralizeFormula(plainRemark(item.cells[column]||''))))
      clipboard.write({ text: buildTsv(rows), html: buildHtml(rows) }); return { success: true, count: items.length }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Could not copy the selected rows.' } }
  })
  ipcMain.handle('qa:findings:share', async (event, projectKey: unknown, ids: unknown) => {
    if (!fromQaWindow(event)) return { success: false, error: 'Not allowed.' }
    try {
      if (activeRun) throw new Error('Wait for the current audit to finish before sharing evidence.')
      const {target,items} = selectedFindings(projectKey,ids)
      const output = runs.create({projectKey:target.key,projectName:target.name,pageUrl:items[0].pageUrl})
      const requireOwner=()=>{if(target.owner!==ownerKey())throw new Error('The account changed. Share evidence from the original account.')}
      const sharingContext:QaContext={...context,organizer:undefined,approve:async request=>{requireOwner();const decision=await context.approve(request);requireOwner();return decision},evidence:context.evidence?{unavailableReason:()=>{requireOwner();return context.evidence!.unavailableReason()},upload:async entries=>{requireOwner();const result=await context.evidence!.upload(entries);requireOwner();return result}}:undefined}
      const result = await handOverRows(sharingContext, {outputRunId:output.id,projectName:target.name,pageUrl:items[0].pageUrl,copyRows:false,maxRows:500,
        entries:items.map(item=>({runId:output.id,row:{cells:item.cells,findingId:item.id},page:{name:target.name,url:item.pageUrl},proof:organizer.picture(target.owner,target.key,item.id,readTrackerFormat()) || undefined}))})
      if (target.owner !== ownerKey()) throw new Error('The account changed while sharing. The evidence remains in the original account.')
      const record = history.detail(output.id)?.handovers[0]
      if (record?.links) {
        const latest = organizer.read(target.owner,target.key,target.name,readTrackerFormat())
        const column = screenshotColumn(readTrackerFormat())
        const changes = column ? Object.entries(record.links).map(([index,url])=>({id:items[Number(index)].id,cells:{[column]:url}})) : []
        if (changes.length) organizer.update(target.owner,target.key,target.name,latest.revision,changes,readTrackerFormat())
        findingsChanged(target.key)
      }
      return result.isError || record?.status!=='approved' ? {success:false,error:result.text} : {success:true}
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Could not share this evidence.' } }
  })
  // Just the saved choices, without checking every agent (which starts their CLIs).
  ipcMain.handle('qa:agents:settings', (event): AgentSettings | null => (fromQaWindow(event) ? readAgentSettings() : null))
  ipcMain.handle('qa:agents:save-settings', async (event, patch: unknown) => {
    if (!fromQaWindow(event)) return null
    const current = readAgentSettings()
    const incoming = (patch && typeof patch === 'object' ? patch : {}) as Partial<AgentSettings>
    const next = normalizeSettings({ ...current, ...incoming, models: { ...current.models, ...(incoming.models || {}) } })
    writeAgentSettings(next)
    sendRunEvent({type:'agents-config-changed'})
    selectionChanged(next)
    return overview()
  })
  ipcMain.handle('qa:agents:set-key', async (event, id: unknown, key: unknown) => {
    if (!fromQaWindow(event) || !isAgentId(id)) return null
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 500) return { error: 'That does not look like an API key.' }
    if (!safeStorage.isEncryptionAvailable()) return { error: 'This computer has no secure place to keep a key (no system keychain). The key was not saved.' }
    mkdirSync(root(), { recursive: true })
    writeFileSync(keyFile(id), safeStorage.encryptString(key.trim()), { mode: 0o600 })
    try { chmodSync(keyFile(id), 0o600) } catch { /* not supported here */ }
    sendRunEvent({type:'agents-config-changed'})
    return overview()
  })
  ipcMain.handle('qa:agents:clear-key', async (event, id: unknown) => {
    if (!fromQaWindow(event) || !isAgentId(id)) return null
    rmSync(keyFile(id), { force: true })
    sendRunEvent({type:'agents-config-changed'})
    return overview()
  })
  ipcMain.handle('qa:agents:models', async (event, id: unknown) => {
    if (!fromQaWindow(event) || !isAgentId(id)) return { models: [], error: 'Not allowed.' }
    return listModels(id, { settings: readAgentSettings(), getKey })
  })

  // One review at a time. Agent CLIs reach the tools over the bridge, so it is started for the
  // length of the run if the person has not turned it on.
  let activeRun: AbortController | null = null
  let activeExecution: QaExecution | null = null
  let activeSelection = ''
  let workFinished = false
  let pendingSwitch: { execution: QaExecution; toolId?: string; signature: string } | null = null
  let activeToolId: string | undefined
  const executions = new Map<string, QaExecution>()
  const accountFolder = () => join(root(),'accounts',createHash('sha256').update(ownerKey()).digest('hex'))
  const executionFolder = () => join(accountFolder(), 'executions')
  const sendRunEvent = (event: QaRunEvent) => {
    const window = options.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('qa:run:event', event)
  }
  type Request = { kind: 'review' | 'batch' | 'chat'; args?: any; message?: string; attachments?: ChatImage[]; chatId?: string | null; history?: ChatTurn[]; agent: AgentId; followsDefault?: boolean; account?: string | null; owner?: string; remarkStyle?: RemarkStyle; privateRead?:boolean }
  const chatSelections = new Map<string,ChatAgentSelection|null>()
  const chatSelection = (id?:string|null) => id ? chatSelections.has(id) ? chatSelections.get(id)! : chats.load(id)?.selection || null : null
  const selectedSettings = (settings:AgentSettings,chatId?:string|null) => {const chosen=chatSelection(chatId);return chosen ? {...settings,defaultAgent:chosen.agent,models:{...settings.models,[chosen.agent]:chosen.model}} : settings}
  const quotas = createQuotaService()
  app.on('before-quit', () => quotas.clear())
  ipcMain.handle('qa:agents:quota', async (event, input: { chatId?: string | null; agent?: AgentId; refresh?: boolean; ownerKey: string | null }) => {
    if (!fromQaWindow(event) || !input || input.ownerKey !== accountOwner()) throw new Error('The account changed. Check quota again.')
    if (input.chatId != null && (typeof input.chatId !== 'string' || !CHAT_ID_PATTERN.test(input.chatId))) throw new Error('Invalid chat reference.')
    if (input.agent !== undefined && !isAgentId(input.agent)) throw new Error('Choose a valid provider.')
    const guard = accountContext().assert
    const settings = selectedSettings(readAgentSettings(), input.chatId)
    const agent = input.agent || settings.defaultAgent
    const key = getKey(agent), scope = quotaScope(ownerKey(), agent, settings, key)
    const result = await quotas.read(scope, agent, settings.models[agent], key, input.refresh === true)
    guard()
    const latest = selectedSettings(readAgentSettings(), input.chatId)
    if ((!input.agent && latest.defaultAgent !== agent) || quotaScope(ownerKey(), agent, latest, getKey(agent)) !== scope) throw new Error('The provider settings changed during this check. Run /quota again.')
    return result
  })
  function selectionChanged(settings: AgentSettings) {
    sendRunEvent({ type: 'agent-selected', ...agentSelection(selectedSettings(settings,currentChatId)) })
    if (!activeRun || !activeExecution || workFinished) return
    const request = activeExecution.state.request as Request
    const effective=request.chatId?selectedSettings(settings,request.chatId):settings
    const selection = agentSelection(effective, request.followsDefault === false ? request.agent : effective.defaultAgent)
    if (selection.signature === (pendingSwitch?.signature || activeSelection)) return
    // Keep only the latest choice, and wait for the old provider/tools to finish cancelling.
    pendingSwitch = { execution: activeExecution, toolId: activeToolId, signature: selection.signature }
    sendRunEvent({ type: 'status', message: `Switching to ${selection.label}. Keeping completed work.` })
    activeRun.abort()
    resolveApproval({ approved: false, note: 'Agent changed before approval.' })
  }
  const fingerprint = (settings: AgentSettings) => createHash('sha256').update(JSON.stringify({
    account: accountAuthId(), owner:ownerKey(), project: reported?.projectKey, page: reported?.pageUrl,
    designs: reported ? context.designs.list(designKeyOf(reported.projectKey, reported.pageUrl)) : {},
    tracker: readTrackerFormat(), allowSend: settings.allowSend,
  })).digest('hex')
  const executeRequest = async (request: Request, provider: AgentProvider, signal: AbortSignal, ctx: QaContext, execution: QaExecution) => {
    const settings = readAgentSettings()
    if (request.kind !== 'chat' && !request.args?.breakpoints?.length) {
      const target = ctx.reportedContext()
      const slots: import('../../shared/qaAgent').DesignSlots = target && request.kind === 'review' && !request.args?.standalone ? ctx.designs.list(designKeyOf(target.projectKey, target.pageUrl)) : {}
      const stored = BREAKPOINTS.filter(bp => slots[bp])
      const available = stored.length ? stored : [...BREAKPOINTS]
      request.args = { ...request.args, breakpoints: provider.lite ? liteBreakpoints(available) : available }
      execution.persist()
    }
    const common = { signal, emit: (event: QaRunEvent) => execution.emit(event), budgetTokens: settings.budgetTokens ? Math.max(1, settings.budgetTokens - execution.snapshot().tokens) : undefined }
    if (request.kind === 'review') await runQa({ context: ctx, provider }, { ...request.args, ...common })
    else if (request.kind === 'batch') await runQaBatch({ context: ctx, provider }, { ...request.args, ...common })
    else {
      const result = await runChatTurn({ context: ctx, provider }, { message: request.message!, attachments: request.attachments, history: request.history || [], ...common })
      ctx.assertAccess?.()
      chatHistory = result.history
      if (request.chatId) chats.save({ id: request.chatId }, chatHistory)
    }
  }
  async function launch(agent: AgentId, settings: AgentSettings, request: Request, existing?: QaExecution, toolId?: string): Promise<QaRunStartResult> {
    if (activeRun) return { started: false, error: 'The agent is busy. Stop it first.' }
    if(request.chatId){settings=selectedSettings(settings,request.chatId);agent=request.followsDefault===false?request.agent:settings.defaultAgent}
    if (!existing) request = { ...request, agent, account: accountAuthId(), owner:ownerKey(), remarkStyle: normalizeRemarkStyle(settings.remarkStyle) }
    const execution = existing || new QaExecution(executionFolder(), fingerprint(settings), request)
    executions.set(execution.state.id, execution)
    if (executions.size > 20) { const oldest = executions.keys().next().value; if (oldest && oldest !== execution.state.id) executions.delete(oldest) }
    if (existing) {
      if(request.owner!==ownerKey()||request.account!==accountAuthId())return {started:false,error:'This retry belongs to another account.'}
      const invalid = existing.validate(fingerprint(settings))
      if (invalid) return { started: false, error: invalid }
      if (settings.budgetTokens && existing.snapshot().tokens >= settings.budgetTokens) return { started: false, error: 'The token budget is reached. Increase it in Settings before retrying.' }
      execution.state.request = request
      execution.persist()
    }
    let provider: AgentProvider
    const runToken=randomUUID()+randomUUID()
    try { provider = createProvider(agent, { settings, getKey, getBridge: () => ({ mcpUrl: `http://127.0.0.1:${bridge.port()}/mcp`, token:runToken }) }) }
    catch (error: any) {
      execution.begin(context, new AbortController().signal, () => {})
      execution.emit({ type: 'error', message: error?.message || 'That agent is not set up.' }); execution.finish(); activeExecution = execution
      return { started: false, error: error?.message || 'That agent is not set up.', retryId: execution.state.id }
    }
    const controller = new AbortController(); activeRun = controller; activeExecution = execution
    activeSelection = agentSelection(settings, agent).signature; activeToolId = toolId; workFinished = false
    const executionReported = reported ? structuredClone(reported) : null
    const accountFence=accountContext().assert
    const allowedTools=new Set<string>()
    const frozenContext: QaContext = fenceQaContext({ ...context,allowedTools, agentAccess:true, reportedContext: () => batchTarget || executionReported, organizer: organizerContext(ownerKey()), remarkStyle: () => normalizeRemarkStyle(request.remarkStyle) },()=>{accountFence();if(controller.signal.aborted)throw new Error('Stopped.')})
    const markPrivate=()=>{request.privateRead=true;execution.state.request=request;execution.persist()}
    if (request.kind === 'chat' && request.chatId) {
      const idsInChat = new Set([...(request.attachments || []), ...(request.history || []).flatMap(turn => turn.attachments || [])].map(image => image.id))
      if (idsInChat.size) markPrivate()
      frozenContext.chatImages = async ids => {
        frozenContext.assertAccess?.()
        if (ids.length > 4 || ids.some(id => !idsInChat.has(id))) throw new Error('That image was not attached to this conversation.')
        markPrivate()
        const images = chatImages.images(request.owner!, request.chatId!, ids)
        frozenContext.assertAccess?.()
        return images
      }
    }
    frozenContext.workspace={...workspace,search:async args=>{markPrivate();return workspace.search(args)},detail:async(...args)=>{markPrivate();return workspace.detail(...args)}}
    frozenContext.authorizeTool=async(name,args)=>{
      if(!request.privateRead||!needsPrivateDataApproval(name,args,executionReported?.pageUrl))return
      frozenContext.assertAccess?.()
      const data=JSON.stringify(args);if(data.length>16000)throw new Error('This network action is too large to review. Use a smaller request.')
      const target=(args as any)?.url||browser.site||executionReported?.pageUrl||'Website under review'
      const decision=await requestApproval({id:randomUUID(),action:'network',runId:execution.state.id,projectName:'Review network action',pageUrl:target,columns:['Action','Destination','Data'],rows:[[name,target,data]],severityCounts:{},evidence:[],warnings:['This chat has accessed private Parity records. Review the destination and data before allowing this network action.'],uploadsEvidence:false,network:{tool:name,args,destination:target}})
      frozenContext.assertAccess?.();if(!decision.approved)throw new Error('The network action was cancelled. No private workspace data was sent.')
    }
    const originalProvider = provider
    const runQuotaScope = quotaScope(request.owner!, agent, settings, getKey(agent))
    provider = { ...originalProvider, run: run => {allowedTools.clear();run.tools.forEach(name=>allowedTools.add(name));return originalProvider.run({ ...run, system: stylePrompt(run.system, request.remarkStyle), task: stylePrompt(run.task, request.remarkStyle) })} }
    execution.begin(frozenContext, controller.signal, event => {
      try {accountFence()} catch{return}
      if (event.type === 'quota-observed') {
        if (!controller.signal.aborted && event.quota.agent === agent && quotaScope(request.owner!, agent, settings, getKey(agent)) === runQuotaScope) quotas.observe(runQuotaScope, event.quota)
        return
      }
      sendRunEvent(event)
      if (event.type === 'usage' && settings.budgetTokens && execution.snapshot().tokens >= settings.budgetTokens) {
        controller.abort(); execution.emit({ type: 'error', category: 'budget', message: 'The token budget was reached. Completed findings are saved. Increase the limit to retry.' })
      }
    })
    executionContext = execution.wrapContext(frozenContext)
    scopedTokens.set(runToken,{owner:ownerKey(),context:executionContext})
    executionContext.readResult = (ref, offset) => {
      const [id, resultId] = ref.split('/')
      if (id !== execution.state.id) throw new Error('That result belongs to another execution.')
      return execution.readResult(resultId, offset)
    }
    void (async () => {
      let startedBridge = false
      try {
        if (provider.needsBridge && !bridge.running()) { await startBridge(); startedBridge = bridge.running(); pushStatus() }
        if (provider.needsBridge && !bridge.running()) throw new Error(bridgeError || 'The local bridge could not start. Retry after checking the agent connection.')
        if (controller.signal.aborted) return
        execution.emit({ type: 'started', agent, label: agentSelection(settings, agent).label, budgetTokens: settings.budgetTokens || undefined })
        if (toolId) {allowedTools.add(execution.state.calls[toolId]?.name||'');await execution.retryTool(toolId, executionContext!)}
        else await executeRequest(request, execution.wrapProvider(provider, JSON.stringify({ model: settings.models[agent], endpoint: settings.localBaseUrl })), controller.signal, executionContext!, execution)
      } catch (error: any) { if (!controller.signal.aborted) execution.emit({ type: 'error', message: error?.message || 'The agent could not finish. Try again.' }) }
      finally {
        scopedTokens.delete(runToken)
        workFinished = true
        if (startedBridge && !readConfig().enabled) { await stopBridge(); pushStatus() }
        if (request.kind !== 'chat') browser.close()
        execution.finish(); activeRun = null; executionContext = null
        execution.emit({ type: 'finished' })
        const change = pendingSwitch; pendingSwitch = null; activeToolId = undefined
        if(request.owner===ownerKey())sendRunEvent({ type: 'agent-selected', ...agentSelection(selectedSettings(readAgentSettings(),currentChatId)) })
        if (change?.execution === execution) {
          const next = request.chatId?selectedSettings(readAgentSettings(),request.chatId):readAgentSettings()
          const nextAgent = request.followsDefault === false ? request.agent : next.defaultAgent
          const resumed = await launch(nextAgent, next, { ...request, agent: nextAgent }, execution, change.toolId)
          if (!resumed.started) sendRunEvent({ type: 'error', message: resumed.error, retryId: resumed.retryId || execution.state.id, retryBlocked: execution.snapshot().retryBlocked })
        }
      }
    })()
    return { started: true }
  }
  ipcMain.handle('qa:execution:status', event => fromQaWindow(event) ? activeExecution?.snapshot() || null : null)
  ipcMain.handle('qa:execution:retry', async (event, retryId: unknown): Promise<QaRunStartResult> => {
    if (!fromQaWindow(event) || typeof retryId !== 'string') return { started: false, error: 'That retry is not available.' }
    const [id, toolId] = retryId.split('/')
    const execution = executions.get(id) || QaExecution.load(executionFolder(), id)
    if (!execution) return { started: false, error: 'The retry checkpoint is no longer available. Start a fresh review.' }
    const request = execution.state.request as Request
    const settings = request.chatId?selectedSettings(readAgentSettings(),request.chatId):readAgentSettings()
    const agent = request.followsDefault === false ? request.agent : settings.defaultAgent
    return launch(agent, settings, { ...request, agent }, execution, toolId)
  })
  ipcMain.handle('qa:execution:result', (event, ref: unknown, offset: unknown) => {
    if (!fromQaWindow(event) || typeof ref !== 'string') return null
    const [id, resultId] = ref.split('/')
    const execution = executions.get(id) || QaExecution.load(executionFolder(), id)
    if (!execution || (execution.state.request as Request).account !== accountAuthId()) return null
    try { return execution.readResult(resultId, typeof offset === 'number' ? offset : 0) } catch { return null }
  })

  ipcMain.handle('qa:run:start', async (event, startOptions: unknown): Promise<QaRunStartResult> => {
    if (!fromQaWindow(event)) return { started: false, error: 'Not allowed.' }
    const requested = (startOptions && typeof startOptions === 'object' ? startOptions : {}) as QaRunStartOptions
    const chatId=typeof requested.chatId==='string'&&CHAT_ID_PATTERN.test(requested.chatId)?requested.chatId:null
    const settings = selectedSettings(readAgentSettings(),chatId)
    const agent: AgentId = isAgentId(requested.agent) ? requested.agent : settings.defaultAgent
    const breakpoints = Array.isArray(requested.breakpoints) ? requested.breakpoints.filter(isBreakpoint) : undefined
    // A free tier skips the functional test unless it was asked for: it would not fit in the allowance.
    const functional = typeof requested.functional === 'boolean' ? requested.functional : settings.functionalChecks && !usesFreeTier(agent, settings)
    return launch(agent, settings, { kind: 'review', agent,chatId, followsDefault: !isAgentId(requested.agent), args: { breakpoints, standalone: requested.standalone === true, functional } })
  })

  // Several pages from a list the person pasted (the Multi-capture dialog), reviewed one after another
  // with no design, and handed over for one approval. The list is checked here: only http(s) pages, no
  // WordPress admin or login pages, and no more than a batch can hold.
  ipcMain.handle('qa:batch:start', async (event, startOptions: unknown): Promise<QaRunStartResult> => {
    if (!fromQaWindow(event)) return { started: false, error: 'Not allowed.' }
    const requested = (startOptions && typeof startOptions === 'object' ? startOptions : {}) as Partial<QaBatchStartOptions>
    const pages: BatchPage[] = []
    const seen = new Set<string>()
    for (const raw of Array.isArray(requested.pages) ? requested.pages.slice(0, MAX_BATCH_PAGES * 2) : []) {
      const url = clamp(raw?.url, 2000)
      if (!isReviewablePageUrl(url) || seen.has(url)) continue
      seen.add(url)
      pages.push({ url, name: clamp(raw?.name, 200) || url, projectId: clamp(raw?.projectId, 300) || undefined })
    }
    if (!pages.length) return { started: false, error: 'There are no pages to review. Check that the links start with https:// and are not WordPress admin or login pages.' }
    const settings = readAgentSettings()
    const agent: AgentId = isAgentId(requested.agent) ? requested.agent : settings.defaultAgent
    const breakpoints = Array.isArray(requested.breakpoints) ? requested.breakpoints.filter(isBreakpoint) : undefined
    const functional = typeof requested.functional === 'boolean' ? requested.functional : settings.functionalChecks && !usesFreeTier(agent, settings)
    return launch(agent, settings, { kind: 'batch', agent, followsDefault: !isAgentId(requested.agent), args: { pages: pages.slice(0, MAX_BATCH_PAGES), breakpoints, functional } })
  })

  // The chat: free-form messages to the agent. Main keeps what was said (text only) so the
  // agent remembers the conversation; "new chat" clears it.
  let chatHistory: ChatTurn[] = []
  let currentChatId: string | null = null
  const chatFiles = () => { const owner = ownerKey(); return createChatStore(join(accountFolder(),'chats'), Date.now, id => chatImages.removeChat(owner, id)) }
  const chats = {list:()=>chatFiles().list(),load:(id:string)=>chatFiles().load(id),save:(...args:Parameters<ReturnType<typeof createChatStore>['save']>)=>chatFiles().save(...args),remove:(id:string)=>chatFiles().remove(id)}
  ipcMain.handle('qa:chat:selection', (event,id:unknown,selection:unknown) => {
    if(!fromQaWindow(event)||typeof id!=='string'||!CHAT_ID_PATTERN.test(id))throw new Error('Invalid chat reference.')
    const chosen=selection as ChatAgentSelection|null
    if(chosen!==null&&(!chosen||!isAgentId(chosen.agent)||typeof chosen.model!=='string'||chosen.model.length>200))throw new Error('Choose an available agent and model.')
    if(activeRun&&(activeExecution?.state.request as Request).chatId!==id)throw new Error('Switch models in the active chat, or stop the current request first.')
    chatSelections.set(id,chosen);chats.save({id,selection:chosen});currentChatId=id
    const label=agentSelection(selectedSettings(readAgentSettings(),id)).label
    sendRunEvent({type:'chat-selection',chatId:id,selection:chosen,label,switching:!!activeRun});selectionChanged(readAgentSettings());return {selection:chosen,label}
  })
  const history = createRunHistory({ runs, trackerFormat: readTrackerFormat })
  ipcMain.handle('qa:chat-images:add', async (event, input: { chatId: string; ownerKey: string | null; files: ChatImageUpload[] }) => {
    if (!fromQaWindow(event) || !input || input.ownerKey !== accountOwner()) throw new Error('The account changed. Add the images again in this account.')
    const guard = accountContext().assert, owner = ownerKey()
    const added = await chatImages.add(owner, input.chatId, input.files, guard)
    guard(); chats.save({ id: input.chatId })
    return added
  })
  ipcMain.handle('qa:chat-images:picture', (event, chatId: string, id: string, full?: boolean) => {
    if (!fromQaWindow(event)) throw new Error('Not allowed.')
    return chatImages.picture(ownerKey(), chatId, id, full === true)
  })
  ipcMain.handle('qa:chat:send', async (event, text: unknown, chatOptions: unknown): Promise<QaRunStartResult> => {
    if (!fromQaWindow(event)) return { started: false, error: 'Not allowed.' }
    const message = typeof text === 'string' ? text.trim().slice(0, MAX_CHAT_MESSAGE) : ''
    const requested = (chatOptions && typeof chatOptions === 'object' ? chatOptions : {}) as QaChatSendOptions
    // A message for another chat than the last one: the agent remembers that chat instead.
    const chatId = typeof requested.chatId === 'string' && CHAT_ID_PATTERN.test(requested.chatId) ? requested.chatId : null
    let attachments: ChatImage[] = []
    try { if (requested.attachmentIds?.length) { if (!chatId) throw new Error('Choose a chat before sending images.'); attachments = chatImages.references(ownerKey(), chatId, requested.attachmentIds) } }
    catch (error) { return { started: false, error: error instanceof Error ? error.message : 'Could not load these images.' } }
    if (!message && !attachments.length) return { started: false, error: 'Type a message or attach an image first.' }
    if (chatId !== currentChatId && !activeRun) { chatHistory = chatId ? chats.load(chatId)?.history ?? [] : []; currentChatId = chatId }
    const settings = readAgentSettings()
    const agent: AgentId = isAgentId(requested.agent) ? requested.agent : settings.defaultAgent
    return launch(agent, settings, { kind: 'chat', agent, followsDefault: !isAgentId(requested.agent), message: message || 'Please inspect the attached images.', attachments, history: structuredClone(chatHistory), chatId: currentChatId })
  })
  ipcMain.handle('qa:chat:reset', (event) => {
    if (!fromQaWindow(event) || activeRun) return false
    chatHistory = []
    currentChatId = null
    browser.close()
    selectionChanged(readAgentSettings())
    return true
  })

  // ── Saved chats ─────────────────────────────────────────────────────────────────
  ipcMain.handle('qa:chats:list', (event): QaChatListItem[] => (fromQaWindow(event) ? chats.list() : []))
  ipcMain.handle('qa:chats:open', (event, id: unknown): QaStoredChat | null => {
    if (!fromQaWindow(event) || activeRun || typeof id !== 'string') return null
    const chat = chats.load(id)
    if (!chat) return null
    chatHistory = chat.history
    currentChatId = chat.id
    chatSelections.set(chat.id,chat.selection||null)
    const { history: _remembered, ...shown } = chat
    return shown
  })
  ipcMain.handle('qa:chats:save', (event, input: unknown): boolean => {
    if (!fromQaWindow(event) || !input || typeof input !== 'object') return false
    if ((input as { ownerKey?: unknown }).ownerKey !== accountOwner()) return false
    const id = (input as { id?: unknown }).id
    return !!chats.save(input as Parameters<typeof chats.save>[0], id === currentChatId ? chatHistory : undefined)
  })
  ipcMain.handle('qa:chats:delete', (event, id: unknown): boolean => {
    if (!fromQaWindow(event) || typeof id !== 'string') return false
    if (id === currentChatId && !activeRun) { currentChatId = null; chatHistory = [] }
    return chats.remove(id)
  })

  // ── Past reviews ────────────────────────────────────────────────────────────────
  const safely = <T,>(work: () => T, fallback: T): T => { try { return work() } catch { return fallback } }
  ipcMain.handle('qa:history:list', (event): QaRunListItem[] => (fromQaWindow(event) ? safely(() => history.list(), []) : []))
  ipcMain.handle('qa:history:detail', (event, id: unknown): QaRunDetail | null => (fromQaWindow(event) && typeof id === 'string' ? safely(() => history.detail(id), null) : null))
  ipcMain.handle('qa:history:picture', async (event, id: unknown, ref: unknown): Promise<string | null> => {
    if (!fromQaWindow(event) || typeof id !== 'string' || !ref || typeof ref !== 'object') return null
    const assert=accountContext().assert
    try { const picture=await history.picture(id, ref as QaHistoryPicture);assert();return picture } catch { return null }
  })
  ipcMain.handle('qa:history:copy', (event, id: unknown, stamp: unknown): number => {
    if (!fromQaWindow(event) || typeof id !== 'string' || typeof stamp !== 'string') return 0
    const copied = safely(() => history.copiedRows(id, stamp), null)
    if (!copied) return 0
    clipboard.write({ text: copied.text, html: copied.html })
    return copied.count
  })
  ipcMain.handle('qa:history:open-folder', async (event, id: unknown): Promise<boolean> => {
    if (!fromQaWindow(event) || typeof id !== 'string') return false
    try {
      if (!runs.get(id)) return false
      const output = join(runs.folder(id), 'output')
      return (await shell.openPath(existsSync(output) ? output : runs.folder(id))) === ''
    } catch { return false }
  })
  ipcMain.handle('qa:history:pin', (event, id: unknown, pinned: unknown): boolean => (fromQaWindow(event) && typeof id === 'string' ? safely(() => !!runs.setPinned(id, pinned === true), false) : false))
  // A run may still be in use while the agent is working, so nothing is deleted then.
  ipcMain.handle('qa:history:delete', (event, id: unknown): boolean => (fromQaWindow(event) && typeof id === 'string' && !activeRun ? safely(() => runs.remove(id), false) : false))
  ipcMain.handle('qa:run:stop', (event) => {
    if (!fromQaWindow(event)) return false
    const stoppedQuota = quotas.cancel()
    pendingSwitch = null
    activeRun?.abort()
    if (activeRun) resolveApproval({ approved: false, note: 'Stopped before approval.' })
    return !!activeRun || stoppedQuota
  })
  ipcMain.handle('qa:run:active', (event) => (fromQaWindow(event) ? !!activeRun : false))

  // ── The `parity` command ──────────────────────────────────────────────────────────
  const cliScript = () => (app.isPackaged ? join(process.resourcesPath, 'cli', 'parity.cjs') : join(app.getAppPath(), 'resources', 'cli', 'parity.cjs'))
  const launcherPath = () => (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Parity', 'bin', 'parity.cmd') : join(homedir(), '.local', 'bin', 'parity'))
  const onPath = (folder: string) => (process.env.PATH || '').split(delimiter).some((entry) => entry && entry.replace(/[\\/]+$/, '') === folder.replace(/[\\/]+$/, ''))
  ipcMain.handle('qa:cli:status', (event) => {
    if (!fromQaWindow(event)) return null
    const file = launcherPath()
    return { installed: existsSync(file), path: file, onPath: onPath(dirname(file)), platform: process.platform }
  })
  ipcMain.handle('qa:cli:install', (event) => {
    if (!fromQaWindow(event)) return null
    const file = launcherPath()
    const executable = process.env.APPIMAGE || process.execPath
    mkdirSync(dirname(file), { recursive: true })
    if (process.platform === 'win32') writeFileSync(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${cliScript()}" %*\r\n`, 'utf8')
    else {
      writeFileSync(file, `#!/bin/sh\n# Installed by Parity. Runs Parity's built-in command line tool.\nELECTRON_RUN_AS_NODE=1 exec "${executable}" "${cliScript()}" "$@"\n`, { mode: 0o755 })
      try { chmodSync(file, 0o755) } catch { /* not supported here */ }
    }
    return { installed: true, path: file, onPath: onPath(dirname(file)), platform: process.platform }
  })
  if (readConfig().enabled) void startBridge().then(pushStatus)
  onAccountChanged(()=>{
    quotas.clear()
    activeRun?.abort();pendingSwitch=null;resolveApproval({approved:false,note:'The account changed.'});browser.close();reported=null;batchTarget=null;targetThumbs=null
    chatHistory=[];currentChatId=null;chatSelections.clear();executions.clear();appLocation={workspace:'dashboard'}
    scopedTokens.clear();token='';resetToken(tokenFile());void stopBridge().then(()=>{if(readConfig().enabled)void startBridge()})
    sendRunEvent({type:'account-reset'});activeExecution=null
  })

  if (!existsSync(root())) { try { mkdirSync(root(), { recursive: true }) } catch { /* created on first save */ } }
  return { context: () => context, workspace, attachMainWindow }
}
