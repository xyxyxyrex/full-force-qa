import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/theme/themes.css'
import AgentsPanel from '../../src/renderer/src/components/AgentsPanel'
import DesignSlots from '../../src/renderer/src/components/DesignSlots'
import QaApprovalCard from '../../src/renderer/src/components/QaApprovalCard'
import QaChat from '../../src/renderer/src/components/QaChat'
import QaHistory from '../../src/renderer/src/components/QaHistory'
import QaTrackerModal from '../../src/renderer/src/components/qaChat/QaTrackerModal'
import { useEffect } from 'react'

// Stand-in for the app's bridge to the main process, so the real components can be rendered and
// driven without the rest of Parity.
const swatch = (color: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="${color}"/><rect x="20" y="20" width="200" height="24" fill="#fff" opacity=".8"/></svg>`)}`
const agents = [
  { id: 'claude-code', label: 'Claude Code (your Claude plan)', kind: 'subscription', ready: true, detail: '2.1.284 (Claude Code) · signed in (claude.ai)', model: '', needsKey: false, hasKey: false },
  { id: 'codex', label: 'Codex (your ChatGPT plan)', kind: 'subscription', ready: false, detail: 'Not found. Install codex and sign in, then refresh.', model: '', needsKey: false, hasKey: false },
  { id: 'antigravity', label: 'Antigravity CLI (your Google plan)', kind: 'subscription', ready: false, detail: 'Not found. Install agy and sign in, then refresh.', model: '', needsKey: false, hasKey: false },
  { id: 'anthropic-api', label: 'Claude API key', kind: 'api', ready: false, detail: 'Add your API key.', model: 'claude-opus-5-5', needsKey: true, hasKey: false },
  { id: 'openai-api', label: 'OpenAI API key', kind: 'api', ready: true, detail: 'gpt-test', model: 'gpt-test', needsKey: true, hasKey: true },
  { id: 'gemini-api', label: 'Gemini API key (free tier)', kind: 'free', ready: false, detail: 'Add your free API key (no card needed), then list the models.', model: '', needsKey: true, hasKey: false, lite: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter (free models)', kind: 'free', ready: false, detail: 'List the models and choose one.', model: '', needsKey: true, hasKey: true, lite: false, keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'local', label: 'Local or custom server (Ollama, LM Studio, any OpenAI-compatible API)', kind: 'local', ready: false, detail: 'Choose a model that can read pictures and use tools.', model: '', needsKey: true, keyOptional: true, hasKey: false },
].map((agent) => ({ lite: false, ...agent }))
let settings = { defaultAgent: 'claude-code', models: Object.fromEntries(agents.map((a) => [a.id, a.model])), effort: 'medium', localBaseUrl: 'http://localhost:11434/v1', budgetTokens: 0, evidenceUploads: true, evidenceDays: 90, allowSend: false, functionalChecks: true, geminiBilling: false }
const bridge = { enabled: true, running: true, port: 29849, error: '', keyHint: '••••a1b2', mcpUrl: 'http://127.0.0.1:29849/mcp', keyFile: '/home/user/.config/Parity/qa-agent/token', lastRequestAt: 1, recent: [{ at: Date.now(), method: 'POST', path: '/mcp', status: 200, ms: 12, tool: 'capture_live' }, { at: Date.now() - 4000, method: 'GET', path: '/api/status', status: 401, ms: 1 }] }
const slot = (breakpoint: string, fileName: string, frameWidth: number, scale: number) => ({ breakpoint, fileName, pixelWidth: frameWidth * scale, pixelHeight: 6000, scale, frameWidth, frameHeight: 3000, detection: 'dimensions', confidence: 'high', sha256: fileName, addedAt: 1 })
const alopeciaTarget = {
  projectName: '[Svenson] Alopecia', pageUrl: 'https://svenson.test/alopecia-page/', pageId: '/alopecia-page',
  slots: { desktop: slot('desktop', 'alopecia-desktop@2x.png', 1440, 2), mobile: slot('mobile', 'alopecia-mobile@2x.png', 390, 2) },
  thumbnails: { desktop: swatch('#335577'), mobile: swatch('#553377') },
}
;(window as any).__target = alopeciaTarget
;(window as any).__targets = { alopecia: alopeciaTarget, contact: { projectName: '[Svenson] Alopecia', pageUrl: 'https://svenson.test/contact/', pageId: '/contact', slots: {}, thumbnails: {} } }
let firstOverview = true
const calls: string[] = []
let runListener: ((event: unknown) => void) | null = null
const findingListeners=new Set<(event:{projectKey:string})=>void>()
let findingSnapshot:any={projectKey:'proj-1',projectName:'Fixture project',revision:1,columns:['Page Link','Section','Screenshot','Remarks','Priority (QA/PM)','Display','Status'],choices:{Status:['IN PROGRESS (DEV)','APPROVED (QA)','ENHANCEMENT (QA)']},findings:[
  {id:'finding-a',projectKey:'proj-1',projectName:'Fixture project',pageUrl:'https://fixture.test/home/',cells:{Section:'Hero',Remarks:'Increase the heading to **32px**, matching the design.',Display:'Desktop'},sources:[{runId:'audit-one',breakpoint:'desktop',area:'visual'}],sourceKeys:[],review:'draft',edited:[],createdAt:1,updatedAt:1,evidence:{file:'fixture',caption:'Heading evidence'}},
  {id:'finding-b',projectKey:'proj-1',projectName:'Fixture project',pageUrl:'https://fixture.test/home/',cells:{Section:'Contact',Remarks:'Add a success message after sending.',Status:'ENHANCEMENT (QA)',Display:'Mobile'},sources:[{runId:'audit-one',breakpoint:'mobile',area:'functional'}],sourceKeys:[],review:'draft',edited:[],createdAt:2,updatedAt:2},
  {id:'finding-c',projectKey:'proj-1',projectName:'Fixture project',pageUrl:'https://fixture.test/about/',cells:{Section:'Footer',Remarks:'Fix the broken link.',Display:'Desktop'},sources:[{runId:'audit-two',breakpoint:'desktop',area:'functional'}],sourceKeys:[],review:'accepted',edited:[],createdAt:3,updatedAt:3},
]}
;(window as any).__addFinding=()=>{findingSnapshot.findings.push({...structuredClone(findingSnapshot.findings[0]),id:'finding-streamed',cells:{Section:'Navbar',Remarks:'Close the menu after navigation.'}});findingSnapshot.revision++;findingListeners.forEach(fn=>fn({projectKey:'proj-1'}))}
;(window as any).__calls = calls
;(window as any).__emit = (event: unknown) => runListener?.(event)
;(window as any).electronAPI = {
  accountStatus: async () => ({ signedIn: false, needsSetup: false }),
  onAccountChanged: () => () => {},
  getProjects: async () => [{id:'proj-1',googleSheetUrl:'https://docs.google.com/spreadsheets/d/test/edit'}],
  qaFindingsList: async () => structuredClone(findingSnapshot),
  onQaFindingsChanged: (fn:(event:{projectKey:string})=>void) => {findingListeners.add(fn);return()=>findingListeners.delete(fn)},
  qaFindingsUpdate: async (_key:string,revision:number,changes:any[]) => {
    calls.push(`findings-update ${JSON.stringify(changes)}`)
    if((window as any).__findingSaveError||revision!==findingSnapshot.revision)return{success:false,error:'Findings changed while editing. Refresh and retry.'}
    changes.forEach(change=>{const item=findingSnapshot.findings.find((f:any)=>f.id===change.id);if(change.review)item.review=change.review;Object.assign(item.cells,change.cells||{})});findingSnapshot.revision++;findingListeners.forEach(fn=>fn({projectKey:'proj-1'}));return{success:true,snapshot:structuredClone(findingSnapshot)}
  },
  qaFindingsPicture: async () => ({src:evidencePicture('Organizer'),caption:'Annotated heading'}),
  qaFindingsImport: async () => {calls.push('findings-import');return{success:true,snapshot:structuredClone(findingSnapshot)}},
  qaFindingsCopy: async (_key:string,ids:string[]) => {calls.push(`findings-copy ${ids.join(',')}`);return{success:true,count:ids.length}},
  qaFindingsShare: async () => {calls.push('findings-share');return{success:true}},
  qaAgentsSettings: async () => structuredClone(settings),
  qaAgentsOverview: async () => { if (firstOverview && new URLSearchParams(location.search).get('view') === 'agents') { firstOverview = false; await new Promise(r => { (window as any).__releaseOverview = r }) } if ((window as any).__overviewError) throw new Error('Could not load agent settings.'); return structuredClone({ settings, agents, keyStorage: 'secure' }) },
  qaAgentsSaveSettings: async (patch: any) => { calls.push(`save ${JSON.stringify(patch)}`); if ((window as any).__saveError) throw new Error('Could not save settings.'); settings = { ...settings, ...patch, models: { ...settings.models, ...patch.models } }; runListener?.({ type: 'agent-selected', agent: settings.defaultAgent, model: settings.models[settings.defaultAgent], label: `${settings.defaultAgent} · ${settings.models[settings.defaultAgent] || 'App default'}` }); return structuredClone({ settings, agents, keyStorage: 'secure' }) },
  qaAgentsSetKey: async (id: string) => { const agent = agents.find(a => a.id === id); if (agent) agent.hasKey = true; return structuredClone({ settings, agents, keyStorage: 'secure' }) },
  qaAgentsClearKey: async (id: string) => { const agent = agents.find(a => a.id === id); if (agent) agent.hasKey = false; return structuredClone({ settings, agents, keyStorage: 'secure' }) },
  qaAgentsModels: async (id: string) => {
    calls.push(`models ${id}`)
    const result = (window as any).__modelResult || (id === 'openrouter' ? { models: ['vendor/vision:free', 'older/vision:free'], recommended: 'vendor/vision:free' } : { models: ['gpt-test', 'gpt-test-mini'], options: [{ id: 'gpt-test', label: 'Test model' }, { id: 'gpt-test-mini', label: 'Test mini' }] })
    await new Promise(r => setTimeout(r, (window as any).__modelDelay || 200))
    return result
  },
  openExternal: async (url: string) => { calls.push(`external ${url}`) },
  qaBridgeStatus: async () => { if (new URLSearchParams(location.search).has('failAux') && !(window as any).__auxRecovered) throw new Error('offline'); return bridge },
  qaBridgeSetEnabled: async () => bridge,
  qaBridgeResetKey: async () => bridge,
  onQaBridgeStatus: () => () => {},
  qaTrackerFormatGet: async () => ({ version: 1, columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'], examples: [] }),
  qaTrackerFormatSave: async (text: string) => { calls.push(`tracker ${text.length}`); return { ok: false, error: 'The first row should be the tracker\'s column names.' } },
  qaTrackerFormatClear: async () => true,
  qaCliStatus: async () => ({ installed: false, path: '/home/user/.local/bin/parity', onPath: false, platform: 'linux' }),
  qaCliInstall: async () => ({ installed: true, path: '/home/user/.local/bin/parity', onPath: true, platform: 'linux' }),
  qaTarget: async () => (window as any).__target ?? null,
  qaRunActive: async () => false,
  onQaRunEvent: (callback: (event: unknown) => void) => { runListener = callback; return () => { runListener = null } },
  qaRunStart: async (options: unknown) => { calls.push(`run ${JSON.stringify(options)}`); return { started: true } },
  qaRunStop: async () => { calls.push('stop'); return true },
  qaExecutionStatus: async () => null,
  qaExecutionRetry: async (id: string) => { calls.push(`retry ${id}`); return { started: true } },
  qaExecutionResult: async (_id: string, offset: number) => ({text:offset ? 'Remaining output' : 'Saved output',total:28,nextOffset:offset ? null : 16}),
  qaChatSend: async (text: string, options?: { chatId?: string }) => { calls.push(`chat ${text}`); (window as any).__lastChatId = options?.chatId; return { started: true } },
  qaChatsSave: async (chat: any) => { calls.push(`chats-save ${chat.id} ${chat.messages.length}`); return true },
  qaChatsList: async () => [{ id: 'chat-saved-0001', title: 'How big is the hero heading?', createdAt: 1791100000000, updatedAt: 1791100000000, messageCount: 4, tokens: 18250 }],
  qaChatsOpen: async (id: string) => { calls.push(`chats-open ${id}`); return { version: 1, id, title: 'How big is the hero heading?', createdAt: 1, updatedAt: 1, agentLabel: 'Antigravity CLI', messages: [{ id: 1, kind: 'user', text: 'How big is the hero heading?' }, { id: 2, kind: 'assistant', text: 'It is **28px**.' }], session: { input: 18000, output: 250, requests: 2 } } },
  qaChatsDelete: async (id: string) => { calls.push(`chats-delete ${id}`); return true },
  qaHistoryList: async () => structuredClone(historyRuns),
  qaHistoryDetail: async (id: string) => structuredClone(id === historyRuns[0].id ? historyDetail : { ...historyDetail, run: historyRuns[1], handovers: [], drafts: [] }),
  qaHistoryPicture: async (id: string, ref: any) => { calls.push(`picture ${id} ${ref.kind} ${ref.file ?? `${ref.area ? `${ref.area}-` : ''}${ref.breakpoint}-${ref.index}`}`); return evidencePicture('History') },
  qaHistoryCopy: async (id: string, stamp: string) => { calls.push(`copy ${id} ${stamp}`); return 2 },
  qaHistoryOpenFolder: async (id: string) => { calls.push(`open-folder ${id}`); return true },
  qaHistoryPin: async (id: string, pinned: boolean) => { calls.push(`pin ${id} ${pinned}`); historyRuns[0].pinned = pinned; historyDetail.run.pinned = pinned; return true },
  qaHistoryDelete: async (id: string) => { calls.push(`delete ${id}`); return true },
  qaChatReset: async () => { calls.push('chat-reset'); return true },
  qaCallTool: async (name: string, args: unknown) => { calls.push(`tool ${name} ${JSON.stringify(args)}`); return { text: name === 'get_context' ? '{ "project": { "name": "[Svenson] Alopecia" } }' : 'ok', isError: false, images: name === 'capture_live' ? [{ dataUrl: swatch('#223344'), caption: 'Overview desktop' }] : [] } },
}

// A side-by-side evidence picture like the real ones: design on the left, live page on the right, the problem boxed in red.
const evidencePicture = (label: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="430"><rect width="1100" height="430" fill="#1c1c1c"/><rect x="0" y="26" width="540" height="404" fill="#f4f1ec"/><rect x="560" y="26" width="540" height="404" fill="#f4f1ec"/><text x="8" y="18" font-family="sans-serif" font-size="14" fill="#fff">Design</text><text x="568" y="18" font-family="sans-serif" font-size="14" fill="#fff">Live</text><rect x="40" y="90" width="460" height="64" fill="#223344"/><rect x="600" y="90" width="400" height="48" fill="#223344"/><rect x="596" y="84" width="408" height="60" fill="none" stroke="#e03030" stroke-width="3"/><text x="40" y="400" font-family="sans-serif" font-size="13" fill="#444">${label}</text></svg>`)}`
const approvalColumns = ['Page Link', 'Section', 'Screenshot', 'Remarks', 'Priority (QA/PM)', 'Display', 'Status', 'Approval Screenshot(QA)', 'Reason for Rejection (if applicable)', 'Screenshot and Remarks (Dev)', 'Remarks (PM)', 'Remarks (CRSM)']
const approvalRow = (cells: Record<string, string>) => approvalColumns.map((name) => cells[name] ?? '')
const approval = {
  id: 'a1', runId: 'run-1', projectName: '[Svenson] Alopecia', pageUrl: 'https://svenson.test/alopecia-page/',
  columns: approvalColumns,
  rows: [
    approvalRow({ 'Page Link': 'https://svenson.test/alopecia-page/', Section: 'Basics section, H2 "The Basics of Alopecia Areata"', Remarks: 'Desktop: heading is font-size 28px, line-height 34px. The design shows ≈32px / 38px. The heading also sits ≈24px lower than in the design.', 'Priority (QA/PM)': 'High', Display: 'Desktop and Tablet' }),
    approvalRow({ 'Page Link': 'https://svenson.test/alopecia-page/', Section: 'Hero, call to action', Remarks: "'- Button label differs: live says Book now, design says Book a Consultation", 'Priority (QA/PM)': 'Low', Display: 'Desktop' }),
    approvalRow({ 'Page Link': 'https://svenson.test/alopecia-page/', Section: 'Treatment, image row', Remarks: 'Content overflows the page horizontally by 100px (div.alt-text-image), which causes a horizontal scrollbar on mobile.', 'Priority (QA/PM)': 'High', Display: 'Mobile' }),
  ],
  severityCounts: { High: 2, Low: 1 },
  evidence: [{ rowIndex: 0, thumbnail: evidencePicture('Heading size'), caption: 'Basics section · desktop · design 0–420 / live 1010–1450' }, { rowIndex: 2, thumbnail: evidencePicture('Overflow'), caption: 'Treatment · mobile' }],
  warnings: ['Evidence images were not uploaded: Sign in to Parity to upload evidence. The screenshot column is left empty.'],
  uploadsEvidence: false,
}

const batchApproval = {
  ...approval, id: 'a2', projectName: '2 pages',
  rows: [
    approvalRow({ 'Page Link': 'https://svenson.test/alopecia-page/', Section: 'Hero', Remarks: 'h1 title should be 2 lines', 'Priority (QA/PM)': 'Medium', Display: 'Desktop' }),
    approvalRow({ 'Page Link': 'https://svenson.test/alopecia-page/', Section: 'Footer', Remarks: 'font size should be 13px', 'Priority (QA/PM)': 'Low', Display: 'Mobile' }),
    approvalRow({ 'Page Link': 'https://svenson.test/contact/', Section: 'Contact form', Remarks: 'add a success message after sending', Display: 'Desktop and Tablet', Status: 'ENHANCEMENT (QA)' }),
  ],
  severityCounts: { Medium: 1, Low: 2 },
  evidence: [{ rowIndex: 0, thumbnail: evidencePicture('Heading'), caption: 'Hero · desktop' }, { rowIndex: 2, thumbnail: evidencePicture('Button'), caption: 'Contact form · desktop' }],
  rowPages: [{ name: 'Alopecia', url: 'https://svenson.test/alopecia-page/' }, { name: 'Alopecia', url: 'https://svenson.test/alopecia-page/' }, { name: 'Contact', url: 'https://svenson.test/contact/' }],
}

const historyRuns: any[] = [
  { id: '20261005-035056-dynamiq-real-estate-mana-5229', projectName: 'Dynamiq Real Estate Management', pageUrl: 'https://dynamiqes.com/products/dynamiq-real-estate-management/', createdAt: 1791172256735, pinned: false, breakpoints: ['desktop', 'tablet', 'mobile'], drafted: 3, handovers: [{ stamp: '1791174398615', status: 'approved', rows: 3, copied: 2 }] },
  { id: '20261005-040514-our-services-cd9c', projectName: 'Our Services', pageUrl: 'https://dynamiqes.com/our-services/', createdAt: 1791172000000, pinned: true, breakpoints: ['desktop'], drafted: 0, handovers: [] },
]
const historyDetail: any = {
  run: historyRuns[0],
  columns: approvalColumns,
  handovers: [{
    version: 1, stamp: '1791174398615', createdAt: 1791174398615, status: 'approved', projectName: 'Dynamiq Real Estate Management', pageUrl: historyRuns[0].pageUrl, columns: approvalColumns,
    rows: [
      approvalRow({ 'Page Link': historyRuns[0].pageUrl, Section: 'Features', Remarks: 'replace watermarked image', Display: 'Desktop' }),
      approvalRow({ 'Page Link': historyRuns[0].pageUrl, Section: 'Features', Remarks: 'wrong image', Display: 'Desktop and Mobile' }),
      approvalRow({ 'Page Link': historyRuns[0].pageUrl, Section: 'Footer', Remarks: 'font size should be 13px', Display: 'Mobile' }),
    ],
    evidence: [{ rowIndex: 0, file: 'evidence-1791174398615-row-01.webp', caption: '' }, { rowIndex: 1, file: 'evidence-1791174398615-row-02.webp', caption: '' }],
    excludedRows: [2], links: { 0: 'https://parity-gfx.pages.dev/?evidence=AbCdEfGhIjKlMnOpQrStUv' }, copiedRows: 2,
  }],
  drafts: [
    { breakpoint: 'tablet', rows: [{ cells: approvalRow({ Section: 'Hero', Remarks: 'h1 title should be 2 lines', Display: 'Tablet' }), hasPicture: true }, { cells: approvalRow({ Section: 'Footer', Remarks: 'logo too small', Display: 'Tablet' }), hasPicture: false }] },
    { breakpoint: 'desktop', area: 'functional', rows: [{ cells: approvalRow({ Section: 'Navbar', Remarks: 'Contact link goes to a 404 page', Display: 'Desktop' }), hasPicture: true }] },
  ],
}

function Fixture() {
  const [tracker,setTracker]=useState(false)
  useEffect(()=>{const open=()=>setTracker(true);window.addEventListener('parity:open-ai-tracker',open);return()=>window.removeEventListener('parity:open-ai-tracker',open)},[])
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') || 'agents')
  ;(window as any).__setView = setView
  return (
    <main style={{ padding: 24, minHeight: '100vh', boxSizing: 'border-box' }}>
      {tracker&&<QaTrackerModal projectKey="proj-1" onClose={()=>setTracker(false)}/>}
      {view === 'agents' && <div style={{ maxWidth: 720 }}><AgentsPanel /></div>}
      {view === 'slots' && <div style={{ maxWidth: 360, border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}><DesignSlots
        slots={{
          desktop: { breakpoint: 'desktop', fileName: 'home@2x.png', pixelWidth: 2880, pixelHeight: 6000, scale: 2, frameWidth: 1440, frameHeight: 3000, detection: 'dimensions', confidence: 'high', sha256: 'a', addedAt: 1 },
          mobile: { breakpoint: 'mobile', fileName: 'tab.png', pixelWidth: 1000, pixelHeight: 2000, scale: 1, frameWidth: 1000, frameHeight: 2000, detection: 'fallback', confidence: 'low', sha256: 'b', addedAt: 1 },
        }}
        thumbnails={{ desktop: swatch('#335577'), mobile: swatch('#553377') }} activeBreakpoint="desktop"
        onAddFiles={(files, target) => (window as any).__calls.push(`add ${files.length} ${target}`)} onRemove={(bp) => (window as any).__calls.push(`remove ${bp}`)} onMove={(bp, to) => (window as any).__calls.push(`move ${bp} ${to}`)} onScale={(bp, s) => (window as any).__calls.push(`scale ${bp} ${s}`)} /></div>}
      {view === 'approval-batch' && <QaApprovalCard request={batchApproval} onDecide={(approved, note) => (window as any).__calls.push(`decide ${approved} ${note ?? ''}`)} />}
      {view === 'approval' && <QaApprovalCard request={approval} onDecide={(approved, note, excluded) => (window as any).__calls.push(`decide ${approved} ${note ?? ''} ${JSON.stringify(excluded ?? [])}`)} />}
      {view === 'history' && <QaHistory initialTab={(new URLSearchParams(location.search).get('tab') as any) || 'reviews'} onClose={() => (window as any).__calls.push('history-close')} />}
      {view === 'chat' && <div style={{ width: 400, height: 640, border: '1px solid var(--border-color)' }}><QaChat onClose={() => (window as any).__calls.push('close')} /></div>}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
