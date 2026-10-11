import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth, type Persona } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useTheme } from '../lib/theme'
import type { Entity } from '../lib/types'
import CommandPalette from './CommandPalette'
import Select from './Select'

interface Item { to: string; label: string; show: boolean; count?: number }

/** Lets a superadmin preview the app as a lower role. Tucked away because most people never need it. */
function PersonaSwitcher() {
  const { L } = useI18n()
  const { persona, setPersona } = useAuth()
  const [entities, setEntities] = useState<Entity[]>([])
  useEffect(() => { supabase.from('entities').select('*').order('name').then(({ data }) => setEntities((data as Entity[]) ?? [])) }, [])

  const kind = persona?.kind ?? 'superadmin'
  const entityId = persona && persona.kind !== 'superadmin' ? persona.entityId : ''

  function choose(next: Persona['kind'], eid = entityId || entities.find((e) => e.slug === 'g-communities')?.id || entities[0]?.id) {
    if (next === 'superadmin') return setPersona(null)
    if (!eid) return
    setPersona(next === 'entity_admin' ? { kind: 'entity_admin', entityId: eid } : { kind: 'employee', entityId: eid })
  }

  return (
    <details className="mt-2 text-sm" open={!!persona && persona.kind !== 'superadmin'}>
      <summary className="px-3 py-2 rounded-xl text-ink-50 hover:bg-soft list-none">{L('Preview as another role')}</summary>
      <div className="px-3 pt-2 pb-1 space-y-3">
        <label className="field">
          <span className="sr-only">{L('View as')}</span>
          <Select value={kind} onChange={(e) => choose(e.target.value as Persona['kind'])}>
            <option value="superadmin">{L('Superadmin')}</option>
            <option value="entity_admin">{L('Entity admin')}</option>
            <option value="employee">{L('Employee')}</option>
          </Select>
        </label>
        {persona && persona.kind !== 'superadmin' && (
          <label className="field">
            <span>{L('Entity')}</span>
            <Select value={entityId} onChange={(e) => choose(persona.kind, e.target.value)}>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </label>
        )}
      </div>
    </details>
  )
}

export default function Shell() {
  const { profile, can, signOut, entitiesWith, isSuper, persona, setPersona } = useAuth()
  const { t, L, toggle } = useI18n()
  const { theme, toggle: toggleTheme } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()
  const [palette, setPalette] = useState(false)
  const [mode, setMode] = useState('')
  const [counts, setCounts] = useState({ alerts: 0, requests: 0 })

  const manager = isSuper || entitiesWith('member.manage').length > 0
  const main: Item[] = [{ to: '/overview', label: t('overview'), show: true }]
  const messages: Item[] = [
    { to: '/send', label: L('Send messages'), show: can('message.send') },
    { to: '/templates', label: t('templates'), show: can('template.read') },
    { to: '/owners', label: L('Clients'), show: can('owner.read') },
  ]
  const activity: Item[] = [
    { to: '/log', label: L('History'), show: can('log.read') },
    { to: '/alerts', label: L('Alerts'), show: true, count: counts.alerts },
  ]
  const admin: Item[] = [
    { to: '/admin/people', label: L('People'), show: manager, count: isSuper ? counts.requests : 0 },
    { to: '/admin/entities', label: L('Companies'), show: isSuper },
  ]
  const allPages = [...main, ...messages, ...activity, ...admin].filter((i) => i.show)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { supabase.rpc('whatsapp_mode').then(({ data }) => setMode((data as string) ?? '')) }, [])
  useEffect(() => {
    const refresh = async () => {
      const [a, r] = await Promise.all([
        supabase.rpc('unread_notifications'),
        isSuper ? supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending') : Promise.resolve({ count: 0 }),
      ])
      setCounts({ alerts: (a.data as number) ?? 0, requests: r.count ?? 0 })
    }
    refresh()
    const ch = supabase.channel('shell-counts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, refresh)
      .subscribe()
    window.addEventListener('counts-changed', refresh)
    return () => { supabase.removeChannel(ch); window.removeEventListener('counts-changed', refresh) }
  }, [isSuper])
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

  const group = (label: string | null, items: Item[]) => {
    const visible = items.filter((i) => i.show)
    if (!visible.length) return null
    return (
      <div className="mb-5">
        {label && <p className="px-3 mb-1.5 text-xs font-medium text-ink-50">{label}</p>}
        <ul className="space-y-0.5">
          {visible.map((i) => (
            <li key={i.to}>
              <NavLink to={i.to}
                className={({ isActive }) => `flex items-center justify-between gap-3 px-3 min-h-10 rounded-xl transition-colors duration-150 ${
                  isActive ? 'bg-paper text-ink font-medium shadow-[var(--shadow-sm)]' : 'text-ink-75 hover:bg-paper/60 hover:text-ink'}`}>
                <span>{i.label}</span>
                {!!i.count && <span className="status tone-bad tnum">{i.count}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const phoneGroups = ([[null, main], [L('Messages'), messages], [L('Activity'), activity], [t('administration'), admin]] as [string | null, Item[]][])
    .map(([label, items]) => [label, items.filter((i) => i.show)] as [string | null, Item[]]).filter(([, items]) => items.length > 0)
  const currentPath = allPages.filter((i) => pathname === i.to || pathname.startsWith(i.to + '/')).sort((a, b) => b.to.length - a.to.length)[0]?.to ?? ''
  const currentLabel = allPages.find((i) => i.to === currentPath)?.label ?? t('menu')
  useEffect(() => { setMenuOpen(false) }, [pathname])
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div className="min-h-screen sm:grid sm:grid-cols-[13rem_1fr] lg:grid-cols-[16rem_1fr]">
      <aside className="sm:sticky sm:top-0 sm:h-screen flex flex-col px-4 pt-5 pb-4 max-sm:pb-2">
        <div className="flex items-center justify-between px-3 pb-5">
          <div>
            <img src="/brand/g-developments-logo-black.png" alt="G Developments" className="h-6 w-auto logo-light" />
            <img src="/brand/g-developments-logo-white.png" alt="G Developments" className="h-6 w-auto logo-dark" />
          </div>
        </div>
        <div className="sm:hidden relative px-1 pb-3">
          <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}
            className={`w-full min-h-12 px-4 rounded-2xl flex items-center justify-between gap-3 text-ink font-medium transition-colors ${menuOpen ? 'bg-paper shadow-[var(--shadow-sm)]' : 'bg-card'}`}>
            <span className="truncate">{currentLabel}</span>
            <svg className={`menu-chevron shrink-0 ${menuOpen ? 'rotate-180' : ''}`} width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <button type="button" aria-label={t('close')} tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setMenuOpen(false)} />
              <div role="menu" className="menu-panel absolute z-40 inset-x-1 top-[calc(100%-0.5rem)] max-h-[70vh] overflow-y-auto rounded-2xl bg-paper p-2 shadow-[var(--shadow)]">
                {phoneGroups.map(([label, items], gi) => (
                  <div key={label ?? 'main'} className={gi ? 'mt-2 pt-2 border-t border-[var(--line)]' : ''}>
                    {label && <p className="px-3 pt-1 pb-1 text-xs font-medium text-ink-50">{label}</p>}
                    {items.map((i, ii) => {
                      const active = i.to === currentPath
                      return (
                        <NavLink key={i.to} to={i.to} role="menuitem" onClick={() => setMenuOpen(false)}
                          style={{ animationDelay: `${Math.min(gi * 3 + ii, 14) * 22}ms` }}
                          className={`menu-item flex items-center justify-between gap-3 px-3 min-h-11 rounded-xl transition-colors ${active ? 'bg-card text-ink font-medium' : 'text-ink-75 active:bg-card'}`}>
                          <span className="flex items-center gap-3">
                            <span className={`h-1.5 w-1.5 rounded-full transition-colors ${active ? 'bg-ink' : 'bg-transparent'}`} />
                            {i.label}
                          </span>
                          {!!i.count && <span className="status tone-bad tnum">{i.count}</span>}
                        </NavLink>
                      )
                    })}
                  </div>
                ))}
                <div className="mt-2 pt-2 border-t border-[var(--line)]">
                  <p className="px-3 pt-1 pb-1 text-xs font-medium text-ink-50">{L('Account')}</p>
                  {[
                    { key: 'lang', label: t('language'), run: toggle },
                    { key: 'theme', label: theme === 'dark' ? L('Light') : L('Dark'), run: toggleTheme },
                    { key: 'out', label: t('signOut'), run: signOut },
                  ].map((a, ai) => (
                    <button key={a.key} type="button" role="menuitem" onClick={() => { setMenuOpen(false); a.run() }}
                      style={{ animationDelay: `${Math.min(phoneGroups.length * 3 + ai, 14) * 22}ms` }}
                      className="menu-item w-full text-start flex items-center gap-3 px-3 min-h-11 rounded-xl text-ink-75 active:bg-card transition-colors">
                      <span className="h-1.5 w-1.5" />{a.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <nav id="main-nav" aria-label="Main" className="hidden sm:flex flex-col flex-1 overflow-y-auto">
          {group(null, main)}
          {group(L('Messages'), messages)}
          {group(L('Activity'), activity)}
          {group(t('administration'), admin)}
          <div className="mt-auto pt-3">
            {profile?.is_superadmin && <PersonaSwitcher />}
            <div className="px-3 pt-3 text-sm">
              <p className="text-ink font-medium truncate">{profile?.full_name || profile?.email}</p>
              <p className="text-ink-50 text-xs truncate mb-2">{profile?.email}</p>
              <div className="flex flex-wrap gap-x-1 -ms-2.5">
                <button className="link-btn !text-ink-75" onClick={toggle}>{t('language')}</button>
                <button className="link-btn !text-ink-75" onClick={toggleTheme}>{theme === 'dark' ? L('Light') : L('Dark')}</button>
                <button className="link-btn !text-ink-75" onClick={signOut}>{t('signOut')}</button>
              </div>
            </div>
          </div>
        </nav>
      </aside>

      <div className="min-w-0 p-3 sm:p-4 sm:ps-0">
        <div className="sheet min-h-[calc(100vh-1.5rem)] sm:min-h-[calc(100vh-2rem)]">
          {persona && persona.kind !== 'superadmin' && (
            <div role="status" className="notice notice-warn !m-4 !mb-0 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>{L('Viewing as')} {persona.kind === 'entity_admin' ? L('Entity admin') : L('Employee')}. {L('This only changes what you see.')}</span>
              <button className="link-btn" onClick={() => setPersona(null)}>{L('Exit')}</button>
            </div>
          )}
          <header className="px-5 md:px-8 pt-5 flex items-center justify-between gap-4">
            <button onClick={() => setPalette(true)} aria-label={L('Search')}
              className="flex-1 max-w-md text-start min-h-11 px-4 rounded-full bg-card border-0 text-ink-50 hover:text-ink-75 flex items-center justify-between gap-4 transition-colors">
              <span className="truncate">{L('Search anything')}</span>
              <span className="text-xs bg-paper rounded-md px-2 py-0.5 hidden sm:inline">{isMac ? '⌘K' : 'Ctrl K'}</span>
            </button>
            <div className="flex items-center gap-2">
              {mode && (
                <span className={`status ${mode === 'live' ? 'tone-ok' : 'tone-warn'}`}
                  title={mode === 'demo' ? L('Messages are recorded but not sent to WhatsApp') : L('Messages are sent through WhatsApp')}>
                  {mode === 'demo' ? L('Demo mode') : L('Live')}
                </span>
              )}
            </div>
          </header>
          <main className="px-5 md:px-8 py-7 md:py-8 max-w-[1100px]">
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={allPages.map((i) => ({ to: i.to, label: i.label }))} />
    </div>
  )
}
