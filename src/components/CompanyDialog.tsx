import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { callFunction } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { isE164, normalizePhone, type Entity, type SendAllowance } from '../lib/types'
import { ErrorNote, Field, Loading, Notice, StatusLabel, Tabs } from './ui'
import { Modal, useDialog } from './Dialog'
import Select from './Select'

interface Account {
  entity_id: string; entity: string; label: string | null; display_phone: string | null; phone_number_id: string | null
  waba_id: string | null; has_token: boolean; has_secret: boolean; api_version: string | null
  mode: 'demo' | 'live'; configured: boolean; effective_mode: 'demo' | 'live'; portfolio_id: string | null; template_cap: number
}
interface Status { mode: 'demo' | 'live'; api_version: string; accounts: Account[] }
interface Health {
  entity_id: string; checked_at: string; token_ok: boolean | null; management_ok: boolean | null; messaging_ok: boolean | null
  quality_rating: string | null; phone_status: string | null; limit_tier: string | null; error: string | null
}
interface Draft { label: string; display_phone: string; phone_number_id: string; waba_id: string; token: string; secret: string; api_version: string; mode: 'demo' | 'live'; portfolio: string; template_cap: number }
interface Member { user_id: string; name: string; email: string; role: string }

export type TabId = 'overview' | 'whatsapp' | 'people'

/** Everything about one company in a popup: its details, its WhatsApp link and its people. */
export default function CompanyDialog({ entity, onClose, onChanged, startTab }: { entity: Entity; onClose: () => void; onChanged: () => void; startTab?: TabId }) {
  const { L } = useI18n()
  const { confirm } = useDialog()
  const [tab, setTab] = useState<TabId>(startTab ?? 'overview')
  const [name, setName] = useState(entity.name)
  const [status, setStatus] = useState<Status | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [stats, setStats] = useState<{ clients: number; groups: number; templates: number } | null>(null)
  const [members, setMembers] = useState<Member[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [allow, setAllow] = useState<SendAllowance | null>(null)
  const [limits, setLimits] = useState<{ cap: string; warmup: boolean }>({ cap: '', warmup: false })
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [checking, setChecking] = useState(false)

  const account = status?.accounts.find((a) => a.entity_id === entity.id)

  const toDraft = (a: Account | undefined): Draft => ({
    label: a?.label ?? '', display_phone: a?.display_phone ?? '', phone_number_id: a?.phone_number_id ?? '', waba_id: a?.waba_id ?? '',
    token: '', secret: '', api_version: a?.api_version ?? '', mode: a?.mode ?? 'demo', portfolio: a?.portfolio_id ?? '', template_cap: a?.template_cap ?? 250,
  })

  const loadLink = useCallback(async () => {
    const [{ data: s }, { data: h }] = await Promise.all([supabase.rpc('get_whatsapp_status'), supabase.rpc('entity_health')])
    const st = s as Status
    setStatus(st)
    setHealth(((h as Health[]) ?? []).find((x) => x.entity_id === entity.id) ?? null)
    setDraft(toDraft(st.accounts.find((a) => a.entity_id === entity.id)))
    const { data: al } = await supabase.rpc('send_allowance', { p_entity: entity.id })
    const a = al as SendAllowance | null
    setAllow(a)
    setLimits({ cap: a?.daily_cap ? String(a.daily_cap) : '', warmup: !!a?.warmup_on })
  }, [entity.id])

  useEffect(() => {
    loadLink()
    ;(async () => {
      const { data: p } = await supabase.from('projects').select('id').eq('entity_id', entity.id).eq('is_default', true).maybeSingle()
      const [c, g, t] = await Promise.all([
        p ? supabase.from('project_owners').select('owner_id', { count: 'exact', head: true }).eq('project_id', (p as { id: string }).id) : Promise.resolve({ count: 0 }),
        supabase.from('client_lists').select('id', { count: 'exact', head: true }).eq('entity_id', entity.id),
        supabase.from('whatsapp_templates').select('id', { count: 'exact', head: true }).eq('entity_id', entity.id).neq('status', 'ARCHIVED'),
      ])
      setStats({ clients: c.count ?? 0, groups: g.count ?? 0, templates: t.count ?? 0 })

      const { data: em } = await supabase.from('entity_members').select('user_id, role_id').eq('entity_id', entity.id)
      const rows = (em as { user_id: string; role_id: string }[]) ?? []
      const [pr, ro] = await Promise.all([
        rows.length ? supabase.from('profiles').select('id, email, full_name').in('id', rows.map((r) => r.user_id)) : Promise.resolve({ data: [] }),
        supabase.from('roles').select('id, name'),
      ])
      const people = Object.fromEntries(((pr.data as { id: string; email: string; full_name: string | null }[]) ?? []).map((x) => [x.id, x]))
      const roles = Object.fromEntries(((ro.data as { id: string; name: string }[]) ?? []).map((x) => [x.id, x.name]))
      setMembers(rows.map((r) => ({ user_id: r.user_id, name: people[r.user_id]?.full_name ?? '', email: people[r.user_id]?.email ?? '', role: roles[r.role_id] ?? '' }))
        .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)))
    })()
  }, [entity.id, loadLink])

  async function rename(e: FormEvent) {
    e.preventDefault(); setError(''); setInfo('')
    if (!name.trim() || name.trim() === entity.name) return
    const { error } = await supabase.from('entities').update({ name: name.trim() }).eq('id', entity.id)
    if (error) setError(error.message); else { setInfo(L('Saved.')); onChanged() }
  }

  async function toggleActive() {
    const deactivate = entity.status === 'active'
    if (deactivate) {
      const ok = await confirm({
        title: `${L('Deactivate')} ${entity.name}?`, danger: true, confirmLabel: L('Deactivate'),
        message: L('Employees of this company will not be able to send messages until it is activated again.'),
      })
      if (!ok) return
    }
    const { error } = await supabase.from('entities').update({ status: deactivate ? 'inactive' : 'active' }).eq('id', entity.id)
    if (error) setError(error.message); else { onChanged(); onClose() }
  }

  async function removeCompany() {
    const ok = await confirm({
      title: `${L('Delete')} ${entity.name}?`, danger: true, confirmLabel: L('Delete company'), requireText: entity.name,
      message: L('This permanently removes the company, its clients, groups, templates, people access and WhatsApp connection. It cannot be undone.'),
    })
    if (!ok) return
    setError(''); setInfo('')
    const { error } = await supabase.rpc('delete_entity', { p_entity: entity.id })
    if (error) setError(error.message); else { onChanged(); onClose() }
  }

  async function saveLink(e: FormEvent) {
    e.preventDefault()
    if (!draft) return
    setError(''); setInfo('')
    const phone = draft.display_phone ? normalizePhone(draft.display_phone) : ''
    if (phone && !isE164(phone)) { setError(L('Phone must be in international format, for example +201010354164.')); return }
    const { error } = await supabase.rpc('save_whatsapp_account', {
      p_entity: entity.id, p_label: draft.label, p_display_phone: phone, p_phone_number_id: draft.phone_number_id.trim(), p_waba_id: draft.waba_id.trim(),
      p_access_token: draft.token, p_app_secret: draft.secret, p_api_version: draft.api_version.trim(), p_mode: draft.mode,
      p_portfolio: draft.portfolio.trim(), p_template_cap: draft.template_cap,
    })
    if (error) { setError(error.message); return }
    setInfo(L('Saved.')); onChanged(); loadLink()
  }

  async function saveLimits(restart = false) {
    setError(''); setInfo('')
    const raw = limits.cap.trim()
    if (raw && (!/^\d+$/.test(raw) || Number(raw) < 1)) { setError(L('The daily limit must be a whole number of 1 or more, or empty for no limit.')); return }
    const { error } = await supabase.rpc('save_send_limits', { p_entity: entity.id, p_daily_cap: raw ? Number(raw) : null, p_warmup: limits.warmup, p_restart: restart })
    if (error) { setError(error.message); return }
    setInfo(L('Saved.')); loadLink()
  }

  async function disconnect() {
    const ok = await confirm({
      title: `${L('Disconnect the WhatsApp number of')} ${entity.name}?`, danger: true, confirmLabel: L('Disconnect'), requireText: entity.name,
      message: L('Messages for this company will stop sending until a number is connected again.'),
    })
    if (!ok) return
    setError(''); setInfo('')
    const { error } = await supabase.rpc('delete_whatsapp_account', { p_entity: entity.id })
    if (error) setError(error.message); else { setInfo(L('Disconnected.')); onChanged(); loadLink() }
  }

  async function checkNow() {
    setChecking(true); setError(''); setInfo('')
    try { await callFunction('whatsapp-health', { entity_id: entity.id }); await loadLink() } catch (e) { setError((e as Error).message) }
    setChecking(false)
  }

  const yn = (v: boolean | null | undefined) => (v === null || v === undefined ? '—' : v ? L('Yes') : L('No'))
  const master = status?.mode

  return (
    <Modal title={entity.name} onClose={onClose} size="xl">
      <Tabs<TabId> value={tab} onChange={(v) => { setTab(v); setError(''); setInfo('') }} items={[
        { id: 'overview', label: L('Overview') }, { id: 'whatsapp', label: L('WhatsApp link') }, { id: 'people', label: L('People') },
      ]} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {info && <Notice tone="ok">{info}</Notice>}

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            {[[L('Clients'), stats?.clients], [L('Groups'), stats?.groups], [L('Templates'), stats?.templates]].map(([label, n]) => (
              <div key={label as string} className="rounded-2xl bg-card px-4 py-3">
                <p className="text-sm text-ink-50">{label}</p>
                <p className="text-ink font-bold text-2xl tnum">{n ?? '…'}</p>
              </div>
            ))}
          </div>
          <form onSubmit={rename} className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-48"><Field label={L('Company name')}><input required value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
            <button className="btn btn-quiet" disabled={!name.trim() || name.trim() === entity.name}>{L('Save')}</button>
          </form>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card px-4 py-3">
            <p className="text-ink-75">{L('Status')}: <StatusLabel value={entity.status} /></p>
            <button className="btn btn-quiet btn-sm" onClick={toggleActive}>{entity.status === 'active' ? L('Deactivate') : L('Activate')}</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-quiet btn-sm" to={`/owners?entity=${entity.id}`} onClick={onClose}>{L('Open client list')}</Link>
            <Link className="btn btn-quiet btn-sm" to="/templates" onClick={onClose}>{L('Open templates')}</Link>
          </div>
          <div className="pt-4 border-t border-[var(--line)] flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-50 max-w-md">{L('Delete this company for good. A company that has already sent messages cannot be deleted, so deactivate it instead.')}</p>
            <button type="button" className="btn btn-quiet btn-sm !text-bad" onClick={removeCompany}>{L('Delete company')}</button>
          </div>
        </div>
      )}

      {tab === 'whatsapp' && (!status || !draft ? <Loading /> : (
        <form onSubmit={saveLink} className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-card px-4 py-3">
            {account?.configured ? <span className="status tone-ok">{L('Connected')}</span> : <span className="status tone-neutral">{L('Not connected')}</span>}
            <span className="text-ink" dir="ltr">{account?.display_phone ?? ''}</span>
            <span className="text-ink-50 text-sm ms-auto">
              {account?.effective_mode === 'live' ? L('Sending live') : L('Demo mode')}
              {master === 'demo' && account?.mode === 'live' ? ` · ${L('The master switch in Shared settings is on Demo')}` : ''}
            </span>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Field label={L('Phone Number ID')} hint={L('From Meta: WhatsApp > API setup. Not the phone number itself.')}><input dir="ltr" value={draft.phone_number_id} onChange={(e) => setDraft({ ...draft, phone_number_id: e.target.value })} /></Field>
            <Field label={L('WhatsApp Business Account ID (WABA)')}><input dir="ltr" value={draft.waba_id} onChange={(e) => setDraft({ ...draft, waba_id: e.target.value })} /></Field>
            <Field label={L('Access token')} hint={account?.has_token ? L('A token is stored. Leave blank to keep it.') : L('Leave blank to use the shared token.')}><input type="password" autoComplete="off" dir="ltr" value={draft.token} onChange={(e) => setDraft({ ...draft, token: e.target.value })} /></Field>
            <Field label={L('App secret')} hint={L('Only if this company uses its own Meta app. Leave blank otherwise.')}><input type="password" autoComplete="off" dir="ltr" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} /></Field>
            <Field label={L('Mode')}>
              <Select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as 'demo' | 'live' })}>
                <option value="demo">{L('Demo (nothing is sent to WhatsApp)')}</option><option value="live">{L('Live (real messages)')}</option>
              </Select>
            </Field>
          </div>
          <details className="text-sm">
            <summary className="text-ink-75 cursor-pointer">{L('More options')}</summary>
            <div className="grid sm:grid-cols-2 gap-5 mt-4">
              <Field label={L('Graph API version')} hint={L('Blank uses the shared version.')}><input dir="ltr" placeholder={status.api_version} value={draft.api_version} onChange={(e) => setDraft({ ...draft, api_version: e.target.value })} /></Field>
            </div>
          </details>

          <div className="rounded-2xl bg-card px-4 py-4 space-y-4">
            <div>
              <p className="font-medium text-ink">{L('Sending limits')}</p>
              <p className="text-sm text-ink-50">{L('These protect the number from being flagged. They only apply to live sending.')}</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-4 bordered-fields">
              <Field label={L('Daily message limit')} hint={L('Most live messages this company can send in one day. Leave empty for no limit.')}>
                <input inputMode="numeric" dir="ltr" placeholder={L('No limit')} value={limits.cap} onChange={(e) => setLimits({ ...limits, cap: e.target.value })} />
              </Field>
              <div className="field">
                <span>{L('Warm-up mode')}</span>
                <label className="flex items-start gap-3 min-h-11 py-2 text-ink-75 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={limits.warmup} onChange={(e) => setLimits({ ...limits, warmup: e.target.checked })} />
                  <span>{L('Start small and grow over 14 days: 50, 100, 150, 250, 400, 600, 800, then 1,000 a day. Turn it on the day this number goes live.')}</span>
                </label>
              </div>
            </div>
            {allow && (allow.warmup_on || allow.limit !== null) && (
              <p className="text-sm text-ink-75">
                {allow.warmup_on && (allow.warmup_done ? `${L('Warm-up finished.')} ` : `${L('Warm-up day')} ${allow.warmup_day} ${L('of 14')}. `)}
                {allow.limit !== null ? `${L('Today')}: ${allow.used} / ${allow.limit} ${L('used')}, ${allow.remaining} ${L('left')}.` : `${L('Today')}: ${allow.used} ${L('sent')}.`}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => saveLimits(false)}>{L('Save limits')}</button>
              {allow?.warmup_on && limits.warmup && <button type="button" className="link-btn" onClick={() => saveLimits(true)}>{L('Restart warm-up from day 1')}</button>}
            </div>
          </div>

          {account?.configured && account.phone_number_id && (
            <div className="rounded-2xl bg-card px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="font-medium text-ink">{L('Connection health')}</p>
                <button type="button" className="link-btn" disabled={checking} onClick={checkNow}>{checking ? L('Checking') + '…' : L('Check now')}</button>
              </div>
              {health ? (
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div><dt className="text-ink-50">{L('Can send')}</dt><dd className="text-ink">{yn(health.messaging_ok)}</dd></div>
                  <div><dt className="text-ink-50">{L('Can manage templates')}</dt><dd className="text-ink">{yn(health.management_ok)}</dd></div>
                  <div><dt className="text-ink-50">{L('Quality')}</dt><dd className="text-ink">{health.quality_rating ?? '—'}</dd></div>
                  <div><dt className="text-ink-50">{L('24-hour limit')}</dt><dd className="text-ink">{health.limit_tier?.replace('TIER_', '') ?? '—'}</dd></div>
                </dl>
              ) : <p className="text-ink-50">{L('Never')}</p>}
              {health?.error && <p className="text-ink-50 mt-2">{health.error}</p>}
            </div>
          )}

          <div className="dialog-footer flex flex-wrap items-center justify-between gap-3">
            {account?.configured ? <button type="button" className="link-btn !text-bad" onClick={disconnect}>{L('Disconnect')}</button> : <span />}
            <button className="btn">{account?.configured ? L('Save') : L('Connect')}</button>
          </div>
        </form>
      ))}

      {tab === 'people' && (!members ? <Loading /> : (
        <div className="space-y-4">
          {members.length === 0 ? <p className="text-ink-50">{L('Nobody has access to this company yet.')}</p> : (
            <ul className="divide-y divide-ink-25">
              {members.map((m) => (
                <li key={m.user_id} className="flex items-center justify-between gap-4 py-3">
                  <span className="min-w-0"><span className="block text-ink font-medium truncate">{m.name || m.email}</span>{m.name && <span className="block text-sm text-ink-50 truncate">{m.email}</span>}</span>
                  <span className="status tone-neutral whitespace-nowrap">{m.role}</span>
                </li>
              ))}
            </ul>
          )}
          <Link className="btn btn-quiet btn-sm" to="/admin/people" onClick={onClose}>{L('Manage people')}</Link>
        </div>
      ))}
    </Modal>
  )
}
