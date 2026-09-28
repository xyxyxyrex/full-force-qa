const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-figma-ui-'))
  await build({ entryPoints: [path.join(__dirname, 'fixtures/figma-comparison-ui.tsx')], outfile: path.join(directory, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(directory, 'ui.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;background:#181621;color:#eee;font:12px Arial}</style><div id="root"></div><script src="ui.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 60000)
  child.once('exit', code => { clearTimeout(timer); console.log('Figma UI artifacts:', directory); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1050, height: 550, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true } })
  const js = expression => window.webContents.executeJavaScript(expression)
  const until = async expression => { for (let attempt = 0; attempt < 100; attempt++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)) } throw new Error(`Timeout: ${expression}`) }
  try {
    await window.loadFile(path.join(directory, 'ui.html'))
    await until("!!document.querySelector('.comparison-mode-island')")
    const anchored = await js("(() => { const card=document.getElementById('figma-card').getBoundingClientRect(); const island=document.querySelector('.comparison-mode-island').getBoundingClientRect(); return {center: Math.abs((card.left+card.right)/2-(island.left+island.right)/2), within: island.left>=card.left && island.right<=card.right} })()")
    assert.ok(anchored.center < 1 && anchored.within, `Mode island is not attached to the Figma card: ${JSON.stringify(anchored)}`)
    await js("document.getElementById('figma-card').style.left='230px'")
    const moved = await js("(() => { const card=document.getElementById('figma-card').getBoundingClientRect(); const island=document.querySelector('.comparison-mode-island').getBoundingClientRect(); return Math.abs((card.left+card.right)/2-(island.left+island.right)/2) })()")
    assert.ok(moved < 1, 'Mode island did not follow the Figma card')
    assert.equal(await js("document.querySelectorAll('.comparison-mode-island button:disabled').length"), 2)
    await js("document.getElementById('attach').click()")
    await until("!document.querySelector('.comparison-mode-island button').disabled")
    fs.writeFileSync(path.join(directory, 'figma-side-island.png'), (await window.capturePage()).toPNG())
    await js("document.querySelector('.comparison-mode-island button').click()")
    await until("!!document.querySelector('.comparison-wipe-handle')")
    assert.equal(await js("document.querySelector('.comparison-mode-island button[aria-pressed=true]').textContent.trim()"), 'Overlay')
    await js("document.querySelector('.comparison-wipe-handle').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,buttons:1,clientX:400,clientY:230}))")
    await until("!!document.querySelector('.comparison-drag-shield')")
    await js("document.getElementById('underlying').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,buttons:1,clientX:500,clientY:190}))")
    await until("document.querySelector('.comparison-wipe-value')?.textContent.includes('Reveal 75%')")
    assert.equal(await js("document.querySelector('.comparison-opacity-gauge strong').textContent"), '70%')
    await js("window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))")
    await until("!document.querySelector('.comparison-drag-shield')")
    await js("document.querySelector('.comparison-wipe-handle').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:2,button:0,buttons:1,clientX:500,clientY:190})); window.dispatchEvent(new Event('blur'))")
    await until("!document.querySelector('.comparison-drag-shield')")
    await js("document.querySelector('.comparison-wipe-handle').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:3,button:0,buttons:1,clientX:500,clientY:190}))")
    await until("!!document.querySelector('.comparison-drag-shield')")
    await js("document.getElementById('underlying').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:3,buttons:0,clientX:500,clientY:190}))")
    await until("!document.querySelector('.comparison-drag-shield')")
    fs.writeFileSync(path.join(directory, 'figma-comparison-ui.png'), (await window.capturePage()).toPNG())
    console.log('PASS: island anchored to the Figma card, labelled opacity feedback, drag across interactive content, and release/blur cleanup.')
  } finally { window.destroy(); app.quit() }
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); process.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
