/* Read-only local integration check. Uses hidden Electron windows and temporary
 * bundles; no Figma credentials, user profile, website edits, or deployment. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

async function driver() {
  const {build} = require('esbuild')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'parity-automation-smoke-'))
  // Electron intentionally ignores NODE_PATH. A test-local junction resolves
  // dependencies without putting fixtures inside installer-packaged out/**/*.
  fs.symlinkSync(path.join(__dirname,'../node_modules'),path.join(directory,'node_modules'),'junction')
  for (const entry of ['capture','runComparison']) {
    await build({entryPoints:[path.join(__dirname,'../src/main/automation',entry+'.ts')],
      outfile:path.join(directory,entry+'.cjs'),bundle:true,platform:'node',format:'cjs',
      external:['electron','sharp'],nodePaths:[path.join(__dirname,'../node_modules')]})
  }
  fs.copyFileSync(path.join(__dirname,'../out/main/automation-worker.js'),path.join(directory,'automation-worker.js'))
  const asarSource=path.join(directory,'asar-source')
  fs.mkdirSync(path.join(asarSource,'main'),{recursive:true})
  fs.copyFileSync(path.join(directory,'automation-worker.js'),path.join(asarSource,'main','automation-worker.js'))
  fs.copyFileSync(path.join(directory,'runComparison.cjs'),path.join(asarSource,'main','runComparison.cjs'))
  fs.cpSync(path.dirname(require.resolve('pngjs/package.json')),path.join(asarSource,'node_modules','pngjs'),{recursive:true})
  await require('@electron/asar').createPackage(asarSource,path.join(directory,'automation.asar'))
  await build({entryPoints:[path.join(__dirname,'fixtures/automation-ui.tsx')],outfile:path.join(directory,'ui.js'),
    bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
  const {spawn} = require('node:child_process')
  const env = {...process.env, NODE_PATH:path.join(__dirname,'../node_modules')}
  delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(require('electron'),[__filename,'--electron-smoke',directory],{env,windowsHide:true,stdio:'inherit'})
  const timeout=setTimeout(()=>{child.kill();process.exitCode=1},120000)
  child.once('exit',code=>{
    clearTimeout(timeout)
    // Keep test artifacts for inspection; never delete a computed directory.
    console.log('Automation smoke artifacts:',directory)
    process.exitCode=code === 0 ? 0 : 1
  })
}

async function electronSmoke() {
  const {app,BrowserWindow} = require('electron')
  const directory=process.argv[process.argv.indexOf('--electron-smoke')+1]
  app.setPath('userData',path.join(directory,'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const {captureAutomatePage}=require(path.join(directory,'capture.cjs'))
  const {runPixelComparison,cancelPixelComparison}=require(path.join(directory,'runComparison.cjs'))
  const window=new BrowserWindow({width:800,height:1200,useContentSize:true,show:false,
    webPreferences:{backgroundThrottling:false,offscreen:true}})
  try {
    const html='<!doctype html><style>html,body{margin:0;width:100%;}body{height:3200px;background:linear-gradient(white,#9ac8dd)}.target{position:absolute;left:80px;top:1800px;width:200px;height:40px;background:black;color:white;font:20px Arial}header{position:fixed;top:0;height:30px;background:#eee;width:100%}</style><header>Fixed header</header><p class="target">Stable capture target</p><p style="position:absolute;top:2900px">Footer text</p>'
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html))
    const first=await captureAutomatePage(window.webContents.id,800,1200)
    assert.equal(first.documentWidth,800)
    assert.equal(first.documentHeight,3200)
    const initial=first.domNodes.find(n=>n.text==='Stable capture target')
    assert.ok(initial)
    assert.equal(initial.rect.y,1820) // default paragraph margin is 1em
    const repeated=await captureAutomatePage(window.webContents.id,800,1200)
    const identical=await runPixelComparison('same',first.dataUrl,repeated.dataUrl)
    assert.equal(identical.success,true,identical.error)
    assert.equal(identical.result.changedPixels,0)
    await window.webContents.executeJavaScript("document.querySelector('.target').style.transform='translateY(8px)'")
    const shifted=await captureAutomatePage(window.webContents.id,800,1200)
    assert.equal(shifted.domNodes.find(n=>n.text==='Stable capture target').rect.y-initial.rect.y,8)
    const changed=await runPixelComparison('shifted',first.dataUrl,shifted.dataUrl)
    assert.equal(changed.success,true,changed.error)
    assert.ok(changed.result.changedPixels>0)
    assert.equal(changed.result.engine,'pixelmatch')
    assert.equal(changed.result.live.width,800)
    assert.equal(changed.result.live.height,3200)
    const packaged=require(path.join(directory,'automation.asar','main','runComparison.cjs'))
    const archived=await packaged.runPixelComparison('asar',first.dataUrl,shifted.dataUrl)
    assert.equal(archived.success,true,archived.error)
    assert.equal(archived.result.changedPixels,changed.result.changedPixels)
    assert.deepEqual(archived.result.regions,changed.result.regions)
    console.log('PASS: worker and PNGJS execute inside ASAR with identical results.')
    fs.writeFileSync(path.join(directory,'diff.png'),Buffer.from(changed.result.diffDataUrl.split(',')[1],'base64'))
    const cancelled=runPixelComparison('cancel',first.dataUrl,shifted.dataUrl)
    assert.equal(cancelPixelComparison('cancel'),true)
    assert.equal((await cancelled).success,false)
    assert.equal(cancelPixelComparison('cancel'),false)
    const invalid=await runPixelComparison('invalid','data:image/png;base64,invalid',first.dataUrl)
    assert.equal(invalid.success,false)
    await uiSmoke(BrowserWindow,directory,{
      design:first.dataUrl,designRect:initial.rect,capture:shifted,comparison:changed
    })
    await window.webContents.executeJavaScript("document.body.style.width='900px'")
    await assert.rejects(captureAutomatePage(window.webContents.id,800,1200),/Horizontal overflow/)
    assert.equal(await window.webContents.executeJavaScript("!!document.getElementById('__qaAutomateFreeze')"),false)
    console.log('PASS: native 800×1200 viewport / 3200px capture; repeatability; 8px live displacement; bundled worker; cancellation; invalid PNG; explicit overflow failure and cleanup.')
    window.destroy()
    app.exit(0)
  } catch(error) {
    console.error(error)
    window.destroy()
    app.exit(1)
  }
}
async function uiSmoke(BrowserWindow,directory,data) {
  const theme=':root{--bg-app:#15151d;--bg-card:#20202c;--bg-elevated:#303042;--bg-input:#292938;--border-color:#45455e;--text-primary:#ececf4;--text-secondary:#b9b9cc;--text-muted:#9999ad;--accent-color:#c4a2f2;--accent-foreground:#171321;--bg-card-hover:#35354a;--accent-hover:#d4b8fa;--accent-hover-foreground:#171321}body{margin:0}'
  fs.writeFileSync(path.join(directory,'ui.html'),'<!doctype html><html><head><style>'+theme+'</style><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script>window.__automationData='+JSON.stringify(data).replace(/</g,'\\u003c')+'</script><script src="ui.js"></script></body></html>')
  const ui=new BrowserWindow({width:1440,height:1100,useContentSize:true,show:false,
    webPreferences:{offscreen:true,backgroundThrottling:false,webviewTag:true,contextIsolation:false}})
  try {
    await ui.loadFile(path.join(directory,'ui.html'))
    const evaluate=async expression=>{
      try {return await ui.webContents.executeJavaScript(expression)}
      catch(error) {throw new Error(expression+': '+error.message)}
    }
    const waitFor=async expression=>{
      for(let i=0;i<100;i++) {if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100))}
      throw new Error('UI condition timed out: '+expression+'; '+await evaluate('document.body.innerText.slice(-1500)'))
    }
    const click=label=>evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
    await waitFor("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Load frames')")
    await click('Load frames')
    await waitFor("document.querySelector('.automate-frame-select select')?.value==='frame'")
    await new Promise(resolve=>setTimeout(resolve,400))
    await click('Run comparison')
    await waitFor("!!document.querySelector('.automate-native-canvas')")
    assert.ok(await evaluate("document.querySelector('.automate-coverage').textContent.includes('strong mappings')"))
    assert.equal(await evaluate("!!document.querySelector('.automate-score-row')"),false)
    for(const label of ['Design','Live','Diff']) await click(label)
    await click('Slider')
    await waitFor("!!document.querySelector('.automate-slider input')")
    await evaluate("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.automate-slider input'),'25');document.querySelector('.automate-slider input').dispatchEvent(new Event('input',{bubbles:true}))")
    await waitFor("document.querySelector('.automate-slider-line').style.left==='25%'")
    await evaluate("Array.from(document.querySelectorAll('.automate-findings-tabs button')).find(b=>b.textContent.startsWith('Verified differences')).click()")
    await waitFor("Array.from(document.querySelectorAll('.automate-finding-heading button')).some(b=>b.textContent.startsWith('Position:'))")
    await evaluate("Array.from(document.querySelectorAll('.automate-finding-heading button')).find(b=>b.textContent.startsWith('Position:')).click()")
    await waitFor("document.querySelector('.automate-native-stage').scrollTop>1000")
    await evaluate("document.querySelector('article.selected summary').click()")
    await waitFor("document.querySelector('article.selected details').open")
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    assert.ok(await evaluate("document.querySelector('article.selected').innerText.includes('Measured Difference')"))
    fs.writeFileSync(path.join(directory,'ui.png'),(await ui.webContents.capturePage()).toPNG())
    await evaluate("Array.from(document.querySelectorAll('article.selected button')).find(b=>b.textContent==='Ignore').click()")
    await waitFor("document.querySelector('.automate-coverage').textContent.includes('Ignored: 1')")
    await evaluate("document.querySelector('.automate-triage-toggle input').click()")
    await evaluate("Array.from(document.querySelectorAll('.automate-findings-tabs button')).find(b=>b.textContent.startsWith('Ignored')).click()")
    await waitFor("Array.from(document.querySelectorAll('article button')).some(b=>b.textContent==='Restore finding')")
    await evaluate("Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='Restore finding').click()")
    await waitFor("document.querySelector('.automate-coverage').textContent.includes('Ignored: 0')")
    await evaluate("Array.from(document.querySelectorAll('.automate-findings-tabs button')).find(b=>b.textContent.startsWith('Verified differences')).click()")
    await waitFor("!!document.querySelector('article.selected')")
    await evaluate("Array.from(document.querySelectorAll('article.selected button')).find(b=>b.textContent==='Pin annotation').click()")
    assert.equal(await evaluate("window.__pinned.rect.y"),initialY(data)+8)
    console.log('PASS: Automation renderer run, evidence filters, Design/Live/Diff/Slider, slider interaction, finding navigation, ignore/restore, annotation bridge.')
  } finally {ui.destroy()}
}
function initialY(data) {return data.designRect.y}
if(process.argv.includes('--electron-smoke')) electronSmoke().catch(error=>{console.error(error);require('electron').app.exit(1)})
else driver().catch(error=>{console.error(error);process.exitCode=1})
