-- Every client lives in a list. Deleting a list also deletes the clients that are in no other list; clients in another list stay.
create or replace function public.delete_client_list(p_list uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.client_lists; ids uuid[];
begin
  select * into l from public.client_lists where id = p_list;
  if l.id is null or not public.has_perm(l.entity_id, 'owner.manage') then raise exception 'Not allowed'; end if;
  select coalesce(array_agg(owner_id), '{}') into ids from public.client_list_members where list_id = p_list;
  delete from public.client_lists where id = p_list;
  delete from public.project_owners po
    where po.owner_id = any(ids)
      and po.project_id in (select id from public.projects where entity_id = l.entity_id)
      and not exists (select 1 from public.client_list_members m join public.client_lists cl on cl.id = m.list_id
                      where m.owner_id = po.owner_id and cl.entity_id = l.entity_id);
end $$;

create or replace function public.delete_client_lists(p_entity uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_perm(p_entity, 'owner.manage') then raise exception 'Not allowed'; end if;
  with gone as (delete from public.client_lists where entity_id = p_entity returning id)
  select count(*) into n from gone;
  -- no list is left, so no client belongs anywhere
  delete from public.project_owners where project_id in (select id from public.projects where entity_id = p_entity);
  return n;
end $$;
