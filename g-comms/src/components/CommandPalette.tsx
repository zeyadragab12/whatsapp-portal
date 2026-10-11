import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

interface Hit { id: string; group: string; label: string; hint?: string; to: string }

/** Ctrl/Cmd + K quick search over pages, templates and clients. */
export default function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: { to: string; label: string }[] }) {
  const { L } = useI18n()
  const { templateAllowed, can } = useAuth()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [data, setData] = useState<Hit[]>([])
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ(''); setActive(0)
    requestAnimationFrame(() => input.current?.focus())
    ;(async () => {
      const hits: Hit[] = []
      if (can('template.read')) {
        const { data: t } = await supabase.from('whatsapp_templates').select('id, name, status, entity_id, project_ids').limit(200)
        ;((t as { id: string; name: string; status: string; entity_id: string; project_ids: string[] }[]) ?? [])
          .filter(templateAllowed).forEach((x) => hits.push({ id: `t${x.id}`, group: L('Templates'), label: x.name, hint: x.status.toLowerCase().replace('_', ' '), to: `/templates/${x.id}` }))
      }
      setData(hits)
    })()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // clients are searched in the database as you type, so every client can be found
  const [clients, setClients] = useState<Hit[]>([])
  useEffect(() => {
    const s = q.trim().replace(/[,()%*\\]/g, ' ').trim()
    if (!open || !can('owner.read') || s.length < 2) { setClients([]); return }
    const digits = s.replace(/\D/g, '').replace(/^0+/, '')
    const filter = digits.length >= 3 ? `full_name.ilike.%${s}%,phone.ilike.%${digits}%` : `full_name.ilike.%${s}%`
    const timer = setTimeout(async () => {
      const { data: o } = await supabase.from('owners').select('id, full_name, phone').or(filter).order('full_name').limit(8)
      setClients(((o as { id: string; full_name: string; phone: string }[]) ?? []).map((x) => ({
        id: `o${x.id}`, group: L('Clients'), label: x.full_name, hint: x.phone, to: `/owners?q=${encodeURIComponent(x.phone)}`,
      })))
    }, 200)
    return () => clearTimeout(timer)
  }, [q, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const all: Hit[] = [...pages.map((p) => ({ id: `g${p.to}`, group: L('Pages'), label: p.label, to: p.to })), ...data]
    const s = q.trim().toLowerCase()
    const local = s ? all.filter((h) => h.label.toLowerCase().includes(s) || h.hint?.toLowerCase().includes(s)) : all.filter((h) => h.group === L('Pages'))
    return [...local, ...(s ? clients : [])].slice(0, 14)
  }, [q, data, clients, pages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(0) }, [q])

  if (!open) return null
  const go = (h: Hit) => { onClose(); nav(h.to) }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={L('Search')} className="w-full max-w-xl sheet overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && results[active]) go(results[active])
        }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded="true" aria-controls="cmd-list"
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          placeholder={L('Search pages, templates and clients')}
          className="w-full min-h-14 px-6 bg-paper text-ink border-0 border-b border-ink-25 outline-none text-base" />
        <ul id="cmd-list" role="listbox" className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 && <li className="px-5 py-4 text-ink-50">{L('Nothing found.')}</li>}
          {results.map((h, i) => (
            <li key={h.id} id={`cmd-${h.id}`} role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onClick={() => go(h)}
              className={`flex justify-between gap-4 px-4 min-h-11 items-center cursor-pointer rounded-xl ${i === active ? 'bg-soft text-ink' : 'text-ink'}`}>
              <span className="truncate">{h.label}</span>
              <span className="text-sm opacity-60 whitespace-nowrap">{h.group}{h.hint ? ` · ${h.hint}` : ''}</span>
            </li>
          ))}
        </ul>
        <p className="px-6 py-3 text-sm text-ink-50 bg-card">{L('Up and down to move, Enter to open, Esc to close')}</p>
      </div>
    </div>
  )
}
