/* Real Electron capture of a local fixture page (sticky + fixed elements, fixed background,
 * reveal-on-scroll, lazy and broken images, growth while scrolling, horizontal overflow).
 * No external site, account or user profile is touched.
 *
 *   npm run test:qa-capture:electron
 *   node scripts/test-qa-capture-electron.cjs --url <page> --width 1440 --bp desktop --out <dir>
 *       captures any public page instead and writes capture.png + capture.json to <dir>. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-qa-capture-'))
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(dir, 'node_modules'), 'junction')
  await build({ entryPoints: [path.join(__dirname, '../src/main/qaAgent/liveCapture.ts')], outfile: path.join(dir, 'capture.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 240000)
  child.once('exit', code => { clearTimeout(timer); console.log('QA capture artifacts:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }

async function smoke() {
  const { app } = require('electron'), http = require('node:http'), sharp = require('sharp')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  // The capture window is the only window here; keep the process alive when it closes.
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(dir, 'profile')); await app.whenReady()
  const { captureLivePage } = require(path.join(dir, 'capture.cjs'))

  const external = arg('--url')
  if (external) {
    const out = arg('--out', dir); fs.mkdirSync(out, { recursive: true })
    const result = await captureLivePage({ url: external, breakpoint: arg('--bp', 'desktop'), width: Number(arg('--width', '1440')), onProgress: m => console.log(' ', m) })
    fs.writeFileSync(path.join(out, 'capture.png'), result.png)
    const { png, nodes, ...rest } = result
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ ...rest, nodeCount: nodes.length, nodes: nodes.slice(0, 400) }, null, 1))
    console.log(JSON.stringify({ ...rest, sections: rest.sections.map(s => `${s.id} ${s.top}+${s.height} ${s.label}`), nodeCount: nodes.length }, null, 1))
    return app.exit(0)
  }

  const lazy = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#990099' } }).png().toBuffer()
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/qa-capture/index.html'))
  const server = http.createServer((req, res) => {
    if (req.url === '/lazy.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(lazy) }
    if (req.url === '/missing.png') { res.writeHead(404); return res.end() }
    if (req.url === '/redirect-to-login') { res.writeHead(302, { Location: '/wp-login.php' }); return res.end() }
    if (req.url.startsWith('/wp-login.php')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>Log in</title>login') }
    if (req.url === '/no-meta') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html.toString().replace(/<meta name="viewport"[^>]*>/, '')) }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const near = (actual, expected, tolerance = 14) => actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance)
  const reader = async png => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    return { info, at: (x, y) => { const o = (y * info.width + x) * info.channels; return [data[o], data[o + 1], data[o + 2]] } }
  }
  const nodeWithText = (result, tag, text) => result.nodes.find(n => n.tag === tag && n.text === text)
  const hasWarning = (result, fragment) => result.warnings.some(w => w.includes(fragment))

  async function checkDesktopImage(result, label) {
    const { info, at } = await reader(result.png)
    const H = info.height
    assert.equal(info.width, 1440, `${label}: width`)
    assert.equal(H, result.capturedHeight, `${label}: image height matches capturedHeight`)
    assert.ok(H > 3000, `${label}: full page height (${H})`)
    assert.ok(near(at(700, 40), [204, 0, 0]), `${label}: sticky header painted at the top`)
    for (let y = 120; y < H; y += 4) assert.ok(!near(at(700, y), [204, 0, 0], 20), `${label}: sticky header repeated at y=${y}`)
    assert.ok(near(at(1410, 130), [0, 0, 255]), `${label}: fixed top nav painted in the first screen`)
    for (let y = 200; y < H; y += 4) assert.ok(!near(at(1410, y), [0, 0, 255], 20), `${label}: fixed nav repeated at y=${y}`)
    assert.ok(near(at(50, H - 30), [0, 170, 0]), `${label}: bottom-fixed widget painted in the last screen`)
    for (let y = 0; y < H - 60; y += 4) assert.ok(!near(at(50, y), [0, 170, 0], 20), `${label}: bottom widget repeated at y=${y}`)
    assert.ok(near(at(1000, 300), [34, 51, 68]), `${label}: full-screen overlay was hidden`)
    const aos = nodeWithText(result, 'div', 'AOS content'); assert.ok(aos, `${label}: AOS node found`)
    assert.ok(near(at(aos.rect.x + aos.rect.width - 30, aos.rect.y + aos.rect.height - 30), [255, 153, 0]), `${label}: revealed block painted`)
    const lazyNode = result.nodes.find(n => n.tag === 'img' && (n.src || '').endsWith('/lazy.png')); assert.ok(lazyNode, `${label}: lazy image resolved`)
    assert.ok(near(at(lazyNode.rect.x + 200, lazyNode.rect.y + 100), [153, 0, 153]), `${label}: lazy image painted`)
    const fixedBg = result.sections.find(s => s.label === 'Fixed background section'); assert.ok(fixedBg, `${label}: fixed-background section found`)
    assert.ok(near(at(700, fixedBg.top + Math.round(fixedBg.height / 2)), [51, 102, 153]), `${label}: fixed-background section painted`)
  }

  // 1. Desktop, DevTools screenshots
  const desktop = await captureLivePage({ url: base + '/', breakpoint: 'desktop', width: 1440, onProgress: m => console.log(' ', m) })
  await checkDesktopImage(desktop, 'desktop')
  assert.equal(desktop.mode, 'cdp', 'desktop uses DevTools screenshots')
  assert.equal(desktop.viewportHeight, 1024)
  assert.ok(desktop.sections.length >= 6, `sections found: ${desktop.sections.length}`)
  for (const label of ['Hero heading', 'Reveal section', 'Fixed background section', 'Images section', 'Overflow section', 'Closing section']) {
    assert.ok(desktop.sections.some(s => s.label === label), `section label: ${label}`)
  }
  const heading = nodeWithText(desktop, 'h2', 'Reveal section')
  assert.equal(heading.styles.fontSize, '32px'); assert.equal(heading.styles.padding, '0 0 8 0')
  assert.equal(heading.sectionId, desktop.sections.find(s => s.label === 'Reveal section').id)
  assert.ok(hasWarning(desktop, 'overflows the page horizontally') || hasWarning(desktop, 'overflow'), 'horizontal overflow warned')
  assert.ok(hasWarning(desktop, '#wide') || hasWarning(desktop, 'wide'), 'overflow culprit named')
  assert.ok(hasWarning(desktop, 'did not load'), 'broken image warned')
  assert.ok(hasWarning(desktop, 'height changed'), 'growth while scrolling warned, not thrown')
  assert.ok(hasWarning(desktop, 'full-screen overlay'), 'overlay hidden warning')
  assert.equal(desktop.truncated, false)

  // 2. Same page through the capturePage fallback
  const fallback = await captureLivePage({ url: base + '/', breakpoint: 'desktop', width: 1440, forceFallback: true })
  await checkDesktopImage(fallback, 'fallback')
  assert.equal(fallback.mode, 'capturePage')
  assert.ok(Math.abs(fallback.capturedHeight - desktop.capturedHeight) <= 2, 'fallback height matches DevTools height')

  // 3. Mobile and tablet identities
  const mobile = await captureLivePage({ url: base + '/', breakpoint: 'mobile', width: 390 })
  assert.equal(mobile.width, 390); assert.equal(mobile.viewportHeight, 844)
  const mobileEnv = mobile.nodes.find(n => n.tag === 'p' && n.text.includes('hover:')); assert.ok(mobileEnv, 'mobile env text found')
  assert.match(mobileEnv.text, /iPhone/); assert.match(mobileEnv.text, /hover:true/)
  // The page's own script read innerWidth at load time (before the fixed-viewport switch), so check the final layout instead.
  const mobileHeading = nodeWithText(mobile, 'h2', 'Reveal section'); assert.ok(mobileHeading, 'mobile heading found')
  assert.ok(mobileHeading.rect.width >= 300 && mobileHeading.rect.width <= 320, `mobile layout is 390px wide (heading is ${mobileHeading.rect.width}px)`)
  assert.equal((await sharp(mobile.png).metadata()).width, 390)
  console.log('  mobile warnings:', JSON.stringify(mobile.warnings))
  assert.ok(hasWarning(mobile, 'fixed 390px viewport'), 'mobile zoom-out on overflowing content was detected and pinned')
  assert.ok(!hasWarning(mobile, 'landed at'), 'every mobile screen landed where planned')
  assert.ok(!hasWarning(mobile, 'repeated the previous'), 'no repeated mobile screens')
  assert.ok(hasWarning(mobile, 'overflows the page horizontally'), 'mobile overflow still reported')
  // A page without a viewport meta tag gets a desktop-width layout under phone emulation; the capture must pin it to 390px.
  const noMeta = await captureLivePage({ url: base + '/no-meta', breakpoint: 'mobile', width: 390 })
  console.log('  no-meta warnings:', JSON.stringify(noMeta.warnings))
  assert.ok(hasWarning(noMeta, 'fixed 390px viewport'), 'missing viewport meta detected and pinned to the design width')
  const noMetaHeading = nodeWithText(noMeta, 'h2', 'Reveal section'); assert.ok(noMetaHeading, 'no-meta heading found')
  assert.ok(noMetaHeading.rect.width >= 300 && noMetaHeading.rect.width <= 320, `no-meta layout is 390px wide (heading is ${noMetaHeading.rect.width}px)`)
  assert.equal((await sharp(noMeta.png).metadata()).width, 390)
  const tablet = await captureLivePage({ url: base + '/', breakpoint: 'tablet', width: 834 })
  const tabletEnv = tablet.nodes.find(n => n.tag === 'p' && n.text.includes('hover:')); assert.ok(tabletEnv, 'tablet env text found')
  assert.match(tabletEnv.text, /Macintosh/); assert.doesNotMatch(tabletEnv.text, /Mobile/)
  const tabletHeading = nodeWithText(tablet, 'h2', 'Reveal section'); assert.ok(tabletHeading, 'tablet heading found')
  assert.ok(tabletHeading.rect.width >= 744 && tabletHeading.rect.width <= 764, `tablet layout is 834px wide (heading is ${tabletHeading.rect.width}px)`)
  assert.ok(!hasWarning(tablet, 'landed at'), 'every tablet screen landed where planned')

  // 4. Refusals and single-flight
  await assert.rejects(captureLivePage({ url: base + '/wp-admin/options.php', breakpoint: 'desktop', width: 1440 }), /admin/i)
  await assert.rejects(captureLivePage({ url: base + '/redirect-to-login', breakpoint: 'desktop', width: 1440 }), /WordPress login/)
  await assert.rejects(captureLivePage({ url: base + '/', breakpoint: 'desktop', width: 100 }), /width/i)
  const first = captureLivePage({ url: base + '/', breakpoint: 'desktop', width: 1440 })
  await assert.rejects(captureLivePage({ url: base + '/', breakpoint: 'desktop', width: 1440 }), /still running/)
  await first

  fs.writeFileSync(path.join(dir, 'desktop.png'), desktop.png); fs.writeFileSync(path.join(dir, 'mobile.png'), mobile.png)
  console.log(`QA capture smoke passed: desktop ${desktop.width}x${desktop.capturedHeight} in ${desktop.tiles} screens (${desktop.mode}); mobile ${mobile.width}x${mobile.capturedHeight}; tablet ${tablet.width}x${tablet.capturedHeight}`)
  server.close(); app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
