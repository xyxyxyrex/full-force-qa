import { describe, expect, it } from 'vitest'
import { buildHtml, buildRows, buildTsv, neutralizeFormula, parseTrackerPaste, parseTsv, rowView, screenshotColumn, STANDARD_TRACKER, trackerColumnGuide, type TrackerFormat } from './trackerFormat'

const format: TrackerFormat = {
  version: 1,
  columns: ['Page', 'Issue', 'Expected', 'Screenshot', 'Severity'],
  examples: [['Home', 'Heading too small', '32px', 'https://x.test/a', 'High']],
}

describe('parseTsv', () => {
  it('parses plain rows and CRLF line endings', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('keeps tabs, newlines and doubled quotes inside quoted cells', () => {
    expect(parseTsv('h1\th2\n"line one\nline two"\t"say ""hi""\tthere"\n')).toEqual([['h1', 'h2'], ['line one\nline two', 'say "hi"\tthere']])
  })

  it('skips blank lines and a byte-order mark', () => {
    expect(parseTsv('﻿a\tb\n\n\t\nc\td')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('does not treat a quote in the middle of a cell as quoting', () => {
    expect(parseTsv('5" nail\tb')).toEqual([['5" nail', 'b']])
  })
})

describe('parseTrackerPaste', () => {
  it('reads the header and example rows, padding short rows', () => {
    const result = parseTrackerPaste('Page\tIssue\tSeverity\nHome\tBroken nav\nAbout\tWrong font\tLow')
    expect(result).toEqual({ ok: true, format: { version: 1, columns: ['Page', 'Issue', 'Severity'], examples: [['Home', 'Broken nav', ''], ['About', 'Wrong font', 'Low']] } })
  })

  it('names blank and duplicate columns', () => {
    const result = parseTrackerPaste('Page\t\tNotes\tNotes\nx\ty\tz\tw')
    expect(result.ok && result.format.columns).toEqual(['Page', 'Column 2', 'Notes', 'Notes (2)'])
  })

  it('keeps at most five examples', () => {
    const rows = Array.from({ length: 9 }, (_, i) => `r${i}\tx`).join('\n')
    const result = parseTrackerPaste(`A\tB\n${rows}`)
    expect(result.ok && result.format.examples).toHaveLength(5)
  })

  it('rejects empty input and a single-column header', () => {
    expect(parseTrackerPaste('')).toMatchObject({ ok: false })
    expect(parseTrackerPaste('Only one column\nvalue')).toMatchObject({ ok: false })
  })
})

describe('screenshotColumn', () => {
  it('finds the screenshot column from its header', () => {
    expect(screenshotColumn(format)).toBe('Screenshot')
    expect(screenshotColumn({ ...format, columns: ['Page', 'Issue', 'Sleekshot link', 'Severity', 'Status'] })).toBe('Sleekshot link')
    expect(screenshotColumn({ ...format, columns: ['A', 'B', 'C', 'D', 'E'] })).toBeNull()
  })
})

describe('neutralizeFormula', () => {
  it('protects cells Sheets would read as formulas', () => {
    expect(neutralizeFormula('=IMAGE("https://evil")')).toBe('\'=IMAGE("https://evil")')
    expect(neutralizeFormula('+1')).toBe("'+1")
    expect(neutralizeFormula('-')).toBe("'-")
    expect(neutralizeFormula('- Button label differs')).toBe("'- Button label differs")
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('leaves ordinary text alone', () => {
    expect(neutralizeFormula('Heading is 28px, expected 32px')).toBe('Heading is 28px, expected 32px')
    expect(neutralizeFormula('')).toBe('')
    expect(neutralizeFormula('https://x.test/a')).toBe('https://x.test/a')
  })
})

describe('buildRows', () => {
  it('orders cells by column, matches names case-insensitively and fills gaps', () => {
    const result = buildRows(format, [{ issue: 'Heading too small', PAGE: 'Home', severity: 'High' }])
    expect(result).toEqual({ ok: true, warnings: [], rows: [['Home', 'Heading too small', '', '', 'High']] })
  })

  it('neutralizes formulas, strips tabs and control characters, clamps length', () => {
    const result = buildRows(format, [{ Issue: '=HYPERLINK("x")', Expected: 'a\tb\u0007c', Page: 'x'.repeat(6000) }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0][1]).toBe('\'=HYPERLINK("x")')
    expect(result.rows[0][2]).toBe('a bc')
    expect(result.rows[0][0]).toHaveLength(5000)
  })

  it('refuses unknown columns with the valid names, and bad row counts', () => {
    expect(buildRows(format, [{ Nope: 'x' }])).toMatchObject({ ok: false, error: expect.stringContaining('Page, Issue, Expected, Screenshot, Severity') })
    expect(buildRows(format, [])).toMatchObject({ ok: false })
    expect(buildRows(format, Array.from({ length: 61 }, () => ({ Page: 'x' })))).toMatchObject({ ok: false })
  })

  it('warns about an empty row', () => {
    const result = buildRows(format, [{}])
    expect(result.ok && result.warnings).toHaveLength(1)
  })
})

describe('buildTsv', () => {
  it('quotes cells that contain tabs, quotes or line breaks', () => {
    expect(buildTsv([['a', 'b'], ['line1\nline2', 'say "hi"']])).toBe('a\tb\n"line1\nline2"\t"say ""hi"""')
  })

  it('round-trips through parseTsv', () => {
    const rows = [['Home', 'two\nlines', 'He said "no"', ''], ["'=x", 'plain', 'a', 'b']]
    expect(parseTsv(buildTsv(rows))).toEqual(rows.map((r) => r))
  })
})

describe('buildHtml', () => {
  it('escapes markup, keeps line breaks and links URLs', () => {
    const html = buildHtml([['<b>x</b> & y', 'see https://x.test/a?b=1\nnext']])
    expect(html).toBe('<table><tr><td>&lt;b&gt;x&lt;/b&gt; &amp; y</td><td>see <a href="https://x.test/a?b=1">https://x.test/a?b=1</a><br>next</td></tr></table>')
  })
})

describe('standard tracker', () => {
  const pasted = 'Page Link\tSection\tScreenshot\tRemarks\t"Priority\n(QA/PM)"\tDisplay\tStatus\tApproval Screenshot(QA)\t"Reason for Rejection\n(if applicable)"\t"Screenshot and Remarks \n(Dev)"\t"Remarks \n(PM)"\tRemarks (CRSM)'

  it('matches the header copied from the sheet, line breaks included', () => {
    const parsed = parseTrackerPaste(pasted)
    expect(parsed.ok && parsed.format.columns).toEqual(STANDARD_TRACKER.columns)
  })

  it('picks the QA screenshot column, not the developer or approval ones', () => {
    expect(screenshotColumn(STANDARD_TRACKER)).toBe('Screenshot')
    expect(screenshotColumn({ ...STANDARD_TRACKER, columns: [...STANDARD_TRACKER.columns].reverse() })).toBe('Screenshot')
  })

  it('tells the agent to fill only QA columns', () => {
    const guide = trackerColumnGuide(STANDARD_TRACKER)
    expect(guide['Page Link']).toMatch(/URL of the page/)
    expect(guide['Remarks']).toMatch(/issue/i)
    expect(guide['Priority (QA/PM)']).toMatch(/High, Medium or Low/)
    for (const name of ['Approval Screenshot(QA)', 'Reason for Rejection (if applicable)', 'Screenshot and Remarks (Dev)', 'Remarks (PM)']) expect(guide[name]).toMatch(/Leave empty/)
    expect(guide['Screenshot']).toMatch(/evidence link/)
    expect(guide['Status']).toMatch(/Leave empty.*ENHANCEMENT \(QA\)/)
    expect(guide['Display']).toMatch(/Desktop and Tablet/)
  })

  it('keeps the dropdown options when the standard header is pasted', () => {
    const parsed = parseTrackerPaste(pasted)
    expect(parsed.ok && parsed.format.choices).toEqual(STANDARD_TRACKER.choices)
  })

  it('accepts a dropdown value in any wording or order and writes the exact option', () => {
    const row = (Display: string, Status = '') => buildRows(STANDARD_TRACKER, [{ Remarks: 'x', Display, Status }])
    const cells = (r: ReturnType<typeof row>) => (r.ok ? [r.rows[0][5], r.rows[0][6]] : r.error)
    expect(cells(row('desktop'))).toEqual(['Desktop', ''])
    expect(cells(row('tablet and mobile'))).toEqual(['Mobile & Tablet', ''])
    expect(cells(row('Mobile & Desktop'))).toEqual(['Desktop and Mobile', ''])
    expect(cells(row('Tablet, Desktop'))).toEqual(['Desktop and Tablet', ''])
    expect(cells(row('Desktop', 'enhancement'))).toEqual(['Desktop', 'ENHANCEMENT (QA)'])
    expect(cells(row('Desktop', 'pm clarification'))).toEqual(['Desktop', 'PM CLARIFICATION'])
  })

  it('rejects values that are not in the dropdown and says what is allowed', () => {
    const all = buildRows(STANDARD_TRACKER, [{ Remarks: 'x', Display: 'Desktop, Tablet and Mobile' }])
    expect(!all.ok && all.error).toMatch(/not an option for Display.*Desktop and Tablet/)
    const status = buildRows(STANDARD_TRACKER, [{ Remarks: 'x', Status: 'Open' }])
    expect(!status.ok && status.error).toMatch(/not an option for Status/)
  })

  it('builds a row with the right cells filled', () => {
    const built = buildRows(STANDARD_TRACKER, [{ 'Page Link': 'https://x.test/a', Section: 'Hero, H1', Remarks: 'Desktop: font-size 28px, design ≈32px', 'Priority (QA/PM)': 'Medium' }])
    expect(built.ok && built.rows[0]).toEqual(['https://x.test/a', 'Hero, H1', '', 'Desktop: font-size 28px, design ≈32px', 'Medium', '', '', '', '', '', '', ''])
  })
})

describe('rowView', () => {
  const row = (cells: Record<string, string>) => buildRows(STANDARD_TRACKER, [cells]).ok ? (buildRows(STANDARD_TRACKER, [cells]) as { rows: string[][] }).rows[0] : []

  it('picks out what a finding says in the standard tracker and leaves empty columns out', () => {
    const view = rowView(STANDARD_TRACKER, row({ 'Page Link': 'https://x.test/a', Section: 'Hero, H1', Remarks: 'Desktop: font-size 28px, design ≈32px', 'Priority (QA/PM)': 'High', Display: 'Desktop and Mobile' }))
    expect(view).toEqual({
      title: 'Hero, H1', body: 'Desktop: font-size 28px, design ≈32px', link: 'https://x.test/a', extras: [],
      badges: [{ label: 'Priority', value: 'High', kind: 'severity' }, { label: 'Display', value: 'Desktop and Mobile', kind: 'display' }],
    })
  })

  it('does not mistake developer, PM or approval columns for the finding', () => {
    const cells = ['', 'Footer', '', '', '', '', '', '', '', 'Dev: fixed in 1.2', 'PM: please confirm', '']
    const view = rowView(STANDARD_TRACKER, cells)
    expect(view.body).toBe('')
    expect(view.extras).toEqual([{ label: 'Screenshot and Remarks (Dev)', value: 'Dev: fixed in 1.2' }, { label: 'Remarks (PM)', value: 'PM: please confirm' }])
  })

  it('keeps the screenshot link out of the details, since the picture is shown instead', () => {
    const view = rowView(STANDARD_TRACKER, row({ Remarks: 'x', Screenshot: 'https://shots.test/1.webp' }))
    expect(view.extras).toEqual([])
  })

  it('works for a tracker with other column names', () => {
    const format: TrackerFormat = { version: 1, columns: ['Page', 'Problem', 'Expected', 'Screenshot', 'Severity'], examples: [] }
    const view = rowView(format, ['Home', 'Heading is 28px, the design shows 32px', '32px', '', 'High'])
    expect(view.body).toBe('Heading is 28px, the design shows 32px')
    expect(view.title).toBe('Heading is 28px, the design shows 32px')
    expect(view.badges).toEqual([{ label: 'Priority', value: 'High', kind: 'severity' }])
    expect(view.extras).toEqual([{ label: 'Page', value: 'Home' }, { label: 'Expected', value: '32px' }])
  })
})

describe('short remarks and sections', () => {
  const row = (cells: Record<string, string>) => buildRows(STANDARD_TRACKER, [{ Display: 'Desktop', ...cells }])

  it('ships the team\'s own remarks as the examples to copy, all of them valid rows', () => {
    expect(STANDARD_TRACKER.examples.length).toBeGreaterThanOrEqual(10)
    const remarks = STANDARD_TRACKER.examples.map((example) => example[STANDARD_TRACKER.columns.indexOf('Remarks')])
    expect(remarks).toContain('wrong image')
    expect(remarks).toContain('remove this duplicated section')
    expect(remarks.every((text) => text.length <= 100)).toBe(true)
    for (const example of STANDARD_TRACKER.examples) {
      expect(example).toHaveLength(STANDARD_TRACKER.columns.length)
      expect(buildRows(STANDARD_TRACKER, [Object.fromEntries(STANDARD_TRACKER.columns.map((name, i) => [name, example[i]]).filter(([, value]) => value))]).ok).toBe(true)
    }
  })

  it('keeps the examples when the standard header is pasted without any rows', () => {
    const header = STANDARD_TRACKER.columns.join('\t')
    const parsed = parseTrackerPaste(header)
    expect(parsed.ok && parsed.format.examples).toEqual(STANDARD_TRACKER.examples)
  })

  it('uses the pasted rows instead when the person pastes their own', () => {
    const own = ['https://x.test', 'Hero', '', 'my own remark', '', 'Desktop', '', '', '', '', '', ''].join('\t')
    const parsed = parseTrackerPaste(`${STANDARD_TRACKER.columns.join('\t')}\n${own}`)
    expect(parsed.ok && parsed.format.examples).toEqual([['https://x.test', 'Hero', '', 'my own remark', '', 'Desktop', '', '', '', '', '', '']])
  })

  it('accepts the short wording the team uses', () => {
    expect(row({ Section: 'Hero', Remarks: 'h1 title should be 2 lines' }).ok).toBe(true)
    expect(row({ Section: 'Treatment options', Remarks: 'H2 should be bold (700) and a one liner. figma has negative 3% letter spacing' }).ok).toBe(true)
  })

  it('sends back a remark that rambles, and says what to do', () => {
    const result = row({ Section: 'Hero', Remarks: 'The heading on the live page is rendered at a font size of 28px with a line height of 34px, whereas the design appears to show a considerably larger heading of roughly 32px with a line height of about 38px, and it also sits lower. '.repeat(2) })
    expect(!result.ok && result.error).toMatch(/Row 1: Remarks is \d+ characters\. Remarks are one short line that tells the developer what to change/)
    expect(!result.ok && result.error).toMatch(/Shorten it to 200 characters or fewer/)
  })

  it('sends back a section that is an element selector or a sentence', () => {
    const result = row({ Section: 'Basics section, H2 "The Basics of Alopecia Areata" inside div.elementor-widget', Remarks: 'font size should be 32px' })
    expect(!result.ok && result.error).toMatch(/Section is \d+ characters\. Section is the section's name in a few words/)
  })

  it('does not apply the limits to the other Remarks columns or to custom trackers', () => {
    const long = 'x'.repeat(400)
    expect(row({ Remarks: 'ok', 'Remarks (PM)': long, 'Remarks (CRSM)': long }).ok).toBe(true)
    const custom: TrackerFormat = { version: 1, columns: ['Page', 'Issue'], examples: [] }
    expect(buildRows(custom, [{ Page: 'Home', Issue: long }]).ok).toBe(true)
  })

  it('tells the agent the same thing in the column guide', () => {
    const guide = trackerColumnGuide(STANDARD_TRACKER)
    expect(guide.Remarks).toMatch(/One short line telling the developer what to change/)
    expect(guide.Remarks).toMatch(/No breakpoint/)
    expect(guide.Section).toMatch(/Header, Navbar, Hero, Footer/)
    expect(guide.Section).toMatch(/Never an element selector/)
  })
})
