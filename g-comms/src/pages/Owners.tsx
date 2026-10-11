import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { downloadCsv, fetchAll, IMPORT_ACCEPT, readTable } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isE164, normalizePhone, RESERVED_FIELD_KEYS, slugField, type OwnerField, type Project, type ProjectOwner } from '../lib/types'
import { ErrorNote, Field, Loading, Notice, PageHead, SampleTag, StatusLabel } from '../components/ui'
import { Modal, useDialog } from '../components/Dialog'
import Select from '../components/Select'

interface Draft { id: string | null; full_name: string; phone: string; email: string; unit: string; opt_in: boolean; extra: Record<string, string> }
const blank: Draft = { id: null, full_name: '', phone: '', email: '', unit: '', opt_in: true, extra: {} }

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
  const [members, setMembers] = useState<Set<string> | null>(null)
  const [listName, setListName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [csv, setCsv] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportScope, setExportScope] = useState('')
  const [modalError, setModalError] = useState('')
  const [table, setTable] = useState<string[][] | null>(null)
  const [fileName, setFileName] = useState('')
  const [cols, setCols] = useState<{ phone: number; name: number }>({ phone: -1, name: -1 })
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
    const all = await fetchAll<ProjectOwner>((from, to) => supabase.from('project_owners')
      .select('unit_no, extra, owners(id, full_name, phone, email, whatsapp_opt_in, status)').eq('project_id', projectId).order('owner_id').range(from, to))
    setRows(all.sort((a, b) => a.owners.full_name.localeCompare(b.owners.full_name)))
  }, [projectId, projects])
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
    if (!isE164(phone)) { setModalError(L('Phone must be in international format, for example +201010354164.')); return }
    setModalError('')
    const { error } = await supabase.rpc('upsert_owner', {
      p_project: projectId, p_owner: draft.id, p_name: draft.full_name, p_phone: phone, p_email: draft.email, p_unit: draft.unit, p_opt_in: draft.opt_in,
      p_extra: draft.extra, p_labels: {},
    })
    if (error) setModalError(error.message); else { setDraft(null); load() }
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

  /** Removes the ticked clients, or every client of this list when `ids` is null. */
  async function removeMany(ids: string[] | null) {
    const count = ids ? ids.length : rows?.length ?? 0
    if (count === 0) return
    const ok = await confirm({
      title: ids ? `${L('Remove')} ${count} ${count === 1 ? L('client') : L('clients')}?` : L('Remove every client?'),
      danger: true, confirmLabel: ids ? `${L('Remove')} ${count}` : L('Remove all'),
      message: ids
        ? L('The selected clients will be removed from this client list and from its groups.')
        : `${L('All')} ${count} ${L('clients will be removed from this client list and from every group. This cannot be undone.')}`,
      requireText: ids ? undefined : String(count),
    })
    if (!ok) return
    setError(''); setInfo('')
    const { data, error } = await supabase.rpc('remove_owners', { p_project: projectId, p_owners: ids })
    if (error) { setError(error.message); return }
    setInfo(`${data as number} ${L('clients removed')}`)
    setPicked(new Set()); load()
  }

  async function deleteGroup(g: { id: string; name: string }) {
    const ok = await confirm({
      title: `${L('Delete the group')} “${g.name}”?`, danger: true, confirmLabel: L('Delete group'),
      message: L('Only the group is deleted. The clients stay in your client list.'),
    })
    if (!ok) return
    const { error } = await supabase.rpc('delete_client_list', { p_list: g.id })
    if (error) setError(error.message); else { setGroupId(''); load() }
  }

  async function deleteAllGroups() {
    const eid = project?.entity_id
    if (!eid) return
    const ok = await confirm({
      title: L('Delete all groups?'), danger: true, confirmLabel: L('Delete all groups'),
      message: `${groups.length} ${L('groups will be deleted. The clients stay in your client list.')}`,
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
    const name = heads.findIndex((h, i) => i !== phone && /name|owner|client|customer|اسم|عميل|مالك/.test(h))
    return { phone, name }
  }

  /** Every column of the file becomes a field for templates. Only the phone column (and optionally a name column) has a special job. */
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
    try { const t = await readTable(file); setTable(t); setCols(t.length > 1 ? guessColumns(t) : { phone: -1, name: -1 }); setFileName(file.name); setListName(file.name.replace(/\.(csv|xlsx)$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 80)) }
    catch (e) { setFileName(''); setFileError((e as Error).message) }
    setReading(false)
  }

  async function runImport() {
    setModalError(''); setInfo('')
    const a = analyze(table)
    if (!a) { setModalError(L('The file needs a header row and at least one client.')); return }
    if (cols.phone < 0) { setModalError(L('Choose the column that has the phone numbers.')); return }
    const payload = a.table.slice(1).map((r) => {
      const phone = normalizePhone(r[cols.phone] ?? '')
      return {
        full_name: (cols.name >= 0 ? r[cols.name]?.trim() : '') || phone, phone, email: '', unit_number: '',
        extra: Object.fromEntries(a.extras.map((x) => [x.key, (r[x.index] ?? '').trim()]).filter(([, v]) => v)),
      }
    })
    const labels = Object.fromEntries(a.extras.map((x) => [x.key, x.label]))
    const { data, error } = await supabase.rpc('import_owners', { p_project: projectId, p_rows: payload, p_labels: labels, p_list_name: listName })
    if (error) { setModalError(error.message); return }
    const res = data as { imported: number; failed: { row: number; error: string }[]; list_name: string | null }
    setInfo(`${res.imported} ${L('imported')}${res.list_name ? `. ${L('Saved as the list')} “${res.list_name}”` : ''}${res.failed.length ? `. ${res.failed.length} ${L('failed')}: ${res.failed.slice(0, 3).map((f) => `${L('row')} ${f.row} (${f.error})`).join('; ')}` : ''}`)
    closeImport()
    load()
  }

  function closeImport() { setCsv(false); setTable(null); setFileName(''); setFileError(''); setModalError('') }

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
  const shownFields = fields.slice(0, 3)

  return (
    <>
      <PageHead title={L('Clients')} sub={L('The people who receive your WhatsApp messages. Each company has one client list.')}>
        {manage && <button className="btn" onClick={() => { setDraft({ ...blank }); setModalError('') }}>{L('Add client')}</button>}
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
                <Field label={L('Which column has the name? (optional)')}>
                  <Select value={cols.name} onChange={(e) => setCols({ ...cols, name: Number(e.target.value) })}>
                    <option value={-1}>{L('None')}</option>
                    {csvInfo.heads.map((h, i) => h && <option key={i} value={i}>{h}</option>)}
                  </Select>
                </Field>
              </div>
            </div>
          )}
          {table && (
            <Field label={L('List name')} hint={L('Everyone in this file is saved as a group with this name, so you can send to the whole group later. Importing another file with the same name adds to it. Clear the name to import without a group.')}>
              <input value={listName} maxLength={80} onChange={(e) => setListName(e.target.value)} />
            </Field>
          )}
          {modalError && <ErrorNote>{modalError}</ErrorNote>}
          <div className="flex justify-end gap-3"><button className="btn btn-quiet" onClick={closeImport}>{t('cancel')}</button><button className="btn" onClick={runImport} disabled={!table || reading || cols.phone < 0}>{L('Import')}</button></div>
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
            <Field label={t('fullName')}><input required value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} /></Field>
            <Field label={L('Phone')} hint={L('International format. Egyptian local numbers are converted.')}><input required dir="ltr" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="+201010354164" /></Field>
            <Field label={L('Email')}><input type="email" dir="ltr" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
            <Field label={L('Unit')}><input value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></Field>
            {fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <input value={draft.extra[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, extra: { ...draft.extra, [f.key]: e.target.value } })} />
              </Field>
            ))}
          </div>
          <label className="flex items-center gap-3"><input type="checkbox" checked={draft.opt_in} onChange={(e) => setDraft({ ...draft, opt_in: e.target.checked })} />{L('Receives WhatsApp messages')}</label>
          {modalError && <ErrorNote>{modalError}</ErrorNote>}
          <div className="flex justify-end gap-3"><button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>{t('cancel')}</button><button className="btn">{t('save')}</button></div>
        </form>
        </Modal>
      )}

      {manage && rows && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <button className="btn btn-quiet btn-sm" disabled={picked.size === 0} onClick={() => removeMany([...picked])}>{L('Remove selected')}{picked.size > 0 ? ` (${picked.size})` : ''}</button>
          <button className="btn btn-quiet btn-sm !text-bad" onClick={() => removeMany(null)}>{L('Remove all clients')} ({rows.length})</button>
          <button className="link-btn lg:hidden" onClick={() => setPicked(new Set(shown.slice(0, 300).map((o) => o.owners.id)))}>{L('Select all shown')}</button>
          {picked.size > 0 && <button className="link-btn" onClick={() => setPicked(new Set())}>{L('Clear selection')}</button>}
        </div>
      )}

      {!rows ? <Loading /> : shown.length === 0 ? <p>{L('No clients in this list yet. Add one, or import a file.')}</p> : (
        <div className="lg:overflow-x-auto">
          <table className="grid-table">
            <thead><tr>{manage && <th className="w-10"><input type="checkbox" aria-label={L('Select all shown')} checked={shown.slice(0, 300).length > 0 && shown.slice(0, 300).every((o) => picked.has(o.owners.id))} onChange={(e) => setPicked(e.target.checked ? new Set(shown.slice(0, 300).map((o) => o.owners.id)) : new Set())} /></th>}<th>{t('name')}</th><th>{L('Unit')}</th><th>{L('Phone')}</th>{shownFields.map((f) => <th key={f.key}>{f.label}</th>)}<th>{L('Status')}</th>{manage && <th>{t('actions')}</th>}</tr></thead>
            <tbody>
              {shown.slice(0, 300).map((o) => (
                <tr key={o.owners.id}>
                  {manage && <td className="cell-select"><input type="checkbox" aria-label={`${L('Select')} ${o.owners.full_name}`} checked={picked.has(o.owners.id)} onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(o.owners.id); else n.delete(o.owners.id); return n })} /></td>}
                  <td className="cell-title">{o.owners.full_name}{project?.is_sample && <SampleTag />}</td>
                  <td data-label={L('Unit')}>{o.unit_no}</td><td data-label={L('Phone')} dir="ltr">{o.owners.phone}</td>{shownFields.map((f) => <td key={f.key} data-label={f.label}>{o.extra?.[f.key] ?? ""}</td>)}
                  <td data-label={L('Status')}>{o.owners.whatsapp_opt_in && !optouts.has(o.owners.id) ? <StatusLabel value="active" /> : <span className="status tone-neutral">{L('Opted out')}</span>}</td>
                  {manage && (
                    <td className="cell-actions whitespace-nowrap">
                      <button className="link-btn me-4" onClick={() => { setDraft({ id: o.owners.id, full_name: o.owners.full_name, phone: o.owners.phone, email: o.owners.email ?? '', unit: o.unit_no ?? '', opt_in: o.owners.whatsapp_opt_in, extra: o.extra ?? {} }); setModalError('') }}>{t('edit')}</button>
                      <button className="link-btn" onClick={() => remove(o)}>{t('remove')}</button>
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
