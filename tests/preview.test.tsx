import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PhonePreview from '../src/components/PhonePreview'
import { I18nProvider } from '../src/lib/i18n'
import { buildPreview, type PreviewInput } from '../src/lib/templatePreview'
import { defaultAuth } from '../supabase/functions/_shared/templateRules'

const input = (p: Partial<PreviewInput> = {}): PreviewInput => ({
  category: 'UTILITY', language: 'en', header: '', body: 'Hello {{owner_name}}, unit {{unit_number}} is ready.', footer: '', buttons: [], media: null,
  auth: defaultAuth(), examples: { owner_name: 'Ahmed', unit_number: 'A-120' }, businessName: 'G Communities', ...p,
})
const show = (props: ReturnType<typeof buildPreview>) => renderToStaticMarkup(<I18nProvider><PhonePreview {...props} /></I18nProvider>)
const html = (p: Partial<PreviewInput> = {}) => show(buildPreview(input(p)))

describe('live preview', () => {
  it('shows example values for the fields while the template text keeps its tokens', () => {
    const out = html()
    expect(out).toContain('Ahmed'); expect(out).toContain('A-120')
    expect(out).not.toContain('{{owner_name}}')
    // the form state itself is untouched by rendering
    expect(input().body).toContain('{{owner_name}}')
  })
  it('a field with no example is shown as its token, never silently replaced', () => {
    expect(html({ examples: { owner_name: 'Ahmed' } })).toContain('{{unit_number}}')
  })
  it('updates when the body changes', () => {
    expect(html({ body: 'Changed text here' })).toContain('Changed text here')
    expect(html({ body: 'Changed text here' })).not.toContain('is ready')
  })
  it('updates when an example changes', () => {
    expect(html({ examples: { owner_name: 'Mona', unit_number: 'B-7' } })).toContain('Mona')
  })
  it('updates when the header, footer and business name change', () => {
    const out = html({ header: 'Handover notice', footer: 'Reply STOP to opt out', businessName: 'Palm Hills' })
    expect(out).toContain('Handover notice'); expect(out).toContain('Reply STOP to opt out'); expect(out).toContain('Palm Hills')
  })
  it('a header with a field shows the example', () => {
    expect(html({ header: 'Hi {{owner_name}}' })).toContain('Hi Ahmed')
  })
  it('shows buttons in order with an icon for each type', () => {
    const out = html({ buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'URL', text: 'Pay now', url: 'https://a.com' }, { type: 'PHONE_NUMBER', text: 'Call us', phone: '+2010' }] })
    expect(out.indexOf('Yes')).toBeLessThan(out.indexOf('Pay now')); expect(out.indexOf('Pay now')).toBeLessThan(out.indexOf('Call us'))
    expect(out).toContain('data-icon="URL"'); expect(out).toContain('data-icon="PHONE_NUMBER"'); expect(out).toContain('data-icon="QUICK_REPLY"')
  })
  it('hides unlabeled buttons and folds more than three into See all options', () => {
    expect(html({ buttons: [{ type: 'QUICK_REPLY', text: '  ' }] })).not.toContain('bubble-btn')
    const four = ['A', 'B', 'C', 'D'].map((text) => ({ type: 'QUICK_REPLY' as const, text }))
    const out = html({ buttons: four })
    expect(out).toContain('See all options'); expect(out).toContain('</svg>A</div>'); expect(out).not.toContain('</svg>D</div>')
  })
  it('shows a placeholder when the message is empty', () => {
    expect(html({ body: '', examples: {} })).toContain('Your message appears here as you type.')
  })
  it('renders bold, italic, strikethrough and monospace as elements', () => {
    const out = html({ body: '*bold* _italic_ ~gone~ ```code``` text here', examples: {} })
    expect(out).toContain('<strong>bold</strong>'); expect(out).toContain('<em>italic</em>'); expect(out).toContain('<s>gone</s>'); expect(out).toContain('wa-mono')
  })
  it('never interprets user text as HTML', () => {
    const out = html({ body: '<script>alert(1)</script> <img src=x onerror=alert(1)>', header: '<b>h</b>', footer: '<i>f</i>', buttons: [{ type: 'QUICK_REPLY', text: '<u>b</u>' }], examples: {} })
    expect(out).not.toContain('<script'); expect(out).not.toContain('<img src=x'); expect(out).not.toContain('<b>h'); expect(out).not.toContain('<i>f'); expect(out).not.toContain('<u>b')
    expect(out).toContain('&lt;script&gt;')
  })
  it('a hostile example value is shown as text too', () => {
    expect(html({ examples: { owner_name: '<img src=x onerror=alert(1)>', unit_number: 'A' } })).not.toContain('<img src=x')
  })
  it('long text wraps instead of overflowing', () => {
    const out = html({ body: 'w'.repeat(1024), examples: {} })
    expect(out).toContain('break-words'); expect(out).toContain('w'.repeat(1024))
  })
  it('sets right-to-left for Arabic and shows Arabic text', () => {
    const out = html({ language: 'ar', body: 'مرحباً {{owner_name}}، وحدتك جاهزة للاستلام.', examples: { owner_name: 'أحمد' } })
    expect(out).toContain('dir="rtl"'); expect(out).toContain('أحمد')
    expect(html()).toContain('dir="ltr"')
  })
  it('mixed Arabic and English text renders', () => {
    expect(html({ body: 'Unit A-120 وحدة رقم', examples: {} })).toContain('Unit A-120 وحدة رقم')
  })
  it('a media header replaces the header text and handles a missing file', () => {
    const noFile = show({ body: 'hi there', header: 'ignored', media: { kind: 'IMAGE' } })
    expect(noFile).toContain('no file yet'); expect(noFile).toContain('wa-media')
    const withUrl = html({ header: 'Title', media: { kind: 'IMAGE', name: 'x', url: 'https://cdn.example.com/a.png' } })
    expect(withUrl).toContain('<img'); expect(withUrl).not.toContain('Title')
    expect(html({ media: { kind: 'VIDEO', name: 'x', url: 'https://cdn.example.com/a.mp4' } })).toContain('<video')
  })
  it('a document header shows its name', () => {
    expect(show({ body: 'hi there', media: { kind: 'DOCUMENT', name: 'contract.pdf' } })).toContain('contract.pdf')
  })
  it('puts the buttons inside the same card as the message, like WhatsApp', () => {
    const out = html({ buttons: [{ type: 'URL', text: 'Pay', url: 'https://a.com' }] })
    expect(out.indexOf('class="bubble"')).toBeLessThan(out.indexOf('bubble-btns'))
    expect(out.indexOf('bubble-btns')).toBeLessThan(out.indexOf('phone-note'))
    expect(out.indexOf('bubble-time')).toBeLessThan(out.indexOf('bubble-btns'))
  })
  it('says that it is only a preview, and can be shown wide', () => {
    expect(html()).toContain('Preview only')
    expect(html({ wide: true })).toContain('phone-wide')
  })
})

describe('category-specific preview', () => {
  const authHtml = (p: Partial<PreviewInput> = {}) => html({ category: 'AUTHENTICATION', ...p })
  it('Authentication shows the fixed message, security note, expiry and a copy-code button', () => {
    const out = authHtml({ auth: { ...defaultAuth(), code_expiration_minutes: 5 } })
    expect(out).toContain('<strong>123456</strong>'); expect(out).toContain('is your verification code.')
    expect(out).toContain('do not share this code'); expect(out).toContain('expires in 5 minutes'); expect(out).toContain('Copy code')
  })
  it('Authentication reflects each option', () => {
    expect(authHtml({ auth: { ...defaultAuth(), add_security_recommendation: false } })).not.toContain('do not share')
    expect(authHtml({ auth: { ...defaultAuth(), code_expiration_minutes: null } })).not.toContain('expires')
    expect(authHtml({ auth: { ...defaultAuth(), code_expiration_minutes: 1 } })).toContain('1 minute.')
    expect(authHtml({ auth: { ...defaultAuth(), otp_type: 'ONE_TAP', autofill_text: 'Fill it' } })).toContain('Fill it')
    expect(authHtml({ auth: { ...defaultAuth(), otp_type: 'ZERO_TAP' } })).toContain('Autofill')
    expect(authHtml({ auth: { ...defaultAuth(), button_text: 'Copy my code' } })).toContain('Copy my code')
  })
  it('Authentication ignores a header, media and buttons left in the form state', () => {
    const out = authHtml({ header: 'Hidden', footer: 'Hidden footer', buttons: [{ type: 'URL', text: 'Hidden button', url: 'https://a.com' }], media: { kind: 'IMAGE', name: 'x', url: 'https://a.com/x.png' } })
    expect(out).not.toContain('Hidden'); expect(out).not.toContain('<img')
  })
  it('Authentication in Arabic is right-to-left', () => {
    expect(authHtml({ language: 'ar' })).toContain('dir="rtl"')
  })
  it('Marketing and Utility render the same way', () => {
    expect(html({ category: 'MARKETING' })).toContain('Ahmed')
  })
})
