
create table public.client_lists (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  source_file text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index client_lists_name_key on public.client_lists (entity_id, lower(name));
create index on public.client_lists (created_by);

create table public.client_list_members (
  list_id uuid not null references public.client_lists(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, owner_id)
);
create index on public.client_list_members (owner_id);

alter table public.client_lists enable row level security;
alter table public.client_list_members enable row level security;
create policy client_lists_select on public.client_lists for select to authenticated using (public.has_perm(entity_id, 'owner.read'));
create policy client_list_members_select on public.client_list_members for select to authenticated
  using (exists (select 1 from public.client_lists l where l.id = list_id));

-- importing a file now saves its clients as a named list
drop function public.import_owners(uuid, jsonb, jsonb);
create or replace function public.import_owners(p_project uuid, p_rows jsonb, p_labels jsonb default '{}', p_list_name text default null)
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
  end if;
  return jsonb_build_object('imported', ok, 'failed', bad, 'list_id', lid, 'list_name', nm);
end $$;

create or replace function public.rename_client_list(p_list uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.client_lists;
begin
  select * into l from public.client_lists where id = p_list;
  if l.id is null or not public.has_perm(l.entity_id, 'owner.manage') then raise exception 'Not allowed'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'The list needs a name'; end if;
  update public.client_lists set name = trim(p_name) where id = p_list;
exception when unique_violation then raise exception 'A list with this name already exists';
end $$;

create or replace function public.delete_client_list(p_list uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.client_lists;
begin
  select * into l from public.client_lists where id = p_list;
  if l.id is null or not public.has_perm(l.entity_id, 'owner.manage') then raise exception 'Not allowed'; end if;
  delete from public.client_lists where id = p_list;   -- the clients themselves stay
end $$;

-- removing a client from the company list also takes them out of its groups
create or replace function public.remove_owner(p_project uuid, p_owner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare eid uuid;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  select entity_id into eid from public.projects where id = p_project;
  delete from public.project_owners where project_id = p_project and owner_id = p_owner;
  delete from public.client_list_members where owner_id = p_owner and list_id in (select id from public.client_lists where entity_id = eid);
end $$;

revoke execute on function public.import_owners(uuid,jsonb,jsonb,text), public.rename_client_list(uuid,text), public.delete_client_list(uuid), public.remove_owner(uuid,uuid) from public, anon;
grant execute on function public.import_owners(uuid,jsonb,jsonb,text), public.rename_client_list(uuid,text), public.delete_client_list(uuid), public.remove_owner(uuid,uuid) to authenticated;
