import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { downloadCsv, fetchAll, IMPORT_ACCEPT, readTable } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isE164, normalizePhone, OPTOUT_RE, RESERVED_FIELD_KEYS, slugField, type OwnerField, type Project, type ProjectOwner } from '../lib/types'
import { ErrorNote, Field, Loading, Notice, PageHead, SampleTag, StatusLabel } from '../components/ui'
import { Modal, useDialog } from '../components/Dialog'
import Select from '../components/Select'
import { prepareRows, type ImportReport } from '../lib/importPrep'

interface Draft { id: string | null; full_name: string; phone: string; email: string; unit: string; opt_in: boolean; extra: Record<string, string>; list_id: string }
interface Review extends ImportReport {
  heads: string[]
  labels: Record<string, string>
}
const blank: Draft = { id: null, full_name: '', phone: '', email: '', unit: '', opt_in: true, extra: {}, list_id: '' }

export default function OwnersPage() {
  const { t, L } = useI18n()
  const { can, entities, projectAllowed } = useAuth()
  const { confirm, prompt } = useDialog()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectId, setProjectId] = useState('')
  const [rows, setRows] = useState<ProjectOwner[] | null>(null)
  const [optouts, setOptouts] = useState<Set<string>>(new Set())
  const [fields, setFields] = useState<OwnerField[]>([])
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '')
  const [groups, setGroups] = useState<{ id: string; name: string; count: number }[]>([])
  const [groupId, setGroupId] = useState('')
  const [listFields, setListFields] = useState<Record<string, Set<string>>>({})
  const [members, setMembers] = useState<Set<string> | null>(null)
  const [listName, setListName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [csv, setCsv] = useState(false)
  const [listModal, setListModal] = useState<{ name: string; added: string[]; forClient: boolean } | null>(null)
  const [listError, setListError] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [importing, setImporting] = useState(false)
  const [importTarget, setImportTarget] = useState('')   // '' = a new list, otherwise the id of the list to add to
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [picker, setPicker] = useState(false)
  const [customs, setCustoms] = useState<{ label: string; value: string }[]>([])
  const [exporting, setExporting] = useState(false)
  const [exportScope, setExportScope] = useState('')
  const [modalError, setModalError] = useState('')
  const [table, setTable] = useState<string[][] | null>(null)
  const [fileName, setFileName] = useState('')
  const [cols, setCols] = useState<{ phone: number; name: number; optout: number }>({ phone: -1, name: -1, optout: -1 })
  const [fileError, setFileError] = useState('')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  useEffect(() => {
    supabase.from('projects').select('*').eq('is_default', true).order('name').then(({ data }) => {
      const ps = ((data as Project[]) ?? []).filter((p) => can('owner.read', p.entity_id) && projectAllowed(p))
      setProjects(ps)
      const wanted = new URLSearchParams(window.location.search).get('entity')
      const first = ps.find((p) => p.entity_id === wanted) ?? ps[0]
      if (first) setProjectId(first.id)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const project = projects?.find((p) => p.id === projectId)
  const manage = !!project && can('owner.manage', project.entity_id)

  const load = useCallback(async () => {
    if (!projectId) { setRows([]); return }
    const eid = projects?.find((p) => p.id === projectId)?.entity_id
    if (eid) {
      const { data: oo } = await supabase.from('owner_optouts').select('owner_id').eq('entity_id', eid)
      setOptouts(new Set(((oo as { owner_id: string }[]) ?? []).map((x) => x.owner_id)))
    }
    if (eid) {
      const { data: fd } = await supabase.from('owner_fields').select('key, label, example').eq('entity_id', eid).order('label')
      setFields(((fd as { key: string; label: string; example: string }[]) ?? []).map((f) => ({ ...f, builtin: false })))
    }
    if (eid) {
      const { data: gl } = await supabase.from('client_lists').select('id, name, client_list_members(count)').eq('entity_id', eid).order('name')
      setGroups(((gl as unknown as { id: string; name: string; client_list_members: { count: number }[] }[]) ?? []).map((g) => ({ id: g.id, name: g.name, count: g.client_list_members?.[0]?.count ?? 0 })))
    }
    if (eid) {
      const { data: lf } = await supabase.from('client_list_fields').select('list_id, key')
      const m: Record<string, Set<string>> = {}
      for (const x of (lf as { list_id: string; key: string }[]) ?? []) (m[x.list_id] ??= new Set()).add(x.key)
      setListFields(m)
    }
    const all = await fetchAll<ProjectOwner>((from, to) => supabase.from('project_owners')
      .select('unit_no, extra, owners(id, full_name, phone, email, whatsapp_opt_in, status)').eq('project_id', projectId).order('owner_id').range(from, to))
    setRows(all.sort((a, b) => a.owners.full_name.localeCompare(b.owners.full_name)))
  }, [projectId, projects])
  useEffect(() => { setRevealed(new Set()); setPicker(false); setCustoms([]) }, [draft === null, draft?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(null); setGroupId(''); setPicked(new Set()); load() }, [load])

  // the first group is shown by default; with no groups the whole list is shown
  useEffect(() => {
    if (groups.length === 0) { if (groupId) setGroupId(''); return }
    if (!groups.some((g) => g.id === groupId)) setGroupId(groups[0].id)
  }, [groups]) // eslint-disable-line react-hooks/exhaustive-deps

  // clients of the chosen group
  useEffect(() => {
    if (!groupId) { setMembers(null); return }
    fetchAll<{ owner_id: string }>((from, to) => supabase.from('client_list_members').select('owner_id').eq('list_id', groupId).order('owner_id').range(from, to))
      .then((r) => setMembers(new Set(r.map((x) => x.owner_id))))
  }, [groupId, rows])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!draft) return
    const phone = normalizePhone(draft.phone)
    if (!isE164(phone)) { setModalError(L('Include the country code in the phone number, for example +971501234567.')); return }
    if (!draft.id && !draft.list_id) { setModalError(L('Choose a list for this client, or create one.')); return }
    const customExtra: Record<string, string> = {}, customLabels: Record<string, string> = {}
    for (const c of customs) {
      const label = c.label.trim(), value = c.value.trim()
      if (!label && !value) continue
      const key = slugField(label)
      if (!label || !key || RESERVED_FIELD_KEYS.includes(key) || key in customExtra) { setModalError(`${L('This field name is not allowed or is used twice')}: ${label || '—'}`); return }
      if (value) { customExtra[key] = value; customLabels[key] = label }
    }
    setModalError('')
    const { data: ownerId, error } = await supabase.rpc('upsert_owner', {
      p_project: projectId, p_owner: draft.id, p_name: draft.full_name.trim() || phone, p_phone: phone, p_email: draft.email, p_unit: draft.unit, p_opt_in: draft.opt_in,
      p_extra: { ...(draft.id ? draft.extra : Object.fromEntries(Object.entries(draft.extra).filter(([k]) => listFields[draft.list_id]?.has(k)))), ...customExtra }, p_labels: customLabels,
    })
    if (error) { setModalError(error.message); return }
    if (!draft.id) {
      // a new client always lands in a list; the company gets one if it has none
      const { error: listError } = await supabase.rpc('add_client_to_list', { p_project: projectId, p_owner: ownerId, p_list: draft.list_id })
      if (listError) { setModalError(listError.message); load(); return }
    }
    setDraft(null); load()
  }

  function openListModal(forClient: boolean) {
    setListError('')
    setListModal({ name: '', added: [], forClient })
  }

  async function createList(e: FormEvent) {
    e.preventDefault()
    if (!listModal) return
    const name = listModal.name.trim()
    if (!name) { setListError(L('Give the list a name.')); return }
    const newFields: Record<string, string> = {}
    const taken = new Set(RESERVED_FIELD_KEYS)
    for (const label of listModal.added.map((a) => a.trim()).filter(Boolean)) {
      const key = slugField(label)
      if (!key || taken.has(key)) { setListError(`${L('This field name is not allowed or is used twice')}: ${label}`); return }
      taken.add(key); newFields[key] = label
    }
    const { data: lid, error } = await supabase.rpc('create_client_list', { p_project: projectId, p_name: name, p_fields: newFields })
    if (error) { setListError(error.message); return }
    if (listModal.forClient) setDraft((d) => (d ? { ...d, list_id: lid as string } : d))
    setGroupId(lid as string)
    setListModal(null)
    load()
  }

  async function remove(o: ProjectOwner) {
    const ok = await confirm({
      title: L('Remove this client?'), danger: true, confirmLabel: t('remove'),
      message: `${o.owners.full_name} ${L('will be removed from this client list and from its groups.')}`,
    })
    if (!ok) return
    const { error } = await supabase.rpc('remove_owner', { p_project: projectId, p_owner: o.owners.id })
    if (error) setError(error.message); else { setPicked(new Set()); load() }
  }

  /** Delete in the open list takes the client out of that list only; they stay in their other lists. A client in no other list is removed completely. */
  async function deleteClient(o: ProjectOwner) {
    const g = groups.find((x) => x.id === groupId)
    if (!g) { remove(o); return }
    const { data: other, error: lookup } = await supabase.from('client_list_members').select('list_id').eq('owner_id', o.owners.id).neq('list_id', g.id)
    if (lookup) { setError(lookup.message); return }
    const elsewhere = (other ?? []).length > 0
    const ok = await confirm({
      title: `${L('Delete')} ${o.owners.full_name} ${L('from the list')} “${g.name}”?`, danger: true, confirmLabel: L('Delete'),
      message: elsewhere ? L('The client stays in their other lists.') : L('This client is in no other list, so they will be deleted completely.'),
    })
    if (!ok) return
    setError(''); setInfo('')
    const { error } = elsewhere
      ? await supabase.rpc('remove_from_group', { p_list: g.id, p_owners: [o.owners.id] })
      : await supabase.rpc('remove_owner', { p_project: projectId, p_owner: o.owners.id })
    if (error) { setError(error.message); return }
    setPicked(new Set()); load()
  }

  /** Same rule as the row Delete, for every ticked client: out of the open list only; clients in no other list are deleted completely. */
  async function deleteSelected() {
    const ids = [...picked]
    const g = groups.find((x) => x.id === groupId)
    if (ids.length === 0) return
    let doomed = ids
    if (g) {
      const { data: other, error: lookup } = await supabase.from('client_list_members').select('owner_id').in('owner_id', ids).neq('list_id', g.id)
      if (lookup) { setError(lookup.message); return }
      const keep = new Set((other ?? []).map((x: { owner_id: string }) => x.owner_id))
      doomed = ids.filter((id) => !keep.has(id))
    }
    const staying = ids.length - doomed.length
    const ok = await confirm({
      title: `${L('Delete')} ${ids.length} ${ids.length === 1 ? L('client') : L('clients')}${g ? ` ${L('from the list')} “${g.name}”` : ''}?`, danger: true, confirmLabel: L('Delete'),
      message: g
        ? `${L('Warning')}: ${doomed.length} ${L('will be deleted completely.')} ${staying > 0 ? `${staying} ${L('are also in other lists and will stay there.')} ` : ''}${L('This cannot be undone.')}`
        : `${L('Warning')}: ${L('The selected clients will be deleted. This cannot be undone.')}`,
    })
    if (!ok) return
    setError(''); setInfo('')
    if (g) {
      const { error } = await supabase.rpc('remove_from_group', { p_list: g.id, p_owners: ids })
      if (error) { setError(error.message); return }
    }
    if (doomed.length > 0) {
      const { error } = await supabase.rpc('remove_owners', { p_project: projectId, p_owners: doomed })
      if (error) { setError(error.message); return }
    }
    setInfo(`${ids.length} ${L('clients deleted')}`)
    setPicked(new Set()); load()
  }

  async function deleteGroup(g: { id: string; name: string }) {
    // count the clients that would be deleted with it: those in no other group
    const inThis = (await fetchAll<{ owner_id: string }>((from, to) => supabase.from('client_list_members').select('owner_id').eq('list_id', g.id).order('owner_id').range(from, to))).map((x) => x.owner_id)
    const inOthers = new Set((await fetchAll<{ owner_id: string }>((from, to) => supabase.from('client_list_members').select('owner_id').neq('list_id', g.id).order('owner_id').range(from, to))).map((x) => x.owner_id))
    const doomed = inThis.filter((id) => !inOthers.has(id)).length
    const ok = await confirm({
      title: `${L('Delete the group')} “${g.name}”?`, danger: true, confirmLabel: L('Delete'),
      message: `${L('Warning')}: ${doomed} ${doomed === 1 ? L('client') : L('clients')} ${L('will be deleted with this group.')} ${inThis.length - doomed > 0 ? `${inThis.length - doomed} ${L('are also in other groups and will stay there.')} ` : ''}${L('This cannot be undone.')}`,
    })
    if (!ok) return
    const { error } = await supabase.rpc('delete_client_list', { p_list: g.id })
    if (error) setError(error.message); else { setGroupId(''); load() }
  }

  async function deleteAllGroups() {
    const eid = project?.entity_id
    if (!eid) return
    const ok = await confirm({
      title: L('Delete all groups?'), danger: true, confirmLabel: L('Delete'),
      message: `${L('Warning')}: ${groups.length} ${L('groups will be deleted, and all their clients with them. This cannot be undone.')}`,
    })
    if (!ok) return
    const { error } = await supabase.rpc('delete_client_lists', { p_entity: eid })
    if (error) setError(error.message); else { setGroupId(''); load() }
  }

  /** Guesses which column holds the phone numbers (by looking at the values) and which holds the name. The person can change both. */
  function guessColumns(t: string[][]) {
    const heads = t[0].map((h) => h.trim().toLowerCase())
    const body = t.slice(1, 61)
    let phone = -1, best = 0
    heads.forEach((h, i) => {
      const filled = body.map((r) => (r[i] ?? '').trim()).filter(Boolean)
      if (!filled.length) return
      const share = filled.filter((v) => isE164(normalizePhone(v))).length / filled.length
      const score = share + (/phone|mobile|whatsapp|tel|رقم|موبايل|هاتف|جوال/.test(h) ? 0.15 : 0)
      if (share >= 0.6 && score > best) { best = score; phone = i }
    })
    const optout = heads.findIndex((_, i) => i !== phone && body.some((r) => OPTOUT_RE.test((r[i] ?? '').trim())))
    return { phone, name: -1, optout }
  }

  /** Every column of the file becomes a field for templates. Only the phone column has a special job. */
  function analyze(table: string[][] | null) {
    if (!table || table.length < 2) return null
    const heads = table[0].map((h) => h.trim())
    const extras: { index: number; key: string; label: string; example: string }[] = []
    heads.forEach((h, index) => {
      if (!h) return
      let key = slugField(h)
      if (!key) return
      if (RESERVED_FIELD_KEYS.includes(key)) key = `col_${key}`
      if (extras.some((x) => x.key === key)) return
      const example = table.slice(1).map((r) => (r[index] ?? '').trim()).find(Boolean) ?? ''
      extras.push({ index, key, label: h, example })
    })
    return { table, heads, extras, rows: table.length - 1 }
  }

  async function chooseFile(file: File | undefined) {
    setFileError(''); setTable(null); setInfo('')
    if (!file) return
    setReading(true)
    try { const t = await readTable(file); setTable(t); setCols(t.length > 1 ? guessColumns(t) : { phone: -1, name: -1, optout: -1 }); setFileName(file.name); setListName(file.name.replace(/\.(csv|xlsx)$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 80)) }
    catch (e) { setFileName(''); setFileError((e as Error).message) }
    setReading(false)
  }

  /** Checks the file before anything is saved: unusable phones are set aside, and the same number with different details is put to the person. */
  function prepareImport() {
    setModalError(''); setInfo('')
    const a = analyze(table)
    if (!a) { setModalError(L('The file needs a header row and at least one client.')); return }
    if (cols.phone < 0) { setModalError(L('Choose the column that has the phone numbers.')); return }
    const labels = Object.fromEntries(a.extras.map((x) => [x.key, x.label]))
    const existingPhones = new Set((rows ?? []).map((o) => o.owners.phone))
    const report = prepareRows(a.table, cols.phone, cols.optout, a.extras, (v) => OPTOUT_RE.test(v), existingPhones)
    setReview({ ...report, heads: a.heads, labels })
  }

  async function finishImport(rv: Review) {
    if (importing) return
    const chosen = rv.ready
    if (chosen.length === 0) { setModalError(L('There is nothing to import.')); setReview(null); return }
    setImporting(true)
    const payload = chosen.map((p) => ({ full_name: p.phone, phone: p.phone, email: '', unit_number: '', extra: p.extra, opt_in: !p.optout }))
    const { data, error } = await supabase.rpc('import_owners', { p_project: projectId, p_rows: payload, p_labels: rv.labels, p_list_name: importTarget ? groups.find((g) => g.id === importTarget)?.name ?? listName : listName })
    setImporting(false)
    if (error) { setModalError(error.message); setReview(null); return }
    const res = data as { imported: number; failed: { row: number; error: string }[]; list_name: string | null }
    setInfo(`${res.imported} ${L('imported')}${res.list_name ? `. ${L('Saved as the list')} “${res.list_name}”` : ''}${rv.rejected.length ? `. ${rv.rejected.length} ${L('rejected because of the phone number')}` : ''}${res.failed.length ? `. ${res.failed.length} ${L('failed')}: ${res.failed.slice(0, 3).map((f) => `${L('row')} ${f.row} (${f.error})`).join('; ')}` : ''}`)
    setReview(null)
    closeImport()
    load()
  }

  function downloadRejected(rv: Review) {
    downloadCsv('rejected-rows.csv', [['Row', 'Reason', ...rv.heads], ...rv.rejected.map((r) => [String(r.n), L(r.reason), ...r.cells])])
  }

  function closeImport() { setCsv(false); setImportTarget(''); setTable(null); setFileName(''); setFileError(''); setModalError('') }

  /** Downloads the whole list, or only one group, as a CSV with every column of the imported files. */
  async function runExport() {
    if (!rows) return
    let list = rows
    if (exportScope) {
      const ids = new Set((await fetchAll<{ owner_id: string }>((from, to) => supabase.from('client_list_members').select('owner_id').eq('list_id', exportScope).order('owner_id').range(from, to))).map((x) => x.owner_id))
      list = rows.filter((o) => ids.has(o.owners.id))
    }
    const name = (exportScope ? groups.find((g) => g.id === exportScope)?.name : project ? entityName(project.entity_id) : '') || 'clients'
    downloadCsv(`${name.replace(/[^\w\- ]+/g, '').trim() || 'clients'}.csv`, [
      [t('name'), L('Phone'), ...fields.map((f) => f.label)],
      ...list.map((o) => [o.owners.full_name, o.owners.phone, ...fields.map((f) => o.extra?.[f.key] ?? '')]),
    ])
    setExporting(false)
  }

  if (!projects) return <Loading />
  const needle = q.trim().toLowerCase()
  const digits = needle.replace(/\D/g, '').replace(/^0+/, '')
  const matches = (o: ProjectOwner) =>
    o.owners.full_name.toLowerCase().includes(needle) || (o.unit_no ?? '').toLowerCase().includes(needle) || (o.owners.email ?? '').toLowerCase().includes(needle)
    || (digits.length >= 3 && o.owners.phone.replace(/\D/g, '').includes(digits))
    || Object.values(o.extra ?? {}).some((v) => String(v).toLowerCase().includes(needle))
  // searching looks through every client of the company, not only the chosen group
  const shown = (rows ?? []).filter((o) => (needle ? matches(o) : !members || members.has(o.owners.id)))
  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? ''
  const csvInfo = csv ? analyze(table) : null
  // columns follow the chosen list: its own fields, and Name / Unit only when some client has them
  const shownFields = (groupId ? fields.filter((f) => listFields[groupId]?.has(f.key)) : []).slice(0, 6)
  const showName = shown.some((o) => o.owners.full_name !== o.owners.phone)
  const showUnit = shown.some((o) => !!o.unit_no)

  // the form shows only the fields of the chosen list (and any the client being edited already has)
  const formListId = draft ? (draft.id ? groupId : draft.list_id) : ''
  const formFieldKeys = new Set([...(listFields[formListId] ?? []), ...Object.keys(draft?.extra ?? {})])

  // everything except the phone is optional: it appears when the person adds it, or when the client already has a value
  const optional = draft ? [
    { key: 'name', label: t('fullName'), value: draft.full_name, set: (v: string) => setDraft({ ...draft, full_name: v }) },
    { key: 'email', label: L('Email'), value: draft.email, set: (v: string) => setDraft({ ...draft, email: v }) },
    { key: 'unit', label: L('Unit'), value: draft.unit, set: (v: string) => setDraft({ ...draft, unit: v }) },
    ...fields.filter((f) => formFieldKeys.has(f.key)).map((f) => ({ key: `f:${f.key}`, label: f.label, value: draft.extra[f.key] ?? '', set: (v: string) => setDraft({ ...draft, extra: { ...draft.extra, [f.key]: v } }) })),
  ] : []
  const isShown = (key: string) => revealed.has(key) || !!optional.find((o) => o.key === key)?.value

  return (
    <>
      <PageHead title={L('Clients')} sub={L('The people who receive your WhatsApp messages. Each company has one client list.')}>
        {manage && <button className="btn" onClick={() => { setDraft({ ...blank, list_id: groupId }); setModalError('') }}>{L('Add client')}</button>}
        {manage && <button className="btn btn-quiet" onClick={() => openListModal(false)}>{L('New list')}</button>}
        {manage && <button className="btn btn-quiet" onClick={() => { setCsv(true); setDraft(null); setModalError('') }}>{L('Import clients')}</button>}
        {rows && rows.length > 0 && <button className="btn btn-quiet" onClick={() => { setExportScope(groupId); setExporting(true) }}>{L('Export clients')}</button>}
      </PageHead>

      <div className="grid sm:grid-cols-2 gap-6 mb-8 max-w-2xl">
        <Field label={L('Client list')}>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{entityName(p.entity_id)}</option>)}
          </Select>
        </Field>
        <Field label={L('Search')} hint={needle ? L('Searching all clients in this list.') : undefined}><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('Name, phone or anything in the file')} /></Field>
      </div>

      {groups.length > 0 && (
        <section aria-label={L('Groups')} className="mb-6">
          <p className="text-sm font-medium text-ink-75 mb-2">{L('Groups from your files')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {groups.map((g) => (
              <button key={g.id} className={`tab !rounded-full ${groupId === g.id ? '!bg-ink !text-paper' : '!bg-card'}`} aria-pressed={groupId === g.id} onClick={() => setGroupId(g.id)}>{g.name} ({g.count})</button>
            ))}
            {manage && groupId && (
              <>
                <button className="link-btn" onClick={async () => {
                  const name = await prompt({ title: L('Rename group'), label: L('New name for this group'), initial: groups.find((g) => g.id === groupId)?.name, confirmLabel: t('save'), required: true })
                  if (!name?.trim()) return
                  const { error } = await supabase.rpc('rename_client_list', { p_list: groupId, p_name: name })
                  if (error) setError(error.message); else load()
                }}>{L('Rename')}</button>
                <button className="link-btn" onClick={() => deleteGroup(groups.find((x) => x.id === groupId)!)}>{L('Delete this group')}</button>
              </>
            )}
            {manage && <button className="link-btn ms-auto" onClick={deleteAllGroups}>{L('Delete all groups')}</button>}
          </div>
        </section>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {info && <Notice>{info}</Notice>}

      {csv && (
        <Modal title={L('Import clients')} onClose={closeImport} wide>
          <div className="space-y-4">
          <p className="text-sm text-ink-50">{L('Use any file you have. The first row is the column names. You only tell us which column has the phone numbers.')}</p>
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); chooseFile(e.dataTransfer.files?.[0]) }}
            className="block rounded-2xl bg-paper px-6 py-8 text-center cursor-pointer hover:bg-soft transition-colors">
            <input type="file" accept={IMPORT_ACCEPT} className="sr-only" aria-label={L('Choose a CSV or Excel file')} onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = '' }} />
            <span className="block text-ink font-medium">{reading ? L('Reading the file…') : fileName || L('Choose a CSV or Excel file')}</span>
            <span className="block text-sm text-ink-50 mt-1">{fileName ? L('Choose another file to replace it.') : L('Drop it here, or click to browse. CSV and Excel (.xlsx) only, up to 5 MB.')}</span>
          </label>
          {fileError && <p role="alert" className="notice notice-bad !m-0">{fileError}</p>}
          <button type="button" className="link-btn text-sm" onClick={() => downloadCsv('example-file.csv', [['Client', 'Mobile', 'Due date', 'Amount'], ['Sara Hassan', '01000000000', '31 October 2026', '4500']])}>{L('Download an example file')}</button>
          {csvInfo && (
            <div className="rounded-xl bg-paper p-4 text-sm space-y-4">
              <p className="text-ink"><span className="font-bold tnum">{csvInfo.rows}</span> {csvInfo.rows === 1 ? L('row found') : L('rows found')}.</p>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label={L('Which column has the phone numbers?')}>
                  <Select value={cols.phone} onChange={(e) => setCols({ ...cols, phone: Number(e.target.value) })}>
                    <option value={-1}>{L('Choose a column')}</option>
                    {csvInfo.heads.map((h, i) => h && <option key={i} value={i}>{h}</option>)}
                  </Select>
                </Field>
              </div>
            </div>
          )}
          {table && (
            <>
              {groups.length > 0 && (
                <Field label={L('Add the clients to')}>
                  <Select value={importTarget} onChange={(e) => setImportTarget(e.target.value)}>
                    <option value="">{L('A new list')}</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.count})</option>)}
                  </Select>
                </Field>
              )}
              {!importTarget && (
                <Field label={L('List name')} hint={L('Everyone in this file is saved as a group with this name, so you can send to the whole group later. Importing another file with the same name adds to it. Clear the name to import without a group.')}>
                  <input value={listName} maxLength={80} onChange={(e) => setListName(e.target.value)} />
                </Field>
              )}
              {importTarget && <p className="text-sm text-ink-50">{L('The clients in this file are added to the list. Clients already in it are kept, and the columns of the file become fields of the list.')}</p>}
            </>
          )}
          {modalError && <ErrorNote>{modalError}</ErrorNote>}
          <div className="flex justify-end gap-3"><button className="btn btn-quiet" onClick={closeImport}>{t('cancel')}</button><button className="btn" onClick={prepareImport} disabled={!table || reading || cols.phone < 0}>{L('Import')}</button></div>
          </div>
        </Modal>
      )}

      {review && (
        <Modal title={L('Check before importing')} onClose={() => setReview(null)} wide>
          <div className="space-y-6">
            <p className="text-sm text-ink-75">
              <span className="font-bold tnum">{review.ready.length}</span> {L('rows have a usable phone')}, <span className="font-bold tnum">{review.rejected.length}</span> {L('have a phone that cannot be used and will be left out')}.
            </p>
            <ul className="text-sm text-ink-75 space-y-1">
              <li><span className="font-bold tnum">{review.fresh}</span> {L('new numbers')}, <span className="font-bold tnum">{review.existing}</span> {L('numbers already in this list')}</li>
              {review.duplicates.length > 0 && <li><span className="font-bold tnum">{review.duplicates.length}</span> {L('repeated rows will be skipped')}: {review.duplicates.slice(0, 5).map((d) => `${L('row')} ${d.n} = ${L('row')} ${d.of}`).join('; ')}</li>}
              {review.conflicts.length > 0 && <li><span className="font-bold tnum">{review.conflicts.length}</span> {L('rows share a number with different details and stay separate clients')}: {review.conflicts.slice(0, 5).map((d) => `${L('row')} ${d.n} + ${L('row')} ${d.of}`).join('; ')}</li>}
              {review.ready.some((p) => p.optout) && <li>{L('Numbers marked as opted out stay opted out. An import never turns messages back on.')}</li>}
            </ul>

            {review.rejected.length > 0 && <section>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="font-medium">{L('Rejected rows')} ({review.rejected.length})</h3>
                <button type="button" className="link-btn text-sm" onClick={() => downloadRejected(review)}>{L('Download rejected rows')}</button>
              </div>
              <div className="max-h-[50vh] overflow-auto rounded-xl bg-paper p-4 text-sm">
                <table className="w-full text-start whitespace-nowrap">
                  <thead><tr className="text-ink-50"><th className="text-start pe-4 font-normal">{L('Row')}</th>{review.heads.map((h, i) => <th key={i} className="text-start pe-4 font-normal">{h}</th>)}<th className="text-start font-normal">{L('Reason')}</th></tr></thead>
                  <tbody>{review.rejected.map((r) => (
                    <tr key={r.n}><td className="pe-4 tnum">{r.n}</td>{review.heads.map((_, i) => <td key={i} className="pe-4" dir="auto">{r.cells[i] ?? ''}</td>)}<td className="text-bad">{L(r.reason)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </section>}

            <div className="flex justify-end gap-3">
              <button className="btn btn-quiet" onClick={() => setReview(null)}>{t('cancel')}</button>
              <button className="btn" disabled={importing} onClick={() => finishImport(review)}>{L('Import')}</button>
            </div>
          </div>
        </Modal>
      )}

      {exporting && (
        <Modal title={L('Export clients')} onClose={() => setExporting(false)}>
          <div className="space-y-4">
            <p className="text-ink-75">{L('Download your clients as a CSV file that opens in Excel. It includes the name, the phone and every column from your imported files.')}</p>
            <Field label={L('What to export')}>
              <Select value={exportScope} onChange={(e) => setExportScope(e.target.value)}>
                <option value="">{L('All clients')} ({rows?.length ?? 0})</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.count})</option>)}
              </Select>
            </Field>
            <div className="flex justify-end gap-3"><button className="btn btn-quiet" onClick={() => setExporting(false)}>{t('cancel')}</button><button className="btn" onClick={runExport}>{L('Download CSV')}</button></div>
          </div>
        </Modal>
      )}

      {draft && (
        <Modal title={draft.id ? t('edit') : L('Add client')} onClose={() => setDraft(null)} wide>
        <form onSubmit={save} className="space-y-6">
          <div className="grid sm:grid-cols-2 gap-6">
            <Field label={L('Phone')} hint={L('Start with the country code, for example +971501234567 or 201010354164. The + is optional.')}><input required autoFocus dir="ltr" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="+971501234567" /></Field>
            {optional.filter((o) => isShown(o.key)).map((o) => (
              <Field key={o.key} label={o.label}>
                <input type={o.key === 'email' ? 'email' : 'text'} dir={o.key === 'email' ? 'ltr' : undefined} value={o.value} onChange={(e) => o.set(e.target.value)} />
              </Field>
            ))}
          </div>
          {customs.length > 0 && (
            <div className="space-y-3">
              {customs.map((c, i) => (
                <div key={i} className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                  <Field label={L('Field name')}><input autoFocus maxLength={40} value={c.label} onChange={(e) => setCustoms(customs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></Field>
                  <Field label={L('Value')}><input maxLength={200} value={c.value} onChange={(e) => setCustoms(customs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /></Field>
                  <button type="button" className="link-btn pb-2" onClick={() => setCustoms(customs.filter((_, j) => j !== i))}>{t('remove')}</button>
                </div>
              ))}
            </div>
          )}
          {(!draft.id || optional.some((o) => !isShown(o.key))) && (
            <div>
              <button type="button" className="btn btn-quiet btn-sm" aria-expanded={picker} onClick={() => setPicker(!picker)}>+ {L('Add field')}</button>
              {picker && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {!draft.id && <button type="button" className="tab !rounded-full !bg-card" onClick={() => { setCustoms([...customs, { label: '', value: '' }]); setPicker(false) }}>+ {L('Custom field')}</button>}
                  {optional.filter((o) => !isShown(o.key)).map((o) => (
                    <button key={o.key} type="button" className="tab !rounded-full !bg-card" onClick={() => { setRevealed(new Set([...revealed, o.key])); setPicker(false) }}>{o.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!draft.id && (
            <Field label={L('Client list')} hint={groups.length === 0 ? L('This company has no list yet. Create one to add the client to it.') : undefined}>
              <div className="flex gap-3 items-center">
                {groups.length > 0 && (
                  <Select value={draft.list_id} onChange={(e) => { if (e.target.value === '__new') openListModal(true); else setDraft({ ...draft, list_id: e.target.value }) }}>
                    <option value="" disabled>{L('Choose a list')}</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    <option value="__new">+ {L('Create new list')}</option>
                  </Select>
                )}
                {groups.length === 0 && <button type="button" className="btn btn-quiet" onClick={() => openListModal(true)}>{L('Create list')}</button>}
              </div>
            </Field>
          )}
          <label className="flex items-center gap-3"><input type="checkbox" checked={draft.opt_in} onChange={(e) => setDraft({ ...draft, opt_in: e.target.checked })} />{L('Receives WhatsApp messages')}</label>
          {modalError && <ErrorNote>{modalError}</ErrorNote>}
          <div className="flex justify-end gap-3"><button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>{t('cancel')}</button><button className="btn">{t('save')}</button></div>
        </form>
        </Modal>
      )}

      {listModal && (
        <Modal title={L('Create list')} onClose={() => setListModal(null)}>
          <form onSubmit={createList} className="space-y-6">
            <Field label={L('List name')}><input required autoFocus maxLength={80} value={listModal.name} onChange={(e) => setListModal({ ...listModal, name: e.target.value })} /></Field>
            <section>
              <p className="text-sm font-medium text-ink-75 mb-2">{L('Fields')}</p>
              <div className="space-y-3">
                {listModal.added.map((a, i) => (
                  <div key={i} className="flex gap-3 items-center">
                    <input autoFocus aria-label={L('Field name')} value={a} maxLength={40} onChange={(e) => setListModal({ ...listModal, added: listModal.added.map((x, j) => (j === i ? e.target.value : x)) })} />
                    <button type="button" className="link-btn" onClick={() => setListModal({ ...listModal, added: listModal.added.filter((_, j) => j !== i) })}>{t('remove')}</button>
                  </div>
                ))}
              </div>
              <button type="button" className="link-btn mt-3" onClick={() => setListModal({ ...listModal, added: [...listModal.added, ''] })}>+ {L('Add field')}</button>
            </section>
            {listError && <ErrorNote>{listError}</ErrorNote>}
            <div className="flex justify-end gap-3"><button type="button" className="btn btn-quiet" onClick={() => setListModal(null)}>{t('cancel')}</button><button className="btn">{L('Create list')}</button></div>
          </form>
        </Modal>
      )}

      {manage && rows && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <button className="link-btn lg:hidden" onClick={() => setPicked(new Set(shown.slice(0, 300).map((o) => o.owners.id)))}>{L('Select all shown')}</button>
          {picked.size > 0 && <button className="btn btn-danger btn-sm" onClick={deleteSelected}>{L('Delete')} ({picked.size})</button>}
          {picked.size > 0 && <button className="link-btn" onClick={() => setPicked(new Set())}>{L('Clear selection')}</button>}
        </div>
      )}

      {!rows ? <Loading /> : shown.length === 0 ? <p>{L('No clients in this list yet. Add one, or import a file.')}</p> : (
        <div className="lg:overflow-x-auto">
          <table className="grid-table">
            <thead><tr>{manage && <th className="w-10"><input type="checkbox" aria-label={L('Select all shown')} checked={shown.slice(0, 300).length > 0 && shown.slice(0, 300).every((o) => picked.has(o.owners.id))} onChange={(e) => setPicked(e.target.checked ? new Set(shown.slice(0, 300).map((o) => o.owners.id)) : new Set())} /></th>}{showName && <th>{t('name')}</th>}{showUnit && <th>{L('Unit')}</th>}<th>{L('Phone')}</th>{shownFields.map((f) => <th key={f.key}>{f.label}</th>)}<th>{L('Status')}</th>{manage && <th>{t('actions')}</th>}</tr></thead>
            <tbody>
              {shown.slice(0, 300).map((o) => (
                <tr key={o.owners.id}>
                  {manage && <td className="cell-select"><input type="checkbox" aria-label={`${L('Select')} ${o.owners.full_name}`} checked={picked.has(o.owners.id)} onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(o.owners.id); else n.delete(o.owners.id); return n })} /></td>}
                  {showName && <td className="cell-title">{o.owners.full_name}{project?.is_sample && <SampleTag />}</td>}
                  {showUnit && <td data-label={L('Unit')}>{o.unit_no}</td>}<td data-label={L('Phone')} dir="ltr">{o.owners.phone}</td>{shownFields.map((f) => <td key={f.key} data-label={f.label}>{o.extra?.[f.key] ?? ""}</td>)}
                  <td data-label={L('Status')}>{o.owners.whatsapp_opt_in && !optouts.has(o.owners.id) ? <StatusLabel value="active" /> : <span className="status tone-neutral">{L('Opted out')}</span>}</td>
                  {manage && (
                    <td className="cell-actions whitespace-nowrap">
                      <button className="btn btn-sm me-3 !bg-yellow-400 !text-black" onClick={() => { setDraft({ id: o.owners.id, full_name: o.owners.full_name, phone: o.owners.phone, email: o.owners.email ?? '', unit: o.unit_no ?? '', opt_in: o.owners.whatsapp_opt_in, extra: o.extra ?? {}, list_id: '' }); setModalError('') }}>{t('edit')}</button>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteClient(o)}>{L('Delete')}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 300 && <p className="text-sm text-ink-50 mt-3">{L('Showing the first 300 of')} {shown.length}. {L('Use the search to find a client.')}</p>}
        </div>
      )}
    </>
  )
}
