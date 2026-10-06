import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STANDARD_TRACKER } from '../../shared/trackerFormat'
import { CONTRAST_SCRIPT, INSPECT_SCRIPT, LAYOUT_SCRIPT, SEO_SCRIPT, STYLES_SCRIPT, TEXT_SCRIPT } from './pageCheckScripts'
import { robotsVerdict } from './pageCheckTools'
import type { HttpResult, QaBrowser } from './qaBrowserTypes'
import { createFakeBrowser, createFakeContext, type FakeContext } from './testSupport'
import { callTool } from './tools'

let root: string
let fake: FakeContext
let answers: Map<string, unknown>
let reads: Array<{ script: string; args: unknown[] }>
let requests: string[]
let site: Record<string, Partial<HttpResult>>
let browser: QaBrowser

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'parity-page-checks-'))
  answers = new Map()
  reads = []
  requests = []
  site = {}
  const base = await createFakeBrowser()
  browser = Object.assign(base, {
    async read<T>(script: string, ...args: unknown[]): Promise<T> {
      reads.push({ script, args })
      if (!answers.has(script)) throw new Error('unexpected script')
      return answers.get(script) as T
    },
    async request(input: { method: string; url: string }): Promise<HttpResult> {
      requests.push(`${input.method} ${input.url}`)
      const known = site[`${input.method} ${input.url}`]
      return { status: 404, statusText: 'Not Found', headers: {}, body: '', truncated: false, ms: 5, ...known }
    },
  })
  fake = createFakeContext(root, { trackerFormat: () => STANDARD_TRACKER, browser })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const call = (name: string, args: unknown = {}) => callTool(name, args, fake.context)
const open = (breakpoint: 'desktop' | 'mobile' = 'desktop') => call('browser_open', { breakpoint })

describe('page checks need an open page', () => {
  it('asks for browser_open first', async () => {
    const closed = { ...browser, read: async () => { throw new Error('No page is open in the agent\'s browser. Call browser_open first.') } }
    fake.context.browser = closed as QaBrowser
    const result = await call('check_contrast')
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('browser_open first') })
  })

  it('says when there is no browser at all', async () => {
    fake.context.browser = undefined
    expect(await call('check_layout')).toMatchObject({ isError: true, text: expect.stringContaining('not available') })
  })
})

describe('inspect_element', () => {
  const item = {
    ref: 'e7', name: 'h2.elementor-heading-title', text: 'Our treatments', shown: true, box: { x: 120, y: 840, width: 600, height: 48 },
    font: '700 40px/48px Montserrat', fontStack: 'Montserrat, sans-serif', fontRenders: false, color: '#1a1a1a', background: '', backgroundImage: '',
    margin: '0px 0px 20px', padding: '0px', display: 'block', position: 'static', letterSpacing: '1px', textTransform: 'uppercase',
  }

  it('needs something to look for, and passes the query to the page', async () => {
    await open()
    expect(await call('inspect_element', {})).toMatchObject({ isError: true, text: expect.stringContaining('ref, a selector or a text') })
    answers.set(INSPECT_SCRIPT, { total: 3, visible: 2, items: [item] })
    const result = await call('inspect_element', { text: 'Our treatments', limit: 1 })
    expect(reads.at(-1)!.args).toEqual([{ ref: undefined, selector: undefined, text: 'Our treatments', limit: 1 }])
    expect(result.isError).toBeFalsy()
    expect(result.images).toBeUndefined()
    expect(result.text).toContain('3 matches (2 visible), showing 1')
    expect(result.text).toContain('[e7] h2.elementor-heading-title "Our treatments" · x 120, y 840, 600×48')
    expect(result.text).toContain('font 700 40px/48px Montserrat · NOT LOADED, so a fallback shows (stack: Montserrat, sans-serif)')
    expect(result.text).toContain('letter-spacing 1px · uppercase')
  })

  it('reports a bad selector and no match', async () => {
    await open()
    answers.set(INSPECT_SCRIPT, { error: 'That is not a valid CSS selector.' })
    expect(await call('inspect_element', { selector: 'h2[' })).toMatchObject({ isError: true, text: 'That is not a valid CSS selector.' })
    answers.set(INSPECT_SCRIPT, { total: 0, visible: 0, items: [] })
    expect(await call('inspect_element', { ref: 'e99' })).toMatchObject({ isError: true, text: expect.stringContaining('Refs change') })
  })
})

describe('check_contrast', () => {
  it('lists the failing colour pairs, worst first, and what it could not judge', async () => {
    await open()
    answers.set(CONTRAST_SCRIPT, {
      checked: 140, failingElements: 13, moreGroups: 0, overImage: 4, covered: 1,
      groups: [{ text: '#aaaaaa', background: '#ffffff', ratio: 2.32, needed: 4.5, size: 14, weight: 400, count: 12, examples: ['Terms apply', 'Read more'], ref: 'e40', box: { x: 10, y: 3000, width: 80, height: 18 } }],
    })
    const result = await call('check_contrast')
    expect(result.text).toContain('Checked 140 text element(s)')
    expect(result.text).toContain('- 2.32:1 (needs 4.5) · #aaaaaa on #ffffff · 14px weight 400 · ×12 · first e40 at x 10, y 3000, 80×18 · "Terms apply", "Read more"')
    expect(result.text).toContain('Not judged: 4 over an image')
    expect(result.text).toContain('browser_scroll to its ref')
  })

  it('says so when nothing fails', async () => {
    await open()
    answers.set(CONTRAST_SCRIPT, { checked: 20, failingElements: 0, groups: [], moreGroups: 0, overImage: 0, covered: 0 })
    expect((await call('check_contrast')).text).toContain('Failing: none.')
  })
})

describe('check_layout', () => {
  const report = {
    viewportWidth: 390, pageWidth: 450, scrollsSideways: true, pageClipsSideways: false,
    pastRightEdge: [{ ref: 'e3', name: 'div.hero-image', text: '', box: { x: 0, y: 200, width: 450, height: 300 }, past: 60 }],
    smallText: [{ size: 10, count: 4, examples: ['© 2026'], ref: 'e9' }],
    smallTapTargets: [{ ref: 'e12', name: '×', width: 16, height: 16 }], smallTapTargetsMore: 0, tapTargetsUnder44: 5,
    images: [{ ref: 'e20', src: 'https://svenson.test/team.jpg', natural: '400x400', shown: '390x200', problems: ['stretched wide'] }],
    cutOffText: [{ ref: 'e30', text: 'Book your free consultation', how: 'cut off at the side' }],
    overlappingText: [{ refs: ['e31', 'e32'], texts: ['Our clinics', 'Find us'], y: 1200 }],
  }

  it('checks touch targets on mobile and describes every problem', async () => {
    await open('mobile')
    answers.set(LAYOUT_SCRIPT, report)
    const result = await call('check_layout')
    expect(reads.at(-1)!.args).toEqual([{ touch: true }])
    expect(result.text).toContain('Layout at mobile (390px wide):')
    expect(result.text).toContain('Sideways scrolling: YES. The page is 450px wide on a 390px screen.')
    expect(result.text).toContain('- e3 div.hero-image (no text) sticks out 60px')
    expect(result.text).toContain('- 10px ×4 (first e9): "© 2026"')
    expect(result.text).toContain('- e12 "×" 16×16')
    expect(result.text).toContain('5 more are 24–43px')
    expect(result.text).toContain('- e20 stretched wide · file 400x400, shown 390x200')
    expect(result.text).toContain('- e30 "Book your free consultation" cut off at the side')
    expect(result.text).toContain('- e31 "Our clinics" and e32 "Find us" at y 1200')
  })

  it('does not check tap targets on desktop', async () => {
    await open('desktop')
    answers.set(LAYOUT_SCRIPT, { ...report, scrollsSideways: false, pastRightEdge: [], smallText: [], smallTapTargets: undefined, images: [], cutOffText: [], overlappingText: [] })
    const result = await call('check_layout')
    expect(reads.at(-1)!.args).toEqual([{ touch: false }])
    expect(result.text).toContain('Sideways scrolling: none.')
    expect(result.text).not.toContain('Tap targets')
    expect(result.text).not.toContain('browser_scroll')
  })
})

describe('style_summary', () => {
  it('flags headings and buttons with more than one style, and fonts that did not load', async () => {
    await open()
    answers.set(STYLES_SCRIPT, {
      kinds: [
        { kind: 'H2', styles: [{ style: '700 36px/44px Montserrat #111111', count: 5, example: 'Our clinics', ref: 'e1' }, { style: '600 32px/40px Montserrat #222222', count: 1, example: 'FAQ', ref: 'e2' }] },
        { kind: 'Body text', styles: [{ style: '400 16px/26px Open Sans #444444', count: 40, example: 'Hair loss is…', ref: 'e3' }, { style: '400 14px/22px Open Sans #444444', count: 6, example: 'Small print', ref: 'e4' }] },
      ],
      families: [{ family: 'Montserrat', count: 6, stack: 'Montserrat, sans-serif', renders: true }, { family: 'Open Sans', count: 46, stack: '"Open Sans", sans-serif', renders: false }],
      textColors: [{ value: '#444444', count: 46 }], backgroundColors: [{ value: '#ffffff', count: 3 }],
    })
    const text = (await call('style_summary')).text
    expect(text).toContain('H2: 2 styles (usually one: check that these are meant to differ)')
    expect(text).toContain('Body text: 2 styles\n')
    expect(text).toContain('Open Sans ×46 (NOT LOADED, so a fallback shows; stack: "Open Sans", sans-serif)')
    expect(text).toContain('Text colours: #444444 ×46')
  })
})

describe('check_text', () => {
  it('finds typos, placeholder text, doubled words and repeated blocks', async () => {
    await open()
    answers.set(TEXT_SCRIPT, {
      lang: 'en-US', title: 'Svenson Hair Clinic', host: 'svenson.test',
      blocks: [
        { ref: 'e1', tag: 'h1', text: 'Svenson hair loss treatments' },
        { ref: 'e2', tag: 'p', text: 'We will recieve your request and call you back within a day.' },
        { ref: 'e3', tag: 'p', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.' },
        { ref: 'e4', tag: 'p', text: 'Book the the consultation today.' },
        { ref: 'e5', tag: 'p', text: 'Our specialists have helped thousands of people regain confidence.' },
        { ref: 'e6', tag: 'p', text: 'Our specialists have helped thousands of people regain confidence.' },
      ],
    })
    const text = (await call('check_text')).text
    expect(text).toMatch(/- "recieve" → [^·]*receive/)
    expect(text).not.toContain('"Svenson"')
    expect(text).not.toContain('"consectetur"')
    expect(text).toContain('Placeholder text:\n- "Lorem ipsum" · e3')
    expect(text).toContain('- "the the" · e4')
    expect(text).toContain('- ×2 "Our specialists have helped thousands of people regain confidence." (e5, e6)')
  }, 30_000)
})

describe('seo_check', () => {
  beforeEach(() => {
    answers.set(SEO_SCRIPT, {
      url: 'https://svenson.test/alopecia-page/', title: 'Alopecia', description: '', robots: 'noindex, nofollow', canonical: 'https://svenson.com/alopecia-page/',
      hreflang: ['en https://svenson.test/alopecia-page/'], og: { title: 'Alopecia', description: '', image: 'https://svenson.test/og.jpg', url: 'https://svenson.com/alopecia-page/', type: 'website' },
      twitter: { card: 'summary_large_image', image: '' }, jsonLd: { blocks: 2, types: ['Organization', 'WebPage'], errors: ['Unexpected token } in JSON'] }, microdata: 0,
      words: 820, links: { internal: 40, external: 3, nofollow: 1 }, headings: [1, 5, 8, 0, 0, 0], generator: 'WordPress 6.6.2', images: 14,
    })
  })

  it('reads the page, its header, robots.txt and the sitemap', async () => {
    await open()
    site['HEAD https://svenson.test/alopecia-page/'] = { status: 200, headers: { 'x-robots-tag': 'noindex' } }
    site['GET /robots.txt'] = { status: 200, body: 'User-agent: *\nDisallow: /\n\nSitemap: https://svenson.test/wp-sitemap.xml\n' }
    site['GET https://svenson.test/wp-sitemap.xml'] = { status: 200, body: '<?xml version="1.0"?><urlset><url><loc>https://svenson.test/</loc></url><url><loc>https://svenson.test/alopecia-page/</loc></url></urlset>' }
    const text = (await call('seo_check')).text
    expect(text).toContain('Title (8 chars): "Alopecia" (short: aim for 30–60)')
    expect(text).toContain('Description (0 chars): MISSING')
    expect(text).toContain('Canonical: https://svenson.com/alopecia-page/ (ANOTHER SITE (svenson.com)')
    expect(text).toContain('X-Robots-Tag header "noindex" · NOINDEX (normal on a staging site')
    expect(text).toContain('robots.txt: BLOCKS this page (Disallow: /;')
    expect(text).toContain('Sitemap: https://svenson.test/wp-sitemap.xml · 2 page(s), this page is listed')
    expect(text).toContain('Structured data: 2 JSON-LD block(s): Organization, WebPage · BROKEN JSON')
    expect(text).toContain('og:url https://svenson.com/alopecia-page/ (another site)')
    expect(text).toContain('hreflang: en https://svenson.test/alopecia-page/ (no x-default)')
    expect(text).toContain('Content: 820 words · headings H1 1, H2 5, H3 8')
    expect(requests).toEqual(['HEAD https://svenson.test/alopecia-page/', 'GET /robots.txt', 'GET https://svenson.test/wp-sitemap.xml'])
  })

  it('tries the usual sitemap places when robots.txt names none, and stops at three', async () => {
    await open()
    const text = (await call('seo_check')).text
    expect(text).toContain('robots.txt: not found (404)')
    expect(text).toContain('Sitemap: none found')
    expect(requests.filter((r) => r.startsWith('GET /') && r.includes('sitemap'))).toEqual(['GET /wp-sitemap.xml', 'GET /sitemap_index.xml', 'GET /sitemap.xml'])
  })
})

describe('robotsVerdict', () => {
  it('applies the longest matching rule for every crawler, Allow winning a tie', () => {
    const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /*.pdf$\nDisallow: /private\n# Sitemap: commented\nSitemap: https://x.test/sitemap.xml'
    expect(robotsVerdict(robots, '/alopecia-page/')).toEqual({ blocked: false, sitemaps: ['https://x.test/sitemap.xml'] })
    expect(robotsVerdict(robots, '/wp-admin/options.php')).toMatchObject({ blocked: true, rule: 'Disallow: /wp-admin/' })
    expect(robotsVerdict(robots, '/wp-admin/admin-ajax.php').blocked).toBe(false)
    expect(robotsVerdict(robots, '/files/guide.pdf').blocked).toBe(true)
    expect(robotsVerdict(robots, '/files/guide.pdf?x=1').blocked).toBe(false)
    expect(robotsVerdict(robots, '/private-clinic/').blocked).toBe(true)
  })

  it('treats an empty Disallow as allowing everything', () => {
    expect(robotsVerdict('User-agent: *\nDisallow:\n', '/').blocked).toBe(false)
  })
})
