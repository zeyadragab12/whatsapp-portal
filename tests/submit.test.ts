import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './mocks/supabase'

type Handler = (req: Request) => Promise<Response>
let handler: Handler

const TPL_ID = '11111111-1111-4111-8111-111111111111'
const ENTITY = '22222222-2222-4222-8222-222222222222'
const META_NAME = 'rent_reminder_111111'

beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: (h: Handler) => { handler = h }, env: { get: (k: string) => (k === 'SUPABASE_URL' ? 'https://test.invalid' : 'key') } })
  await import('../supabase/functions/submit-whatsapp-template/index')
})

const tpl = (p: Record<string, unknown> = {}) => ({
  id: TPL_ID, entity_id: ENTITY, name: 'Rent reminder', category: 'UTILITY', language: 'en', status: 'DRAFT', parameter_format: 'NAMED',
  header_text: null, header_media_id: null, body_text: 'Hello {{owner_name}}, your payment is due on Friday.', footer_text: null, buttons: [],
  variables: [{ name: 'owner_name', example: 'Ahmed', source: 'owner_name' }], meta_template_id: null, meta_name: null, meta_status: null, meta_submitted_at: null, ...p,
})
const live = () => {
  db.tables.whatsapp_config = [{ id: 1, mode: 'live', api_version: 'v25.0', access_token: 'SECRET_TOKEN' }]
  db.tables.whatsapp_accounts = [{ entity_id: ENTITY, mode: 'live', waba_id: 'WABA1', api_version: 'v25.0', template_cap: 250 }]
}
const submit = () => handler(new Request('https://x.test/submit', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ template_id: TPL_ID }) }))
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let meta: ReturnType<typeof vi.fn>

beforeEach(() => {
  db.reset()
  db.user = { id: 'u1' }
  db.rpcResults.has_perm = true
  db.tables.whatsapp_config = [{ id: 1, mode: 'demo' }]
  db.tables.whatsapp_templates = [tpl()]
  meta = vi.fn()
  vi.stubGlobal('fetch', meta)
})
afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('Deno', { serve: () => {}, env: { get: () => 'x' } }) })

const sentToMeta = () => meta.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
const statusUpdate = () => db.updates.find((u) => u.table === 'whatsapp_templates')?.values as Record<string, unknown> | undefined

describe('server-side validation on submit', () => {
  it('refuses an invalid template with field-level issues and never calls Meta', async () => {
    live()
    db.tables.whatsapp_templates = [tpl({ body_text: 'x'.repeat(1025), variables: [], buttons: [{ type: 'URL', text: 'Go', url: 'javascript:alert(1)' }] })]
    const r = await submit()
    const j = await r.json()
    expect(r.status).toBe(422)
    expect(j.error).toMatch(/problems? to fix/)
    expect(j.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['body.long', 'url.scheme']))
    expect(j.issues.every((i: { field: string; message: string }) => i.field && i.message)).toBe(true)
    expect(meta).not.toHaveBeenCalled()
    expect(statusUpdate()).toBeUndefined()
  })
  it('refuses a missing example for a field even though the browser may have skipped it', async () => {
    db.tables.whatsapp_templates = [tpl({ variables: [] })]
    const r = await submit()
    expect(r.status).toBe(422)
    expect((await r.json()).issues[0].code).toBe('example.missing')
  })
  it('refuses a duplicate name among the company’s other templates', async () => {
    db.tables.whatsapp_templates = [tpl(), { id: '99999999-9999-4999-8999-999999999999', name: 'rent reminder' }]
    const r = await submit()
    expect(r.status).toBe(422)
    expect((await r.json()).issues.map((i: { code: string }) => i.code)).toContain('name.duplicate')
  })
  it('refuses an Authentication template with a header, and one-tap with no app', async () => {
    db.tables.whatsapp_templates = [tpl({ category: 'AUTHENTICATION', header_text: 'Code', auth_options: { otp_type: 'ONE_TAP', supported_apps: [] } })]
    const codes = (await (await submit()).json()).issues.map((i: { code: string }) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['auth.header', 'auth.apps']))
  })
  it('refuses a caller who may not submit, and one who is not signed in', async () => {
    db.rpcResults.has_perm = false
    expect((await submit()).status).toBe(403)
    db.user = null
    expect((await submit()).status).toBe(401)
  })
})

describe('demo mode', () => {
  it('moves a valid template to Pending without calling Meta', async () => {
    const r = await submit()
    expect(r.status).toBe(200)
    expect((await r.json()).mode).toBe('demo')
    expect(statusUpdate()).toMatchObject({ status: 'PENDING_APPROVAL', meta_status: 'PENDING', meta_name: META_NAME })
    expect(meta).not.toHaveBeenCalled()
  })
})

describe('live submission', () => {
  it('sends the payload built by the shared mapper and records Pending, not Approved', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ id: 'META123' }))
    const r = await submit()
    expect(r.status).toBe(200)
    const [url, init] = sentToMeta()[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v25.0/WABA1/message_templates')
    expect(JSON.parse(init.body as string)).toEqual({
      name: META_NAME, language: 'en_US', category: 'UTILITY', parameter_format: 'NAMED',
      components: [{ type: 'BODY', text: 'Hello {{owner_name}}, your payment is due on Friday.', example: { body_text_named_params: [{ param_name: 'owner_name', example: 'Ahmed' }] } }],
    })
    expect(statusUpdate()).toMatchObject({ status: 'PENDING_APPROVAL', meta_status: 'PENDING', meta_template_id: 'META123' })
    expect(statusUpdate()?.status).not.toBe('APPROVED')
  })
  it('keeps the access token out of the body and out of the response', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ id: 'META123' }))
    const r = await submit()
    expect(await r.text()).not.toContain('SECRET_TOKEN')
    expect((sentToMeta()[0][1] as RequestInit).body).not.toContain('SECRET_TOKEN')
  })
  it('sends the Authentication payload for each option', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ id: 'A1' }))
    db.tables.whatsapp_templates = [tpl({ category: 'AUTHENTICATION', body_text: 'x', variables: [], parameter_format: 'POSITIONAL',
      auth_options: { otp_type: 'ONE_TAP', code_expiration_minutes: 10, add_security_recommendation: true, button_text: '', autofill_text: '', supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] } })]
    expect((await submit()).status).toBe(200)
    expect(JSON.parse((sentToMeta()[0][1] as RequestInit).body as string)).toEqual({
      name: META_NAME, language: 'en_US', category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'ONE_TAP', supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] }] },
      ],
    })
  })
  it('edits an existing template in place with components only, and the category until first approval', async () => {
    live()
    db.tables.whatsapp_templates = [tpl({ meta_template_id: 'META9', meta_name: META_NAME, meta_status: 'REJECTED', meta_approved_once: false })]
    meta.mockResolvedValueOnce(reply({ success: true }))
    expect((await submit()).status).toBe(200)
    const [url, init] = sentToMeta()[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v25.0/META9')
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['category', 'components'])
  })
})

describe('failures from Meta', () => {
  it('shows Meta’s own explanation for a rejected request and records nothing', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ error: { code: 100, error_user_msg: 'Body is too long for this category.' } }, 400))
    const r = await submit()
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('Body is too long for this category.')
    expect(statusUpdate()).toBeUndefined()
  })
  it('explains a permission failure and an expired token', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ error: { code: 200 } }, 403))
    expect((await (await submit()).json()).error).toMatch(/whatsapp_business_management/)
    meta.mockResolvedValueOnce(reply({ error: { code: 190 } }, 401))
    expect((await (await submit()).json()).error).toMatch(/invalid or expired/)
  })
  it('turns a rate limit into a clear 429', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ error: { code: 80008, message: 'x' } }, 400))
    const r = await submit()
    expect(r.status).toBe(429)
    expect((await r.json()).error).toMatch(/limiting how fast/)
    meta.mockResolvedValueOnce(reply({}, 429))
    expect((await submit()).status).toBe(429)
  })
  it('after a timeout it looks the template up by name and adopts it instead of failing or duplicating', async () => {
    live()
    meta.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    meta.mockResolvedValueOnce(reply({ data: [{ id: 'FOUND1', status: 'PENDING' }] }))
    const r = await submit()
    const j = await r.json()
    expect(r.status).toBe(200)
    expect(j.reconciled).toBe(true)
    expect(statusUpdate()).toMatchObject({ meta_template_id: 'FOUND1', status: 'PENDING_APPROVAL' })
    expect(sentToMeta()).toHaveLength(1)     // one create attempt, then only a lookup
    expect(String(meta.mock.calls[1][0])).toContain(`name=${META_NAME}`)
  })
  it('after a timeout with nothing found on Meta it says it is safe to try again', async () => {
    live()
    meta.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    meta.mockResolvedValueOnce(reply({ data: [] }))
    const r = await submit()
    expect(r.status).toBe(504)
    expect((await r.json()).error).toMatch(/safe to try again/)
    expect(statusUpdate()).toBeUndefined()
  })
  it('a retry that meets "already exists" adopts the template that an earlier attempt created', async () => {
    live()
    meta.mockResolvedValueOnce(reply({ error: { code: 100, error_subcode: 2388024 } }, 400))
    meta.mockResolvedValueOnce(reply({ data: [{ id: 'EARLIER', status: 'APPROVED' }] }))
    const r = await submit()
    expect(r.status).toBe(200)
    expect(statusUpdate()).toMatchObject({ meta_template_id: 'EARLIER' })
  })
  it('a timeout while editing does not guess: it tells the person to check on Meta', async () => {
    live()
    db.tables.whatsapp_templates = [tpl({ meta_template_id: 'META9', meta_name: META_NAME, meta_status: 'REJECTED' })]
    meta.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    const r = await submit()
    expect(r.status).toBe(504)
    expect((await r.json()).error).toMatch(/Check the template on Meta/)
    expect(meta).toHaveBeenCalledTimes(1)
  })
})
