import { describe, expect, it } from 'vitest'
import { prepareRows } from '../src/lib/importPrep'
import { OPTOUT_RE } from '../src/lib/types'

const head = ['Client', 'Mobile', 'Unit', 'Status']
const extras = [{ index: 0, key: 'client' }, { index: 2, key: 'unit' }]
const run = (rows: string[][], existing: string[] = []) =>
  prepareRows([head, ...rows], 1, 3, extras, (v) => OPTOUT_RE.test(v), new Set(existing))

describe('A/E. the same valid phone imported twice', () => {
  it('drops an exact repeat inside one file and reports which row it repeats', () => {
    const r = run([['Sara', '01010354164', 'A1', ''], ['Sara', '01010354164', 'A1', '']])
    expect(r.ready).toHaveLength(1)
    expect(r.duplicates).toEqual([{ n: 3, phone: '+201010354164', of: 2 }])
  })

  it('is deterministic: the same file gives the same report every time', () => {
    const rows = [['Sara', '01010354164', 'A1', ''], ['Omar', '01112223334', 'B2', ''], ['Sara', '+20 101 035 4164', 'A1', '']]
    expect(JSON.stringify(run(rows))).toBe(JSON.stringify(run(rows)))
  })

  it('uploading the same dataset again reports every number as already existing, none as new', () => {
    const rows = [['Sara', '01010354164', 'A1', ''], ['Omar', '01112223334', 'B2', '']]
    const second = run(rows, ['+201010354164', '+201112223334'])
    expect(second.fresh).toBe(0)
    expect(second.existing).toBe(2)
  })
})

describe('B/C. formatting-only differences are the same contact', () => {
  it('spaces, hyphens, parentheses, local and international forms collapse to one duplicate', () => {
    const r = run([['Sara', '01010354164', 'A1', ''], ['Sara', '+20 (101) 035-4164', 'A1', ''], ['Sara', '00201010354164', 'A1', '']])
    expect(r.ready).toHaveLength(1)
    expect(r.duplicates.map((d) => d.n)).toEqual([3, 4])
  })
})

describe('D/I. the same phone with different names or units', () => {
  it('keeps both associations and lists the second as a conflict instead of overwriting', () => {
    const r = run([['Sara', '01010354164', 'A1', ''], ['Sara Hassan', '01010354164', 'B7', '']])
    expect(r.ready.map((p) => p.extra.unit)).toEqual(['A1', 'B7'])
    expect(r.conflicts).toEqual([{ n: 3, phone: '+201010354164', of: 2 }])
    expect(r.duplicates).toHaveLength(0)
  })
})

describe('G. bad phone values are never silently dropped', () => {
  it('rejects with row number, original value and reason', () => {
    const r = run([['A', '', '1', ''], ['B', 'N/A', '2', ''], ['C', '0101', '3', ''], ['D', '1010354164', '4', ''], ['E', '01010354164', '5', '']])
    expect(r.ready).toHaveLength(1)
    expect(r.rejected.map((x) => [x.n, x.raw])).toEqual([[2, ''], [3, 'N/A'], [4, '0101'], [5, '1010354164']])
    expect(r.rejected.every((x) => x.reason.length > 0)).toBe(true)
  })

  it('skips fully empty rows without counting them as errors', () => {
    const r = run([['', '', '', ''], ['Sara', '01010354164', 'A1', '']])
    expect(r.rejected).toHaveLength(0)
    expect(r.ready).toHaveLength(1)
  })
})

describe('H. different phones of the same client stay separate contacts', () => {
  it('imports two numbers for one name as two contacts', () => {
    const r = run([['Sara', '01010354164', 'A1', ''], ['Sara', '01112223334', 'A1', '']])
    expect(r.ready.map((p) => p.phone)).toEqual(['+201010354164', '+201112223334'])
    expect(r.duplicates).toHaveLength(0)
  })
})

describe('J. opt-out survives duplicates', () => {
  it('an opted-out row opts out every row of that number in the file', () => {
    const r = run([['Sara', '01010354164', 'A1', ''], ['Sara', '+201010354164', 'B2', 'opted out']])
    expect(r.ready).toHaveLength(2)
    expect(r.ready.every((p) => p.optout)).toBe(true)
  })

  it('does not opt out other numbers', () => {
    const r = run([['Sara', '01010354164', 'A1', 'stop'], ['Omar', '01112223334', 'B2', '']])
    expect(r.ready.map((p) => p.optout)).toEqual([true, false])
  })
})

describe('original value', () => {
  it('keeps what was typed beside the canonical number', () => {
    const r = run([['Sara', ' 010-1035-4164 ', 'A1', '']])
    expect(r.ready[0]).toMatchObject({ phone: '+201010354164', original: '010-1035-4164' })
  })
})
