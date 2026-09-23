const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-comparison-ui-'))
  await build({ entryPoints: [path.join(__dirname, 'fixtures/comparison-ui.tsx')], outfile: path.join(directory, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(directory, 'ui.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;background:#201e2a;color:#eee;font:12px Arial}#canvas{display:flex;justify-content:center;gap:24px;padding:55px 20px}.fixture-card{position:relative;width:500px;height:300px;flex:none;border:1px solid #51485d;border-radius:7px;overflow:visible}.fixture-card header{position:absolute;top:-34px;left:0;right:0;height:30px;box-sizing:border-box;padding:7px;background:#25202f;border:1px solid #51485d;border-radius:6px}.fixture-live-header{position:absolute;z-index:2;top:0;left:0;right:0;height:50px;background:#27212c;pointer-events:none}#live{height:100%;overflow:auto;background:#fff;scrollbar-width:none}#live::-webkit-scrollbar{display:none}#live img{display:block;width:100%}</style><div id="root"></div><script src="ui.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 60000)
  child.once('exit', code => { clearTimeout(timer); console.log('Comparison UI artifacts:', directory); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1120, height: 470, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true } })
  const js = expression => window.webContents.executeJavaScript(expression)
  const until = async expression => { for (let attempt = 0; attempt < 100; attempt++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)) } throw new Error(`Timeout: ${expression}`) }
  try {
    await window.loadFile(path.join(directory, 'ui.html'))
    await until("!!document.querySelector('.browser-comparison-image img')")
    const alignment = await js("(() => { const left=document.getElementById('live').getBoundingClientRect(); const right=document.querySelector('.browser-comparison-viewport').getBoundingClientRect(); const headers=[document.querySelector('.fixture-card header').getBoundingClientRect(),document.querySelector('.browser-comparison-header').getBoundingClientRect()]; return { top: Math.abs(left.top-right.top), width: Math.abs(left.width-right.width), headers: Math.abs(headers[0].top-headers[1].top) } })()")
    assert.ok(alignment.top < 2 && alignment.width < 2 && alignment.headers < 2, `Comparison geometry differs: ${JSON.stringify(alignment)}`)
    assert.equal(await js("!!document.querySelector('.browser-comparison-warning')"), false)
    assert.equal(await js("!!document.querySelector('[aria-label=\"Capture warnings\"]')"), true)
    await js("document.getElementById('live').scrollTop=600;document.getElementById('live').dispatchEvent(new Event('scroll',{bubbles:true}))")
    await until("Math.abs(document.querySelector('.browser-comparison-viewport').scrollTop-600*document.querySelector('.browser-comparison-viewport').clientWidth/500)<3")
    await new Promise(resolve => setTimeout(resolve, 80))
    await js("const panel=document.querySelector('.browser-comparison-viewport');panel.scrollTop=900*panel.clientWidth/500;panel.dispatchEvent(new Event('scroll',{bubbles:true}))")
    await until("Math.abs(document.getElementById('live').scrollTop-900)<3")
    await until("!!document.querySelector('.browser-comparison-pinned-column img')")
    await js("document.querySelector('[aria-label=\"Saved comparisons\"]').click()")
    await until("!!document.querySelector('.browser-comparison-history-row .browser-comparison-delete')")
    await new Promise(resolve => setTimeout(resolve, 80))
    fs.writeFileSync(path.join(directory, 'comparison-card.png'), (await window.capturePage()).toPNG())
    await js("document.querySelector('.browser-comparison-history-row .browser-comparison-delete').click()")
    await until("document.querySelector('.browser-comparison-popover')?.textContent.includes('No saved comparisons')")
    assert.equal(await js("!!document.querySelector('.browser-comparison-image img')"), false)
    console.log('PASS: aligned canvas card, pinned header, full-page scroll synchronization in both directions, and per-record deletion.')
  } finally { window.destroy(); app.quit() }
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); process.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
