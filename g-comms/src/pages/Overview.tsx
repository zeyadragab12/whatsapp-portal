import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { maskPhone, type MessageLog } from '../lib/types'
import { Kpi, Loading, StatusLabel, fmtDate, fmtTime, EntityFilter, entityScope } from '../components/ui'
import Select from '../components/Select'

interface Day { day: string; total: number; delivered: number; read: number; failed: number }
interface Summary { total: number; sent: number; delivered: number; read: number; failed: number; queued: number; cost: number; daily: Day[] }

const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0)
const fmtPct = (n: number) => `${n.toFixed(0)}%`
function change(now: number, prev: number): string | undefined {
  if (prev === 0) return now === 0 ? undefined : 'New'
  const d = ((now - prev) / prev) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`
}

const SERIES = [
  { key: 'total', label: 'Sent', color: 'var(--info)' },
  { key: 'delivered', label: 'Delivered', color: 'var(--warn)' },
  { key: 'read', label: 'Read', color: 'var(--ok)' },
  { key: 'failed', label: 'Failed', color: 'var(--bad)' },
] as const
type SeriesKey = (typeof SERIES)[number]['key']

/** Rounds the top of the axis up to a tidy number so the grid lines read well. */
function niceMax(v: number): number {
  if (v <= 4) return 4
  const pow = 10 ** Math.floor(Math.log10(v))
  return ([1, 2, 5, 10].map((m) => m * pow).find((m) => m >= v)) ?? v
}
type Unit = 'day' | 'week' | 'month'
const UNITS: { id: Unit; label: string; steps: number[] }[] = [
  { id: 'day', label: 'Day', steps: [7, 14, 30, 60, 90, 180, 365] },
  { id: 'week', label: 'Week', steps: [4, 8, 13, 26, 52] },
  { id: 'month', label: 'Month', steps: [3, 6, 12] },
]
const DAY_MS = 86400000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (s: string) => new Date(s + 'T00:00:00Z')
/** First day of the bucket a date falls in: the day itself, the Monday of its week, or the 1st of its month. */
function bucketStart(d: Date, unit: Unit): Date {
  if (unit === 'day') return d
  if (unit === 'week') return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
function addUnits(d: Date, unit: Unit, n: number): Date {
  if (unit === 'day') return new Date(d.getTime() + n * DAY_MS)
  if (unit === 'week') return new Date(d.getTime() + n * 7 * DAY_MS)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
}
const fmtShort = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
/** Short label under the axis. */
const bucketLabel = (key: string, unit: Unit) => unit === 'month' ? utc(key).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtShort(utc(key))
/** Full label in the tooltip. */
function bucketTitle(key: string, unit: Unit) {
  const d = utc(key)
  if (unit === 'week') return `${fmtShort(d)} – ${fmtShort(new Date(d.getTime() + 6 * DAY_MS))}`
  if (unit === 'month') return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return fmtShort(d)
}

function VolumeChart({ entityIds, tick }: { entityIds: string[]; tick: number }) {
  const { L, t } = useI18n()
  const [off, setOff] = useState<Set<SeriesKey>>(new Set(['failed']))
  const [hover, setHover] = useState<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [unit, setUnit] = useState<Unit>('day')
  const [stepIx, setStepIx] = useState<Record<Unit, number>>({ day: 2, week: 2, month: 1 })
  const [daily, setDaily] = useState<Day[] | null>(null)
  const scope = entityIds.join(',')

  // the chart loads a full year of daily counts once, then groups them by day, week or month on screen
  useEffect(() => {
    supabase.rpc('analytics_summary', { p_entities: scope ? scope.split(',') : [], p_project: null, p_days: 365 })
      .then(({ data }) => setDaily(((data as Summary | null)?.daily) ?? []))
  }, [scope, tick])

  const steps = UNITS.find((u) => u.id === unit)!.steps
  const count = steps[stepIx[unit]]
  const zoom = (dir: 1 | -1) => setStepIx((s) => ({ ...s, [unit]: Math.max(0, Math.min(steps.length - 1, s[unit] + dir)) }))

  // every bucket of the period, so quiet days, weeks and months show as empty instead of being skipped
  const rows = useMemo(() => {
    const byKey = new Map<string, Day>()
    for (const d of daily ?? []) {
      const key = iso(bucketStart(utc(d.day.slice(0, 10)), unit))
      const row = byKey.get(key) ?? { day: key, total: 0, delivered: 0, read: 0, failed: 0 }
      row.total += d.total; row.delivered += d.delivered; row.read += d.read; row.failed += d.failed
      byKey.set(key, row)
    }
    const end = bucketStart(utc(iso(new Date())), unit)
    return Array.from({ length: count }, (_, i) => {
      const key = iso(addUnits(end, unit, -(count - 1 - i)))
      return byKey.get(key) ?? { day: key, total: 0, delivered: 0, read: 0, failed: 0 }
    })
  }, [daily, unit, count])

  const unitWord = { day: L('day'), week: L('week'), month: L('month') }[unit]
  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="tabs" role="group" aria-label={L('Group by')}>
        {UNITS.map((u) => (
          <button key={u.id} type="button" className="tab" aria-pressed={unit === u.id} aria-selected={unit === u.id} onClick={() => { setUnit(u.id); setHover(null) }}>{L(u.label)}</button>
        ))}
      </div>
      <div className="inline-flex items-center gap-1" role="group" aria-label={L('Zoom')}>
        <button type="button" className="btn btn-quiet btn-sm !px-0 w-9" aria-label={L('Zoom in')} title={L('Zoom in')} disabled={stepIx[unit] === 0} onClick={() => zoom(-1)}>+</button>
        <span className="text-sm text-ink-50 tnum min-w-20 text-center">{count} {L(unit === 'day' ? 'days' : unit === 'week' ? 'weeks' : 'months')}</span>
        <button type="button" className="btn btn-quiet btn-sm !px-0 w-9" aria-label={L('Zoom out')} title={L('Zoom out')} disabled={stepIx[unit] === steps.length - 1} onClick={() => zoom(1)}>−</button>
      </div>
    </div>
  )

  if (!daily) return <p className="text-ink-50 py-10 text-center">{t('loading')}</p>
  if (daily.length === 0) return <p className="text-ink-50 py-10 text-center">{L('No messages in this period yet.')}</p>

  const W = 640, H = 220, padL = 34, padR = 8, padT = 12, padB = 26
  const shown = SERIES.filter((s) => !off.has(s.key))
  const max = niceMax(Math.max(1, ...rows.flatMap((r) => shown.map((s) => r[s.key] as number))))
  const slot = (W - padL - padR) / rows.length            // the room each day gets
  const groupW = slot * (rows.length > 40 ? 0.9 : 0.7)    // the bars of one day sit together in the middle of it
  const barW = Math.max(1, groupW / Math.max(shown.length, 1) - (shown.length > 1 && rows.length <= 40 ? 1 : 0))
  const centre = (i: number) => padL + slot * (i + 0.5)
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB)
  const base = y(0)
  const totals = Object.fromEntries(SERIES.map((s) => [s.key, rows.reduce((a, r) => a + (r[s.key] as number), 0)])) as Record<SeriesKey, number>
  const peak = rows.reduce((best, r) => (r.total > best.total ? r : best), rows[0])
  const every = Math.max(1, Math.ceil(rows.length / 6))

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const box = svg.current?.getBoundingClientRect()
    if (!box) return
    const vx = ((e.clientX - box.left) / box.width) * W
    setHover(Math.max(0, Math.min(rows.length - 1, Math.floor((vx - padL) / slot))))
  }
  const toggle = (k: SeriesKey) => setOff((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else if (n.size < SERIES.length - 1) n.add(k); return n })
  const h = hover !== null ? rows[hover] : null

  return (
    <figure className="m-0">
      {controls}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {SERIES.map((s) => {
          const on = !off.has(s.key)
          return (
            <button key={s.key} type="button" aria-pressed={on} onClick={() => toggle(s.key)}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm transition-all duration-200 ${on ? 'bg-card text-ink' : 'bg-transparent text-ink-50 line-through opacity-60'}`}>
              <span className="h-2.5 w-2.5 rounded-[3px] transition-transform duration-200" style={{ background: s.color, transform: on ? 'scale(1)' : 'scale(0.6)' }} />
              {L(s.label)} <span className="tnum font-medium">{totals[s.key]}</span>
            </button>
          )
        })}
        <span className="ms-auto text-sm text-ink-50">{L('Busiest')} {unitWord}: <span className="text-ink font-medium">{peak.total ? `${bucketTitle(peak.day, unit)} · ${peak.total}` : '—'}</span></span>
      </div>

      <div className="relative">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto touch-pan-y select-none" role="img" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)}
          aria-label={`${L('Messages per')} ${unitWord}: ${rows.map((d) => `${bucketTitle(d.day, unit)} ${d.total}`).join(', ')}`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" strokeWidth="1" strokeDasharray={f === 0 ? undefined : '3 4'} />
              <text x={padL - 6} y={y(max * f) + 4} fontSize="11" fill="var(--fg3)" textAnchor="end">{Math.round(max * f)}</text>
            </g>
          ))}
          {hover !== null && <rect x={padL + slot * hover} y={padT} width={slot} height={H - padT - padB} rx="4" fill="var(--soft)" />}
          {rows.map((r, i) => shown.map((s, si) => {
            const v = r[s.key] as number
            if (!v) return null
            const bx = centre(i) - groupW / 2 + si * (groupW / shown.length) + (shown.length > 1 && rows.length <= 40 ? 0.5 : 0)
            return (
              <rect key={`${r.day}-${s.key}-${unit}-${count}`} x={bx} y={y(v)} width={barW} height={base - y(v)} rx={Math.min(3, barW / 2)} fill={s.color}
                className="chart-bar" style={{ animationDelay: `${Math.min(i, 40) * 12}ms`, opacity: hover === null || hover === i ? 1 : 0.45 }} />
            )
          }))}
          {rows.map((r, i) => (i % every === 0 || i === rows.length - 1) && (
            <text key={r.day} x={centre(i)} y={H - 6} fontSize="11" fill="var(--fg3)" textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}>{bucketLabel(r.day, unit)}</text>
          ))}
        </svg>
        {h && hover !== null && (
          <div role="status" className="chart-tip pointer-events-none absolute top-0 z-10 rounded-xl bg-ink text-paper px-3 py-2 text-xs shadow-[var(--shadow)] min-w-32"
            style={{ left: `${(centre(hover) / W) * 100}%`, transform: `translateX(${hover > rows.length * 0.6 ? 'calc(-100% - 10px)' : '10px'})` }}>
            <p className="font-medium mb-1">{bucketTitle(h.day, unit)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className={`flex items-center justify-between gap-4 ${off.has(s.key) ? 'opacity-50' : ''}`}>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />{L(s.label)}</span>
                <span className="tnum font-bold">{h[s.key] as number}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </figure>
  )
}

interface Attention { key: string; tone: 'bad' | 'warn' | 'info'; text: string; to: string; action: string }

function greetingKey(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export default function Overview() {
  const { t, L } = useI18n()
  const { profile, can, entities, entitiesWith, isSuper } = useAuth()
  const [entityId, setEntityId] = useState('')
  const [days, setDays] = useState(30)
  const [sum, setSum] = useState<Summary | null>(null)
  const [prev, setPrev] = useState<Summary | null>(null)
  const [feed, setFeed] = useState<MessageLog[]>([])
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const [attention, setAttention] = useState<Attention[] | null>(null)
  const showAnalytics = can('analytics.read') || can('log.read')

  const load = useCallback(async () => {
    if (!showAnalytics) { setSum({ total: 0, sent: 0, delivered: 0, read: 0, failed: 0, queued: 0, cost: 0, daily: [] }); return }
    const [a, b] = await Promise.all([
      supabase.rpc('analytics_summary', { p_entities: entityScope(entityId, entities), p_project: null, p_days: days }),
      supabase.rpc('analytics_summary', { p_entities: entityScope(entityId, entities), p_project: null, p_days: days * 2 }),
    ])
    const cur = a.data as Summary, both = b.data as Summary
    setSum(cur)
    setPrev({ total: both.total - cur.total, sent: both.sent - cur.sent, delivered: both.delivered - cur.delivered, read: both.read - cur.read,
      failed: both.failed - cur.failed, queued: 0, cost: both.cost - cur.cost, daily: [] })
  }, [entityId, entities, days, showAnalytics]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  const loadAttention = useCallback(async () => {
    if (!isSuper) { setAttention([]); return }
    const items: Attention[] = []
    const [notes, tpls, reqs] = await Promise.all([
      supabase.rpc('unread_notifications'),
      can('template.read') ? supabase.from('whatsapp_templates').select('status, meta_status, meta_submitted_at').neq('status', 'ARCHIVED') : Promise.resolve({ data: [] }),
      isSuper ? supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending') : Promise.resolve({ count: 0 }),
    ])
    const list = (tpls.data as { status: string; meta_status: string | null; meta_submitted_at: string | null }[]) ?? []
    const bad = list.filter((x) => x.status === 'REJECTED' || ['PAUSED', 'DISABLED', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED'].includes(x.meta_status ?? '')).length
    if (bad) items.push({ key: 'tplbad', tone: 'bad', text: `${bad} ${bad === 1 ? L('template needs fixing') : L('templates need fixing')}`, to: '/templates', action: L('Review templates') })
    const waiting = list.filter((x) => x.status === 'PENDING_APPROVAL' && !x.meta_submitted_at).length
    if (waiting && can('template.submit')) items.push({ key: 'tplwait', tone: 'warn', text: `${waiting} ${waiting === 1 ? L('template is waiting to be sent to Meta') : L('templates are waiting to be sent to Meta')}`, to: '/templates', action: L('Open templates') })
    if (reqs.count) items.push({ key: 'req', tone: 'warn', text: `${reqs.count} ${reqs.count === 1 ? L('person is waiting for access') : L('people are waiting for access')}`, to: '/admin/people?tab=requests', action: L('Review requests') })
    const alerts = (notes.data as number) ?? 0
    if (alerts) items.push({ key: 'alerts', tone: 'info', text: `${alerts} ${alerts === 1 ? L('unread alert') : L('unread alerts')}`, to: '/alerts', action: L('See alerts') })
    setAttention(items)
  }, [can, isSuper, L])
  useEffect(() => {
    loadAttention()
    if (!isSuper) return
    const ch = supabase.channel('overview-notifications')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, loadAttention)
      .subscribe()
    window.addEventListener('counts-changed', loadAttention)
    return () => { supabase.removeChannel(ch); window.removeEventListener('counts-changed', loadAttention) }
  }, [loadAttention, isSuper])

  useEffect(() => {
    if (!showAnalytics) return
    supabase.from('whatsapp_templates').select('id, name').then(({ data }) =>
      setTemplates(Object.fromEntries(((data as { id: string; name: string }[]) ?? []).map((x) => [x.id, x.name]))))
    supabase.from('message_logs').select('*').order('updated_at', { ascending: false }).limit(40)
      .then(({ data }) => setFeed((data as MessageLog[]) ?? []))
    const ch = supabase.channel('overview-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_logs' }, (p) => {
        const row = p.new as MessageLog
        setFeed((f) => [row, ...f.filter((x) => x.id !== row.id)].slice(0, 40))
        load()
      }).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [showAnalytics]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sum) return <Loading />
  const scoped = feed.filter((f) => (!entityId || f.entity_id === entityId) && entities.some((e) => e.id === f.entity_id))
  const attempted = sum.total - sum.queued
  const first = (profile?.full_name || profile?.email || '').split(/[ @]/)[0]

  return (
    <>
      <section className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <h1>{L(greetingKey())}, {first}</h1>
          <p className="mt-1.5 text-ink-50">{fmtDate(new Date().toISOString())}</p>
        </div>
        {can('message.send')
          ? <Link to="/send" className="btn">{L('Send messages')}</Link>
          : entitiesWith('template.create').length > 0 && <Link to="/templates/new" className="btn">{t('newTemplate')}</Link>}
      </section>

      {isSuper && attention && attention.length > 0 && (
        <section aria-label={L('Notifications')} className="card mb-6">
          <h2 className="mb-3">{L('Notifications')}</h2>
          <ul className="space-y-2">
            {attention.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center justify-between gap-3 bg-paper rounded-xl px-4 py-3">
                <span className="flex items-center gap-3 min-w-0">
                  <span className={`status tone-${a.tone}`}>{{ bad: L('Fix'), warn: L('Action'), info: L('New') }[a.tone]}</span>
                  <span className="text-ink">{a.text}</span>
                </span>
                <Link className="link-btn" to={a.to}>{a.action}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showAnalytics && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
            <h2>{L('How your messages are doing')}</h2>
            <div className="flex gap-2">
              <label className="field"><span className="sr-only">{t('entity')}</span>
                <EntityFilter entities={entities} value={entityId} onChange={setEntityId} />
              </label>
              <label className="field"><span className="sr-only">{L('Period')}</span>
                <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  <option value={7}>{L('Last 7 days')}</option><option value={30}>{L('Last 30 days')}</option><option value={90}>{L('Last 90 days')}</option>
                </Select>
              </label>
            </div>
          </div>
          <section className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
            <Kpi tone="info" label={L('Messages sent')} value={sum.total} delta={prev ? change(sum.total, prev.total) : undefined} sub={sum.queued ? `${sum.queued} ${L('waiting to send')}` : L('in this period')} />
            <Kpi tone="ok" label={L('Delivered')} value={fmtPct(pct(sum.delivered, attempted))} delta={prev ? change(sum.delivered, prev.delivered) : undefined} sub={`${sum.delivered} ${L('messages')}`} />
            <Kpi tone="warn" label={L('Read')} value={fmtPct(pct(sum.read, attempted))} delta={prev ? change(sum.read, prev.read) : undefined} sub={`${sum.read} ${L('messages')}`} />
            <Kpi tone={sum.failed ? 'bad' : undefined} label={L('Failed')} value={sum.failed} delta={prev ? change(sum.failed, prev.failed) : undefined} sub={sum.failed ? fmtPct(pct(sum.failed, sum.total)) + ' ' + L('of messages') : L('nothing failed')} />
          </section>

          <section className="grid lg:grid-cols-[3fr_2fr] gap-4">
            <div className="card">
              <h2>{L('Messages sent over time')}</h2>
              <p className="card-sub mb-4">{L('Hover or tap a bar to see its numbers. Tap a label to show or hide a line.')}</p>
              <VolumeChart entityIds={entityScope(entityId, entities)} tick={sum.total} />
            </div>
            <div className="card">
              <header className="flex items-baseline justify-between gap-4 mb-3">
                <div><h2>{L('Recent activity')}</h2><p className="card-sub">{L('Updates as WhatsApp reports each message.')}</p></div>
                <Link className="link-btn" to="/log">{L('See all')}</Link>
              </header>
              {scoped.length === 0 ? <p className="text-ink-50">{t('noSends')}</p> : (
                <ul className="divide-y divide-[var(--line)]">
                  {scoped.slice(0, 6).map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-ink truncate">{templates[f.template_id] ?? ''}</p>
                        <p className="text-xs text-ink-50 truncate">{entities.find((e) => e.id === f.entity_id)?.name} · <span dir="ltr">{maskPhone(f.phone_number)}</span> · {fmtTime(f.updated_at)}</p>
                      </div>
                      <StatusLabel value={f.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </>
  )
}
