import { useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { buildCreatePayload, hasErrors, statusOf, variablesOf, type Issue, type TemplateDraft } from '../../../supabase/functions/_shared/templateRules'
import { Modal } from '../Dialog'
import { ErrorNote, Notice } from '../ui'
import PhonePreview, { type PreviewProps } from '../PhonePreview'
import { StatusChip } from './ValidationSummary'

/** The last look before a template goes to Meta: everything that will be sent, a rendered preview and every open warning. */
export default function SubmitReview({ draft, issues, preview, busy, error, edit, onSubmit, onClose }: {
  draft: TemplateDraft; issues: Issue[]; preview: PreviewProps; busy: boolean; error: string; edit: boolean
  onSubmit: () => void; onClose: () => void
}) {
  const { L } = useI18n()
  const [ack, setAck] = useState(false)
  const blocked = hasErrors(issues)
  const notes = issues.filter((i) => i.severity !== 'error')
  const vars = [...new Set([...variablesOf(draft.headerText), ...variablesOf(draft.body)])]
  const auth = draft.category === 'AUTHENTICATION'
  const row = (k: string, v: string | null | undefined) => v ? <div className="grid grid-cols-[8rem_1fr] gap-3 py-2 border-b border-ink-25 last:border-0"><dt className="text-ink-50 text-sm">{k}</dt><dd className="text-ink break-words whitespace-pre-wrap" dir="auto">{v}</dd></div> : null
  return (
    <Modal title={edit ? L('Send changes to Meta') : L('Submit to Meta for approval')} onClose={onClose} size="xl">
      <div className="grid md:grid-cols-[1fr_auto] gap-8">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-3"><StatusChip status={statusOf(issues)} /></div>
          <dl>
            {row(L('Name'), draft.name)}
            {row(L('Language'), draft.language === 'ar' ? 'العربية (ar)' : 'English (en_US)')}
            {row(L('Category'), draft.category)}
            {!auth && row(L('Header'), draft.media ? `${draft.media.kind.toLowerCase()} (${draft.media.mime})` : draft.headerText.trim())}
            {row(L('Message'), auth ? `${draft.body}  (${L('set by Meta')})` : draft.body)}
            {vars.length > 0 && row(L('Examples'), vars.map((v) => `{{${v}}} → ${draft.examples[v] ?? ''}`).join('\n'))}
            {!auth && row(L('Footer'), draft.footer.trim())}
            {!auth && draft.buttons.length > 0 && row(L('Buttons'), draft.buttons.map((b) => `${b.text}${b.url ? ` → ${b.url}` : b.phone ? ` → ${b.phone}` : ''}`).join('\n'))}
            {auth && draft.auth && row(L('Code button'), draft.auth.otp_type.replace('_', ' ').toLowerCase())}
            {auth && draft.auth && row(L('Expiry'), draft.auth.code_expiration_minutes !== null ? `${draft.auth.code_expiration_minutes} min` : L('none'))}
          </dl>
          {notes.length > 0 && (
            <div className="space-y-2">
              <p className="text-ink font-medium">{L('Review these before you submit')}</p>
              <ul className="space-y-1 text-sm text-ink-75 list-disc ps-5">{notes.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
              {!blocked && (
                <label className="flex items-start gap-3 pt-1">
                  <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span className="text-ink">{L('I have read these and want to submit anyway.')}</span>
                </label>
              )}
            </div>
          )}
          {blocked && <ErrorNote>{L('Fix the problems in the form before submitting.')}</ErrorNote>}
          <Notice>{L('Meta reviews every template. This can take from a few minutes to a day, and it may be rejected or placed in a different category. It shows as Approved only once Meta says so.')}</Notice>
          <details>
            <summary className="text-sm text-ink-75">{L('What will be sent to Meta')}</summary>
            <pre className="text-xs bg-paper rounded-xl p-3 mt-2 overflow-x-auto" dir="ltr">{JSON.stringify(buildCreatePayload(draft, '<generated_name>', { headerHandle: draft.media ? '<uploaded on submit>' : undefined }), null, 2)}</pre>
          </details>
          {error && <p role="alert" className="notice notice-bad whitespace-pre-line">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3 !mt-0">
            <button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>{L('Back to editing')}</button>
            <button type="button" className="btn" disabled={busy || blocked || (notes.length > 0 && !ack)} onClick={onSubmit}>{busy ? L('Submitting…') : edit ? L('Send changes to Meta') : L('Submit to Meta')}</button>
          </div>
        </div>
        <div className="justify-self-center"><PhonePreview {...preview} /></div>
      </div>
    </Modal>
  )
}
