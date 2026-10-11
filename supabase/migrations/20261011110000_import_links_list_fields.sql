-- A list keeps the columns of the files imported into it.
-- A row only merges into an existing client when phone, name, unit AND every other column match; the same number with any different detail becomes its own client
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
        where po.project_id = p_project and o.phone = (r->>'phone') and o.full_name = trim(r->>'full_name')
          and coalesce(po.unit_no, '') = coalesce(nullif(trim(coalesce(r->>'unit_number', '')), ''), '')
          and coalesce(po.extra, '{}'::jsonb) = coalesce(r->'extra', '{}'::jsonb) limit 1;
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
    insert into public.client_list_fields (list_id, key)
      select distinct lid, k from jsonb_array_elements(p_rows) e, jsonb_object_keys(coalesce(e->'extra', '{}'::jsonb)) k
      where exists (select 1 from public.owner_fields f where f.entity_id = eid and f.key = k) on conflict do nothing;
  end if;
  return jsonb_build_object('imported', ok, 'failed', bad, 'list_id', lid, 'list_name', nm);
end $$;
