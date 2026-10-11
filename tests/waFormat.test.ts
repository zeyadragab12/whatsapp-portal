import { describe, expect, it } from 'vitest'
import { parseFormatting } from '../src/lib/waFormat'

const kinds = (s: string) => parseFormatting(s).map((n) => n.kind)

describe('WhatsApp formatting', () => {
  it('reads bold, italic, strikethrough and monospace', () => {
    expect(kinds('*a*')).toEqual(['b'])
    expect(kinds('_a_')).toEqual(['i'])
    expect(kinds('~a~')).toEqual(['s'])
    expect(kinds('```a b```')).toEqual(['m'])
  })
  it('keeps plain text around the formatting', () => {
    expect(parseFormatting('Hello *world* today')).toEqual([
      { kind: 'text', text: 'Hello ' }, { kind: 'b', children: [{ kind: 'text', text: 'world' }] }, { kind: 'text', text: ' today' }])
  })
  it('nests formats', () => {
    expect(parseFormatting('*bold _and italic_*')).toEqual([{ kind: 'b', children: [{ kind: 'text', text: 'bold ' }, { kind: 'i', children: [{ kind: 'text', text: 'and italic' }] }] }])
  })
  it('does not format across a line break, around spaces, or inside words', () => {
    expect(kinds('*a\nb*')).toEqual(['text'])
    expect(kinds('* a *')).toEqual(['text'])
    expect(kinds('snake_case_name')).toEqual(['text'])
    expect(kinds('5 * 3 * 2')).toEqual(['text'])
    expect(kinds('**')).toEqual(['text'])
  })
  it('leaves an unclosed marker as text', () => {
    expect(parseFormatting('*never closed')).toEqual([{ kind: 'text', text: '*never closed' }])
  })
  it('monospace shows its content as it is', () => {
    expect(parseFormatting('```*x*```')).toEqual([{ kind: 'm', children: [{ kind: 'text', text: '*x*' }] }])
  })
  it('finds placeholders as their own nodes, also inside formatting', () => {
    expect(parseFormatting('Hi *{{owner_name}}*!')).toEqual([
      { kind: 'text', text: 'Hi ' }, { kind: 'b', children: [{ kind: 'var', name: 'owner_name' }] }, { kind: 'text', text: '!' }])
  })
  it('does not treat HTML as anything but text', () => {
    expect(parseFormatting('<b>x</b>')).toEqual([{ kind: 'text', text: '<b>x</b>' }])
  })
  it('handles Arabic text and empty input', () => {
    expect(parseFormatting('مرحباً *أحمد*')).toEqual([{ kind: 'text', text: 'مرحباً ' }, { kind: 'b', children: [{ kind: 'text', text: 'أحمد' }] }])
    expect(parseFormatting('')).toEqual([])
  })
})
