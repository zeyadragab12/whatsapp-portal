import { useI18n } from '../../lib/i18n'
import { AUTH_BODY, RULES, type AuthOptions, type Issue, type OtpType } from '../../../supabase/functions/_shared/templateRules'
import { Field } from '../ui'
import { FieldIssues } from './ValidationSummary'

const TYPES: { id: OtpType; label: string; hint: string }[] = [
  { id: 'COPY_CODE', label: 'Copy code', hint: 'The owner taps a button to copy the code. Works on every phone.' },
  { id: 'ONE_TAP', label: 'One-tap autofill', hint: 'Fills the code into your Android app with one tap. Other phones show a copy-code button.' },
  { id: 'ZERO_TAP', label: 'Zero-tap', hint: 'Your Android app receives the code without a tap. Other phones fall back to copy code.' },
]

/**
 * The builder for Authentication templates. Meta fixes the wording, so the only choices are the ones Meta allows:
 * how the code button works, the security note, the expiry and the button labels.
 */
export default function AuthBuilder({ value, onChange, issues, touched }: {
  value: AuthOptions; onChange: (a: AuthOptions) => void; issues: Issue[]; touched: (field: string) => boolean
}) {
  const { L } = useI18n()
  const set = (p: Partial<AuthOptions>) => onChange({ ...value, ...p })
  const bad = (f: string) => issues.some((i) => i.field === f && i.severity === 'error')
  const android = value.otp_type !== 'COPY_CODE'
  const setApp = (i: number, p: Partial<AuthOptions['supported_apps'][number]>) => set({ supported_apps: value.supported_apps.map((a, j) => (j === i ? { ...a, ...p } : a)) })
  return (
    <section className="card space-y-6 bordered-fields">
      <div>
        <h3 className="mb-1">{L('Verification code message')}</h3>
        <p className="text-sm text-ink-50">{L('Meta sets the wording of authentication messages. You choose how the code button works and what to add.')}</p>
      </div>
      <div>
        <p className="text-sm text-ink-50 mb-1">{L('Message text (set by Meta)')}</p>
        <p className="bg-paper rounded-xl px-4 py-2.5 text-ink" dir="ltr" data-field="auth">{AUTH_BODY}</p>
        <FieldIssues issues={issues} field="auth" show />
      </div>

      <fieldset className="border-0 p-0 m-0">
        <legend className="text-sm font-medium text-ink mb-2">{L('Code button')}</legend>
        <div className="space-y-2" role="radiogroup" aria-label={L('Code button')}>
          {TYPES.map((t) => (
            <label key={t.id} className="flex items-start gap-3 bg-paper rounded-xl px-4 py-3 cursor-pointer">
              <input type="radio" name="otp_type" className="mt-1" data-field={t.id === value.otp_type ? 'auth.otp_type' : undefined} checked={value.otp_type === t.id} onChange={() => set({ otp_type: t.id })} />
              <span><span className="block text-ink font-medium">{L(t.label)}</span><span className="block text-sm text-ink-50">{L(t.hint)}</span></span>
            </label>
          ))}
        </div>
        <FieldIssues issues={issues} field="auth.otp_type" show />
      </fieldset>

      <div className="grid sm:grid-cols-2 gap-6">
        <div>
          <Field label={`${L('Code expires after (minutes)')}`} hint={`${L('Optional. From')} ${RULES.authExpiryMin} ${L('to')} ${RULES.authExpiryMax}. ${L('Adds “This code expires in N minutes.” to the message.')}`}>
            <input data-field="auth.code_expiration_minutes" aria-invalid={bad('auth.code_expiration_minutes')} type="number" inputMode="numeric" min={RULES.authExpiryMin} max={RULES.authExpiryMax} step={1} dir="ltr"
              value={value.code_expiration_minutes ?? ''} onChange={(e) => set({ code_expiration_minutes: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <FieldIssues issues={issues} field="auth.code_expiration_minutes" show />
        </div>
        <label className="flex items-start gap-3 mt-7">
          <input type="checkbox" className="mt-1" checked={value.add_security_recommendation} onChange={(e) => set({ add_security_recommendation: e.target.checked })} />
          <span><span className="block text-ink font-medium">{L('Add a security note')}</span><span className="block text-sm text-ink-50">{L('“For your security, do not share this code.”')}</span></span>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-6">
        <div>
          <Field label={`${L('Copy-code button label')} (${value.button_text.length}/${RULES.buttonTextMax})`} hint={L('Optional. Meta uses a standard label when empty.')}>
            <input data-field="auth.button_text" aria-invalid={bad('auth.button_text')} value={value.button_text} onChange={(e) => set({ button_text: e.target.value })} />
          </Field>
          <FieldIssues issues={issues} field="auth.button_text" show />
        </div>
        {android && (
          <div>
            <Field label={`${L('Autofill button label')} (${value.autofill_text.length}/${RULES.buttonTextMax})`} hint={L('Optional. Meta uses a standard label when empty.')}>
              <input data-field="auth.autofill_text" aria-invalid={bad('auth.autofill_text')} value={value.autofill_text} onChange={(e) => set({ autofill_text: e.target.value })} />
            </Field>
            <FieldIssues issues={issues} field="auth.autofill_text" show />
          </div>
        )}
      </div>

      {android && (
        <div className="space-y-4">
          <div>
            <h3 className="mb-1">{L('Your Android app')} <span className="text-ink-50 text-sm font-normal">({value.supported_apps.length}/{RULES.authAppsMax})</span></h3>
            <p className="text-sm text-ink-50">{L('Meta needs the package name and the 11-character signature hash of the app that receives the code.')}</p>
          </div>
          <div data-field="auth.supported_apps" tabIndex={-1} className="outline-none"><FieldIssues issues={issues} field="auth.supported_apps" show /></div>
          {value.supported_apps.map((a, i) => {
            const f = `auth.supported_apps.${i}`
            return (
              <div key={i} className="grid sm:grid-cols-[1fr_12rem_auto] gap-4 items-start">
                <div>
                  <Field label={L('Package name')}><input data-field={`${f}.package_name`} aria-invalid={bad(`${f}.package_name`)} dir="ltr" placeholder="com.example.app" value={a.package_name} onChange={(e) => setApp(i, { package_name: e.target.value })} /></Field>
                  <FieldIssues issues={issues} field={`${f}.package_name`} show={touched(f)} />
                </div>
                <div>
                  <Field label={L('Signature hash')}><input data-field={`${f}.signature_hash`} aria-invalid={bad(`${f}.signature_hash`)} dir="ltr" maxLength={RULES.signatureHashLen + 4} value={a.signature_hash} onChange={(e) => setApp(i, { signature_hash: e.target.value })} /></Field>
                  <FieldIssues issues={issues} field={`${f}.signature_hash`} show={touched(f)} />
                </div>
                <button type="button" className="link-btn pt-7" onClick={() => set({ supported_apps: value.supported_apps.filter((_, j) => j !== i) })}>{L('Remove')}</button>
              </div>
            )
          })}
          {value.supported_apps.length < RULES.authAppsMax && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => set({ supported_apps: [...value.supported_apps, { package_name: '', signature_hash: '' }] })}>{L('Add app')}</button>
          )}
        </div>
      )}

      {value.otp_type === 'ZERO_TAP' && (
        <div>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" data-field="auth.zero_tap_terms_accepted" checked={value.zero_tap_terms_accepted} onChange={(e) => set({ zero_tap_terms_accepted: e.target.checked })} />
            <span><span className="block text-ink font-medium">{L('I accept Meta’s zero-tap terms')}</span><span className="block text-sm text-ink-50">{L('Meta will not create a zero-tap template unless this is accepted.')}</span></span>
          </label>
          <FieldIssues issues={issues} field="auth.zero_tap_terms_accepted" show={touched('auth')} />
        </div>
      )}
      <p className="text-sm text-ink-50">{L('Not every WhatsApp account can use every option. If Meta does not allow one for your account, it will say so when you submit.')}</p>
    </section>
  )
}
