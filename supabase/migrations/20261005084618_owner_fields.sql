
alter table public.project_owners add column extra jsonb not null default '{}';

create table public.owner_fields (
  entity_id uuid not null references public.entities(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text not null,
  example text not null default 'Sample',
  created_at timestamptz not null default now(),
  primary key (entity_id, key)
);
alter table public.owner_fields enable row level security;
create policy owner_fields_select on public.owner_fields for select to authenticated
  using (public.has_perm(entity_id, 'owner.read') or public.has_perm(entity_id, 'template.read'));

-- rebuild the owner functions so imported columns are kept and registered as fields
drop function public.upsert_owner(uuid,uuid,text,text,text,text,boolean);
drop function public.import_owners(uuid,jsonb);

create or replace function public.register_owner_fields(p_entity uuid, p_extra jsonb, p_labels jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare k text; v text; reserved text[] := array['owner_name','unit_number','phone','email','project_name','project_code','entity_name'];
begin
  for k, v in select key, value from jsonb_each_text(coalesce(p_extra, '{}'::jsonb)) loop
    if k = any(reserved) then raise exception 'The field name % is reserved', k; end if;
    if k !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'Invalid field name %', k; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if (select count(*) from public.owner_fields where entity_id = p_entity) >= 30
       and not exists (select 1 from public.owner_fields where entity_id = p_entity and key = k) then
      raise exception 'An entity can have at most 30 custom fields';
    end if;
    insert into public.owner_fields (entity_id, key, label, example)
    values (p_entity, k, coalesce(nullif(trim(p_labels->>k), ''), initcap(replace(k, '_', ' '))), left(trim(v), 200))
    on conflict (entity_id, key) do nothing;
  end loop;
end $$;

create or replace function public.upsert_owner(p_project uuid, p_owner uuid, p_name text, p_phone text, p_email text, p_unit text, p_opt_in boolean,
                                               p_extra jsonb default '{}', p_labels jsonb default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid := p_owner; eid uuid; clean jsonb;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage owners for this project'; end if;
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone must be in E.164 format, for example +201010354164'; end if;
  select entity_id into eid from public.projects where id = p_project;
  -- keep only non-empty text values
  select coalesce(jsonb_object_agg(key, left(trim(value), 200)), '{}'::jsonb) into clean
    from jsonb_each_text(coalesce(p_extra, '{}'::jsonb)) where coalesce(trim(value), '') <> '';
  perform public.register_owner_fields(eid, clean, p_labels);
  if oid is null then
    insert into public.owners (full_name, phone, email, whatsapp_opt_in, opted_out_at)
    values (trim(p_name), p_phone, nullif(trim(coalesce(p_email,'')),''), p_opt_in, case when p_opt_in then null else now() end)
    returning id into oid;
  else
    if not exists (select 1 from public.project_owners where project_id = p_project and owner_id = oid) then
      raise exception 'Owner is not linked to this project';
    end if;
    update public.owners set full_name = trim(p_name), phone = p_phone, email = nullif(trim(coalesce(p_email,'')),''),
      whatsapp_opt_in = p_opt_in,
      opted_out_at = case when p_opt_in then null when whatsapp_opt_in then now() else opted_out_at end
    where id = oid;
  end if;
  if p_opt_in then delete from public.owner_optouts where owner_id = oid and entity_id = eid; end if;
  insert into public.project_owners (project_id, owner_id, unit_no, extra) values (p_project, oid, nullif(trim(coalesce(p_unit,'')),''), clean)
  on conflict (project_id, owner_id) do update set unit_no = excluded.unit_no, extra = project_owners.extra || excluded.extra;
  return oid;
end $$;

create or replace function public.import_owners(p_project uuid, p_rows jsonb, p_labels jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; ok int := 0; bad jsonb := '[]'; i int := 0; oid uuid;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage owners for this project'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Import up to 2000 rows at a time'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select o.id into oid from public.owners o join public.project_owners po on po.owner_id = o.id
        where po.project_id = p_project and o.phone = (r->>'phone') and o.full_name = trim(r->>'full_name') limit 1;
      perform public.upsert_owner(p_project, oid, r->>'full_name', r->>'phone', r->>'email', r->>'unit_number', true, coalesce(r->'extra', '{}'::jsonb), p_labels);
      ok := ok + 1;
    exception when others then
      bad := bad || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('imported', ok, 'failed', bad);
end $$;

revoke execute on function public.register_owner_fields(uuid,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.upsert_owner(uuid,uuid,text,text,text,text,boolean,jsonb,jsonb), public.import_owners(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.upsert_owner(uuid,uuid,text,text,text,text,boolean,jsonb,jsonb), public.import_owners(uuid,jsonb,jsonb) to authenticated;

-- sample owner fields so the Template editor has something real to show before any import
update public.whatsapp_templates set variables = (
  select coalesce(jsonb_agg(jsonb_build_object('name', v->>'name', 'example', coalesce(v->>'example', 'Sample'),
    'source', case v->>'source' when 'owner.full_name' then 'owner_name' when 'owner.unit_number' then 'unit_number' when 'owner.phone' then 'phone'
      when 'owner.email' then 'email' when 'project.name' then 'project_name' when 'project.code' then 'project_code' when 'entity.name' then 'entity_name'
      else coalesce(nullif(v->>'source', 'static'), v->>'name') end)), '[]'::jsonb)
  from jsonb_array_elements(variables) v);
