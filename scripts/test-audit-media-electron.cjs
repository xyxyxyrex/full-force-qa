const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

async function driver() {
  const { build } = require('esbuild')
  const { spawn } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-audit-media-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(directory, 'node_modules'), 'junction')
  await build({ entryPoints: [path.join(__dirname, '../src/main/auditExport.ts')], outfile: path.join(directory, 'audit.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  await build({ entryPoints: [path.join(__dirname, 'fixtures/audit-media-gallery.tsx')], outfile: path.join(directory, 'ui.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(directory, 'ui.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;background:#201d29;color:#eee}</style></head><body><div id="root"></div><script>const ipc=require('electron').ipcRenderer;window.electronAPI={previewAuditMedia:r=>ipc.invoke('audit-media:preview',r),saveAuditMedia:r=>ipc.invoke('audit-media:save',r),revealAuditMediaFile:p=>ipc.invoke('audit-media:reveal',p),scanAuditExport:r=>ipc.invoke('audit-export:scan',r),startAuditExport:id=>ipc.invoke('audit-export:start',id),openExternal:()=>Promise.resolve()}</script><script src="ui.js"></script></body></html>`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', directory], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 90000)
  child.once('exit', code => { clearTimeout(timer); console.log('Audit media artifacts:', directory); process.exitCode = code === 0 ? 0 : 1 })
}

function wave() {
  const rate = 8000, samples = rate / 4
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 12000), 44 + index * 2)
  return buffer
}

async function smoke() {
  const { app, BrowserWindow, dialog } = require('electron')
  const directory = process.argv[process.argv.indexOf('--smoke') + 1]
  app.setPath('userData', path.join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const image = fs.readFileSync(path.join(__dirname, '../src/renderer/src/assets/parity-180.png'))
  const audio = wave()
  const assets = new Map([['/photo.png', { bytes: image, type: 'image/png' }], ['/sound.wav', { bytes: audio, type: 'audio/wav' }], ['/clip.mp4', { bytes: Buffer.from('not a playable video'), type: 'video/mp4' }]])
  const receivedRequests = []
  const server = http.createServer((request, response) => {
    receivedRequests.push({ path: request.url, referer: request.headers.referer })
    const asset = assets.get(request.url)
    if (!asset) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length })
    response.end(request.method === 'HEAD' ? undefined : asset.bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const savedFile = path.join(directory, 'saved-photo.png')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedFile })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  require(path.join(directory, 'audit.cjs')).registerAuditExportHandlers()
  const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } })
  const js = expression => window.webContents.executeJavaScript(expression)
  const until = async expression => {
    for (let attempt = 0; attempt < 150; attempt++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw new Error(`Timeout: ${expression}`)
  }
  try {
    await window.loadFile(path.join(directory, 'ui.html'), { query: { base } })
    await until("document.querySelectorAll('.audit-media-tile').length===4")
    await until("document.querySelector('.audit-media-preview img')?.src.startsWith('data:image/png;base64,')")
    assert.equal(await js("document.querySelector('.audit-media-preview img').naturalWidth>0"), true)
    const securePagePreview = await js(`window.electronAPI.previewAuditMedia({resource:{url:${JSON.stringify(`${base}/photo.png`)},kind:'image',source:'img[src]'},refererUrl:'https://127.0.0.1/private-page'})`)
    assert.equal(securePagePreview.mimeType, 'image/png')
    assert.equal(securePagePreview.bytes, image.length)
    assert.equal(receivedRequests.at(-1).referer, undefined)
    const downgradedSavePath = path.join(directory, 'saved-http-from-https.png')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: downgradedSavePath })
    const downgradedSave = await js(`window.electronAPI.saveAuditMedia({resource:{url:${JSON.stringify(`${base}/photo.png`)},kind:'image',source:'img[src]'},refererUrl:'https://127.0.0.1/private-page'})`)
    assert.equal(downgradedSave.filePath, downgradedSavePath)
    assert.deepEqual(fs.readFileSync(downgradedSavePath), image)
    assert.equal(receivedRequests.at(-1).referer, undefined)
    assert.equal(await js("document.querySelectorAll('.audit-media-usage').length"), 2)
    await js("document.querySelector('.audit-media-usage button').click()")
    assert.equal(await js("window.__located"), 'main img')
    await js("Array.from(document.querySelectorAll('.audit-media-filters button')).find(button=>button.textContent.startsWith('Audio')).click()")
    await until("document.querySelector('.audit-media-preview audio')?.readyState>=1")
    assert.equal(await js("document.querySelector('.audit-media-preview audio').duration>0"), true)
    await js("Array.from(document.querySelectorAll('.audit-media-filters button')).find(button=>button.textContent.startsWith('SVGs')).click()")
    await until("document.querySelector('.audit-media-preview img')?.naturalWidth===100")
    const svgPath = path.join(directory, 'saved-inline.svg')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: svgPath })
    await js("Array.from(document.querySelectorAll('.audit-media-actions button')).find(button=>button.textContent==='Download').click()")
    await until("!!document.querySelector('.audit-media-reveal')")
    assert.match(fs.readFileSync(svgPath, 'utf8'), /<circle/)
    await js("Array.from(document.querySelectorAll('.audit-media-filters button')).find(button=>button.textContent.startsWith('Videos')).click()")
    await until("!!document.querySelector('.audit-media-preview video[controls]')")
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedFile })
    await js("Array.from(document.querySelectorAll('.audit-media-filters button')).find(button=>button.textContent.startsWith('Images')).click()")
    await until("document.querySelector('.audit-media-preview img')?.naturalWidth>0")
    await js("Array.from(document.querySelectorAll('.audit-media-actions button')).find(button=>button.textContent==='Download').click()")
    await until("!!document.querySelector('.audit-media-reveal')")
    assert.deepEqual(fs.readFileSync(savedFile), image)
    const beforeDrag = await js("Number.parseFloat(document.querySelector('.audit-media-dialog').style.left)")
    await js("(() => { const header=document.querySelector('.audit-media-header'); header.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:200,clientY:100})); window.dispatchEvent(new PointerEvent('pointermove',{clientX:250,clientY:125})); window.dispatchEvent(new PointerEvent('pointerup',{clientX:250,clientY:125})); })()")
    await until(`Number.parseFloat(document.querySelector('.audit-media-dialog').style.left)>${beforeDrag}`)
    fs.writeFileSync(path.join(directory, 'gallery.png'), (await window.capturePage()).toPNG())
    await js("Array.from(document.querySelectorAll('.audit-media-header-actions button')).find(button=>button.textContent==='Export all').click()")
    await until("!!window.__bulkResult||!!window.__bulkError")
    assert.equal(await js("window.__bulkError||''"), '')
    const result = await js('window.__bulkResult')
    assert.equal(result.success, true)
    const exported = JSON.parse(fs.readFileSync(path.join(result.folderPath, 'resources.json'), 'utf8'))
    assert.equal(exported.length, 4)
    console.log('PASS: gallery preview, audio playback metadata, video controls, SVG, source locations, drag, individual save, and media-only export.')
  } finally { window.destroy(); await new Promise(resolve => server.close(resolve)); app.quit() }
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); process.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
