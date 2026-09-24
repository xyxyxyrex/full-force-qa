/* Local contract server + real Electron, Supabase client, safeStorage, IPC and UI.
 * No real Google, Monday account, Supabase project or user profile is accessed. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-account-smoke-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(dir, 'node_modules'), 'junction')
  await build({ entryPoints: [path.join(__dirname, 'fixtures/account-integration.ts')], outfile: path.join(dir, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp'], define: { __PARITY_SUPABASE_URL__: '""', __PARITY_SUPABASE_KEY__: '""' } })
  await build({ entryPoints: [path.join(__dirname, '../src/preload/index.ts')], outfile: path.join(dir, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'] })
  await build({ entryPoints: [path.join(__dirname, 'fixtures/account-ui.tsx')], outfile: path.join(dir, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' } })
  fs.writeFileSync(path.join(dir, 'ui.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{background:#18181b;color:#eee;font:14px Arial}</style><div id="root"></div><script src="ui.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90000)
  child.once('exit', code => { clearTimeout(timer); console.log('Account smoke artifacts:', dir); process.exitCode = code === 0 ? 0 : 1 })
}
async function smoke() {
  const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron'), http = require('node:http')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration(); await app.whenReady()
  const users = new Map(), accounts = new Map(), records = new Map(), feedback = []; let requests = 0, oauthEmail = 'old@example.test'
  const uid = email => email === 'old@example.test' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002'
  const session = email => {
    const user = { id: uid(email), aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
    const token = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: user.id, email, exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url'), 'signature'].join('.')
    users.set(token, user)
    return { access_token: token, refresh_token: 'test-refresh-' + user.id, token_type: 'bearer', expires_in: 3600, user }
  }
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}, identity = users.get((req.headers.authorization || '').replace('Bearer ', ''))
    const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url.startsWith('/auth/v1/settings')) return reply({ external: { google: true } })
    if (req.url.startsWith('/auth/v1/token?grant_type=pkce')) return body.auth_code === 'google-code' ? reply(session(oauthEmail)) : reply({ msg: 'Invalid authorization code' }, 403)
    if (req.url.startsWith('/auth/v1/user')) return identity ? reply(identity) : reply({ message: 'Unauthorized' }, 401)
    if (req.url.startsWith('/auth/v1/logout')) return reply({})
    if (!identity) return reply({ error: 'Unauthorized' }, 401)
    requests++
    if (body.action === 'submit_feedback') { feedback.push({ userId: identity.id, ...body.feedback }); return reply({ id: '00000000-0000-4000-8000-000000000321' }) }
    if (body.action === 'initialize') {
      if (body.mode === 'monday' && body.mondayToken !== 'fresh-monday-proof') return reply({ error: 'Monday proof required' }, 401)
      const ownerKey = body.mode === 'monday' ? 'monday:7' : 'parity:' + identity.id
      const user = { ownerKey, authUserId: identity.id, email: identity.email, name: 'Test user' }
      accounts.set(identity.id, user); return reply({ user })
    }
    const user = accounts.get(identity.id)
    if (!user) return reply({ needsSetup: true })
    if (body.action === 'status') return reply({ user })
    const key = user.ownerKey + ':' + (body.ticket?.id || '')
    if (body.action === 'save_ticket') {
      const previous = records.get(key)
      if ((previous?.revision || 0) !== body.revision) return reply({ conflict: true, ...previous })
      const record = { ticket: body.ticket, revision: body.revision + 1 }; records.set(key, record); return reply({ revision: record.revision })
    }
    if (body.action === 'list_tickets') return reply({ records: [...records].filter(([key]) => key.startsWith(user.ownerKey + ':')).map(([,record]) => record) })
    return reply({ success: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:' + server.address().port; process.env.VITE_SUPABASE_ANON_KEY = 'test-public-key'
  shell.openExternal = async authorizationUrl => {
    const url = new URL(authorizationUrl)
    assert.equal(url.searchParams.get('provider'), 'google')
    const redirectTo = url.searchParams.get('redirect_to')
    assert(redirectTo?.startsWith('http://127.0.0.1:51848/account/oauth/callback'))
    setTimeout(() => void fetch(redirectTo + '?code=google-code'), 20)
  }
  const mainFile = path.join(dir, 'main.cjs'), api = require(mainFile)
  const window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { preload: path.join(dir, 'preload.cjs'), backgroundThrottling: false, offscreen: true } })
  try {
    assert(safeStorage.isEncryptionAvailable())
    api.setProjectOwner('monday:7')
    const original = { id: 'monday-42', name: 'Existing page', stagingUrl: 'https://stage.test', adminUrl: '', createdAt: 1, lastOpenedAt: 1 }
    api.saveProject(original)
    const attachment = await api.saveLocalNoteAttachment('monday:7', { name: 'original.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('original attachment').toString('base64') })
    api.setProjectOwner(null)
    api.registerTicketHandlers()
    ipcMain.handle('account:status', () => api.getAccountStatus())
    ipcMain.handle('account:login-google', () => api.loginWithGoogle())
    ipcMain.handle('account:initialize', (_, mode) => api.initializeAccount(mode, 'fresh-monday-proof'))
    ipcMain.handle('account:sign-out', () => api.signOutAccount())
    ipcMain.handle('projects:list', () => api.getProjects())
    ipcMain.handle('projects:save', (_, project, owner) => { api.assertAccountOwner(owner); api.saveProject(project) })
    await window.loadFile(path.join(dir, 'ui.html'))
    const js = source => window.webContents.executeJavaScript(source)
    const until = async predicate => { for(let i=0;i<100;i++){ if(await js(predicate)) return; await new Promise(r=>setTimeout(r,50)) } throw Error('UI timeout: '+predicate) }
    const click = text => js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`)
    const fill = (selector, text) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await until("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Continue with Google')")
    fs.writeFileSync(path.join(dir, 'account-sign-in.png'), (await window.capturePage()).toPNG())
    await click('Continue with Google')
    await until("document.body.textContent.includes('Restore my existing Monday workspace')")
    assert.equal((await api.accountRequest('submit_feedback', { feedback: { kind: 'bug', title: 'Sign-in issue', details: 'This happened before setup.', area: 'settings', appVersion: '1.4.6', platform: 'win32' } })).id, '00000000-0000-4000-8000-000000000321')
    assert.equal(feedback[0].userId, uid('old@example.test'))
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(dir, 'account-setup.png'), (await window.capturePage()).toPNG())
    await click('Restore my existing Monday workspace'); await until("document.body.textContent.includes('Your workspace is ready')")
    assert.equal(api.accountOwner(), 'monday:7'); assert.equal(api.getProjects()[0].id, original.id)
    assert.equal(api.loadLocalNoteAttachment(attachment.uri).bytes.toString(), 'original attachment')
    const encrypted = fs.readFileSync(path.join(dir, 'profile/parity-auth.bin'))
    assert(!encrypted.toString().includes('test-refresh'))
    await until("!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add ticket').disabled")
    await click('Add ticket'); await fill('input[maxlength="500"]', 'Opsmosis smoke ticket')
    await click('Save ticket'); await until("!!document.querySelector('.ticket-card h3')")
    await until("document.querySelector('.ticket-card-meta').textContent.includes('Synced')")
    assert.equal((await js('window.intakeTickets()'))[0].providerLabel, 'Opsmosis')
    await click('Create project'); await until("document.body.textContent.includes('Create another page')")
    await click('Create another page'); assert.equal(api.getProjects().filter(p=>p.ticketRef).length, 2)
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(dir, 'tickets.png'), (await window.capturePage()).toPNG())
    const oldTicket = [...records.values()][0].ticket
    await api.signOutAccount()
    assert.equal(api.loadLocalNoteAttachment(attachment.uri), null)
    oauthEmail = 'new@example.test'; await api.loginWithGoogle(); await api.initializeAccount('new')
    assert.equal(api.getProjects().length, 0)
    assert.equal((await js('window.electronAPI.ticketsList()')).records.length, 0)
    await assert.rejects(js(`window.electronAPI.ticketsSave(${JSON.stringify(oldTicket)},'monday:7')`), /account changed/)
    delete require.cache[require.resolve(mainFile)]
    const restarted = require(mainFile); await restarted.restoreAccount()
    assert.equal(restarted.accountOwner(), api.accountOwner())
    assert(requests > 5)
    console.log('PASS: Google PKCE browser callback, restored owner and attachment path, safeStorage, manual Opsmosis UI, shared picker, two page projects, account isolation and encrypted session restoration.')
    app.exit(0)
  } catch(error) { console.error(error); app.exit(1) }
  finally { server.close() }
}
if (process.argv.includes('--smoke')) smoke().catch(error=>{console.error(error);require('electron').app.exit(1)})
else driver().catch(error=>{console.error(error);process.exitCode=1})
