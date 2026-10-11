import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { Members, Requests, Roles } from './Admin'
import { PageHead } from '../components/ui'
import { Modal } from '../components/Dialog'

type ListId = 'requests' | 'members' | 'roles'

/** One place for everything about who can use the system. Each list opens in a popup. */
export function PeoplePage() {
  const { L } = useI18n()
  const { isSuper } = useAuth()
  const [params, setParams] = useSearchParams()
  const [counts, setCounts] = useState<{ pending: number; members: number }>({ pending: 0, members: 0 })

  const wanted = params.get('tab') as ListId | null
  const open: ListId | null = wanted && (isSuper || wanted === 'members') && ['requests', 'members', 'roles'].includes(wanted) ? wanted : null
  const openList = (id: ListId | null) => (id ? setParams({ tab: id }) : setParams({}))

  const loadCounts = useCallback(async () => {
    const [p, m] = await Promise.all([
      isSuper ? supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending') : Promise.resolve({ count: 0 }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).in('status', ['approved', 'suspended']),
    ])
    setCounts({ pending: p.count ?? 0, members: m.count ?? 0 })
  }, [isSuper])
  useEffect(() => { loadCounts() }, [loadCounts, open])

  const cards: { id: ListId; title: string; text: string; badge?: string; show: boolean }[] = [
    { id: 'requests', title: L('Requests'), text: L('People who signed up and are waiting for approval.'), badge: counts.pending ? `${counts.pending} ${L('waiting')}` : undefined, show: isSuper },
    { id: 'members', title: L('Members'), text: L('Everyone with access. Choose their companies, role and client groups.'), badge: `${counts.members}`, show: true },
    { id: 'roles', title: L('Roles'), text: L('What each role can do.'), show: isSuper },
  ]
  const titles: Record<ListId, string> = { requests: L('Requests'), members: L('Members'), roles: L('Roles') }

  return (
    <>
      <PageHead title={L('People')} sub={L('Approve new people, choose which entities they work in, and set what each role can do.')} />
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {cards.filter((c) => c.show).map((c) => (
          <button key={c.id} type="button" onClick={() => openList(c.id)}
            className="card text-start flex flex-col justify-between gap-5 min-h-36 w-full cursor-pointer transition-colors hover:bg-soft outline-offset-2">
            <span className="flex items-start justify-between gap-3">
              <h2>{c.title}</h2>
              {c.badge && <span className={`status ${c.id === 'requests' ? 'tone-warn' : 'tone-neutral'} tnum`}>{c.badge}</span>}
            </span>
            <span className="flex items-end justify-between gap-3">
              <span className="text-ink-75">{c.text}</span>
              <span className="text-sm text-ink-50 whitespace-nowrap">{L('Open')} →</span>
            </span>
          </button>
        ))}
      </div>

      {open && (
        <Modal title={titles[open]} onClose={() => openList(null)} size="xl">
          {open === 'requests' ? <Requests embedded /> : open === 'roles' ? <Roles embedded /> : <Members embedded />}
        </Modal>
      )}
    </>
  )
}
