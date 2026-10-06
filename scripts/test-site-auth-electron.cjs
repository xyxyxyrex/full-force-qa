const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-site-auth-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(dir, 'node_modules'), 'junction')
  await build({ entryPoints: [path.join(__dirname, 'fixtures/site-auth-main.ts')], outfile: path.join(dir, 'main.cjs'), bundle: true, platform: 'node', external: ['electron', 'sharp'] })
  await build({ entryPoints: [path.join(__dirname, '../src/preload/index.ts')], outfile: path.join(dir, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'] })
  await build({ entryPoints: [path.join(__dirname, 'fixtures/site-auth-ui.tsx')], outfile: path.join(dir, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(dir, 'ui.html'), '<!doctype html><html data-theme="parity"><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><button id="previous">Capture</button><div id="root"></div><script src="ui.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90000)
  child.once('exit', code => { clearTimeout(timer); console.log('Site authentication artifacts:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow, session } = require('electron'), http = require('node:http')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const api = require(path.join(dir, 'main.cjs'))
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: path.join(dir, 'preload.cjs'), offscreen: true, backgroundThrottling: false } })
  const nativeDialog = process.argv.includes('--native')
  let promptWindow
  api.registerSiteAuthentication(() => win, nativeDialog ? contents => {
    const parent = BrowserWindow.fromWebContents(contents)
    const prompt = new BrowserWindow({ show: false, parent: parent?.isModal() ? parent : win, modal: true, width: 460, height: 530, webPreferences: { preload: path.join(dir, 'preload.cjs'), offscreen: true, backgroundThrottling: false } })
    promptWindow = prompt
    void prompt.loadFile(path.join(dir, 'ui.html'), { query: { standalone: '1' } })
    return prompt
  } : undefined)
  await win.loadFile(path.join(dir, 'ui.html'))
  const js = value => (promptWindow && !promptWindow.isDestroyed() ? promptWindow : win).webContents.executeJavaScript(value)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async value => { for (let i = 0; i < 140; i++) { try { if (await js(value)) return } catch { /* A native prompt can close between polls. */ } await sleep(50) } throw new Error(`Timeout: ${value}`) }
  const submit = async password => {
    await js(`(() => { const inputs=document.querySelectorAll('.site-auth-dialog input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(inputs[0],'reviewer'); inputs[0].dispatchEvent(new Event('input',{bubbles:true})); set.call(inputs[1],${JSON.stringify(password)}); inputs[1].dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await until("!document.querySelector('.site-auth-primary').disabled")
    await js("document.querySelector('.site-auth-primary').click()")
  }
  let requestCount = 0, otherAuthorization = false
  const other = http.createServer((req, res) => { otherAuthorization ||= !!req.headers.authorization; res.end('other site') })
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
  const server = http.createServer((req, res) => {
    requestCount++
    if (req.headers.authorization !== 'Basic ' + Buffer.from('reviewer:staging-secret').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Staging review"' }); return res.end('Please sign in')
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>Protected staging</title></head><body><h1>Authenticated page</h1></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  let capture
  try {
    await js("document.getElementById('previous').focus()")
    capture = api.captureUrl(url)
    await until("!!document.querySelector('.site-auth-dialog')")
    assert.equal(await js("document.activeElement === document.querySelector('.site-auth-dialog input')"), true)
    assert.equal(await js("document.querySelector('.site-auth-dialog strong').textContent"), new URL(url).origin)
    assert.equal(await js("document.querySelectorAll('.site-auth-dialog input')[1].type"), 'password')
    const darkColor = await js("getComputedStyle(document.querySelector('.site-auth-dialog')).backgroundColor")
    await js("document.documentElement.dataset.theme='light'")
    assert.notEqual(await js("getComputedStyle(document.querySelector('.site-auth-dialog')).backgroundColor"), darkColor)
    await js("document.documentElement.dataset.theme='parity'")
    await sleep(150)
    fs.writeFileSync(path.join(dir, 'site-auth.png'), (await (nativeDialog ? promptWindow : win).webContents.capturePage()).toPNG())
    await js("document.querySelector('.site-auth-password button').click()")
    assert.equal(await js("document.querySelectorAll('.site-auth-dialog input')[1].type"), 'text')
    await submit('wrong-password')
    console.log('  verifying rejected credentials')
    await until("!!document.querySelector('.site-auth-error')")
    assert.match(await js("document.querySelector('.site-auth-error').textContent"), /did not accept/)
    await submit('staging-secret')
    console.log('  capturing the authenticated page')
    const html = await capture
    assert.match(html, /Authenticated page/)
    assert.doesNotMatch(html, /staging-secret|wrong-password/)
    await until("!document.querySelector('.site-auth-dialog')")
    assert.equal(await js("document.activeElement.id"), 'previous')
    assert.equal(api.rememberedSiteCredentials(session.defaultSession, url).username, 'reviewer')
    const again = await api.captureUrl(url)
    console.log('  verifying session reuse')
    assert.match(again, /Authenticated page/)
    assert.equal(await js("!!document.querySelector('.site-auth-dialog')"), false, 'cached session does not prompt again')
    if (nativeDialog) assert.equal(promptWindow.isDestroyed(), true, 'the native prompt closes after submitting')

    // A new Electron session and another origin must authenticate independently.
    const isolated = new BrowserWindow({ show: false, webPreferences: { partition: 'auth-isolated' } })
    await isolated.loadURL(url)
    assert.equal(await js("!!document.querySelector('.site-auth-dialog')"), false, 'agent session reuses matching approved site credentials')
    const otherUrl = `http://127.0.0.1:${other.address().port}/`
    await isolated.loadURL(otherUrl)
    assert.equal(otherAuthorization, false)
    assert.equal(api.rememberedSiteCredentials(session.defaultSession, otherUrl), undefined)
    isolated.destroy()

    api.clearSiteAuthentication(); await session.defaultSession.clearAuthCache()
    const qaCapture = api.captureLivePage({ url, breakpoint: 'desktop', width: 800 })
    await until("!!document.querySelector('.site-auth-dialog')")
    await submit('staging-secret')
    const qa = await qaCapture
    console.log('  verifying authenticated QA screenshots')
    assert.ok(qa.nodes.some(node => node.tag === 'h1' && node.text === 'Authenticated page'), 'QA capture resumes after authentication')
    assert.equal(qa.warnings.some(value => value.includes('HTTP 401') || value.includes('load timeout')), false)
    fs.writeFileSync(path.join(dir, 'qa-authenticated.png'), qa.png)

    if (process.argv.includes('--engines')) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(app.getPath('appData'), 'Parity', 'browser-runtimes')
      const playwright = require('playwright')
      for (const name of ['firefox', 'webkit']) {
        const browser = await playwright[name].launch({ headless: true })
        try {
          const protectedPage = await api.openAuthenticatedComparison(browser, url, {}, win.webContents)
          assert.equal(protectedPage.response.status(), 200)
          assert.match(await protectedPage.page.content(), /Authenticated page/)
          await protectedPage.page.goto(otherUrl)
          assert.equal(otherAuthorization, false, `${name}: credentials must not follow to another origin`)
          await protectedPage.context.close()

          // A fresh challenge uses the same themed dialog and resumes the engine capture.
          api.clearSiteAuthentication()
          const prompted = api.openAuthenticatedComparison(browser, url, {}, win.webContents)
          await until("!!document.querySelector('.site-auth-dialog')")
          await submit('staging-secret')
          const signedIn = await prompted
          assert.equal(signedIn.response.status(), 200)
          await signedIn.page.screenshot({ path: path.join(dir, `${name}-authenticated.png`) })
          await signedIn.context.close()
          console.log(`PASS: ${name} authenticated navigation, prompt/resume and origin restriction`)
        } finally { await browser.close() }
      }
    }

    // A pending challenge pauses the deadline until the user responds.
    const pending = api.requestSiteAuthentication(session.defaultSession, { origin: new URL(url).origin, realm: 'Slow sign-in', scheme: 'basic', isProxy: false, retry: false }, win.webContents)
    await until("!!document.querySelector('.site-auth-dialog')")
    let complete
    const task = api.withSiteAuthenticationTimeout(new Promise(resolve => { complete = resolve }), win.webContents, 150, 'load timed out')
    await sleep(400)
    await submit('staging-secret')
    assert.equal((await pending).username, 'reviewer')
    complete('resumed'); assert.equal(await task, 'resumed')
    console.log('  verifying paused load deadline')

    // Clear credential memory and Chromium's own cache to exercise cancellation.
    api.clearSiteAuthentication(); await session.defaultSession.clearAuthCache()
    const cancelled = api.captureUrl(url)
    const rejected = assert.rejects(cancelled, /Sign-in was cancelled|server did not accept/i)
    await until("document.querySelector('.site-auth-realm')?.textContent === 'Staging review'")
    // Assert the cancellation effect instead of awaiting a reply from a closing renderer.
    void js("document.querySelector('.site-auth-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))").catch(() => {})
    await rejected
    console.log('  verifying capture cancellation')
    assert.equal(api.rememberedSiteCredentials(session.defaultSession, url), undefined)
    await until("!document.querySelector('.site-auth-dialog')")

    // Closing the page also closes its pending authentication request.
    const closing = new BrowserWindow({ show: false, parent: win, modal: true, webPreferences: { partition: 'auth-closing' } })
    const navigation = closing.loadURL(url).catch(() => {})
    await until("!!document.querySelector('.site-auth-dialog')")
    if (nativeDialog) {
      assert.equal(promptWindow.getParentWindow(), closing, 'authentication is a child of the modal login window')
      assert.equal(await win.webContents.executeJavaScript('window.electronAPI.siteAuthPending()'), null, 'only the authentication window can access its challenge')
    }
    closing.destroy()
    // Electron can leave loadURL's promise unresolved when its modal parent is destroyed.
    // The actual invariant is that the page is gone and no credential request remains.
    void navigation
    console.log('  verifying modal parent cleanup')
    await until("!document.querySelector('.site-auth-dialog')")
    assert.ok(requestCount >= 5)
    console.log('PASS: HTTP challenge, incorrect credentials/retry, capture/resume, session reuse, origin isolation, masked password, focus restoration, paused timeout, cancel and page-close cleanup.')
  } finally { api.clearSiteAuthentication(); server.close(); other.close(); win.destroy(); app.quit() }
}

(process.argv.includes('--smoke') ? smoke() : driver()).catch(error => { console.error(error); process.exitCode = 1; if (process.argv.includes('--smoke')) require('electron').app.exit(1) })
