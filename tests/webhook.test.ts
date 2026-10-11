import { createHmac } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './mocks/supabase'

const SECRET = 'test-app-secret'
let handler: (req: Request) => Promise<Response>

beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: (h: typeof handler) => { handler = h }, env: { get: () => 'x' } })
  await import('../supabase/functions/whatsapp-webhook/index')
})

beforeEach(() => {
  db.reset()
  db.tables.whatsapp_config = [{ verify_token: 'verify-me', app_secret: SECRET }]
  db.tables.whatsapp_accounts = []
})

const sign = (raw: string, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
const post = (raw: string, header?: string) => handler(new Request('https://x.test/hook', { method: 'POST', body: raw, headers: header ? { 'x-hub-signature-256': header } : {} }))
const inbound = (id: string, text: string) => JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '201010354164', profile: { name: 'Sara' } }],
  messages: [{ from: '201010354164', id, type: 'text', text: { body: text }, timestamp: '1' }] } }] }] })

describe('P. webhook signature verification', () => {
  it('rejects a request with no signature header and does no work', async () => {
    const r = await post(inbound('w1', 'STOP'))
    expect(r.status).toBe(401)
    expect(db.rpc).toHaveLength(0)
  })
  it('rejects a wrong signature', async () => {
    const raw = inbound('w1', 'STOP')
    expect((await post(raw, sign(raw, 'attacker-secret'))).status).toBe(401)
    expect(db.rpc).toHaveLength(0)
  })
  it('rejects a body changed after signing', async () => {
    const raw = inbound('w1', 'hello')
    expect((await post(inbound('w1', 'STOP'), sign(raw))).status).toBe(401)
    expect(db.rpc).toHaveLength(0)
  })
  it('rejects a malformed or truncated signature header', async () => {
    const raw = inbound('w1', 'hi')
    expect((await post(raw, 'sha256=abc')).status).toBe(401)
    expect((await post(raw, sign(raw).replace('sha256=', 'md5='))).status).toBe(401)
  })
  it('refuses everything when no app secret is configured (fails closed)', async () => {
    db.tables.whatsapp_config = [{ verify_token: 'v', app_secret: null }]
    const raw = inbound('w1', 'hi')
    expect((await post(raw, sign(raw, ''))).status).toBe(401)
    expect(db.rpc).toHaveLength(0)
  })
  it('accepts a correctly signed request and forwards the inbound message', async () => {
    const raw = inbound('w1', 'STOP')
    expect((await post(raw, sign(raw))).status).toBe(200)
    const call = db.rpc.find((c) => c.name === 'ingest_inbound_batch')
    expect(call?.args).toMatchObject({ p_items: [{ wamid: 'w1', from: '201010354164' }] })
  })
  it('accepts a signature made with a per-company app secret', async () => {
    db.tables.whatsapp_accounts = [{ app_secret: 'company-secret' }]
    const raw = inbound('w2', 'hi')
    expect((await post(raw, sign(raw, 'company-secret'))).status).toBe(200)
  })
})

describe('P. webhook replay', () => {
  it('a replayed delivery carries the same wamid every time, so the database unique key can drop it', async () => {
    const raw = inbound('w-replay', 'STOP')
    const header = sign(raw)
    expect((await post(raw, header)).status).toBe(200)
    expect((await post(raw, header)).status).toBe(200)   // Meta retries until it gets a 200: it must never error on a repeat
    const ids = db.rpc.filter((c) => c.name === 'ingest_inbound_batch').map((c) => (c.args as { p_items: { wamid: string }[] }).p_items[0].wamid)
    expect(ids).toEqual(['w-replay', 'w-replay'])
  })
  it('status receipts are forwarded as one batch for the idempotent updater', async () => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.A', status: 'delivered' }, { id: 'wamid.A', status: 'read' }] } }] }] })
    expect((await post(raw, sign(raw))).status).toBe(200)
    expect(db.rpc.find((c) => c.name === 'apply_status_updates')?.args).toMatchObject({ p_items: [{ wamid: 'wamid.A', status: 'DELIVERED' }, { wamid: 'wamid.A', status: 'READ' }] })
  })
  it('a signed body that is not JSON is a 400, not a crash', async () => {
    const raw = 'not json'
    expect((await post(raw, sign(raw))).status).toBe(400)
  })
})

describe('webhook verification handshake', () => {
  const get = (q: string) => handler(new Request(`https://x.test/hook?${q}`))
  it('answers the challenge only for the right token', async () => {
    const good = await get('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123')
    expect([good.status, await good.text()]).toEqual([200, '123'])
    expect((await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123')).status).toBe(403)
  })
})
