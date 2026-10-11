import { useI18n } from '../../lib/i18n'
import { statusOf, type Issue, type Status } from '../../../supabase/functions/_shared/templateRules'

const LABEL: Record<Status, string> = { incomplete: 'Incomplete', invalid: 'Invalid', warnings: 'Warnings', ready: 'Ready to submit' }
const TONE: Record<Status, string> = { incomplete: 'tone-neutral', invalid: 'tone-bad', warnings: 'tone-warn', ready: 'tone-ok' }

/** Moves keyboard focus to the input that an issue is about. */
export const focusField = (field: string) => {
  const parts = field.split('.')
  let el: HTMLElement | null = null
  while (parts.length && !el) { el = document.querySelector<HTMLElement>(`[data-field="${parts.join('.')}"]`); parts.pop() }
  el?.focus()
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

export function StatusChip({ status }: { status: Status }) {
  const { L } = useI18n()
  return <span className={`status ${TONE[status]}`}>{L(LABEL[status])}</span>
}

/** The state of the template and what to fix. A polite live region, so screen readers hear changes without being interrupted. */
export default function ValidationSummary({ issues, attempted }: { issues: Issue[]; attempted: boolean }) {
  const { L } = useI18n()
  const status = statusOf(issues)
  const errors = issues.filter((i) => i.severity === 'error')
  const notes = issues.filter((i) => i.severity !== 'error')
  return (
    <section className="card space-y-3 !my-10" aria-label={L('Template check')}>
      <div className="flex flex-wrap items-center gap-3">
        <h3>{L('Template check')}</h3>
        <span aria-live="polite" role="status"><StatusChip status={status} /></span>
      </div>
      <p className="text-sm text-ink-50">{L('This checks the template against the rules Meta publishes. It does not mean Meta will approve it: Meta reviews every template and can reject or recategorise it.')}</p>
      {errors.length > 0 && (
        <div>
          <p className="text-ink font-medium text-sm mb-2 flex items-center gap-2">
            <span className="status tone-bad">{errors.length}</span>
            {status === 'incomplete' && !attempted ? L('Still to fill in') : L('Must be fixed before you can submit')}
          </p>
          <ul className="space-y-2">
            {errors.map((i, n) => (
              <li key={`${i.code}-${i.field}-${n}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl px-4 py-3" style={{ background: 'var(--bad-bg)' }}>
                <span className="flex items-start gap-3 min-w-0 flex-1 basis-60">
                  <span className="status tone-bad shrink-0" style={{ background: 'var(--sheet)' }}>{i.missing ? L('Required') : L('Error')}</span>
                  <span className="text-ink">{i.message}</span>
                </span>
                <button type="button" className="btn btn-quiet btn-sm shrink-0" onClick={() => focusField(i.field)}>{L('Go to field')}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <p className="text-ink font-medium text-sm mb-2 flex items-center gap-2">
            <span className="status tone-warn">{notes.length}</span>
            {L('Worth a look. These do not stop you from submitting')}
          </p>
          <ul className="space-y-2">
            {notes.map((i, n) => {
              const verify = i.severity === 'verify'
              return (
                <li key={`${i.code}-${i.field}-${n}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl px-4 py-3" style={{ background: verify ? 'var(--info-bg)' : 'var(--warn-bg)' }}>
                  <span className="flex items-start gap-3 min-w-0 flex-1 basis-60">
                    <span className={`status shrink-0 ${verify ? 'tone-info' : 'tone-warn'}`} style={{ background: 'var(--sheet)' }}>{verify ? L('Check with Meta') : L('Warning')}</span>
                    <span className="text-ink">{i.message}</span>
                  </span>
                  {!i.field.startsWith('auth') && i.field !== 'category' && <button type="button" className="btn btn-quiet btn-sm shrink-0" onClick={() => focusField(i.field)}>{L('Go to field')}</button>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

/** The messages for one field, shown under its input. Required-but-empty messages wait until the field has been visited. */
export function FieldIssues({ issues, field, show }: { issues: Issue[]; field: string; show: boolean }) {
  const mine = issues.filter((i) => (i.field === field) && (show || !i.missing))
  if (!mine.length) return null
  return (
    <ul id={`issues-${field}`} className="text-sm space-y-0.5 mt-1">
      {mine.map((i, n) => <li key={n} className={i.severity === 'error' ? 'text-bad' : 'text-warn'}>{i.message}</li>)}
    </ul>
  )
}
