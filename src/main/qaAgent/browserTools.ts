import * as z from 'zod'
import { BREAKPOINTS, type Breakpoint } from '../../shared/designScale'
import { siteOf } from './qaBrowserPolicy'
import { BROWSER_KEYS, type BrowserEvents, type BrowserStep } from './qaBrowserTypes'
import { DEFAULT_WIDTH, defineTool, fail, loadRun, requireContext, type ToolResult } from './toolBasics'
import type { QaContext } from './tools'

// Tools that let the agent use the site like a visitor: open pages, click, type, choose, scroll,
// and check links, console and network errors, SEO and accessibility basics, and the site's API.
// They work in the agent's own browser (qaBrowser.ts), which stays on the site under review.

const SENDING_OFF = 'Sending is off: you can fill forms in and see their validation, but submissions and POST, PUT and DELETE requests are stopped (listed as "Parity blocked"). That is Parity, not a fault of the site; never report it.'
const SENDING_ON = 'Sending is on: forms really submit and POST, PUT and DELETE requests reach the site. Use made-up test data only, and send each form at most once.'

const refSchema = z.string().regex(/^e\d{1,5}$/).describe('An element ref from the latest snapshot, such as e12.')

function browserOf(context: QaContext) {
  if (!context.browser) throw new Error('The agent\'s browser is not available here.')
  return context.browser
}

function describeEvents(events: BrowserEvents, heading: string): string[] {
  const lines: string[] = []
  const errors = events.console.filter((entry) => entry.level === 'error')
  if (errors.length) lines.push(`${errors.length} console error(s): ${errors.slice(0, 5).map((entry) => `"${entry.message}"`).join('; ')}`)
  const warnings = events.console.filter((entry) => entry.level === 'warning')
  if (warnings.length) lines.push(`${warnings.length} console warning(s)${warnings.length ? `: "${warnings[0].message}"` : ''}`)
  if (events.requests.length) lines.push(`${events.requests.length} failed request(s): ${events.requests.slice(0, 6).map((r) => `${r.status ?? r.error} ${r.method} ${r.url}`).join('; ')}`)
  if (events.blocked.length) lines.push(`Parity blocked ${events.blocked.length}: ${events.blocked.slice(0, 4).map((b) => `${b.kind === 'form' ? 'form submission' : b.kind} ${b.method} ${b.url} (${b.reason})`).join('; ')}`)
  if (events.dialogs.length) lines.push(`Dialogs (answered OK): ${events.dialogs.map((d) => `${d.type} "${d.message}"`).join('; ')}`)
  if (events.popups.length) lines.push(`The page tried to open new windows (not opened): ${events.popups.slice(0, 3).join(', ')}`)
  if (events.downloads.length) lines.push(`Downloads (not saved): ${events.downloads.slice(0, 3).join(', ')}`)
  return lines.length ? [heading, ...lines.map((line) => `- ${line}`)] : []
}

function describeElement(element: BrowserStep['snapshot']['elements'][number]): string {
  const bits = [`[${element.ref}]`, element.role === element.tag ? element.tag : element.role]
  if (element.type && !['text', 'submit'].includes(element.type) && element.role === 'textbox') bits.push(element.type)
  bits.push(element.name ? `"${element.name}"` : '(no name)')
  if (element.href) bits.push(`→ ${element.href}`)
  if (element.value !== undefined) bits.push(element.value ? `value "${element.value}"` : '(empty)')
  if (element.checked !== undefined) bits.push(element.checked ? 'checked' : 'not checked')
  if (element.required) bits.push('required')
  if (element.disabled) bits.push('disabled')
  if (element.invalid) bits.push(`INVALID: ${element.invalid}`)
  if (element.options) bits.push(`options: ${element.options.join(' | ')}`)
  if (element.form) bits.push(`(${element.form})`)
  if (!element.inViewport) bits.push('(off screen)')
  return bits.join(' ')
}

/** Turns a browser step into what the agent reads, with the screenshot saved in the run for evidence. */
function stepResult(context: QaContext, step: BrowserStep, title: string): ToolResult {
  const browser = browserOf(context)
  const { snapshot } = step
  const shot = browser.runId ? context.runs.saveBrowserShot(browser.runId, step.screenshot) : null
  const lines = [
    `${title}: "${snapshot.title}" — ${snapshot.url}${step.status ? ` (HTTP ${step.status})` : ''}${step.navigated ? ' · a new page opened' : ''}`,
    `${browser.breakpoint ?? ''} ${snapshot.viewport.width}×${snapshot.viewport.height} · scrolled to ${snapshot.scrollY} of ${snapshot.scrollHeight}px${browser.runId ? ` · run ${browser.runId}` : ''}`,
  ]
  if (step.note) lines.push(`Note: ${step.note}`)
  if (snapshot.headings.length) lines.push(`Headings: ${snapshot.headings.slice(0, 10).map((h) => `H${h.level} "${h.text}"`).join(' · ')}`)
  lines.push(`Interactive elements (${snapshot.elements.length}${snapshot.totalElements > snapshot.elements.length ? ` of ${snapshot.totalElements}, visible ones first` : ''}):`, ...snapshot.elements.map(describeElement))
  if (snapshot.forms.length) lines.push('Forms:', ...snapshot.forms.map((form) => `${form.id} ${form.method} ${form.action} · fields ${form.fields.join(', ') || 'none'} · submit ${form.submits.join(', ') || 'none'}`))
  lines.push(...describeEvents(step.events, 'Since the previous step:'))
  if (shot) lines.push(`Screenshot ${shot} is attached. For a finding seen here, give evidence { breakpoint, screenshot: "${shot}", live: <the issue area in CSS px of this view> }.`)
  return { text: lines.join('\n'), images: [{ data: step.screenshot, mimeType: 'image/jpeg', caption: `Screenshot ${shot ?? ''} · ${snapshot.url}`.trim() }] }
}

const act = async (context: QaContext, title: string, work: () => Promise<BrowserStep>): Promise<ToolResult> => {
  try { return stepResult(context, await work(), title) } catch (error: any) { return fail(error?.message || `${title} failed.`) }
}

const browserOpen = defineTool({
  name: 'browser_open',
  title: 'Open a page in the agent\'s browser',
  description: 'Opens the page under review (or another page on the same site) in your own browser, at a breakpoint, so you can click, type and test it like a visitor. Answers the interactive elements with refs (e1, e2, …), forms, headings, console and network errors, and a screenshot. The browser stays on the site; WordPress admin, login and logout are off limits, and data is only sent if the person allowed it.',
  input: z.object({
    url: z.string().max(2000).optional().describe('A page on the same site, as a full URL or a path. Defaults to the page under review.'),
    breakpoint: z.enum(BREAKPOINTS).optional().describe('desktop (default), tablet or mobile.'),
    runId: z.string().min(8).max(80).optional().describe('Reuse a run so screenshots are saved with it. Without one, a run is started.'),
  }),
  readOnly: true,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    let browser
    try { browser = browserOf(context) } catch (error: any) { return fail(error.message) }
    const site = siteOf(reported.pageUrl)
    if (!site) return fail('The page under review is not a web page.')
    let target: string
    try { target = new URL(args.url ?? reported.pageUrl, reported.pageUrl).toString() } catch { return fail('That is not a page address.') }
    let runId = args.runId
    if (runId) {
      const run = loadRun(context, runId, reported)
      if (!run.ok) return fail(run.error)
    } else runId = browser.runId && context.runs.get(browser.runId)?.projectKey === reported.projectKey ? browser.runId : context.runs.create({ projectKey: reported.projectKey, projectName: reported.project.name, pageUrl: reported.pageUrl }).id
    const breakpoint: Breakpoint = args.breakpoint ?? 'desktop'
    const allowSend = context.allowSend?.() === true
    const result = await act(context, 'Opened', () => browser.open({ url: target, site, breakpoint, width: DEFAULT_WIDTH[breakpoint], allowSend, runId: runId! }))
    if (!result.isError) result.text += `\n${allowSend ? SENDING_ON : SENDING_OFF}`
    return result
  },
})

const browserSnapshot = defineTool({
  name: 'browser_snapshot',
  title: 'Look at the page again',
  description: 'The current state of the page in your browser: interactive elements with refs, forms, headings, new console and network errors, and a screenshot.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => act(context, 'Page', () => browserOf(context).snapshot()),
})

const browserClick = defineTool({
  name: 'browser_click',
  title: 'Click an element',
  description: 'Clicks an element by its ref with a real mouse click (it is scrolled into view first). Answers what changed: a new page, new errors, dialogs, and a screenshot. Says when something else covered the element.',
  input: z.object({ ref: refSchema }),
  readOnly: false,
  agentAllowed: true,
  run: (args, context) => act(context, 'After the click', () => browserOf(context).click(args.ref)),
})

const browserType = defineTool({
  name: 'browser_type',
  title: 'Type into a field',
  description: 'Types text into a field by its ref, as a person would. Clears the field first unless clear is false; enter presses Enter afterwards (which usually submits the form). Use made-up test data, never real personal data.',
  input: z.object({ ref: refSchema, text: z.string().max(2000), clear: z.boolean().optional(), enter: z.boolean().optional() }),
  readOnly: false,
  agentAllowed: true,
  run: (args, context) => act(context, 'After typing', () => browserOf(context).type(args.ref, args.text, { clear: args.clear !== false, enter: args.enter === true })),
})

const browserSelect = defineTool({
  name: 'browser_select',
  title: 'Choose an option',
  description: 'Chooses an option in a list (by its value or visible text), or ticks a checkbox or radio button, by ref.',
  input: z.object({ ref: refSchema, value: z.string().max(200).describe('The option\'s value or visible text. Ignored for checkboxes and radio buttons.') }),
  readOnly: false,
  agentAllowed: true,
  run: (args, context) => act(context, 'After choosing', () => browserOf(context).select(args.ref, args.value)),
})

const browserPress = defineTool({
  name: 'browser_press',
  title: 'Press a key',
  description: 'Presses a key in the page, for example Escape to close a menu or Tab to move through a form.',
  input: z.object({ key: z.enum(BROWSER_KEYS) }),
  readOnly: false,
  agentAllowed: true,
  run: (args, context) => act(context, `After ${args.key}`, () => browserOf(context).press(args.key)),
})

const browserScroll = defineTool({
  name: 'browser_scroll',
  title: 'Scroll the page',
  description: 'Scrolls to the top or bottom, up or down a screen, or to a y position in CSS px.',
  input: z.object({ to: z.union([z.enum(['top', 'bottom', 'up', 'down']), z.number().min(0).max(100_000)]) }),
  readOnly: true,
  agentAllowed: true,
  run: (args, context) => act(context, 'After scrolling', () => browserOf(context).scroll(args.to)),
})

const browserBack = defineTool({
  name: 'browser_back',
  title: 'Go back',
  description: 'Goes back to the previous page in your browser.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  run: (_args, context) => act(context, 'Back', () => browserOf(context).back()),
})

const browserEvents = defineTool({
  name: 'browser_events',
  title: 'Console and network errors',
  description: 'Everything since the page was opened: console errors and warnings, failed requests (4xx, 5xx, network errors), requests Parity blocked, dialogs, pop-ups and downloads.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  async run(_args, context) {
    try {
      const lines = describeEvents(browserOf(context).allEvents(), 'Since the page was opened:')
      return { text: lines.length ? lines.join('\n') : 'Since the page was opened: no console errors or warnings, no failed or blocked requests, no dialogs.' }
    } catch (error: any) { return fail(error.message) }
  },
})

const checkLinks = defineTool({
  name: 'check_links',
  title: 'Check the links on the page',
  description: 'Checks every link on the page that is open in your browser: broken (4xx, 5xx, unreachable), redirected, placeholder (# or empty) and mailto/tel links. Admin, login and logout links are never requested.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  async run(_args, context) {
    let results
    try { results = await browserOf(context).links() } catch (error: any) { return fail(error.message) }
    const checked = results.filter((link) => link.plan === 'check')
    const broken = checked.filter((link) => link.error || (link.status ?? 0) >= 400)
    const redirected = checked.filter((link) => !link.error && link.finalUrl && (link.status ?? 0) < 400)
    const placeholders = results.filter((link) => link.plan === 'placeholder')
    const mail = results.filter((link) => link.plan === 'skip-scheme')
    const admin = results.filter((link) => link.plan === 'skip-admin')
    const label = (link: (typeof results)[number]) => `"${link.text || '(no text)'}" ${link.url}${link.count > 1 ? ` (×${link.count})` : ''}`
    const lines = [`Checked ${checked.length} link(s) of ${results.length} unique on the page.`]
    lines.push(broken.length ? `Broken (${broken.length}):` : 'Broken: none.', ...broken.map((link) => `- ${link.error ?? link.status} ${label(link)}`))
    if (redirected.length) lines.push(`Redirected (${redirected.length}):`, ...redirected.slice(0, 20).map((link) => `- ${label(link)} → ${link.finalUrl}`))
    if (placeholders.length) lines.push(`Placeholder links that go nowhere (${placeholders.length}):`, ...placeholders.slice(0, 20).map((link) => `- ${label(link)}`))
    if (mail.length) lines.push(`Not web links, not requested (${mail.length}): ${mail.slice(0, 10).map((link) => link.url).join(', ')}`)
    if (admin.length) lines.push(`Admin, login or logout links, not requested (${admin.length}).`)
    return { text: lines.join('\n') }
  },
})

const pageAudit = defineTool({
  name: 'page_audit',
  title: 'SEO and accessibility basics',
  description: 'Reads the page open in your browser for SEO and accessibility basics: title and meta description, canonical, robots (noindex), language, viewport, H1s and skipped heading levels, images without alt text or broken, links and buttons without a name, fields without a label, duplicate ids, mixed content, page weight and large images.',
  input: z.object({}),
  readOnly: true,
  agentAllowed: true,
  async run(_args, context) {
    let audit
    try { audit = await browserOf(context).audit() } catch (error: any) { return fail(error.message) }
    const lines = [
      `Title (${audit.title.length} chars): "${audit.title}"`,
      `Meta description (${audit.description.length} chars): ${audit.description ? `"${audit.description}"` : 'MISSING'}`,
      `Canonical: ${audit.canonical || 'none'} · robots: ${audit.robots || 'not set'}${/noindex/i.test(audit.robots) ? ' (NOINDEX: search engines are told not to list this page)' : ''}`,
      `Language: ${audit.lang || 'NOT SET'} · viewport meta: ${audit.viewport || 'MISSING'} · favicon: ${audit.favicon ? 'yes' : 'none'}`,
      `H1: ${audit.h1.length ? audit.h1.map((text) => `"${text}"`).join(', ') : 'NONE'}${audit.h1.length > 1 ? ' (more than one)' : ''}`,
      audit.headingJumps.length ? `Skipped heading levels: ${audit.headingJumps.join('; ')}` : 'Heading levels: no skips',
      `Open Graph: title ${audit.ogTitle ? 'set' : 'missing'}, image ${audit.ogImage ? 'set' : 'missing'}`,
      `Images without alt (${audit.imagesWithoutAlt.length}): ${audit.imagesWithoutAlt.join(', ') || 'none'}`,
      `Broken images (${audit.brokenImages.length}): ${audit.brokenImages.join(', ') || 'none'}`,
      `Links without a name: ${audit.unnamedLinks} · buttons without a name: ${audit.unnamedButtons}`,
      `Fields without a label (${audit.unlabeledInputs.length}): ${audit.unlabeledInputs.join('; ') || 'none'}`,
      `Duplicate ids: ${audit.duplicateIds.join(', ') || 'none'} · mixed content: ${audit.mixedContent.join(', ') || 'none'}`,
      `Load: ${audit.loadMs ?? '?'} ms · ${audit.requests} requests · ${audit.transferKb} KB transferred`,
      audit.largeImages.length ? `Large images (over 300 KB): ${audit.largeImages.map((image) => `${image.kb} KB ${image.url}`).join('; ')}` : 'Large images: none over 300 KB',
    ]
    return { text: lines.join('\n') }
  },
})

const httpRequest = defineTool({
  name: 'http_request',
  title: 'Call the site\'s API',
  description: 'Sends one HTTP request to the site under review (same site only), with the person\'s login, for example GET /wp-json/wp/v2/pages or a form endpoint. GET, HEAD and OPTIONS always work; POST, PUT, PATCH and DELETE only if the person allowed sending data. Answers the status, key headers and the body (shortened).',
  input: z.object({
    method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string().min(1).max(2000).describe('A path such as /wp-json/wp/v2/pages, or a full URL on the same site.'),
    headers: z.record(z.string().max(100), z.string().max(1000)).optional(),
    body: z.string().max(50_000).optional(),
  }),
  readOnly: false,
  agentAllowed: true,
  async run(args, context) {
    const reported = requireContext(context)
    if (typeof reported === 'string') return fail(reported)
    let browser
    try { browser = browserOf(context) } catch (error: any) { return fail(error.message) }
    if (!browser.site) return fail('Open the page with browser_open first; requests go to the same site.')
    if (args.headers && Object.keys(args.headers).length > 20) return fail('At most 20 headers.')
    try {
      const result = await browser.request({ method: args.method, url: args.url, headers: args.headers, body: args.body })
      let body = result.body
      if (/json/i.test(result.headers['content-type'] ?? '')) { try { body = JSON.stringify(JSON.parse(body), null, 2) } catch { /* not valid JSON: shown as is */ } }
      const shown = body.length > 6000 ? `${body.slice(0, 6000)}\n… (${body.length - 6000} more characters)` : body
      return { text: [`${args.method} ${args.url} → ${result.status} ${result.statusText} in ${result.ms} ms`, `Headers: ${Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`).join(' · ') || 'none'}`, result.truncated ? 'The body was cut at 100 KB.' : '', 'Body:', shown || '(empty)'].filter(Boolean).join('\n') }
    } catch (error: any) {
      return fail(error?.name === 'TimeoutError' ? 'The site did not answer within 20 seconds.' : error?.message || 'The request failed.')
    }
  },
})

export const BROWSER_TOOLS = [browserOpen, browserSnapshot, browserClick, browserType, browserSelect, browserPress, browserScroll, browserBack, browserEvents, checkLinks, pageAudit, httpRequest] as const
export const BROWSER_TOOL_NAMES = BROWSER_TOOLS.map((tool) => tool.name)
