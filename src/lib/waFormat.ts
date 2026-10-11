/**
 * WhatsApp text formatting as a tree of plain nodes. The preview turns the tree into React elements, so user
 * text is never interpreted as HTML.
 *
 * Syntax: *bold*  _italic_  ~strikethrough~  ```monospace```. This is WhatsApp's standard syntax; Meta's template
 * reference only shows *bold* in its samples and does not spell out the rest, so treat italic, strikethrough and
 * monospace as WhatsApp behaviour rather than a documented template rule.
 */
export type FmtNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'b' | 'i' | 's' | 'm'; children: FmtNode[] }

const MARK: Record<string, 'b' | 'i' | 's'> = { '*': 'b', _: 'i', '~': 's' }
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)
const isSpace = (c: string | undefined) => !c || /\s/.test(c)

/** Splits plain text into text and {{variable}} nodes. */
function withVars(text: string): FmtNode[] {
  const out: FmtNode[] = []
  let last = 0
  for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    out.push({ kind: 'var', name: m[1].trim() })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function parseFormatting(src: string): FmtNode[] {
  const out: FmtNode[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push(...withVars(buf)); buf = '' } }
  let i = 0
  while (i < src.length) {
    if (src.startsWith('```', i)) {
      const end = src.indexOf('```', i + 3)
      if (end > i + 3) { flush(); out.push({ kind: 'm', children: [{ kind: 'text', text: src.slice(i + 3, end) }] }); i = end + 3; continue }
    }
    const c = src[i]
    const kind = MARK[c]
    if (kind && !isWord(src[i - 1]) && !isSpace(src[i + 1]) && src[i + 1] !== c) {
      let j = i + 1
      let close = -1
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === c && !isSpace(src[j - 1]) && !isWord(src[j + 1])) { close = j; break }
        j++
      }
      if (close > i + 1) { flush(); out.push({ kind, children: parseFormatting(src.slice(i + 1, close)) }); i = close + 1; continue }
    }
    buf += c
    i++
  }
  flush()
  return out
}
