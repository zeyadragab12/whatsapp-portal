import { describe, expect, it } from 'vitest'
import { buildPayload, cleanParam, extractVars } from '../supabase/functions/send-whatsapp-template/payload'
import { overAllowance } from '../supabase/functions/send-whatsapp-template/allowance'

const tpl = { meta_name: 'rent_due_ab12', language: 'en', header_text: null, body_text: 'Hi {{owner_name}}, unit {{unit_number}} owes {{amount}}.' }

describe('L. template variables', () => {
  it('finds each variable once, in order of appearance', () => {
    expect(extractVars('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
    expect(extractVars(null)).toEqual([])
  })
  it('builds named parameters with the recipient values and a number without its plus', () => {
    const p = buildPayload(tpl, { owner_name: 'Sara', unit_number: 'A1', amount: '4500' }, '+201010354164')
    expect(p.to).toBe('201010354164')
    expect(p.template.components).toEqual([{ type: 'body', parameters: [
      { type: 'text', parameter_name: 'owner_name', text: 'Sara' }, { type: 'text', parameter_name: 'unit_number', text: 'A1' }, { type: 'text', parameter_name: 'amount', text: '4500' }] }])
  })
  it('positional templates are ordered numerically', () => {
    const p = buildPayload({ ...tpl, parameter_format: 'POSITIONAL', body_text: '{{2}} then {{1}}' }, { 1: 'one', 2: 'two' }, '+201010354164')
    expect((p.template.components[0] as { parameters: { text: string }[] }).parameters.map((x) => x.text)).toEqual(['one', 'two'])
  })
  it('renders values as plain text: newlines, tabs and long space runs are removed, markup is not interpreted', () => {
    expect(cleanParam('a\nb\tc      d')).toBe('a b c    d')
    expect(cleanParam('<script>alert(1)</script> {{x}}')).toBe('<script>alert(1)</script> {{x}}')
  })
  it('uses the Arabic language code for Arabic templates', () => {
    expect(buildPayload({ ...tpl, language: 'ar' }, {}, '+2010').template.language.code).toBe('ar')
  })
})

describe('N. Meta account allowance', () => {
  const al = { warmup_on: false, warmup_day: null, warmup_done: true, warmup_limit: null, daily_cap: 1000, limit: 1000, reason: 'cap' as const, used: 990, remaining: 10 }
  it('allows a send that fits and refuses one that does not, naming what is left', () => {
    expect(overAllowance(al, 10)).toBeNull()
    expect(overAllowance(al, 11)).toMatch(/10 or fewer/)
  })
  it('says so when nothing is left today', () => {
    expect(overAllowance({ ...al, remaining: 0 }, 1)).toMatch(/Nothing is left/)
  })
  it('does not invent a limit when none is known', () => {
    expect(overAllowance({ ...al, remaining: null, limit: null }, 99999)).toBeNull()
    expect(overAllowance(null, 5)).toBeNull()
  })
})
