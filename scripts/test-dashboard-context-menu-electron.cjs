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

    // The split button keeps single capture direct and exposes Multi-capture from the caret.
    assert.equal(await js("document.querySelector('.new-project-btn').textContent.trim()"), 'New Capture')
    await js("document.querySelector('.new-capture-menu-trigger').click()")
    await until("!!document.querySelector('[role=menu][aria-label=\"Capture options\"]')")
    await js("document.querySelector('[role=menu][aria-label=\"Capture options\"] button').click()")
    await until("!!document.querySelector('.multi-capture-dialog')")
    assert.equal(await js("document.querySelector('.multi-capture-destination strong').textContent"), 'Home')

    // Spreadsheet/tab, comma, and whitespace paste become editable rows.
    await js("(() => { const input=document.getElementById('multi-capture-paste'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(input,'one.test/path\\ttwo.test, https://three.test'); input.dispatchEvent(new Event('input',{bubbles:true})); })()")
    await js("document.querySelector('.multi-capture-paste-row button').click()")
    await until("document.querySelectorAll('.multi-capture-row').length === 3")
    await js("document.querySelector('.multi-capture-add-row').click()")
    await until("document.querySelectorAll('.multi-capture-row').length === 4")
    await js("(() => { const inputs=[...document.querySelectorAll('[data-row-url]')]; const input=inputs[3]; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'file:///bad'); input.dispatchEvent(new Event('input',{bubbles:true})); })()")
    await until("document.querySelector('.multi-capture-status.status-invalid')?.textContent === 'Invalid'")
    assert.equal(await js("document.querySelector('.multi-capture-primary').disabled"), true)
    await js("(() => { const input=[...document.querySelectorAll('[data-row-url]')][3]; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'four.test'); input.dispatchEvent(new Event('input',{bubbles:true})); const name=[...document.querySelectorAll('.multi-capture-row > input')][3]; setter.call(name,'Fourth page'); name.dispatchEvent(new Event('input',{bubbles:true})); })()")
    await until("!document.querySelector('.multi-capture-primary').disabled")
    await js("document.querySelector('.multi-capture-primary').click()")
    await until("document.querySelector('.multi-capture-summary strong')?.textContent.includes('3 added')")
    assert(await js("document.querySelector('.multi-capture-summary strong').textContent.includes('1 failed')"))
    assert.equal(await js("window.__dashboardTest.captureCalls"), 0)
    assert.equal(await js("window.__dashboardTest.savedProjects.every(project => project.folderId == null)"), true)
    await js("document.querySelector('.multi-capture-primary').click()")
    await until("document.querySelector('.multi-capture-summary strong')?.textContent.includes('4 added')")
    assert.equal(await js("window.__dashboardTest.savedProjects.length"), 4)
    assert.equal(await js("window.__dashboardTest.savedProjects.find(project=>project.stagingUrl==='https://four.test/').name"), 'Fourth page')
    await js("document.querySelector('.multi-capture-secondary').click()")
    await until("!document.querySelector('.multi-capture-dialog')")

    // Blank dashboard space offers all creation actions.
    await js("document.querySelector('.active-project-dropzone').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:700,clientY:700}))")
    await until("!!document.querySelector('[role=menu][aria-label=\"Dashboard actions\"]')")
    assert.equal(await js("document.querySelector('[role=menu][aria-label=\"Dashboard actions\"]').textContent.replace(/\\s+/g,' ').trim()"), 'New CaptureNew Multi-captureNew Folder')
    await js("[...document.querySelector('[role=menu][aria-label=\"Dashboard actions\"]').querySelectorAll('button')].find(button=>button.textContent.includes('New Capture')).click()")
    assert.equal(await js("window.__dashboardTest.newProjectFolders.length"), 1)
    assert.equal(await js("window.__dashboardTest.newProjectFolders[0] == null"), true)

    await js("document.querySelector('.dashboard-folder-more').click()")
    await until("!!document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]')")
    assert(await js("document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]').textContent.includes('Rename folder')"))
    assert(await js("document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]').textContent.includes('New Capture')"))
    assert(await js("document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]').textContent.includes('New Multi-capture')"))
    await js("[...document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]').querySelectorAll('button')].find(button=>button.textContent.trim()==='New Capture').click()")
    assert.equal(await js("window.__dashboardTest.newProjectFolders.at(-1)"), 'folder-one')
    await js("document.querySelector('.dashboard-folder-more').click()")
    await until("!!document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]')")
    await js("[...document.querySelector('[role=menu][aria-label=\"Folder actions for Audit pages\"]').querySelectorAll('button')].find(button=>button.textContent.includes('New Multi-capture')).click()")
    await until("!!document.querySelector('.multi-capture-dialog')")
    assert.equal(await js("document.querySelector('.multi-capture-destination strong').textContent"), 'Home / Audit pages')
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    await until("!document.querySelector('.multi-capture-dialog')")

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
    await js("document.querySelector('.active-project-dropzone').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:700,clientY:700}))")
    await until("!!document.querySelector('[role=menu][aria-label=\"Dashboard actions\"]')")
    assert(await js("document.querySelector('[role=menu][aria-label=\"Dashboard actions\"]').textContent.includes('New Capture')"))
    console.log('PASS: dashboard creation menus, folder targets, Multi-capture parsing/save/retry, keyboard dismissal, and project menus')
  } finally { window.destroy(); app.quit() }
}

(process.argv.includes('--smoke') ? smoke() : driver()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--smoke')) require('electron').app.exit(1) })
