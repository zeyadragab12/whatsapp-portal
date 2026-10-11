/**
 * One set of WhatsApp template rules, used by the editor (live validation, preview, payload) and by the
 * submit-whatsapp-template Edge Function (the same checks again, server side). No imports, so it runs in
 * the browser, Deno and Vitest unchanged.
 *
 * Every limit below names its source. S-numbers refer to Meta's pages, listed in META_SOURCES. A rule that
 * Meta's pages do not state is marked `verify`, and a rule the portal itself enforces is marked `portal`.
 * Local validation is NOT Meta approval: Meta reviews every template and may reject or recategorise it.
 */

export type Category = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
export type ParamFormat = 'NAMED' | 'POSITIONAL'
export type OtpType = 'COPY_CODE' | 'ONE_TAP' | 'ZERO_TAP'
/** error blocks submission; warning needs a human look; verify is a rule Meta does not publish precisely. */
export type Severity = 'error' | 'warning' | 'verify'

export interface DraftButton { type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY'; text: string; url?: string; phone?: string }
export interface SupportedApp { package_name: string; signature_hash: string }
export interface AuthOptions {
  otp_type: OtpType
  add_security_recommendation: boolean
  code_expiration_minutes: number | null
  button_text: string
  autofill_text: string
  supported_apps: SupportedApp[]
  zero_tap_terms_accepted: boolean
}
export interface DraftMedia { kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mime: string; size: number; uploaded: boolean }
export interface TemplateDraft {
  name: string
  category: Category | string
  language: string
  parameterFormat: ParamFormat
  headerText: string
  media: DraftMedia | null
  body: string
  footer: string
  buttons: DraftButton[]
  auth: AuthOptions | null
  /** example value per variable name */
  examples: Record<string, string>
}
export interface Issue {
  code: string
  field: string
  severity: Severity
  /** true when the problem is only that something required is empty */
  missing?: boolean
  message: string
}
export interface ValidationContext {
  /** Graph API version the account uses, for example v25.0. Never upgraded silently. */
  apiVersion?: string | null
  /** names of the company's other templates, to catch duplicates */
  existingNames?: string[]
  /** owner field keys the portal can fill. When given, a named variable outside it is an error. */
  knownFields?: string[]
}
export type Status = 'incomplete' | 'invalid' | 'warnings' | 'ready'

export const META_SOURCES = {
  S1: 'https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/',
  S2: 'https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components',
  S3: 'https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates',
  S5: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization',
  S6: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates',
  S7: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/autofill-button-authentication-templates',
  S8: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/zero-tap-authentication-templates',
  S9: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management',
  S10: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review',
  S11: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates',
  MEDIA: 'https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media',
} as const

/** The rule table. `since` lets a rule depend on the Graph API version the account is pinned to. */
export const RULES = {
  metaNameMax: 512,                           // S1: max 512 chars, lowercase alphanumerics and underscores
  metaNameRe: /^[a-z0-9_]+$/,                 // S9
  displayNameMax: 80,                         // portal: the existing name column
  bodyMax: 1024,                              // S2
  headerTextMax: 60,                          // S2
  headerTextVars: 1,                          // S2: a text header supports 1 parameter
  footerMax: 60,                              // S2
  buttonsMax: 10,                             // S2
  quickReplyMax: 10, urlMax: 2, phoneMax: 1,  // S2
  buttonTextMax: 25,                          // S2
  urlLengthMax: 2000,                         // S2
  phoneLengthMax: 20,                         // S2
  otpLengthMax: 15,                           // S3: the code sent with an authentication template
  authExpiryMin: 1, authExpiryMax: 90,        // S3
  authAppsMax: 5,                             // S7
  packageNameMax: 224, signatureHashLen: 11,  // S7
  authSupportedAppsFromMajor: 21,             // S7: supported_apps array from Graph API v21.0
  imageMaxBytes: 5 * 1024 * 1024, videoMaxBytes: 16 * 1024 * 1024,   // MEDIA (Cloud API media limits; Meta states no separate limit for template samples)
  mediaTypes: { 'image/jpeg': 'IMAGE', 'image/png': 'IMAGE', 'video/mp4': 'VIDEO', 'video/3gpp': 'VIDEO' } as Record<string, 'IMAGE' | 'VIDEO'>,
} as const

export const LANGUAGES: Record<string, string> = { en: 'en_US', ar: 'ar' }   // portal language -> Meta locale (S4)
export const CATEGORIES: Category[] = ['UTILITY', 'MARKETING', 'AUTHENTICATION']
export const langCode = (l: string) => LANGUAGES[l] ?? 'en_US'
export const AUTH_BODY = '{{1}} is your verification code.'    // S3: fixed text, not customisable
export const defaultAuth = (): AuthOptions => ({
  otp_type: 'COPY_CODE', add_security_recommendation: true, code_expiration_minutes: 10,
  button_text: '', autofill_text: '', supported_apps: [], zero_tap_terms_accepted: false,
})

export const apiMajor = (version?: string | null): number | null => {
  const m = /^v?(\d+)/.exec(version ?? '')
  return m ? Number(m[1]) : null
}

/** What each category may contain, from S2, S3, S5 and S11. */
export const CATEGORY_RULES: Record<Category, { header: boolean; media: boolean; footer: boolean; buttons: ('QUICK_REPLY' | 'URL' | 'PHONE_NUMBER')[]; freeBody: boolean }> = {
  MARKETING: { header: true, media: true, footer: true, buttons: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'], freeBody: true },
  UTILITY: { header: true, media: true, footer: true, buttons: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'], freeBody: true },
  AUTHENTICATION: { header: false, media: false, footer: false, buttons: [], freeBody: false },
}

/* ------------------------------ variables ------------------------------ */

const TOKEN = /\{\{([^{}]*)\}\}/g
export const NAMED_RE = /^[a-z][a-z0-9_]*$/       // S1: lowercase and underscores. Digits are not mentioned by Meta, see the `verify` note below.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/

/** Placeholder names in order of first appearance, with duplicates removed. */
export const variablesOf = (s: string | null | undefined): string[] =>
  [...new Set([...(s ?? '').matchAll(TOKEN)].map((m) => m[1].trim()))]

const stripTokens = (s: string) => s.replace(TOKEN, '')
const blank = (s: string) => s.replace(/[\s​‎‏ ]/g, '') === ''

/** Checks the placeholders of one text. `prefix` is the field id. */
function checkVariables(text: string, field: string, format: ParamFormat, out: Issue[], ctx: ValidationContext) {
  const leftovers = stripTokens(text)
  if (/\{\{|\}\}/.test(leftovers) || /\{\{\s*\}\}/.test(text)) {
    out.push({ code: 'var.malformed', field, severity: 'error', message: 'A placeholder is not closed properly. Each one must look like {{name}} with two braces on each side.' })
  }
  const names = variablesOf(text)
  const numeric = names.filter((n) => /^\d+$/.test(n))
  const named = names.filter((n) => !/^\d+$/.test(n))
  if (numeric.length && named.length) {
    out.push({ code: 'var.mixed', field, severity: 'error', message: 'Numbered ({{1}}) and named ({{name}}) placeholders cannot be mixed in one template.' })
    return names
  }
  if (format === 'POSITIONAL') {
    if (named.length) out.push({ code: 'var.notPositional', field, severity: 'error', message: `This template uses numbered placeholders. ${named.map((n) => `{{${n}}}`).join(', ')} is not a number.` })
    const nums = numeric.map(Number)
    if (nums.some((n, i) => n !== i + 1)) {
      out.push({ code: 'var.sequence', field, severity: 'error', message: 'Numbered placeholders must start at {{1}}, have no gaps and appear in order (1, 2, 3 …). Meta rejects templates like 1, 2, 5, 4.' })
    }
  } else {
    if (numeric.length) out.push({ code: 'var.notNamed', field, severity: 'error', message: `This template uses named placeholders. ${numeric.map((n) => `{{${n}}}`).join(', ')} is a number.` })
    for (const n of named) {
      if (!NAMED_RE.test(n)) { out.push({ code: 'var.name', field, severity: 'error', message: `{{${n}}} is not a valid name. Use lowercase letters, digits and underscores, starting with a letter.` }); continue }
      if (ctx.knownFields && !ctx.knownFields.includes(n)) out.push({ code: 'var.unknownField', field, severity: 'error', message: `{{${n}}} is not a field in your owner data.` })
      if (/\d/.test(n)) out.push({ code: 'var.nameDigits', field, severity: 'verify', message: `{{${n}}} contains a digit. Meta's documentation only mentions lowercase letters and underscores, so check that Meta accepts it.` })
    }
  }
  return names
}

/* ------------------------------ category guidance ------------------------------ */

/** Words that read as promotion. Used only to raise a review warning, never to block. */
const PROMO_RE = [
  /\b\d{1,3}\s?%\s?(off|discount)?/i, /\b(discount|sale|offer|offers|promo|promotion|coupon|voucher|deal|deals|bargain|clearance|free gift|special price|limited[\s-]?time|exclusive|bonus|cashback)\b/i,
  /\b(buy now|shop now|order now|book now|don'?t miss|hurry|upgrade now|save up to|save \d)/i,
  /(خصم|خصومات|تخفيض|تخفيضات|عرض خاص|عروض|عرض لفترة|حصري|وفر|وفّر|اشتر|اشترِ|كوبون|قسيمة|هدية|لا تفوت|فرصة)/,
]
/** Words that read as a specific transaction, account or service update. */
const TRANSACT_RE = [
  /\b(order|invoice|receipt|payment|paid|due|overdue|installment|instalment|balance|statement|booking|reservation|appointment|delivery|delivered|shipped|shipment|tracking|ticket|request|account|contract|unit|handover|maintenance|reminder|confirm(ed|ation)?|verification|password|renewal notice)\b/i,
  /(طلب|فاتورة|إيصال|دفعة|دفع|مستحق|قسط|رصيد|كشف حساب|حجز|موعد|توصيل|شحنة|تذكرة|حساب|عقد|وحدة|استلام|صيانة|تذكير|تأكيد)/,
]
export interface CategoryHint { code: string; severity: Severity; message: string }

/**
 * Reads the text and says whether it looks like it belongs to a different category than the one chosen.
 * It only ever warns: Meta decides the category, and since 9 April 2025 it approves a Utility template
 * that looks promotional as Marketing instead of rejecting it (S5).
 */
export function categoryHints(category: string, text: string): CategoryHint[] {
  const t = stripTokens(text)
  if (blank(t)) return []
  const promo = PROMO_RE.some((r) => r.test(t))
  const transact = TRANSACT_RE.some((r) => r.test(t))
  if (category === 'UTILITY') {
    if (promo && transact) return [{ code: 'cat.mixed', severity: 'warning', message: 'This mixes a transaction update with promotional wording. Meta treats mixed content as Marketing, so it may approve it under that category (and its price). Review the wording or choose Marketing.' }]
    if (promo) return [{ code: 'cat.promo', severity: 'warning', message: 'This reads as promotional (offer, discount or a call to buy). Utility messages must be about a specific transaction, account or service. Meta may classify it as Marketing.' }]
    if (!transact) return [{ code: 'cat.unclear', severity: 'warning', message: 'Nothing here ties the message to a specific transaction, request or account. Meta treats unclear content as Marketing. Check that it is about something the owner asked for or agreed to.' }]
  }
  return []
}

/** Plain reminders shown beside a category. Not validation. */
export function categoryNotes(category: string): string[] {
  if (category === 'MARKETING') return [
    'Send marketing messages only to owners who agreed to receive WhatsApp messages from your company. Meta requires opt-in before you message anyone, and you must honour requests to stop.',
    'Meta does not require a fixed opt-out sentence inside the template. A quick-reply button such as “Stop” is a common way to let people opt out.',
    'WhatsApp does not deliver marketing templates to phone numbers in the United States.',
  ]
  if (category === 'UTILITY') return [
    'Utility templates must be about a specific transaction, account or service the owner asked for or agreed to, and must not contain offers, upselling or renewal pushes.',
  ]
  if (category === 'AUTHENTICATION') return [
    'Authentication templates have a fixed format set by Meta. Only the code, the security note, the expiry and the button can be chosen.',
    'One-tap and zero-tap autofill work only on Android and need your app’s package name and signature hash. Other devices fall back to a copy-code button.',
  ]
  return []
}

/* ------------------------------ validation ------------------------------ */

const looksPlaceholderOnly = (s: string) => blank(stripTokens(s).replace(/[\p{P}\p{S}\s]/gu, ''))
const hasEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s)
const URL_IN_TEXT = /(https?:\/\/|www\.)\S+/i

/** Meta display-name -> template name. Stable for the life of a template because the id suffix is fixed. */
export function metaNameFor(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'template'
  return `${slug}_${id.slice(0, 6)}`
}

export function validateTemplate(d: TemplateDraft, ctx: ValidationContext = {}): Issue[] {
  const out: Issue[] = []
  const add = (code: string, field: string, severity: Severity, message: string, missing = false) => out.push({ code, field, severity, message, ...(missing ? { missing } : {}) })
  const cat = d.category as Category
  const known = CATEGORIES.includes(cat)

  /* name */
  const name = d.name.trim()
  if (!name) add('name.required', 'name', 'error', 'Give the template a name.', true)
  else {
    if (name.length > RULES.displayNameMax) add('name.long', 'name', 'error', `The name can be up to ${RULES.displayNameMax} characters.`)
    if (CONTROL.test(name)) add('name.control', 'name', 'error', 'The name contains characters that cannot be shown.')
    if ((ctx.existingNames ?? []).some((n) => n.trim().toLowerCase() === name.toLowerCase())) add('name.duplicate', 'name', 'error', 'Another template of this company already has this name.')
    if (!/[a-z0-9]/i.test(name)) add('name.noLatin', 'name', 'warning', 'The name has no English letters or digits, so the name Meta sees will be a generic “template_…” one. Add a few English letters to tell your templates apart on Meta.')
    const probe = metaNameFor(name, 'abcdef')
    if (!RULES.metaNameRe.test(probe) || probe.length > RULES.metaNameMax) add('name.meta', 'name', 'error', 'This name cannot be turned into a valid Meta template name.')
  }

  /* category and language */
  if (!d.category) add('category.required', 'category', 'error', 'Choose a category.', true)
  else if (!known) add('category.unsupported', 'category', 'error', 'This category is not one Meta supports. Choose Utility, Marketing or Authentication.')
  if (!d.language) add('language.required', 'language', 'error', 'Choose a language.', true)
  else if (!LANGUAGES[d.language]) add('language.unsupported', 'language', 'error', 'This language is not supported by the portal yet.')

  if (cat === 'AUTHENTICATION') { validateAuth(d, ctx, add); return out }
  const caps = known ? CATEGORY_RULES[cat] : CATEGORY_RULES.MARKETING

  /* body */
  if (blank(d.body)) add('body.required', 'body', 'error', 'Write the message text.', true)
  else {
    if (d.body.length > RULES.bodyMax) add('body.long', 'body', 'error', `The message can be up to ${RULES.bodyMax} characters. It has ${d.body.length}.`)
    if (CONTROL.test(d.body)) add('body.control', 'body', 'error', 'The message contains control characters. Remove them.')
    if (looksPlaceholderOnly(d.body)) add('body.placeholderOnly', 'body', 'error', 'The message is only fields and punctuation. Add the words the owner should read.')
    const plain = stripTokens(d.body)
    const vars = variablesOf(d.body)
    if (vars.length && (/^\s*\{\{/.test(d.body) || /\}\}\s*$/.test(d.body))) {
      add('body.dangling', 'body', 'warning', 'The message starts or ends with a field. Meta’s review guide says a template cannot start or end with a parameter, so it may be rejected. Add a word before or after it.')
    }
    if (vars.length && plain.trim().length / vars.length < 15) {
      add('body.ratio', 'body', 'verify', 'Many fields for a short message. Meta rejects templates with too many variables for their length but publishes no exact ratio, so add more fixed text if Meta pushes back.')
    }
  }
  const bodyVars = checkVariables(d.body, 'body', d.parameterFormat, out, ctx)

  /* header */
  let headerVars: string[] = []
  if (d.media) {
    if (!caps.media) add('media.category', 'media', 'error', 'This category cannot have an image or video header.')
    const kind = RULES.mediaTypes[d.media.mime]
    if (d.media.kind !== 'DOCUMENT') {
      if (!kind) add('media.type', 'media', 'error', 'Use a JPG or PNG image, or an MP4 video.')
      else if (kind !== d.media.kind) add('media.mismatch', 'media', 'error', 'The file type does not match its kind. Upload the file again.')
      const max = d.media.kind === 'IMAGE' ? RULES.imageMaxBytes : RULES.videoMaxBytes
      if (d.media.size > max) add('media.size', 'media', 'error', `${d.media.kind === 'IMAGE' ? 'Images' : 'Videos'} can be up to ${max / 1048576} MB.`)
    }
    if (d.media.size <= 0) add('media.empty', 'media', 'error', 'The file is empty.')
    if (!d.media.uploaded) add('media.pending', 'media', 'error', 'The file has not finished uploading.')
    if (!blank(d.headerText)) add('header.both', 'header', 'warning', 'A header text is set as well as an image or video. Only the media is used.')
  } else if (!blank(d.headerText)) {
    if (!caps.header) add('header.category', 'header', 'error', 'This category cannot have a header.')
    if (d.headerText.length > RULES.headerTextMax) add('header.long', 'header', 'error', `The header can be up to ${RULES.headerTextMax} characters.`)
    if (CONTROL.test(d.headerText) || /[\r\n]/.test(d.headerText)) add('header.control', 'header', 'error', 'The header must be a single line of plain text.')
    if (/[*_~`]/.test(d.headerText)) add('header.markdown', 'header', 'warning', 'Meta says not to use formatting characters (* _ ~ `) in a header.')
    headerVars = checkVariables(d.headerText, 'header', d.parameterFormat, out, ctx)
    if (headerVars.length > RULES.headerTextVars) add('header.vars', 'header', 'error', `A text header can have only ${RULES.headerTextVars} field.`)
  } else if (d.headerText && blank(d.headerText)) add('header.blank', 'header', 'warning', 'The header only has spaces. It will be left out.')

  /* footer */
  if (d.footer && blank(d.footer)) add('footer.blank', 'footer', 'warning', 'The footer only has spaces. It will be left out.')
  else if (d.footer) {
    if (!caps.footer) add('footer.category', 'footer', 'error', 'This category cannot have a footer.')
    if (d.footer.length > RULES.footerMax) add('footer.long', 'footer', 'error', `The footer can be up to ${RULES.footerMax} characters.`)
    if (CONTROL.test(d.footer) || /[\r\n]/.test(d.footer)) add('footer.control', 'footer', 'error', 'The footer must be a single line of plain text.')
    if (variablesOf(d.footer).length || /\{\{|\}\}/.test(d.footer)) add('footer.vars', 'footer', 'error', 'The footer cannot contain fields. Meta’s component reference describes it as plain text.')
  }

  /* examples: every field needs one, shown separately from the placeholder */
  for (const v of [...new Set([...headerVars, ...bodyVars])]) {
    const ex = d.examples[v]
    if (ex === undefined || blank(ex)) add('example.missing', `examples.${v}`, 'error', `Give an example value for {{${v}}}. Meta reviews the template using it.`, true)
    else if (/\{\{|\}\}/.test(ex)) add('example.token', `examples.${v}`, 'error', `The example for {{${v}}} cannot contain braces.`)
    else if (CONTROL.test(ex) || /[\r\n\t]/.test(ex)) add('example.control', `examples.${v}`, 'error', `The example for {{${v}}} must be one line of plain text.`)
    else if (ex.length > 200) add('example.long', `examples.${v}`, 'warning', `The example for {{${v}}} is long. A short, realistic value reads best to reviewers.`)
  }

  /* buttons */
  validateButtons(d.buttons, caps.buttons, add)

  /* category fit: a review warning, never a block */
  if (cat === 'UTILITY') for (const h of categoryHints(cat, [d.headerText, d.body, d.footer, ...d.buttons.map((b) => b.text)].join('\n'))) add(h.code, 'category', h.severity, h.message)

  return out
}

function validateButtons(buttons: DraftButton[], allowed: string[], add: (c: string, f: string, s: Severity, m: string, miss?: boolean) => void) {
  if (buttons.length > RULES.buttonsMax) add('buttons.max', 'buttons', 'error', `A template can have up to ${RULES.buttonsMax} buttons.`)
  const count = (t: string) => buttons.filter((b) => b.type === t).length
  if (count('QUICK_REPLY') > RULES.quickReplyMax) add('buttons.qr', 'buttons', 'error', `Up to ${RULES.quickReplyMax} quick replies.`)
  if (count('URL') > RULES.urlMax) add('buttons.url', 'buttons', 'error', `Up to ${RULES.urlMax} link buttons.`)
  if (count('PHONE_NUMBER') > RULES.phoneMax) add('buttons.phone', 'buttons', 'error', `Only ${RULES.phoneMax} call button is allowed.`)
  // S2: quick replies must be grouped together
  const kinds = buttons.map((b) => (b.type === 'QUICK_REPLY' ? 'Q' : 'O')).join('')
  if (/Q+O+Q/.test(kinds)) add('buttons.order', 'buttons', 'error', 'Quick replies must be grouped together. Put all quick replies first, or all of them after the link and call buttons.')
  const seen = new Set<string>()
  buttons.forEach((b, i) => {
    const f = `buttons.${i}`
    const text = b.text.trim()
    if (!allowed.includes(b.type)) add('button.type', `${f}.type`, 'error', 'This button type is not allowed in this category.')
    if (!text) add('button.required', `${f}.text`, 'error', `Button ${i + 1} needs a label.`, true)
    else {
      if (text.length > RULES.buttonTextMax) add('button.long', `${f}.text`, 'error', `Button labels can be up to ${RULES.buttonTextMax} characters.`)
      if (CONTROL.test(text) || /[\r\n]/.test(text)) add('button.control', `${f}.text`, 'error', 'A button label must be one line of plain text.')
      if (/[{}]/.test(text)) add('button.vars', `${f}.text`, 'error', 'A button label cannot contain fields.')
      if (hasEmoji(text)) add('button.emoji', `${f}.text`, 'warning', 'Meta’s utility guide says button labels should be alphanumeric. Emoji may be rejected.')
      if (seen.has(text.toLowerCase())) add('button.duplicate', `${f}.text`, 'warning', 'Two buttons have the same label.')
      seen.add(text.toLowerCase())
    }
    if (b.type === 'URL') {
      const u = (b.url ?? '').trim()
      if (!u) add('url.required', `${f}.url`, 'error', `Button ${i + 1} needs a link.`, true)
      else {
        if (/\{\{/.test(u)) add('url.dynamic', `${f}.url`, 'error', 'Links with a changing part are not supported yet, because sending does not fill them in. Use a fixed link.')
        else {
          let parsed: URL | null = null
          try { parsed = new URL(u) } catch { /* reported below */ }
          if (!parsed) add('url.invalid', `${f}.url`, 'error', 'This is not a valid link. Start it with https://')
          else if (parsed.protocol !== 'https:') add('url.scheme', `${f}.url`, 'error', parsed.protocol === 'http:' ? 'Use an https:// link.' : `Links starting with ${parsed.protocol} are not allowed. Use an https:// link.`)
          else {
            if (parsed.username || parsed.password) add('url.credentials', `${f}.url`, 'error', 'A link cannot contain a user name or password.')
            if (!parsed.hostname.includes('.')) add('url.host', `${f}.url`, 'error', 'The link needs a full web address, such as https://example.com')
          }
        }
        if (u.length > RULES.urlLengthMax) add('url.long', `${f}.url`, 'error', `A link can be up to ${RULES.urlLengthMax} characters.`)
        if (/\s/.test(u)) add('url.space', `${f}.url`, 'error', 'A link cannot contain spaces.')
      }
    }
    if (b.type === 'PHONE_NUMBER') {
      const p = (b.phone ?? '').trim()
      if (!p) add('phone.required', `${f}.phone`, 'error', `Button ${i + 1} needs a phone number.`, true)
      else if (!/^\+[1-9]\d{6,14}$/.test(p) || p.length > RULES.phoneLengthMax) add('phone.invalid', `${f}.phone`, 'error', 'Use the international format, for example +201010354164.')
    }
  })
}

function validateAuth(d: TemplateDraft, ctx: ValidationContext, add: (c: string, f: string, s: Severity, m: string, miss?: boolean) => void) {
  const a = d.auth
  // S3: no header, media, footer text, URLs or custom buttons
  if (!blank(d.headerText)) add('auth.header', 'header', 'error', 'Authentication templates cannot have a header.')
  if (d.media) add('auth.media', 'media', 'error', 'Authentication templates cannot have an image or video.')
  if (!blank(d.footer)) add('auth.footer', 'footer', 'error', 'The footer of an authentication template is set by Meta. Use the expiry option instead.')
  if (d.buttons.length) add('auth.buttons', 'buttons', 'error', 'Authentication templates have one code button set by Meta. Remove the other buttons.')
  if (!a) { add('auth.options', 'auth', 'error', 'Choose how the code button works.', true); return }
  if (!['COPY_CODE', 'ONE_TAP', 'ZERO_TAP'].includes(a.otp_type)) add('auth.otpType', 'auth.otp_type', 'error', 'Choose copy code, one-tap or zero-tap.')
  if (a.code_expiration_minutes !== null) {
    const m = a.code_expiration_minutes
    if (!Number.isInteger(m) || m < RULES.authExpiryMin || m > RULES.authExpiryMax) add('auth.expiry', 'auth.code_expiration_minutes', 'error', `The expiry must be a whole number from ${RULES.authExpiryMin} to ${RULES.authExpiryMax} minutes.`)
  } else if (a.otp_type !== 'COPY_CODE') add('auth.expiryNone', 'auth.code_expiration_minutes', 'verify', 'Without an expiry, Meta disables the autofill button 10 minutes after the message is sent.')
  for (const [field, label, v] of [['button_text', 'copy-code button label', a.button_text], ['autofill_text', 'autofill button label', a.autofill_text]] as const) {
    const t = v.trim()
    if (!t) continue
    const f = `auth.${field}`
    if (t.length > RULES.buttonTextMax) add('auth.btnLong', f, 'error', `The ${label} can be up to ${RULES.buttonTextMax} characters.`)
    if (hasEmoji(t)) add('auth.btnEmoji', f, 'error', 'Emoji are not allowed in authentication templates.')
    if (URL_IN_TEXT.test(t)) add('auth.btnUrl', f, 'error', 'Links are not allowed in authentication templates.')
    if (CONTROL.test(t) || /[\r\n]/.test(t)) add('auth.btnControl', f, 'error', 'A button label must be one line of plain text.')
  }
  if (a.otp_type === 'ONE_TAP' || a.otp_type === 'ZERO_TAP') {
    const apps = a.supported_apps
    if (!apps.length) add('auth.apps', 'auth.supported_apps', 'error', 'Add your Android app’s package name and signature hash.', true)
    if (apps.length > RULES.authAppsMax) add('auth.appsMax', 'auth.supported_apps', 'error', `Up to ${RULES.authAppsMax} apps.`)
    apps.forEach((app, i) => {
      const f = `auth.supported_apps.${i}`
      const pkg = app.package_name.trim()
      if (!pkg) add('auth.pkgRequired', `${f}.package_name`, 'error', `App ${i + 1} needs a package name.`, true)
      else if (pkg.length > RULES.packageNameMax || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) add('auth.pkg', `${f}.package_name`, 'error', 'A package name has at least two parts separated by dots, each starting with a letter, for example com.example.app.')
      const h = app.signature_hash.trim()
      if (!h) add('auth.hashRequired', `${f}.signature_hash`, 'error', `App ${i + 1} needs a signature hash.`, true)
      else if (h.length !== RULES.signatureHashLen || !/^[A-Za-z0-9+/=]+$/.test(h)) add('auth.hash', `${f}.signature_hash`, 'error', `The signature hash is exactly ${RULES.signatureHashLen} characters (letters, digits, + / =).`)
    })
    const major = apiMajor(ctx.apiVersion)
    if (ctx.apiVersion && major !== null && major < RULES.authSupportedAppsFromMajor) add('auth.legacyApi', 'auth', 'warning', `This account uses Graph API ${ctx.apiVersion}. Meta moved app details into a list from v21.0, so the older format is sent.`)
  }
  if (a.otp_type === 'ZERO_TAP' && !a.zero_tap_terms_accepted) add('auth.terms', 'auth.zero_tap_terms_accepted', 'error', 'Zero-tap needs you to accept Meta’s zero-tap terms. Meta will not create the template otherwise.', true)
  if (a.otp_type !== 'COPY_CODE') add('auth.android', 'auth.otp_type', 'verify', 'One-tap and zero-tap work only on Android. Other devices show a copy-code button instead.')
}

/** Incomplete: only required things are empty. Invalid: something is wrong. Warnings: submittable, but worth a look. */
export function statusOf(issues: Issue[]): Status {
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.some((i) => !i.missing)) return 'invalid'
  if (errors.length) return 'incomplete'
  if (issues.length) return 'warnings'
  return 'ready'
}
export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === 'error')
export const issuesFor = (issues: Issue[], field: string) => issues.filter((i) => i.field === field || i.field.startsWith(`${field}.`))

/* ------------------------------ Meta payload ------------------------------ */

export interface PayloadOptions {
  /** handle Meta's upload API returned for the media sample */
  headerHandle?: string
  apiVersion?: string | null
}

const exampleList = (names: string[], d: TemplateDraft) => names.map((n) => d.examples[n]?.trim() || 'Sample')

/** The `components` array Meta's message_templates endpoint expects. */
export function buildComponents(d: TemplateDraft, o: PayloadOptions = {}): unknown[] {
  if (d.category === 'AUTHENTICATION') return buildAuthComponents(d.auth ?? defaultAuth(), o)
  const positional = d.parameterFormat === 'POSITIONAL'
  const named = (names: string[]) => names.map((n) => ({ param_name: n, example: d.examples[n]?.trim() || 'Sample' }))
  const components: unknown[] = []
  const hv = variablesOf(d.headerText), bv = variablesOf(d.body)
  if (d.media && o.headerHandle) {
    components.push({ type: 'HEADER', format: d.media.kind, example: { header_handle: [o.headerHandle] } })
  } else if (!d.media && !blank(d.headerText)) {
    components.push({ type: 'HEADER', format: 'TEXT', text: d.headerText.trim(),
      ...(hv.length ? { example: positional ? { header_text: exampleList(hv, d) } : { header_text_named_params: named(hv) } } : {}) })
  }
  components.push({ type: 'BODY', text: d.body,
    ...(bv.length ? { example: positional ? { body_text: [exampleList(bv, d)] } : { body_text_named_params: named(bv) } } : {}) })
  if (!blank(d.footer)) components.push({ type: 'FOOTER', text: d.footer.trim() })
  const buttons = d.buttons.filter((b) => b.text.trim())
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((b) => b.type === 'URL' ? { type: 'URL', text: b.text.trim(), url: (b.url ?? '').trim() }
        : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text.trim(), phone_number: (b.phone ?? '').trim() }
        : { type: 'QUICK_REPLY', text: b.text.trim() }),
    })
  }
  return components
}

/** Authentication components in the shape of S3, S6, S7 and S8. */
export function buildAuthComponents(a: AuthOptions, o: PayloadOptions = {}): unknown[] {
  const major = apiMajor(o.apiVersion)
  const legacy = major !== null && major < RULES.authSupportedAppsFromMajor
  const button: Record<string, unknown> = { type: 'OTP', otp_type: a.otp_type }
  if (a.button_text.trim()) button.text = a.button_text.trim()
  if (a.otp_type !== 'COPY_CODE') {
    if (a.autofill_text.trim()) button.autofill_text = a.autofill_text.trim()
    const apps = a.supported_apps.map((x) => ({ package_name: x.package_name.trim(), signature_hash: x.signature_hash.trim() }))
    if (legacy) { if (apps[0]) { button.package_name = apps[0].package_name; button.signature_hash = apps[0].signature_hash } } else button.supported_apps = apps
  }
  if (a.otp_type === 'ZERO_TAP') button.zero_tap_terms_accepted = a.zero_tap_terms_accepted
  return [
    { type: 'BODY', add_security_recommendation: a.add_security_recommendation },
    ...(a.code_expiration_minutes !== null ? [{ type: 'FOOTER', code_expiration_minutes: a.code_expiration_minutes }] : []),
    { type: 'BUTTONS', buttons: [button] },
  ]
}

/** The full request body for creating a template. */
export function buildCreatePayload(d: TemplateDraft, metaName: string, o: PayloadOptions = {}) {
  const base = { name: metaName, language: langCode(d.language), category: d.category, components: buildComponents(d, o) }
  // authentication templates are always numbered; the other categories use the draft's own format
  return d.category === 'AUTHENTICATION' ? base : { ...base, ...(d.parameterFormat === 'POSITIONAL' ? {} : { parameter_format: 'NAMED' }) }
}

/** Edits replace all components in place. The category can only be sent until the template is first approved (S9). */
export function buildEditPayload(d: TemplateDraft, approvedOnce: boolean, o: PayloadOptions = {}) {
  return { components: buildComponents(d, o), ...(approvedOnce ? {} : { category: d.category }) }
}

/** Rebuilds a draft from a stored template row, the way both the editor and the Edge Function need it. */
export interface TemplateRow {
  name: string; category: string; language: string; parameter_format?: string | null
  header_text: string | null; body_text: string; footer_text: string | null
  buttons: DraftButton[] | null; variables: { name: string; example?: string }[] | null
  auth_options?: Partial<AuthOptions> | null
}
export function draftFromRow(r: TemplateRow, media: DraftMedia | null): TemplateDraft {
  const isAuth = r.category === 'AUTHENTICATION'
  return {
    name: r.name, category: r.category, language: r.language,
    parameterFormat: isAuth || r.parameter_format === 'POSITIONAL' ? 'POSITIONAL' : 'NAMED',
    headerText: r.header_text ?? '', media, body: isAuth ? AUTH_BODY : r.body_text, footer: r.footer_text ?? '',
    buttons: r.buttons ?? [],
    auth: isAuth ? { ...defaultAuth(), ...(r.auth_options ?? {}) } : null,
    examples: Object.fromEntries((r.variables ?? []).map((v) => [v.name, v.example ?? ''])),
  }
}
