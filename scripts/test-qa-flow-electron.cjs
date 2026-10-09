/* Real Electron check of the QA flow's main-process wiring: the window reporting its project
 * and page, tool calls over IPC, the approval handshake, the clipboard, tracker-format storage
 * and that only the app window may do any of it. A stand-in app window (with a preload like the
 * real one) plays the renderer; the page being captured is a local fixture.
 *
 *   npm run test:qa-flow:electron */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-qa-flow-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(dir, 'node_modules'), 'junction')
  const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp', 'nspell', 'dictionary-en'], define: { __PARITY_SUPABASE_URL__: '""', __PARITY_SUPABASE_KEY__: '""' } }
  await build({ ...common, entryPoints: [path.join(__dirname, '../src/main/qaAgent/index.ts')], outfile: path.join(dir, 'qa.cjs') })
  await build({ ...common, entryPoints: [path.join(__dirname, '../src/main/designStore.ts')], outfile: path.join(dir, 'designs.cjs') })
  await build({ ...common, entryPoints: [path.join(__dirname, '../src/main/qaAgent/tools.ts')], outfile: path.join(dir, 'tools.cjs') })
  fs.writeFileSync(path.join(dir, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('qaTest', {
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onApproval: (callback) => { ipcRenderer.on('qa:approval-request', (_event, request) => callback(request)) },
  onRun: (callback) => { ipcRenderer.on('qa:run:event', (_event, event) => callback(event)) },
})`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 240000)
  child.once('exit', code => { clearTimeout(timer); console.log('QA flow artifacts:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow, clipboard } = require('electron'), http = require('node:http'), sharp = require('sharp')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(dir, 'profile')); await app.whenReady()
  const portProbe = http.createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const bridgePort = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const qaConfigFolder = path.join(app.getPath('userData'), 'qa-agent')
  fs.mkdirSync(qaConfigFolder, {recursive:true})
  fs.writeFileSync(path.join(qaConfigFolder, 'config.json'), JSON.stringify({enabled:false,port:bridgePort}))
  const { registerQaAgent } = require(path.join(dir, 'qa.cjs')), { createDesignStore } = require(path.join(dir, 'designs.cjs')), { callTool } = require(path.join(dir, 'tools.cjs'))

  const lazy = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#990099' } }).png().toBuffer()
  let modelRequests = 0
  let modelFailure = true
  const modelBodies = []
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/qa-capture/index.html'))
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      modelRequests++
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body); modelBodies.push(parsed)
        if (parsed.model.startsWith('fixture-hold')) return // Abort must close the old request.
        const busy = parsed.model === 'fixture-busy'
        res.writeHead(busy ? 429 : modelFailure ? 401 : 200, {'Content-Type':'application/json', ...(busy ? {'Retry-After':'10'} : {})})
        res.end(JSON.stringify(busy ? {error:{message:'temporarily busy'}} : modelFailure ? {error:{message:'fixture key rejected'}} : {choices:[{message:{role:'assistant',content:'Fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:3}}))
      })
      return
    }
    if (req.url === '/lazy.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(lazy) }
    if (req.url === '/missing.png') { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const makeWindow = () => new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { preload: path.join(dir, 'preload.cjs'), contextIsolation: true, sandbox: false } })
  const main = makeWindow(), other = makeWindow()
  await Promise.all([main.loadURL('about:blank'), other.loadURL('about:blank')])
  const store = createDesignStore(path.join(app.getPath('userData'), 'designs'))
  const qa = registerQaAgent({ getMainWindow: () => main, getDesignStore: () => store })
  qa.attachMainWindow(main)

  const run = (win, code) => win.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error.message} (while running: ${code.slice(0, 140).replace(/\s+/g, ' ')})`) })
  const call = (win, name, args) => run(win, `qaTest.invoke('qa:call-tool', ${JSON.stringify(name)}, ${JSON.stringify(args || {})})`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (check, what) => { for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50) } assert.fail('Timed out waiting for ' + what) }

  // The stand-in app window answers approval requests like the real approval card would.
  await run(main, `window.__approvals = []; window.__decision = { approved: true }; window.__hold = false;
    qaTest.onApproval(async (request) => { window.__approvals.push(request); if (window.__hold) return; await qaTest.invoke('qa:approval-decision', request.id, window.__decision) })`)

  console.log('  step 1');
  // 1. Reporting the open page: accepted from the app window only, and sanitised.
  const context = { projectKey: 'proj-1', project: { id: 'proj-1', name: '[Svenson] Alopecia', stagingUrl: base + '/' }, pageUrl: base + '/alopecia-page/', workspaceTab: 'editBeta', breakpoint: 'desktop', viewport: { width: 1920, height: 1200 }, reportedAt: 0 }
  await run(other, `qaTest.send('qa:report-context', ${JSON.stringify({ ...context, projectKey: 'hijacked' })})`)
  await sleep(300)
  assert.equal(qa.context().reportedContext(), null, 'a window other than the app window cannot report a project')
  await run(main, `qaTest.send('qa:report-context', ${JSON.stringify(context)})`)
  await until(() => qa.context().reportedContext(), 'the app window to report its context')
  assert.equal(qa.context().reportedContext().pageUrl, base + '/alopecia-page/')
  assert.ok(qa.context().reportedContext().reportedAt > 0, 'the report is time-stamped by the main process')
  await run(main, `qaTest.send('qa:report-context', { projectKey: 'x', pageUrl: 'file:///etc/passwd' })`)
  await sleep(300)
  assert.equal(qa.context().reportedContext(), null, 'a non-web page is not accepted')
  await run(main, `qaTest.send('qa:report-context', ${JSON.stringify(context)})`)
  await until(() => qa.context().reportedContext(), 'the context again')

  console.log('  step 2');
  // 2. Tool calls over IPC: only from the app window.
  assert.deepEqual((await call(other, 'get_context')).isError, true, 'another window cannot call tools')
  const info = JSON.parse((await call(main, 'get_context')).text)
  assert.equal(info.project.name, '[Svenson] Alopecia'); assert.equal(info.tracker.columns[0], 'Page Link', 'the standard tracker applies until one is pasted'); assert.equal(info.tracker.screenshotColumn, 'Screenshot')
  assert.equal(info.notes.some((note) => /tracker format is not set/.test(note)), false)

  console.log('  step 3');
  // 3. Tracker format: saved by the app window, validated, persisted.
  assert.equal((await run(other, `qaTest.invoke('qa:tracker-format:save', 'A\\tB\\nx\\ty')`)).ok, false, 'another window cannot set the tracker format')
  assert.equal((await run(main, `qaTest.invoke('qa:tracker-format:save', 'just one line')`)).ok, false)
  const saved = await run(main, `qaTest.invoke('qa:tracker-format:save', ${JSON.stringify('Page\tIssue\tExpected\tScreenshot\tSeverity\nHome\tHeading too small\t32px\thttps://x.test/a\tHigh')})`)
  assert.equal(saved.ok, true); assert.deepEqual(saved.format.columns, ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'])
  assert.equal((await run(main, `qaTest.invoke('qa:tracker-format:get')`)).columns.length, 5)

  console.log('  step 4');
  // 4. Capture the fixture with a stored design, read a section, save a draft.
  const design = await sharp({ create: { width: 2880, height: 7000, channels: 3, background: '#dddddd' } }).png().toBuffer()
  assert.equal((await store.put('proj-1', design, { target: 'desktop', pagePath: '/alopecia-page/' })).success, true)
  const captured = await call(main, 'capture_live', { breakpoint: 'desktop' })
  assert.equal(captured.isError, false, captured.text)
  assert.equal(captured.images.length, 1); assert.match(captured.images[0].dataUrl, /^data:image\/jpeg;base64,/)
  assert.match(captured.text, /S\d+ "Hero heading"/); assert.match(captured.text, /Design: 1440px wide frame \(2x export\)/)
  const runId = /Run (\S+) ·/.exec(captured.text)[1]
  const revealId = /(S\d+) "Reveal section"/.exec(captured.text)[1]
  const section = await call(main, 'get_section', { runId, breakpoint: 'desktop', section: revealId })
  assert.equal(section.isError, false, section.text); assert.equal(section.images.length, 2)
  assert.match(section.text, /#\d+ h2 "Reveal section" x\d+ y\d+ w\d+ h\d+ \| Arial 32\/(?:normal|[\d.]+) 700 #111111/)

  const rows = [
    { cells: { Page: 'Alopecia', Issue: 'Heading is smaller than the design', Expected: '32px', Severity: 'High' }, evidence: { breakpoint: 'desktop', section: revealId, caption: 'Heading size' } },
    { cells: { Page: 'Alopecia', Issue: '- Button label differs', Severity: 'Low' } },
  ]

  console.log('  step 5');
  // 5. Findings save automatically; finalization never touches the clipboard or waits for approval.
  clipboard.writeText('untouched')
  const savedFindings = await call(main,'save_draft',{runId,breakpoint:'desktop',rows})
  assert.equal(savedFindings.isError,false,savedFindings.text);assert.match(savedFindings.text,/Finding IDs/)
  let organized = await run(main, `qaTest.invoke('qa:findings:list')`)
  assert.equal(organized.findings.filter(f=>!f.mergedInto).length,2)
  assert.ok(organized.findings[0].evidence,'annotated evidence is retained locally')
  const finalized = await call(main,'finalize_rows',{runId,rows})
  assert.match(finalized.text,/Saved 2 finding/);assert.equal(clipboard.readText(),'untouched')
  assert.equal((await run(main,'window.__approvals')).length,0,'saving local findings does not show approval')
  await call(main,'finalize_rows',{runId,rows})
  organized = await run(main, `qaTest.invoke('qa:findings:list')`)
  assert.equal(organized.findings.filter(f=>!f.mergedInto).length,2,'finalization is idempotent')
  assert.equal(await run(other, `qaTest.invoke('qa:findings:list')`),null)
  const itemId=organized.findings[0].id
  const changed=await run(main, `qaTest.invoke('qa:findings:update','proj-1',${organized.revision},[{id:${JSON.stringify(itemId)},cells:{Issue:'Human remark, with punctuation',Severity:'High'},review:'accepted'}])`)
  assert.equal(changed.success,true)
  const stale=await run(main, `qaTest.invoke('qa:findings:update','proj-1',${organized.revision},[{id:${JSON.stringify(itemId)},review:'dismissed'}])`)
  assert.equal(stale.success,false);assert.match(stale.error,/changed/)
  await call(main,'save_draft',{runId,breakpoint:'desktop',rows})
  organized=await run(main, `qaTest.invoke('qa:findings:list')`)
  assert.equal(organized.findings.find(f=>f.id===itemId).cells.Issue,'Human remark, with punctuation')
  assert.equal((await run(main,`qaTest.invoke('qa:findings:picture','proj-1',${JSON.stringify(itemId)})`)).src.startsWith('data:image/webp;base64,'),true)
  const selectedIds=organized.findings.filter(f=>!f.mergedInto).map(f=>f.id)
  await run(main, `qaTest.invoke('qa:findings:copy','proj-1',${JSON.stringify(selectedIds)})`)
  assert.match(clipboard.readText(),/Human remark, with punctuation/);assert.match(clipboard.readText(),/High/,'human priority is preserved when copying')
  clipboard.writeText('untouched-share')
  await run(main, `window.__decision = { approved: false, note: 'Not ready to share' }`)
  const rejected=await run(main,`qaTest.invoke('qa:findings:share','proj-1',${JSON.stringify(selectedIds)})`)
  assert.equal(rejected.success,false);assert.match(rejected.error,/Not ready to share/)
  await run(main, `window.__decision = { approved: true }`)
  const shared=await run(main,`qaTest.invoke('qa:findings:share','proj-1',${JSON.stringify(selectedIds)})`)
  assert.equal(shared.success,true,shared.error);assert.equal(clipboard.readText(),'untouched-share','sharing does not automatically copy')
  const imported=await run(main,`qaTest.invoke('qa:findings:import','proj-1')`)
  assert.equal(imported.success,true,imported.error)
  assert.equal(imported.snapshot.findings.filter(f=>!f.mergedInto).length,2,'importing past drafts and shared handovers does not duplicate existing findings')

  console.log('  step 6');
  console.log('  step bridge');
  // The local bridge: off until the person turns it on, key stored on disk, same tools over HTTP.
  assert.equal((await run(main, `qaTest.invoke('qa:bridge:status')`)).running, false, 'the bridge is off by default')
  assert.equal(await run(other, `qaTest.invoke('qa:bridge:set-enabled', true)`), null, 'another window cannot turn the bridge on')
  const on = await run(main, `qaTest.invoke('qa:bridge:set-enabled', true)`)
  assert.equal(on.running, true, on.error); assert.match(on.keyHint, /^••••.{4}$/); assert.equal(on.port, bridgePort)
  const key = fs.readFileSync(on.keyFile, 'utf8').trim()
  assert.equal(key.length, 43, 'the key is stored in its file')
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(on.keyFile), 'bridge.json'), 'utf8')).port, on.port, 'the port is published for the parity command')
  const api = (suffix, init = {}) => fetch(`http://127.0.0.1:${on.port}${suffix}`, { ...init, headers: { ...(init.headers || {}) } })
  assert.equal((await api('/api/status')).status, 401, 'no key, no access')
  const status = await (await api('/api/status', { headers: { Authorization: 'Bearer ' + key } })).json()
  assert.equal(status.projectOpen, true); assert.equal(status.project, '[Svenson] Alopecia')
  const viaApi = await (await api('/api/tools/get_context', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' })).json()
  assert.match(viaApi.text, /Svenson/); assert.equal(viaApi.isError, false)
  const reset = await run(main, `qaTest.invoke('qa:bridge:reset-key')`)
  assert.notEqual(fs.readFileSync(on.keyFile, 'utf8').trim(), key, 'a reset makes a new key')
  assert.equal((await api('/api/status', { headers: { Authorization: 'Bearer ' + key } })).status, 401, 'the old key stops working')
  assert.ok(reset.recent.length >= 3, 'requests are logged')
  const off = await run(main, `qaTest.invoke('qa:bridge:set-enabled', false)`)
  assert.equal(off.running, false)
  await assert.rejects(api('/api/status'), undefined, 'nothing listens once the bridge is off')
  assert.equal(fs.existsSync(path.join(path.dirname(on.keyFile), 'bridge.json')), false, 'the port file is removed')

  // Main owns retry descriptors: setup failure can recover, attempts retain identity and usage.
  await run(main, `qaTest.invoke('qa:agents:save-settings', {localBaseUrl:${JSON.stringify(base+'/v1')},models:{local:''}})`)
  const setupFailed = await run(main, `qaTest.invoke('qa:chat:send','Check the fixture',{agent:'local',chatId:'chat-retry-fixture'})`)
  assert.equal(setupFailed.started,false);assert.ok(setupFailed.retryId)
  assert.equal((await run(other, `qaTest.invoke('qa:execution:retry',${JSON.stringify(setupFailed.retryId)})`)).started,false, 'another window cannot retry')
  await run(main, `qaTest.invoke('qa:agents:save-settings', {models:{local:'fixture-model'}})`)
  assert.equal((await run(main, `qaTest.invoke('qa:execution:retry',${JSON.stringify(setupFailed.retryId)})`)).started,true)
  await until(async()=>!(await run(main, `qaTest.invoke('qa:run:active')`)), 'the failed API request')
  assert.equal(modelRequests,1)
  modelFailure=false
  assert.equal((await run(main, `qaTest.invoke('qa:execution:retry',${JSON.stringify(setupFailed.retryId)})`)).started,true)
  await until(async()=>!(await run(main, `qaTest.invoke('qa:run:active')`)), 'the successful retry')
  const snapshot = await run(main, `qaTest.invoke('qa:execution:status')`)
  assert.equal(snapshot.executionId,setupFailed.retryId);assert.equal(snapshot.attempt,3);assert.equal(snapshot.tokens,23)
  assert.equal(modelRequests,2)
  assert.equal(await run(other, `qaTest.invoke('qa:execution:status')`),null)
  assert.equal(await run(other, `qaTest.invoke('qa:execution:result','forbidden',0)`),null)
  await run(main, `qaTest.send('qa:report-context',${JSON.stringify({...context,pageUrl:base+'/changed/'})})`)
  await sleep(100)
  assert.equal((await run(main, `qaTest.invoke('qa:execution:retry',${JSON.stringify(setupFailed.retryId)})`)).started,false, 'a changed page invalidates retry')
  await run(main, `qaTest.send('qa:report-context',${JSON.stringify(context)})`);await sleep(100)

  // Settings changes hot-swap unfinished work in the same chat, including a retry countdown.
  await run(main, `window.__runEvents=[]; qaTest.onRun(e=>window.__runEvents.push(e))`)
  await run(main, `qaTest.invoke('qa:agents:save-settings', {defaultAgent:'local',models:{local:'fixture-busy'}})`)
  await run(main, `qaTest.invoke('qa:chat:send','Continue the same conversation',{chatId:'chat-retry-fixture'})`)
  await until(async()=>(await run(main, `qaTest.invoke('qa:execution:status')`)).phase==='retrying', 'a provider retry countdown')
  const swapping = await run(main, `qaTest.invoke('qa:execution:status')`)
  await run(main, `qaTest.invoke('qa:agents:save-settings', {models:{local:'fixture-replacement'}})`)
  await until(async()=>!(await run(main, `qaTest.invoke('qa:run:active')`)), 'the replacement model to finish')
  const replaced = await run(main, `qaTest.invoke('qa:execution:status')`)
  assert.equal(replaced.executionId, swapping.executionId, 'the request keeps its identity')
  assert.equal(replaced.attempt,2, 'a model change starts a new attempt')
  assert.deepEqual(modelBodies.slice(-2).map(body=>body.model), ['fixture-busy','fixture-replacement'], 'the old retry is cancelled')
  assert.match(JSON.stringify(modelBodies.at(-1).messages), /Check the fixture/, 'the replacement retains earlier conversation')
  assert.equal(modelBodies.at(-1).messages.filter(message=>message.role==='user' && message.content==='Continue the same conversation').length,1)
  assert.ok((await run(main, 'window.__runEvents')).some(e=>e.type==='started' && /fixture-replacement/.test(e.label)), 'the header identifies the actual model')

  // Changing providers after failure must use the new default on Retry, without reopening.
  modelFailure=true
  await run(main, `qaTest.invoke('qa:chat:send','A recoverable failure',{chatId:'chat-retry-fixture'})`)
  await until(async()=>!(await run(main, `qaTest.invoke('qa:run:active')`)), 'another failed request')
  const failed = await run(main, `qaTest.invoke('qa:execution:status')`)
  await run(main, `qaTest.invoke('qa:agents:save-settings', {defaultAgent:'openai-api',models:{'openai-api':'fixture-openai'}})`)
  const switchedFailure = await run(main, `qaTest.invoke('qa:execution:retry',${JSON.stringify(failed.executionId)})`)
  assert.equal(switchedFailure.started,false)
  assert.match(switchedFailure.error,/OpenAI API key/, 'Retry selects the new provider, rather than the failed provider')
  modelFailure=false

  // Stop wins over any queued switch and does not restart the held provider.
  await run(main, `qaTest.invoke('qa:agents:save-settings', {defaultAgent:'local',models:{local:'fixture-hold'}})`)
  await run(main, `qaTest.invoke('qa:chat:send','Stop this held request',{chatId:'chat-retry-fixture'})`)
  await until(async()=>modelBodies.at(-1)?.model==='fixture-hold', 'the held request')
  await run(main, `Promise.all([qaTest.invoke('qa:agents:save-settings',{models:{local:'fixture-hold-next'}}),qaTest.invoke('qa:run:stop')])`)
  await until(async()=>!(await run(main, `qaTest.invoke('qa:run:active')`)), 'Stop to cancel the request')
  const stoppedAt = modelRequests
  await sleep(150)
  assert.equal(modelRequests,stoppedAt, 'Stop does not leave another attempt queued')

  // 6. Decisions only count from the app window and only for the pending request; one request at a time.
  await run(main, `window.__hold = true; window.__approvals.length = 0`)
  // Called in-process: the window that would carry an IPC reply is about to be closed.
  const pending = callTool('finalize_rows', { runId, rows }, { ...qa.context(), organizer: undefined })
  await until(async () => (await run(main, 'window.__approvals.length')) === 1, 'the approval request to arrive')
  const pendingId = (await run(main, 'window.__approvals[0].id'))
  assert.equal(await run(other, `qaTest.invoke('qa:approval-decision', ${JSON.stringify(pendingId)}, { approved: true })`), false, 'another window cannot approve')
  assert.equal(await run(main, `qaTest.invoke('qa:approval-decision', 'wrong-id', { approved: true })`), false, 'a wrong id is ignored')
  const second = await callTool('finalize_rows', { runId, rows }, { ...qa.context(), organizer: undefined })
  assert.match(second.text, /already waiting for approval/)
  clipboard.writeText('before-close')
  console.log('  step 7');
  // 7. Closing the app window while rows wait counts as not approved.
  main.destroy()
  const afterClose = await pending
  assert.match(afterClose.text, /did not approve/); assert.match(afterClose.text, /window closed/)
  assert.equal(clipboard.readText(), 'before-close', 'nothing is copied when the window closes')
  assert.equal(qa.context().reportedContext(), null, 'closing the window clears the reported page')

  console.log('QA flow smoke passed: context, tool IPC, tracker format, capture, section, approval and clipboard all behaved')
  server.close(); app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
