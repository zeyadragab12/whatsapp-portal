import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { ErrorNote, Field, Loading } from './ui'
import { Modal, useDialog } from './Dialog'

export interface Scheduled {
  id: string; entity_id: string; template_id: string; sender_id: string; list_ids: string[]; all_clients: boolean
  run_at: string; status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled'
  repeat: 'none' | 'daily' | 'weekly'; repeat_until: string | null; run_count: number
  result: { total?: number; queued?: number; skipped?: number } | null; error: string | null
  whatsapp_templates: { name: string } | null
}

/** "2026-10-06T21:00" for a date input, in the person's own time zone. */
export const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export const whenText = (iso: string | Date) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
export type Repeat = 'none' | 'daily' | 'weekly'
/** "Every day at 9:00 AM" / "Every Wednesday at 9:00 AM" */
export const repeatText = (repeat: Repeat, at: string | Date, L: (s: string) => string) => {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (repeat === 'daily') return `${L('Every day at')} ${time}`
  if (repeat === 'weekly') return `${L('Every')} ${d.toLocaleDateString(undefined, { weekday: 'long' })} ${L('at')} ${time}`
  return ''
}
export const zoneName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' } }

const TONE: Record<Scheduled['status'], string> = { scheduled: 'tone-info', sending: 'tone-warn', sent: 'tone-ok', failed: 'tone-bad', cancelled: 'tone-neutral' }
const LABEL: Record<Scheduled['status'], string> = { scheduled: 'Scheduled', sending: 'Sending now', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled' }

/** Everything scheduled: change the time, cancel, or see what happened. */
export default function ScheduledSends({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { L } = useI18n()
  const { entities, can, profile } = useAuth()
  const { confirm } = useDialog()
  const [rows, setRows] = useState<Scheduled[] | null>(null)
  const [groups, setGroups] = useState<Record<string, string>>({})
  const [people, setPeople] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [when, setWhen] = useState('')
  const [error, setError] = useState('')

  const seesAll = entities.some((e) => can('member.manage', e.id) || can('log.all', e.id))

  const load = useCallback(async () => {
    const { data } = await supabase.from('scheduled_sends').select('*, whatsapp_templates(name)').order('run_at', { ascending: false }).limit(100)
    const list = ((data as unknown as Scheduled[]) ?? [])
    // what is still to come first (soonest on top), then what already happened (latest on top)
    setRows([...list.filter((r) => r.status === 'scheduled' || r.status === 'sending').sort((a, b) => a.run_at.localeCompare(b.run_at)),
      ...list.filter((r) => r.status !== 'scheduled' && r.status !== 'sending')])
  }, [])

  useEffect(() => {
    load()
    supabase.from('client_lists').select('id, name').then(({ data }) => setGroups(Object.fromEntries(((data as { id: string; name: string }[]) ?? []).map((g) => [g.id, g.name]))))
    supabase.from('profiles').select('id, email').then(({ data }) => setPeople(Object.fromEntries(((data as { id: string; email: string }[]) ?? []).map((p) => [p.id, p.email]))))
    const timer = setInterval(load, 15000)   // a send that just went out flips to "Sent" without a reload
    return () => clearInterval(timer)
  }, [load])

  async function saveTime(r: Scheduled) {
    setError('')
    const { error } = await supabase.rpc('reschedule_send', { p_id: r.id, p_run_at: new Date(when).toISOString() })
    if (error) { setError(error.message); return }
    setEditing(null); load(); onChanged()
  }

  async function cancel(r: Scheduled) {
    const ok = await confirm({
      title: r.repeat !== 'none' ? L('Stop this repeating send?') : L('Cancel this scheduled send?'), danger: true, confirmLabel: r.repeat !== 'none' ? L('Stop repeating') : L('Cancel the send'),
      message: `${r.whatsapp_templates?.name ?? ''} · ${whenText(r.run_at)}. ${r.repeat !== 'none' ? L('Nothing more will be sent. What already went out stays in History.') : L('Nothing will be sent.')}`,
    })
    if (!ok) return
    setError('')
    const { error } = await supabase.rpc('cancel_scheduled_send', { p_id: r.id })
    if (error) setError(error.message); else { load(); onChanged() }
  }

  const who = (r: Scheduled) => (r.sender_id === profile?.id ? L('You') : people[r.sender_id] ?? '')
  const to = (r: Scheduled) => (r.all_clients ? L('Everyone') : r.list_ids.map((id) => groups[id] ?? '…').join(', '))

  return (
    <Modal title={L('Scheduled messages')} onClose={onClose} size="xl">
      {error && <ErrorNote>{error}</ErrorNote>}
      {!rows ? <Loading /> : rows.length === 0 ? (
        <p className="text-ink-50 py-6">{L('Nothing is scheduled yet. On the last step of Send messages, choose Schedule for later.')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-2xl bg-card px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-ink font-medium truncate">{r.whatsapp_templates?.name ?? ''}</p>
                  <p className="text-sm text-ink-75">{r.repeat !== 'none' && r.status === 'scheduled' ? `${L('Next')}: ` : ''}{whenText(r.run_at)}</p>
                  <p className="text-sm text-ink-50 truncate">
                    {L('To')}: {to(r)}{seesAll && who(r) ? ` · ${L('By')} ${who(r)}` : ''}
                  </p>
                </div>
                <span className={`status ${TONE[r.status]}`}>{r.repeat !== 'none' && r.status === 'scheduled' ? L('Repeating') : r.repeat !== 'none' && r.status === 'sent' ? L('Finished') : L(LABEL[r.status])}</span>
              </div>
              {r.repeat !== 'none' && (
                <p className="text-sm text-ink-75 mt-1">
                  {repeatText(r.repeat, r.run_at, L)}
                  {r.repeat_until ? ` · ${L('until')} ${new Date(r.repeat_until).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                  {r.run_count ? ` · ${L('Sent')} ${r.run_count} ${r.run_count === 1 ? L('time') : L('times')}` : ''}
                </p>
              )}
              {r.status === 'scheduled' && r.repeat !== 'none' && r.error && <p className="notice notice-warn !m-0 !mt-2 text-sm">{L('The last run failed')}: {r.error}</p>}

              {r.status === 'sent' && r.result && (
                <p className="text-sm text-ink-75 mt-2">
                  {r.result.total ?? 0} {L('clients')}{r.result.skipped ? ` · ${r.result.skipped} ${L('skipped')}` : ''}{' · '}
                  <Link className="link-btn !px-0" to="/log" onClick={onClose}>{L('See it in History')}</Link>
                </p>
              )}
              {r.status === 'failed' && r.error && <p className="notice notice-bad !m-0 !mt-2 text-sm">{r.error}</p>}

              {r.status === 'scheduled' && (
                editing === r.id ? (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="w-64"><Field label={L('New time')}><input type="datetime-local" value={when} min={toLocalInput(new Date(Date.now() + 120000))} onChange={(e) => setWhen(e.target.value)} /></Field></div>
                    <button className="btn btn-quiet btn-sm" disabled={!when} onClick={() => saveTime(r)}>{L('Save')}</button>
                    <button className="link-btn" onClick={() => setEditing(null)}>{L('Cancel')}</button>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1 -ms-2.5">
                    <button className="link-btn" onClick={() => { setEditing(r.id); setWhen(toLocalInput(new Date(r.run_at))); setError('') }}>{r.repeat !== 'none' ? L('Change next time') : L('Change time')}</button>
                    <button className="link-btn !text-bad" onClick={() => cancel(r)}>{r.repeat !== 'none' ? L('Stop repeating') : L('Cancel the send')}</button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-50 mt-4">{L('Times are in your time zone')}{zoneName() ? ` (${zoneName()})` : ''}. {L('A scheduled message goes out within a minute of its time.')}</p>
    </Modal>
  )
}
