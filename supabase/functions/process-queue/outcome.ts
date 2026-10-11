/** Meta's throughput and pair-rate limits: it refused the message before doing anything with it, so trying again later is safe. */
export const RETRYABLE = new Set([130429, 131056])
export const MAX_ATTEMPTS = 6

export type Outcome =
  | { action: 'sent'; wamid: string }
  | { action: 'retry'; delaySec: number }
  | { action: 'fail'; code: number }
  /** The request may have reached Meta (timeout, dropped connection, server error), so sending again could message the person twice. */
  | { action: 'unconfirmed' }

export const backoffSeconds = (attempts: number, jitter = Math.random() * 3) => Math.min(900, 8 * 2 ** attempts) + jitter

/** What to do after one try. `reply` is undefined when no answer came back at all. */
export function classifySend(reply: { status: number; body: any } | undefined, attempts: number, jitter?: number): Outcome {
  if (!reply) return { action: 'unconfirmed' }
  const id = reply.body?.messages?.[0]?.id
  if (reply.status >= 200 && reply.status < 300 && id) return { action: 'sent', wamid: String(id) }
  const code = Number(reply.body?.error?.code ?? 0)
  if (reply.status >= 500) return { action: 'unconfirmed' }
  if ((RETRYABLE.has(code) || reply.status === 429) && attempts < MAX_ATTEMPTS) return { action: 'retry', delaySec: backoffSeconds(attempts, jitter) }
  return { action: 'fail', code }
}
