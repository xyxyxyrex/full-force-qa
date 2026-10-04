import { describe, expect, it } from 'vitest'
import { buildHtml, buildRows, buildTsv, neutralizeFormula, parseTrackerPaste, parseTsv, screenshotColumn, STANDARD_TRACKER, trackerColumnGuide, type TrackerFormat } from './trackerFormat'

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
    expect(guide['Status']).toMatch(/Leave empty/)
  })

  it('copies a Status that every example row shares', () => {
    const examples = [['', '', '', '', '', '', 'Open', '', '', '', '', ''], ['', '', '', '', '', '', 'Open', '', '', '', '', '']]
    expect(trackerColumnGuide({ ...STANDARD_TRACKER, examples })['Status']).toBe('Use "Open", as in the example rows.')
  })

  it('builds a row with the right cells filled', () => {
    const built = buildRows(STANDARD_TRACKER, [{ 'Page Link': 'https://x.test/a', Section: 'Hero, H1', Remarks: 'Desktop: font-size 28px, design ≈32px', 'Priority (QA/PM)': 'Medium' }])
    expect(built.ok && built.rows[0]).toEqual(['https://x.test/a', 'Hero, H1', '', 'Desktop: font-size 28px, design ≈32px', 'Medium', '', '', '', '', '', '', ''])
  })
})
