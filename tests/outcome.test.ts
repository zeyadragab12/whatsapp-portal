import { describe, expect, it } from 'vitest'
import { backoffSeconds, classifySend, MAX_ATTEMPTS } from '../supabase/functions/process-queue/outcome'

const ok = { status: 200, body: { messages: [{ id: 'wamid.X' }] } }
const err = (status: number, code: number) => ({ status, body: { error: { code } } })

describe('M. timeouts and server errors are never blindly retried', () => {
  it('a missing answer (timeout, dropped connection) is unconfirmed, not a retry', () => {
    expect(classifySend(undefined, 1)).toEqual({ action: 'unconfirmed' })
  })
  it.each([500, 502, 503, 504])('HTTP %i is unconfirmed: Meta may already hold the message', (s) => {
    expect(classifySend(err(s, 1), 1)).toEqual({ action: 'unconfirmed' })
  })
  it('a 2xx without a message id is not treated as sent', () => {
    expect(classifySend({ status: 200, body: {} }, 1).action).not.toBe('sent')
  })
  it('records the id when Meta accepts', () => {
    expect(classifySend(ok, 1)).toEqual({ action: 'sent', wamid: 'wamid.X' })
  })
})

describe('N. rate limits retry with backoff, permanent errors do not', () => {
  it.each([130429, 131056])('code %i is retried later', (code) => {
    expect(classifySend(err(400, code), 1, 0)).toEqual({ action: 'retry', delaySec: 16 })
  })
  it('HTTP 429 is retried', () => {
    expect(classifySend(err(429, 0), 2, 0)).toEqual({ action: 'retry', delaySec: 32 })
  })
  it('stops retrying after the maximum attempts', () => {
    expect(classifySend(err(400, 130429), MAX_ATTEMPTS, 0)).toEqual({ action: 'fail', code: 130429 })
  })
  it.each([100, 190, 131026, 132000, 132018])('permanent code %i fails at once', (code) => {
    expect(classifySend(err(400, code), 1)).toEqual({ action: 'fail', code })
  })
  it('backoff grows and is capped at 15 minutes plus jitter', () => {
    expect(backoffSeconds(1, 0)).toBeLessThan(backoffSeconds(3, 0))
    expect(backoffSeconds(30, 0)).toBe(900)
  })
})
