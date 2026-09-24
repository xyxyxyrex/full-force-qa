const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-feedback-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(directory, 'node_modules'), 'junction')
  await build({ entryPoints: [path.join(__dirname, '../src/main/feedback.ts')], outfile: path.join(directory, 'feedback.cjs'), bundle: true, platform: 'node', format: 'cjs' })
  await build({ entryPoints: [path.join(__dirname, '../src/preload/index.ts')], outfile: path.join(directory, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'] })
  await build({ entryPoints: [path.join(__dirname, 'fixtures/feedback-ui.tsx')], outfile: path.join(directory, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(directory, 'ui.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90000)
  child.once('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  const { validateFeedback } = require(path.join(directory, 'feedback.cjs'))
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  let signedIn = false
  const submissions = []
  ipcMain.handle('account:status', () => ({ signedIn, needsSetup: false, email: signedIn ? 'reviewer@example.test' : undefined }))
  ipcMain.handle('feedback:submit', (_event, input) => {
    if (!signedIn) throw new Error('Sign in to your Parity account.')
    submissions.push(validateFeedback(input))
    return { id: '00000000-0000-4000-8000-000000000321' }
  })
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: path.join(directory, 'preload.cjs'), offscreen: true, backgroundThrottling: false } })
  const js = expression => window.webContents.executeJavaScript(expression)
  const until = async expression => { for (let i = 0; i < 120; i++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) } throw new Error(`Timeout: ${expression}`) }
  try {
    await window.loadFile(path.join(directory, 'ui.html'))
    await js("document.querySelector('[aria-label=\"Feedback and report a bug\"]').click()")
    await until("!!document.querySelector('.feedback-signin')")
    assert.equal(await js("!!document.querySelector('.feedback-form')"), false)
    await js("document.querySelector('.feedback-signin button').click()")
    assert.equal(await js('window.__openedAccount'), true)
    signedIn = true
    await js("document.querySelector('[aria-label=\"Feedback and report a bug\"]').click()")
    await until("!!document.querySelector('.feedback-form')")
    fs.writeFileSync(path.join(directory, 'feedback-form.png'), (await window.capturePage()).toPNG())
    assert.equal(await js("document.querySelector('.feedback-form select').value"), 'audit')
    assert.equal(await js("document.querySelector('.feedback-privacy').textContent.includes('Page content, Notes, screenshots and credentials are not attached')"), true)
    await js("(() => { const el=document.querySelector('.feedback-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'  Audit preview fails  '); el.dispatchEvent(new Event('input',{bubbles:true})); })()")
    await js("(() => { const el=document.querySelector('.feedback-form textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'  Preview does not open after clicking an image.  '); el.dispatchEvent(new Event('input',{bubbles:true})); })()")
    await until("!document.querySelector('.feedback-form button[type=submit]').disabled")
    await js("document.querySelector('.feedback-form button[type=submit]').click()")
    await until("!!document.querySelector('.feedback-receipt')")
    assert.deepEqual(submissions, [{ kind: 'bug', area: 'audit', title: 'Audit preview fails', details: 'Preview does not open after clicking an image.' }])
    assert.equal(await js("document.querySelector('.feedback-receipt code').textContent"), '00000000-0000-4000-8000-000000000321')
    console.log('PASS: signed-out guidance, authenticated feedback submission, safe context, and receipt.')
    console.log('Feedback smoke artifacts:', directory)
  } finally { window.destroy(); app.quit() }
}

(process.argv.includes('--smoke') ? smoke() : driver()).catch(error => { console.error(error); process.exitCode = 1; if (process.argv.includes('--smoke')) require('electron').app.exit(1) })
