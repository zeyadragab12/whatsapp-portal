-- The 30-field cap counts only fields that belong to a list. Fields left behind by deleted lists no longer block imports.
create or replace function public.register_owner_fields(p_entity uuid, p_extra jsonb, p_labels jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare k text; v text; reserved text[] := array['owner_name','unit_number','phone','email','project_name','project_code','entity_name'];
begin
  for k, v in select key, value from jsonb_each_text(coalesce(p_extra, '{}'::jsonb)) loop
    if k = any(reserved) then raise exception 'The field name % is reserved', k; end if;
    if k !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'Invalid field name %', k; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if (select count(*) from public.owner_fields f where f.entity_id = p_entity
          and exists (select 1 from public.client_list_fields lf join public.client_lists l on l.id = lf.list_id where l.entity_id = p_entity and lf.key = f.key)) >= 30
       and not exists (select 1 from public.owner_fields where entity_id = p_entity and key = k) then
      raise exception 'A company can have at most 30 custom fields';
    end if;
    insert into public.owner_fields (entity_id, key, label, example)
    values (p_entity, k, coalesce(nullif(trim(p_labels->>k), ''), initcap(replace(k, '_', ' '))), left(trim(v), 200))
    on conflict (entity_id, key) do update set label = excluded.label
      where not exists (select 1 from public.client_list_fields lf join public.client_lists l on l.id = lf.list_id where l.entity_id = p_entity and lf.key = excluded.key);
  end loop;
end $$;

create or replace function public.create_client_list(p_project uuid, p_name text, p_fields jsonb default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare eid uuid; lid uuid; k text; v text; keys text[] := '{}'; nm text := trim(coalesce(p_name, ''));
        reserved text[] := array['owner_name','unit_number','phone','email','project_name','project_code','entity_name'];
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  if length(nm) = 0 then raise exception 'The list needs a name'; end if;
  select entity_id into eid from public.projects where id = p_project;
  for k, v in select key, value from jsonb_each_text(coalesce(p_fields, '{}'::jsonb)) loop
    if k = any(reserved) or k !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'Invalid field name %', v; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if (select count(*) from public.owner_fields f where f.entity_id = eid
          and exists (select 1 from public.client_list_fields lf join public.client_lists l on l.id = lf.list_id where l.entity_id = eid and lf.key = f.key)) >= 30
       and not exists (select 1 from public.owner_fields where entity_id = eid and key = k) then
      raise exception 'A company can have at most 30 custom fields';
    end if;
    insert into public.owner_fields (entity_id, key, label) values (eid, k, left(trim(v), 80))
    on conflict (entity_id, key) do update set label = excluded.label
      where not exists (select 1 from public.client_list_fields lf join public.client_lists l on l.id = lf.list_id where l.entity_id = eid and lf.key = excluded.key);
    keys := keys || k;
  end loop;
  insert into public.client_lists (entity_id, name, created_by) values (eid, left(nm, 80), (select auth.uid())) returning id into lid;
  insert into public.client_list_fields (list_id, key) select lid, x from unnest(keys) x;
  return lid;
exception when unique_violation then raise exception 'A list with this name already exists';
end $$;
