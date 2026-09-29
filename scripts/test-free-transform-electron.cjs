const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-free-transform-'))
  await build({
    entryPoints: [path.join(__dirname, 'fixtures/free-transform.tsx')],
    outfile: path.join(directory, 'ui.js'),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  fs.writeFileSync(path.join(directory, 'ui.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>html,body,#overlay-root{width:100%;height:100%;margin:0}</style></head><body><div id="overlay-root" data-fullforce-beta-ui></div><script src="ui.js"></script></body></html>')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90_000)
  child.once('exit', code => {
    clearTimeout(timer)
    process.exitCode = code === 0 ? 0 : 1
  })
}

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  })
  const js = expression => window.webContents.executeJavaScript(expression)
  const until = async (expression, message = expression) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await js(expression)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Timeout: ${message}`)
  }
  const guest = expression => js(expression)
  const pointer = (selector, type, x, y, options = '') => js(`(() => { const target=document.querySelector(${JSON.stringify(selector)}); target.dispatchEvent(new PointerEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,pointerId:17,button:0,buttons:${type === 'pointerup' ? 0 : 1},clientX:${x},clientY:${y}${options}})); })()`)

  try {
    await window.loadFile(path.join(directory, 'ui.html'))
    await until("!!document.querySelector('.edit-beta-selection-box')", 'selection overlay')

    const before = await guest("(() => { const element=document.querySelector('#target'); const target=element.getBoundingClientRect(); const sibling=document.querySelector('#sibling').getBoundingClientRect(); return { target:{left:target.left,top:target.top}, siblingTop:sibling.top, inline:element.style.transform, computed:getComputedStyle(element).transform }; })()")
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Alt',altKey:true,bubbles:true}))")
    await until("document.querySelectorAll('.edit-beta-anchor.free-transform-anchor').length === 8")
    assert.equal(await js("document.querySelector('.edit-beta-free-transform-hint').textContent"), 'Free Transform')
    assert.equal(await js("document.querySelector('.edit-beta-move-handle').title"), 'Translate element')

    await pointer('.edit-beta-move-handle', 'pointerdown', 200, 200)
    await until("document.querySelector('.edit-beta-selection-box').classList.contains('is-free-transform')")
    await new Promise(resolve => setTimeout(resolve, 80))
    await pointer('.edit-beta-move-handle', 'pointermove', 224, 192)
    await until("document.querySelector('.edit-beta-transform-hud')?.textContent.includes('X +24')", 'translation HUD')
    await js("window.dispatchEvent(new KeyboardEvent('keyup',{key:'Alt',bubbles:true}))")
    assert.equal(await js("document.querySelector('.edit-beta-selection-box').classList.contains('is-free-transform')"), true, 'gesture mode must remain locked after Alt release')
    await pointer('.edit-beta-move-handle', 'pointerup', 224, 192)
    await until("!document.querySelector('.edit-beta-transform-hud') && !!document.querySelector('[aria-label=\"Reset Free Transform\"]')", 'committed transform')

    const committed = await guest("(() => { const target=document.querySelector('#target').getBoundingClientRect(); const sibling=document.querySelector('#sibling').getBoundingClientRect(); return { target:{left:target.left,top:target.top}, siblingTop:sibling.top, inline:document.querySelector('#target').style.transform, history:window.__fullForceEditBeta.getState().history.length }; })()")
    assert.ok(Math.abs((committed.target.left - before.target.left) - 24) < 1.2)
    assert.ok(Math.abs((committed.target.top - before.target.top) + 8) < 1.2)
    assert.ok(Math.abs(committed.siblingTop - before.siblingTop) < 0.1, 'translation must preserve the layout footprint')
    assert.equal(committed.history, 1, 'one gesture must create one history entry')
    const committedPatches = await guest("window.__fullForceEditBeta.getPatches()")
    assert.equal(committedPatches.length, 1)

    // Escape restores the previously committed matrix and does not add history.
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Alt',altKey:true,bubbles:true}))")
    await until("document.querySelectorAll('.edit-beta-anchor.free-transform-anchor').length === 8")
    await pointer('.edit-beta-anchor.se', 'pointerdown', 300, 300)
    await new Promise(resolve => setTimeout(resolve, 80))
    await pointer('.edit-beta-anchor.se', 'pointermove', 340, 340)
    await until("!!document.querySelector('.edit-beta-transform-hud')")
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
    await until("!document.querySelector('.edit-beta-transform-hud')")
    assert.equal(await guest("document.querySelector('#target').style.transform"), committed.inline)
    assert.equal(await guest("window.__fullForceEditBeta.getState().history.length"), 1)

    await js("document.querySelector('[aria-label=\"Reset Free Transform\"]').click()")
    await until("!document.querySelector('[aria-label=\"Reset Free Transform\"]')")
    assert.equal(await guest("document.querySelector('#target').style.transform"), before.inline)
    assert.equal(await guest("getComputedStyle(document.querySelector('#target')).transform"), before.computed)
    assert.equal(await guest("window.__fullForceEditBeta.getState().history.length"), 2)
    await guest("window.__fullForceEditBeta.undo()")
    assert.equal(await guest("document.querySelector('#target').style.transform"), committed.inline)
    await guest("window.__fullForceEditBeta.redo()")
    assert.equal(await guest("document.querySelector('#target').style.transform"), before.inline)

    // Replaying the viewport patch reproduces the transform after a document-style reset.
    await guest(`window.__fullForceEditBeta.revertAll(); window.__fullForceEditBeta.applyPatches(${JSON.stringify(committedPatches)}); window.__fullForceEditBeta.selectPath('#target')`)
    assert.equal(await guest("document.querySelector('#target').style.transform"), committed.inline)
    assert.equal(await guest("window.__fullForceEditBeta.getState().selected.freeTransform.hasReset"), true)
    await guest("window.__fullForceEditBeta.resetFreeTransform()")

    await guest("window.__freeTransformSelect('#inline')")
    await until("document.querySelector('.edit-beta-selection-toolbar strong')?.textContent === 'span'")
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Alt',altKey:true,bubbles:true}))")
    await until("document.querySelector('.edit-beta-free-transform-hint')?.textContent === 'Unavailable'")
    assert.equal(await js("document.querySelector('.edit-beta-anchor').getAttribute('aria-disabled')"), 'true')
    assert.match(await js("document.querySelector('.edit-beta-anchor').title"), /inline-block|block element/i)

    const stale = await guest("window.__fullForceEditBeta.previewFreeTransform(999, 'stale-document', '#target', {translateX:10,translateY:10,scaleX:1,scaleY:1})")
    assert.equal(stale, null)
    console.log('PASS: Alt Free Transform visuals, translation, locked gestures, HUD, cancellation, history, reset, layout preservation, unsupported targets, and stale-operation rejection')
  } finally {
    window.destroy()
    app.quit()
  }
}

(process.argv.includes('--smoke') ? smoke() : driver()).catch(error => {
  console.error(error)
  process.exitCode = 1
  if (process.argv.includes('--smoke')) require('electron').app.exit(1)
})
