// Isolated Electron profile. No real account, staging URL or user data is used.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-palette-'))
  await build({ entryPoints: [path.join(__dirname, 'fixtures/palette-ui.tsx')], outfile: path.join(dir, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  await build({ entryPoints: [path.join(__dirname, '../src/main/paletteShortcut.ts')], outfile: path.join(dir, 'shortcut.cjs'), bundle: true, platform: 'node', external: ['electron'] })
  await build({ entryPoints: [path.join(__dirname, '../src/preload/index.ts')], outfile: path.join(dir, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'] })
  fs.writeFileSync(path.join(dir, 'ui.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{background:#15151a;font:14px Arial}button{padding:8px}</style><div id="root"></div><script src="ui.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 60000)
  child.on('exit', code => { clearTimeout(timer); console.log('Palette smoke artifacts:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

async function smoke() {
  const { app, BrowserWindow, webContents } = require('electron')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration(); await app.whenReady()
  const { forwardPaletteShortcut } = require(path.join(dir, 'shortcut.cjs'))
  let window
  app.on('web-contents-created', (_, contents) => {
    contents.on('before-input-event', (event, input) => forwardPaletteShortcut(contents, event, input, window?.webContents))
  })
  window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { preload: path.join(dir, 'preload.cjs'), webviewTag: true, backgroundThrottling: false, offscreen: true } })
  try {
    await window.loadFile(path.join(dir, 'ui.html'))
    const js = expression => window.webContents.executeJavaScript(expression)
    const until = async expression => { for (let attempt = 0; attempt < 100; attempt++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)) } throw new Error(`Timeout: ${expression}`) }
    const fill = value => js(`(() => {const e=document.querySelector('.command-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await until("!!document.getElementById('opener')")
    await js("document.getElementById('opener').focus(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',ctrlKey:true,shiftKey:true,bubbles:true}))")
    await until("!!document.querySelector('[role=dialog]') && document.querySelectorAll('[role=option]').length > 0")
    assert(await js("document.activeElement.matches('.command-palette input') && document.getElementById('root').inert"))
    await fill('> Test command'); await until("document.querySelector('[role=option]')?.textContent.includes('Test command') && document.querySelectorAll('[role=option]').length === 1")
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
    await until("!document.querySelector('[role=dialog]')")
    await until("window.ran")
    assert(await js("window.ranWithoutPalette && !document.getElementById('root').inert && document.activeElement.id === 'opener'"))
    await js("document.getElementById('opener').click()")
    await fill('slow'); await new Promise(resolve => setTimeout(resolve, 190)); await fill('fast')
    await until("document.body.textContent.includes('Result fast')")
    await new Promise(resolve => setTimeout(resolve, 500))
    assert(!(await js("document.body.textContent.includes('Result slow')")))
    fs.writeFileSync(path.join(dir, 'palette.png'), (await window.capturePage()).toPNG())
    await js("window.dispatchEvent(new Event('parity:account-owner-changed'))")
    await until("!document.querySelector('[role=dialog]')")

    await js("new Promise(resolve => {const view=document.createElement('webview');view.id='guest';view.src='data:text/html,<h1>Guest</h1>';view.addEventListener('dom-ready',()=>resolve(true),{once:true});document.body.append(view)})")
    const guest = webContents.fromId(await js("document.getElementById('guest').getWebContentsId()"))
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control', 'shift'] })
    await until("!!document.querySelector('[role=dialog]')")
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    await until("!document.querySelector('[role=dialog]')")

    // Real DOM with deep branches, shadow content, large inventories, hidden text,
    // files, mutations and removed nodes. Execute serialized guest code as well.
    await js(`(() => {
      const frame = document.createElement('iframe'); frame.id='fixture-page'; document.body.append(frame);
      const doc = frame.contentDocument; doc.body.innerHTML='<h1 id="heading">Café calculator</h1><div hidden>Hidden audit copy</div><img src="/assets/hero.png"><div id="shadow"></div><div id="large"></div><div data-fullforce-beta-ui>parity-private-instrumentation</div>';
      doc.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>Shadow specimen</p>';
      doc.querySelector('#large').innerHTML=Array.from({length:3000},(_,i)=>'<div>needle '+i+'</div>').join('');
    })()`)
    const result = await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'search',query:'needle'})")
    assert.equal(result.total, 3000); assert.equal(result.matches.length, 80)
    const oldToken = result.token
    assert.equal((await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'search',query:'shadow specimen'})")).total, 1)
    assert.equal((await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'search',query:'hidden audit'})")).total, 1)
    assert.equal((await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'search',query:'hero.png'})")).matches[0].kind, 'Files')
    assert.equal((await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'search',query:'parity-private-instrumentation'})")).total, 0)
    await js("document.querySelector('#fixture-page').contentDocument.querySelector('h1').textContent='Changed heading'")
    const changed = await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'search',query:'changed heading'})")
    assert.equal(changed.total, 1); assert.notEqual(changed.token, oldToken)
    await js("document.querySelector('#fixture-page').contentDocument.querySelector('h1').remove()")
    await assert.rejects(() => js(`window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'reveal',token:${JSON.stringify(changed.token)},id:${changed.matches[0].id}})`))
    assert.equal((await js("eval(window.pageSearchExpression({action:'search',query:'Open palette'}))")).total >= 1, true)
    await js("window.pageSearch(document.querySelector('#fixture-page').contentDocument,{action:'release'})")
    assert(await js("!document.querySelector('#fixture-page').contentDocument.__parityPageSearch"))
    console.log('PASS: palette keyboard, focus, command execution, cancellation, account reset and page index lifecycle')
  } finally { window.destroy(); app.quit() }
}
(process.argv.includes('--smoke') ? smoke() : driver()).catch(error => { console.error(error); process.exitCode = 1; if (process.argv.includes('--smoke')) require('electron').app.exit(1) })
