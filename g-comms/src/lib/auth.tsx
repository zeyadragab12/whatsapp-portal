import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Entity, Membership, Perm, Profile, Project, Role, Template } from './types'

/** Persona simulation lets a superadmin preview the app as a lower role. It only changes what the UI shows. */
export type Persona =
  | { kind: 'superadmin' }
  | { kind: 'entity_admin'; entityId: string }
  | { kind: 'employee'; entityId: string }

interface Ctx {
  session: Session | null
  profile: Profile | null
  memberships: Membership[]
  entities: Entity[]
  roles: Role[]
  loading: boolean
  persona: Persona | null
  setPersona: (p: Persona | null) => void
  isSuper: boolean
  can: (perm: Perm, entityId?: string) => boolean
  entitiesWith: (perm: Perm) => Entity[]
  projectAllowed: (p: Pick<Project, 'id' | 'entity_id'>) => boolean
  templateAllowed: (t: Pick<Template, 'entity_id' | 'project_ids'>) => boolean
  reload: () => Promise<void>
  signOut: () => Promise<void>
}
const AuthCtx = createContext<Ctx>(null as never)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [allEntities, setAllEntities] = useState<Entity[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [persona, setPersonaState] = useState<Persona | null>(null)
  const [loading, setLoading] = useState(true)
  const loadedUser = useRef<string | null>(null)

  const load = useCallback(async (s: Session | null) => {
    loadedUser.current = s?.user.id ?? null
    if (!s) {
      setProfile(null); setMemberships([]); setAllEntities([]); setRoles([]); setLoading(false)
      return
    }
    const { data: p } = await supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle()
    setProfile((p as Profile) ?? null)
    if (p?.status === 'approved') {
      const [m, e, r] = await Promise.all([
        supabase.from('entity_members').select('entity_id, role_id, roles(name, permissions)').eq('user_id', s.user.id),
        supabase.from('entities').select('*').order('name'),
        supabase.from('roles').select('*').order('name'),
      ])
      setMemberships((m.data as unknown as Membership[]) ?? [])
      setAllEntities((e.data as Entity[]) ?? [])
      setRoles((r.data as Role[]) ?? [])
    } else {
      setMemberships([]); setAllEntities([]); setRoles([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); load(data.session) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      // a new sign-in holds the UI until the profile loads; token refreshes for the same user must not unmount the app
      if (s && loadedUser.current !== s.user.id) setLoading(true)
      setTimeout(() => load(s), 0) // defer so the auth callback is not blocked by our own queries
    })
    return () => sub.subscription.unsubscribe()
  }, [load])

  const realSuper = !!profile?.is_superadmin && profile.status === 'approved'
  const activePersona = realSuper ? persona : null
  const rolePerms = useCallback((name: string) => roles.find((r) => r.name === name)?.permissions ?? [], [roles])

  const setPersona = (p: Persona | null) => {
    setPersonaState(p)
    try { if (p) sessionStorage.setItem('persona', JSON.stringify(p)); else sessionStorage.removeItem('persona') } catch { /* storage unavailable */ }
  }
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('persona')
      if (raw) setPersonaState(JSON.parse(raw) as Persona)
    } catch { /* storage unavailable */ }
  }, [])

  const isSuper = realSuper && (!activePersona || activePersona.kind === 'superadmin')

  const can = useCallback((perm: Perm, entityId?: string) => {
    if (profile?.status !== 'approved') return false
    if (realSuper) {
      if (!activePersona || activePersona.kind === 'superadmin') return true
      if (entityId && entityId !== activePersona.entityId) return false
      return rolePerms(activePersona.kind === 'entity_admin' ? 'Entity Admin' : 'Employee').includes(perm)
    }
    return memberships.some((m) => (!entityId || m.entity_id === entityId) && m.roles?.permissions.includes(perm))
  }, [profile, realSuper, activePersona, rolePerms, memberships])

  const entities = useMemo(
    () => (activePersona && activePersona.kind !== 'superadmin' ? allEntities.filter((e) => e.id === activePersona.entityId) : allEntities),
    [allEntities, activePersona],
  )
  const entitiesWith = useCallback((perm: Perm) => entities.filter((e) => can(perm, e.id)), [entities, can])

  const projectAllowed = useCallback((p: Pick<Project, 'id' | 'entity_id'>) => {
    if (!activePersona || activePersona.kind === 'superadmin') return true
    return p.entity_id === activePersona.entityId
  }, [activePersona])

  const templateAllowed = useCallback((t: Pick<Template, 'entity_id' | 'project_ids'>) => {
    if (!activePersona || activePersona.kind === 'superadmin') return true
    return t.entity_id === activePersona.entityId
  }, [activePersona])

  const value: Ctx = {
    session, profile, memberships, entities, roles, loading, persona: activePersona, setPersona, isSuper, can, entitiesWith,
    projectAllowed, templateAllowed,
    reload: () => load(session),
    signOut: async () => { setPersona(null); await supabase.auth.signOut() },
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
export const useAuth = () => useContext(AuthCtx)
