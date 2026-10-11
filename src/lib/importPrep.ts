import { parsePhone } from './phone'

export interface Prepared { n: number; phone: string; original: string; extra: Record<string, string>; optout: boolean }
export interface Rejected { n: number; raw: string; reason: string; cells: string[] }
/** A row set aside or flagged: `of` is the row it repeats or shares its phone with. */
export interface Repeat { n: number; phone: string; of: number }
export interface ImportReport { ready: Prepared[]; rejected: Rejected[]; duplicates: Repeat[]; conflicts: Repeat[]; fresh: number; existing: number }

/**
 * Turns the rows of a file into what can be imported. The phone is the identity: it is normalized first, then compared.
 * A row that repeats a number with the very same details is dropped as a duplicate. The same number with different details is kept
 * as its own client (the existing business rule) but listed as a conflict so the person sees it before anything is saved.
 * One opted-out row opts the number out for every row of the file, so a duplicate can never undo an opt-out.
 */
export function prepareRows(
  table: string[][], phoneCol: number, optoutCol: number, extras: { index: number; key: string }[], isOptout: (v: string) => boolean,
  existingPhones: ReadonlySet<string> = new Set(),
): ImportReport {
  const ready: Prepared[] = [], rejected: Rejected[] = [], duplicates: Repeat[] = [], conflicts: Repeat[] = []
  const firstByDetails = new Map<string, number>()
  const firstByPhone = new Map<string, number>()
  const optedOut = new Set<string>()
  table.slice(1).forEach((r, i) => {
    const n = i + 2
    if (r.every((c) => !(c ?? '').trim())) return
    const raw = r[phoneCol] ?? ''
    const parsed = parsePhone(raw)
    if (!parsed.ok) { rejected.push({ n, raw, reason: parsed.reason, cells: r }); return }
    const phone = parsed.e164
    const extra = Object.fromEntries(extras.map((x) => [x.key, (r[x.index] ?? '').trim()]).filter(([, v]) => v))
    const optout = optoutCol >= 0 && isOptout((r[optoutCol] ?? '').trim())
    if (optout) optedOut.add(phone)
    const details = `${phone}|${JSON.stringify(Object.entries(extra).sort(([a], [b]) => (a < b ? -1 : 1)))}`
    const same = firstByDetails.get(details)
    if (same !== undefined) { duplicates.push({ n, phone, of: same }); return }
    firstByDetails.set(details, n)
    const sharer = firstByPhone.get(phone)
    if (sharer !== undefined) conflicts.push({ n, phone, of: sharer }); else firstByPhone.set(phone, n)
    ready.push({ n, phone, original: raw.trim(), extra, optout })
  })
  for (const p of ready) if (optedOut.has(p.phone)) p.optout = true
  const phones = new Set(ready.map((p) => p.phone))
  const existing = [...phones].filter((p) => existingPhones.has(p)).length
  return { ready, rejected, duplicates, conflicts, fresh: phones.size - existing, existing }
}
