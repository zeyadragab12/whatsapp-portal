import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import type { Entity } from '../lib/types'
import { ErrorNote, Field, Loading, PageHead, StatusLabel } from '../components/ui'
import CompanyDialog, { type TabId } from '../components/CompanyDialog'
import { Modal } from '../components/Dialog'
import SharedSettingsDialog from '../components/SharedSettingsDialog'

/** Companies: each entity is one project with one client list. */
export function Entities() {
  const { t, L } = useI18n()
  const { reload } = useAuth()
  const [entities, setEntities] = useState<Entity[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [openTab, setOpenTab] = useState<TabId>('overview')
  const [adding, setAdding] = useState(false)
  const [shared, setShared] = useState(false)

  const load = useCallback(async () => {
    const [e, p] = await Promise.all([
      supabase.from('entities').select('*').order('name'),
      supabase.from('projects').select('id, entity_id').eq('is_default', true),
    ])
    setEntities((e.data as Entity[]) ?? [])
    const lists = (p.data as { id: string; entity_id: string }[]) ?? []
    const next: Record<string, number> = {}
    await Promise.all(lists.map(async (l) => {
      const { count } = await supabase.from('project_owners').select('owner_id', { count: 'exact', head: true }).eq('project_id', l.id)
      next[l.entity_id] = count ?? 0
    }))
    setCounts(next)
  }, [])
  useEffect(() => { load() }, [load])

  async function addEntity(e: FormEvent) {
    e.preventDefault(); setError('')
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const { data, error } = await supabase.from('entities').insert({ name: name.trim(), slug }).select('id').single()
    if (error) { setError(error.message); return }
    setName(''); setAdding(false)
    await load(); reload()
    setOpenTab('whatsapp'); setOpenId((data as { id: string }).id)   // straight on to linking the new company's WhatsApp number
  }
  if (!entities) return <Loading />
  return (
    <>
      <PageHead title={L('Companies')} sub={L('Each company is its own project, with its own client list, WhatsApp number and templates.')}>
        <button className="btn btn-quiet" onClick={() => setShared(true)}>{L('Shared settings')}</button>
        <button className="btn" onClick={() => { setError(''); setAdding(true) }}>{t('addEntity')}</button>
      </PageHead>
      {error && !adding && <ErrorNote>{error}</ErrorNote>}
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-8">
        {entities.map((e) => (
          <button key={e.id} type="button" onClick={() => { setOpenTab('overview'); setOpenId(e.id) }} aria-label={`${L('Open settings of')} ${e.name}`}
            className="card text-start flex flex-col justify-between gap-5 min-h-36 w-full cursor-pointer transition-colors hover:bg-soft outline-offset-2">
            <span className="flex items-start justify-between gap-3">
              <h2>{e.name}</h2>
              <StatusLabel value={e.status} />
            </span>
            <span className="flex items-end justify-between gap-3">
              <span className="text-ink-75"><span className="text-ink font-bold text-2xl tnum">{counts[e.id] ?? 0}</span> {L('clients')}</span>
              <span className="text-sm text-ink-50">{L('Open settings')} →</span>
            </span>
          </button>
        ))}
      </div>
      {shared && <SharedSettingsDialog onClose={() => setShared(false)} />}
      {adding && (
        <Modal title={L('Add a company')} onClose={() => { setAdding(false); setName('') }}>
          <form onSubmit={addEntity} className="space-y-5">
            <Field label={L('Company name')}><input required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex justify-end gap-3">
              <button type="button" className="btn btn-quiet" onClick={() => { setAdding(false); setName('') }}>{t('cancel')}</button>
              <button className="btn">{t('addEntity')}</button>
            </div>
          </form>
        </Modal>
      )}

      {openId && entities.find((e) => e.id === openId) && (
        <CompanyDialog key={openId} startTab={openTab} entity={entities.find((e) => e.id === openId)!} onClose={() => setOpenId(null)} onChanged={() => { load(); reload() }} />
      )}
    </>
  )
}
