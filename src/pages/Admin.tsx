import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { type Perm, type Profile, type Role } from '../lib/types'
import { ErrorNote, Field, Loading, Notice, PageHead, StatusLabel, fmtDate } from '../components/ui'
import { Modal } from '../components/Dialog'
import Select from '../components/Select'

/* ---------- access editor: which entities a member can use, and with which role ---------- */

/** list_ids null = every client group of the company; otherwise only those groups. */
interface Row { entity_id: string; role_id: string; list_ids: string[] | null }
interface Group { id: string; name: string; entity_id: string }

function AccessEditor({ profile, approving, onDone }: { profile: Profile; approving?: boolean; onDone: () => void }) {
  const { t, L } = useI18n()
  const { entitiesWith, profile: me, isSuper } = useAuth()
  const manageable = entitiesWith('member.manage')
  const [roles, setRoles] = useState<Role[]>([])
  const [rows, setRows] = useState<Row[] | null>(null)
  const [initial, setInitial] = useState<Row[]>([])   // what the person has now; only the superadmin may change these roles
  const [groups, setGroups] = useState<Group[]>([])
  const [bulkRole, setBulkRole] = useState('')
  const [bulkPick, setBulkPick] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const manageableIds = manageable.map((e) => e.id)

  useEffect(() => {
    (async () => {
      const [r, m, sc, gl] = await Promise.all([
        supabase.from('roles').select('*').order('name'),
        supabase.from('entity_members').select('entity_id, role_id').eq('user_id', profile.id),
        supabase.from('member_scope').select('entity_id, list_ids').eq('user_id', profile.id),
        supabase.from('client_lists').select('id, name, entity_id').order('name'),
      ])
      setRoles((r.data as Role[]) ?? [])
      setGroups((gl.data as Group[]) ?? [])
      const scope = Object.fromEntries(((sc.data as { entity_id: string; list_ids: string[] }[]) ?? []).map((x) => [x.entity_id, x.list_ids]))
      const current = ((m.data ?? []) as { entity_id: string; role_id: string }[])
        .filter((x) => manageableIds.includes(x.entity_id)).map((x) => ({ ...x, list_ids: scope[x.entity_id] ?? null }))
      setInitial(current)
      setRows(current)
    })()
  }, [profile.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <Loading />
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const free = manageable.filter((e) => !rows.some((r) => r.entity_id === e.id))
  // roles are the superadmin's to give: everyone else adds people as Employee and cannot change or remove an admin
  const employeeId = roles.find((x) => x.name === 'Employee')?.id ?? roles[0]?.id ?? ''
  const roleName = (id: string) => roles.find((x) => x.id === id)?.name ?? ''
  const isAdminRole = (id: string) => !!roles.find((x) => x.id === id)?.permissions.includes('member.manage')

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const limited = rows!.find((r) => r.list_ids !== null && r.list_ids.length === 0)
    if (limited) { setError(L('Choose at least one client group, or choose all groups.')); setBusy(false); return }
    // the superadmin rewrites the whole list; anyone else only adds companies (as Employee) or removes them, so existing roles stay as they are
    const removed = isSuper ? manageableIds : initial.filter((i) => !rows!.some((r) => r.entity_id === i.entity_id)).map((i) => i.entity_id)
    const added = isSuper ? rows! : rows!.filter((r) => !initial.some((i) => i.entity_id === r.entity_id)).map((r) => ({ ...r, role_id: employeeId }))
    if (removed.length) {
      const del = await supabase.from('entity_members').delete().eq('user_id', profile.id).in('entity_id', removed)
      if (del.error) { setError(del.error.message); setBusy(false); return }
    }
    const delScope = await supabase.from('member_scope').delete().eq('user_id', profile.id).in('entity_id', manageableIds)
    if (delScope.error) { setError(delScope.error.message); setBusy(false); return }
    if (added.length) {
      const { error } = await supabase.from('entity_members').insert(added.map((r) => ({ user_id: profile.id, entity_id: r.entity_id, role_id: r.role_id })))
      if (error) { setError(error.message); setBusy(false); return }
    }
    if (rows!.length) {
      const scoped = rows!.filter((r) => r.list_ids !== null).map((r) => ({ user_id: profile.id, entity_id: r.entity_id, list_ids: r.list_ids! }))
      if (scoped.length) {
        const { error: e2 } = await supabase.from('member_scope').insert(scoped)
        if (e2) { setError(e2.message); setBusy(false); return }
      }
    }
    if (approving) {
      const { error } = await supabase.from('profiles')
        .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: me!.id }).eq('id', profile.id)
      if (error) { setError(error.message); setBusy(false); return }
    }
    setBusy(false); onDone()
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-ink font-medium">{profile.full_name || profile.email}{profile.full_name && <span className="text-ink-50 font-normal"> · {profile.email}</span>}</p>
      <p className="text-sm text-ink-50">{L('Choose the companies this person can work in and their role in each. You can also limit them to certain client groups, so they only see those clients.')}</p>
      {rows.map((r, i) => (
        <div key={r.entity_id} className="rounded-2xl bg-paper p-4 space-y-4">
        <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-4 items-end">
          <Field label={t('entity')}>
            <Select value={r.entity_id} onChange={(e) => update(i, { entity_id: e.target.value })}>
              {manageable.filter((x) => x.id === r.entity_id || free.some((f) => f.id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          {isSuper ? (
            <Field label={t('role')}>
              <Select value={r.role_id} onChange={(e) => update(i, { role_id: e.target.value })}>
                {roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </Field>
          ) : (
            <div className="field">
              <span>{t('role')}</span>
              <p className="min-h-11 flex items-center px-1 text-ink">{roleName(initial.some((x) => x.entity_id === r.entity_id) ? initial.find((x) => x.entity_id === r.entity_id)!.role_id : employeeId)}</p>
            </div>
          )}
          {isSuper || !(initial.some((x) => x.entity_id === r.entity_id && isAdminRole(x.role_id)))
            ? <button type="button" className="link-btn mb-1" onClick={() => setRows(rows.filter((_, j) => j !== i))}>{t('remove')}</button>
            : <span />}
        </div>
        {(() => {
          const own = groups.filter((g) => g.entity_id === r.entity_id)
          if (own.length === 0) return null
          return (
            <div>
              <Field label={L('Client groups they can see')}>
                <Select value={r.list_ids === null ? 'all' : 'some'} onChange={(e) => update(i, { list_ids: e.target.value === 'all' ? null : own.slice(0, 1).map((g) => g.id) })}>
                  <option value="all">{L('All groups')}</option>
                  <option value="some">{L('Only the groups I choose')}</option>
                </Select>
              </Field>
              {r.list_ids !== null && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {own.map((g) => {
                    const on = r.list_ids!.includes(g.id)
                    return (
                      <label key={g.id} className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm cursor-pointer ${on ? 'bg-ink text-paper' : 'bg-card text-ink'}`}>
                        <input type="checkbox" className="sr-only" checked={on} onChange={() => update(i, { list_ids: on ? r.list_ids!.filter((x) => x !== g.id) : [...r.list_ids!, g.id] })} />
                        {g.name}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}
        </div>
      ))}
      {free.length > 0 && roles.length > 0 && (
        <div className="rounded-2xl bg-card p-4 space-y-4">
          <p className="font-medium text-ink">{rows.length ? L('Add more companies') : L('Choose the companies')}</p>
          <div className="flex flex-wrap gap-2">
            {free.map((e) => {
              const on = bulkPick.has(e.id)
              return (
                <label key={e.id} className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm cursor-pointer ${on ? 'bg-ink text-paper' : 'bg-paper text-ink'}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => setBulkPick((prev) => { const n = new Set(prev); if (on) n.delete(e.id); else n.add(e.id); return n })} />
                  {e.name}
                </label>
              )
            })}
            <button type="button" className="link-btn" onClick={() => setBulkPick(bulkPick.size === free.length ? new Set() : new Set(free.map((e) => e.id)))}>
              {bulkPick.size === free.length ? L('Clear') : L('Select all')}
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {isSuper && (
              <div className="w-56">
                <Field label={L('Role in these companies')}>
                  <Select value={bulkRole || employeeId} onChange={(e) => setBulkRole(e.target.value)}>
                    {roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            <button type="button" className="btn btn-quiet" disabled={bulkPick.size === 0}
              onClick={() => {
                const role = isSuper ? (bulkRole || employeeId) : employeeId
                setRows([...rows, ...free.filter((e) => bulkPick.has(e.id)).map((e) => ({ entity_id: e.id, role_id: role, list_ids: null }))])
                setBulkPick(new Set())
              }}>
              {L('Add')} {bulkPick.size > 0 ? `(${bulkPick.size})` : ''}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="notice notice-bad">{error}</p>}
      <div className="flex gap-3 items-center">
        <button className="btn" disabled={busy}>{approving ? t('approve') : t('save')}</button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>{t('cancel')}</button>
      </div>
    </form>
  )
}

/** Assign access in a popup. */
function AccessDialog({ profile, approving, onDone }: { profile: Profile; approving?: boolean; onDone: () => void }) {
  const { t } = useI18n()
  return (
    <Modal title={t('assignAccess')} onClose={onDone} wide>
      <AccessEditor profile={profile} approving={approving} onDone={onDone} />
    </Modal>
  )
}

/* ---------- requests ---------- */

export function Requests({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useI18n()
  const { profile: me } = useAuth()
  const [rows, setRows] = useState<Profile[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(async () => {
    const { data } = await supabase.from('profiles').select('*').eq('status', 'pending').order('created_at')
    setRows((data as Profile[]) ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  async function reject(p: Profile) {
    await supabase.from('profiles').update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: me!.id }).eq('id', p.id)
    load()
  }
  if (!rows) return <Loading />
  return (
    <>
      {!embedded && <PageHead title={t('pendingRequests')} />}
      {rows.length === 0 ? <p>{t('noPending')}</p> : (
        <table className="grid-table">
          <thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('date')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <Fragment key={p.id}>
                <tr>
                  <td className="cell-title">{p.full_name}</td><td data-label={t('email')}>{p.email}</td><td data-label={t('date')}>{fmtDate(p.created_at)}</td>
                  <td className="cell-actions whitespace-nowrap">
                    <button className="link-btn me-4" onClick={() => setOpen(p.id)}>{t('approve')}</button>
                    <button className="link-btn" onClick={() => reject(p)}>{t('reject')}</button>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {open && rows.find((p) => p.id === open) && <AccessDialog profile={rows.find((p) => p.id === open)!} approving onDone={() => { setOpen(null); load() }} />}
    </>
  )
}

/* ---------- members ---------- */

export function Members({ embedded }: { embedded?: boolean } = {}) {
  const { t, L } = useI18n()
  const { profile: me } = useAuth()
  const [rows, setRows] = useState<(Profile & { entity_members: { entities: { name: string } | null; roles: { name: string } | null }[] })[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [email, setEmail] = useState('')
  const [found, setFound] = useState<Profile | null | undefined>(undefined)   // undefined = not searched yet
  const [finding, setFinding] = useState(false)
  const [findError, setFindError] = useState('')
  const load = useCallback(async () => {
    const { data } = await supabase.from('profiles')
      .select('*, entity_members(entities(name), roles(name))').in('status', ['approved', 'suspended']).order('email')
    setRows((data as never) ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  async function setStatus(p: Profile, status: 'approved' | 'suspended') {
    await supabase.from('profiles').update({ status }).eq('id', p.id)
    load()
  }
  async function find(e: FormEvent) {
    e.preventDefault(); setFindError(''); setFound(undefined); setFinding(true)
    const { data, error } = await supabase.rpc('find_person', { p_email: email })
    setFinding(false)
    if (error) { setFindError(error.message); return }
    setFound(((data as Profile[]) ?? [])[0] ?? null)
  }
  function closeAdd() { setAdding(false); setEmail(''); setFound(undefined); setFindError('') }

  if (!rows) return <Loading />
  return (
    <>
      {!embedded && <PageHead title={t('members')} />}
      <div className="flex justify-end mb-4"><button className="btn" onClick={() => setAdding(true)}>{L('Add a person')}</button></div>
      {adding && (
        <Modal title={L('Add a person to your companies')} onClose={closeAdd} wide>
          <div className="space-y-4">
            <p className="text-sm text-ink-50">{L('Find someone who already has an approved account, then choose the companies and the role. New people must sign up first and be approved by the superadmin.')}</p>
            <form onSubmit={find} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-56"><Field label={L('Their email')}><input type="email" required dir="ltr" placeholder="name@thegdevelopments.com" value={email} onChange={(e) => { setEmail(e.target.value); setFound(undefined) }} /></Field></div>
              <button className="btn btn-quiet" disabled={finding}>{L('Find')}</button>
            </form>
            {findError && <ErrorNote>{findError}</ErrorNote>}
            {found === null && <Notice tone="warn">{L('No approved account with that email.')}</Notice>}
            {found && <AccessEditor profile={found} onDone={() => { closeAdd(); load() }} />}
          </div>
        </Modal>
      )}
      <table className="grid-table">
        <thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('role')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <Fragment key={p.id}>
              <tr>
                <td className="cell-title">{p.full_name}</td><td data-label={t('email')}>{p.email}</td>
                <td data-label={t('role')}>
                  {p.is_superadmin ? t('superadmin') : p.entity_members.map((m, i) => (
                    <div key={i}>{m.entities?.name}: {m.roles?.name}</div>
                  ))}
                </td>
                <td data-label={t('status')}><StatusLabel value={p.status as 'approved' | 'suspended'} /></td>
                <td className="cell-actions whitespace-nowrap">
                  {!p.is_superadmin && <button className="link-btn me-4" onClick={() => setOpen(p.id)}>{t('edit')}</button>}
                  {me?.is_superadmin && !p.is_superadmin && (
                    p.status === 'approved'
                      ? <button className="link-btn" onClick={() => setStatus(p, 'suspended')}>{t('suspend')}</button>
                      : <button className="link-btn" onClick={() => setStatus(p, 'approved')}>{t('reactivate')}</button>
                  )}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {open && rows.find((p) => p.id === open) && <AccessDialog profile={rows.find((p) => p.id === open)!} onDone={() => { setOpen(null); load() }} />}
    </>
  )
}

/* ---------- roles ---------- */

// what each switch means, in plain words, grouped by area. The inbox is not part of this version, so it is not listed.
const PERM_GROUPS: { title: string; perms: [Perm, string][] }[] = [
  { title: 'Templates', perms: [
    ['template.read', 'View templates'], ['template.create', 'Create templates'], ['template.update', 'Edit templates'],
    ['template.archive', 'Archive templates'], ['template.submit', 'Send templates to Meta'],
  ] },
  { title: 'Messages', perms: [['message.send', 'Send messages'], ['log.read', 'See message history'], ['log.all', 'See everyone’s messages, not only their own']] },
  { title: 'Clients', perms: [['owner.read', 'View clients'], ['owner.manage', 'Add, import and remove clients']] },
  { title: 'Reports', perms: [['analytics.read', 'See reports on the Overview']] },
  { title: 'People', perms: [['member.manage', 'Manage people and their access']] },
]

export function Roles({ embedded }: { embedded?: boolean } = {}) {
  const { t, L } = useI18n()
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { supabase.from('roles').select('*').order('name').then(({ data }) => setRoles((data as Role[]) ?? [])) }, [])

  async function toggle(r: Role, perm: Perm, on: boolean) {
    setError('')
    const permissions = on ? [...r.permissions, perm] : r.permissions.filter((p) => p !== perm)
    const { error } = await supabase.from('roles').update({ permissions }).eq('id', r.id)
    if (error) { setError(error.message); return }
    setRoles(roles!.map((x) => (x.id === r.id ? { ...x, permissions } : x)))
  }
  if (!roles) return <Loading />
  return (
    <>
      {!embedded && <PageHead title={t('roles')} />}
      {error && <Notice tone="bad">{error}</Notice>}
      <p className="text-sm text-ink-50 mb-4">{L('Switch on what each role is allowed to do. Changes save as you click and apply to everyone with that role.')}</p>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {roles.map((r) => (
          <section key={r.id} className="rounded-2xl bg-card p-5 min-w-0">
            <h3>{r.name}</h3>
            {r.description && <p className="text-sm text-ink-50 mt-1">{r.description}</p>}
            <div className="mt-4 space-y-4">
              {PERM_GROUPS.map((g) => (
                <fieldset key={g.title} className="border-0 p-0 m-0">
                  <legend className="text-xs font-bold uppercase tracking-wide text-ink-50 mb-1">{L(g.title)}</legend>
                  {g.perms.map(([perm, label]) => (
                    <label key={perm} className="flex items-center justify-between gap-3 py-1.5 cursor-pointer">
                      <span className="text-ink min-w-0">{L(label)}</span>
                      <input type="checkbox" className="shrink-0" aria-label={`${r.name}: ${L(label)}`} checked={r.permissions.includes(perm)} onChange={(e) => toggle(r, perm, e.target.checked)} />
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
