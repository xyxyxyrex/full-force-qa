const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-audit-inspector-'))
  await build({ entryPoints: [path.join(__dirname, 'fixtures/audit-inspector.tsx')], outfile: path.join(directory, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(directory, 'ui.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;background:#201d29;color:#eee}#page{width:300px;height:130px}.audit-inspector{width:360px;height:600px}</style></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90000)
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } })
  const js = (expression) => window.webContents.executeJavaScript(expression)
  const until = async (expression) => {
    for (let attempt = 0; attempt < 120; attempt++) { if (await js(expression)) return; await new Promise((resolve) => setTimeout(resolve, 50)) }
    throw new Error(`Timeout: ${expression}`)
  }
  try {
    await window.loadFile(path.join(directory, 'ui.html'))
    await until("document.querySelector('.audit-inspector-annotation-group')?.textContent.includes('300 × 130')")
    await until("[...document.querySelectorAll('.audit-inspector-node')].some(node=>node.textContent.includes('<section class=\"cs-hero\">'))")
    assert.equal(await js("window.auditTextElements().filter(item=>item.text.includes('Tubings')).length"), 1)
    assert.equal(await js("window.auditTextElements().filter(item=>item.text.includes('Invisible phrase')).length"), 0)
    await js("[...document.querySelectorAll('.audit-inspector-row')].find(row=>row.textContent.includes('<section class=\"cs-hero\">')).querySelector('.audit-inspector-chevron').click()")
    await until("[...document.querySelectorAll('.audit-inspector-node')].some(node=>node.textContent.includes('<h1 id=\"primary\">'))")
    assert(!(await js("[...document.querySelectorAll('.audit-inspector-node')].find(node=>node.textContent.includes('<h1 id=\"primary\">')).textContent.includes('class=' )")))
    await js("[...document.querySelectorAll('.audit-inspector-node')].find(node=>node.textContent.includes('<h1 id=\"primary\">')).click()")
    await js("(() => { window.prompt=()=> 'data-reviewed=yes'; document.querySelector('.audit-inspector-row.selected').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:150})) })()")
    await until("!!document.querySelector('.audit-inspector-menu')")
    await js("[...document.querySelectorAll('.audit-inspector-menu button')].find(button=>button.textContent==='Edit attribute').click()")
    assert.equal(await js("document.querySelector('#page').contentDocument.querySelector('#primary').getAttribute('data-reviewed')"), 'yes')
    await until("[...document.querySelectorAll('[aria-label=\"Rule selector\"]')].some(node=>node.value==='.cs-hero h1')")
    await js("document.querySelector('.audit-inspector-source:not(:disabled)').click()")
    await until("!!document.querySelector('[aria-label=\"Captured stylesheet source\"]')")
    assert(await js("document.querySelector('[aria-label=\"Captured stylesheet source\"]').textContent.includes('.cs-hero h1')"))
    await js("document.querySelector('[aria-label=\"Close source viewer\"]').click()")
    assert(await js("!!document.querySelector('[aria-label=\".cs-hero h1 color\"]')"))
    await js("(() => { const input=document.querySelector('[aria-label=\".cs-hero h1 color\"]'); input.value='green'; input.dispatchEvent(new FocusEvent('focusout',{bubbles:true})) })()")
    try { await until("document.querySelector('#page').contentDocument.querySelector('.cs-hero h1').ownerDocument.defaultView.getComputedStyle(document.querySelector('#page').contentDocument.querySelector('.cs-hero h1')).color==='rgb(0, 128, 0)'") } catch (error) { console.error(await js("({rule:document.querySelector('#page').contentDocument.styleSheets[0].cssRules[0].cssText,color:document.querySelector('#page').contentDocument.defaultView.getComputedStyle(document.querySelector('#page').contentDocument.querySelector('h1')).color})")); throw error }
    assert.equal(await js("[...document.querySelector('#page').contentDocument.querySelectorAll('.cs-hero h1')].every(node=>node.ownerDocument.defaultView.getComputedStyle(node).color==='rgb(0, 128, 0)')"), true)
    assert.equal(await js("document.querySelector('#page').contentDocument.documentElement.outerHTML.includes('color: green')"), true)
    await js("[...document.querySelectorAll('.audit-inspector-force button')].find(button=>button.textContent===':hover').click()")
    await until("document.querySelector('#page').contentDocument.querySelector('#primary').hasAttribute('data-audit-force-hover')")
    assert.equal(await js("document.querySelector('#page').contentDocument.defaultView.getComputedStyle(document.querySelector('#page').contentDocument.querySelector('#primary')).backgroundColor"), 'rgb(255, 255, 0)')
    await js("[...document.querySelectorAll('.audit-inspector-force button')].find(button=>button.textContent===':hover').click()")
    await js("[...document.querySelectorAll('.audit-inspector-tabs button')].find(button=>button.textContent==='computed').click()")
    await until("[...document.querySelectorAll('.audit-inspector-computed')].some(node=>node.textContent.includes('rgb(0, 128, 0)'))")
    await js("[...document.querySelectorAll('.audit-inspector-computed')].find(node=>node.querySelector('b')?.textContent.trim().replace(/^[›⌄]\\s*/, '')==='color').click()")
    await until("document.querySelector('.audit-inspector-contributors')?.textContent.includes('.cs-hero h1')")
    await js("(() => { const select=document.querySelector('.audit-inspector-toolbar select'); select.value='xpath'; select.dispatchEvent(new Event('change',{bubbles:true})); const input=document.querySelector('.audit-inspector-toolbar input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'//h1'); input.dispatchEvent(new Event('input',{bubbles:true})) })()")
    await until("document.querySelector('.audit-inspector-search-status')?.textContent.includes('of 2')")
    fs.writeFileSync(path.join(directory, 'audit-inspector.png'), (await window.capturePage()).toPNG())
    await js("document.querySelector('#page').contentDocument.querySelector('#primary').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
    await until("!document.querySelector('#page').contentDocument.querySelector('[data-live-selected]')")
    assert.equal(await js("!document.querySelector('.audit-inspector-row.selected')"), true)
    console.log('PASS: audit DOM tree, attribute editing, cross-frame CSS rules, shared rule editing, source viewer, forced hover, computed styles, XPath search, and Escape deselection')
  } finally { window.destroy(); app.quit() }
}

(process.argv.includes('--smoke') ? smoke() : driver()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--smoke')) require('electron').app.exit(1) })
