import { describe, expect, it } from 'vitest'
import { cellText, detectDelimiter, parseCsv } from '../src/lib/csv'
import { prepareRows } from '../src/lib/importPrep'

describe('CSV reading', () => {
  it('keeps leading zeros and plus signs as text', () => {
    expect(parseCsv('Client,Mobile\nSara,01010354164\nOmar,+201112223334')).toEqual([['Client', 'Mobile'], ['Sara', '01010354164'], ['Omar', '+201112223334']])
  })
  it('reads quoted cells with commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']])
  })
  it('accepts Windows and old Mac line endings and skips empty rows', () => {
    expect(parseCsv('a,b\r\n\r\n1,2\r3,4\n,\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })
  it('detects the delimiter Excel used for the computer\'s region', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(detectDelimiter('single')).toBe(',')
  })
  it('reads Arabic text unchanged', () => {
    expect(parseCsv('الاسم,الموبايل\nسارة,٠١٠١٠٣٥٤١٦٤')[1]).toEqual(['سارة', '٠١٠١٠٣٥٤١٦٤'])
  })
})

describe('Excel cells', () => {
  it('writes long whole numbers in full, never as 1.01E+9', () => {
    expect(cellText(201010354164)).toBe('201010354164')
  })
  it('empty and boolean cells become empty text', () => {
    expect([cellText(null), cellText(undefined), cellText(true)]).toEqual(['', '', ''])
  })
  it('a phone column that Excel stored as a number loses its zero, and the import refuses it instead of guessing', () => {
    const sheet = [['Client', 'Mobile'], ['Sara', cellText(1010354164)]]
    const r = prepareRows(sheet, 1, -1, [], () => false)
    expect(r.ready).toHaveLength(0)
    expect(r.rejected[0]).toMatchObject({ n: 2, raw: '1010354164' })
    expect(r.rejected[0].reason).toMatch(/leading 0/)
  })
})

describe('large datasets', () => {
  it('prepares 5,000 rows, with repeats and bad values, quickly and with every row accounted for', () => {
    const rows: string[][] = [['Client', 'Mobile']]
    for (let i = 0; i < 5000; i++) rows.push([`Client ${i}`, i % 10 === 0 ? 'N/A' : `0101${String(10000000 + (i % 2500)).slice(1)}`])
    const t0 = Date.now()
    const r = prepareRows(rows, 1, -1, [{ index: 0, key: 'client' }], () => false)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.ready.length + r.rejected.length + r.duplicates.length).toBe(5000)
    expect(r.rejected).toHaveLength(500)
  })
})
