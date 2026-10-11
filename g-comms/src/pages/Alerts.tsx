import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import type { AppNotification } from '../lib/types'
import { Loading, PageHead, Tabs, fmtTime } from '../components/ui'

export default function AlertsPage() {
  const { L } = useI18n()
  const { entities, isSuper } = useAuth()
  const [rows, setRows] = useState<AppNotification[] | null>(null)
  const [read, setRead] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'unread' | 'all'>('unread')

  const load = useCallback(async () => {
    const [n, r] = await Promise.all([
      supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(150),
      supabase.from('notification_reads').select('notification_id'),
    ])
    setRows((n.data as AppNotification[]) ?? [])
    setRead(new Set(((r.data as { notification_id: string }[]) ?? []).map((x) => x.notification_id)))
  }, [])

  useEffect(() => {
    load()
    const ch = supabase.channel('alerts-page').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, () => load()).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  async function markRead(ids: string[] | null) {
    await supabase.rpc('mark_notifications_read', { p_ids: ids })
    await load()
    window.dispatchEvent(new Event('counts-changed'))
  }

  if (!rows) return <Loading />
  // persona simulation: only alerts for the entities that persona can see
  const visible = rows.filter((n) => (n.entity_id ? entities.some((e) => e.id === n.entity_id) : isSuper))
  const unread = visible.filter((n) => !read.has(n.id))
  const shown = tab === 'unread' ? unread : visible
  const entityName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? ''
  const sev = (s: AppNotification['severity']) => (s === 'critical' ? 'tone-bad' : s === 'warning' ? 'tone-warn' : 'tone-info')

  return (
    <>
      <PageHead title={L('Alerts')} sub={L('Template reviews, connection problems, limits, failed sends and new replies.')}>
        {unread.length > 0 && <button className="btn btn-quiet btn-sm" onClick={() => markRead(null)}>{L('Mark all as read')}</button>}
      </PageHead>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'unread', label: `${L('Unread')} (${unread.length})` }, { id: 'all', label: L('All') }]} />
      {shown.length === 0 ? <p>{tab === 'unread' ? L('Nothing needs your attention.') : L('No alerts yet.')}</p> : (
        <ul className="space-y-2">
          {shown.map((n) => {
            const isRead = read.has(n.id)
            return (
              <li key={n.id} className={`rounded-2xl px-5 py-4 flex flex-wrap items-start justify-between gap-4 ${isRead ? 'bg-paper' : 'bg-card'}`}>
                <div className="min-w-0 max-w-2xl">
                  <p className="flex flex-wrap items-center gap-3">
                    <span className={`status ${sev(n.severity)}`}>{{ critical: L('Critical'), warning: L('Warning'), info: L('Info') }[n.severity]}</span>
                    <span className={`text-ink ${isRead ? '' : 'font-bold'}`}>{n.title}</span>
                  </p>
                  {n.body && <p className="mt-1 text-ink-75">{n.body}</p>}
                  <p className="mt-1 text-sm text-ink-50">{fmtTime(n.created_at)}{n.entity_id ? ` · ${entityName(n.entity_id)}` : ''}</p>
                </div>
                <div className="flex gap-5 text-sm whitespace-nowrap">
                  {n.link && <Link className="link-btn" to={n.link} onClick={() => markRead([n.id])}>{L('Open')}</Link>}
                  {!isRead && <button className="link-btn" onClick={() => markRead([n.id])}>{L('Mark as read')}</button>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
