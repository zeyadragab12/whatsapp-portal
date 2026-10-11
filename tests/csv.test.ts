import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from '../src/lib/csv'

describe('exports cannot carry spreadsheet formulas', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', '\r=1', '=HYPERLINK("http://evil","x")'])('neutralizes %j', (v) => {
    expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/)
  })
  it('leaves ordinary text alone and quotes commas, quotes and newlines', () => {
    expect(csvCell('Sara Hassan')).toBe('Sara Hassan')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })
  it('writes null as empty and keeps a UTF-8 marker for Arabic in Excel', () => {
    expect(csvCell(null)).toBe('')
    expect(toCsv([['اسم', 'x']]).startsWith('﻿')).toBe(true)
  })
  it('a formula in any column of a report is neutralized', () => {
    expect(toCsv([['Row', 'Reason'], ['2', '=cmd|calc']])).toContain("'=cmd|calc")
  })
})
