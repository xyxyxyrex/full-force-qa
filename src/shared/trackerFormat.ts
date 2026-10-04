// The master tracker's layout, and turning drafted issues into rows ready to paste into it.
// Everything here is pure so it can be tested without Electron.

export interface TrackerFormat {
  version: 1
  /** Column names in sheet order. */
  columns: string[]
  /** A few real rows, so the agent can match the team's wording. */
  examples: string[][]
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
  return { ok: true, format: { version: 1, columns, examples } }
}

export function isTrackerFormat(value: unknown): value is TrackerFormat {
  const v = value as TrackerFormat
  return !!v && v.version === 1 && Array.isArray(v.columns) && v.columns.length >= 2 && v.columns.every((c) => typeof c === 'string') && Array.isArray(v.examples) && v.examples.every((r) => Array.isArray(r))
}

const SCREENSHOT_HEADER = /screenshot|screen shot|image|evidence|sleekshot|capture|proof|attachment|link/i

/** The column that holds the screenshot link, guessed from its header. */
export function screenshotColumn(format: TrackerFormat): string | null {
  const strong = format.columns.find((name) => /screenshot|screen shot|sleekshot|evidence/i.test(name))
  return strong ?? format.columns.find((name) => SCREENSHOT_HEADER.test(name)) ?? null
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
      cells[column] = cleanCell(value)
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
