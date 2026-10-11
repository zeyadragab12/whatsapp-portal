import { supabase } from './supabase'

/** Calls an Edge Function and returns its JSON, throwing the function's own error message when it fails. */
export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> })
  if (error) {
    let message = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try { const j = await ctx.json(); if (j?.error) message = j.error } catch { /* keep default message */ }
    }
    throw new Error(message)
  }
  return data as T
}

export function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    let s = v === null ? '' : String(v)
    if (/^[=+\-@]/.test(s)) s = `'${s}` // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** Reads every page of a query: the database returns at most 1000 rows per request. */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await page(from, from + 999)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

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

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Turns an Excel cell into the text a person would see: dates read naturally and long numbers never turn into 1.01E+9. */
function cellText(v: unknown): string {
  if (v === null || v === undefined || typeof v === 'boolean') return ''
  if (v instanceof Date) return v.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fullwide', { useGrouping: false }) : String(v)
  return String(v).trim()
}

/** Reads a CSV or Excel (.xlsx) file into rows of text. Anything else is refused with a clear reason. */
export async function readTable(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase()
  if (file.size === 0) throw new Error('The file is empty.')
  if (file.size > MAX_IMPORT_BYTES) throw new Error('The file is larger than 5 MB. Split it into smaller files.')
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported. In Excel choose File, Save As, Excel Workbook (.xlsx), then upload that file.')
  if (name.endsWith('.csv')) {
    const text = (await file.text()).replace(/^\ufeff/, '')
    return parseCsv(text, detectDelimiter(text))
  }
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser')   // loaded only when an Excel file is chosen
    const sheet = await readSheet(file)
    return sheet.map((r) => r.map(cellText)).filter((r) => r.some((c) => c !== ''))
  }
  throw new Error('Only CSV and Excel (.xlsx) files can be imported.')
}
