import { supabase } from './supabase'
import { cellText, detectDelimiter, parseCsv, toCsv } from './csv'

/** Calls an Edge Function and returns its JSON, throwing the function's own error message when it fails. */
export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> })
  if (error) {
    let message = error.message
    let issues: unknown
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try { const j = await ctx.json(); if (j?.error) message = j.error; issues = j?.issues } catch { /* keep default message */ }
    }
    throw Object.assign(new Error(message), issues ? { issues } : {})
  }
  return data as T
}

export function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
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

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

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
