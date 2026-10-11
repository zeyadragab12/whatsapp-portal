import type { ReactNode } from 'react'
import { useI18n, type Key } from '../lib/i18n'
import Select from './Select'

const TONE: Record<string, string> = {
  APPROVED: 'tone-ok', DELIVERED: 'tone-ok', READ: 'tone-ok', SENT: 'tone-ok', active: 'tone-ok', approved: 'tone-ok',
  PENDING_APPROVAL: 'tone-info', QUEUED: 'tone-info', pending: 'tone-info',
  DRAFT: 'tone-neutral', ARCHIVED: 'tone-neutral', draft: 'tone-neutral',
  FAILED: 'tone-bad', REJECTED: 'tone-bad', rejected: 'tone-bad', suspended: 'tone-bad',
}

export function StatusLabel({ value }: { value: string }) {
  const { L, t } = useI18n()
  const nice = value.toLowerCase().replace(/_/g, ' ')
  const label = ['pending', 'approved', 'rejected', 'suspended', 'draft'].includes(value) ? t(value as Key) : L(nice.charAt(0).toUpperCase() + nice.slice(1))
  return <span className={`status ${TONE[value] ?? 'tone-warn'}`}>{label}</span>
}

export function SampleTag() {
  const { t } = useI18n()
  return <span className="status tone-neutral ms-2">{t('sample')}</span>
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function PageHead({ title, children, sub }: { title: string; children?: ReactNode; sub?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-7">
      <div className="min-w-0">
        <h1>{title}</h1>
        {sub && <p className="mt-1.5 text-ink-50 max-w-2xl">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  )
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'ok' | 'warn' | 'bad' }) {
  return <p role="status" className={`notice ${tone === 'info' ? '' : `notice-${tone}`}`}>{children}</p>
}
export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="notice notice-bad">{children}</p>
}

/** Small box that explains why something is locked, on hover or keyboard focus. */
export function Tip({ id, text, children }: { id: string; text: string; children: ReactNode }) {
  return <span className="tip-wrap">{children}<span id={id} role="tooltip" className="tip">{text}</span></span>
}

/** The companies a filter should cover: the chosen one, or every company the person can open. */
export const entityScope = (value: string, entities: { id: string }[]) => (value ? [value] : entities.map((e) => e.id))

/** Company filter. Lists only the companies this person can open. "All" appears when there are several and means exactly those. */
export function EntityFilter({ entities, value, onChange }: { entities: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  const { L } = useI18n()
  return (
    <Select value={entities.length > 1 ? value : (entities[0]?.id ?? '')} onChange={(e) => onChange(e.target.value)} disabled={entities.length <= 1}>
      {entities.length > 1 && <option value="">{L('All my companies')} ({entities.length})</option>}
      {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
    </Select>
  )
}

export function Loading() {
  const { t } = useI18n()
  return <p className="text-ink-50 py-6">{t('loading')}</p>
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="tabs mb-6" role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)} className="tab">{i.label}</button>
      ))}
    </div>
  )
}

export function Kpi({ label, value, delta, sub, tone }: { label: string; value: string | number; delta?: string; sub?: string; tone?: 'ok' | 'info' | 'warn' | 'bad' }) {
  return (
    <div className="card min-h-32 flex flex-col justify-between gap-4" style={tone ? { background: `var(--${tone}-bg)` } : undefined}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <p className="text-sm text-ink-75 font-medium">{label}</p>
        {delta && <span className="status tnum" style={{ background: 'var(--sheet)' }}>{delta}</span>}
      </div>
      <div>
        <p className="text-ink font-bold text-3xl min-[1180px]:text-4xl leading-none tnum">{value}</p>
        {sub && <p className="text-sm text-ink-75 mt-2">{sub}</p>}
      </div>
    </div>
  )
}

export { default as PhonePreview } from './PhonePreview'

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
