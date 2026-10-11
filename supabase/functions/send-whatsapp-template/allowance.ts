/** What `send_allowance` reports for one company today. */
export interface Allowance {
  warmup_on: boolean; warmup_day: number | null; warmup_done: boolean; warmup_limit: number | null
  daily_cap: number | null; limit: number | null; reason: 'warmup' | 'cap' | null; used: number; remaining: number | null
}

/** Returns why a send must be refused, or null when it fits inside today's allowance. */
export function overAllowance(al: Allowance | null | undefined, needed: number): string | null {
  if (!al || al.remaining === null || al.limit === null) return null
  if (needed <= al.remaining) return null
  const left = al.remaining
  const tail = left === 0
    ? 'Nothing is left for today, so try again tomorrow.'
    : `Send to ${left} or fewer clients now, and the rest tomorrow.`
  if (al.reason === 'warmup') {
    return `Warm-up limit: day ${al.warmup_day} of this number's warm-up allows ${al.limit} messages a day. ${al.used} already went out today and this send needs ${needed}. ${tail}`
  }
  return `Daily limit of ${al.limit} messages reached for this company: ${al.used} already went out today and this send needs ${needed}. ${tail}`
}
