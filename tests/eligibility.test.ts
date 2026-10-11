import { describe, expect, it } from 'vitest'
import { eligibilityError, templateBlock } from '../supabase/functions/send-whatsapp-template/eligibility'

const ok = { id: 'o1', phone: '+201010354164', whatsapp_opt_in: true, status: 'active' }
const none = new Set<string>()

describe('J. opt-out and consent are enforced before queueing', () => {
  it('lets an opted-in active client with every field through', () => {
    expect(eligibilityError(ok, none, none, [])).toBeNull()
  })
  it('blocks a client flagged opted out', () => {
    expect(eligibilityError({ ...ok, whatsapp_opt_in: false }, none, none, [])?.code).toBe('OPT_OUT')
  })
  it('blocks a client with an opt-out record', () => {
    expect(eligibilityError(ok, new Set(['o1']), none, [])?.code).toBe('OPT_OUT')
  })
  it('blocks a second client row with the same phone when that phone has opted out (re-upload with different details)', () => {
    expect(eligibilityError({ ...ok, id: 'o2' }, none, new Set(['+201010354164']), [])?.code).toBe('OPT_OUT')
  })
  it('opt-out wins over every other reason', () => {
    expect(eligibilityError({ ...ok, whatsapp_opt_in: false, status: 'inactive' }, none, none, ['Unit'])?.code).toBe('OPT_OUT')
  })
})

describe('L/G. other reasons a message is refused', () => {
  it('refuses missing template variables and lists them', () => {
    expect(eligibilityError(ok, none, none, ['Unit', 'Amount'])).toEqual({ code: 'MISSING_VARIABLE', message: 'Missing in the client data: Unit, Amount' })
  })
  it('refuses an inactive client', () => {
    expect(eligibilityError({ ...ok, status: 'inactive' }, none, none, [])?.code).toBe('INACTIVE')
  })
  it.each(['01010354164', '+0123', '', '201010354164', '+20abc'])('refuses the stored phone %j that is not E.164', (phone) => {
    expect(eligibilityError({ ...ok, phone }, none, none, [])?.code).toBe('INVALID_PHONE')
  })
})

describe('K. only a currently approved template can be sent', () => {
  const project = { entity_id: 'e1' }
  const tpl = (over: object) => ({ status: 'APPROVED', meta_status: 'APPROVED', entity_id: 'e1', ...over })

  it('allows approved and flagged', () => {
    expect(templateBlock(tpl({}), project, true)).toBeNull()
    expect(templateBlock(tpl({ meta_status: 'FLAGGED' }), project, true)).toBeNull()
  })
  it.each(['PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'DELETED', 'IN_APPEAL', 'LIMIT_EXCEEDED', 'SOMETHING_NEW'])('blocks Meta status %s', (s) => {
    expect(templateBlock(tpl({ meta_status: s }), project, true)).toMatch(/cannot be sent/)
  })
  it.each(['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'ARCHIVED'])('blocks local status %s', (status) => {
    expect(templateBlock(tpl({ status }), project, false)).toBe('Only approved templates can be sent')
  })
  it('live sending needs Meta\'s own status on record (a local approval alone is refused)', () => {
    expect(templateBlock(tpl({ meta_status: null }), project, true)).toMatch(/unknown/)
    expect(templateBlock(tpl({ meta_status: null }), project, false)).toBeNull()   // demo mode
  })
  it('refuses a missing template and another company\'s template', () => {
    expect(templateBlock(null, project, false)).toMatch(/not found/)
    expect(templateBlock(tpl({ entity_id: 'e2' }), project, false)).toMatch(/different entity/)
  })
})
