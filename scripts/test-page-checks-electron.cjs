/* Runs the agent's page checks (src/main/qaAgent/pageCheckTools.ts and pageCheckScripts.ts) in the
 * agent's real browser against a local page with known defects: contrast, layout at desktop and
 * mobile, text styles and a font that never loaded, the copy, SEO (with robots.txt, the sitemap and
 * an X-Robots-Tag header), inspecting elements, and scrolling to one for evidence.
 *
 *   npm run test:page-checks:electron */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http')

async function driver() {
  const { build } = require('esbuild'), { spawn } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-page-checks-'))
  const qa = path.join(__dirname, '..', 'src', 'main', 'qaAgent')
  // Inside the project, so the bundle finds nspell and the dictionary in node_modules.
  const bundle = path.join(__dirname, '..', 'node_modules', '.cache', 'parity-page-checks', 'checks.cjs')
  await build({
    stdin: { contents: `export { createQaBrowser } from './qaBrowser'; export * from './pageCheckScripts'; export { PAGE_CHECK_TOOLS } from './pageCheckTools'`, resolveDir: qa, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp', 'nspell', 'dictionary-en'],
  })
  const env = { ...process.env, PARITY_PAGE_CHECKS_BUNDLE: bundle }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, '--smoke', dir], { env, windowsHide: true, stdio: 'inherit', cwd: path.join(__dirname, '..') })
  const timer = setTimeout(() => child.kill(), 150_000)
  child.once('exit', code => { clearTimeout(timer); console.log('Page check screenshots:', dir); process.exitCode = code === 0 ? 0 : 1 })
}

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#4a7"/></svg>'
const PHOTO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#eee"/></svg>')}`
const REPEATED = 'Our specialists have helped thousands of people regain their confidence.'

function site() {
  const page = (body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>Hair Clinic</title><meta name="robots" content="noindex, nofollow"><link rel="canonical" href="https://live-clinic.example/treatments/">
    <meta property="og:title" content="Treatments"><meta property="og:url" content="https://live-clinic.example/treatments/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Clinic"},{"@type":"WebPage"}]}</script>
    <script type="application/ld+json">{"@type": "FAQPage", </script>
    <style>body{font:16px/1.5 serif;margin:20px;color:#111}h2.big{font-size:36px}h2.small{font-size:28px;font-weight:400}.hero{background:#234 url('${PHOTO}');padding:40px}</style>${head}</head><body>${body}</body></html>`
  const server = http.createServer((req, res) => {
    const send = (status, type, text, headers = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(text) }
    if (req.url === '/treatments/') return send(200, 'text/html', page(`
      <section class="hero"><h1 style="color:#fff">Hair loss treatments</h1></section>
      <div style="position:relative;width:300px"><img src="${PHOTO}" width="300" height="200" alt="Clinic"><span style="position:absolute;top:20px;left:20px;color:#fff">Caption on photo</span></div>
      <h2 class="big">Our clinics</h2><h2 class="small">Questions</h2>
      <p class="faint" style="color:#bbb">Terms and conditions apply to every offer.</p>
      <p style="font-family:'Nonexistent Brand Font', serif">We will recieve your request and call you back within a day.</p>
      <p>Read our <a href="/privacy/">privacy policy</a> before you book the the consultation.</p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      <p>${REPEATED}</p><p>${REPEATED}</p>
      <p style="display:none">Hidden text that nobody sees</p>
      <img id="stretched" src="/square.svg" style="width:300px;height:100px" alt="">
      <img id="blown" src="/square.svg" style="width:400px;height:400px" alt="">
      <div style="width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">This line is far too long for its little box</div>
      <div style="position:relative;height:40px"><span style="position:absolute;top:0;left:0">Our clinics near you</span><span style="position:absolute;top:4px;left:12px">Find us here today</span></div>
      <div class="wide" style="width:600px;background:#fde">Wide promo banner</div>
      <button style="width:16px;height:16px;padding:0;font-size:10px">×</button>
      <small style="font-size:10px">© 2026 Clinic</small>`), { 'X-Robots-Tag': 'noindex' })
    if (req.url === '/square.svg') return send(200, 'image/svg+xml', SQUARE)
    if (req.url === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nDisallow: /\n\nSitemap: http://${req.headers.host}/wp-sitemap.xml\n`)
    if (req.url === '/wp-sitemap.xml') return send(200, 'application/xml', `<?xml version="1.0"?><urlset><url><loc>http://${req.headers.host}/</loc></url><url><loc>http://${req.headers.host}/treatments/</loc></url></urlset>`)
    send(404, 'text/html', page('<h1>404</h1>'))
  })
  return server
}

async function smoke() {
  const { app } = require('electron')
  const dir = process.argv[process.argv.indexOf('--smoke') + 1]
  app.on('window-all-closed', () => {})
  app.setPath('userData', path.join(dir, 'profile')); app.disableHardwareAcceleration(); await app.whenReady()
  const server = site()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const checks = require(process.env.PARITY_PAGE_CHECKS_BUNDLE)
  const browser = checks.createQaBrowser()
  const tool = (name) => checks.PAGE_CHECK_TOOLS.find(t => t.name === name)
  // Each answer is also saved, to read what the agent is told.
  const run = async (name, args = {}) => {
    const result = await tool(name).run(args, { browser })
    assert.ok(!result.isError, `${name} failed: ${result.text}`)
    fs.appendFileSync(path.join(dir, 'answers.txt'), `── ${name} ${JSON.stringify(args)}\n${result.text}\n\n`)
    return result.text
  }
  const open = (breakpoint, width) => browser.open({ url: `${base}/treatments/`, site: base, breakpoint, width, allowSend: false, runId: 'run-1' })

  // ── Desktop ───────────────────────────────────────────────────────────────────────
  let step = await open('desktop', 1440)
  fs.writeFileSync(path.join(dir, 'desktop.jpg'), step.screenshot)
  await browser.scroll(300)

  // Contrast: the faint grey fails; white text on the hero's background image and on a sibling photo is not judged; scroll is put back.
  const contrast = await browser.read(checks.CONTRAST_SCRIPT, 15)
  const faint = contrast.groups.find(g => g.examples.some(e => /Terms and conditions/.test(e)))
  assert.ok(faint, 'the faint grey text fails contrast')
  assert.equal(faint.text, '#bbbbbb'); assert.equal(faint.background, '#ffffff'); assert.ok(faint.ratio > 1.8 && faint.ratio < 2, `ratio ${faint.ratio}`)
  assert.equal(contrast.groups.some(g => g.examples.some(e => /Caption on photo|Hair loss treatments/.test(e))), false, 'text over pictures is not judged as if on white')
  assert.ok(contrast.overImage >= 2, 'text over the hero background and the photo is counted as over an image')
  assert.equal(contrast.groups.some(g => g.examples.some(e => /Hidden text/.test(e))), false)
  assert.equal(await browser.read('() => Math.round(scrollY)'), 300, 'the contrast check put the scroll back')

  // Layout at desktop: no sideways scroll, the images, the cut-off and overlapping text, small text; no tap target check.
  const desk = await browser.read(checks.LAYOUT_SCRIPT, { touch: false })
  assert.equal(desk.scrollsSideways, false)
  assert.ok(desk.images.some(i => i.problems.includes('stretched wide')), 'the stretched image is found')
  assert.ok(desk.images.some(i => i.problems.some(p => /blown up to 400%/.test(p))), 'the blown-up image is found')
  assert.ok(desk.cutOffText.some(c => /far too long/.test(c.text) && c.how === 'ends in …'))
  assert.ok(desk.overlappingText.some(o => o.texts.join(' ').includes('Our clinics near you')), 'overlapping text is found')
  assert.ok(desk.smallText.some(s => s.size === 10))
  assert.equal(desk.smallTapTargets, undefined)

  // Styles: two kinds of H2, and the brand font that never loaded.
  const styles = await browser.read(checks.STYLES_SCRIPT)
  assert.equal(styles.kinds.find(k => k.kind === 'H2').styles.length, 2, 'two H2 styles')
  const brand = styles.families.find(f => f.family === 'Nonexistent Brand Font')
  assert.ok(brand && brand.renders === false, 'a font that is not available is reported as not loaded')
  assert.ok(styles.families.find(f => f.family === 'serif').renders)
  assert.match(await run('style_summary'), /H2: 2 styles \(usually one/)

  // Copy: the paragraph with a link is one block; hidden text is left out; the tool finds the typo, placeholder, doubled word and repeat.
  const text = await browser.read(checks.TEXT_SCRIPT, 1200)
  assert.ok(text.blocks.some(b => b.text === 'Read our privacy policy before you book the the consultation.'), 'a paragraph and its link are one block')
  assert.equal(text.blocks.some(b => /Hidden text/.test(b.text)), false)
  const copy = await run('check_text')
  assert.match(copy, /"recieve" → [^\n]*receive/)
  assert.match(copy, /Placeholder text:\n- "Lorem ipsum"/)
  assert.match(copy, /"the the"/)
  assert.ok(copy.includes(`×2 "${REPEATED}"`))

  // Inspecting by text, by selector and by ref.
  const hero = await browser.read(checks.INSPECT_SCRIPT, { text: 'Hair loss treatments', limit: 3 })
  assert.equal(hero.items[0].name, 'h1'); assert.equal(hero.items[0].color, '#ffffff'); assert.match(hero.items[0].backgroundImage, /^$/)
  assert.equal((await browser.read(checks.INSPECT_SCRIPT, { selector: 'h2', limit: 6 })).total, 2)
  const byRef = await run('inspect_element', { ref: faint.ref })
  assert.match(byRef, /colour #bbbbbb/)
  assert.match(await run('inspect_element', { selector: 'p:nth-of-type(2)' }), /NOT LOADED/)

  // Scrolling to a ref gives its box in the screenshot.
  step = await browser.scroll(faint.ref)
  assert.match(step.note || '', new RegExp(`${faint.ref} is at x \\d+, y \\d+, \\d+×\\d+ in this view`))

  // SEO: canonical to another site, noindex in the page and the header, robots.txt blocking, the sitemap, structured data.
  const seo = await run('seo_check')
  assert.match(seo, /Canonical: https:\/\/live-clinic\.example\/treatments\/ \(ANOTHER SITE/)
  assert.match(seo, /X-Robots-Tag header "noindex" · NOINDEX/)
  assert.match(seo, /robots\.txt: BLOCKS this page \(Disallow: \//)
  assert.match(seo, /Sitemap: http:\/\/127\.0\.0\.1:\d+\/wp-sitemap\.xml · 2 page\(s\), this page is listed/)
  assert.match(seo, /Structured data: 2 JSON-LD block\(s\): Organization, WebPage · BROKEN JSON/)
  assert.match(await run('check_contrast'), /Terms and conditions/)

  // ── Mobile ────────────────────────────────────────────────────────────────────────
  step = await open('mobile', 390)
  fs.writeFileSync(path.join(dir, 'mobile.jpg'), step.screenshot)
  const mobile = await browser.read(checks.LAYOUT_SCRIPT, { touch: true })
  assert.equal(mobile.scrollsSideways, true, 'the wide banner makes the page scroll sideways')
  assert.ok(mobile.pastRightEdge.some(p => /Wide promo banner/.test(p.text)), 'the banner is named')
  assert.ok(mobile.smallTapTargets.some(t => t.name === '×' && t.width === 16), 'the tiny button is a small tap target')
  assert.equal(mobile.smallTapTargets.some(t => /privacy policy/.test(t.name)), false, 'a link inside a sentence is exempt')
  assert.match(await run('check_layout'), /Layout at mobile/)

  browser.close()
  server.close()
  console.log('Page checks: all assertions passed.')
  app.exit(0)
}

if (process.argv.includes('--smoke')) smoke().catch(error => { console.error(error); require('electron').app.exit(1) })
else driver().catch(error => { console.error(error); process.exitCode = 1 })
