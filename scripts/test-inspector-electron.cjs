/* Deterministic Chromium DOM/CSS integration gate. No network, profile, or
 * project data is used; all pages and artifacts live in a temporary folder. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-inspector-smoke-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(directory, 'node_modules'), 'junction')
  await build({
    entryPoints: [path.join(__dirname, 'fixtures/inspector-integration.ts')],
    outfile: path.join(directory, 'inspector.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'sharp'],
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90_000)
  child.once('exit', code => {
    clearTimeout(timer)
    console.log('Inspector smoke artifacts:', directory)
    process.exitCode = code === 0 ? 0 : 1
  })
}

const fixture = `<!doctype html><html><head><style>
* { box-sizing: border-box; }
h1 { font-size: 28px; margin: 3px; color: blue; }
.cs-hero h1, .other h1 { font-size: 60px !important; color: rgb(220, 20, 60); margin: 10px; }
@media (min-width: 500px) { .cs-hero h1 { letter-spacing: 2px; } }
#duplicate-me:hover { color: rgb(0, 128, 0); }
</style></head><body>
<section class="cs-hero"><div class="cs-hero__content"><h1>Weight <span>Calculator</span></h1></div></section>
<section class="cs-hero"><h1>Second heading</h1></section>
<div class="one two three four five six many" data-long="preserved"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></div>
<p id="dom-edit">Original</p><p id="delete-me">Delete me</p><p id="duplicate-me">Duplicate me</p>
<div id="shadow-host"></div><iframe srcdoc="<p class='inside-frame'>frame</p>"></iframe>
<script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<style>.shadow-target{color:green}</style><span class="shadow-target">shadow</span>'</script>
</body></html>`

async function smoke() {
  const { app, BrowserWindow } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const api = require(path.join(directory, 'inspector.cjs'))
  api.registerInspectorHandlers()
  const options = { width: 800, height: 600, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } }
  const inspected = new BrowserWindow(options)
  const untouched = new BrowserWindow(options)
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(fixture)
  try {
    await Promise.all([inspected.loadURL(url), untouched.loadURL(url)])
    const invoke = (channel, ...args) => inspected.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
    const invokeUntouched = (channel, ...args) => untouched.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
    await assert.rejects(invokeUntouched('inspector:start', { webContentsId: inspected.webContents.id, previewId: 'foreign' }), /another window/i)
    let session = await invoke('inspector:start', { webContentsId: inspected.webContents.id, previewId: 'desktop' })
    assert.equal(session.status, 'ready')

    // The Edit bridge mutates its selection UI as the renderer resolves an
    // ID selector. A concurrent DOM refresh must not invalidate the node ID
    // returned by Chromium for that click.
    for (let attempt = 0; attempt < 12; attempt++) {
      const [idNode] = await Promise.all([
        invoke('inspector:resolve-selector', session.sessionId, session.generation, '#dom-edit'),
        invoke('inspector:reconnect', session.sessionId),
      ])
      assert.equal(idNode.attributes.find(attribute => attribute.name === 'id').value, 'dom-edit')
    }

    const heading = await invoke('inspector:resolve-selector', session.sessionId, session.generation, '.cs-hero h1')
    assert.equal(heading.localName, 'h1')
    assert.equal(heading.attributes.some(attribute => attribute.name === 'class'), false, 'Layers must not invent selector classes')
    assert.ok(heading.ancestors.some(node => node.attributes.some(attribute => attribute.value === 'cs-hero')))

    let styles = await invoke('inspector:styles', heading.ref)
    const heroRule = styles.rules.find(rule => rule.selectorText.includes('.cs-hero h1'))
    const genericRule = styles.rules.find(rule => rule.selectorText === 'h1')
    assert.ok(heroRule)
    assert.deepEqual(heroRule.selectors.map(selector => selector.matches), [true, false])
    assert.equal(heroRule.declarations.find(item => item.name === 'font-size').state, 'active')
    assert.equal(genericRule.declarations.find(item => item.name === 'font-size').state, 'overridden')
    assert.ok(styles.rules.some(rule => rule.contexts.some(context => context.startsWith('@media')) && rule.conditionActive))

    await invoke('inspector:edit-selector', { sessionId: session.sessionId, generation: session.generation, nodeId: heading.ref.nodeId, ruleId: heroRule.id, selector: '.other h1', revision: styles.revision })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '28px')
    await invoke('inspector:undo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '60px')
    styles = await invoke('inspector:styles', heading.ref)

    const many = await invoke('inspector:resolve-selector', session.sessionId, session.generation, '.many')
    assert.equal(many.attributes.find(attribute => attribute.name === 'class').value, 'one two three four five six many')
    const search = await invoke('inspector:search', session.sessionId, session.generation, '.shadow-target', 'selector', 0)
    assert.ok(search.nodes.some(node => node.localName === 'span' && node.attributes.some(attribute => attribute.value === 'shadow-target')), 'author shadow DOM should be searchable')
    const iframe = await invoke('inspector:resolve-selector', session.sessionId, session.generation, 'iframe')
    assert.equal(iframe.isFrameBoundary, true)

    const restoredHeroRule = styles.rules.find(rule => rule.selectorText.includes('.cs-hero h1'))
    const font = restoredHeroRule.declarations.find(item => item.name === 'font-size')
    const draftHistoryLength = (await invoke('inspector:history', session.sessionId)).entries.length
    const draftBase = { sessionId: session.sessionId, generation: session.generation, nodeId: heading.ref.nodeId, ruleId: restoredHeroRule.id, declarationId: font.id, name: 'font-size', important: true, revision: styles.revision, draftId: 'font-size-live-draft' }
    await assert.rejects(invoke('inspector:edit-declaration', { ...draftBase, value: 'definitely-not-a-size', phase: 'preview' }), /not a valid CSS declaration/i)
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '60px')
    await invoke('inspector:edit-declaration', { ...draftBase, value: '66px', phase: 'preview' })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '66px', 'valid drafts should preview before commit')
    assert.equal((await invoke('inspector:history', session.sessionId)).entries.length, draftHistoryLength, 'a draft must not create undo entries')
    styles = await invoke('inspector:edit-declaration', { ...draftBase, value: '66px', phase: 'cancel' })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '60px', 'Escape-style cancellation should restore source')
    const committedDraft = { ...draftBase, revision: styles.revision, draftId: 'font-size-commit-draft' }
    await invoke('inspector:edit-declaration', { ...committedDraft, value: '68px', phase: 'preview' })
    styles = await invoke('inspector:edit-declaration', { ...committedDraft, value: '68px', phase: 'commit' })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '68px')
    assert.equal((await invoke('inspector:history', session.sessionId)).entries.length, 1, 'one committed draft should create one undo entry')

    const postDraftRule = styles.rules.find(rule => rule.selectorText.includes('.cs-hero h1'))
    const postDraftFont = postDraftRule.declarations.find(item => item.name === 'font-size')
    styles = await invoke('inspector:edit-declaration', { sessionId: session.sessionId, generation: session.generation, nodeId: heading.ref.nodeId, ruleId: postDraftRule.id, declarationId: postDraftFont.id, name: 'font-size', value: '72px', important: true, revision: styles.revision })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelectorAll('.cs-hero h1')[0]).fontSize"), '72px')
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelectorAll('.cs-hero h1')[1]).fontSize"), '72px')
    assert.equal(await untouched.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '60px', 'another preview must not be mutated')

    let currentRule = styles.rules.find(rule => rule.selectorText.includes('.cs-hero h1'))
    let currentFont = currentRule.declarations.find(item => item.name === 'font-size')
    styles = await invoke('inspector:edit-declaration', { sessionId: session.sessionId, generation: session.generation, nodeId: heading.ref.nodeId, ruleId: currentRule.id, declarationId: currentFont.id, name: 'font-size', value: '72px', important: true, disabled: true, revision: styles.revision })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '28px')
    currentRule = styles.rules.find(rule => rule.selectorText.includes('.cs-hero h1'))
    currentFont = currentRule.declarations.find(item => item.name === 'font-size' && item.state === 'disabled')
    assert.ok(currentFont, 'disabled declaration must remain visible')
    styles = await invoke('inspector:edit-declaration', { sessionId: session.sessionId, generation: session.generation, nodeId: heading.ref.nodeId, ruleId: currentRule.id, declarationId: currentFont.id, name: 'font-size', value: '72px', important: true, disabled: false, revision: styles.revision })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '72px')

    const history = await invoke('inspector:history', session.sessionId)
    assert.equal(history.entries.length, 4)
    await invoke('inspector:undo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '28px')
    await invoke('inspector:redo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '72px')

    styles = await invoke('inspector:styles', heading.ref)
    currentRule = styles.rules.find(rule => rule.selectorText.includes('.cs-hero h1'))
    const color = currentRule.declarations.find(item => item.name === 'color')
    styles = await invoke('inspector:edit-declaration', { sessionId: session.sessionId, generation: session.generation, nodeId: heading.ref.nodeId, ruleId: currentRule.id, declarationId: color.id, name: 'color', value: color.value, remove: true, revision: styles.revision })
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).color"), 'rgb(0, 0, 255)')
    assert.equal((await invoke('inspector:history', session.sessionId)).entries.length, 5)
    await invoke('inspector:undo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).color"), 'rgb(220, 20, 60)')
    await invoke('inspector:redo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).color"), 'rgb(0, 0, 255)')

    const domEdit = await invoke('inspector:resolve-selector', session.sessionId, session.generation, '#dom-edit')
    const replaced = await invoke('inspector:edit-dom', { sessionId: session.sessionId, generation: session.generation, nodeId: domEdit.ref.nodeId, kind: 'set-outer-html', value: '<p id="dom-edit" class="changed">Changed</p>' })
    assert.ok(replaced?.ref.nodeId && replaced.ref.nodeId !== domEdit.ref.nodeId)
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelector('#dom-edit').textContent"), 'Changed')
    await invoke('inspector:undo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelector('#dom-edit').textContent"), 'Original')
    await invoke('inspector:redo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelector('#dom-edit').textContent"), 'Changed')

    const deleted = await invoke('inspector:resolve-selector', session.sessionId, session.generation, '#delete-me')
    await invoke('inspector:edit-dom', { sessionId: session.sessionId, generation: session.generation, nodeId: deleted.ref.nodeId, kind: 'remove-node' })
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelector('#delete-me')"), null)
    await invoke('inspector:undo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelector('#delete-me').textContent"), 'Delete me')

    const duplicate = await invoke('inspector:resolve-selector', session.sessionId, session.generation, '#duplicate-me')
    const clone = await invoke('inspector:edit-dom', { sessionId: session.sessionId, generation: session.generation, nodeId: duplicate.ref.nodeId, kind: 'duplicate-node' })
    assert.ok(clone?.ref.nodeId)
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelectorAll('#duplicate-me').length"), 2)
    await invoke('inspector:undo', session.sessionId)
    assert.equal(await inspected.webContents.executeJavaScript("document.querySelectorAll('#duplicate-me').length"), 1)
    const pseudo = await invoke('inspector:force-pseudo', duplicate.ref, ['hover'])
    assert.ok(pseudo.forcedPseudoStates.includes('hover'))
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('#duplicate-me')).color"), 'rgb(0, 128, 0)')
    await invoke('inspector:undo', session.sessionId)
    assert.notEqual(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('#duplicate-me')).color"), 'rgb(0, 128, 0)')
    await invoke('inspector:layout-overlay', duplicate.ref, 'none')

    const withNewRule = await invoke('inspector:add-rule', heading.ref, '.cs-hero h1')
    assert.ok(withNewRule.rules.some(rule => rule.parityInjected), 'new rules should be labeled as Parity inspector styles')
    await invoke('inspector:undo', session.sessionId)

    const capture = await api.captureAutomatePage(inspected.webContents.id, 800, 600)
    assert.equal(capture.success, true)
    styles = await invoke('inspector:styles', heading.ref)
    assert.equal(styles.layout.display, 'block', 'inspector must resume after capture')

    inspected.webContents.debugger.detach()
    await new Promise(resolve => setTimeout(resolve, 30))
    await assert.rejects(invoke('inspector:styles', heading.ref), /disconnected/i)
    session = await invoke('inspector:reconnect', session.sessionId)
    assert.equal(session.status, 'ready')

    await inspected.reload()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await inspected.webContents.executeJavaScript("getComputedStyle(document.querySelector('.cs-hero h1')).fontSize"), '60px', 'reload must clear temporary CSS edits')
    await assert.rejects(invoke('inspector:styles', heading.ref), /page changed/i)
    await invoke('inspector:stop', session.sessionId)
    console.log('PASS: concurrent ID selection, classless Layers node, matched grouped rules, cascade state, live declaration drafts, full classes, shadow search, iframe boundary, active-preview rule editing, history, capture coexistence, debugger reconnect, stale-node rejection, and reload cleanup.')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    if (!inspected.isDestroyed()) inspected.destroy()
    if (!untouched.isDestroyed()) untouched.destroy()
  }
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
