
-- A member can be limited to some client groups of a company. No row = every group of the company.
create table public.member_scope (
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  list_ids uuid[] not null,
  primary key (user_id, entity_id)
);
alter table public.member_scope enable row level security;
create policy member_scope_select on public.member_scope for select
  using (user_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage'));
create policy member_scope_write on public.member_scope for all
  using (public.has_perm(entity_id, 'member.manage')) with check (public.has_perm(entity_id, 'member.manage'));

-- null = no limit
create or replace function public.scope_lists(eid uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when public.is_superadmin() then null
    else (select ms.list_ids from public.member_scope ms where ms.user_id = (select auth.uid()) and ms.entity_id = eid) end
$$;

create or replace function public.can_see_owner(pid uuid, oid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when s.l is null then true
      else exists (select 1 from public.client_list_members m where m.owner_id = oid and m.list_id = any(s.l)) end
    from (select public.scope_lists((select entity_id from public.projects where id = pid)) as l) s
  ), true)
$$;

drop policy powners_select on public.project_owners;
create policy powners_select on public.project_owners for select
  using (public.can_access_project(project_id, 'owner.read') and public.can_see_owner(project_id, owner_id));

drop policy owners_select on public.owners;
create policy owners_select on public.owners for select
  using (public.is_superadmin() or exists (
    select 1 from public.project_owners po
    where po.owner_id = owners.id and public.can_access_project(po.project_id, 'owner.read') and public.can_see_owner(po.project_id, owners.id)));

drop policy client_lists_select on public.client_lists;
create policy client_lists_select on public.client_lists for select
  using (public.has_perm(entity_id, 'owner.read') and (public.scope_lists(entity_id) is null or id = any(public.scope_lists(entity_id))));

drop policy logs_select on public.message_logs;
create policy logs_select on public.message_logs for select
  using (public.can_access_project(project_id, 'log.read') and (owner_id is null or public.can_see_owner(project_id, owner_id)));

-- a limited member who imports a file keeps access to the group that import creates
create or replace function public.import_owners(p_project uuid, p_rows jsonb, p_labels jsonb default '{}'::jsonb, p_list_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; ok int := 0; bad jsonb := '[]'; i int := 0; oid uuid; eid uuid; lid uuid; ids uuid[] := '{}'; nm text := nullif(trim(coalesce(p_list_name, '')), '');
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Import up to 2000 rows at a time'; end if;
  select entity_id into eid from public.projects where id = p_project;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select o.id into oid from public.owners o join public.project_owners po on po.owner_id = o.id
        where po.project_id = p_project and o.phone = (r->>'phone') and o.full_name = trim(r->>'full_name') limit 1;
      oid := public.upsert_owner(p_project, oid, r->>'full_name', r->>'phone', r->>'email', r->>'unit_number', true, coalesce(r->'extra', '{}'::jsonb), p_labels);
      ids := ids || oid;
      ok := ok + 1;
    exception when others then
      bad := bad || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  if nm is not null and ok > 0 then
    select id into lid from public.client_lists where entity_id = eid and lower(name) = lower(nm);
    if lid is null then
      insert into public.client_lists (entity_id, name, source_file, created_by) values (eid, nm, nm, (select auth.uid())) returning id into lid;
    end if;
    insert into public.client_list_members (list_id, owner_id) select lid, x from unnest(ids) x on conflict do nothing;
    update public.member_scope set list_ids = array_append(list_ids, lid)
      where user_id = (select auth.uid()) and entity_id = eid and not (lid = any(list_ids));
  end if;
  return jsonb_build_object('imported', ok, 'failed', bad, 'list_id', lid, 'list_name', nm);
end $$;

revoke all on function public.scope_lists(uuid) from public, anon;
revoke all on function public.can_see_owner(uuid, uuid) from public, anon;
grant execute on function public.scope_lists(uuid) to authenticated;
grant execute on function public.can_see_owner(uuid, uuid) to authenticated;
