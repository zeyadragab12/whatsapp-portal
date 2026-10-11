import { describe, expect, it } from 'vitest'
import { isE164, normalizePhone, parsePhone, phoneProblem } from '../src/lib/phone'

const EG = '+201010354164'

describe('B/C. one Egyptian contact, however it is written', () => {
  it.each([
    '01010354164', '+201010354164', '00201010354164', '201010354164',
    '0101 035 4164', '010-1035-4164', '(010) 1035 4164', '+20 101 035 4164', ' +20-(101)-035-4164 ',
    '٠١٠١٠٣٥٤١٦٤', '＋201010354164',
  ])('%s -> +201010354164', (raw) => {
    expect(parsePhone(raw)).toEqual({ ok: true, e164: EG })
    expect(normalizePhone(raw)).toBe(EG)
  })

  it('drops a typed extension, which is not part of a WhatsApp number', () => {
    expect(normalizePhone('01010354164 ext 55')).toBe(EG)
  })

  it('keeps international numbers of other countries as they are', () => {
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567')
    expect(normalizePhone('00971501234567')).toBe('+971501234567')
  })
})

describe('G. missing, blank, malformed and ambiguous values', () => {
  it.each([
    [null, 'The phone is empty'],
    [undefined, 'The phone is empty'],
    ['', 'The phone is empty'],
    ['   ', 'The phone is empty'],
    ['NULL', 'The phone is a placeholder, not a number'],
    ['N/A', 'The phone is a placeholder, not a number'],
    ['n/a', 'The phone is a placeholder, not a number'],
    ['-', 'The phone is a placeholder, not a number'],
  ])('%j is refused (%s)', (raw, reason) => {
    expect(parsePhone(raw)).toEqual({ ok: false, reason })
  })

  it('refuses too short, too long, letters and misplaced plus', () => {
    expect(phoneProblem('0101')).toBe('The phone is too short')
    expect(phoneProblem('+2010103541640000000')).toBe('The phone is too long')
    expect(phoneProblem('010abc35416')).toBe('The phone contains letters or symbols')
    expect(phoneProblem('0101+0354164')).toBe('The + is in the wrong place')
    expect(phoneProblem('+0101035416')).toMatch(/country code is missing/)
  })

  it('refuses invalid country codes and numbers that are not valid for their country', () => {
    expect(phoneProblem('+99999999999')).not.toBeNull()
    expect(phoneProblem('+20 123')).not.toBeNull()
    expect(isE164(normalizePhone('+20 123'))).toBe(false)
  })

  it('flags, and never guesses, a number whose leading zero Excel dropped', () => {
    expect(phoneProblem('1010354164')).toMatch(/leading 0 looks lost/)
    expect(parsePhone(1010354164)).toMatchObject({ ok: false })
  })

  it('flags scientific notation from a spreadsheet', () => {
    expect(phoneProblem('2.01010354164E+11')).toMatch(/scientific notation/)
  })

  it('does not guess a country for a foreign number written without its plus', () => {
    expect(phoneProblem('971501234567')).not.toBeNull()
  })

  it('never turns an invalid value into a valid-looking E.164', () => {
    for (const raw of ['1010354164', '12345678', '99999999999', 'abc', '+', '++201010354164']) {
      expect(isE164(normalizePhone(raw))).toBe(false)
    }
  })
})
