import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { callFunction } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  BUILTIN_FIELDS, templateVarNames,
  type Category, type MediaAsset, type OwnerField, type TButton, type Template, type TemplateVar, type TStatus,
} from '../lib/types'
import { EntityFilter, ErrorNote, Field, Loading, Notice, PageHead, PhonePreview, StatusLabel, entityScope, fmtDate } from '../components/ui'
import type { PreviewProps } from '../components/PhonePreview'
import ValidationSummary, { FieldIssues, StatusChip, focusField } from '../components/templates/ValidationSummary'
import ButtonsEditor from '../components/templates/ButtonsEditor'
import AuthBuilder from '../components/templates/AuthBuilder'
import SubmitReview from '../components/templates/SubmitReview'
import { buildPreview } from '../lib/templatePreview'
import { planCategorySwitch } from '../lib/categorySwitch'
import {
  AUTH_BODY, RULES, categoryNotes, defaultAuth, hasErrors, langCode, statusOf, validateTemplate,
  type AuthOptions, type Issue, type TemplateDraft,
} from '../../supabase/functions/_shared/templateRules'
import { Modal, useDialog } from '../components/Dialog'
import Select from '../components/Select'
import MediaPicker, { mediaUrl } from '../components/MediaPicker'

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

const emptyAside = () => ({ header: '', body: '', footer: '', buttons: [] as TButton[], media: null as MediaAsset | null })
type Aside = ReturnType<typeof emptyAside>

export function TemplateEditor() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const { t, L } = useI18n()
  const { prompt, confirm } = useDialog()
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
  const [media, setMedia] = useState<MediaAsset | null>(null)
  const [auth, setAuth] = useState<AuthOptions>(defaultAuth())
  const [aside, setAside] = useState<Aside | null>(null)   // what an Authentication switch set aside, so switching back loses nothing
  const [vars, setVars] = useState<TemplateVar[]>([])
  const [custom, setCustom] = useState<OwnerField[]>([])
  const [sample, setSample] = useState<Record<string, string>>({})
  const [conns, setConns] = useState<Record<string, string>>({})
  const [others, setOthers] = useState<string[]>([])
  const [budget, setBudget] = useState<{ last_24h: number; last_30d: number; limited: boolean; next_allowed_at: string | null } | null>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(isNew)
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const [attempted, setAttempted] = useState(false)
  const [wide, setWide] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [review, setReview] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)   // the category requirements popup
  const [reviewError, setReviewError] = useState('')
  const submitLock = useRef(false)

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
        setAuth({ ...defaultAuth(), ...(r.auth_options ?? {}) })
        if (r.header_text || r.footer_text || r.buttons?.length) setMoreOpen(true)
        if (r.header_media_id) supabase.from('media_assets').select('*').eq('id', r.header_media_id).maybeSingle().then(({ data }) => setMedia((data as MediaAsset) ?? null))
        if (r.meta_template_id) supabase.rpc('template_edit_budget', { p_template: r.id }).then(({ data }) => setBudget(data as typeof budget))
      }
      setLoaded(true)
    })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // owner fields come from the imported owner data; the first real owner supplies the examples Meta asks for
  useEffect(() => {
    if (!entityId) return
    ;(async () => {
      const [f, o, n] = await Promise.all([
        supabase.from('owner_fields').select('key, label, example').eq('entity_id', entityId).order('label'),
        supabase.from('project_owners').select('unit_no, owners(full_name, phone, email), projects!inner(name, code, entity_id)').eq('projects.entity_id', entityId).limit(1),
        supabase.from('whatsapp_templates').select('id, name').eq('entity_id', entityId).neq('status', 'ARCHIVED'),
      ])
      setCustom(((f.data as { key: string; label: string; example: string }[]) ?? []).map((x) => ({ ...x, builtin: false })))
      setOthers(((n.data as { id: string; name: string }[]) ?? []).filter((x) => x.id !== id).map((x) => x.name))
      const row = ((o.data as unknown as { unit_no: string | null; owners: { full_name: string; phone: string; email: string | null }; projects: { name: string; code: string } }[]) ?? [])[0]
      setSample(row ? {
        owner_name: row.owners.full_name, unit_number: row.unit_no ?? '', phone: row.owners.phone, email: row.owners.email ?? '',
      } : {})
    })()
  }, [entityId, id])
  const entityLabel = entities.find((e) => e.id === entityId)?.name ?? ''
  const fields: OwnerField[] = useMemo(() => [
    ...BUILTIN_FIELDS.map((b) => ({ key: b.key, label: L(b.label), example: (b.key === 'entity_name' || b.key === 'project_name' ? entityLabel : sample[b.key]) || b.example, builtin: true, legacy: b.legacy })),
    ...custom,
  ], [custom, sample, entityLabel, L])
  const fieldMap = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f])), [fields])
  const isAuth = category === 'AUTHENTICATION'
  const positional = !isAuth && original?.parameter_format === 'POSITIONAL' && original.category !== 'AUTHENTICATION'

  // placeholders are read from the message text; examples start from the owner data and can be edited
  const names = useMemo(() => (isAuth ? [] : templateVarNames({ header_text: header, body_text: body })), [isAuth, header, body])
  useEffect(() => {
    setVars((prev) => names.map((n) => {
      const old = prev.find((v) => v.name === n)
      return positional
        ? { name: n, example: old?.example || fieldMap[old?.source ?? '']?.example || 'Sample', source: old?.source ?? '' }
        : { name: n, example: old?.example ?? (fieldMap[n]?.example || 'Sample'), source: n }
    }))
  }, [names, fieldMap, positional])

  const archived = original?.status === 'ARCHIVED'
  const demoMode = conns[entityId] !== 'live'
  const hasMeta = !!original?.meta_template_id
  const metaBlocksEdit = hasMeta && !demoMode && !!original?.meta_status && !['APPROVED', 'REJECTED', 'PAUSED'].includes(original.meta_status)
  const canEdit = isNew ? true : !archived && can('template.update', entityId)
  const examples = useMemo(() => Object.fromEntries(vars.map((v) => [v.name, v.example])), [vars])
  const dir = language === 'ar' ? 'rtl' : 'ltr'

  // one draft feeds the preview, the checks and the payload shown at review, so they cannot drift apart
  const draft: TemplateDraft = useMemo(() => ({
    name, category, language, parameterFormat: isAuth || positional ? 'POSITIONAL' : 'NAMED',
    headerText: header, media: media ? { kind: media.kind, mime: media.mime_type, size: media.size_bytes, uploaded: true } : null,
    body: isAuth ? AUTH_BODY : body, footer, buttons, auth: isAuth ? auth : null, examples,
  }), [name, category, language, isAuth, positional, header, media, body, footer, buttons, auth, examples])
  const issues = useMemo(() => validateTemplate(draft, { existingNames: others, knownFields: positional || isAuth ? undefined : fields.map((f) => f.key) }),
    [draft, others, positional, isAuth, fields])
  const blocked = hasErrors(issues)
  const status = statusOf(issues)

  const touched = useCallback((f: string) => attempted || [...visited].some((v) => v === f || f.startsWith(`${v}.`) || v.startsWith(`${f}.`)), [attempted, visited])
  const show = (f: string) => touched(f)
  const bad = (f: string) => issues.some((i) => i.field === f && i.severity === 'error' && (!i.missing || touched(f)))

  const preview: PreviewProps = useMemo(() => buildPreview({
    category, language, header, body, footer, buttons, auth, examples, businessName: entityLabel, wide,
    media: media ? { kind: media.kind, name: media.name, url: mediaUrl(media.path) } : null,
  }), [category, language, header, body, footer, buttons, auth, examples, entityLabel, wide, media])

  const authChanged = !!original && JSON.stringify({ ...defaultAuth(), ...(original.auth_options ?? {}) }) !== JSON.stringify(auth)
  const contentChanged = !!original && (
    original.name !== name || original.category !== category || original.language !== language || (original.header_text ?? '') !== header
    || (isAuth ? false : original.body_text !== body) || (original.footer_text ?? '') !== footer
    || (original.header_media_id ?? null) !== (media?.id ?? null)
    || JSON.stringify(original.buttons ?? []) !== JSON.stringify(buttons)
    || JSON.stringify(original.variables ?? []) !== JSON.stringify(vars)
    || (isAuth && authChanged))

  async function changeCategory(next: Category) {
    const plan = planCategorySwitch(category, next, { header, body, footer, buttons, hasMedia: !!media })
    if (plan.needsConfirm) {
      const ok = await confirm({
        title: L('Switch to Authentication?'), confirmLabel: L('Switch'),
        message: `${L('Authentication messages use a fixed format set by Meta, so')} ${plan.setAside.map((x) => L(x)).join(', ')} ${L('will be set aside. They come back if you switch back before leaving this page, but saving as Authentication removes them from this template.')}`,
      })
      if (!ok) return
      setAside({ header, body, footer, buttons, media })
    }
    if (next === 'AUTHENTICATION') { setHeader(''); setBody(''); setFooter(''); setButtons([]); setMedia(null) }
    else if (plan.restore && aside && !body.trim()) {
      setHeader(aside.header); setBody(aside.body); setFooter(aside.footer); setButtons(aside.buttons); setMedia(aside.media); setAside(null)
      if (aside.header || aside.footer || aside.buttons.length) setMoreOpen(true)
    }
    setCategory(next)
    setNotesOpen(true)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    // a draft may be unfinished, but it needs a name and must not carry control characters
    if (!name.trim()) { setAttempted(true); setError(L('Give the template a name.')); focusField('name'); return }
    // a button that was added must be filled in: its label, and its link or phone number
    const emptyButton = issues.find((i) => i.missing && i.field.startsWith('buttons.'))
    if (emptyButton) { setAttempted(true); setMoreOpen(true); setError(emptyButton.message); focusField(emptyButton.field); return }
    setBusy(true); setError(''); setInfo('')
    const payload = {
      entity_id: entityId, project_ids: [], name: name.trim(), category, language,
      header_text: isAuth || media ? null : header.trim() || null, header_media_id: isAuth ? null : media?.id ?? null,
      body_text: isAuth ? AUTH_BODY : body, footer_text: isAuth ? null : footer.trim() || null,
      buttons: isAuth ? [] : buttons.filter((b) => b.text.trim()), variables: isAuth ? [] : vars,
      parameter_format: isAuth || positional ? 'POSITIONAL' : 'NAMED',
      // only touched when it matters, so saving Marketing and Utility drafts works before the auth_options migration is applied
      ...(isAuth || original?.auth_options ? { auth_options: isAuth ? auth : null } : {}),
    }
    const res = isNew
      ? await supabase.from('whatsapp_templates').insert(payload).select('id').single()
      : await supabase.from('whatsapp_templates').update(payload).eq('id', id!).select('id').single()
    setBusy(false)
    if (res.error) { setError(res.error.message); return }
    if (isNew) { nav(`/templates/${res.data.id}`, { replace: true }); return }
    await reloadOriginal()
    setAside(null)
    setInfo(L('Draft saved. Use the next step below.'))
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

  function openReview() {
    setAttempted(true); setReviewError('')
    if (hasErrors(issues)) { const first = issues.find((i) => i.severity === 'error'); if (first) focusField(first.field); return }
    setReview(true)
  }

  async function submitToMeta() {
    if (submitLock.current) return           // a double click or a retry while one request is still running must not send twice
    submitLock.current = true
    setBusy(true); setReviewError(''); setError(''); setInfo('')
    try {
      await callFunction('submit-whatsapp-template', { template_id: id })
      setReview(false)
      setInfo(L('Sent to Meta. The status is Pending until Meta replies, and updates automatically.'))
      await reloadOriginal()
    } catch (e) {
      const issuesFromServer = ((e as { issues?: Issue[] }).issues ?? []).filter((i) => i.severity === 'error').map((i) => `• ${i.message}`)
      setReviewError([(e as Error).message, ...issuesFromServer].join('\n'))
    }
    setBusy(false)
    submitLock.current = false
  }

  if (!loaded) return <Loading />
  if (!isNew && !original) return <Notice>{t('error')}</Notice>

  const st = original?.status
  const nextText = st === 'DRAFT'
    ? (can('template.submit', entityId)
        ? (hasMeta ? L('Your changes are saved here. Send them to Meta so they can be reviewed.') : L('Ready? Check the template, then send it to Meta for approval.'))
        : L('Ask an admin to approve this template so it can be sent.'))
    : st === 'PENDING_APPROVAL'
      ? (original?.meta_submitted_at ? L('Waiting for Meta to review. This usually takes a few minutes to a day.') : L('Waiting for an admin to send this to Meta.'))
      : st === 'REJECTED' ? L('Meta rejected this template. Edit it, then send it again.')
      : st === 'APPROVED' ? L('Approved by Meta. You can send this message from Send messages.') : ''
  const submitDisabled = busy || metaBlocksEdit || (!demoMode && !!budget?.limited) || blocked
  const submitButton = (
    <>
      <button type="button" className="btn btn-quiet" disabled={submitDisabled} aria-describedby={blocked ? 'submit-hint' : undefined} onClick={openReview}>
        {hasMeta ? L('Send changes to Meta') : L('Submit to Meta')}
      </button>
      {blocked && <span id="submit-hint" className="text-sm text-bad">{L('Fix the problems listed under Template check first.')}</span>}
    </>
  )
  const notes = categoryNotes(category)
  const issuesIn = (...fs: string[]) => issues.some((i) => fs.some((f) => i.field === f || i.field.startsWith(`${f}.`)))
  const fieldErrors = (f: string) => <FieldIssues issues={issues} field={f} show={show(f)} />

  return (
    <>
      <PageHead title={isNew ? t('newTemplate') : original!.name}>
        {!isNew && <StatusLabel value={original!.status} />}
      </PageHead>
      {original?.status === 'REJECTED' && original.rejection_reason && <ErrorNote>{L('Rejected')}: {original.rejection_reason}</ErrorNote>}
      {original?.meta_name && <p className="text-sm text-ink-50 mb-4">{L('Meta template name')}: <span className="text-ink" dir="ltr">{original.meta_name}</span></p>}

      <div className="grid xl:grid-cols-[3fr_2fr] gap-10 xl:gap-16">
        <form onSubmit={save} noValidate className="space-y-6 min-w-0"
          onBlur={(e) => { const f = (e.target as HTMLElement).closest?.('[data-field]')?.getAttribute('data-field'); if (f) setVisited((p) => (p.has(f) ? p : new Set(p).add(f))) }}>
          <fieldset disabled={!canEdit} className="border-0 p-0 m-0 space-y-6 min-w-0">
            <div className="grid sm:grid-cols-2 gap-6">
              <Field label={t('entity')}>
                <Select required value={entityId} disabled={!isNew} onChange={(e) => { setEntityId(e.target.value); setMedia(null) }}>
                  {(isNew ? creatable : entities).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
              </Field>
              <div>
                <Field label={t('name')}><input data-field="name" aria-invalid={bad('name')} aria-describedby="issues-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
                {fieldErrors('name')}
              </div>
              <div>
                <Field label={L('Category')} hint={original?.meta_approved_once ? L('Meta does not allow changing the category after approval.') : undefined}>
                  <Select data-field="category" value={category} disabled={!!original?.meta_approved_once} onChange={(e) => changeCategory(e.target.value as Category)}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{L(cap(c))}</option>)}
                  </Select>
                </Field>
                {fieldErrors('category')}
              </div>
              <div>
                <Field label={t('language_')} hint={`${L('Sent to Meta as')} ${langCode(language)}`}>
                  <Select data-field="language" value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'ar')}>
                    <option value="en">English</option><option value="ar">العربية</option>
                  </Select>
                </Field>
                {fieldErrors('language')}
              </div>
            </div>
            {notes.length > 0 && (
              <div className="-mt-2">
                <button type="button" className="link-btn text-sm" onClick={() => setNotesOpen(true)}>ⓘ {L('Requirements for')} {L(cap(category))} {L('templates')}</button>
              </div>
            )}

            {isAuth ? (
              <AuthBuilder value={auth} onChange={setAuth} issues={issues} touched={touched} />
            ) : (
              <>
                <div>
                  <Field label={`${L('Message')} (${body.length}/${RULES.bodyMax})`} hint={L('Format with *bold*, _italic_, ~strikethrough~ and ```monospace```.')}>
                    <textarea data-field="body" aria-invalid={bad('body')} aria-describedby="issues-body" value={body} onChange={(e) => setBody(e.target.value)} dir={dir} rows={6} />
                  </Field>
                  {fieldErrors('body')}
                </div>
                <section className="card" data-field="media" tabIndex={-1}>
                  <h3 className="mb-1">{L('Image or video')} <span className="text-ink-50 text-sm font-normal">({L('optional')})</span></h3>
                  <p className="text-sm text-ink-50 mb-3">{L('Shown above the message. Pick one saved by your company, or upload a new one to save it for everyone.')}</p>
                  <MediaPicker entityId={entityId} value={media?.id ?? null} onChange={(a) => { setMedia(a); if (a) setHeader('') }} canRemove={can('template.update', entityId)} />
                  {media && <p className="text-sm text-ink-50 mt-3">{L('Meta reviews the file when you submit the template. Changing it needs approval again.')}</p>}
                  <FieldIssues issues={issues} field="media" show />
                </section>
                {vars.length > 0 && (
                  <section className="card">
                    <h3 className="mb-1">{L('Fields in this message')}</h3>
                    <p className="text-sm text-ink-50 mb-3">{L('Meta reviews a template using an example for each field. The examples start from your owner data and show in the preview. Changing one does not change the message.')}</p>
                    <ul className="space-y-2">
                      {vars.map((v, i) => (
                        <li key={v.name} className="bg-paper rounded-xl px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="text-ink-50" dir="ltr">{`{{${v.name}}}`}</span>
                            {positional && (
                              <label className="field flex-1 min-w-48"><span className="sr-only">{L('Filled from')}</span>
                                <Select value={v.source} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, source: e.target.value, example: fieldMap[e.target.value]?.example ?? x.example } : x)))}>
                                  <option value="">{L('Choose the field that fills this')}</option>
                                  {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                                </Select>
                              </label>
                            )}
                            {!positional && <span className="text-ink font-medium">{fieldMap[v.name]?.label ?? v.name}</span>}
                            <label className="flex items-center gap-2 flex-1 min-w-48">
                              <span className="text-ink-50 text-sm whitespace-nowrap">{L('Example')}</span>
                              <input data-field={`examples.${v.name}`} aria-invalid={bad(`examples.${v.name}`)} value={v.example} dir={dir} onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, example: e.target.value } : x)))} />
                            </label>
                          </div>
                          <FieldIssues issues={issues} field={`examples.${v.name}`} show={show(`examples.${v.name}`)} />
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <details className="card" open={moreOpen || issuesIn('header', 'footer', 'buttons')} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
                  <summary className="font-medium text-ink">{L('More options')} <span className="text-ink-50 font-normal text-sm">({L('header, footer, buttons')})</span></summary>
                  <div className="space-y-6 mt-5 bordered-fields">
                    <div>
                      <Field label={`${L('Header')} (${header.length}/${RULES.headerTextMax})`} hint={media ? L('Not used while the message has an image or video.') : L('Optional. A short title.')}>
                        <input data-field="header" aria-invalid={bad('header')} value={header} disabled={!!media} onChange={(e) => setHeader(e.target.value)} dir={dir} />
                      </Field>
                      {fieldErrors('header')}
                    </div>
                    <div>
                      <Field label={`${L('Footer')} (${footer.length}/${RULES.footerMax})`}>
                        <input data-field="footer" aria-invalid={bad('footer')} value={footer} onChange={(e) => setFooter(e.target.value)} dir={dir} />
                      </Field>
                      {fieldErrors('footer')}
                    </div>
                    <ButtonsEditor buttons={buttons} onChange={setButtons} category={category} issues={issues} touched={touched} />
                  </div>
                </details>
              </>
            )}
          </fieldset>

          <ValidationSummary issues={issues} attempted={attempted} />

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
          <div className="flex flex-wrap items-center gap-4 mt-6">
            {canEdit && <button className="btn" disabled={busy}>{isNew || st === 'DRAFT' || st === 'REJECTED' ? L('Save draft') : L('Save')}</button>}
            <Link to="/templates" className="btn btn-quiet">{t('cancel')}</Link>
          </div>
          {!isNew && contentChanged && !archived && canEdit && (
            <div className="card">
              <p className="text-ink">{L('You have unsaved changes. Save the draft first, then the next step (Submit to Meta or Approve) will appear here.')}</p>
            </div>
          )}
          {!isNew && !contentChanged && !archived && (
            <div className="card space-y-3">
              <p className="text-ink">{nextText}</p>
              <div className="flex flex-wrap items-center gap-3">
                {st === 'DRAFT' && can('template.submit', entityId) && submitButton}
                {st === 'DRAFT' && !can('template.submit', entityId) && can('template.update', entityId) && (
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => lifecycle('PENDING_APPROVAL')}>{L('Request approval')}</button>
                )}
                {st === 'PENDING_APPROVAL' && !original!.meta_submitted_at && can('template.submit', entityId) && submitButton}
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

        <aside aria-label={t('preview')} className="xl:sticky xl:top-12 self-start min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
            <h3>{t('preview')}</h3>
            <div className="tabs" role="group" aria-label={L('Preview size')}>
              <button type="button" className="tab" aria-pressed={!wide} onClick={() => setWide(false)}>{L('Phone')}</button>
              <button type="button" className="tab" aria-pressed={wide} onClick={() => setWide(true)}>{L('Wide')}</button>
            </div>
          </div>
          <p className="text-sm text-ink-50 mb-4">{t('previewNote')}</p>
          <PhonePreview {...preview} placeholder={L('Your message appears here as you type.')} />
          <p className="text-sm text-ink-50 mt-4 max-w-[300px]"><StatusChip status={status} /></p>
        </aside>
      </div>
      {notesOpen && notes.length > 0 && (
        <Modal title={`${L(cap(category))} ${L('template requirements')}`} onClose={() => setNotesOpen(false)}>
          <ul className="space-y-3 list-disc ps-5 text-ink-75">{notes.map((n) => <li key={n}>{L(n)}</li>)}</ul>
          <div className="flex justify-end mt-6"><button type="button" className="btn" onClick={() => setNotesOpen(false)}>{L('Got it')}</button></div>
        </Modal>
      )}
      {review && (
        <SubmitReview draft={draft} issues={issues} preview={preview} busy={busy} error={reviewError} edit={hasMeta} onSubmit={submitToMeta} onClose={() => { if (!busy) setReview(false) }} />
      )}
    </>
  )
}
