import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { callFunction, fetchAll } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  BUILTIN_FIELDS, buildPayload, fieldKeyOf, fillText, isSendable, maskPhone, normalizePhone, templateVarNames,
  type MessageLog, type MsgStatus, type Preflight, type SendAllowance, type Project, type ProjectOwner, type Template,
} from '../lib/types'
import { ErrorNote, Field, Loading, Notice, PageHead, PhonePreview, StatusLabel, Tip } from '../components/ui'
import ScheduledSends, { repeatText, toLocalInput, whenText, zoneName, type Repeat } from '../components/ScheduledSends'
import Select from '../components/Select'
import { Modal } from '../components/Dialog'
import { mediaUrl } from '../components/MediaPicker'

type StepId = 'what' | 'who' | 'review'
type DupGroup = { phone: string; members: ProjectOwner[] }   // clients that share one phone number
type DupMode = 'each' | 'one' | 'combine'                      // one message per entry, only one entry, or all entries in one message

const DUP_MODE_LABEL: Record<DupMode, (L: (s: string) => string) => string> = {
  each: (L) => L('Send each separately'), one: (L) => L('Send only one'), combine: (L) => L('Combine into one message'),
}
const DUP_MODE_HINT: Record<DupMode, (L: (s: string) => string, n: number) => string> = {
  each: (L, n) => `${n} ${L('messages, each with its own data')}`, one: (L) => L('1 message, you pick which entry'), combine: (L) => L('1 message with every value, such as all units'),
}

export default function SendPage() {
  const { t, L } = useI18n()
  const { can, entities, projectAllowed, templateAllowed } = useAuth()
  const [step, setStep] = useState<StepId>('what')
  const [lists, setLists] = useState<Project[] | null>(null)          // one client list per entity
  const [templates, setTemplates] = useState<Template[]>([])
  const [conns, setConns] = useState<Record<string, { display_phone: string | null; connected: boolean; mode: string }>>({})
  const [entityId, setEntityId] = useState('')
  const [template, setTemplate] = useState<Template | null>(null)
  const [headerMedia, setHeaderMedia] = useState<{ kind: 'IMAGE' | 'VIDEO'; url: string } | null>(null)
  const [tq, setTq] = useState('')
  const [fieldLabels, setFieldLabels] = useState<Record<string, string>>({})
  const [owners, setOwners] = useState<ProjectOwner[]>([])
  const [optouts, setOptouts] = useState<Set<string>>(new Set())
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  const [memberMap, setMemberMap] = useState<Record<string, Set<string>>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set(['ALL']))   // 'ALL' or group ids
  const [gq, setGq] = useState('')
  const [previewId, setPreviewId] = useState('')
  const [busy, setBusy] = useState(false)
  const sendLock = useRef(false)
  const requestId = useRef<string | null>(null)
  const [error, setError] = useState('')
  const [batchId, setBatchId] = useState<string | null>(null)
  const [pre, setPre] = useState<Preflight | null>(null)
  const [allow, setAllow] = useState<SendAllowance | null>(null)
  const [preError, setPreError] = useState('')
  const [when, setWhen] = useState<'now' | 'later'>('now')
  const [runAt, setRunAt] = useState('')                       // the date and time picked, in the person's own time zone
  const [repeat, setRepeat] = useState<Repeat>('none')
  const [ends, setEnds] = useState<'never' | 'on'>('never')
  const [endDate, setEndDate] = useState('')
  const [scheduledAt, setScheduledAt] = useState<string | null>(null)   // set once a schedule is saved
  const [scheduledSummary, setScheduledSummary] = useState('')
  const [schedOpen, setSchedOpen] = useState(false)
  const [schedCount, setSchedCount] = useState(0)
  const [choices, setChoices] = useState<Record<string, string>>({})   // phone number -> the client who gets the message
  const [modes, setModes] = useState<Record<string, DupMode>>({})      // phone number -> what to do with its entries
  const [dupAsk, setDupAsk] = useState(false)
  const [resolvedSig, setResolvedSig] = useState('')                  // the duplicates the person has already decided on

  const list = lists?.find((l) => l.entity_id === entityId) ?? null
  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? ''

  const loadList = useCallback(async (l: Project) => {
    setSelected(new Set()); setTemplate(null); setError('')
    const [all, oo, fd, gl] = await Promise.all([
      fetchAll<ProjectOwner>((from, to) => supabase.from('project_owners')
        .select('unit_no, extra, owners(id, full_name, phone, email, whatsapp_opt_in, status)').eq('project_id', l.id).order('owner_id').range(from, to)),
      supabase.from('owner_optouts').select('owner_id').eq('entity_id', l.entity_id),
      supabase.from('owner_fields').select('key, label').eq('entity_id', l.entity_id),
      supabase.from('client_lists').select('id, name').eq('entity_id', l.entity_id).order('name'),
    ])
    setOwners(all.sort((a, b) => a.owners.full_name.localeCompare(b.owners.full_name)))
    setOptouts(new Set(((oo.data as { owner_id: string }[]) ?? []).map((x) => x.owner_id)))
    setFieldLabels({
      ...Object.fromEntries(BUILTIN_FIELDS.map((b) => [b.key, L(b.label)])),
      ...Object.fromEntries(((fd.data as { key: string; label: string }[]) ?? []).map((f) => [f.key, f.label])),
    })
    const gs = (gl.data as { id: string; name: string }[]) ?? []
    setGroups(gs)
    if (!gs.length) setSelected(new Set(['ALL']))   // a list with no groups yet can only be sent as a whole
    const map: Record<string, Set<string>> = {}
    if (gs.length) {
      const rows = await fetchAll<{ list_id: string; owner_id: string }>((from, to) => supabase.from('client_list_members')
        .select('list_id, owner_id').in('list_id', gs.map((g) => g.id)).order('owner_id').range(from, to))
      rows.forEach((r) => { (map[r.list_id] ??= new Set()).add(r.owner_id) })
    }
    setMemberMap(map)
  }, [L])

  useEffect(() => {
    (async () => {
      const [p, tp, m] = await Promise.all([
        supabase.from('projects').select('*').eq('is_default', true),
        supabase.from('whatsapp_templates').select('*').neq('status', 'ARCHIVED').order('name'),
        supabase.rpc('entity_connections'),
      ])
      const ls = ((p.data as Project[]) ?? []).filter((x) => can('message.send', x.entity_id) && projectAllowed(x))
      setLists(ls)
      setTemplates(((tp.data as Template[]) ?? []).filter(templateAllowed))
      setConns(Object.fromEntries(((m.data as { entity_id: string; display_phone: string | null; connected: boolean; mode: string }[]) ?? []).map((c) => [c.entity_id, c])))
      if (ls.length) { setEntityId(ls[0].entity_id); loadList(ls[0]) }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function chooseEntity(id: string) {
    setEntityId(id)
    const l = lists?.find((x) => x.entity_id === id)
    if (l) loadList(l)
  }

  const loadSchedCount = useCallback(() => {
    supabase.from('scheduled_sends').select('id', { count: 'exact', head: true }).eq('status', 'scheduled').then(({ count }) => setSchedCount(count ?? 0))
  }, [])
  useEffect(() => { loadSchedCount() }, [loadSchedCount])

  // quick choices, worked out from the current time each time "Schedule for later" is opened
  const presets = useMemo(() => {
    const now = new Date()
    const at = (days: number, hour: number) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d }
    const list = [{ label: L('In 1 hour'), date: new Date(now.getTime() + 3600_000) }]
    const tonight = at(0, 20)
    if (tonight.getTime() > now.getTime() + 10 * 60_000) list.push({ label: L('Tonight 8 PM'), date: tonight })
    list.push({ label: L('Tomorrow 9 AM'), date: at(1, 9) }, { label: L('Tomorrow 6 PM'), date: at(1, 18) })
    return list
  }, [when]) // eslint-disable-line react-hooks/exhaustive-deps
  const runAtValid = !!runAt && new Date(runAt).getTime() >= Date.now() + 90_000
  // a repeat can stop on a chosen day (the end of that day, in the person's time zone)
  const untilISO = repeat !== 'none' && ends === 'on' && endDate ? new Date(`${endDate}T23:59:59`).toISOString() : null
  const repeatValid = repeat === 'none' || ends === 'never' || (!!untilISO && !!runAt && new Date(untilISO).getTime() > new Date(runAt).getTime())

  const steps: StepId[] = ['what', 'who', 'review']
  const stepLabels: Record<StepId, string> = { what: L('Choose a list and a message'), who: L('Recipients'), review: L('Review') }

  const sendable = (o: ProjectOwner) => o.owners.whatsapp_opt_in && o.owners.status === 'active' && !optouts.has(o.owners.id)
  const eligible = owners.filter(sendable)
  const picked = useMemo(() => {
    const ids = new Set<string>()
    eligible.forEach((o) => { if (selected.has('ALL') || [...selected].some((g) => memberMap[g]?.has(o.owners.id))) ids.add(o.owners.id) })
    return ids
  }, [owners, optouts, selected, memberMap]) // eslint-disable-line react-hooks/exhaustive-deps
  const groupClients = (id: string) => owners.filter((o) => memberMap[id]?.has(o.owners.id))
  const toggleGroup = (id: string) => {
    const next = new Set(selected)
    if (id === 'ALL') { setSelected(new Set(['ALL'])); return }
    next.delete('ALL')
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  // every value comes from the client's own data: built-in fields first, then the columns imported from their file
  const ownValues = useCallback((o: ProjectOwner): Record<string, string> => {
    if (!list || !template) return {}
    const data: Record<string, string> = {
      ...(o.extra ?? {}),
      owner_name: o.owners.full_name, unit_number: o.unit_no ?? '', phone: o.owners.phone, email: o.owners.email ?? '',
      project_name: list.name, project_code: list.code, entity_name: entityName(list.entity_id),
    }
    return Object.fromEntries(templateVarNames(template).map((n) => [n, String(data[fieldKeyOf(template.variables?.find((v) => v.name === n), n)] ?? '').trim()]))
  }, [list, template]) // eslint-disable-line react-hooks/exhaustive-deps

  // A number that appears more than once in the selection is one person. The person chooses what happens to its entries:
  // one message per entry, only one entry, or every entry combined into one message (for example two units in one text).
  const hasAllData = useCallback((o: ProjectOwner) => {
    if (!template) return true
    const vals = ownValues(o)
    return templateVarNames(template).every((n) => vals[n])
  }, [template, ownValues])
  const duplicateGroups = useMemo<DupGroup[]>(() => {
    const byPhone = new Map<string, ProjectOwner[]>()
    owners.filter((o) => picked.has(o.owners.id)).forEach((o) => {
      const phone = normalizePhone(o.owners.phone)
      byPhone.set(phone, [...(byPhone.get(phone) ?? []), o])
    })
    return [...byPhone].filter(([, m]) => m.length > 1).map(([phone, members]) => ({ phone, members }))
  }, [owners, picked])
  // the entry that is kept, or that carries the combined message: the one with all the data the message needs, unless the person picks
  const chosenFor = (g: DupGroup) => (g.members.some((m) => m.owners.id === choices[g.phone]) ? choices[g.phone] : (g.members.find(hasAllData) ?? g.members[0]).owners.id)
  // entries that differ in what the message shows (two units) default to one message each; identical entries default to one message
  const differs = (g: DupGroup) => new Set(g.members.map((m) => JSON.stringify(ownValues(m)))).size > 1
  const modeFor = (g: DupGroup): DupMode => modes[g.phone] ?? (differs(g) ? 'each' : 'one')
  const excluded = useMemo(
    () => new Set(duplicateGroups.flatMap((g) => (modeFor(g) === 'each' ? [] : g.members.map((m) => m.owners.id).filter((id) => id !== chosenFor(g))))),
    [duplicateGroups, choices, modes, hasAllData], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const merged = useMemo(() => {
    const out: Record<string, string[]> = {}   // the entry that carries the message -> the entries combined into it
    duplicateGroups.filter((g) => modeFor(g) === 'combine').forEach((g) => { out[chosenFor(g)] = g.members.map((m) => m.owners.id).filter((id) => id !== chosenFor(g)) })
    return out
  }, [duplicateGroups, choices, modes, hasAllData]) // eslint-disable-line react-hooks/exhaustive-deps
  const eachPhones = () => duplicateGroups.filter((g) => modeFor(g) === 'each').map((g) => g.phone.replace(/\D/g, ''))
  // what the message will show for a client: its own values, or every distinct value when entries are combined
  const valuesFor = useCallback((o: ProjectOwner): Record<string, string> => {
    const own = ownValues(o)
    const others = (merged[o.owners.id] ?? []).map((id) => owners.find((x) => x.owners.id === id)).filter(Boolean) as ProjectOwner[]
    if (!others.length) return own
    return Object.fromEntries(Object.keys(own).map((n) => [n, [...new Set([own, ...others.map(ownValues)].map((v) => v[n]).filter(Boolean))].join(', ')]))
  }, [ownValues, merged, owners])
  const dupSig = `${template?.id ?? ''}|${duplicateGroups.map((g) => `${g.phone}:${g.members.map((m) => m.owners.id).join(',')}`).join('|')}`
  const finalIds = () => [...picked].filter((id) => !excluded.has(id))

  const missingInfo = useMemo(() => {
    if (!template) return { owners: 0, fields: [] as string[] }
    const keys = templateVarNames(template).map((n) => [n, fieldKeyOf(template.variables?.find((v) => v.name === n), n)] as const)
    const lacking = new Set<string>()
    let count = 0
    owners.filter((o) => picked.has(o.owners.id) && !excluded.has(o.owners.id)).forEach((o) => {
      const vals = valuesFor(o)
      const miss = keys.filter(([n]) => !vals[n])
      if (miss.length) { count += 1; miss.forEach(([, k]) => lacking.add(fieldLabels[k] ?? k.replace(/_/g, ' '))) }
    })
    return { owners: count, fields: [...lacking] }
  }, [owners, picked, excluded, template, valuesFor, fieldLabels])

  const previewOwner = owners.find((o) => o.owners.id === (previewId || [...picked][0]))
  const previewValues = previewOwner ? valuesFor(previewOwner) : {}
  // a template with an image or video header shows that file in the preview and carries its link in the message
  useEffect(() => {
    setHeaderMedia(null)
    if (!template?.header_media_id) return
    let live = true
    supabase.from('media_assets').select('kind, path').eq('id', template.header_media_id).maybeSingle()
      .then(({ data }) => { if (live && data) setHeaderMedia({ kind: data.kind as 'IMAGE' | 'VIDEO', url: mediaUrl(data.path as string) }) })
    return () => { live = false }
  }, [template?.header_media_id])
  const payload = template && previewOwner ? buildPayload(template, previewValues, previewOwner.owners.phone, headerMedia) : null
  const sendCount = picked.size - missingInfo.owners - excluded.size

  async function runPreflight() {
    if (!list) return
    setPre(null); setPreError(''); setAllow(null)
    supabase.rpc('send_allowance', { p_entity: list.entity_id }).then(({ data }) => setAllow((data as SendAllowance) ?? null))
    const { data, error } = await supabase.rpc('dispatch_preflight', { p_project: list.id, p_owner_ids: finalIds() })
    if (error) setPreError(error.message)
    setPre((data as Preflight) ?? null)
  }

  function go(next: StepId) {
    setError('')
    if (next === 'review') { setPreviewId(finalIds()[0] ?? ''); runPreflight() }
    setStep(next)
  }
  const idx = steps.indexOf(step)
  const next = () => go(steps[idx + 1])
  const back = () => go(steps[idx - 1])

  async function send() {
    if (!list || !template || sendLock.current) return   // a second click before the screen updates must not send again
    sendLock.current = true
    setBusy(true); setError('')
    // one id per intended send: if the answer is lost, trying again returns the batch that already exists instead of making a second one
    requestId.current ??= crypto.randomUUID()
    try {
      const res = await callFunction<{ batch_id: string }>('send-whatsapp-template', { request_id: requestId.current, template_id: template.id, project_id: list.id, owner_ids: finalIds(), list_ids: selected.has('ALL') ? [] : [...selected], merge: merged, each_phones: eachPhones() })
      requestId.current = null
      setBatchId(res.batch_id)
    } catch (e) {
      const msg = (e as Error).message
      if (!/failed to send a request|network|timeout|fetch/i.test(msg)) requestId.current = null   // a clear refusal means nothing was sent
      setError(msg)
    }
    sendLock.current = false
    setBusy(false)
  }

  async function scheduleIt() {
    if (!list || !template || !runAtValid || !repeatValid) return
    setBusy(true); setError('')
    const when = new Date(runAt)
    const { error } = await supabase.rpc('schedule_send', {
      p_project: list.id, p_template: template.id, p_list_ids: selected.has('ALL') ? [] : [...selected], p_all: selected.has('ALL'), p_run_at: when.toISOString(),
      p_repeat: repeat, p_until: untilISO, p_timezone: zoneName() || 'UTC',
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    setScheduledSummary(repeat === 'none' ? '' : `${repeatText(repeat, when, L)}${untilISO ? ` · ${L('until')} ${new Date(untilISO).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ` · ${L('until you stop it')}`}`)
    setScheduledAt(when.toISOString()); loadSchedCount()
  }

  function startOver() {
    setScheduledAt(null); setScheduledSummary(''); setStep('what'); setTemplate(null); setWhen('now'); setRunAt(''); setRepeat('none'); setEnds('never'); setEndDate(''); setError(''); setPre(null)
    if (list) loadList(list)
  }

  if (!lists) return <Loading />
  if (batchId) return <Progress batchId={batchId} owners={owners} />
  if (scheduledAt) return (
    <>
      <PageHead title={L('Send messages')} />
      <section className="card max-w-xl">
        <h2 className="mb-1">{L('Scheduled')}</h2>
        <p className="text-ink font-medium">{template?.name}</p>
        <p className="text-ink-75 mb-1">{scheduledSummary ? `${L('First send')}: ` : ''}{whenText(scheduledAt)}</p>
        {scheduledSummary && <p className="text-ink-75 mb-1">{scheduledSummary}</p>}
        <p className="text-sm text-ink-50 mb-5">{L('It goes out within a minute of that time. You can change the time or cancel it from Scheduled messages.')}</p>
        <div className="flex flex-wrap gap-3">
          <button className="btn" onClick={() => setSchedOpen(true)}>{L('Open scheduled messages')}</button>
          <button className="btn btn-quiet" onClick={startOver}>{L('Send another message')}</button>
        </div>
      </section>
      {schedOpen && <ScheduledSends onClose={() => setSchedOpen(false)} onChanged={loadSchedCount} />}
    </>
  )

  const conn = list ? conns[list.entity_id] : undefined
  const sendableEntities = entities.filter((e) => lists.some((l) => l.entity_id === e.id))
  const entityTemplates = templates.filter((x) => x.entity_id === entityId)
    .filter((x) => !tq.trim() || x.name.toLowerCase().includes(tq.toLowerCase()) || x.body_text.toLowerCase().includes(tq.toLowerCase()))
    .sort((a, b) => Number(isSendable(b)) - Number(isSendable(a)) || a.name.localeCompare(b.name))

  /** Plain-language reason a template is locked, shown when someone hovers it. */
  const lockReason = (x: Template): string => {
    if (x.category === 'AUTHENTICATION') return L('Authentication templates carry a one-time code and cannot be sent to owner lists.')
    if (x.status === 'DRAFT') return L('Not submitted yet. Ask an admin to send it to Meta for approval.')
    if (x.status === 'PENDING_APPROVAL') return x.meta_submitted_at ? L('Submitted to Meta and waiting for their review. This usually takes a few minutes to a day.') : L('Waiting for an admin to send it to Meta.')
    if (x.status === 'REJECTED') return `${L('Rejected by Meta')}${x.rejection_reason ? `: ${x.rejection_reason.replace(/\.?\s*$/, '.')}` : '.'} ${L('Edit it and send it again.')}`
    switch (x.meta_status) {
      case 'PAUSED': return L('Paused by Meta because of low read rates or complaints. It cannot be sent right now.')
      case 'DISABLED': return L('Disabled by Meta. Create a new template instead.')
      case 'ARCHIVED': return L('Archived by Meta after a long time without use. It must be unarchived in WhatsApp Manager.')
      case 'PENDING_DELETION': case 'DELETED': return L('Meta is deleting or has deleted this template.')
      case 'IN_APPEAL': return L('Under appeal with Meta.')
      case 'LIMIT_EXCEEDED': return L('The WhatsApp account is over its template limit.')
      default: return L('Not available to send right now.')
    }
  }

  const warningText: Record<string, string> = {
    LIMIT_EXCEEDED: L('This would go over the 24-hour messaging limit, so sending is blocked.'),
    LIMIT_UNKNOWN: L('The messaging limit could not be read, so it is not checked here.'),
    HEALTH_STALE: L('The number health check is more than 6 hours old.'),
    PHONE_NOT_CONNECTED: L('The WhatsApp number is not connected, so sending is blocked.'),
    QUALITY_YELLOW: L('Number quality is Yellow. Too many unwanted messages can lower it.'),
    QUALITY_RED: L('Number quality is Red. Meta may reduce this number’s limit.'),
    TOKEN_CANNOT_SEND: L('The access token cannot send messages, so sending is blocked.'),
  }

  return (
    <>
      <PageHead title={L('Send messages')} sub={L('Pick a client list and a message, choose who gets it, then review before it goes out.')}>
        <button className="btn btn-quiet" onClick={() => setSchedOpen(true)}>{L('Scheduled messages')}{schedCount ? ` (${schedCount})` : ''}</button>
      </PageHead>

      <ol aria-label="Steps" className="flex flex-wrap gap-2 mb-8">
        {steps.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined}>
            <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium ${s === step ? 'bg-ink text-paper' : i < idx ? 'tone-ok' : 'bg-card text-ink-50'}`}>
              <span className="tnum">{i + 1}</span>{stepLabels[s]}
            </span>
          </li>
        ))}
      </ol>
      {error && <ErrorNote>{error}</ErrorNote>}

      {lists.length === 0 && <p>{t('noProjects')}</p>}

      {step === 'what' && lists.length > 0 && (
        <section>
          <div className="flex flex-wrap items-end gap-4 mb-6">
            {sendableEntities.length > 1 ? (
              <div className="w-full sm:w-72">
                <Field label={L('Client list')}>
                  <Select value={entityId} onChange={(e) => chooseEntity(e.target.value)}>
                    {sendableEntities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </Select>
                </Field>
              </div>
            ) : (
              <div><p className="text-sm font-medium text-ink-75 mb-1">{L('Client list')}</p><p className="text-ink font-medium">{entityName(entityId)}</p></div>
            )}
            <div className="w-full sm:w-72 sm:ms-auto">
              <Field label={L('Search messages')}><input value={tq} onChange={(e) => setTq(e.target.value)} placeholder={L('Search by name or text')} /></Field>
            </div>
          </div>

          <h2 className="mb-3">{L('Choose a message')}</h2>
          {entityTemplates.length === 0 ? <p className="text-ink-50">{tq ? L('No message matches your search.') : t('noApproved')}</p> : (
            <ul className="grid min-[880px]:grid-cols-2 gap-3">
              {entityTemplates.map((x) => {
                const ok = isSendable(x)
                const selected = template?.id === x.id
                const card = (
                  <div role="button" tabIndex={0} aria-pressed={selected} aria-disabled={!ok} aria-describedby={ok ? undefined : `tip-${x.id}`}
                    onClick={() => { if (ok) setTemplate(x) }}
                    onKeyDown={(e) => { if (ok && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setTemplate(x) } }}
                    className={`w-full text-start rounded-2xl px-5 py-4 transition-colors outline-offset-2 ${
                      !ok ? 'bg-card opacity-60 cursor-not-allowed' : selected ? 'bg-ink text-paper cursor-pointer' : 'bg-card hover:bg-soft text-ink cursor-pointer'}`}>
                    <span className="flex items-start justify-between gap-3">
                      <span className="font-medium">{x.name}</span>
                      {!ok && <StatusLabel value={x.status === 'APPROVED' && x.meta_status ? x.meta_status : x.status} />}
                    </span>
                    <span className={`block text-sm mt-1 line-clamp-2 ${selected ? 'opacity-80' : 'text-ink-75'}`} dir={x.language === 'ar' ? 'rtl' : 'ltr'}>{x.body_text}</span>
                  </div>
                )
                return <li key={x.id}>{ok ? card : <Tip id={`tip-${x.id}`} text={lockReason(x)}>{card}</Tip>}</li>
              })}
            </ul>
          )}
          <div className="flex items-center gap-4 mt-6">
            <button className="btn" disabled={!list || !template} onClick={next}>{L('Continue')}</button>
            {conn && <span className="text-sm text-ink-50">{L('Sending from')} <span dir="ltr" className="text-ink">{conn.display_phone ?? L('no number connected')}</span> · {conn.mode === 'live' ? L('Live') : L('Demo mode')}</span>}
          </div>
        </section>
      )}

      {step === 'who' && template && (
        <section>
          <h2 className="mb-1">{L('Who should get it?')}</h2>
          <p className="text-ink-50 mb-5 max-w-2xl">{entityName(entityId)} · {template.name}. {L('Choose one or more groups. You do not pick people one by one.')}</p>
          {groups.length > 0 && <div className="max-w-sm mb-4"><Field label={L('Search groups')}><input value={gq} onChange={(e) => setGq(e.target.value)} /></Field></div>}
          <ul className="grid min-[880px]:grid-cols-2 gap-3">
            {groups.length === 0 && <li>
              <label className={`flex items-start gap-3 rounded-2xl px-5 py-4 cursor-pointer transition-colors ${selected.has('ALL') ? 'bg-ink text-paper' : 'bg-card hover:bg-soft text-ink'}`}>
                <input type="checkbox" className="mt-1" checked={selected.has('ALL')} onChange={() => toggleGroup('ALL')} />
                <span>
                  <span className="font-medium block">{L('Everyone in')} {entityName(entityId)}</span>
                  <span className={`text-sm ${selected.has('ALL') ? 'opacity-80' : 'text-ink-75'}`}>{eligible.length} {L('clients can receive messages')}</span>
                </span>
              </label>
            </li>}
            {groups.filter((g) => !gq.trim() || g.name.toLowerCase().includes(gq.toLowerCase())).map((g) => {
              const members = groupClients(g.id)
              const on = selected.has(g.id)
              return (
                <li key={g.id}>
                  <div className={`rounded-2xl px-5 py-4 transition-colors ${on ? 'bg-ink text-paper' : 'bg-card text-ink'}`}>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input type="checkbox" className="mt-1" checked={on} onChange={() => toggleGroup(g.id)} />
                      <span>
                        <span className="font-medium block">{g.name}</span>
                        <span className={`text-sm ${on ? 'opacity-80' : 'text-ink-75'}`}>{members.filter(sendable).length} {L('clients can receive messages')}{members.length !== members.filter(sendable).length ? ` · ${members.length - members.filter(sendable).length} ${L('opted out or inactive')}` : ''}</span>
                      </span>
                    </label>
                    <details className="mt-2 ms-8 text-sm">
                      <summary className="opacity-80">{L('See who is in this group')}</summary>
                      <p className="mt-1 opacity-80">{members.slice(0, 12).map((o) => o.owners.full_name).join(', ')}{members.length > 12 ? ` ${L('and')} ${members.length - 12} ${L('more')}` : ''}</p>
                    </details>
                  </div>
                </li>
              )
            })}
          </ul>
          {groups.length === 0 && <p className="text-sm text-ink-50 mt-4">{L('Groups appear here when you import a file on the Clients page. Each file becomes a group you can pick.')}</p>}

          <p className="mt-6 text-ink"><span className="font-bold text-2xl tnum">{picked.size}</span> {L('clients will receive this message')}</p>
          {picked.size > 2000 && <ErrorNote>{L('You can send to at most 2,000 clients at a time. Choose fewer groups.')}</ErrorNote>}
          {missingInfo.owners > 0 && <Notice tone="warn">{missingInfo.owners} {L('selected clients have no value for')} <strong>{missingInfo.fields.join(', ')}</strong> {L('and will be skipped. Add the missing data on the Clients page, then try again.')} <Link className="link-btn" to="/owners">{L('Open clients')}</Link></Notice>}
          {duplicateGroups.length > 0 && <Notice>{duplicateGroups.length} {L('phone numbers appear more than once in your selection. Each number gets the message only once, and you choose which entry to use.')} <button className="link-btn" onClick={() => setDupAsk(true)}>{L('Choose')}</button></Notice>}
          <div className="flex items-center gap-3 mt-6">
            <button className="btn" disabled={picked.size === 0 || picked.size > 2000} onClick={() => (duplicateGroups.length > 0 && resolvedSig !== dupSig ? setDupAsk(true) : next())}>{L('Continue')}</button>
            <button className="btn btn-quiet" onClick={back}>{L('Back')}</button>
          </div>
        </section>
      )}

      {step === 'review' && template && list && (
        <section className="grid min-[1000px]:grid-cols-[1fr_auto] gap-8 items-start">
          <div className="min-w-0">
            <h2 className="mb-4">{L('Ready to send?')}</h2>
            <dl className="card grid grid-cols-[6.5rem_1fr] sm:grid-cols-[8rem_1fr] gap-y-2.5 mb-5">
              <dt className="text-ink-50">{L('From')}</dt><dd className="text-ink" dir="ltr">{conn?.display_phone ?? L('no number connected')} <span className="text-ink-50">({entityName(list.entity_id)})</span></dd>
              <dt className="text-ink-50">{L('Client list')}</dt><dd className="text-ink">{entityName(list.entity_id)}</dd>
              <dt className="text-ink-50">{L('Message')}</dt><dd className="text-ink">{template.name}</dd>
              <dt className="text-ink-50">{L('Groups')}</dt><dd className="text-ink">{selected.has('ALL') ? `${L('Everyone in')} ${entityName(list.entity_id)}` : groups.filter((g) => selected.has(g.id)).map((g) => g.name).join(', ')}</dd>
              <dt className="text-ink-50">{L('Recipients')}</dt><dd className="text-ink font-medium">{sendCount} {L('clients')}{missingInfo.owners + excluded.size > 0 ? ` (${missingInfo.owners + excluded.size} ${L('skipped')})` : ''}</dd>
            </dl>

            {preError && <ErrorNote>{L('The pre-send check could not run')}: {preError}. {L('The server will still check before sending.')}</ErrorNote>}
            {!pre && !preError && <p className="text-ink-50 mb-4">{L('Checking your connection')}…</p>}
            {pre && pre.mode === 'demo' && <Notice tone="warn">{L('Demo mode: messages are recorded but not sent to WhatsApp.')}</Notice>}
            {pre && pre.mode === 'live' && pre.warnings.length === 0 && <Notice tone="ok">{L('All checks passed.')}</Notice>}
            {pre && pre.mode === 'live' && pre.warnings.map((w) => (
              <p key={w} className={`notice ${['LIMIT_EXCEEDED', 'PHONE_NOT_CONNECTED', 'TOKEN_CANNOT_SEND'].includes(w) ? 'notice-bad' : 'notice-warn'}`}>{warningText[w] ?? w}</p>
            ))}
            {pre && pre.mode === 'live' && allow && allow.limit !== null && (
              <Notice tone={allow.remaining !== null && sendCount > allow.remaining ? 'bad' : 'info'}>
                {allow.reason === 'warmup' ? `${L('Warm-up')}: ${L('day')} ${allow.warmup_day}. ` : ''}{L('Daily limit')}: {allow.used} / {allow.limit} {L('used today')}, {allow.remaining} {L('left')}.
                {allow.remaining !== null && sendCount > allow.remaining ? ` ${L('This send is too big for today. Send to fewer clients, or send the rest tomorrow.')}` : ''}
              </Notice>
            )}
            {pre && pre.mode === 'live' && (
              <p className="text-sm text-ink-50 mb-4">{L('Unique people messaged in the last 24 hours')}: <span className="text-ink tnum">{pre.unique_24h}</span> + {pre.new_unique} {L('new')} / {pre.limit ? (pre.limit >= 1e12 ? L('unlimited') : pre.limit) : L('limit unknown')}</p>
            )}

            <details className="mb-6">
              <summary className="text-sm text-ink-50 mb-2">{L('Show technical details')}</summary>
              <p className="text-sm mb-2 text-ink-75" dir="ltr"><span className="font-bold text-ink">POST</span> /{'{api_version}'}/{'{phone_number_id}'}/messages</p>
              <pre dir="ltr" className="card whitespace-pre-wrap break-all text-xs text-ink leading-relaxed">{JSON.stringify(payload, null, 2)}</pre>
            </details>

            <section className="card mb-5">
              <h3 className="mb-3">{L('When should it go out?')}</h3>
              <div className="grid sm:grid-cols-2 gap-2 mb-1">
                {(['now', 'later'] as const).map((w) => (
                  <label key={w} className={`flex items-start gap-3 rounded-2xl px-4 py-3 cursor-pointer transition-colors ${when === w ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-soft'}`}>
                    <input type="radio" name="when" className="mt-1" checked={when === w} onChange={() => setWhen(w)} />
                    <span>
                      <span className="font-medium block">{w === 'now' ? L('Send now') : L('Schedule for later')}</span>
                      <span className="text-sm opacity-80">{w === 'now' ? L('It goes out as soon as you confirm.') : L('Pick the date and the time.')}</span>
                    </span>
                  </label>
                ))}
              </div>
              {when === 'later' && (
                <div className="space-y-3 mt-4">
                  <div className="flex flex-wrap gap-2">
                    {presets.map((p) => (
                      <button type="button" key={p.label} className={`btn btn-sm ${runAt === toLocalInput(p.date) ? '' : 'btn-quiet'}`} onClick={() => setRunAt(toLocalInput(p.date))}>{p.label}</button>
                    ))}
                  </div>
                  <div className="max-w-xs">
                    <Field label={L('Date and time')}>
                      <input type="datetime-local" value={runAt} min={toLocalInput(new Date(Date.now() + 120_000))} onChange={(e) => setRunAt(e.target.value)} />
                    </Field>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4 max-w-xl">
                    <Field label={L('Repeat')}>
                      <Select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
                        <option value="none">{L('Does not repeat')}</option>
                        <option value="daily">{L('Every day')}</option>
                        <option value="weekly">{runAt ? `${L('Every week on')} ${new Date(runAt).toLocaleDateString(undefined, { weekday: 'long' })}` : L('Every week')}</option>
                      </Select>
                    </Field>
                    {repeat !== 'none' && (
                      <Field label={L('Stops')}>
                        <Select value={ends} onChange={(e) => setEnds(e.target.value as 'never' | 'on')}>
                          <option value="never">{L('Never, until I stop it')}</option>
                          <option value="on">{L('On a date')}</option>
                        </Select>
                      </Field>
                    )}
                    {repeat !== 'none' && ends === 'on' && (
                      <Field label={L('Last day')}>
                        <input type="date" value={endDate} min={runAt ? runAt.slice(0, 10) : undefined} onChange={(e) => setEndDate(e.target.value)} />
                      </Field>
                    )}
                  </div>
                  {runAtValid && repeatValid
                    ? <p className="text-sm text-ink-75">
                        {repeat === 'none'
                          ? <>{L('It will be sent on')} <strong className="text-ink">{whenText(runAt)}</strong></>
                          : <>{L('First send')}: <strong className="text-ink">{whenText(runAt)}</strong>. <strong className="text-ink">{repeatText(repeat, runAt, L)}</strong> {untilISO ? `${L('until')} ${new Date(untilISO).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : L('until you stop it')}</>}
                        {zoneName() ? ` (${zoneName()})` : ''}.
                      </p>
                    : !runAtValid && runAt ? <p className="text-sm text-bad">{L('Choose a time at least a few minutes from now.')}</p>
                    : runAtValid && !repeatValid ? <p className="text-sm text-bad">{L('Choose a last day after the first send.')}</p> : null}
                  <p className="text-sm text-ink-50">{L('The clients are taken from the chosen groups at that moment, so people added to them before then are included. It goes out within a minute of the time.')}</p>
                </div>
              )}
            </section>

            <div className="flex flex-wrap items-center gap-3">
              {when === 'now' ? (
                <button className="btn" disabled={busy || sendCount === 0 || (!pre && !preError) || !!pre?.blocking || (pre?.mode === 'live' && allow?.remaining != null && sendCount > allow.remaining)} onClick={send}>{t('sendTo')} {sendCount} {L('clients')}</button>
              ) : (
                <button className="btn" disabled={busy || sendCount === 0 || !runAtValid || !repeatValid} onClick={scheduleIt}>{repeat === 'none' ? L('Schedule for') : L('Schedule from')} {runAtValid ? whenText(runAt) : '…'}</button>
              )}
              <button className="btn btn-quiet" onClick={back}>{L('Back')}</button>
            </div>
          </div>
          <div>
            <PhonePreview media={headerMedia} header={fillText(template.header_text, previewValues)} body={fillText(template.body_text, previewValues)}
              footer={template.footer_text} buttons={template.buttons} dir={template.language === 'ar' ? 'rtl' : 'ltr'} />
            {picked.size > 1 && (
              <div className="mt-4 max-w-[300px]">
                <Field label={L('Preview for')}>
                  <Select value={previewOwner?.owners.id ?? ''} onChange={(e) => setPreviewId(e.target.value)}>
                    {owners.filter((o) => picked.has(o.owners.id) && !excluded.has(o.owners.id)).map((o) => <option key={o.owners.id} value={o.owners.id}>{o.owners.full_name}</option>)}
                  </Select>
                </Field>
              </div>
            )}
          </div>
        </section>
      )}
      {dupAsk && (
        <Modal title={L('This phone number appears more than once')} size="wide" onClose={() => setDupAsk(false)}>
          <p className="text-ink-75 mb-4">{L('The same phone number is in more than one of the groups or files you selected. Choose what to do with each number.')}</p>
          <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
            <span className="text-ink-50">{L('Apply to all numbers')}:</span>
            {(['each', 'one', 'combine'] as const).map((m) => (
              <button type="button" key={m} className="btn btn-quiet btn-sm" onClick={() => setModes(Object.fromEntries(duplicateGroups.map((g) => [g.phone, m])))}>{DUP_MODE_LABEL[m](L)}</button>
            ))}
          </div>
          <div className="max-h-[50vh] overflow-y-auto space-y-4 mb-5">
            {duplicateGroups.map((g) => {
              const mode = modeFor(g)
              const describe = (m: ProjectOwner) => {
                const o = m.owners
                const from = groups.filter((x) => memberMap[x.id]?.has(o.id)).map((x) => x.name)
                const details = [
                  o.full_name && o.full_name !== o.phone ? o.full_name : '',
                  m.unit_no ? `${L('Unit')} ${m.unit_no}` : '',
                  ...Object.entries(m.extra ?? {}).filter(([, v]) => v).slice(0, 4).map(([k, v]) => `${fieldLabels[k] ?? k.replace(/_/g, ' ')}: ${v}`),
                ].filter(Boolean)
                return (
                  <>
                    <span className="text-ink font-medium">{from.length ? from.join(', ') : L('Client list')}</span>
                    <span className="block text-sm text-ink-50">{details.length ? details.join(' · ') : L('Only the phone number')}</span>
                    {!hasAllData(m) && <span className="block text-sm text-bad">{L('Missing data this message needs')}</span>}
                  </>
                )
              }
              const combined = template && mode === 'combine' ? templateVarNames(template).map((n) => [n, [...new Set(g.members.map((m) => ownValues(m)[n]).filter(Boolean))].join(', ')] as const) : []
              return (
                <fieldset key={g.phone} className="card">
                  <legend className="px-1 text-sm text-ink-50" dir="ltr">{maskPhone(g.phone)} · {g.members.length} {L('entries')}</legend>
                  <div className="grid sm:grid-cols-3 gap-2 mb-3">
                    {(['each', 'one', 'combine'] as const).map((m) => (
                      <label key={m} className={`rounded-xl px-3 py-2 cursor-pointer text-sm transition-colors ${mode === m ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-soft'}`}>
                        <input type="radio" className="me-2" name={`mode-${g.phone}`} checked={mode === m} onChange={() => setModes((c) => ({ ...c, [g.phone]: m }))} />
                        <span className="font-medium">{DUP_MODE_LABEL[m](L)}</span>
                        <span className="block opacity-80 mt-0.5">{DUP_MODE_HINT[m](L, g.members.length)}</span>
                      </label>
                    ))}
                  </div>
                  {g.members.map((m) => (
                    <label key={m.owners.id} className={`flex items-start gap-3 py-1.5 ${mode === 'each' ? '' : 'cursor-pointer'}`}>
                      {mode === 'each'
                        ? <span className="mt-1 text-ink-50" aria-hidden="true">•</span>
                        : <input type="radio" className="mt-1" name={`dup-${g.phone}`} checked={chosenFor(g) === m.owners.id} onChange={() => setChoices((c) => ({ ...c, [g.phone]: m.owners.id }))} />}
                      <span>{describe(m)}</span>
                    </label>
                  ))}
                  {mode === 'one' && <p className="text-sm text-ink-50 mt-1">{L('Choose the entry that gets the message. The others are skipped in this send.')}</p>}
                  {mode === 'combine' && (
                    <div className="text-sm mt-2">
                      <p className="text-ink-50">{L('One message with all the values together. The selected entry is the main one.')}</p>
                      {combined.length > 0 && <p className="text-ink mt-1">{combined.map(([n, v]) => `${n}: ${v || '—'}`).join(' · ')}</p>}
                    </div>
                  )}
                </fieldset>
              )
            })}
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" className="btn btn-quiet" onClick={() => setDupAsk(false)}>{L('Cancel')}</button>
            <button type="button" className="btn" onClick={() => { setResolvedSig(dupSig); setDupAsk(false); if (step === 'who') next() }}>{L('Use these choices')}</button>
          </div>
        </Modal>
      )}
      {schedOpen && <ScheduledSends onClose={() => setSchedOpen(false)} onChanged={loadSchedCount} />}
    </>
  )
}

/* ---------- live progress ---------- */

function Progress({ batchId, owners }: { batchId: string; owners: ProjectOwner[] }) {
  const { t, L } = useI18n()
  const [logs, setLogs] = useState<MessageLog[]>([])
  const timer = useRef<number>(0)

  const refresh = useCallback(async () => {
    const { data } = await supabase.from('message_logs').select('*').eq('batch_id', batchId).order('created_at')
    setLogs((data as MessageLog[]) ?? [])
  }, [batchId])

  useEffect(() => {
    refresh()
    const ch = supabase.channel(`batch-${batchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_logs', filter: `batch_id=eq.${batchId}` }, (p) => {
        const row = p.new as MessageLog
        setLogs((prev) => (prev.some((x) => x.id === row.id) ? prev.map((x) => (x.id === row.id ? row : x)) : [...prev, row]))
      }).subscribe()
    timer.current = window.setInterval(refresh, 4000) // fallback if realtime is unavailable
    return () => { supabase.removeChannel(ch); window.clearInterval(timer.current) }
  }, [batchId, refresh])

  const count = (...s: MsgStatus[]) => logs.filter((l) => s.includes(l.status)).length
  const total = logs.length || 1
  const nameOf = (id: string | null) => owners.find((o) => o.owners.id === id)?.owners.full_name ?? ''
  const done = logs.length > 0 && count('QUEUED') === 0
  // finished messages fill from the left and "Waiting" is last, so the bar grows left to right as the send goes on
  const segs: [string, number, string][] = [
    [L('Read'), count('READ'), 'var(--ok)'],
    [L('Delivered'), count('DELIVERED'), 'color-mix(in srgb, var(--ok) 55%, var(--sheet))'],
    [L('Sent'), count('SENT'), 'var(--info)'],
    [L('Failed'), count('FAILED'), 'var(--bad)'],
    [L('Waiting'), count('QUEUED'), 'var(--line)'],
  ]

  return (
    <>
      <PageHead title={done ? L('Sent') : L('Sending…')} sub={L('Statuses update live as WhatsApp reports back.')} />
      <div className="card mb-6">
        <div dir="ltr" className="flex h-3 rounded-full overflow-hidden bg-soft mb-4" role="img" aria-label={segs.map(([l, n]) => `${l} ${n}`).join(', ')}>
          {segs.map(([l, n, c]) => <div key={l} style={{ width: `${(n / total) * 100}%`, background: c }} />)}
        </div>
        <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {segs.map(([l, n]) => <span key={l} className="text-ink-75">{l} <span className="text-ink font-bold tnum">{n}</span></span>)}
        </p>
      </div>
      <div className="table-wrap mb-6">
        <table className="grid-table">
          <thead><tr><th className="lg:!ps-4">{t('name')}</th><th>{L('Phone')}</th><th>{L('Status')}</th><th>{L('Detail')}</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="lg:!ps-4 cell-title">{nameOf(l.owner_id)}</td><td data-label={L('Phone')} dir="ltr">{maskPhone(l.phone_number)}</td><td data-label={L('Status')}><StatusLabel value={l.status} /></td>
                <td data-label={L('Detail')} className="text-ink-50 cell-wide">{l.error_details?.message ?? (l.status === 'QUEUED' && l.last_error ? l.last_error : l.status === 'QUEUED' && l.attempts === 0 ? L('Waiting in the queue') : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-3">
        <Link to="/overview" className="btn">{L('Back to overview')}</Link>
        <Link to="/log" className="btn btn-quiet">{t('viewLog')}</Link>
      </div>
    </>
  )
}
