-- A client added by hand must belong to a list. With no list given, the company's first list is used;
-- a company with no list gets one called "Clients".
create or replace function public.add_client_to_list(p_project uuid, p_owner uuid, p_list uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare eid uuid; lid uuid := p_list;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  select entity_id into eid from public.projects where id = p_project;
  if lid is not null and not exists (select 1 from public.client_lists where id = lid and entity_id = eid) then
    raise exception 'That list does not belong to this company';
  end if;
  if lid is null then
    select id into lid from public.client_lists where entity_id = eid order by name limit 1;
  end if;
  if lid is null then
    insert into public.client_lists (entity_id, name, created_by) values (eid, 'Clients', (select auth.uid())) returning id into lid;
  end if;
  insert into public.client_list_members (list_id, owner_id) values (lid, p_owner) on conflict do nothing;
  return lid;
end $$;

revoke execute on function public.add_client_to_list(uuid, uuid, uuid) from public, anon;
grant execute on function public.add_client_to_list(uuid, uuid, uuid) to authenticated;

-- creates a list; p_fields is {key: label} for the fields the list's clients carry (fields belong to the company)
create or replace function public.create_client_list(p_project uuid, p_name text, p_fields jsonb default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare eid uuid; lid uuid; k text; v text; nm text := trim(coalesce(p_name, ''));
        reserved text[] := array['owner_name','unit_number','phone','email','project_name','project_code','entity_name'];
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  if length(nm) = 0 then raise exception 'The list needs a name'; end if;
  select entity_id into eid from public.projects where id = p_project;
  for k, v in select key, value from jsonb_each_text(coalesce(p_fields, '{}'::jsonb)) loop
    if k = any(reserved) or k !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'Invalid field name %', v; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if (select count(*) from public.owner_fields where entity_id = eid) >= 30
       and not exists (select 1 from public.owner_fields where entity_id = eid and key = k) then
      raise exception 'A company can have at most 30 custom fields';
    end if;
    insert into public.owner_fields (entity_id, key, label) values (eid, k, left(trim(v), 80))
    on conflict (entity_id, key) do nothing;
  end loop;
  insert into public.client_lists (entity_id, name, created_by) values (eid, left(nm, 80), (select auth.uid())) returning id into lid;
  return lid;
exception when unique_violation then raise exception 'A list with this name already exists';
end $$;

create or replace function public.rename_owner_field(p_project uuid, p_key text, p_label text) returns void
language plpgsql security definer set search_path = public as $$
declare eid uuid;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed'; end if;
  if length(trim(coalesce(p_label, ''))) = 0 then raise exception 'The field needs a name'; end if;
  select entity_id into eid from public.projects where id = p_project;
  update public.owner_fields set label = left(trim(p_label), 80) where entity_id = eid and key = p_key;
end $$;

revoke execute on function public.create_client_list(uuid, text, jsonb), public.rename_owner_field(uuid, text, text) from public, anon;
grant execute on function public.create_client_list(uuid, text, jsonb), public.rename_owner_field(uuid, text, text) to authenticated;
