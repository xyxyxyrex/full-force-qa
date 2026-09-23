/* Local Electron/Firefox/WebKit integration gate. Uses a temporary profile and
 * never touches the user's saved projects or browser credentials. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-comparison-smoke-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(directory, 'node_modules'), 'junction')
  const profile = path.join(directory, 'profile')
  fs.mkdirSync(profile)
  const runtime = path.join(process.env.APPDATA, 'Parity', 'browser-runtimes')
  if (fs.existsSync(runtime)) fs.symlinkSync(runtime, path.join(profile, 'browser-runtimes'), 'junction')
  await build({
    entryPoints: [path.join(__dirname, '../src/main/crossBrowser.ts')],
    outfile: path.join(directory, 'comparison.cjs'),
    bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', 'sharp', 'playwright'],
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 120_000)
  child.once('exit', code => {
    clearTimeout(timer)
    console.log('Comparison smoke artifacts:', directory)
    process.exitCode = code === 0 ? 0 : 1
  })
}

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const { safeStorage } = require('electron')
  const http = require('node:http')
  const sharp = require('sharp')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const api = require(path.join(directory, 'comparison.cjs'))
  const server = http.createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><script>document.cookie="paritySmoke=yes";sessionStorage.setItem("paritySmoke","yes")</script><h1>Signed in</h1>')
      return
    }
    if (request.url === '/slow') {
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Slow page</h1>') } }, 8000).unref()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><style>body{margin:0;min-width:620px;min-height:1600px;background:#008877;color:white;font:32px Arial}footer{position:absolute;top:1450px}nav{position:fixed;top:0;left:0;width:100%;height:60px;background:#665544;z-index:10;transition:transform .15s}nav.hidden{transform:translateY(-100%)}</style><nav id="nav">Site navigation</nav><h1>Cross-browser fixture</h1><footer>Below the fold</footer><script>let navTimer;addEventListener("scroll",()=>{clearTimeout(navTimer);navTimer=setTimeout(()=>document.getElementById("nav").classList.toggle("hidden",scrollY>0),200)})</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/fixture`
  const window = new BrowserWindow({ width: 600, height: 400, frame: false, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true } })
  try {
    const projectId = 'fixture-project'
    fs.writeFileSync(path.join(directory, 'profile', 'projects.json'), JSON.stringify([{ id: projectId, lastOpenedAt: Date.now() }]))
    api.registerComparisonHandlers()
    await window.loadURL(url)
    const invoke = (channel, ...args) => window.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
    const status = await invoke('comparison:status')
    assert.equal(status.firefox, true)
    assert.equal(status.webkit, true)
    const viewportImage = await window.webContents.capturePage().then(image => image.toDataURL({ scaleFactor: 1 }))
    const png = Buffer.from(viewportImage.split(',')[1], 'base64')
    const size = await sharp(png).metadata()
    const chromiumImage = `data:image/png;base64,${(await sharp(png).extend({ bottom: 1200, background: '#008877' }).png().toBuffer()).toString('base64')}`
    for (const engine of ['firefox', 'webkit']) {
      const result = await invoke('comparison:capture', { projectId, engine, url, width: size.width, height: size.height, scrollY: 0, chromiumImage, chromiumDocumentWidth: size.width + 20 })
      assert.equal(result.record.engine, engine)
      assert.equal(result.record.projectId, projectId)
      assert.equal(result.record.width, size.width)
      assert.equal(result.record.fullPage, true)
      assert.equal(result.record.pinnedHeaderHeight, 60)
      assert.match(result.record.warning, /visible .*px-wide column/)
      assert.ok(result.record.engineDocumentWidth > size.width)
      const topPixel = await sharp(Buffer.from(result.image.split(',')[1], 'base64')).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer()
      assert.deepEqual([...topPixel.subarray(0, 3)], [102, 85, 68], 'the fixed navigation must appear at the top of the full-page capture')
      assert.ok(result.record.imageHeight > size.height, 'the browser image must include content below the viewport')
      assert.ok(result.record.chromiumImageHeight > size.height)
      assert.ok(result.image.startsWith('data:image/png;base64,'))
      assert.equal((await invoke('comparison:load', projectId, result.record.id)).record.id, result.record.id)
      const annotations = [{ id: 'a0000000-0000-0000-0000-000000000001', x: .1, y: .2, width: .3, height: .4, note: 'Heading differs' }]
      assert.equal((await invoke('comparison:save-annotations', projectId, result.record.id, annotations)).annotations[0].note, 'Heading differs')
      await assert.rejects(invoke('comparison:load', 'other-project', result.record.id), /unavailable to this account/)
    }
    const saved = await invoke('comparison:list', projectId)
    assert.equal(saved.length, 2)
    assert.notEqual(saved[0].id, saved[1].id)
    await window.webContents.executeJavaScript("require('electron').ipcRenderer.on('comparison:progress', (_event, progress) => { window.__comparisonPhase = progress.phase }); true")
    const cancelled = invoke('comparison:capture', { projectId, engine: 'firefox', url: `${url.replace('/fixture', '/slow')}`, width: size.width, height: size.height, scrollY: 0, chromiumImage })
    let phase = ''
    for (let attempt = 0; attempt < 60; attempt++) {
      phase = await window.webContents.executeJavaScript('window.__comparisonPhase')
      if (phase === 'loading') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(phase, 'loading')
    await invoke('comparison:cancel')
    await assert.rejects(cancelled, /cancelled/i)
    assert.equal((await invoke('comparison:list', projectId)).length, 2, 'cancelled work must not save a partial comparison')
    if (process.platform === 'win32' && safeStorage.isEncryptionAvailable()) {
      await invoke('comparison:open-login', 'firefox', projectId, url.replace('/fixture', '/login'))
      await invoke('comparison:finish-login', 'firefox', projectId)
      const root = path.join(directory, 'profile', 'browser-comparisons')
      const savedSession = fs.readdirSync(root, { recursive: true }).find(item => String(item).endsWith('session-firefox.bin'))
      assert.ok(savedSession)
      const encrypted = fs.readFileSync(path.join(root, savedSession))
      const auth = JSON.parse(safeStorage.decryptString(encrypted))
      assert.ok(auth.storageState.cookies.some(cookie => cookie.name === 'paritySmoke'))
      assert.ok(Object.values(auth.sessionStorage).some(entries => entries.paritySmoke === 'yes'))
      await invoke('comparison:clear-session', 'firefox', projectId)
      assert.equal(fs.existsSync(path.join(root, savedSession)), false)
    }
    console.log('Firefox and WebKit captures, persistence, annotations, project isolation, cancellation, and browser login passed.')
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
    app.quit()
  }
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); process.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
