import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { callFunction } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  BUILTIN_FIELDS, extractVars, fillText, templateVarNames,
  type Category, type OwnerField, type TButton, type Template, type TemplateVar, type TStatus,
} from '../lib/types'
import { EntityFilter, ErrorNote, Field, Loading, Notice, PageHead, PhonePreview, StatusLabel, entityScope, fmtDate } from '../components/ui'
import { useDialog } from '../components/Dialog'
import Select from '../components/Select'

const CATEGORIES: Category[] = ['UTILITY', 'MARKETING', 'AUTHENTICATION']
const STATUSES: TStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ARCHIVED']
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

/* ------------------------------ list ------------------------------ */

export function TemplateList() {
  const { t, L } = useI18n()
  const { can, entities, entitiesWith, templateAllowed } = useAuth()
  const [rows, setRows] = useState<Template[] | null>(null)
  const [entityId, setEntityId] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [quota, setQuota] = useState<{ entity_id: string; waba_id: string | null; used: number; cap: number; created_last_hour: number }[]>([])
  const [syncing, setSyncing] = useState(false)
  const [unmatched, setUnmatched] = useState(0)
  const submitters = entitiesWith('template.submit')

  const load = useCallback(async () => {
    supabase.rpc('template_quota').then(({ data }) => setQuota((data as typeof quota) ?? []))
    const { data, error } = await supabase.from('whatsapp_templates').select('*').order('updated_at', { ascending: false })
    if (error) setError(error.message)
    setRows((data as Template[]) ?? [])
  }, [])
  useEffect(() => {
    load()
    const ch = supabase.channel('templates-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_templates' }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? ''
  const shown = (rows ?? []).filter((r) =>
    templateAllowed(r) && entityScope(entityId, entities).includes(r.entity_id) && (!category || r.category === category)
    && (status ? r.status === status : r.status !== 'ARCHIVED')
    && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()) || r.body_text.toLowerCase().includes(q.trim().toLowerCase())))

  async function sync(doImport: boolean) {
    setSyncing(true); setError(''); setInfo('')
    try {
      let updated = 0, imported = 0, un = 0
      const skipped: string[] = []
      for (const e of submitters) {
        const res = await callFunction<{ results: { updated?: number; imported?: number; unmatched?: unknown[]; skipped?: { name: string; reason: string }[]; error?: string }[] }>(
          'sync-whatsapp-templates', { entity_id: e.id, import: doImport })
        for (const r of res.results) {
          if (r.error) { setError(`${e.name}: ${r.error}`); continue }
          updated += r.updated ?? 0; imported += r.imported ?? 0; un += r.unmatched?.length ?? 0
          ;(r.skipped ?? []).forEach((x) => skipped.push(`${x.name} (${x.reason})`))
        }
      }
      setUnmatched(doImport ? 0 : un)
      setInfo(`${L('Synced with Meta')}: ${updated} ${L('updated')}${doImport ? `, ${imported} ${L('imported')}` : un ? `, ${un} ${L('only on Meta')}` : ''}${skipped.length ? `. ${L('Skipped')}: ${skipped.slice(0, 3).join('; ')}` : ''}`)
      load()
    } catch (e) { setError((e as Error).message) }
    setSyncing(false)
  }

  async function setTemplateStatus(r: Template, next: TStatus) {
    setError('')
    const { error } = await supabase.from('whatsapp_templates').update({ status: next }).eq('id', r.id)
    if (error) setError(error.message); else load()
  }

  return (
    <>
      <PageHead title={t('templates')} sub={L('The messages you can send to owners. Each one is reviewed by WhatsApp before it can be used.')}>
        {submitters.length > 0 && <button className="btn btn-quiet" disabled={syncing} onClick={() => sync(false)}>{L('Sync with Meta')}</button>}
        {entitiesWith('template.create').length > 0 && <Link to="/templates/new" className="btn inline-flex items-center">{t('newTemplate')}</Link>}
      </PageHead>
      {quota.length > 0 && (
        <p className="text-sm text-ink-50 mb-6 flex flex-wrap gap-x-6 gap-y-1">
          {quota.map((qq) => (
            <span key={qq.entity_id}>{entities.find((e) => e.id === qq.entity_id)?.name}: <span className="text-ink tnum">{qq.used}/{qq.cap}</span> {L('templates on Meta')}
              {qq.used >= qq.cap * 0.8 && <span className="status tone-warn ms-2">{L('Near the limit')}</span>}
              {qq.created_last_hour > 0 && <span> · {qq.created_last_hour}/100 {L('created this hour')}</span>}</span>
          ))}
        </p>
      )}
      {info && <Notice>{info} {unmatched > 0 && <button className="link-btn ms-2" onClick={() => sync(true)}>{L('Import them')}</button>}</Notice>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <Field label={L('Search')}><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label={t('entity')}>
          <EntityFilter entities={entities} value={entityId} onChange={setEntityId} />
        </Field>
        <Field label={L('Category')}>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{L('All categories')}</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{L(cap(c))}</option>)}
          </Select>
        </Field>
        <Field label={L('Status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{L('All except archived')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{L(cap(s.replace('_', ' ')))}</option>)}
          </Select>
        </Field>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!rows ? <Loading /> : shown.length === 0 ? <p>{t('noTemplates')}</p> : (
        <div className="lg:overflow-x-auto">
          <table className="grid-table">
            <thead><tr>
              <th>{t('name')}</th><th>{t('entity')}</th><th>{L('Category')}</th><th>{L('Status')}</th><th>{t('version')}</th><th>{t('updated')}</th><th>{t('actions')}</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="cell-title">
                    <Link className="link-btn" to={`/templates/${r.id}`}>{r.name}</Link>
                  </td>
                  <td data-label={t('entity')}>{entityName(r.entity_id)}</td>
                  <td data-label={L('Category')}>{L(cap(r.category))}</td>
                  <td data-label={L('Status')} className="cell-wide">
                    <StatusLabel value={r.status} />
                    {r.meta_status && !['APPROVED', 'PENDING', 'REJECTED'].includes(r.meta_status) && <span className="status tone-neutral ms-2" title={L('Status reported by Meta')}>Meta: {r.meta_status.toLowerCase().replace(/_/g, ' ')}</span>}
                    {r.status === 'REJECTED' && r.rejection_reason && <span className="block text-sm text-ink-50 mt-1 max-w-56">{r.rejection_reason}</span>}
                  </td>
                  <td data-label={t('version')}>{r.version}</td>
                  <td data-label={t('updated')}>{fmtDate(r.updated_at)}</td>
                  <td className="cell-actions whitespace-nowrap">
                    <Link className="link-btn me-4" to={`/templates/${r.id}`}>{r.status === 'ARCHIVED' || !can('template.update', r.entity_id) ? L('Open') : t('edit')}</Link>
                    {r.status !== 'ARCHIVED' && can('template.archive', r.entity_id) && (
                      <button className="link-btn" onClick={() => setTemplateStatus(r, 'ARCHIVED')}>{t('archive')}</button>
                    )}
                    {r.status === 'ARCHIVED' && can('template.archive', r.entity_id) && (
                      <button className="link-btn" onClick={() => setTemplateStatus(r, r.previous_status ?? 'DRAFT')}>{t('restore')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/* ------------------------------ editor ------------------------------ */

const emptyButton = (): TButton => ({ type: 'QUICK_REPLY', text: '' })

export function TemplateEditor() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const { t, L } = useI18n()
  const { prompt } = useDialog()
  const { entities, entitiesWith, can } = useAuth()
  const creatable = entitiesWith('template.create')
  const [original, setOriginal] = useState<Template | null>(null)
  const [entityId, setEntityId] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState<Category>('UTILITY')
  const [language, setLanguage] = useState<'en' | 'ar'>('en')
  const [header, setHeader] = useState('')
  const [body, setBody] = useState('')
  const [footer, setFooter] = useState('')
  const [buttons, setButtons] = useState<TButton[]>([])
  const [vars, setVars] = useState<TemplateVar[]>([])
  const [custom, setCustom] = useState<OwnerField[]>([])
  const [sample, setSample] = useState<Record<string, string>>({})
  const [conns, setConns] = useState<Record<string, string>>({})
  const [budget, setBudget] = useState<{ last_24h: number; last_30d: number; limited: boolean; next_allowed_at: string | null } | null>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(isNew)

  useEffect(() => {
    supabase.rpc('entity_connections').then(({ data }) => setConns(Object.fromEntries(((data as { entity_id: string; mode: string }[]) ?? []).map((c) => [c.entity_id, c.mode]))))
  }, [])

  useEffect(() => {
    if (isNew) { if (creatable[0] && !entityId) setEntityId(creatable[0].id); return }
    supabase.from('whatsapp_templates').select('*').eq('id', id).maybeSingle().then(({ data }) => {
      const r = data as Template | null
      if (r) {
        setOriginal(r); setEntityId(r.entity_id); setName(r.name); setCategory(r.category)
        setLanguage(r.language); setHeader(r.header_text ?? ''); setBody(r.body_text); setFooter(r.footer_text ?? '')
        setButtons(r.buttons ?? []); setVars(r.variables ?? [])
        if (r.meta_template_id) supabase.rpc('template_edit_budget', { p_template: r.id }).then(({ data }) => setBudget(data as typeof budget))
      }
      setLoaded(true)
    })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // owner fields come from the imported owner data; the first real owner supplies the examples Meta asks for
  useEffect(() => {
    if (!entityId) return
    ;(async () => {
      const [f, o] = await Promise.all([
        supabase.from('owner_fields').select('key, label, example').eq('entity_id', entityId).order('label'),
        supabase.from('project_owners').select('unit_no, owners(full_name, phone, email), projects!inner(name, code, entity_id)').eq('projects.entity_id', entityId).limit(1),
      ])
      setCustom(((f.data as { key: string; label: string; example: string }[]) ?? []).map((x) => ({ ...x, builtin: false })))
      const row = ((o.data as unknown as { unit_no: string | null; owners: { full_name: string; phone: string; email: string | null }; projects: { name: string; code: string } }[]) ?? [])[0]
      setSample(row ? {
        owner_name: row.owners.full_name, unit_number: row.unit_no ?? '', phone: row.owners.phone, email: row.owners.email ?? '',
      } : {})
    })()
  }, [entityId])
  const entityLabel = entities.find((e) => e.id === entityId)?.name ?? ''
  const fields: OwnerField[] = useMemo(() => [
    ...BUILTIN_FIELDS.map((b) => ({ key: b.key, label: L(b.label), example: (b.key === 'entity_name' || b.key === 'project_name' ? entityLabel : sample[b.key]) || b.example, builtin: true, legacy: b.legacy })),
    ...custom,
  ], [custom, sample, entityLabel, L])
  const fieldMap = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f])), [fields])
  const positional = original?.parameter_format === 'POSITIONAL'

  // placeholders are read from the message text; the employee never fills in examples or sources
  const names = useMemo(() => templateVarNames({ header_text: header, body_text: body }), [header, body])
  useEffect(() => {
    setVars((prev) => names.map((n) => {
      const old = prev.find((v) => v.name === n)
      return positional
        ? { name: n, example: old?.example || fieldMap[old?.source ?? '']?.example || 'Sample', source: old?.source ?? '' }
        : { name: n, example: old?.example || fieldMap[n]?.example || 'Sample', source: n }
    }))
  }, [names, fieldMap, positional])

  const archived = original?.status === 'ARCHIVED'
  const demoMode = conns[entityId] !== 'live'
  const hasMeta = !!original?.meta_template_id
  const metaBlocksEdit = hasMeta && !demoMode && !!original?.meta_status && !['APPROVED', 'REJECTED', 'PAUSED'].includes(original.meta_status)
  const canEdit = isNew ? true : !archived && can('template.update', entityId)
  const badNames = positional ? [] : names.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n))
  const unknownNames = positional ? [] : names.filter((n) => /^[a-z][a-z0-9_]*$/.test(n) && !fieldMap[n])
  const examples = Object.fromEntries(vars.map((v) => [v.name, v.example || `{{${v.name}}}`]))
  const dir = language === 'ar' ? 'rtl' : 'ltr'

  const contentChanged = !!original && (
    original.name !== name || original.category !== category || original.language !== language || (original.header_text ?? '') !== header
    || original.body_text !== body || (original.footer_text ?? '') !== footer
    || JSON.stringify(original.buttons ?? []) !== JSON.stringify(buttons)
    || JSON.stringify(original.variables ?? []) !== JSON.stringify(vars))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (badNames.length) { setError(L('A field name in the text is not valid. Use the field buttons to add fields.')); return }
    if (unknownNames.length) { setError(`${L('This field is not in your owner data')}: ${unknownNames.map((n) => `{{${n}}}`).join(', ')}. ${L('Use the field buttons, or import a file that has this column.')}`); return }
    setBusy(true); setError(''); setInfo('')
    const payload = {
      entity_id: entityId, project_ids: [], name: name.trim(), category, language,
      header_text: header.trim() || null, body_text: body, footer_text: footer.trim() || null,
      buttons: buttons.filter((b) => b.text.trim()), variables: vars,
    }
    const res = isNew
      ? await supabase.from('whatsapp_templates').insert(payload).select('id').single()
      : await supabase.from('whatsapp_templates').update(payload).eq('id', id!).select('id').single()
    setBusy(false)
    if (res.error) { setError(res.error.message); return }
    if (isNew) { nav(`/templates/${res.data.id}`, { replace: true }); return }
    await reloadOriginal()
    setInfo(L('Saved. Use the next step below.'))
  }

  async function reloadOriginal() {
    const { data } = await supabase.from('whatsapp_templates').select('*').eq('id', id!).maybeSingle()
    if (data) setOriginal(data as Template)
  }

  async function lifecycle(next: TStatus) {
    setBusy(true); setError('')
    const patch: Record<string, unknown> = { status: next }
    if (next === 'REJECTED') {
      const reason = await prompt({ title: L('Reject this template?'), label: L('Reason for rejection'), confirmLabel: L('Reject') })
      if (reason === null) { setBusy(false); return }
      patch.rejection_reason = reason || L('Rejected in demo mode')
    }
    const { error } = await supabase.from('whatsapp_templates').update(patch).eq('id', id!)
    setBusy(false)
    if (error) setError(error.message); else await reloadOriginal()
  }

  async function submitToMeta() {
    setBusy(true); setError(''); setInfo('')
    try {
      await callFunction('submit-whatsapp-template', { template_id: id })
      setInfo(L('Submitted. The status updates automatically when Meta replies.'))
      const { data } = await supabase.from('whatsapp_templates').select('*').eq('id', id).maybeSingle()
      if (data) setOriginal(data as Template)
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  if (!loaded) return <Loading />
  if (!isNew && !original) return <Notice>{t('error')}</Notice>

  const st = original?.status
  const nextText = st === 'DRAFT'
    ? (can('template.submit', entityId)
        ? (hasMeta ? L('Your changes are saved here. Send them to Meta so they can be reviewed.') : L('Ready? Send this template to Meta for approval.'))
        : L('Ask an admin to approve this template so it can be sent.'))
    : st === 'PENDING_APPROVAL'
      ? (original?.meta_submitted_at ? L('Waiting for Meta to review. This usually takes a few minutes to a day.') : L('Waiting for an admin to send this to Meta.'))
      : st === 'REJECTED' ? L('Meta rejected this template. Edit it, then send it again.')
      : st === 'APPROVED' ? L('Approved. You can send this message from Send messages.') : ''
  return (
    <>
      <PageHead title={isNew ? t('newTemplate') : original!.name}>
        {!isNew && <StatusLabel value={original!.status} />}
      </PageHead>
      {original?.status === 'REJECTED' && original.rejection_reason && <ErrorNote>{L('Rejected')}: {original.rejection_reason}</ErrorNote>}
      {original?.meta_name && <p className="text-sm text-ink-50 mb-4">{L('Meta template name')}: <span className="text-ink" dir="ltr">{original.meta_name}</span></p>}

      <div className="grid xl:grid-cols-[3fr_2fr] gap-10 xl:gap-16">
        <form onSubmit={save} className="space-y-6">
          <fieldset disabled={!canEdit} className="border-0 p-0 m-0 space-y-6">
            <div className="grid sm:grid-cols-2 gap-6">
              <Field label={t('entity')}>
                <Select required value={entityId} disabled={!isNew} onChange={(e) => setEntityId(e.target.value)}>
                  {(isNew ? creatable : entities).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
              </Field>
              <Field label={t('name')}><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label={L('Category')} hint={original?.meta_approved_once ? L('Meta does not allow changing the category after approval.') : undefined}>
                <Select value={category} disabled={!!original?.meta_approved_once} onChange={(e) => setCategory(e.target.value as Category)}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{L(cap(c))}</option>)}
                </Select>
              </Field>
              <Field label={t('language_')}>
                <Select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'ar')}>
                  <option value="en">English</option><option value="ar">العربية</option>
                </Select>
              </Field>
            </div>

            <div>
              <Field label={`${L('Message')} (${body.length}/1024)`}>
                <textarea required maxLength={1024} value={body} onChange={(e) => setBody(e.target.value)} dir={dir} />
              </Field>
            </div>
            {vars.length > 0 && (
              <section className="card">
                <h3 className="mb-1">{L('Fields in this message')}</h3>
                <p className="text-sm text-ink-50 mb-3">{L('Meta reviews a template using an example for each field. The examples are taken from your owner data automatically.')}</p>
                <ul className="space-y-2">
                  {vars.map((v, i) => (
                    <li key={v.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-paper rounded-xl px-4 py-2.5">
                      <span className="text-ink-50" dir="ltr">{`{{${v.name}}}`}</span>
                      {positional ? (
                        <label className="field flex-1 min-w-48"><span className="sr-only">{L('Filled from')}</span>
                          <Select value={v.source} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, source: e.target.value, example: fieldMap[e.target.value]?.example ?? x.example } : x)))}>
                            <option value="">{L('Choose the field that fills this')}</option>
                            {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                          </Select>
                        </label>
                      ) : (
                        <>
                          <span className="text-ink font-medium">{fieldMap[v.name]?.label ?? v.name}</span>
                          <span className="text-ink-50">{L('Example')}: <span className="text-ink">{v.example}</span></span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {unknownNames.length > 0 && <ErrorNote>{L('Not in your owner data')}: {unknownNames.map((n) => `{{${n}}}`).join(', ')}. {L('Use the field buttons, or import a file that has this column.')}</ErrorNote>}
                {badNames.length > 0 && <ErrorNote>{L('A field name in the text is not valid. Use the field buttons to add fields.')}: {badNames.join(', ')}</ErrorNote>}
              </section>
            )}
            <details className="card">
              <summary className="font-medium text-ink">{L('More options')} <span className="text-ink-50 font-normal text-sm">({L('header, footer, buttons')})</span></summary>
              <div className="space-y-6 mt-5">
            <Field label={`${L('Header')} (${header.length}/60)`} hint={L('Optional. A short title.')}>
              <input maxLength={60} value={header} onChange={(e) => setHeader(e.target.value)} dir={dir} />
            </Field>
            <Field label={`${L('Footer')} (${footer.length}/60)`}>
              <input maxLength={60} value={footer} onChange={(e) => setFooter(e.target.value)} dir={dir} />
            </Field>

            <section>
              <h3 className="mb-3">{L('Buttons')} <span className="text-ink-50 text-sm font-normal">({buttons.length}/3)</span></h3>
              {buttons.map((b, i) => (
                <div key={i} className="grid sm:grid-cols-[10rem_1fr_1fr_auto] gap-4 items-end mb-3">
                  <Field label={L('Type')}>
                    <Select value={b.type} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, type: e.target.value as TButton['type'] } : x)))}>
                      <option value="QUICK_REPLY">{L('Quick reply')}</option><option value="URL">{L('Link')}</option><option value="PHONE_NUMBER">{L('Call')}</option>
                    </Select>
                  </Field>
                  <Field label={L('Label')}><input maxLength={25} value={b.text} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} /></Field>
                  {b.type === 'URL' && <Field label="URL"><input type="url" dir="ltr" value={b.url ?? ''} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} /></Field>}
                  {b.type === 'PHONE_NUMBER' && <Field label={L('Phone')}><input dir="ltr" placeholder="+201010354164" value={b.phone ?? ''} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} /></Field>}
                  {b.type === 'QUICK_REPLY' && <span />}
                  <button type="button" className="link-btn pb-3" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>{t('remove')}</button>
                </div>
              ))}
              {buttons.length < 3 && <button type="button" className="btn btn-quiet btn-sm" onClick={() => setButtons([...buttons, emptyButton()])}>{L('Add button')}</button>}
            </section>


              </div>
            </details>
          </fieldset>

          {archived && <Notice>{L('Archived templates are read-only. Restore the template to edit it.')}</Notice>}
          {!isNew && st === 'APPROVED' && contentChanged && <Notice>{L('Changing an approved template creates a new version that must be approved again.')}</Notice>}
          {hasMeta && !demoMode && original?.meta_status && original.meta_status !== 'APPROVED' && (
            <Notice>{L('Meta reports this template as')} <strong>{original.meta_status.toLowerCase().replace(/_/g, ' ')}</strong>.{metaBlocksEdit ? ` ${L('Meta only allows edits while it is Approved, Rejected or Paused.')}` : ''}</Notice>
          )}
          {hasMeta && !demoMode && budget && original?.meta_status === 'APPROVED' && (
            <p className="text-sm text-ink-50">{L('Edits sent to Meta')}: {budget.last_24h}/1 {L('today')}, {budget.last_30d}/10 {L('in 30 days')}.{budget.limited && budget.next_allowed_at ? ` ${L('Next edit allowed after')} ${new Date(budget.next_allowed_at).toLocaleString('en-GB')}.` : ''}</p>
          )}
          {hasMeta && <p className="text-sm text-ink-50">{L('This template is edited in place on Meta, so it keeps its name and ID.')}</p>}
          {error && <ErrorNote>{error}</ErrorNote>}
          {info && <Notice>{info}</Notice>}
          <div className="flex  flex-wrap items-center gap-4">
            {canEdit && <button className="btn" disabled={busy}>{L('Save')}</button>}
            <Link to="/templates" className="btn btn-quiet">{t('cancel')}</Link>
          </div>
          {!isNew && contentChanged && !archived && canEdit && (
            <div className="card">
              <p className="text-ink">{L('You have unsaved changes. Click Save first, then the next step (Submit to Meta or Approve) will appear here.')}</p>
            </div>
          )}
          {!isNew && !contentChanged && !archived && (
            <div className="card space-y-3">
              <p className="text-ink">{nextText}</p>
              <div className="flex flex-wrap items-center gap-3">
                {st === 'DRAFT' && can('template.submit', entityId) && (
                  <button type="button" className="btn btn-quiet" disabled={busy || metaBlocksEdit || (!demoMode && !!budget?.limited)} onClick={submitToMeta}>
                    {hasMeta ? L('Send changes to Meta') : L('Submit to Meta')}
                  </button>
                )}
                {st === 'DRAFT' && !can('template.submit', entityId) && can('template.update', entityId) && (
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => lifecycle('PENDING_APPROVAL')}>{L('Request approval')}</button>
                )}
                {st === 'PENDING_APPROVAL' && !original!.meta_submitted_at && can('template.submit', entityId) && (
                  <button type="button" className="btn btn-quiet" disabled={busy || metaBlocksEdit || (!demoMode && !!budget?.limited)} onClick={submitToMeta}>
                    {hasMeta ? L('Send changes to Meta') : L('Submit to Meta')}
                  </button>
                )}
                {st === 'PENDING_APPROVAL' && !original!.meta_submitted_at && can('template.update', entityId) && (
                  <button type="button" className="link-btn" onClick={() => lifecycle('DRAFT')}>{L('Withdraw request')}</button>
                )}
                {st === 'REJECTED' && can('template.update', entityId) && (
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => lifecycle('DRAFT')}>{L('Back to draft')}</button>
                )}
                {demoMode && st === 'PENDING_APPROVAL' && original!.meta_submitted_at && can('template.submit', entityId) && (
                  <>
                    <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => lifecycle('APPROVED')}>{L('Approve (demo)')}</button>
                    <button type="button" className="link-btn" onClick={() => lifecycle('REJECTED')}>{L('Reject (demo)')}</button>
                  </>
                )}
              </div>
            </div>
          )}
          {!isNew && <p className="text-sm text-ink-50">{t('version')} {original!.version}. {t('editNote')}</p>}
        </form>

        <aside aria-label={t('preview')} className="xl:sticky xl:top-12 self-start">
          <h3 className="mb-1">{t('preview')}</h3>
          <p className="text-sm text-ink-50 mb-4">{t('previewNote')}</p>
          <PhonePreview header={fillText(header, examples) || null} body={fillText(body, examples)} footer={footer || null} buttons={buttons} dir={dir} />
          {extractVars(body).length > 0 && (
            <p className="text-sm text-ink-50 mt-4 max-w-[300px]">{L('Variables found')}: {names.map((n) => `{{${n}}}`).join(' ')}</p>
          )}
        </aside>
      </div>
    </>
  )
}
