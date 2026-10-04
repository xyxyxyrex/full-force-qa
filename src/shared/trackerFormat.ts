// The master tracker's layout, and turning drafted issues into rows ready to paste into it.
// Everything here is pure so it can be tested without Electron.

export interface TrackerFormat {
  version: 1
  /** Column names in sheet order. */
  columns: string[]
  /** A few real rows, so the agent can match the team's wording. */
  examples: string[][]
  /** Columns that are dropdowns in the sheet, with their exact options. */
  choices?: Record<string, string[]>
}

export type IssueRow = Record<string, string>

export const MAX_CELL_LENGTH = 5000
export const MAX_ROWS = 60
const MAX_EXAMPLES = 5

/** Reads TSV as Google Sheets copies it: quoted cells may hold tabs, newlines and "" quotes. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const input = text.replace(/^﻿/, '')
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += char
    } else if (char === '"' && cell === '') {
      quoted = true
    } else if (char === '\t') {
      row.push(cell); cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rows.push(row); row = []
    } else cell += char
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export type ParseResult = { ok: true; format: TrackerFormat } | { ok: false; error: string }

/** First row is the header; up to five more become examples. */
export function parseTrackerPaste(text: string): ParseResult {
  const rows = parseTsv(text)
  if (!rows.length) return { ok: false, error: 'Paste the header row and a few example rows from the tracker.' }
  const header = rows[0].map((name) => name.replace(/\s+/g, ' ').trim())
  if (header.filter(Boolean).length < 2) return { ok: false, error: 'The first row should be the tracker\'s column names, separated by tabs. Copy the header row straight from the sheet.' }
  const seen = new Map<string, number>()
  const columns = header.map((name, index) => {
    const base = name || `Column ${index + 1}`
    const count = (seen.get(base.toLowerCase()) || 0) + 1
    seen.set(base.toLowerCase(), count)
    return count === 1 ? base : `${base} (${count})`
  })
  const examples = rows.slice(1, 1 + MAX_EXAMPLES).map((r) => columns.map((_, i) => r[i] ?? ''))
  // Pasting the standard tracker's own header keeps its dropdown options.
  const isStandard = columns.length === STANDARD_TRACKER.columns.length && columns.every((name, i) => name === STANDARD_TRACKER.columns[i])
  return { ok: true, format: { version: 1, columns, examples, ...(isStandard ? { choices: STANDARD_TRACKER.choices } : {}) } }
}

export function isTrackerFormat(value: unknown): value is TrackerFormat {
  const v = value as TrackerFormat
  return !!v && v.version === 1 && Array.isArray(v.columns) && v.columns.length >= 2 && v.columns.every((c) => typeof c === 'string') && Array.isArray(v.examples) && v.examples.every((r) => Array.isArray(r)) && (v.choices === undefined || (typeof v.choices === 'object' && v.choices !== null && Object.values(v.choices).every((o) => Array.isArray(o) && o.every((x) => typeof x === 'string'))))
}

const SCREENSHOT_HEADER = /screenshot|screen shot|image|evidence|sleekshot|capture|proof|attachment|link/i
// Columns other people fill in: the developer's reply and the QA approval after a fix.
const OTHER_PEOPLE_HEADER = /\((dev|pm|crsm)\)|approval|rejection/i

/** The column that holds the screenshot link, guessed from its header. */
export function screenshotColumn(format: TrackerFormat): string | null {
  const mine = format.columns.filter((name) => !OTHER_PEOPLE_HEADER.test(name))
  const strong = mine.find((name) => /screenshot|screen shot|sleekshot|evidence/i.test(name))
  return strong ?? mine.find((name) => SCREENSHOT_HEADER.test(name) && !/^page\b/i.test(name)) ?? null
}

/** The tracker every project uses, so nobody has to paste it. Pasting one in Settings replaces it. */
export const STANDARD_TRACKER: TrackerFormat = {
  version: 1,
  columns: [
    'Page Link', 'Section', 'Screenshot', 'Remarks', 'Priority (QA/PM)', 'Display', 'Status', 'Approval Screenshot(QA)',
    'Reason for Rejection (if applicable)', 'Screenshot and Remarks (Dev)', 'Remarks (PM)', 'Remarks (CRSM)',
  ],
  examples: [],
  choices: {
    Display: ['Desktop', 'Mobile', 'Tablet', 'Mobile & Tablet', 'Desktop and Mobile', 'Desktop and Tablet'],
    Status: ['IN PROGRESS (DEV)', 'COMPLETED (DEV)', 'REJECTED (QA)', 'APPROVED (QA)', 'INVALID (DEV)', 'ENHANCEMENT (QA)', 'PM CLARIFICATION'],
  },
}

// "Mobile and tablet", "tablet & Mobile" and "Mobile & Tablet" are the same choice.
const choiceKey = (text: string) => [...new Set(text.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word && word !== 'and'))].sort().join(' ')
const withoutParentheses = (text: string) => text.replace(/\([^)]*\)/g, ' ')

/** The dropdown option a cell means, or null when it is not one of them. */
export function matchChoice(options: string[], value: string): string | null {
  const wanted = choiceKey(value)
  if (!wanted) return null
  return options.find((option) => choiceKey(option) === wanted) ?? options.find((option) => choiceKey(withoutParentheses(option)) === wanted) ?? null
}

/** What to write in each column, guessed from its header, so the agent fills only QA's columns. */
export function trackerColumnGuide(format: TrackerFormat): Record<string, string> {
  const shot = screenshotColumn(format)
  const guide: Record<string, string> = {}
  format.columns.forEach((name, index) => {
    const shared = new Set(format.examples.map((row) => (row[index] ?? '').trim()).filter(Boolean))
    const options = format.choices?.[name]
    if (options && /^status$/i.test(name)) guide[name] = 'Leave empty: developers and the approval step set it. Only for a suggestion that is not a mismatch with the design, use "ENHANCEMENT (QA)". Allowed values: ' + options.join(' | ')
    else if (options) guide[name] = `Where the issue appears. Exactly one of: ${options.join(' | ')}. The same problem on several breakpoints is one row with the matching combination.`
    else if (OTHER_PEOPLE_HEADER.test(name)) guide[name] = 'Leave empty. Developers, PMs and the QA approval step fill this in later.'
    else if (name === shot) guide[name] = 'Leave empty. Parity fills it with the evidence link.'
    else if (/^page\b.*(link|url)|^url$|^link$/i.test(name)) guide[name] = 'The URL of the page that was checked (openPage.url from get_context).'
    else if (/^section$/i.test(name)) guide[name] = 'The page section and element, for example "Basics section, H2". Add the breakpoint here if there is no better column.'
    else if (/severity|priority|impact/i.test(name)) guide[name] = 'High, Medium or Low (or the values the example rows use).'
    else if (/^(remarks|issue|description|finding|comment)s?$/i.test(name)) guide[name] = 'The issue: breakpoint, what is different, what the design shows and what the live page shows. One issue per row.'
    else if (/^(display|status)$/i.test(name)) guide[name] = shared.size === 1 ? `Use "${[...shared][0]}", as in the example rows.` : 'Leave empty unless the example rows show a value to use.'
  })
  return guide
}

/**
 * Sheets reads a pasted cell that starts with = + - or @ as a formula. A stray "- Button"
 * or injected =IMAGE(...) must stay plain text, so those cells get a leading apostrophe.
 */
export function neutralizeFormula(cell: string): string {
  return /^[=+\-@]/.test(cell) ? `'${cell}` : cell
}

function cleanCell(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, MAX_CELL_LENGTH)
}

export type RowsResult = { ok: true; rows: string[][]; warnings: string[] } | { ok: false; error: string }

/** Maps issue objects (keyed by column name) to cell arrays in column order. */
export function buildRows(format: TrackerFormat, issues: IssueRow[]): RowsResult {
  if (!Array.isArray(issues) || !issues.length) return { ok: false, error: 'There are no rows to copy.' }
  if (issues.length > MAX_ROWS) return { ok: false, error: `At most ${MAX_ROWS} rows can be copied at once.` }
  const byLowerName = new Map(format.columns.map((name) => [name.toLowerCase(), name]))
  const warnings: string[] = []
  const rows: string[][] = []
  for (const [index, issue] of issues.entries()) {
    const cells: Record<string, string> = {}
    for (const [key, value] of Object.entries(issue || {})) {
      const column = byLowerName.get(key.trim().toLowerCase())
      if (!column) return { ok: false, error: `Row ${index + 1} uses a column that is not in the tracker: "${key}". The columns are: ${format.columns.join(', ')}.` }
      const text = cleanCell(value)
      const options = format.choices?.[column]
      if (options && text.trim()) {
        const choice = matchChoice(options, text)
        if (!choice) return { ok: false, error: `Row ${index + 1}: "${text}" is not an option for ${column}. Use exactly one of: ${options.join(' | ')}.` }
        cells[column] = choice
      } else cells[column] = text
    }
    const row = format.columns.map((name) => neutralizeFormula(cells[name] ?? ''))
    if (row.every((cell) => cell === '')) warnings.push(`Row ${index + 1} is empty.`)
    rows.push(row)
  }
  return { ok: true, rows, warnings }
}

const needsQuoting = /[\t\n\r"]/

/** Tab-separated rows, no header, in tracker column order. */
export function buildTsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => (needsQuoting.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join('\t')).join('\n')
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A plain table; links become clickable and line breaks stay inside their cell. */
export function buildHtml(rows: string[][]): string {
  const cell = (text: string) => escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')
  return `<table>${rows.map((row) => `<tr>${row.map((text) => `<td>${cell(text)}</td>`).join('')}</tr>`).join('')}</table>`
}
