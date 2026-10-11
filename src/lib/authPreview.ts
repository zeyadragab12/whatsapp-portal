import { type AuthOptions } from '../../supabase/functions/_shared/templateRules'

/**
 * What an authentication message looks like in the preview. Meta writes this wording itself in the template's
 * language, so it is only approximate here (the Arabic lines especially).
 */
const TEXT = {
  en: { body: 'is your verification code.', security: 'For your security, do not share this code.', expires: (n: number) => `This code expires in ${n} ${n === 1 ? 'minute' : 'minutes'}.`, copy: 'Copy code', autofill: 'Autofill' },
  ar: { body: 'هو رمز التحقق الخاص بك.', security: 'لأمانك، لا تشارك هذا الرمز مع أحد.', expires: (n: number) => `ينتهي هذا الرمز خلال ${n} دقيقة.`, copy: 'نسخ الرمز', autofill: 'ملء تلقائي' },
}

export function authPreview(a: AuthOptions, language: string, code = '123456') {
  const t = TEXT[language === 'ar' ? 'ar' : 'en']
  return {
    body: `*${code}* ${t.body}${a.add_security_recommendation ? ` ${t.security}` : ''}`,
    footer: a.code_expiration_minutes !== null ? t.expires(a.code_expiration_minutes) : null,
    buttons: [a.otp_type === 'COPY_CODE'
      ? { type: 'COPY_CODE' as const, text: a.button_text.trim() || t.copy }
      : { type: 'AUTOFILL' as const, text: a.autofill_text.trim() || t.autofill }],
  }
}
