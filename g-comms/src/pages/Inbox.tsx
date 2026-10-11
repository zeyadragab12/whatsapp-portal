import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { callFunction } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { maskPhone, type Conversation, type ConvMessage, type MessageLog, type Template } from '../lib/types'
import { ErrorNote, Field, Loading, Notice, PageHead, StatusLabel, fmtTime } from '../components/ui'
import Select from '../components/Select'

const WINDOW_MS = 24 * 3600_000
type Filter = 'open' | 'unread' | 'mine' | 'closed'

interface Entry { key: string; at: string; dir: 'in' | 'out'; kind: 'text' | 'template'; text: string; status: string | null; error?: string | null; by?: string | null }

/** Rebuilds the text of a sent template from its stored payload parameters. */
function renderSent(log: MessageLog, tpl?: Template): string {
  const comps = ((log.payload as { template?: { components?: { type: string; parameters: { parameter_name?: string; text?: string }[] }[] } })?.template?.components) ?? []
  const named: Record<string, string> = {}
  const positional: string[] = []
  comps.forEach((c) => c.parameters.forEach((p) => { if (p.parameter_name) named[p.parameter_name] = p.text ?? ''; else positional.push(p.text ?? '') }))
  const fill = (s: string | null | undefined) => (s ?? '').replace(/\{\{(\w+)\}\}/g, (m, k) => named[k] ?? (/^\d+$/.test(k) ? positional[Number(k) - 1] : undefined) ?? m)
  return tpl ? [fill(tpl.header_text), fill(tpl.body_text), tpl.footer_text].filter(Boolean).join('\n') : ''
}

const windowLeft = (c: Conversation) => (c.last_inbound_at ? new Date(c.last_inbound_at).getTime() + WINDOW_MS - Date.now() : 0)
const fmtLeft = (ms: number) => `${Math.floor(ms / 3600_000)} h ${Math.floor((ms % 3600_000) / 60_000)} min`

export default function InboxPage() {
  const { t, L } = useI18n()
  const { profile, can, entities, isSuper } = useAuth()
  const [params, setParams] = useSearchParams()
  const [convs, setConvs] = useState<Conversation[] | null>(null)
  const [filter, setFilter] = useState<Filter>('open')
  const [q, setQ] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [optedOut, setOptedOut] = useState(false)
  const [conns, setConns] = useState<Record<string, string>>({})
  const [demo, setDemo] = useState({ open: false, entity: '', phone: '+201010354164', name: 'Zeyad Ragab', text: 'Hello, when is the next service charge due?' })
  const [, tick] = useState(0)
  const selectedId = params.get('c')
  const bottom = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    const { data } = await supabase.from('conversations').select('*').order('last_message_at', { ascending: false }).limit(300)
    setConvs((data as Conversation[]) ?? [])
  }, [])

  useEffect(() => {
    loadList()
    supabase.rpc('entity_connections').then(({ data }) => setConns(Object.fromEntries(((data as { entity_id: string; mode: string }[]) ?? []).map((c) => [c.entity_id, c.mode]))))
    const ch = supabase.channel('inbox-list').on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => loadList()).subscribe()
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => { supabase.removeChannel(ch); window.clearInterval(timer) }
  }, [loadList])

  // persona simulation: show only what that persona could see
  const visibleConvs = useMemo(() => (convs ?? []).filter((c) => entities.some((e) => e.id === c.entity_id)), [convs, entities])

  const shown = visibleConvs.filter((c) => {
    const s = q.trim().toLowerCase()
    if (s && !((c.contact_name ?? '').toLowerCase().includes(s) || c.phone_number.includes(s) || (c.last_message_preview ?? '').toLowerCase().includes(s))) return false
    if (filter === 'closed') return c.status === 'closed'
    if (c.status === 'closed') return false
    if (filter === 'unread') return c.unread_count > 0
    if (filter === 'mine') return c.assigned_to === profile?.id
    return true
  })
  const counts = {
    open: visibleConvs.filter((c) => c.status === 'open').length,
    unread: visibleConvs.filter((c) => c.status === 'open' && c.unread_count > 0).length,
    mine: visibleConvs.filter((c) => c.status === 'open' && c.assigned_to === profile?.id).length,
    closed: visibleConvs.filter((c) => c.status === 'closed').length,
  }
  const selected = visibleConvs.find((c) => c.id === selectedId) ?? null
  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? ''
  const canReply = !!selected && can('inbox.reply', selected.entity_id)

  const loadThread = useCallback(async (c: Conversation) => {
    const [m, l, o] = await Promise.all([
      supabase.from('conversation_messages').select('*').eq('conversation_id', c.id).order('created_at'),
      supabase.from('message_logs').select('*').eq('entity_id', c.entity_id).eq('phone_number', c.phone_number).order('created_at').limit(200),
      c.owner_id ? supabase.from('owner_optouts').select('owner_id').eq('entity_id', c.entity_id).eq('owner_id', c.owner_id).maybeSingle() : Promise.resolve({ data: null }),
    ])
    setOptedOut(!!o.data)
    const logs = (l.data as MessageLog[]) ?? []
    const tplIds = [...new Set(logs.map((x) => x.template_id))]
    const tpls = new Map<string, Template>()
    if (tplIds.length) {
      const { data: tp } = await supabase.from('whatsapp_templates').select('*').in('id', tplIds)
      ;((tp as Template[]) ?? []).forEach((x) => tpls.set(x.id, x))
    }
    const list: Entry[] = [
      ...((m.data as ConvMessage[]) ?? []).map((x): Entry => ({
        key: x.id, at: x.created_at, dir: x.direction, kind: 'text', status: x.direction === 'out' ? x.status : null, error: x.error, by: x.sent_by,
        text: x.body || `[${x.type}]${x.type !== 'text' ? ` ${L('Media is not shown yet')}` : ''}`,
      })),
      ...logs.filter((x) => x.status !== 'FAILED' || x.error_details?.code !== 'OPT_OUT').map((x): Entry => ({
        key: x.id, at: x.created_at, dir: 'out', kind: 'template', status: x.status, error: x.error_details?.message ?? x.last_error,
        text: renderSent(x, tpls.get(x.template_id)) || tpls.get(x.template_id)?.name || L('Template'),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at))
    setEntries(list)
  }, [L])

  useEffect(() => {
    if (!selected) { setEntries([]); return }
    loadThread(selected)
    if (selected.unread_count > 0) supabase.rpc('inbox_mark_read', { p_conversation: selected.id }).then(() => { loadList(); window.dispatchEvent(new Event('counts-changed')) })
    const ch = supabase.channel(`thread-${selected.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_messages', filter: `conversation_id=eq.${selected.id}` }, () => loadThread(selected))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_logs', filter: `phone_number=eq.${selected.phone_number}` }, () => loadThread(selected))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [selected?.id, selected?.last_message_at]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [entries.length, selected?.id])

  async function send() {
    if (!selected || !text.trim()) return
    setBusy(true); setError('')
    try {
      await callFunction('send-whatsapp-reply', { conversation_id: selected.id, text })
      setText(''); await loadThread(selected); loadList()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  async function act(fn: 'inbox_set_status' | 'inbox_assign', args: Record<string, unknown>) {
    setError('')
    const { error } = await supabase.rpc(fn, args)
    if (error) setError(error.message); else loadList()
  }

  async function simulate() {
    setError('')
    const { error } = await supabase.rpc('simulate_inbound', { p_entity: demo.entity, p_phone: demo.phone.trim(), p_name: demo.name, p_text: demo.text })
    if (error) setError(error.message); else { setDemo({ ...demo, open: false }); loadList() }
  }

  if (!convs) return <Loading />
  const demoEntities = entities.filter((e) => conns[e.id] !== 'live' && (isSuper || can('template.submit', e.id)))
  const left = selected ? windowLeft(selected) : 0
  const windowOpen = left > 0

  return (
    <>
      <PageHead title={L('Inbox')} sub={L('Replies and button taps from owners. You can answer in free text for 24 hours after their last message.')}>
        {demoEntities.length > 0 && <button className="btn btn-quiet btn-sm" onClick={() => setDemo({ ...demo, open: !demo.open, entity: demo.entity || demoEntities[0].id })}>{L('Simulate a reply (demo)')}</button>}
      </PageHead>
      {demo.open && (
        <section className="card p-5 mb-6 space-y-4 max-w-3xl">
          <p className="text-sm text-ink-50">{L('Demo only: creates an incoming message as if the owner had replied on WhatsApp.')}</p>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label={t('entity')}><Select value={demo.entity} onChange={(e) => setDemo({ ...demo, entity: e.target.value })}>{demoEntities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
            <Field label={L('Phone')}><input dir="ltr" value={demo.phone} onChange={(e) => setDemo({ ...demo, phone: e.target.value })} /></Field>
            <Field label={t('name')}><input value={demo.name} onChange={(e) => setDemo({ ...demo, name: e.target.value })} /></Field>
          </div>
          <Field label={L('Message')}><input value={demo.text} onChange={(e) => setDemo({ ...demo, text: e.target.value })} /></Field>
          <div className="flex gap-6"><button className="btn btn-sm" onClick={simulate}>{L('Receive reply')}</button><button className="link-btn" onClick={() => setDemo({ ...demo, open: false })}>{t('cancel')}</button></div>
          <p className="text-sm text-ink-50">{L('Tip: send the text STOP to see opt-out handling, and START to reverse it.')}</p>
        </section>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid lg:grid-cols-[22rem_1fr] rounded-2xl overflow-hidden bg-paper shadow-[var(--shadow-sm)] min-h-[32rem]">
        {/* conversation list */}
        <aside className={`${selected ? 'hidden lg:flex' : 'flex'} flex-col min-w-0 bg-card`}>
          <div className="p-4 space-y-3">
            <Field label={L('Search')}><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
            <div className="tabs" role="tablist">
              {(['open', 'unread', 'mine', 'closed'] as Filter[]).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                  className={`tab !px-3 !py-1.5 ${filter === f ? '' : ''}`}>
                  {{ open: L('Open'), unread: L('Unread'), mine: L('Mine'), closed: L('Closed') }[f]} ({counts[f]})
                </button>
              ))}
            </div>
          </div>
          <ul className="overflow-y-auto max-h-[36rem]">
            {shown.length === 0 && <li className="p-4 text-ink-50">{L('No conversations here.')}</li>}
            {shown.map((c) => (
              <li key={c.id} className="px-2 py-0.5">
                <button onClick={() => setParams({ c: c.id })}
                  className={`w-full text-start p-4 rounded-xl transition-colors duration-150 ${c.id === selectedId ? 'bg-paper text-ink shadow-[var(--shadow-sm)]' : 'hover:bg-paper/60 text-ink'}`}>
                  <span className="flex justify-between gap-3">
                    <span className={`truncate ${c.unread_count ? 'font-bold' : 'font-medium'}`}>{c.contact_name || maskPhone(c.phone_number)}</span>
                    <span className="text-xs opacity-60 whitespace-nowrap">{fmtTime(c.last_message_at)}</span>
                  </span>
                  <span className="flex justify-between gap-3 mt-1">
                    <span className="truncate text-sm opacity-75">{c.last_message_preview}</span>
                    {c.unread_count > 0 && <span className={`status ${c.id === selectedId ? 'status-outline' : 'status-filled'} !px-1.5 tnum`}>{c.unread_count}</span>}
                  </span>
                  <span className="block text-xs opacity-60 mt-1">{entityName(c.entity_id)}{c.assigned_to === profile?.id ? ` · ${L('Mine')}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* thread */}
        <section className={`${selected ? 'flex' : 'hidden lg:flex'} flex-col min-w-0`}>
          {!selected ? (
            <p className="p-8 text-ink-50">{L('Choose a conversation.')}</p>
          ) : (
            <>
              <header className="p-5 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <button className="link-btn lg:hidden text-sm mb-2" onClick={() => setParams({})}>{t('back')}</button>
                  <h2 className="!text-xl truncate">{selected.contact_name || selected.phone_number}</h2>
                  <p className="text-sm text-ink-50" dir="ltr">{selected.phone_number} · {entityName(selected.entity_id)}</p>
                </div>
                {canReply && (
                  <div className="flex gap-4 text-sm">
                    <button className="link-btn" onClick={() => act('inbox_assign', { p_conversation: selected.id, p_to_me: selected.assigned_to !== profile?.id })}>
                      {selected.assigned_to === profile?.id ? L('Unassign') : L('Assign to me')}
                    </button>
                    <button className="link-btn" onClick={() => act('inbox_set_status', { p_conversation: selected.id, p_status: selected.status === 'open' ? 'closed' : 'open' })}>
                      {selected.status === 'open' ? L('Close') : L('Reopen')}
                    </button>
                  </div>
                )}
              </header>

              <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[28rem] min-h-[16rem]" aria-live="polite">
                {entries.map((e) => (
                  <div key={e.key} className={`flex ${e.dir === 'out' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${e.dir === 'out' ? 'bg-ok-bg rounded-br-md' : 'bg-card rounded-bl-md'}`}>
                      {e.kind === 'template' && <p className="text-xs text-ink-50 mb-1">{L('Template message')}</p>}
                      <p className="whitespace-pre-wrap break-words text-ink">{e.text}</p>
                      <p className="text-xs text-ink-50 mt-2 flex flex-wrap items-center gap-2">
                        <span>{fmtTime(e.at)}</span>
                        {e.dir === 'out' && e.status && <StatusLabel value={e.status} />}
                        {e.error && <span>{e.error}</span>}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>

              <footer className="p-5 bg-card">
                {optedOut && <Notice>{L('This person opted out. They can start messages again by sending START.')}</Notice>}
                {!windowOpen && !optedOut && (
                  <p className="text-sm mb-3 text-ink-75">
                    {L('The 24-hour reply window is closed. Only approved templates can be sent now.')} <Link className="link-btn" to="/send">{L('Open Dispatch')}</Link>
                  </p>
                )}
                {windowOpen && <p className="text-sm text-ink-50 mb-2">{L('Reply window closes in')} <span className="text-ink tnum">{fmtLeft(left)}</span></p>}
                {canReply ? (
                  <div className="flex gap-3 items-end">
                    <label className="field flex-1">
                      <span className="sr-only">{L('Message')}</span>
                      <textarea className="!min-h-[5rem]" value={text} disabled={!windowOpen || optedOut} maxLength={4096} onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() }} placeholder={L('Write a reply')} />
                    </label>
                    <button className="btn" disabled={busy || !text.trim() || !windowOpen || optedOut} onClick={send}>{L('Send reply')}</button>
                  </div>
                ) : <p className="text-sm text-ink-50">{L('You can read this conversation but not reply.')}</p>}
              </footer>
            </>
          )}
        </section>
      </div>
    </>
  )
}
