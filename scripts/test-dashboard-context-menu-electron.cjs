const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-dashboard-menu-'))
  await build({ entryPoints: [path.join(__dirname, 'fixtures/dashboard-context-menu.tsx')], outfile: path.join(directory, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', loader: { '.svg': 'dataurl', '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(directory, 'ui.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
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
  const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } })
  const js = (expression) => window.webContents.executeJavaScript(expression)
  const until = async (expression) => {
    for (let attempt = 0; attempt < 120; attempt++) { if (await js(expression)) return; await new Promise((resolve) => setTimeout(resolve, 50)) }
    throw new Error(`Timeout: ${expression}`)
  }
  try {
    await window.loadFile(path.join(directory, 'ui.html'))
    await until("!!document.querySelector('.dashboard-folder-more')")
    await js("document.querySelector('.dashboard-folder-more').click()")
    await until("!!document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]')")
    assert(await js("document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]').textContent.includes('Rename folder')"))
    await js("document.querySelector('.dashboard-folder-tile').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:140}))")
    await until("!!document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]')")
    await js("document.querySelector('.dashboard-folder-open').click()")
    await until("!!document.querySelector('.project-card, .list-row')")
    await js("document.querySelector('[aria-label=\"More actions for Homepage\"]').click()")
    await until("!!document.querySelector('[role=menu][aria-label=\"Project actions for Homepage\"]')")
    await js("document.querySelector('.project-card, .list-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:150,clientY:180}))")
    await until("!!document.querySelector('[aria-label=\"Project actions for Homepage\"]')")
    assert(await js("document.querySelector('[aria-label=\"Project actions for Homepage\"]').textContent.includes('Move to folder')"))
    await js("[...document.querySelector('[aria-label=\"Project actions for Homepage\"]').querySelectorAll('button')].find(button=>button.textContent.includes('Rename / edit project')).click()")
    await until("!!document.querySelector('.project-edit-dialog')")
    await js("document.querySelector('.project-edit-close').click()")
    await js("document.querySelector('[title=\"Tabular List View\"]').click()")
    await until("!!document.querySelector('.list-row')")
    await js("document.querySelector('[aria-label=\"More actions for Homepage\"]').click()")
    await until("!!document.querySelector('[role=menu][aria-label=\"Project actions for Homepage\"]')")
    await js("document.querySelector('.list-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:130,clientY:160}))")
    await until("!!document.querySelector('[role=menu][aria-label=\"Project actions for Homepage\"]')")
    console.log('PASS: dashboard folder/project three-dot menus, folder/project right-click menus, and project edit action')
  } finally { window.destroy(); app.quit() }
}

(process.argv.includes('--smoke') ? smoke() : driver()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--smoke')) require('electron').app.exit(1) })
