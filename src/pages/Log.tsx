import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { downloadCsv } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { Field, Loading, PageHead, StatusLabel, Tabs, fmtTime, EntityFilter, entityScope } from '../components/ui'
import Select from '../components/Select'

interface Audit { id: number; actor_id: string | null; entity_id: string | null; action: string; target_type: string; target_id: string | null; details: Record<string, unknown>; created_at: string }
const PAGE = 50

export default function LogPage() {
  const { L } = useI18n()
  const { can, entities } = useAuth()
  const canAudit = entities.some((e) => can('member.manage', e.id))
  const seesAll = canAudit || entities.some((e) => can('log.all', e.id))
  const [tab, setTab] = useState<'messages' | 'activity'>('messages')
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const [people, setPeople] = useState<Record<string, string>>({})

  useEffect(() => {
    supabase.from('whatsapp_templates').select('id, name').then(({ data }) => setTemplates(Object.fromEntries(((data as { id: string; name: string }[]) ?? []).map((x) => [x.id, x.name]))))
    supabase.from('profiles').select('id, email').then(({ data }) => setPeople(Object.fromEntries(((data as { id: string; email: string }[]) ?? []).map((x) => [x.id, x.email]))))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHead title={L('Audit log')} sub={canAudit ? L('Every send in your companies and every administrative change, with who did it and when.') : seesAll ? L('Every send in your companies, with its status.') : L('The sends you made, with their status.')} />
      <Tabs value={tab} onChange={setTab} items={[{ id: 'messages', label: L('Messages') }, ...(canAudit ? [{ id: 'activity' as const, label: L('Activity') }] : [])]} />
      {tab === 'messages' ? <Messages templates={templates} people={people} /> : <Activity people={people} />}
    </>
  )
}

interface SendRow {
  id: string; created_at: string; entity_id: string; template_id: string; sender_id: string | null; mode: string; total: number; group_names: string[] | null
  sent: number; delivered: number; read: number; failed: number; queued: number
}

/** One line per send: who, which message, which company and groups, when, and how it went. */
function Messages({ templates, people }: { templates: Record<string, string>; people: Record<string, string> }) {
  const { entities } = useAuth()
  const { L } = useI18n()
  const [rows, setRows] = useState<SendRow[] | null>(null)
  const [entityId, setEntityId] = useState('')
  const [from, setFrom] = useState('')
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const pname = (id: string) => entities.find((e) => e.id === id)?.name ?? ''
  const groupsOf = (r: SendRow) => (r.group_names === null ? '—' : r.group_names.length === 0 ? L('Everyone') : r.group_names.join(', '))

  const query = useCallback((pg: number, size = PAGE) =>
    supabase.rpc('send_history', { p_entities: entityScope(entityId, entities), p_from: from || null, p_limit: size + 1, p_offset: pg * size }),
  [entityId, entities, from])

  useEffect(() => {
    setRows(null)
    query(page).then(({ data }) => {
      const list = (data as SendRow[]) ?? []
      setMore(list.length > PAGE)
      setRows(list.slice(0, PAGE))
    })
  }, [query, page])
  useEffect(() => { setPage(0) }, [entityId, from])

  async function exportAll() {
    const { data } = await query(0, 5000)
    downloadCsv('g-developments-send-history.csv', [
      ['Time', 'Sent by', 'Company', 'Groups', 'Template', 'Clients', 'Sent', 'Delivered', 'Read', 'Failed'],
      ...((data as SendRow[]) ?? []).map((r) => [r.created_at, people[r.sender_id ?? ''] ?? '', pname(r.entity_id), r.group_names?.join(' | ') ?? '', templates[r.template_id] ?? '', r.total, r.sent, r.delivered, r.read, r.failed]),
    ])
  }

  return (
    <>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 items-end">
        <Field label={L('Client list')}>
          <EntityFilter entities={entities} value={entityId} onChange={setEntityId} />
        </Field>
        <Field label={L('From date')}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <button className="btn btn-quiet" onClick={exportAll}>{L('Export CSV')}</button>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <p>{L('No messages match.')}</p> : (
        <div className="lg:overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>{L('Time')}</th><th>{L('Who')}</th><th>{L('Template')}</th><th>{L('Company')}</th><th>{L('Groups')}</th><th>{L('Clients')}</th><th>{L('Status')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cell-title">{fmtTime(r.created_at)}</td>
                  <td data-label={L('Who')}>{r.sender_id ? people[r.sender_id] ?? r.sender_id.slice(0, 8) : L('System')}</td>
                  <td data-label={L('Template')}>{templates[r.template_id]}</td>
                  <td data-label={L('Company')}>{pname(r.entity_id)}</td>
                  <td data-label={L('Groups')}>{groupsOf(r)}</td>
                  <td data-label={L('Clients')} className="tnum">{r.total}{r.mode === 'demo' ? ` · ${L('Demo mode')}` : ''}</td>
                  <td data-label={L('Status')}>
                    {r.queued > 0 ? <StatusLabel value="QUEUED" /> : r.failed === r.total ? <StatusLabel value="FAILED" /> : <StatusLabel value="SENT" />}
                    {r.failed > 0 && r.failed < r.total && <span className="text-sm text-ink-50 ms-2">{r.failed} {L('failed')}</span>}
                  </td>
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

const ACTION_LABELS: Record<string, string> = {
  messages_sent: 'Sent messages', messages_scheduled: 'Scheduled messages', messages_rescheduled: 'Changed a schedule', messages_schedule_cancelled: 'Cancelled a schedule', phone_revealed: 'Viewed a phone number', insert: 'Created', update: 'Changed', delete: 'Deleted',
}

function Activity({ people }: { people: Record<string, string> }) {
  const { L } = useI18n()
  const objectOf = (r: Audit): ReactNode => {
    const d = r.details as { phone_masked?: string; template?: string; total?: number; mode?: string }
    if (r.action === 'phone_revealed') return <span dir="ltr">{String(d.phone_masked ?? '')}</span>
    if (r.action.startsWith('messages_sched') || r.action === 'messages_rescheduled') {
      const e = r.details as { template?: string; run_at?: string; repeat?: string }
      return `${e.template ?? ''}${e.run_at ? ` · ${new Date(e.run_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}${e.repeat === 'daily' ? ` · ${L('Every day')}` : e.repeat === 'weekly' ? ` · ${L('Every week')}` : ''}`
    }
    if (r.action === 'messages_sent') return `${d.template ?? ''} · ${d.total ?? 0} ${L('clients')}${d.mode === 'demo' ? ` · ${L('Demo mode')}` : ''}`
    return r.target_type.replace(/_/g, ' ')
  }
  const { isSuper, entities } = useAuth()
  const [rows, setRows] = useState<Audit[] | null>(null)
  const [entityId, setEntityId] = useState('')
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [from, setFrom] = useState('')

  useEffect(() => {
    setRows(null)
    let q = supabase.from('audit_events').select('*').order('created_at', { ascending: false }).limit(200)
    if (entityId) q = q.eq('entity_id', entityId)
    else {
      // "all my companies" is exactly the companies listed; the superadmin also keeps system-wide entries that belong to no company
      const ids = entityScope('', entities).join(',')
      q = isSuper ? q.or(`entity_id.in.(${ids}),entity_id.is.null`) : q.in('entity_id', entityScope('', entities))
    }
    if (action) q = q.eq('action', action)
    if (actor) q = q.eq('actor_id', actor)
    if (from) q = q.gte('created_at', from)
    q.then(({ data }) => setRows((data as Audit[]) ?? []))
  }, [entityId, entities, isSuper, action, actor, from])

  const actions = Object.keys(ACTION_LABELS).filter((a) => isSuper || a !== 'phone_revealed')
  const label = (a: string) => (ACTION_LABELS[a] ? L(ACTION_LABELS[a]) : a)
  const names = Object.entries(people).sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
        <Field label={L('Company')}>
          <EntityFilter entities={entities} value={entityId} onChange={setEntityId} />
        </Field>
        <Field label={L('What happened')}>
          <Select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{L('Everything')}</option>
            {actions.map((a) => <option key={a} value={a}>{label(a)}</option>)}
          </Select>
        </Field>
        <Field label={L('Who')}>
          <Select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">{L('Everyone')}</option>
            {names.map(([id, email]) => <option key={id} value={id}>{email}</option>)}
          </Select>
        </Field>
        <Field label={L('From date')}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <p>{L('Nothing matches.')}</p> : (
        <div className="lg:overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>{L('Time')}</th><th>{L('Who')}</th><th>{L('Action')}</th><th>{L('Object')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cell-title">{fmtTime(r.created_at)}</td>
                  <td data-label={L('Who')}>{r.actor_id ? people[r.actor_id] ?? r.actor_id.slice(0, 8) : L('System')}</td>
                  <td data-label={L('Action')}>{label(r.action)}</td>
                  <td data-label={L('Object')}>{objectOf(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
