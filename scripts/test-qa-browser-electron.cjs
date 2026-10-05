/* Drives the agent's own browser (src/main/qaAgent/qaBrowser.ts) against a small local site in Electron:
 * clicking, typing, forms, links, console and network errors, dialogs, mobile menus, the API, and the
 * rules (stays on the site, never opens admin/login/logout, sends no data unless allowed).
 *
 *   npm run test:qa-browser:electron */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-qa-browser-'))
  await build({ entryPoints: [path.join(__dirname, '..', 'src', 'main', 'qaAgent', 'qaBrowser.ts')], outfile: path.join(dir, 'browser.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 150_000)
  child.once('exit', code => { clearTimeout(timer); console.log('QA browser screenshots:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

function site() {
  const hits = []
  const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>${head}<style>body{font:16px sans-serif;margin:20px}.burger{display:none}@media(max-width:600px){.burger{display:block}nav.main{display:none}nav.main.open{display:block}}</style></head><body>${body}</body></html>`
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw })
      const loggedIn = /wordpress_logged_in_test=yes/.test(req.headers.cookie || '')
      const send = (status, type, text) => { res.writeHead(status, { 'Content-Type': type }); res.end(text) }
      if (req.url === '/') return send(200, 'text/html', page('Home', `
        <h1>${loggedIn ? 'Logged in home' : 'Home'}</h1>
        <button class="burger" onclick="document.querySelector('nav.main').classList.toggle('open')">Menu</button>
        <nav class="main"><a href="/contact/">Contact</a> <a href="/missing">Old page</a> <a href="#">Learn more</a> <a href="mailto:hi@site.test">Email</a> <a href="/wp-login.php?action=logout&_wpnonce=1">Log out</a> <a href="${OTHER}/">Partner site</a></nav>
        <img src="/nope.png" width="20" height="20">
        <button id="more" onclick="this.textContent = this.textContent === 'Show more' ? 'Show less' : 'Show more'">Show more</button>
        <button onclick="alert('Hello from the page')">Say hello</button>
        <button onclick="window.open('/popup')">Open popup</button>
        <script>console.error('Something broke on load')</script>`))
      if (req.url === '/contact/') return send(200, 'text/html', page('Contact', `
        <h1>Contact us</h1>
        <form method="post" action="/submit"><label for="email">Your email</label><input id="email" name="email" type="email" required>
        <select name="topic"><option value="">Choose…</option><option value="hair">Hair loss</option><option value="other">Something else</option></select>
        <input name="nolabel" placeholder="Phone"><button type="submit">Send</button></form>
        <button id="ajax" onclick="fetch('/api/subscribe', { method: 'POST', body: '{}' }).then(() => { this.textContent = 'Subscribed' }, () => { this.textContent = 'Could not subscribe' })">Subscribe</button>`))
      if (req.url === '/submit') return send(200, 'text/html', page('Thanks', '<h1>Thanks, we got it</h1>'))
      if (req.url === '/api/items') return send(200, 'application/json', JSON.stringify([{ id: 1, name: 'First' }]))
      if (req.url.startsWith('/wp-admin') || req.url.startsWith('/wp-login')) return send(200, 'text/html', page('Admin', '<h1>Admin</h1>'))
      send(404, 'text/html', page('Not found', '<h1>404</h1>'))
    })
  })
  return { server, hits }
}
let OTHER = ''

async function smoke() {
  const { app, session } = require('electron')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration(); await app.whenReady()
  const other = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Other site</h1>') })
  await new Promise(r => other.listen(0, '127.0.0.1', r))
  OTHER = `http://localhost:${other.address().port}`
  const { server, hits } = site()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const siteKey = base
  await session.defaultSession.cookies.set({ url: base, name: 'wordpress_logged_in_test', value: 'yes' })
  const { createQaBrowser } = require(path.join(dir, 'browser.cjs'))
  const browser = createQaBrowser()
  const shot = (name, step) => fs.writeFileSync(path.join(dir, `${name}.jpg`), step.screenshot)
  const el = (step, name) => step.snapshot.elements.find(e => e.name === name)

  // Opening: the person's login carries over; console and network errors are reported; screenshots are JPEG.
  let step = await browser.open({ url: `${base}/`, site: siteKey, breakpoint: 'desktop', width: 1440, allowSend: false, runId: 'run-1' })
  shot('home', step)
  assert.equal(step.status, 200)
  assert.equal(step.snapshot.headings[0].text, 'Logged in home', 'the login cookie was copied into the agent\'s browser')
  assert.ok(step.screenshot.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'screenshots are JPEG')
  assert.ok(step.events.console.some(e => e.level === 'error' && /Something broke on load/.test(e.message)), 'console errors are caught')
  assert.ok(step.events.requests.some(r => r.status === 404 && r.url.endsWith('/nope.png')), 'failed requests are caught')
  assert.ok(el(step, 'Contact') && el(step, 'Contact').href === '/contact/')
  assert.equal(browser.runId, 'run-1')

  // Clicking changes the page; dialogs are answered and reported; pop-ups are not opened.
  step = await browser.click(el(step, 'Show more').ref)
  assert.ok(el(step, 'Show less'), 'a real click ran the page\'s own script')
  step = await browser.click(el(step, 'Say hello').ref)
  assert.deepEqual(step.events.dialogs, [{ type: 'alert', message: 'Hello from the page' }])
  step = await browser.click(el(step, 'Open popup').ref)
  assert.ok(step.events.popups.some(u => u.endsWith('/popup')), 'pop-ups are reported, not opened')

  // Leaving the site is blocked and reported.
  step = await browser.click(el(step, 'Partner site').ref)
  assert.equal(step.snapshot.url, `${base}/`, 'the browser stayed on the site')
  assert.ok(step.events.blocked.some(b => b.kind === 'navigation' && b.url.startsWith(OTHER)), 'the attempt is reported')

  // Links: broken and placeholder links are found; the logout link is never requested.
  const links = await browser.links()
  const byText = text => links.find(l => l.text === text)
  assert.equal(byText('Contact').status, 200); assert.equal(byText('Old page').status, 404)
  assert.equal(byText('Learn more').plan, 'placeholder'); assert.equal(byText('Email').plan, 'skip-scheme'); assert.equal(byText('Log out').plan, 'skip-admin')
  assert.equal(hits.some(h => h.url.startsWith('/wp-login')), false, 'the logout link was never requested')

  // Audit and API.
  const audit = await browser.audit()
  assert.equal(audit.title, 'Home'); assert.deepEqual(audit.h1, ['Logged in home']); assert.equal(audit.description, ''); assert.equal(audit.lang, 'en')
  assert.ok(audit.brokenImages.some(u => u.endsWith('/nope.png')))
  const api = await browser.request({ method: 'GET', url: '/api/items' })
  assert.equal(api.status, 200); assert.deepEqual(JSON.parse(api.body), [{ id: 1, name: 'First' }])
  await assert.rejects(browser.request({ method: 'POST', url: '/api/items', body: '{}' }), /sending is off/, 'sending to the API needs permission')
  await assert.rejects(browser.request({ method: 'GET', url: `${OTHER}/` }), /only go to the site under review/)
  await assert.rejects(browser.request({ method: 'GET', url: '/wp-admin/users.php' }), /off limits/)

  // A form: browser validation, typing, choosing, and a submission that Parity blocks.
  step = await browser.click(el(await browser.snapshot(), 'Contact').ref)
  assert.equal(step.navigated, true); assert.equal(step.snapshot.title, 'Contact')
  assert.equal(step.snapshot.forms[0].method, 'POST')
  const email = el(step, 'Your email')
  assert.equal(email.required, true)
  step = await browser.type(email.ref, 'not-an-email', { clear: true, enter: false })
  assert.match(el(step, 'Your email').invalid || '', /@/, 'the browser\'s own validation message is reported')
  step = await browser.type(email.ref, 'tester@example.com', { clear: true, enter: false })
  step = await browser.select(step.snapshot.elements.find(e => e.role === 'select').ref, 'Hair loss')
  assert.equal(step.snapshot.elements.find(e => e.role === 'select').value, 'Hair loss')
  step = await browser.click(el(step, 'Send').ref)
  shot('contact-blocked', step)
  assert.ok(step.events.blocked.some(b => b.kind === 'form' && b.method === 'POST' && b.url.endsWith('/submit')), 'the submission was blocked and reported')
  assert.equal(step.snapshot.title, 'Contact', 'the page stayed as it was')
  assert.equal(el(step, 'Your email').value, 'tester@example.com', 'with what the agent typed')
  // A form that sends with fetch is stopped by the request rules, and the page shows its own error.
  step = await browser.click(el(step, 'Subscribe').ref)
  assert.ok(step.events.blocked.some(b => b.kind === 'request' && b.method === 'POST' && b.url.endsWith('/api/subscribe')))
  assert.ok(el(step, 'Could not subscribe'), 'the page saw the request fail')
  assert.equal(hits.some(h => h.method === 'POST'), false, 'nothing was sent to the site')

  // With sending allowed, the same form goes through.
  step = await browser.open({ url: `${base}/contact/`, site: siteKey, breakpoint: 'desktop', width: 1440, allowSend: true, runId: 'run-1' })
  step = await browser.type(el(step, 'Your email').ref, 'tester@example.com', { clear: true, enter: true })
  assert.equal(step.snapshot.title, 'Thanks', 'Enter submitted the form')
  assert.ok(hits.some(h => h.method === 'POST' && h.url === '/submit' && /email=tester%40example\.com/.test(h.body)), 'the site received the submission')
  await assert.rejects(browser.request({ method: 'GET', url: '/wp-login.php' }), /off limits/)

  // Mobile: the menu button appears and opens the menu.
  step = await browser.open({ url: `${base}/`, site: siteKey, breakpoint: 'mobile', width: 390, allowSend: false, runId: 'run-1' })
  assert.equal(step.snapshot.viewport.width, 390)
  assert.equal(el(step, 'Contact'), undefined, 'the menu is closed on mobile')
  step = await browser.click(el(step, 'Menu').ref)
  shot('mobile-menu', step)
  assert.ok(el(step, 'Contact'), 'the menu opened')
  step = await browser.press('Escape')
  step = await browser.scroll('bottom')
  assert.ok(step.snapshot.scrollY >= 0)

  // Admin pages cannot be opened, and nothing ever reached them.
  await assert.rejects(browser.open({ url: `${base}/wp-admin/`, site: siteKey, breakpoint: 'desktop', width: 1440, allowSend: false, runId: 'run-1' }), /off limits/)
  assert.equal(hits.some(h => h.url.startsWith('/wp-admin')), false)
  // The person's own browsing session was not changed.
  assert.equal((await session.defaultSession.cookies.get({ url: base })).length, 1)

  browser.close()
  assert.equal(browser.runId, null)
  console.log('QA browser smoke passed')
  server.close(); other.close()
  app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
