import { describe, expect, it } from 'vitest'
import { planCategorySwitch } from '../src/lib/categorySwitch'
import { templateBlock } from '../supabase/functions/send-whatsapp-template/eligibility'
import { validateTemplate, type TemplateDraft } from '../supabase/functions/_shared/templateRules'
import { isSendable } from '../src/lib/types'

const full = { header: 'Title', body: 'Hello there friend', footer: 'Foot', buttons: [{ type: 'QUICK_REPLY' as const, text: 'Yes' }], hasMedia: true }
const empty = { header: '', body: '', footer: '', buttons: [], hasMedia: false }

describe('switching categories', () => {
  it('asks before Authentication would hide anything, and names what it hides', () => {
    const p = planCategorySwitch('UTILITY', 'AUTHENTICATION', full)
    expect(p.needsConfirm).toBe(true)
    expect(p.setAside).toEqual(['the message text', 'the header', 'the image or video', 'the footer', 'the buttons'])
  })
  it('does not ask when there is nothing to lose', () => {
    expect(planCategorySwitch('MARKETING', 'AUTHENTICATION', empty)).toEqual({ needsConfirm: false, setAside: [], restore: false })
    expect(planCategorySwitch('MARKETING', 'AUTHENTICATION', { ...empty, body: '   ' }).needsConfirm).toBe(false)
  })
  it('moving between Utility and Marketing never loses or asks anything', () => {
    expect(planCategorySwitch('UTILITY', 'MARKETING', full)).toEqual({ needsConfirm: false, setAside: [], restore: false })
    expect(planCategorySwitch('MARKETING', 'UTILITY', full).needsConfirm).toBe(false)
  })
  it('leaving Authentication restores what was set aside', () => {
    expect(planCategorySwitch('AUTHENTICATION', 'UTILITY', empty).restore).toBe(true)
    expect(planCategorySwitch('AUTHENTICATION', 'AUTHENTICATION', empty).restore).toBe(false)
  })
  it('content that a category cannot hold is flagged as an error, not dropped, if it is still in the draft', () => {
    const d: TemplateDraft = { name: 'x', category: 'AUTHENTICATION', language: 'en', parameterFormat: 'POSITIONAL', headerText: 'Kept', media: null, body: '', footer: 'Kept', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }], auth: null, examples: {} }
    const codes = validateTemplate(d).map((i) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['auth.header', 'auth.footer', 'auth.buttons']))
  })
})

describe('Authentication templates are kept out of owner-list sending', () => {
  const ok = { status: 'APPROVED', meta_status: 'APPROVED', entity_id: 'e1' }
  it('the server refuses them', () => {
    expect(templateBlock({ ...ok, category: 'AUTHENTICATION' }, { entity_id: 'e1' }, true)).toMatch(/one-time code/)
    expect(templateBlock({ ...ok, category: 'UTILITY' }, { entity_id: 'e1' }, true)).toBeNull()
    expect(templateBlock(ok, { entity_id: 'e1' }, true)).toBeNull()
  })
  it('the Send page does not offer them', () => {
    expect(isSendable({ status: 'APPROVED', meta_status: 'APPROVED', category: 'AUTHENTICATION' })).toBe(false)
    expect(isSendable({ status: 'APPROVED', meta_status: 'APPROVED', category: 'MARKETING' })).toBe(true)
    expect(isSendable({ status: 'APPROVED', meta_status: 'APPROVED' })).toBe(true)
  })
})
