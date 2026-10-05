/* Renders the QA screens (settings panel, chat, approval card, design slots) in Electron with a
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
  const until = async (expression) => {
    for (let attempt = 0; attempt < 120; attempt++) { if (await run(expression)) return; await sleep(50) }
    throw new Error(`Timeout: ${expression}`)
  }

  // Settings → AI Agents
  await open('agents')
  assert.equal(await run(`document.querySelectorAll('.agents-card').length`), 7, 'seven agents are listed')
  assert.match(await text('.agents-card.selected'), /Claude Code/, 'the default agent is selected')
  assert.match(await text('.agents-panel'), /Not found\. Install codex/, 'a missing CLI says how to fix it')
  assert.match(await text('.agents-chips'), /Screenshot/, 'the saved tracker columns are shown')
  assert.match(await text('.agents-kv'), /127\.0\.0\.1:29849\/mcp/, 'the bridge address is shown')
  assert.match(await text('.agents-panel'), /Uploading needs your Parity account/, 'signed-out users are told uploads need an account')
  const group = heading => `[...document.querySelectorAll('.agents-group')].find(g => g.querySelector('h4')?.textContent === ${JSON.stringify(heading)})`
  assert.equal(await run(`${group('Evidence screenshots')}.querySelector('select').value`), '90', 'the evidence lifetime defaults to 90 days')
  // Testing the page: on for reviews, sending off, and each switch saves.
  assert.deepEqual(await run(`[...${group('Testing the page')}.querySelectorAll('input[type=checkbox]')].map(i => i.checked)`), [true, false], 'reviews test the page, and nothing is sent, by default')
  assert.match(await run(`${group('Testing the page')}.innerText`), /submissions and POST, PUT and DELETE requests are stopped/)
  await run(`${group('Testing the page')}.querySelectorAll('input[type=checkbox]')[1].click()`); await sleep(150)
  assert.ok((await run('window.__calls')).includes('save {"allowSend":true}'), 'allowing sends saves it')
  await run(`${group('Testing the page')}.querySelectorAll('input[type=checkbox]')[0].click()`); await sleep(150)
  assert.ok((await run('window.__calls')).includes('save {"functionalChecks":false}'), 'turning testing off saves it')
  await run(`${group('Testing the page')}.scrollIntoView()`); await shot('agents-testing')
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
  assert.match(await text('.qa-approval h2'), /Copy 3 findings for the tracker/)
  assert.equal(await run(`document.querySelectorAll('.qa-finding').length`), 3, 'one block per finding')
  assert.match(await text('.qa-finding'), /Basics section, H2/); assert.match(await text('.qa-finding'), /font-size 28px/); assert.match(await text('.qa-finding'), /Desktop and Tablet/)
  assert.doesNotMatch(await text('.qa-finding'), /Approval Screenshot|Remarks \(PM\)|Status/, 'empty tracker columns are not shown')
  assert.equal(await run(`document.querySelectorAll('.qa-finding-shot img').length`), 2, 'the pictures sit inside their findings')
  assert.equal(await run(`document.querySelectorAll('.qa-finding-noshot').length`), 1, 'a finding without a picture says so')
  assert.equal(await run(`document.querySelectorAll('.qa-finding')[0].querySelector('.qa-finding-shot img') !== null`), true)
  assert.ok((await run(`document.querySelector('.qa-finding-shot img').getBoundingClientRect().width`)) > 600, 'the picture is large enough to read')
  assert.equal(await run(`document.querySelector('.qa-badge.sev-high').textContent`), 'High'); assert.equal(await run(`document.querySelector('.qa-finding .qa-badge.display').textContent`), 'Desktop and Tablet')
  assert.match(await text('.qa-approval-chips'), /2 High/); assert.match(await text('.qa-approval-warning'), /Sign in to Parity/)
  assert.match(await text('.qa-approval-effect'), /copies the rows to your clipboard/)
  await shot('approval')
  // Enlarging a picture, and closing it with Esc without closing the card.
  await click('.qa-finding-shot button'); await sleep(150)
  assert.equal(await run(`!!document.querySelector('.qa-lightbox img')`), true, 'clicking a picture enlarges it')
  await shot('approval-zoom')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(100)
  assert.equal(await run(`document.querySelector('.qa-lightbox')`), null, 'Esc closes the enlarged picture'); assert.equal(await run(`!!document.querySelector('.qa-approval')`), true, 'but not the card')
  // The raw rows, as they will be pasted.
  await click('.qa-approval-view button', 1); await sleep(100)
  assert.equal(await run(`document.querySelectorAll('.qa-approval tbody tr').length`), 3, 'the sheet view lists the rows')
  assert.equal(await run(`document.querySelectorAll('.qa-approval thead th').length`), 13, 'with every tracker column')
  await click('.qa-approval-view button', 0); await sleep(100)
  await run(`(() => { const t = document.querySelector('.qa-approval-note textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Finding 3 is wrong'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(100); await click('.qa-approval-secondary'); await sleep(100)
  assert.ok((await run('window.__calls')).includes('decide false Finding 3 is wrong []'), 'rejecting sends the note')
  assert.equal(await run(`document.querySelector('.qa-approval-primary').disabled`), true, 'buttons lock after a decision')

  // Leaving findings out before copying.
  await open('approval')
  await click('.qa-finding-toggle', 1); await sleep(100)
  assert.match(await text('.qa-approval h2'), /Copy 2 of 3 findings/, 'the title counts what will be copied')
  assert.equal(await run(`document.querySelectorAll('.qa-finding.excluded').length`), 1)
  assert.equal(await run(`document.querySelector('.qa-finding.excluded .qa-finding-toggle').textContent`), 'Put back')
  assert.match(await text('.qa-approval-primary'), /Approve & copy 2/)
  await click('.qa-approval-view button', 1); await sleep(100)
  assert.equal(await run(`document.querySelectorAll('.qa-approval tr.excluded').length`), 1, 'the sheet view marks a left-out row')
  await click('.qa-approval-view button', 0); await sleep(100)
  await click('.qa-finding-toggle', 0); await click('.qa-finding-toggle', 2); await sleep(100)
  assert.equal(await run(`document.querySelector('.qa-approval-primary').disabled`), true, 'nothing to copy when everything is left out')
  assert.match(await text('.qa-approval-effect'), /Every finding is left out/)
  await click('.qa-finding-toggle', 2); await sleep(100)
  await click('.qa-approval-primary'); await sleep(100)
  assert.ok((await run('window.__calls')).includes('decide true  [0,1]'), 'approving sends the findings that were left out')
  await shot('approval-leave-out')

  // Past reviews: runs, their hand-overs and drafts with screenshots, copy again, keep, delete.
  await open('history')
  assert.equal(await run(`document.querySelectorAll('.qa-history-runs li').length`), 2)
  assert.match(await text('.qa-history-runs li'), /Dynamiq Real Estate Management/); assert.match(await text('.qa-history-runs li'), /2 copied/); assert.match(await text('.qa-history-runs li'), /3 drafted/)
  assert.match(await text('.qa-history-detail'), /Approved · 2 rows copied · 1 left out/)
  assert.match(await text('.qa-history-detail'), /replace watermarked image/); assert.match(await text('.qa-history-detail'), /Drafted by the agent/); assert.match(await text('.qa-history-detail'), /h1 title should be 2 lines/)
  assert.equal(await run(`document.querySelectorAll('.qa-history-detail .qa-finding.excluded').length`), 1, 'a finding left out at the time is marked')
  assert.match(await text('.qa-finding-evidence-link'), /parity-gfx\.pages\.dev\/\?evidence=/, 'the link that went in the sheet is shown')
  await until(`window.__calls.includes('picture 20261005-035056-dynamiq-real-estate-mana-5229 draft functional-desktop-0')`)
  const pictureCalls = (await run('window.__calls')).filter(c => c.startsWith('picture '))
  assert.ok(pictureCalls.includes('picture 20261005-035056-dynamiq-real-estate-mana-5229 handover evidence-1791174398615-row-01.webp'), 'hand-over pictures load')
  assert.ok(pictureCalls.includes('picture 20261005-035056-dynamiq-real-estate-mana-5229 draft tablet-0'), 'drafted findings get their pictures made')
  assert.match(await text('.qa-history-detail'), /Desktop · testing links, buttons and forms · 1 finding/, 'findings from testing the page have their own group')
  assert.ok(pictureCalls.includes('picture 20261005-035056-dynamiq-real-estate-mana-5229 draft functional-desktop-0'), 'with the browser screenshot as their picture')
  assert.equal(pictureCalls.some(c => c.endsWith('tablet-1')), false, 'no picture is asked for a draft without evidence')
  assert.ok((await run(`document.querySelectorAll('.qa-history-detail .qa-finding-shot img').length`)) >= 2)
  await run(`document.querySelectorAll('.qa-history-breakpoint')[1].scrollIntoView()`)
  await shot('history-reviews')
  await run(`[...document.querySelectorAll('.qa-history-section header button')].find(b => b.textContent === 'Copy rows again').click()`); await sleep(150)
  assert.ok((await run('window.__calls')).includes('copy 20261005-035056-dynamiq-real-estate-mana-5229 1791174398615'))
  assert.match(await text('.qa-history-notice'), /Copied 2 rows to the clipboard/)
  await run(`[...document.querySelectorAll('.qa-history-actions button')].find(b => b.textContent === 'Keep').click()`); await sleep(200)
  assert.ok((await run('window.__calls')).includes('pin 20261005-035056-dynamiq-real-estate-mana-5229 true'))
  assert.equal(await run(`[...document.querySelectorAll('.qa-history-actions button')].some(b => b.textContent === 'Kept')`), true)
  await run(`[...document.querySelectorAll('.qa-history-actions button')].find(b => b.textContent === 'Open folder').click()`); await sleep(100)
  assert.ok((await run('window.__calls')).includes('open-folder 20261005-035056-dynamiq-real-estate-mana-5229'))
  await run(`document.querySelector('.qa-history-actions .danger').click()`); await sleep(100)
  assert.equal(await run(`document.querySelector('.qa-history-actions .danger').textContent`), 'Delete for good?', 'deleting asks once more')
  assert.equal((await run('window.__calls')).some(c => c.startsWith('delete ')), false)
  await run(`document.querySelector('.qa-history-actions .danger').click()`); await sleep(200)
  assert.ok((await run('window.__calls')).includes('delete 20261005-035056-dynamiq-real-estate-mana-5229'))
  await run(`(() => { const i = document.querySelector('.qa-history-runs input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'services'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(100)
  assert.equal(await run(`document.querySelectorAll('.qa-history-runs li').length`), 1, 'the list filters by page or project')

  // Past chats: open one into the chat, or delete it.
  await run(`window.__chatOpened = 0; window.addEventListener('parity:open-qa-chat', () => { window.__chatOpened++ })`)
  await click('.qa-history-tabs button', 1); await sleep(200)
  assert.match(await text('.qa-history-chats'), /How big is the hero heading\?/); assert.match(await text('.qa-history-chats'), /18,250 tokens/)
  await run(`[...document.querySelectorAll('.qa-history-chats button')].find(b => b.textContent === 'Open').click()`); await sleep(200)
  assert.ok((await run('window.__calls')).includes('chats-open chat-saved-0001'))
  assert.equal(await run('window.__chatOpened'), 1, 'opening a chat shows the chat panel')
  assert.ok((await run('window.__calls')).includes('history-close'))
  await shot('history-chats')

  // Approval card for a batch of pages: findings grouped under a heading per page.
  await open('approval-batch')
  assert.match(await text('.qa-approval h2'), /Copy 3 findings from 2 pages for the tracker/)
  assert.equal(await run(`document.querySelectorAll('.qa-finding-page').length`), 2, 'one heading per page')
  assert.match(await text('.qa-finding-page'), /Alopecia/); assert.match(await text('.qa-finding-page'), /2 findings/)
  assert.equal(await run(`[...document.querySelectorAll('.qa-findings > li')].map(li => li.className).join(',')`), 'qa-finding-page,qa-finding,qa-finding,qa-finding-page,qa-finding', 'a heading starts each page\'s findings')
  assert.equal(await run(`document.querySelector('.qa-badge.suggestion')?.textContent`), 'Suggestion', 'a suggestion is marked as one')
  await shot('approval-batch')

  // Chat
  await open('chat')
  assert.equal(await run(`document.querySelectorAll('.qa-chat-suggestions button').length`), 3, 'an empty chat offers starting points')
  // The review target: which page, and which designs are stored for it.
  assert.match(await text('.qa-target-page'), /\/alopecia-page/, 'the open page is shown')
  assert.equal(await run(`document.querySelectorAll('.qa-target-design:not(.missing) img').length`), 2, 'the stored designs are shown')
  assert.match(await text('.qa-target-designs'), /alopecia-desktop@2x\.png/, 'with their file names')
  assert.match(await text('.qa-target-designs'), /Tablet\s*no design/, 'a missing breakpoint says so')
  assert.match(await text('.qa-target-note'), /No tablet design for this page/)
  await shot('chat-target')
  await run(`window.__target = window.__targets.contact`); await sleep(3200)
  assert.match(await text('.qa-target-page'), /\/contact/, 'changing the page changes the target')
  assert.equal(await run(`document.querySelectorAll('.qa-target-design:not(.missing) img').length`), 0, 'and the designs are that page\'s, not the previous one\'s')
  assert.match(await text('.qa-target-warn'), /No designs for this page yet/)
  await run(`window.__target = window.__targets.alopecia`); await sleep(3200)
  assert.match(await text('.qa-chat-meter'), /tokens: —/, 'the meter says usage is not reported yet')
  const send = async message => { await run(`(() => { const t = document.querySelector('.qa-chat-composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(message)}); t.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(80); await click('.qa-chat-send'); await sleep(250) }
  await send('How big is the hero heading?')
  assert.ok((await run('window.__calls')).includes('chat How big is the hero heading?'), 'a message goes to the agent')
  assert.match(await run('window.__lastChatId'), /^chat-/, 'with the id of the chat it belongs to')
  await sleep(500)
  assert.ok((await run('window.__calls')).some(c => c.startsWith('chats-save chat-')), 'the chat is saved')
  assert.match(await text('.qa-chat-body'), /How big is the hero heading\?/, 'and shows as your bubble')
  await send('/review tablet --agent codex'); assert.ok((await run('window.__calls')).includes('run {"agent":"codex","breakpoints":["tablet"]}'), '/review starts a review')
  await send('/review --agent skynet'); assert.match(await text('.qa-chat-body'), /Unknown agent "skynet"/)
  await send('/agents'); assert.match(await text('.qa-chat-body'), /claude-code\s+ready/); assert.match(await text('.qa-chat-body'), /codex\s+not ready/)
  await send('/help'); assert.match(await text('.qa-chat-body'), /\/review \[desktop\]/); assert.match(await text('.qa-chat-body'), /--no-design/)
  await send('/review mobile --no-design'); assert.ok((await run('window.__calls')).includes('run {"breakpoints":["mobile"],"standalone":true}'), '--no-design reviews the page on its own')
  await send('/review --visual-only'); assert.ok((await run('window.__calls')).includes('run {"functional":false}'), '--visual-only skips testing links, buttons and forms')
  // A streamed answer: deltas join into one message, tool calls become cards, tokens add up, the turn ends with a summary.
  for (const e of [
    { type: 'started', agent: 'anthropic-api', label: 'Claude API (claude-opus-5-5)', budgetTokens: 10000 },
    { type: 'text', text: 'The **hero** heading is ', delta: true }, { type: 'text', text: '`28px` tall.', delta: true },
    { type: 'tool', name: 'get_section', args: { section: 'S2' } },
    { type: 'usage', inputTokens: 1000, outputTokens: 200 },
  ]) await run(`window.__emit(${JSON.stringify(e)})`)
  await sleep(250)
  assert.match(await text('.qa-chat-agent'), /Claude API/); assert.match(await text('.qa-chat-running'), /Working/)
  assert.equal(await run(`document.querySelector('.qa-chat-send').textContent.includes('Stop')`), true, 'while working the button stops the agent')
  assert.equal(await run(`document.querySelectorAll('.qa-chat-tool.pending').length`), 1, 'a running tool shows as pending')
  assert.match(await text('.qa-chat-meter'), /1\.2k tokens/); assert.match(await text('.qa-chat-meter'), /\+1\.2k now/)
  for (const e of [
    { type: 'tool-result', name: 'get_section', isError: false, text: 'Section S2 "Basics"\nmore', images: 2 },
    { type: 'text', text: 'It is 28px; the design shows ≈32px.' },
    { type: 'usage', inputTokens: 2000, outputTokens: 300 }, { type: 'finished' },
  ]) await run(`window.__emit(${JSON.stringify(e)})`)
  await sleep(250)
  const chatBody = await text('.qa-chat-body')
  assert.equal(await run(`document.querySelectorAll('.qa-chat-text strong').length`), 1, '**bold** is rendered'); assert.equal(await run(`document.querySelectorAll('.qa-chat-text code').length`), 1, '`code` is rendered')
  assert.match(chatBody, /hero heading is 28px tall\./, 'streamed pieces join into one message')
  assert.match(chatBody, /get_section/); assert.equal(await run(`document.querySelectorAll('.qa-chat-tool.ok').length`), 1, 'a finished tool shows as done')
  assert.match(chatBody, /3,500 tokens · 3,000 in, 500 out · 2 requests/, 'each message ends with its token use')
  assert.match(await text('.qa-chat-meter'), /3\.5k tokens/); assert.match(await text('.qa-chat-meter'), /3k in · 500 out/)
  assert.equal(await run(`document.querySelector('.qa-chat-running')`), null, 'the working marker clears when the agent finishes')
  await shot('chat')
  await run(`window.__historyTab = ''; window.addEventListener('parity:open-qa-history', (e) => { window.__historyTab = e.detail.tab })`)
  await run(`[...document.querySelectorAll('.qa-chat-actions button')].find(b => b.textContent === 'History').click()`); await sleep(100)
  assert.equal(await run('window.__historyTab'), 'chats', 'History opens past chats')
  await run(`[...document.querySelectorAll('.qa-chat-actions button')].find(b => b.textContent === 'New chat').click()`); await sleep(250)
  assert.ok((await run('window.__calls')).includes('chat-reset'), 'New chat tells the agent to forget')
  assert.equal(await run(`document.querySelectorAll('.qa-chat-msg').length`), 0, 'and clears the transcript')
  assert.match(await text('.qa-chat-meter'), /tokens: —/, 'and the counts')

  console.log('QA UI smoke passed')
  app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
