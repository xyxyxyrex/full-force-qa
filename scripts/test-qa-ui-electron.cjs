/* Renders the QA screens (settings panel, console, approval card, design slots) in Electron with a
 * stand-in for the app's main-process bridge, drives them, and saves screenshots to look at.
 *
 *   npm run test:qa-ui:electron */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-qa-ui-'))
  await build({ entryPoints: [path.join(__dirname, 'fixtures/qa-ui.tsx')], outfile: path.join(dir, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' } })
  fs.writeFileSync(path.join(dir, 'ui.html'), '<!doctype html><html data-theme="parity"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;background:var(--bg-primary,#18181b);color:var(--text-primary,#eee);font:14px Arial}</style><div id="root"></div><script src="ui.js"></script></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120000)
  child.once('exit', code => { clearTimeout(timer); console.log('QA UI screenshots:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration(); await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false } })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const run = code => win.webContents.executeJavaScript(code)
  const shot = async name => { await sleep(350); fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const open = async view => { await win.loadFile(path.join(dir, 'ui.html'), { query: { view } }); await sleep(500) }
  const text = selector => run(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
  const click = (selector, index = 0) => run(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].click()`)

  // Settings → AI Agents
  await open('agents')
  assert.equal(await run(`document.querySelectorAll('.agents-card').length`), 7, 'seven agents are listed')
  assert.match(await text('.agents-card.selected'), /Claude Code/, 'the default agent is selected')
  assert.match(await text('.agents-panel'), /Not found\. Install codex/, 'a missing CLI says how to fix it')
  assert.match(await text('.agents-chips'), /Screenshot/, 'the saved tracker columns are shown')
  assert.match(await text('.agents-kv'), /127\.0\.0\.1:29849\/mcp/, 'the bridge address is shown')
  await run(`document.querySelectorAll('input[name=default-agent]')[4].click()`)
  await sleep(200)
  assert.ok((await run('window.__calls')).some(c => c === 'save {"defaultAgent":"openai-api"}'), 'choosing an agent saves it')
  await run(`(() => { const t = document.querySelector('.agents-group textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'x\\ty'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(100); await click('.agents-button.primary'); await sleep(200)
  assert.match(await text('.agents-panel'), /first row should be/, 'a rejected tracker format shows its reason')
  await shot('agents')

  // Design slots
  await open('slots')
  assert.equal(await run(`document.querySelectorAll('.design-slot').length`), 3)
  assert.match(await text('.design-slots'), /1440 px · @2x/); assert.match(await text('.design-slots'), /check scale/); assert.match(await text('.design-slots'), /Looks like Tablet/)
  await click('.design-slot-hint'); await click('.design-slot-x')
  const slotCalls = await run('window.__calls')
  assert.ok(slotCalls.includes('move mobile tablet'), 'the hint moves the image to the slot it looks like')
  assert.ok(slotCalls.includes('remove desktop'), 'the remove button removes that slot')
  await shot('slots')

  // Approval card
  await open('approval')
  assert.match(await text('.qa-approval h2'), /Copy 3 rows for the tracker/)
  assert.equal(await run(`document.querySelectorAll('.qa-approval tbody tr').length`), 3)
  assert.equal(await run(`document.querySelectorAll('.qa-approval-evidence img').length`), 2)
  assert.match(await text('.qa-approval-chips'), /2 High/); assert.match(await text('.qa-approval-warning'), /Sign in to Parity/)
  assert.match(await text('.qa-approval-effect'), /copies the rows to your clipboard/)
  await shot('approval')
  await run(`(() => { const t = document.querySelector('.qa-approval-note textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Row 3 is wrong'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(100); await click('.qa-approval-secondary'); await sleep(100)
  assert.ok((await run('window.__calls')).includes('decide false Row 3 is wrong'), 'rejecting sends the note')
  assert.equal(await run(`document.querySelector('.qa-approval-primary').disabled`), true, 'buttons lock after a decision')

  // Console
  await open('console')
  const submit = async cmd => { await run(`(() => { const i = document.querySelector('.qa-console-input input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(cmd)}); i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.qa-console-input').requestSubmit() })()`); await sleep(250) }
  await submit('help'); assert.match(await text('.qa-console-body'), /qa run \[desktop\]/)
  await submit('agents'); assert.match(await text('.qa-console-body'), /claude-code\s+ready/); assert.match(await text('.qa-console-body'), /codex\s+not ready/)
  await submit('context'); assert.match(await text('.qa-console-body'), /\[Svenson\] Alopecia/)
  await submit('tool capture_live {"breakpoint":"desktop"}'); assert.equal(await run(`document.querySelectorAll('.qa-images img').length`), 1, 'tool pictures show in the transcript')
  await submit('qa run tablet --agent codex'); assert.ok((await run('window.__calls')).includes('run {"agent":"codex","breakpoints":["tablet"]}'))
  await submit('qa run --agent skynet'); assert.match(await text('.qa-console-body'), /Unknown agent "skynet"/)
  await submit('frobnicate'); assert.match(await text('.qa-console-body'), /Unknown command "frobnicate"/)
  // A streamed review: deltas join into one message, tool calls and results are listed, the run ends with a summary.
  for (const e of [
    { type: 'started', agent: 'anthropic-api', label: 'Claude API (claude-opus-5-5)' }, { type: 'status', message: 'Reviewing desktop…' },
    { type: 'text', text: 'Comparing the ', delta: true }, { type: 'text', text: 'hero section.', delta: true },
    { type: 'tool', name: 'get_section', args: { section: 'S2' } }, { type: 'tool-result', name: 'get_section', isError: false, text: 'Section S2 "Basics"\nmore', images: 2 },
    { type: 'tool-result', name: 'save_draft', isError: true, text: 'Colour is not in the tracker', images: 0 },
    { type: 'usage', inputTokens: 1000, outputTokens: 50 }, { type: 'done', message: 'Copied 3 rows.' }, { type: 'finished' },
  ]) await run(`window.__emit(${JSON.stringify(e)})`)
  await sleep(250)
  const body = await text('.qa-console-body')
  assert.match(body, /Comparing the hero section\./, 'streamed pieces join into one message')
  assert.match(body, /▸ get_section \{"section":"S2"\}/); assert.match(body, /✓ Section S2 "Basics" \(2 pictures\)/); assert.match(body, /✗ Colour is not in the tracker/)
  assert.match(body, /Copied 3 rows\.\n\(1,050 tokens\)/)
  assert.equal(await run(`document.querySelector('.qa-console-running')`), null, 'the running marker clears when the review finishes')
  await shot('console')

  console.log('QA UI smoke passed')
  app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
