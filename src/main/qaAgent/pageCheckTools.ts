import * as z from 'zod'
import { checkCopy, loadSpeller, type TextBlock } from './copyCheck'
import { CONTRAST_SCRIPT, INSPECT_SCRIPT, LAYOUT_SCRIPT, SEO_SCRIPT, STYLES_SCRIPT, TEXT_SCRIPT } from './pageCheckScripts'
import { browserOf, defineTool, fail, type ToolResult } from './toolBasics'
import type { QaContext } from './tools'

// Checks that read exact values from the page open in the agent's browser and answer in text: no
// screenshot, so they cost little, and they measure what a picture can only suggest (a contrast
// ratio, a font that did not load, an element 40px past the edge). They need browser_open first.
// Every element they name gets a ref, so browser_scroll can show it for evidence.

type Box = { x: number; y: number; width: number; height: number }
const refSchema = z.string().regex(/^e\d{1,5}$/).describe('An element ref, such as e12, from a snapshot or an earlier check.')
const at = (box: Box) => `x ${box.x}, y ${box.y}, ${box.width}×${box.height}`
const quote = (text: string) => (text ? `"${text}"` : '(no text)')

/** Runs a check, turning "no page is open" and script failures into an error the agent can act on. */
async function checking(context: QaContext, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try { browserOf(context) } catch (error: any) { return fail(error.message) }
  try { return await work() } catch (error: any) { return fail(error?.message || 'The check failed.') }
}

const EVIDENCE_HINT = 'To show a finding in a picture, browser_scroll to its ref; the result gives its box in that screenshot.'

// ── inspect_element ─────────────────────────────────────────────────────────────────

interface Inspected {
  ref: string; name: string; text: string; shown: boolean; box: Box; font: string; fontStack: string; fontRenders: boolean
  color: string; background: string; backgroundImage: string; margin: string; padding: string; display: string; position: string
  letterSpacing?: string; textTransform?: string; textAlign?: string; gap?: string; border?: string; radius?: string; shadow?: string; opacity?: string; maxWidth?: string
  image?: { src: string; natural: string; alt: string | null; fit: string }; href?: string
}

export function describeInspected(item: Inspected): string {
  const extras = [
    item.letterSpacing && `letter-spacing ${item.letterSpacing}`, item.textTransform, item.textAlign && `align ${item.textAlign}`, item.gap && `gap ${item.gap}`,
    item.border && `border ${item.border}`, item.radius && `radius ${item.radius}`, item.shadow && `shadow ${item.shadow}`, item.opacity && `opacity ${item.opacity}`, item.maxWidth && `max-width ${item.maxWidth}`,
  ].filter(Boolean)
  const lines = [
    `[${item.ref}] ${item.name} ${quote(item.text)} · ${at(item.box)} (page px)${item.shown ? '' : ' · NOT VISIBLE'}`,
    `  font ${item.font}${item.fontRenders ? '' : ` · NOT LOADED, so a fallback shows (stack: ${item.fontStack})`} · colour ${item.color} · background ${item.background || 'none'}${item.backgroundImage ? ` + image ${item.backgroundImage}` : ''}`,
    `  margin ${item.margin} · padding ${item.padding} · ${item.display}${item.position !== 'static' ? ` · ${item.position}` : ''}${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
  ]
  if (item.image) lines.push(`  image ${item.image.src} · file ${item.image.natural} · fit ${item.image.fit} · alt ${item.image.alt === null ? 'MISSING' : quote(item.image.alt)}`)
  if (item.href !== undefined) lines.push(`  link → ${item.href || '(empty)'}`)
  return lines.join('\n')
}

const inspectElement = defineTool({
  name: 'inspect_element',
  title: 'Inspect elements',
  description: 'Exact computed values of elements on the page open in your browser, found by ref (e12), CSS selector (h2, .elementor-button) or the text they show ("Book now"): font family, weight, size and line height, whether that font really loaded, colour, background, margin, padding, position and size, and for images the file\'s own size and alt text. Text only, no screenshot, so it is cheap: use it for "what font, size, colour or spacing is X" instead of guessing from a picture.',
  input: z.object({
    ref: refSchema.optional(),
    selector: z.string().min(1).max(300).optional().describe('A CSS selector.'),
    text: z.string().min(2).max(200).optional().describe('Text the element shows.'),
    limit: z.number().int().min(1).max(12).optional().describe('How many matches to describe (default 6).'),
  }),
  readOnly: true,
  agentAllowed: true,
  run: (args, context) => checking(context, async () => {
    if (!args.ref && !args.selector && !args.text) return fail('Give a ref, a selector or a text to look for.')
    const result = await browserOf(context).read<{ error?: string; total: number; visible: number; items: Inspected[] }>(INSPECT_SCRIPT, { ref: args.ref, selector: args.selector, text: args.text, limit: args.limit ?? 6 })
    if (result.error) return fail(result.error)
    if (!result.total) return fail(`Nothing on the page matches ${args.ref ?? args.selector ?? quote(args.text ?? '')}.${args.ref ? ' Refs change when the page changes; take a snapshot or run the check again.' : ''}`)
    const head = `${result.total} match${result.total === 1 ? '' : 'es'} (${result.visible} visible)${result.items.length < result.total ? `, showing ${result.items.length}` : ''}:`
    return { text: [head, ...result.items.map(describeInspected)].join('\n') }
  }),
})

// ── check_contrast ──────────────────────────────────────────────────────────────────

interface ContrastGroup { text: string; background: string; ratio: number; needed: number; size: number; weight: number; count: number; examples: string[]; ref: string; box: Box }

const checkContrast = defineTool({
  name: 'check_contrast',
  title: 'Check text contrast',
  description: 'Measures the WCAG contrast of every visible text on the page open in your browser against the colour actually painted behind it, and lists what fails AA (4.5:1, or 3:1 for large text). Text over images or video is counted but not judged. Text only, no screenshot.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => checking(context, async () => {
    const result = await browserOf(context).read<{ checked: number; failingElements: number; groups: ContrastGroup[]; moreGroups: number; overImage: number; covered: number }>(CONTRAST_SCRIPT, 15)
    const lines = [`Checked ${result.checked} text element(s) against what is behind them. WCAG AA needs 4.5:1, or 3:1 for large text (24px and up, or 18.7px bold).`]
    if (!result.groups.length) lines.push('Failing: none.')
    else {
      lines.push(`Failing: ${result.failingElements} element(s), grouped by colour pair and size (worst first):`)
      for (const g of result.groups) lines.push(`- ${g.ratio}:1 (needs ${g.needed}) · ${g.text} on ${g.background} · ${g.size}px weight ${g.weight} · ×${g.count} · first ${g.ref} at ${at(g.box)} · ${g.examples.map(quote).join(', ')}`)
      if (result.moreGroups) lines.push(`… and ${result.moreGroups} more group(s).`)
    }
    if (result.overImage) lines.push(`Not judged: ${result.overImage} over an image, video or gradient (look at those in a screenshot).`)
    if (result.covered) lines.push(`Not judged: ${result.covered} covered by a sticky header or popup while checking.`)
    if (result.groups.length) lines.push(EVIDENCE_HINT)
    return { text: lines.join('\n') }
  }),
})

// ── check_layout ────────────────────────────────────────────────────────────────────

interface LayoutReport {
  viewportWidth: number; pageWidth: number; scrollsSideways: boolean; pageClipsSideways: boolean
  pastRightEdge: Array<{ ref: string; name: string; text: string; box: Box; past: number }>
  smallText: Array<{ size: number; count: number; examples: string[]; ref: string }>
  smallTapTargets?: Array<{ ref: string; name: string; width: number; height: number }>; smallTapTargetsMore?: number; tapTargetsUnder44?: number
  images: Array<{ ref: string; src: string; natural: string; shown: string; problems: string[] }>
  cutOffText: Array<{ ref: string; text: string; how: string }>
  overlappingText: Array<{ refs: string[]; texts: string[]; y: number }>
}

export function describeLayout(report: LayoutReport, breakpoint: string): string {
  const lines = [`Layout at ${breakpoint} (${report.viewportWidth}px wide):`]
  lines.push(report.scrollsSideways ? `Sideways scrolling: YES. The page is ${report.pageWidth}px wide on a ${report.viewportWidth}px screen.` : `Sideways scrolling: none${report.pageClipsSideways && report.pastRightEdge.length ? ' (the page hides its overflow, so anything past the edge is cut off instead)' : ''}.`)
  if (report.pastRightEdge.length) lines.push('Past the right edge:', ...report.pastRightEdge.map((item) => `- ${item.ref} ${item.name} ${quote(item.text)} sticks out ${item.past}px · ${at(item.box)}`))
  lines.push(report.smallText.length ? 'Text under 12px:' : 'Text under 12px: none.', ...report.smallText.map((group) => `- ${group.size}px ×${group.count} (first ${group.ref}): ${group.examples.map(quote).join(', ')}`))
  if (report.smallTapTargets) {
    lines.push(report.smallTapTargets.length ? 'Tap targets under 24×24px (WCAG 2.5.8):' : 'Tap targets under 24×24px: none.', ...report.smallTapTargets.map((target) => `- ${target.ref} ${quote(target.name)} ${target.width}×${target.height}`))
    if (report.smallTapTargetsMore) lines.push(`… and ${report.smallTapTargetsMore} more.`)
    if (report.tapTargetsUnder44) lines.push(`${report.tapTargetsUnder44} more are 24–43px: allowed, but under the 44px most guidelines recommend.`)
  }
  lines.push(report.images.length ? 'Images:' : 'Images: none stretched, blown up or far too large.', ...report.images.map((image) => `- ${image.ref} ${image.problems.join('; ')} · file ${image.natural}, shown ${image.shown} · ${image.src}`))
  if (report.cutOffText.length) lines.push('Text cut off by its box (check whether that is meant):', ...report.cutOffText.map((item) => `- ${item.ref} ${quote(item.text)} ${item.how}`))
  if (report.overlappingText.length) lines.push('Text over other text:', ...report.overlappingText.map((item) => `- ${item.refs[0]} ${quote(item.texts[0])} and ${item.refs[1]} ${quote(item.texts[1])} at y ${item.y}`))
  return lines.join('\n')
}

const checkLayout = defineTool({
  name: 'check_layout',
  title: 'Check the layout',
  description: 'Finds layout defects at the width the page is open at in your browser: sideways scrolling and what sticks out past the right edge, text under 12px, tap targets under 24px on tablet and mobile, images stretched, blown up past their own size or far too large, text cut off by its box, and text over other text. Text only, no screenshot. Run it at each breakpoint you open.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => checking(context, async () => {
    const browser = browserOf(context)
    const breakpoint = browser.breakpoint ?? 'desktop'
    const report = await browser.read<LayoutReport>(LAYOUT_SCRIPT, { touch: breakpoint !== 'desktop' })
    const found = report.scrollsSideways || report.pastRightEdge.length || report.smallText.length || report.smallTapTargets?.length || report.images.length || report.cutOffText.length || report.overlappingText.length
    return { text: describeLayout(report, breakpoint) + (found ? `\n${EVIDENCE_HINT}` : '') }
  }),
})

// ── style_summary ───────────────────────────────────────────────────────────────────

interface StyleSummary {
  kinds: Array<{ kind: string; styles: Array<{ style: string; count: number; example: string; ref: string }> }>
  families: Array<{ family: string; count: number; stack: string; renders: boolean }>
  textColors: Array<{ value: string; count: number }>
  backgroundColors: Array<{ value: string; count: number }>
}

/** Kinds of text that a design usually gives one style each. */
const CONSISTENT = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Button', 'Menu'])

export function describeStyles(summary: StyleSummary): string {
  const lines = ['Text styles by kind (weight size/line-height font colour, how many, first example):']
  for (const { kind, styles } of summary.kinds) {
    const mixed = styles.length > 1 && CONSISTENT.has(kind)
    lines.push(`${kind}: ${styles.length} style${styles.length === 1 ? '' : 's'}${mixed ? ' (usually one: check that these are meant to differ)' : ''}`)
    for (const entry of styles.slice(0, 5)) lines.push(`- ${entry.style} ×${entry.count} · ${entry.ref} ${quote(entry.example)}`)
    if (styles.length > 5) lines.push(`- … and ${styles.length - 5} more`)
  }
  lines.push(`Fonts: ${summary.families.map((f) => `${f.family} ×${f.count}${f.renders ? '' : ` (NOT LOADED, so a fallback shows; stack: ${f.stack})`}`).join('; ') || 'none'}`)
  lines.push(`Text colours: ${summary.textColors.map((c) => `${c.value} ×${c.count}`).join(', ') || 'none'}`)
  lines.push(`Background colours: ${summary.backgroundColors.map((c) => `${c.value} ×${c.count}`).join(', ') || 'none'}`)
  return lines.join('\n')
}

const styleSummary = defineTool({
  name: 'style_summary',
  title: 'Summarise text styles',
  description: 'Lists every text style on the page open in your browser, grouped by kind (H1 to H6, buttons, links, menu, body text), with the fonts used (and any that failed to load) and the text and background colours. Shows inconsistencies at a glance: two styles of H2, buttons of different sizes, a font that never loaded. Text only, no screenshot.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => checking(context, async () => ({ text: describeStyles(await browserOf(context).read<StyleSummary>(STYLES_SCRIPT)) })),
})

// ── check_text ──────────────────────────────────────────────────────────────────────

const checkText = defineTool({
  name: 'check_text',
  title: 'Check the copy',
  description: 'Reads all the visible text on the page open in your browser and lists possible misspellings (US English dictionary, with suggestions), placeholder text (lorem ipsum, "your text here", "click here", TBD), doubled words ("the the") and blocks of text repeated on the page. Text only, no screenshot.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => checking(context, async () => {
    const page = await browserOf(context).read<{ lang: string; title: string; host: string; blocks: TextBlock[] }>(TEXT_SCRIPT, 1200)
    const report = checkCopy(page, await loadSpeller())
    const lines = [`Read ${report.blocks} block(s) of text (${report.words} words checked for spelling).`]
    if (!report.misspellings) lines.push('Spelling: the dictionary could not be loaded, so spelling was not checked.')
    else {
      const british = /^en-(gb|au|nz|ie|za|in)/i.test(page.lang)
      lines.push(report.misspellings.length ? `Possible misspellings (US English${british ? `, but the page says it is ${page.lang}, so British spellings show here too` : ''}; names, brands and jargon show up as well, so report only real typos):` : 'Possible misspellings: none.')
      for (const entry of report.misspellings) lines.push(`- "${entry.word}"${entry.suggestions.length ? ` → ${entry.suggestions.join(', ')}` : ''}${entry.count > 1 ? ` ×${entry.count}` : ''} · ${entry.ref} · "${entry.context}"`)
    }
    lines.push(report.placeholders.length ? 'Placeholder text:' : 'Placeholder text: none.', ...report.placeholders.map((entry) => `- "${entry.match}" · ${entry.ref} · "${entry.context}"`))
    if (report.doubledWords.length) lines.push('Doubled words (some are correct, like "had had"):', ...report.doubledWords.map((entry) => `- "${entry.match}" · ${entry.ref} · "${entry.context}"`))
    if (report.repeatedBlocks.length) lines.push('The same text more than once on the page:', ...report.repeatedBlocks.map((entry) => `- ×${entry.count} "${entry.text}" (${entry.refs.join(', ')})`))
    return { text: lines.join('\n') }
  }),
})

// ── seo_check ───────────────────────────────────────────────────────────────────────

interface SeoData {
  url: string; title: string; description: string; robots: string; canonical: string; hreflang: string[]
  og: { title: string; description: string; image: string; url: string; type: string }; twitter: { card: string; image: string }
  jsonLd: { blocks: number; types: string[]; errors: string[] }; microdata: number; words: number
  links: { internal: number; external: number; nofollow: number }; headings: number[]; generator: string; images: number
}

/** What robots.txt says about a path for every crawler ("User-agent: *"): the longest matching rule wins, and Allow wins a tie. */
export function robotsVerdict(robots: string, path: string): { blocked: boolean; rule?: string; sitemaps: string[] } {
  const sitemaps: string[] = []
  const rules: Array<{ allow: boolean; pattern: string }> = []
  let agents: string[] = []
  let inRules = false
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!match) continue
    const [, field, value] = match
    const key = field.toLowerCase()
    if (key === 'sitemap') { sitemaps.push(value); continue }
    if (key === 'user-agent') { if (inRules) { agents = []; inRules = false } agents.push(value.toLowerCase()); continue }
    if (key !== 'allow' && key !== 'disallow') continue
    inRules = true
    if (agents.includes('*') && value) rules.push({ allow: key === 'allow', pattern: value })
  }
  let best: { allow: boolean; pattern: string } | null = null
  for (const rule of rules) {
    // "*" is any run of characters and a final "$" ends the path; everything else is literal.
    const anchored = rule.pattern.endsWith('$')
    const literal = (anchored ? rule.pattern.slice(0, -1) : rule.pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    if (!new RegExp(`^${literal}${anchored ? '$' : ''}`).test(path)) continue
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule
  }
  return { blocked: !!best && !best.allow, ...(best && !best.allow ? { rule: `Disallow: ${best.pattern}` } : {}), sitemaps }
}

const lengthNote = (length: number, low: number, high: number) => (length < low ? ` (short: aim for ${low}–${high})` : length > high ? ` (long: search results cut it after about ${high})` : '')

const seoCheck = defineTool({
  name: 'seo_check',
  title: 'Deeper SEO check',
  description: 'Goes beyond page_audit for the page open in your browser: title and description lengths, canonical (another page or another site?), noindex in the page or its X-Robots-Tag header, robots.txt (does it block this page?), the sitemap (found, and is this page in it?), structured data (JSON-LD types and errors), Open Graph and Twitter cards, hreflang, word count, heading counts and internal, external and nofollow links. Text only.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => checking(context, async () => {
    const browser = browserOf(context)
    const seo = await browser.read<SeoData>(SEO_SCRIPT)
    const page = new URL(seo.url)
    const get = async (url: string, method = 'GET') => { try { return await browser.request({ method, url }) } catch { return null } }
    const lines = [`SEO for ${seo.url}`]
    lines.push(`Title (${seo.title.length} chars): ${seo.title ? quote(seo.title) : 'MISSING'}${seo.title ? lengthNote(seo.title.length, 30, 60) : ''}`)
    lines.push(`Description (${seo.description.length} chars): ${seo.description ? quote(seo.description) : 'MISSING'}${seo.description ? lengthNote(seo.description.length, 70, 160) : ''}`)
    if (!seo.canonical) lines.push('Canonical: none.')
    else {
      const canonical = new URL(seo.canonical, seo.url)
      const where = canonical.host !== page.host ? `ANOTHER SITE (${canonical.host}): fine if it is the live site this staging copy becomes, wrong otherwise` : canonical.pathname !== page.pathname ? 'ANOTHER PAGE on this site: this page asks not to be indexed itself' : 'this page'
      lines.push(`Canonical: ${seo.canonical} (${where})`)
    }
    const head = await get(seo.url, 'HEAD')
    const headerRobots = head?.headers['x-robots-tag'] ?? ''
    const noindex = /noindex/i.test(`${seo.robots} ${headerRobots}`)
    lines.push(`Robots: meta ${seo.robots ? quote(seo.robots) : 'not set'} · X-Robots-Tag header ${headerRobots ? quote(headerRobots) : 'not set'}${noindex ? ' · NOINDEX (normal on a staging site; it must be removed at launch)' : ''}`)

    const robotsFile = await get('/robots.txt')
    let sitemapUrls: string[] = []
    if (!robotsFile || robotsFile.status >= 400) lines.push(`robots.txt: ${robotsFile ? `not found (${robotsFile.status})` : 'could not be read'}`)
    else {
      const verdict = robotsVerdict(robotsFile.body, page.pathname + page.search)
      sitemapUrls = verdict.sitemaps
      lines.push(`robots.txt: ${verdict.blocked ? `BLOCKS this page (${verdict.rule}; normal on a staging site, it must be lifted at launch)` : 'does not block this page'} · sitemaps listed: ${verdict.sitemaps.length ? verdict.sitemaps.join(', ') : 'none'}`)
    }
    // The sitemap the site names, else where WordPress, Yoast and Rank Math put theirs. Other sites cannot be requested.
    const candidates = [...sitemapUrls.filter((url) => { try { return new URL(url).host === page.host } catch { return false } }), '/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml']
    let sitemapLine = 'Sitemap: none found (tried /wp-sitemap.xml, /sitemap_index.xml and /sitemap.xml).'
    for (const candidate of [...new Set(candidates)].slice(0, 3)) {
      const sitemap = await get(candidate)
      if (!sitemap || sitemap.status >= 400 || !/<(urlset|sitemapindex)\b/i.test(sitemap.body)) continue
      const children = (sitemap.body.match(/<sitemap>/gi) ?? []).length
      const urls = (sitemap.body.match(/<url>/gi) ?? []).length
      const locs = [...sitemap.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => { try { return new URL(m[1]).pathname.replace(/\/+$/, '') } catch { return '' } })
      const listed = locs.includes(page.pathname.replace(/\/+$/, ''))
      sitemapLine = `Sitemap: ${candidate} · ${children ? `an index of ${children} sitemaps (fetch one with http_request to look for this page)` : `${urls} page(s), this page ${listed ? 'is listed' : 'is NOT listed'}`}${sitemap.truncated ? ' (only the first 100 KB read)' : ''}`
      break
    }
    lines.push(sitemapLine)
    lines.push(seo.jsonLd.blocks ? `Structured data: ${seo.jsonLd.blocks} JSON-LD block(s): ${seo.jsonLd.types.join(', ') || 'no @type'}${seo.jsonLd.errors.length ? ` · BROKEN JSON: ${seo.jsonLd.errors.join('; ')}` : ''}` : `Structured data: no JSON-LD${seo.microdata ? `, ${seo.microdata} microdata item(s)` : ''}.`)
    const og = seo.og
    const ogHost = (() => { try { return og.url ? new URL(og.url, seo.url).host : '' } catch { return '' } })()
    lines.push(`Social: og:title ${og.title ? 'set' : 'MISSING'}, og:description ${og.description ? 'set' : 'MISSING'}, og:image ${og.image || 'MISSING'}, og:url ${og.url ? `${og.url}${ogHost && ogHost !== page.host ? ' (another site)' : ''}` : 'not set'}, og:type ${og.type || 'not set'} · twitter:card ${seo.twitter.card || 'not set'}`)
    if (seo.hreflang.length) lines.push(`hreflang: ${seo.hreflang.join('; ')}${seo.hreflang.some((entry) => entry.startsWith('x-default')) ? '' : ' (no x-default)'}`)
    lines.push(`Content: ${seo.words} words · headings ${seo.headings.map((count, i) => `H${i + 1} ${count}`).join(', ')} · links ${seo.links.internal} internal, ${seo.links.external} external (${seo.links.nofollow} nofollow) · ${seo.images} images`)
    if (seo.generator) lines.push(`Generator meta: ${quote(seo.generator)}`)
    return { text: lines.join('\n') }
  }),
})

export const PAGE_CHECK_TOOLS = [inspectElement, checkContrast, checkLayout, styleSummary, checkText, seoCheck] as const
