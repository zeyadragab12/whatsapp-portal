import type { PreviewProps } from '../components/PhonePreview'
import type { AuthOptions } from '../../supabase/functions/_shared/templateRules'
import { authPreview } from './authPreview'
import type { MediaAsset, TButton } from './types'

export interface PreviewInput {
  category: string
  language: string
  header: string
  body: string
  footer: string
  buttons: TButton[]
  media: (Pick<MediaAsset, 'kind' | 'name'> & { url: string }) | null
  auth: AuthOptions
  examples: Record<string, string>
  businessName: string
  wide?: boolean
}

/** Everything the preview shows, derived from the form's state alone. The editor and the tests both use this. */
export function buildPreview(i: PreviewInput): PreviewProps {
  const dir = i.language === 'ar' ? 'rtl' : 'ltr'
  if (i.category === 'AUTHENTICATION') {
    const p = authPreview(i.auth, i.language)
    return { body: p.body, footer: p.footer, buttons: p.buttons, dir, businessName: i.businessName, wide: i.wide }
  }
  return {
    header: i.media ? null : i.header, body: i.body, footer: i.footer,
    buttons: i.buttons.map((b) => ({ type: b.type, text: b.text })),
    media: i.media, examples: i.examples, dir, businessName: i.businessName, wide: i.wide,
  }
}
