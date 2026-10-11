import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './mocks/supabase'

type Handler = (req: Request) => Promise<Response>
const handlers: Record<string, Handler> = {}
let current = ''

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    serve: (h: Handler) => { handlers[current] = h },
    env: { get: (k: string) => (k === 'SUPABASE_URL' ? 'https://test.invalid' : 'key') },
  })
  vi.stubGlobal('EdgeRuntime', { waitUntil: () => {} })
  current = 'send'; await import('../supabase/functions/send-whatsapp-template/index')
  current = 'queue'; await import('../supabase/functions/process-queue/index')
})

beforeEach(() => {
  db.reset()
  db.tables.whatsapp_config = [{ id: 1, mode: 'demo', worker_secret: 'worker-secret' }]
})

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_R = '33333333-3333-4333-8333-333333333333'
const send = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer t' }) =>
  handlers.send(new Request('https://x.test/send', { method: 'POST', headers, body: JSON.stringify(body) }))
const valid = { template_id: UUID_A, project_id: UUID_B, owner_ids: [UUID_A], request_id: UUID_R }

describe('O. employees cannot call the send endpoint around the rules', () => {
  it('refuses a caller who is not signed in', async () => {
    db.user = null
    const r = await send(valid)
    expect(r.status).toBe(401)
    expect(db.inserts).toHaveLength(0)
  })
  it('refuses a signed-in caller who may not send for this list', async () => {
    db.user = { id: 'u1' }
    db.rpcResults.can_access_project = false
    const r = await send(valid)
    expect(r.status).toBe(403)
    expect(db.inserts).toHaveLength(0)
  })
  it('refuses a wrong worker secret (the scheduled-send door)', async () => {
    const r = await send({ scheduled_id: UUID_A }, { 'x-worker-secret': 'guess' })
    expect(r.status).toBe(401)
    expect(db.inserts).toHaveLength(0)
  })
  it('refuses a request with no recipients, with ids that are not UUIDs, or with too many', async () => {
    db.user = { id: 'u1' }
    expect((await send({ ...valid, owner_ids: [] })).status).toBe(400)
    expect((await send({ ...valid, owner_ids: ["x'; drop table owners;--"] })).status).toBe(400)
    expect((await send({ ...valid, owner_ids: Array.from({ length: 2001 }, () => UUID_A) })).status).toBe(400)
    expect((await send({ ...valid, template_id: 'nope' })).status).toBe(400)
  })
  it('refuses GET and does nothing', async () => {
    const r = await handlers.send(new Request('https://x.test/send'))
    expect(r.status).toBe(405)
  })
})

describe('M. a double click or retried request does not send twice', () => {
  it('returns the batch that already exists for the same request id and queues nothing new', async () => {
    db.user = { id: 'u1' }
    db.rpcResults.can_access_project = true
    db.tables.whatsapp_templates = [{ id: UUID_A, status: 'APPROVED', meta_status: 'APPROVED', entity_id: 'e1' }]
    db.tables.projects = [{ id: UUID_B, entity_id: 'e1', code: 'P', name: 'P' }]
    db.tables.project_owners = [{ owner_id: UUID_A, owners: { id: UUID_A, phone: '+201010354164', whatsapp_opt_in: true, status: 'active', full_name: 'Sara', email: null } }]
    db.tables.dispatch_batches = [{ id: 'batch-1', total: 1, mode: 'demo' }]
    const r = await send(valid)
    const j = await r.json()
    expect(r.status).toBe(200)
    expect(j).toMatchObject({ batch_id: 'batch-1', duplicate_request: true })
    expect(db.inserts.filter((i) => i.table === 'message_logs' || i.table === 'dispatch_batches')).toHaveLength(0)
  })
})

describe('worker endpoint', () => {
  it('only runs for the worker secret', async () => {
    const no = await handlers.queue(new Request('https://x.test/q', { method: 'POST' }))
    const bad = await handlers.queue(new Request('https://x.test/q', { method: 'POST', headers: { 'x-worker-secret': 'nope' } }))
    expect([no.status, bad.status]).toEqual([401, 401])
  })
})
