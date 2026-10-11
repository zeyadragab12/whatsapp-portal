-- a client added by hand brings its fields into the list it joins
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
  insert into public.client_list_fields (list_id, key)
    select lid, k from public.project_owners po, jsonb_object_keys(po.extra) k
    where po.project_id = p_project and po.owner_id = p_owner
      and exists (select 1 from public.owner_fields f where f.entity_id = eid and f.key = k)
    on conflict do nothing;
  return lid;
end $$;
