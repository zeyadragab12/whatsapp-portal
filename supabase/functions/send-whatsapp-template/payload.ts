export interface TemplateLike {
  meta_name: string | null
  language: string
  header_text: string | null
  body_text: string
  parameter_format?: string | null
}

export const extractVars = (s: string | null | undefined): string[] =>
  [...new Set([...(s ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))]

export const langCode = (l: string) => (l === 'ar' ? 'ar' : 'en_US')

// Meta rejects newlines, tabs and runs of more than 4 spaces inside parameter values.
export const cleanParam = (v: string) => v.replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim()

export interface HeaderMedia { kind: 'IMAGE' | 'VIDEO'; url: string }

export function buildPayload(tpl: TemplateLike, values: Record<string, string>, phone: string, media?: HeaderMedia | null) {
  const positional = tpl.parameter_format === 'POSITIONAL'
  const order = (names: string[]) => (positional ? [...names].sort((a, b) => Number(a) - Number(b)) : names)
  const params = (names: string[]) =>
    order(names).map((n) => (positional
      ? { type: 'text', text: cleanParam(values[n] ?? '') }
      : { type: 'text', parameter_name: n, text: cleanParam(values[n] ?? '') }))
  const components: unknown[] = []
  const header = extractVars(tpl.header_text)
  const body = extractVars(tpl.body_text)
  if (media) components.push({ type: 'header', parameters: [media.kind === 'VIDEO' ? { type: 'video', video: { link: media.url } } : { type: 'image', image: { link: media.url } }] })
  else if (header.length) components.push({ type: 'header', parameters: params(header) })
  if (body.length) components.push({ type: 'body', parameters: params(body) })
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone.replace(/^\+/, ''),
    type: 'template',
    template: { name: tpl.meta_name ?? '', language: { code: langCode(tpl.language) }, components },
  }
}
