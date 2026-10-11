import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadCsv } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { maskPhone, type MessageLog } from '../lib/types'
import { Field, Loading, PageHead, StatusLabel, Tabs, fmtTime, EntityFilter, entityScope } from '../components/ui'
import Select from '../components/Select'

interface Audit { id: number; actor_id: string | null; entity_id: string | null; action: string; target_type: string; target_id: string | null; details: Record<string, unknown>; created_at: string }
const PAGE = 50

export default function LogPage() {
  const { L } = useI18n()
  const { can, entities } = useAuth()
  const canAudit = entities.some((e) => can('member.manage', e.id))
  const [tab, setTab] = useState<'messages' | 'activity'>('messages')
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const [people, setPeople] = useState<Record<string, string>>({})

  useEffect(() => {
    supabase.from('whatsapp_templates').select('id, name').then(({ data }) => setTemplates(Object.fromEntries(((data as { id: string; name: string }[]) ?? []).map((x) => [x.id, x.name]))))
    supabase.from('profiles').select('id, email').then(({ data }) => setPeople(Object.fromEntries(((data as { id: string; email: string }[]) ?? []).map((x) => [x.id, x.email]))))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHead title={L('Audit log')} sub={L('Every message and every administrative change, with who did it and when.')} />
      <Tabs value={tab} onChange={setTab} items={[{ id: 'messages', label: L('Messages') }, ...(canAudit ? [{ id: 'activity' as const, label: L('Activity') }] : [])]} />
      {tab === 'messages' ? <Messages templates={templates} people={people} /> : <Activity people={people} />}
    </>
  )
}

function Messages({ templates, people }: { templates: Record<string, string>; people: Record<string, string> }) {
  const { entities } = useAuth()
  const { L } = useI18n()
  const [rows, setRows] = useState<MessageLog[] | null>(null)
  const [status, setStatus] = useState('')
  const [entityId, setEntityId] = useState('')
  const [from, setFrom] = useState('')
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const pname = (id: string) => entities.find((e) => e.id === id)?.name ?? ''

  const query = useCallback((pg: number) => {
    let q = supabase.from('message_logs').select('*').order('created_at', { ascending: false }).range(pg * PAGE, pg * PAGE + PAGE)
    if (status) q = q.eq('status', status)
    q = q.in('entity_id', entityScope(entityId, entities))
    if (from) q = q.gte('created_at', from)
    return q
  }, [status, entityId, entities, from])

  useEffect(() => {
    setRows(null)
    query(page).then(({ data }) => {
      const list = (data as MessageLog[]) ?? []
      setMore(list.length > PAGE)
      setRows(list.slice(0, PAGE))
    })
  }, [query, page])
  useEffect(() => { setPage(0) }, [status, entityId, from])

  async function exportAll() {
    const { data } = await query(0).range(0, 4999)
    downloadCsv('g-developments-message-log.csv', [
      ['Time', 'Client list', 'Template', 'Phone', 'Status', 'Sent by', 'Cost estimate', 'Error'],
      ...((data as MessageLog[]) ?? []).map((r) => [r.created_at, pname(r.entity_id), templates[r.template_id] ?? '', maskPhone(r.phone_number), r.status, people[r.sender_id] ?? '', r.cost_estimate, r.error_details?.message ?? '']),
    ])
  }

  return (
    <>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 items-end">
        <Field label={L('Status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{L('All statuses')}</option>
            {['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'].map((s) => <option key={s} value={s}>{L(s.charAt(0) + s.slice(1).toLowerCase())}</option>)}
          </Select>
        </Field>
        <Field label={L('Client list')}>
          <EntityFilter entities={entities} value={entityId} onChange={setEntityId} />
        </Field>
        <Field label={L('From date')}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <button className="btn btn-quiet" onClick={exportAll}>{L('Export CSV')}</button>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <p>{L('No messages match.')}</p> : (
        <div className="lg:overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>{L('Time')}</th><th>{L('Client list')}</th><th>{L('Template')}</th><th>{L('Phone')}</th><th>{L('Status')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cell-title">{fmtTime(r.created_at)}</td><td data-label={L('Client list')}>{pname(r.entity_id)}</td><td data-label={L('Template')}>{templates[r.template_id]}</td>
                  <td data-label={L('Phone')} dir="ltr">{maskPhone(r.phone_number)}</td><td data-label={L('Status')}><StatusLabel value={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-6 mt-6">
        <button className="link-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>{L('Previous')}</button>
        <button className="link-btn" disabled={!more} onClick={() => setPage(page + 1)}>{L('Next')}</button>
      </div>
    </>
  )
}

function Activity({ people }: { people: Record<string, string> }) {
  const { L } = useI18n()
  const [rows, setRows] = useState<Audit[] | null>(null)
  useEffect(() => {
    supabase.from('audit_events').select('*').order('created_at', { ascending: false }).limit(200).then(({ data }) => setRows((data as Audit[]) ?? []))
  }, [])
  if (!rows) return <Loading />
  return (
    <div className="lg:overflow-x-auto">
      <table className="grid-table">
        <thead><tr><th>{L('Time')}</th><th>{L('Who')}</th><th>{L('Action')}</th><th>{L('Object')}</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            return (
              <tr key={r.id}>
                <td className="cell-title">{fmtTime(r.created_at)}</td>
                <td data-label={L('Who')}>{r.actor_id ? people[r.actor_id] ?? r.actor_id.slice(0, 8) : L('System')}</td>
                <td data-label={L('Action')}>{r.action}</td><td data-label={L('Object')}>{r.target_type.replace(/_/g, ' ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
