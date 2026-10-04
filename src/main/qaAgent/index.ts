import { app, BrowserWindow, clipboard, ipcMain, safeStorage, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { isBreakpoint } from '../../shared/designScale'
import { isAgentId, type AgentId, type AgentsOverview, type AgentSettings, type ApprovalDecision, type ApprovalRequest, type QaChatSendOptions, type QaRunEvent, type QaRunStartOptions, type QaRunStartResult, type QaToolCallResult, type ReportedContext } from '../../shared/qaAgent'
import { isTrackerFormat, parseTrackerPaste, STANDARD_TRACKER, type TrackerFormat } from '../../shared/trackerFormat'
import type { DesignStore } from '../designStore'
import { createEvidenceUploader } from './evidenceUpload'
import { captureLivePage } from './liveCapture'
import { runChatTurn } from './chat'
import { runQa } from './runner'
import { createRunStore } from './runStore'
import { accountAccessToken, accountAuthId, parityPublicConfig } from '../account'
import { createProvider, describeAgents, listModels, normalizeSettings } from './agents/registry'
import type { AgentProvider, ChatTurn } from './agents/types'
import { createBridgeServer, type BridgeLogEntry } from './bridge/httpServer'
import { ensureToken, resetToken } from './bridge/token'
import { callTool, type QaContext, type ToolResult } from './tools'

// Electron wiring for the QA tools: the page the window reports, the approval handshake,
// clipboard, tracker format storage and the IPC entry points. The tools themselves live in
// tools.ts and do not import Electron.

const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_BRIDGE_PORT = 29849
const LOG_LIMIT = 50
const MAX_CHAT_MESSAGE = 4000
const clamp = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

interface Options {
  getMainWindow: () => BrowserWindow | null
  getDesignStore: () => DesignStore
}

function toRendererResult(result: ToolResult): QaToolCallResult {
  return {
    text: result.text,
    isError: !!result.isError,
    images: (result.images || []).map((image) => ({ dataUrl: `data:${image.mimeType};base64,${image.data.toString('base64')}`, caption: image.caption, file: image.file })),
  }
}

export function registerQaAgent(options: Options): { context: () => QaContext; attachMainWindow: (window: BrowserWindow) => void } {
  const root = () => join(app.getPath('userData'), 'qa-agent')
  const trackerFile = () => join(root(), 'tracker-format.json')
  const runs = createRunStore(join(app.getPath('userData'), 'qa-runs'))
  try { runs.prune() } catch (error) { console.warn('[Parity QA] Could not prune old runs:', error) }

  let reported: ReportedContext | null = null
  let pendingApproval: { id: string; resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout } | null = null

  const fromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const window = options.getMainWindow()
    return !!window && !window.isDestroyed() && event.senderFrame === window.webContents.mainFrame
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
    const { resolve } = pendingApproval
    pendingApproval = null
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

  const context: QaContext = {
    now: () => Date.now(),
    reportedContext: () => reported,
    designs: {
      list: (projectKey) => options.getDesignStore().list(projectKey),
      put: (projectKey, bytes, putOptions) => options.getDesignStore().put(projectKey, bytes, putOptions),
      readNormalized: async (projectKey, breakpoint) => {
        const path = await options.getDesignStore().normalizedPath(projectKey, breakpoint)
        return path ? readFile(path) : null
      },
    },
    runs,
    capture: (captureOptions) => captureLivePage(captureOptions),
    trackerFormat: readTrackerFormat,
    readLocalFile: (path) => readFile(path),
    approve: requestApproval,
    copyToClipboard: (text, html) => clipboard.write({ text, html }),
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
    if (!fromMainWindow(event)) return { text: 'Not allowed.', isError: true, images: [] }
    if (typeof name !== 'string') return { text: 'A tool name is required.', isError: true, images: [] }
    return toRendererResult(await callTool(name, args, context))
  })

  ipcMain.handle('qa:approval-decision', (event, id: unknown, decision: unknown) => {
    if (!fromMainWindow(event) || !pendingApproval || id !== pendingApproval.id) return false
    const d = decision as Partial<ApprovalDecision>
    resolveApproval({ approved: d?.approved === true, note: clamp(d?.note, 500) || undefined })
    options.getMainWindow()?.flashFrame(false)
    return true
  })

  ipcMain.handle('qa:tracker-format:get', (event) => (fromMainWindow(event) ? readTrackerFormat() : null))
  ipcMain.handle('qa:tracker-format:save', (event, text: unknown) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'Not allowed.' }
    if (typeof text !== 'string' || text.length > 200_000) return { ok: false, error: 'Paste the header row and a few example rows from the tracker.' }
    const parsed = parseTrackerPaste(text)
    if (parsed.ok) writeTrackerFormat(parsed.format)
    return parsed
  })
  ipcMain.handle('qa:tracker-format:clear', (event) => {
    if (!fromMainWindow(event)) return false
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
  const bridge = createBridgeServer({
    getContext: () => context,
    getToken: () => token,
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

  ipcMain.handle('qa:bridge:status', (event) => (fromMainWindow(event) ? bridgeStatus() : null))
  ipcMain.handle('qa:bridge:set-enabled', async (event, enabled: unknown) => {
    if (!fromMainWindow(event)) return null
    const config = readConfig()
    writeConfig({ ...config, enabled: enabled === true })
    if (enabled === true) await startBridge()
    else { bridgeError = ''; await stopBridge() }
    pushStatus()
    return bridgeStatus()
  })
  ipcMain.handle('qa:bridge:reset-key', (event) => {
    if (!fromMainWindow(event)) return null
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

  ipcMain.handle('qa:agents:overview', async (event) => (fromMainWindow(event) ? overview() : null))
  ipcMain.handle('qa:agents:save-settings', async (event, patch: unknown) => {
    if (!fromMainWindow(event)) return null
    const current = readAgentSettings()
    const incoming = (patch && typeof patch === 'object' ? patch : {}) as Partial<AgentSettings>
    writeAgentSettings(normalizeSettings({ ...current, ...incoming, models: { ...current.models, ...(incoming.models || {}) } }))
    return overview()
  })
  ipcMain.handle('qa:agents:set-key', async (event, id: unknown, key: unknown) => {
    if (!fromMainWindow(event) || !isAgentId(id)) return null
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 500) return { error: 'That does not look like an API key.' }
    if (!safeStorage.isEncryptionAvailable()) return { error: 'This computer has no secure place to keep a key (no system keychain). The key was not saved.' }
    mkdirSync(root(), { recursive: true })
    writeFileSync(keyFile(id), safeStorage.encryptString(key.trim()), { mode: 0o600 })
    try { chmodSync(keyFile(id), 0o600) } catch { /* not supported here */ }
    return overview()
  })
  ipcMain.handle('qa:agents:clear-key', async (event, id: unknown) => {
    if (!fromMainWindow(event) || !isAgentId(id)) return null
    rmSync(keyFile(id), { force: true })
    return overview()
  })
  ipcMain.handle('qa:agents:models', async (event, id: unknown) => {
    if (!fromMainWindow(event) || !isAgentId(id)) return { models: [], error: 'Not allowed.' }
    return listModels(id, { settings: readAgentSettings(), getKey })
  })

  // One review at a time. Agent CLIs reach the tools over the bridge, so it is started for the
  // length of the run if the person has not turned it on.
  let activeRun: AbortController | null = null
  const sendRunEvent = (event: QaRunEvent) => {
    const window = options.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('qa:run:event', event)
  }
  // Starts one agent job (a review run or a chat message) if none is running. Agent CLIs reach the
  // tools over the bridge, so it is started for the length of the job if it is not already on.
  async function launch(agent: AgentId, settings: AgentSettings, job: (provider: AgentProvider, signal: AbortSignal) => Promise<void>): Promise<QaRunStartResult> {
    if (activeRun) return { started: false, error: 'The agent is busy. Stop it first.' }
    let provider: AgentProvider
    try { provider = createProvider(agent, { settings, getKey, getBridge: () => ({ mcpUrl: `http://127.0.0.1:${bridge.port()}/mcp`, token }) }) }
    catch (error: any) { return { started: false, error: error?.message || 'That agent is not set up.' } }

    const controller = new AbortController()
    activeRun = controller
    void (async () => {
      let startedBridge = false
      try {
        if (provider.needsBridge && !bridge.running()) { await startBridge(); startedBridge = bridge.running(); pushStatus() }
        if (provider.needsBridge && !bridge.running()) { sendRunEvent({ type: 'error', message: bridgeError || 'The local bridge could not start, so this agent cannot reach Parity\'s tools.' }); return }
        sendRunEvent({ type: 'started', agent, label: provider.label, budgetTokens: settings.budgetTokens || undefined })
        await job(provider, controller.signal)
      } catch (error: any) {
        sendRunEvent({ type: 'error', message: error?.message || 'The agent failed.' })
      } finally {
        if (startedBridge && !readConfig().enabled) { await stopBridge(); pushStatus() }
        activeRun = null
        sendRunEvent({ type: 'finished' })
      }
    })()
    return { started: true }
  }

  ipcMain.handle('qa:run:start', async (event, startOptions: unknown): Promise<QaRunStartResult> => {
    if (!fromMainWindow(event)) return { started: false, error: 'Not allowed.' }
    const requested = (startOptions && typeof startOptions === 'object' ? startOptions : {}) as QaRunStartOptions
    const settings = readAgentSettings()
    const agent: AgentId = isAgentId(requested.agent) ? requested.agent : settings.defaultAgent
    const breakpoints = Array.isArray(requested.breakpoints) ? requested.breakpoints.filter(isBreakpoint) : undefined
    return launch(agent, settings, async (provider, signal) => {
      await runQa({ context, provider }, { breakpoints, signal, emit: sendRunEvent, budgetTokens: settings.budgetTokens || undefined })
    })
  })

  // The chat: free-form messages to the agent. Main keeps what was said (text only) so the
  // agent remembers the conversation; "new chat" clears it.
  let chatHistory: ChatTurn[] = []
  ipcMain.handle('qa:chat:send', async (event, text: unknown, chatOptions: unknown): Promise<QaRunStartResult> => {
    if (!fromMainWindow(event)) return { started: false, error: 'Not allowed.' }
    const message = typeof text === 'string' ? text.trim().slice(0, MAX_CHAT_MESSAGE) : ''
    if (!message) return { started: false, error: 'Type a message first.' }
    const requested = (chatOptions && typeof chatOptions === 'object' ? chatOptions : {}) as QaChatSendOptions
    const settings = readAgentSettings()
    const agent: AgentId = isAgentId(requested.agent) ? requested.agent : settings.defaultAgent
    return launch(agent, settings, async (provider, signal) => {
      const result = await runChatTurn({ context, provider }, { message, history: chatHistory, signal, emit: sendRunEvent, budgetTokens: settings.budgetTokens || undefined })
      chatHistory = result.history
    })
  })
  ipcMain.handle('qa:chat:reset', (event) => {
    if (!fromMainWindow(event) || activeRun) return false
    chatHistory = []
    return true
  })
  ipcMain.handle('qa:run:stop', (event) => {
    if (!fromMainWindow(event)) return false
    activeRun?.abort()
    return !!activeRun
  })
  ipcMain.handle('qa:run:active', (event) => (fromMainWindow(event) ? !!activeRun : false))

  // ── The `parity` command ──────────────────────────────────────────────────────────
  const cliScript = () => (app.isPackaged ? join(process.resourcesPath, 'cli', 'parity.cjs') : join(app.getAppPath(), 'resources', 'cli', 'parity.cjs'))
  const launcherPath = () => (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Parity', 'bin', 'parity.cmd') : join(homedir(), '.local', 'bin', 'parity'))
  const onPath = (folder: string) => (process.env.PATH || '').split(delimiter).some((entry) => entry && entry.replace(/[\\/]+$/, '') === folder.replace(/[\\/]+$/, ''))
  ipcMain.handle('qa:cli:status', (event) => {
    if (!fromMainWindow(event)) return null
    const file = launcherPath()
    return { installed: existsSync(file), path: file, onPath: onPath(dirname(file)), platform: process.platform }
  })
  ipcMain.handle('qa:cli:install', (event) => {
    if (!fromMainWindow(event)) return null
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

  if (!existsSync(root())) { try { mkdirSync(root(), { recursive: true }) } catch { /* created on first save */ } }
  return { context: () => context, attachMainWindow }
}
