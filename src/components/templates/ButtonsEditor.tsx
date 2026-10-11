import { useI18n } from '../../lib/i18n'
import type { TButton } from '../../lib/types'
import { CATEGORY_RULES, RULES, type Category, type Issue } from '../../../supabase/functions/_shared/templateRules'
import { Field } from '../ui'
import Select from '../Select'
import { FieldIssues } from './ValidationSummary'

const TYPE_LABEL = { QUICK_REPLY: 'Quick reply', URL: 'Link', PHONE_NUMBER: 'Call' } as const
const LIMIT = { QUICK_REPLY: RULES.quickReplyMax, URL: RULES.urlMax, PHONE_NUMBER: RULES.phoneMax }

/** The buttons of a template. Offers only the types the category allows and stops at Meta's per-type limits. */
export default function ButtonsEditor({ buttons, onChange, category, issues, touched }: {
  buttons: TButton[]; onChange: (b: TButton[]) => void; category: Category; issues: Issue[]; touched: (field: string) => boolean
}) {
  const { t, L } = useI18n()
  const allowed = CATEGORY_RULES[category].buttons
  const count = (type: TButton['type']) => buttons.filter((b) => b.type === type).length
  const patch = (i: number, p: Partial<TButton>) => onChange(buttons.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const move = (i: number, d: number) => {
    const next = [...buttons]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    onChange(next)
  }
  const firstFree = allowed.find((a) => count(a) < LIMIT[a])
  const bad = (f: string) => issues.some((i) => i.field === f && i.severity === 'error')
  return (
    <section>
      <h3 className="mb-1">{L('Buttons')} <span className="text-ink-50 text-sm font-normal">({buttons.length}/{RULES.buttonsMax})</span></h3>
      <p className="text-sm text-ink-50 mb-3">{L('Quick replies must stay together, either before or after the link and call buttons. Up to 2 links and 1 call button.')}</p>
      <div data-field="buttons" tabIndex={-1} className="outline-none">
        <FieldIssues issues={issues} field="buttons" show />
      </div>
      {buttons.map((b, i) => {
        const f = `buttons.${i}`
        return (
          <div key={i} className="mb-6">
            <div className="grid sm:grid-cols-[10rem_1fr_1fr_auto] gap-4 items-start">
              <Field label={L('Type')}>
                <Select data-field={`${f}.type`} value={b.type} onChange={(e) => patch(i, { type: e.target.value as TButton['type'] })}>
                  {allowed.map((a) => <option key={a} value={a} disabled={a !== b.type && count(a) >= LIMIT[a]}>{L(TYPE_LABEL[a])}</option>)}
                </Select>
              </Field>
              <div>
                <Field label={`${L('Label')} (${b.text.length}/${RULES.buttonTextMax})`}>
                  <input data-field={`${f}.text`} aria-invalid={bad(`${f}.text`)} value={b.text} onChange={(e) => patch(i, { text: e.target.value })} />
                </Field>
                <FieldIssues issues={issues} field={`${f}.text`} show={touched(f)} />
              </div>
              {b.type === 'URL' && (
                <div>
                  <Field label="URL"><input data-field={`${f}.url`} aria-invalid={bad(`${f}.url`)} dir="ltr" inputMode="url" placeholder="https://" value={b.url ?? ''} onChange={(e) => patch(i, { url: e.target.value })} /></Field>
                  <FieldIssues issues={issues} field={`${f}.url`} show={touched(f)} />
                </div>
              )}
              {b.type === 'PHONE_NUMBER' && (
                <div>
                  <Field label={L('Phone')}><input data-field={`${f}.phone`} aria-invalid={bad(`${f}.phone`)} dir="ltr" inputMode="tel" placeholder="+201010354164" value={b.phone ?? ''} onChange={(e) => patch(i, { phone: e.target.value })} /></Field>
                  <FieldIssues issues={issues} field={`${f}.phone`} show={touched(f)} />
                </div>
              )}
              {b.type === 'QUICK_REPLY' && <span />}
              <div className="flex items-center gap-3 pt-7">
                <button type="button" className="link-btn" disabled={i === 0} aria-label={`${L('Move up')} ${i + 1}`} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="link-btn" disabled={i === buttons.length - 1} aria-label={`${L('Move down')} ${i + 1}`} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="link-btn" onClick={() => onChange(buttons.filter((_, j) => j !== i))}>{t('remove')}</button>
              </div>
            </div>
          </div>
        )
      })}
      {buttons.length < RULES.buttonsMax && firstFree && (
        <button type="button" className="btn btn-quiet btn-sm mt-1" onClick={() => onChange([...buttons, { type: firstFree, text: '' }])}>{L('Add button')}</button>
      )}
    </section>
  )
}
