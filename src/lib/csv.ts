/** One CSV cell. A cell that starts with = + - @ (or a tab or carriage return) would run as a formula in Excel, so it gets a leading apostrophe. */
export function csvCell(v: string | number | null): string {
  let s = v === null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const toCsv = (rows: (string | number | null)[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n')

/** Excel exports CSV with a comma, a semicolon or a tab depending on the computer's region. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (c: string) => first.split(c).length - 1
  const best = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]
  return count(best) > 0 ? best : ','
}

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim())) rows.push(row)
  return rows
}

/** Turns an Excel cell into the text a person would see: dates read naturally and long numbers never turn into 1.01E+9. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || typeof v === 'boolean') return ''
  if (v instanceof Date) return v.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fullwide', { useGrouping: false }) : String(v)
  return String(v).trim()
}

