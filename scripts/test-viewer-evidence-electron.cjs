/* Loads the built viewer site's QA evidence page (?evidence=<id>) in Electron, with the evidence
 * service answered locally, and checks what a person opening a tracker link sees.
 *
 *   npm run test:viewer:electron */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const SUPABASE = 'https://ci-placeholder.supabase.co'
const LIVE = 'AbCdEfGhIjKlMnOpQrStUv', EXPIRED = 'ZzZzZzZzZzZzZzZzZzZzZz', EVIL = 'EeEeEeEeEeEeEeEeEeEeEe'

async function driver() {
  const { execFileSync, spawn } = require('node:child_process')
  const root = path.join(__dirname, '..')
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-viewer.js')], { cwd: root, env: { ...process.env, VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: 'ci-placeholder-key', VITE_EPHEMERAL_VIEWER_URL: 'https://parity-gfx.pages.dev' }, stdio: 'inherit' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-viewer-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir, path.join(root, 'dist-viewer')], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90_000)
  child.once('exit', code => { clearTimeout(timer); console.log('Viewer screenshots:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow, protocol, net } = require('electron')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  const site = process.argv[process.argv.indexOf('--smoke') + 2]
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration(); await app.whenReady()
  const png = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'parity-180.png'))
  const requests = []
  // Answer the evidence service as the deployed function would; anything else on the internet is refused.
  protocol.handle('https', async (request) => {
    const url = new URL(request.url)
    requests.push(url.pathname)
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    if (url.origin !== SUPABASE) return new Response('blocked', { status: 403 })
    const fn = '/functions/v1/qa-evidence/'
    if (url.pathname === `${fn}${LIVE}.json`) return new Response(JSON.stringify({ id: LIVE, label: 'Hero: wrong image (Desktop and Mobile)', contentType: 'image/png', expiresAt: '2027-01-03T00:00:00Z', image: `${SUPABASE}${fn}${LIVE}.png` }), { headers: cors })
    if (url.pathname === `${fn}${LIVE}.png`) return new Response(png, { headers: { 'Content-Type': 'image/png' } })
    if (url.pathname === `${fn}${EVIL}.json`) return new Response(JSON.stringify({ label: 'x', image: 'https://evil.test/track.png' }), { headers: cors })
    return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: cors })
  })
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false } })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const run = code => win.webContents.executeJavaScript(code)
  const text = selector => run(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
  const open = async query => { await win.loadFile(path.join(site, 'index.html'), { query }); await sleep(700) }
  const shot = async name => { await sleep(250); fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG()) }

  await open({ evidence: LIVE })
  assert.equal(await run(`document.getElementById('evidencePage').hidden`), false, 'the evidence page shows')
  assert.equal(await run(`document.getElementById('viewerPage').hidden && document.getElementById('landing').hidden`), true, 'the snapshot viewer and the landing page stay hidden')
  assert.equal(await text('#evidenceTitle'), 'Hero: wrong image (Desktop and Mobile)', 'the finding is the title')
  assert.match(await text('#evidenceExpiry'), /Available until .*2027/)
  assert.equal(await run(`document.getElementById('evidenceImage').naturalWidth`), 180, 'the picture loads from the evidence store')
  assert.equal(await run(`document.getElementById('evidenceOpen').href`), `${SUPABASE}/functions/v1/qa-evidence/${LIVE}.png`)
  assert.equal(await run(`document.querySelector('meta[name=robots]').content`), 'noindex, nofollow')
  assert.match(await run('document.title'), /^Hero: wrong image/)
  await shot('evidence')
  await run(`document.getElementById('evidenceImage').click()`); await sleep(150)
  assert.equal(await run(`document.getElementById('imageLightbox').hidden`), false, 'clicking the picture enlarges it')

  await open({ evidence: EXPIRED })
  assert.match(await text('#evidenceMessage'), /expired, or the link is not complete/)
  assert.equal(await run(`document.getElementById('evidenceImage').hidden`), true)
  await shot('evidence-expired')

  await open({ evidence: 'short' })
  assert.match(await text('#evidenceMessage'), /This link is not complete/)

  await open({ evidence: EVIL })
  assert.match(await text('#evidenceMessage'), /unexpected answer/, 'a picture from anywhere else is not shown')
  assert.equal(requests.some(p => p.includes('track.png')), false)

  await open({})
  assert.equal(await run(`document.getElementById('landing').hidden`), false, 'the landing page still shows without parameters')

  console.log('Viewer evidence smoke passed')
  app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
