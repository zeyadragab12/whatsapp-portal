import { describe, expect, it } from 'vitest'
import {
  AUTH_BODY, buildAuthComponents, buildComponents, buildCreatePayload, buildEditPayload, categoryHints, defaultAuth, draftFromRow, hasErrors,
  metaNameFor, statusOf, validateTemplate, variablesOf, type AuthOptions, type TemplateDraft,
} from '../supabase/functions/_shared/templateRules'

const draft = (p: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'Rent reminder', category: 'UTILITY', language: 'en', parameterFormat: 'NAMED', headerText: '', media: null,
  body: 'Hello {{owner_name}}, your payment for unit {{unit_number}} is due on Friday.', footer: '', buttons: [], auth: null,
  examples: { owner_name: 'Ahmed', unit_number: 'A-120' }, ...p,
})
const auth = (p: Partial<AuthOptions> = {}): TemplateDraft => draft({ category: 'AUTHENTICATION', parameterFormat: 'POSITIONAL', body: AUTH_BODY, examples: {}, auth: { ...defaultAuth(), ...p } })
const codes = (d: TemplateDraft, ctx = {}) => validateTemplate(d, ctx).map((i) => i.code)
const has = (d: TemplateDraft, code: string, ctx = {}) => expect(codes(d, ctx)).toContain(code)
const lacks = (d: TemplateDraft, code: string, ctx = {}) => expect(codes(d, ctx)).not.toContain(code)

describe('a valid template', () => {
  it('has no issues and is ready', () => {
    const issues = validateTemplate(draft(), { knownFields: ['owner_name', 'unit_number'] })
    expect(issues).toEqual([])
    expect(statusOf(issues)).toBe('ready')
  })
})

describe('empty and incomplete forms', () => {
  it('an empty form is Incomplete, not Invalid', () => {
    const issues = validateTemplate(draft({ name: '', body: '', examples: {} }))
    expect(issues.filter((i) => i.severity === 'error').every((i) => i.missing)).toBe(true)
    expect(statusOf(issues)).toBe('incomplete')
  })
  it('whitespace-only name and body count as empty', () => {
    const c = codes(draft({ name: '   ', body: ' \n\t ', examples: {} }))
    expect(c).toContain('name.required'); expect(c).toContain('body.required')
  })
  it('placeholder-only or punctuation-only text is rejected', () => {
    has(draft({ body: '{{owner_name}}', examples: { owner_name: 'A' } }), 'body.placeholderOnly')
    has(draft({ body: '{{owner_name}} - !!', examples: { owner_name: 'A' } }), 'body.placeholderOnly')
  })
  it('a real error makes the status Invalid even when other things are missing', () => {
    expect(statusOf(validateTemplate(draft({ name: '', body: 'x'.repeat(1025), examples: {} })))).toBe('invalid')
  })
})

describe('name, category and language', () => {
  it('limits the display name and blocks control characters', () => {
    has(draft({ name: 'x'.repeat(81) }), 'name.long')
    has(draft({ name: 'bad\u0007name' }), 'name.control')
  })
  it('rejects a name another template of the company already uses, ignoring case and spaces', () => {
    has(draft({ name: 'Rent Reminder' }), 'name.duplicate', { existingNames: [' rent reminder '] })
    lacks(draft(), 'name.duplicate', { existingNames: ['Other'] })
  })
  it('warns when the name has no Latin letters, because Meta then sees a generic name', () => {
    has(draft({ name: 'تذكير بالإيجار' }), 'name.noLatin')
  })
  it('derives a Meta name of lowercase letters, digits and underscores', () => {
    const n = metaNameFor('Rent Reminder – May!', 'abcdef123')
    expect(n).toBe('rent_reminder_may_abcdef')
    expect(n).toMatch(/^[a-z0-9_]+$/)
    expect(metaNameFor('تذكير', 'abcdef123')).toBe('template_abcdef')
    expect(metaNameFor('a'.repeat(200), 'abcdef123').length).toBeLessThanOrEqual(512)
  })
  it('accepts only the three Meta categories', () => {
    has(draft({ category: 'PROMO' }), 'category.unsupported')
    has(draft({ category: '' }), 'category.required')
    for (const c of ['UTILITY', 'MARKETING']) lacks(draft({ category: c }), 'category.unsupported')
  })
  it('accepts only supported languages', () => {
    has(draft({ language: 'xx' }), 'language.unsupported')
    has(draft({ language: '' }), 'language.required')
    lacks(draft({ language: 'ar' }), 'language.unsupported')
  })
})

describe('body', () => {
  it('allows exactly 1024 characters and rejects 1025', () => {
    const pad = (n: number) => 'a'.repeat(n)
    lacks(draft({ body: pad(1024), examples: {} }), 'body.long')
    has(draft({ body: pad(1025), examples: {} }), 'body.long')
  })
  it('rejects control characters but allows line breaks', () => {
    has(draft({ body: 'Hello\u0000 world there', examples: {} }), 'body.control')
    lacks(draft({ body: 'Hello there\n\nSee you soon', examples: {} }), 'body.control')
  })
  it('warns when the text starts or ends with a field (Meta review guide)', () => {
    has(draft({ body: '{{owner_name}} your unit is ready for handover soon', examples: { owner_name: 'A' } }), 'body.dangling')
    has(draft({ body: 'Your unit is ready for handover, {{owner_name}}', examples: { owner_name: 'A' } }), 'body.dangling')
    lacks(draft(), 'body.dangling')
    // a warning, not a block
    expect(hasErrors(validateTemplate(draft({ body: 'Dear {{owner_name}}, thank you for your payment today.' })))).toBe(false)
  })
  it('marks a high field-to-text ratio as something to verify, because Meta publishes no number', () => {
    const d = draft({ body: 'x {{a}} {{b}} {{c}} y', examples: { a: '1', b: '2', c: '3' } })
    expect(validateTemplate(d).find((i) => i.code === 'body.ratio')?.severity).toBe('verify')
  })
})

describe('variables', () => {
  it('finds malformed braces', () => {
    for (const body of ['Hello {{owner_name', 'Hello owner_name}} today friend', 'Hello {{}} there friend']) has(draft({ body, examples: {} }), 'var.malformed')
  })
  it('rejects mixing numbered and named placeholders', () => {
    has(draft({ body: 'Hi {{1}} and {{owner_name}} welcome back', examples: { '1': 'a', owner_name: 'b' } }), 'var.mixed')
  })
  it('named templates need lowercase names starting with a letter', () => {
    has(draft({ body: 'Hi there {{OwnerName}} welcome back', examples: { OwnerName: 'A' } }), 'var.name')
    has(draft({ body: 'Hi there {{1}} welcome back', examples: { '1': 'A' } }), 'var.notNamed')
  })
  it('flags a digit in a named placeholder as unverified instead of inventing a rule', () => {
    const i = validateTemplate(draft({ body: 'Hi there {{field_1}} welcome back', examples: { field_1: 'A' } })).find((x) => x.code === 'var.nameDigits')
    expect(i?.severity).toBe('verify')
  })
  it('rejects a field that is not in the owner data when that list is known', () => {
    has(draft({ body: 'Hi there {{nickname}} welcome back', examples: { nickname: 'A' } }), 'var.unknownField', { knownFields: ['owner_name'] })
  })
  it('numbered templates must run 1, 2, 3 without gaps and in order', () => {
    const p = (body: string, ex: Record<string, string>) => draft({ parameterFormat: 'POSITIONAL', body, examples: ex })
    lacks(p('Hi {{1}}, unit {{2}} is ready for you', { 1: 'a', 2: 'b' }), 'var.sequence')
    has(p('Hi {{1}}, unit {{3}} is ready for you', { 1: 'a', 3: 'b' }), 'var.sequence')
    has(p('Hi {{2}}, unit {{1}} is ready for you', { 1: 'a', 2: 'b' }), 'var.sequence')
    has(p('Hi {{2}}, unit is ready for you today', { 2: 'a' }), 'var.sequence')
    has(p('Hi {{name}}, unit is ready for you today', {}), 'var.notPositional')
  })
  it('every field needs an example, shown separately from the token', () => {
    const d = draft({ examples: { owner_name: 'Ahmed' } })
    const miss = validateTemplate(d).find((i) => i.code === 'example.missing')
    expect(miss?.field).toBe('examples.unit_number')
    expect(miss?.missing).toBe(true)
    has(draft({ examples: { owner_name: '   ', unit_number: 'A' } }), 'example.missing')
  })
  it('an example cannot contain braces or line breaks', () => {
    has(draft({ examples: { owner_name: '{{x}}', unit_number: 'A' } }), 'example.token')
    has(draft({ examples: { owner_name: 'a\nb', unit_number: 'A' } }), 'example.control')
  })
  it('lists each variable once in order of appearance', () => {
    expect(variablesOf('{{b}} {{a}} {{b}}')).toEqual(['b', 'a'])
    expect(variablesOf(null)).toEqual([])
  })
})

describe('header', () => {
  it('limits text to 60 characters, one field, and a single line', () => {
    has(draft({ headerText: 'h'.repeat(61) }), 'header.long')
    lacks(draft({ headerText: 'h'.repeat(60) }), 'header.long')
    has(draft({ headerText: 'Hi {{owner_name}} {{unit_number}}' }), 'header.vars')
    has(draft({ headerText: 'two\nlines' }), 'header.control')
  })
  it('warns about formatting characters, which Meta says not to use', () => {
    has(draft({ headerText: '*Important*' }), 'header.markdown')
  })
  it('a field in the header needs an example too', () => {
    has(draft({ headerText: 'Hello {{city}}' }), 'example.missing')
  })
  it('is not allowed on Authentication', () => {
    has(auth({}) && { ...auth(), headerText: 'Code' }, 'auth.header')
  })
})

describe('footer', () => {
  it('limits the footer to 60 characters and forbids fields', () => {
    has(draft({ footer: 'f'.repeat(61) }), 'footer.long')
    has(draft({ footer: 'Ref {{owner_name}}' }), 'footer.vars')
    lacks(draft({ footer: 'Reply STOP to opt out' }), 'footer.long')
  })
})

describe('buttons', () => {
  const qr = (text: string) => ({ type: 'QUICK_REPLY' as const, text })
  const url = (text: string, u: string) => ({ type: 'URL' as const, text, url: u })
  const phone = (text: string, p: string) => ({ type: 'PHONE_NUMBER' as const, text, phone: p })
  it('allows 10 buttons in total and rejects 11', () => {
    lacks(draft({ buttons: Array.from({ length: 10 }, (_, i) => qr(`Option ${i}`)) }), 'buttons.max')
    has(draft({ buttons: Array.from({ length: 11 }, (_, i) => qr(`Option ${i}`)) }), 'buttons.max')
  })
  it('allows at most 2 links and 1 call button', () => {
    has(draft({ buttons: [url('A', 'https://a.com'), url('B', 'https://b.com'), url('C', 'https://c.com')] }), 'buttons.url')
    has(draft({ buttons: [phone('A', '+201010354164'), phone('B', '+201010354165')] }), 'buttons.phone')
  })
  it('keeps quick replies together', () => {
    has(draft({ buttons: [qr('Yes'), url('Site', 'https://a.com'), qr('No')] }), 'buttons.order')
    lacks(draft({ buttons: [qr('Yes'), qr('No'), url('Site', 'https://a.com')] }), 'buttons.order')
    lacks(draft({ buttons: [url('Site', 'https://a.com'), qr('Yes'), qr('No')] }), 'buttons.order')
  })
  it('needs a label of at most 25 characters', () => {
    has(draft({ buttons: [qr('')] }), 'button.required')
    has(draft({ buttons: [qr('x'.repeat(26))] }), 'button.long')
    lacks(draft({ buttons: [qr('x'.repeat(25))] }), 'button.long')
    has(draft({ buttons: [qr('Hi {{1}}')] }), 'button.vars')
  })
  it('warns on duplicate labels and on emoji', () => {
    has(draft({ buttons: [qr('Yes'), qr('yes')] }), 'button.duplicate')
    has(draft({ buttons: [qr('Yes 👍')] }), 'button.emoji')
  })
  it('accepts only https links and rejects unsafe schemes', () => {
    lacks(draft({ buttons: [url('Pay', 'https://pay.example.com/invoice')] }), 'url.scheme')
    for (const u of ['javascript:alert(1)', 'data:text/html,<b>x', 'file:///etc/passwd', 'ftp://a.com/x']) has(draft({ buttons: [url('Go', u)] }), 'url.scheme')
    has(draft({ buttons: [url('Go', 'http://a.com')] }), 'url.scheme')
    has(draft({ buttons: [url('Go', 'not a url')] }), 'url.invalid')
    has(draft({ buttons: [url('Go', '')] }), 'url.required')
  })
  it('rejects credentials, a host with no dot, spaces and over-long links', () => {
    has(draft({ buttons: [url('Go', 'https://user:pw@example.com')] }), 'url.credentials')
    has(draft({ buttons: [url('Go', 'https://localhost/a')] }), 'url.host')
    has(draft({ buttons: [url('Go', 'https://a.com/' + 'x'.repeat(2000))] }), 'url.long')
  })
  it('rejects a changing part in the link, because sending cannot fill it in yet', () => {
    has(draft({ buttons: [url('Go', 'https://a.com/pay?id={{1}}')] }), 'url.dynamic')
  })
  it('wants a phone number in international format', () => {
    lacks(draft({ buttons: [phone('Call', '+201010354164')] }), 'phone.invalid')
    for (const p of ['01010354164', '+0123456', '+20 101', 'abc']) has(draft({ buttons: [phone('Call', p)] }), 'phone.invalid')
    has(draft({ buttons: [phone('Call', '')] }), 'phone.required')
  })
})

describe('media header', () => {
  const media = (p = {}) => ({ kind: 'IMAGE' as const, mime: 'image/png', size: 1000, uploaded: true, ...p })
  it('accepts a finished upload of a supported type', () => {
    expect(codes(draft({ media: media() }))).not.toContain('media.type')
  })
  it('checks the MIME type, not the file name', () => {
    has(draft({ media: media({ mime: 'image/gif' }) }), 'media.type')
    has(draft({ media: media({ kind: 'VIDEO', mime: 'image/png' }) }), 'media.mismatch')
  })
  it('enforces 5 MB for images and 16 MB for videos', () => {
    lacks(draft({ media: media({ size: 5 * 1024 * 1024 }) }), 'media.size')
    has(draft({ media: media({ size: 5 * 1024 * 1024 + 1 }) }), 'media.size')
    lacks(draft({ media: media({ kind: 'VIDEO', mime: 'video/mp4', size: 16 * 1024 * 1024 }) }), 'media.size')
    has(draft({ media: media({ kind: 'VIDEO', mime: 'video/mp4', size: 16 * 1024 * 1024 + 1 }) }), 'media.size')
  })
  it('blocks an empty file and an unfinished upload', () => {
    has(draft({ media: media({ size: 0 }) }), 'media.empty')
    has(draft({ media: media({ uploaded: false }) }), 'media.pending')
  })
  it('is not allowed on Authentication', () => {
    has({ ...auth(), media: media() }, 'auth.media')
  })
})

describe('category guidance (never blocks)', () => {
  const util = (body: string) => draft({ body, examples: {} })
  it('Utility: promotional wording raises a review warning', () => {
    const i = validateTemplate(util('Get 20% off your next order, limited time offer!'))
    expect(i.some((x) => x.code === 'cat.promo' || x.code === 'cat.mixed')).toBe(true)
    expect(hasErrors(i)).toBe(false)
  })
  it('Utility: a transaction update mixed with an offer is called out as mixed', () => {
    has(util('Your invoice is due on Friday. Pay now and get a discount on your next payment.'), 'cat.mixed')
  })
  it('Utility: plain transactional wording is not flagged', () => {
    for (const b of ['Your payment of 4,500 EGP was received. Thank you.', 'Your appointment is confirmed for Sunday at 10 am.', 'تم استلام دفعتك بنجاح، شكراً لك.']) {
      expect(codes(util(b)).filter((c) => c.startsWith('cat.'))).toEqual([])
    }
  })
  it('Utility: Arabic promotional wording is caught', () => {
    has(util('خصم خاص 30% على جميع العروض لفترة محدودة'), 'cat.promo')
  })
  it('Utility: text that ties to nothing specific is flagged as unclear, not as an error', () => {
    const i = validateTemplate(util('Congratulations and best wishes from the whole team today'))
    expect(i.find((x) => x.code === 'cat.unclear')?.severity).toBe('warning')
  })
  it('Marketing is never flagged for promotional wording', () => {
    expect(categoryHints('MARKETING', 'Get 20% off today only')).toEqual([])
    expect(categoryHints('UTILITY', '')).toEqual([])
  })
})

describe('Authentication', () => {
  it('a valid copy-code template is ready', () => {
    expect(statusOf(validateTemplate(auth()))).toBe('ready')
  })
  it('forbids a header, footer text and custom buttons', () => {
    has({ ...auth(), headerText: 'Code' }, 'auth.header')
    has({ ...auth(), footer: 'Hello' }, 'auth.footer')
    has({ ...auth(), buttons: [{ type: 'URL', text: 'Go', url: 'https://a.com' }] }, 'auth.buttons')
  })
  it('needs the code expiry to be a whole number from 1 to 90, or empty', () => {
    for (const m of [0, 91, 1.5, -3]) has(auth({ code_expiration_minutes: m }), 'auth.expiry')
    for (const m of [1, 10, 90]) lacks(auth({ code_expiration_minutes: m }), 'auth.expiry')
    lacks(auth({ code_expiration_minutes: null }), 'auth.expiry')
  })
  it('keeps button labels short and free of emoji and links', () => {
    has(auth({ button_text: 'x'.repeat(26) }), 'auth.btnLong')
    has(auth({ button_text: 'Copy 👍' }), 'auth.btnEmoji')
    has(auth({ button_text: 'Visit https://a.com' }), 'auth.btnUrl')
  })
  it('one-tap needs an Android app with a valid package name and an 11-character hash', () => {
    has(auth({ otp_type: 'ONE_TAP' }), 'auth.apps')
    const app = (package_name: string, signature_hash: string) => auth({ otp_type: 'ONE_TAP', supported_apps: [{ package_name, signature_hash }] })
    lacks(app('com.example.app', 'K8a/AINcGX7'), 'auth.pkg'); lacks(app('com.example.app', 'K8a/AINcGX7'), 'auth.hash')
    has(app('example', 'K8a/AINcGX7'), 'auth.pkg')
    has(app('1com.example', 'K8a/AINcGX7'), 'auth.pkg')
    has(app('com.example.app', 'short'), 'auth.hash')
    has(app('com.example.app', 'K8a/AINcGX7!'), 'auth.hash')
    has(app('', ''), 'auth.pkgRequired'); has(app('', ''), 'auth.hashRequired')
  })
  it('allows at most 5 apps', () => {
    const apps = Array.from({ length: 6 }, (_, i) => ({ package_name: `com.example.a${i}`, signature_hash: 'K8a/AINcGX7' }))
    has(auth({ otp_type: 'ONE_TAP', supported_apps: apps }), 'auth.appsMax')
  })
  it('zero-tap needs the terms accepted', () => {
    const apps = [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }]
    has(auth({ otp_type: 'ZERO_TAP', supported_apps: apps }), 'auth.terms')
    lacks(auth({ otp_type: 'ZERO_TAP', supported_apps: apps, zero_tap_terms_accepted: true }), 'auth.terms')
  })
  it('says Android-only options need checking, and warns about an old API version', () => {
    const apps = [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }]
    has(auth({ otp_type: 'ONE_TAP', supported_apps: apps }), 'auth.android')
    has(auth({ otp_type: 'ONE_TAP', supported_apps: apps }), 'auth.legacyApi', { apiVersion: 'v20.0' })
    lacks(auth({ otp_type: 'ONE_TAP', supported_apps: apps }), 'auth.legacyApi', { apiVersion: 'v25.0' })
  })
  it('does not validate the fixed body, so wording and fields in it never produce errors', () => {
    expect(codes({ ...auth(), body: '' })).not.toContain('body.required')
  })
})

describe('payload mapping', () => {
  it('Utility with named fields, a header, a footer and buttons', () => {
    const d = draft({
      headerText: 'Payment due', footer: 'G Communities',
      buttons: [{ type: 'QUICK_REPLY', text: 'Paid' }, { type: 'URL', text: 'Pay', url: 'https://pay.example.com' }, { type: 'PHONE_NUMBER', text: 'Call', phone: '+201010354164' }],
    })
    expect(buildCreatePayload(d, 'rent_abc123')).toEqual({
      name: 'rent_abc123', language: 'en_US', category: 'UTILITY', parameter_format: 'NAMED',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Payment due' },
        { type: 'BODY', text: d.body, example: { body_text_named_params: [{ param_name: 'owner_name', example: 'Ahmed' }, { param_name: 'unit_number', example: 'A-120' }] } },
        { type: 'FOOTER', text: 'G Communities' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Paid' }, { type: 'URL', text: 'Pay', url: 'https://pay.example.com' }, { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+201010354164' }] },
      ],
    })
  })
  it('Marketing keeps the category and uses the Arabic locale code for Arabic', () => {
    const p = buildCreatePayload(draft({ category: 'MARKETING', language: 'ar', body: 'مرحباً بكم في عرضنا الجديد اليوم', examples: {} }), 'x_1')
    expect(p).toMatchObject({ category: 'MARKETING', language: 'ar' })
  })
  it('numbered templates send arrays of examples and no parameter_format', () => {
    const d = draft({ parameterFormat: 'POSITIONAL', headerText: 'Hi {{1}}', body: 'Unit {{1}} is due {{2}} today', examples: { 1: 'A-1', 2: 'Friday' } })
    const p = buildCreatePayload(d, 'x_1') as { components: { example?: unknown }[] }
    expect(p).not.toHaveProperty('parameter_format')
    expect(p.components[0].example).toEqual({ header_text: ['A-1'] })
    expect(p.components[1].example).toEqual({ body_text: [['A-1', 'Friday']] })
  })
  it('a media header sends the uploaded handle and no header text', () => {
    const d = draft({ headerText: 'ignored', media: { kind: 'IMAGE', mime: 'image/png', size: 1, uploaded: true } })
    expect(buildComponents(d, { headerHandle: 'h123' })[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h123'] } })
  })
  it('blank header, footer and buttons are left out', () => {
    const c = buildComponents(draft({ headerText: '  ', footer: ' ', buttons: [{ type: 'QUICK_REPLY', text: ' ' }] }))
    expect(c.map((x) => (x as { type: string }).type)).toEqual(['BODY'])
  })
  it('an edit sends components, and the category only until the first approval', () => {
    expect(buildEditPayload(draft(), false)).toHaveProperty('category', 'UTILITY')
    expect(buildEditPayload(draft(), true)).not.toHaveProperty('category')
  })
  it('Authentication copy code', () => {
    expect(buildCreatePayload(auth({ code_expiration_minutes: 10 }), 'otp_1')).toEqual({
      name: 'otp_1', language: 'en_US', category: 'AUTHENTICATION',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
      ],
    })
  })
  it('Authentication without a security note, expiry or labels sends the minimum', () => {
    expect(buildAuthComponents({ ...defaultAuth(), add_security_recommendation: false, code_expiration_minutes: null })).toEqual([
      { type: 'BODY', add_security_recommendation: false }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ])
  })
  it('Authentication one-tap on Graph v21+ lists the apps; older versions use the single-app fields', () => {
    const a = { ...defaultAuth(), otp_type: 'ONE_TAP' as const, button_text: 'Copy', autofill_text: 'Autofill', supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] }
    const button = (c: unknown[]) => (c[c.length - 1] as { buttons: unknown[] }).buttons[0]
    expect(button(buildAuthComponents(a, { apiVersion: 'v25.0' }))).toEqual({ type: 'OTP', otp_type: 'ONE_TAP', text: 'Copy', autofill_text: 'Autofill', supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] })
    expect(button(buildAuthComponents(a, { apiVersion: 'v20.0' }))).toEqual({ type: 'OTP', otp_type: 'ONE_TAP', text: 'Copy', autofill_text: 'Autofill', package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' })
  })
  it('Authentication zero-tap carries the accepted terms', () => {
    const a = { ...defaultAuth(), otp_type: 'ZERO_TAP' as const, zero_tap_terms_accepted: true, supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] }
    const c = buildAuthComponents(a) as { buttons?: { zero_tap_terms_accepted?: boolean; otp_type?: string }[] }[]
    expect(c[2].buttons?.[0]).toMatchObject({ otp_type: 'ZERO_TAP', zero_tap_terms_accepted: true })
  })
})

describe('rebuilding a draft from a stored row', () => {
  const row = { name: 'Rent', category: 'UTILITY', language: 'en', header_text: null, body_text: 'Hi {{owner_name}} welcome', footer_text: null, buttons: null, variables: [{ name: 'owner_name', example: 'Sara' }] }
  it('uses the stored examples and the named format by default', () => {
    expect(draftFromRow(row, null)).toMatchObject({ parameterFormat: 'NAMED', examples: { owner_name: 'Sara' }, buttons: [], auth: null })
  })
  it('imported numbered templates stay numbered', () => {
    expect(draftFromRow({ ...row, parameter_format: 'POSITIONAL' }, null).parameterFormat).toBe('POSITIONAL')
  })
  it('an Authentication row gets the fixed body and its saved options', () => {
    const d = draftFromRow({ ...row, category: 'AUTHENTICATION', body_text: 'whatever', auth_options: { otp_type: 'ONE_TAP' } }, null)
    expect(d.body).toBe(AUTH_BODY)
    expect(d.auth?.otp_type).toBe('ONE_TAP')
    expect(d.auth?.add_security_recommendation).toBe(true)
  })
})
