import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/theme/themes.css'
import AgentsPanel from '../../src/renderer/src/components/AgentsPanel'
import DesignSlots from '../../src/renderer/src/components/DesignSlots'
import QaApprovalCard from '../../src/renderer/src/components/QaApprovalCard'
import QaConsole from '../../src/renderer/src/components/QaConsole'

// Stand-in for the app's bridge to the main process, so the real components can be rendered and
// driven without the rest of Parity.
const swatch = (color: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="${color}"/><rect x="20" y="20" width="200" height="24" fill="#fff" opacity=".8"/></svg>`)}`
const agents = [
  { id: 'claude-code', label: 'Claude Code (your Claude plan)', kind: 'subscription', ready: true, detail: '2.1.284 (Claude Code) · signed in (claude.ai)', model: '', needsKey: false, hasKey: false },
  { id: 'codex', label: 'Codex (your ChatGPT plan)', kind: 'subscription', ready: false, detail: 'Not found. Install codex and sign in, then refresh.', model: '', needsKey: false, hasKey: false },
  { id: 'gemini-cli', label: 'Gemini CLI (your Gemini plan)', kind: 'subscription', ready: false, detail: 'Not found. Install gemini and sign in, then refresh.', model: '', needsKey: false, hasKey: false },
  { id: 'anthropic-api', label: 'Claude API key', kind: 'api', ready: false, detail: 'Add your API key.', model: 'claude-opus-5-5', needsKey: true, hasKey: false },
  { id: 'openai-api', label: 'OpenAI API key', kind: 'api', ready: true, detail: 'gpt-test', model: 'gpt-test', needsKey: true, hasKey: true },
  { id: 'gemini-api', label: 'Gemini API key', kind: 'api', ready: false, detail: 'Add your API key.', model: '', needsKey: true, hasKey: false },
  { id: 'local', label: 'Local model (Ollama, LM Studio)', kind: 'local', ready: false, detail: 'Choose a model that can read pictures and use tools.', model: '', needsKey: false, hasKey: false },
]
const settings = { defaultAgent: 'claude-code', models: Object.fromEntries(agents.map((a) => [a.id, a.model])), effort: 'medium', localBaseUrl: 'http://localhost:11434/v1', budgetTokens: 0, evidenceUploads: true, evidenceDays: 90 }
const bridge = { enabled: true, running: true, port: 29849, error: '', keyHint: '••••a1b2', mcpUrl: 'http://127.0.0.1:29849/mcp', keyFile: '/home/user/.config/Parity/qa-agent/token', lastRequestAt: 1, recent: [{ at: Date.now(), method: 'POST', path: '/mcp', status: 200, ms: 12, tool: 'capture_live' }, { at: Date.now() - 4000, method: 'GET', path: '/api/status', status: 401, ms: 1 }] }
const calls: string[] = []
let runListener: ((event: unknown) => void) | null = null
;(window as any).__calls = calls
;(window as any).__emit = (event: unknown) => runListener?.(event)
;(window as any).electronAPI = {
  accountStatus: async () => ({ signedIn: false, needsSetup: false }),
  qaAgentsOverview: async () => ({ settings, agents, keyStorage: 'secure' }),
  qaAgentsSaveSettings: async (patch: any) => { calls.push(`save ${JSON.stringify(patch)}`); return { settings, agents, keyStorage: 'secure' } },
  qaAgentsSetKey: async () => ({ settings, agents, keyStorage: 'secure' }),
  qaAgentsClearKey: async () => ({ settings, agents, keyStorage: 'secure' }),
  qaAgentsModels: async () => ({ models: ['gpt-test', 'gpt-test-mini'] }),
  qaBridgeStatus: async () => bridge,
  qaBridgeSetEnabled: async () => bridge,
  qaBridgeResetKey: async () => bridge,
  onQaBridgeStatus: () => () => {},
  qaTrackerFormatGet: async () => ({ version: 1, columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'], examples: [] }),
  qaTrackerFormatSave: async (text: string) => { calls.push(`tracker ${text.length}`); return { ok: false, error: 'The first row should be the tracker\'s column names.' } },
  qaTrackerFormatClear: async () => true,
  qaCliStatus: async () => ({ installed: false, path: '/home/user/.local/bin/parity', onPath: false, platform: 'linux' }),
  qaCliInstall: async () => ({ installed: true, path: '/home/user/.local/bin/parity', onPath: true, platform: 'linux' }),
  qaRunActive: async () => false,
  onQaRunEvent: (callback: (event: unknown) => void) => { runListener = callback; return () => { runListener = null } },
  qaRunStart: async (options: unknown) => { calls.push(`run ${JSON.stringify(options)}`); return { started: true } },
  qaRunStop: async () => false,
  qaCallTool: async (name: string, args: unknown) => { calls.push(`tool ${name} ${JSON.stringify(args)}`); return { text: name === 'get_context' ? '{ "project": { "name": "[Svenson] Alopecia" } }' : 'ok', isError: false, images: name === 'capture_live' ? [{ dataUrl: swatch('#223344'), caption: 'Overview desktop' }] : [] } },
}

const approval = {
  id: 'a1', runId: 'run-1', projectName: '[Svenson] Alopecia', pageUrl: 'https://svenson.test/alopecia-page/',
  columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'],
  rows: [
    ['Alopecia', 'Heading "The Basics of Alopecia Areata" is 28px; the design shows ≈32px', '32px', '', 'High'],
    ['Alopecia', "'- Button label differs: live says Book now, design says Book a Consultation", '', '', 'Low'],
    ['Alopecia', 'Content overflows the page horizontally by 100px (div.alt-text-image)', 'No horizontal scroll', '', 'High'],
  ],
  severityCounts: { High: 2, Low: 1 },
  evidence: [{ rowIndex: 0, thumbnail: swatch('#335577'), caption: 'Heading size' }, { rowIndex: 2, thumbnail: swatch('#775533'), caption: 'Overflow' }],
  warnings: ['Evidence images were not uploaded: Sign in to Parity to upload evidence. The screenshot column is left empty.'],
  uploadsEvidence: false,
}

function Fixture() {
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') || 'agents')
  ;(window as any).__setView = setView
  return (
    <main style={{ padding: 24, minHeight: '100vh', boxSizing: 'border-box' }}>
      {view === 'agents' && <div style={{ maxWidth: 720 }}><AgentsPanel /></div>}
      {view === 'slots' && <div style={{ maxWidth: 360, border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}><DesignSlots
        slots={{
          desktop: { breakpoint: 'desktop', fileName: 'home@2x.png', pixelWidth: 2880, pixelHeight: 6000, scale: 2, frameWidth: 1440, frameHeight: 3000, detection: 'dimensions', confidence: 'high', sha256: 'a', addedAt: 1 },
          mobile: { breakpoint: 'mobile', fileName: 'tab.png', pixelWidth: 1000, pixelHeight: 2000, scale: 1, frameWidth: 1000, frameHeight: 2000, detection: 'fallback', confidence: 'low', sha256: 'b', addedAt: 1 },
        }}
        thumbnails={{ desktop: swatch('#335577'), mobile: swatch('#553377') }} activeBreakpoint="desktop"
        onAddFiles={(files, target) => (window as any).__calls.push(`add ${files.length} ${target}`)} onRemove={(bp) => (window as any).__calls.push(`remove ${bp}`)} onMove={(bp, to) => (window as any).__calls.push(`move ${bp} ${to}`)} onScale={(bp, s) => (window as any).__calls.push(`scale ${bp} ${s}`)} /></div>}
      {view === 'approval' && <QaApprovalCard request={approval} onDecide={(approved, note) => (window as any).__calls.push(`decide ${approved} ${note ?? ''}`)} />}
      {view === 'console' && <QaConsole open onClose={() => {}} />}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
