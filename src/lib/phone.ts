import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max'

/** Egypt is the region the client data is written in, so a number without a country code is read as Egyptian. */
export const DEFAULT_REGION: CountryCode = 'EG'

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: string }

/** Arabic-Indic, Persian and full-width digits (and the full-width plus) become plain ones. */
const asciiDigits = (s: string) => s
  .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
  .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10))
  .replace(/＋/g, '+')

const PLACEHOLDER = /^(null|nil|none|n\/?a|#n\/?a|undefined|-+|—+|\.+)$/i
const SCIENTIFIC = /^\d(\.\d+)?e[+-]?\d+$/i
const EXTENSION = /\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i

/** Cleans a typed or imported phone and works out its canonical E.164 form, or why it cannot be used. Never guesses. */
export function parsePhone(raw: unknown, region: CountryCode = DEFAULT_REGION): PhoneResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'The phone is empty' }
  if (typeof raw === 'number') return { ok: false, reason: 'The phone is a spreadsheet number, which loses its leading zero and plus sign. Save the column as text' }
  const text = asciiDigits(String(raw)).trim()
  if (!text) return { ok: false, reason: 'The phone is empty' }
  if (PLACEHOLDER.test(text)) return { ok: false, reason: 'The phone is a placeholder, not a number' }
  if (SCIENTIFIC.test(text)) return { ok: false, reason: 'The phone looks like a spreadsheet number that lost its digits (scientific notation). Save the column as text' }

  const s = text.replace(EXTENSION, '').replace(/[\s\-().]/g, '')
  if (/[^\d+]/.test(s)) return { ok: false, reason: 'The phone contains letters or symbols' }
  const digits = s.replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'The phone has no digits' }
  if (/.\+/.test(s) || (s.match(/\+/g) ?? []).length > 1) return { ok: false, reason: 'The + is in the wrong place' }

  // Excel reads 01010354164 as the number 1010354164: the lost zero is a guess we will not make
  if (/^1\d{9}$/.test(s)) return { ok: false, reason: 'The leading 0 looks lost (a spreadsheet often drops it). Write it as 01… or +20…' }

  const p = parsePhoneNumberFromString(s, region)
  if (p?.isValid() && /^\+[1-9]\d{7,14}$/.test(p.number)) return { ok: true, e164: p.number }

  if (/^\+0/.test(s)) return { ok: false, reason: 'The country code is missing (a + cannot be followed by 0)' }
  if (digits.length < 8) return { ok: false, reason: 'The phone is too short' }
  if (digits.length > 15) return { ok: false, reason: 'The phone is too long' }
  if (!s.startsWith('+') && !/^00/.test(s) && !/^0\d/.test(s)) return { ok: false, reason: 'The country code is missing. Start the number with + and the country code' }
  return { ok: false, reason: 'This is not a valid phone number' }
}

/** The canonical E.164 form when the phone is valid; otherwise the cleaned text, which `isE164` rejects. */
export function normalizePhone(raw: string): string {
  const r = parsePhone(raw)
  return r.ok ? r.e164 : asciiDigits(raw ?? '').replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, '').replace(/[\s\-().]/g, '')
}

export const isE164 = (s: string) => /^\+[1-9]\d{7,14}$/.test(s)

/** Why a phone value cannot be used, or null when it is a valid number. */
export const phoneProblem = (raw: string): string | null => {
  const r = parsePhone(raw)
  return r.ok ? null : r.reason
}
