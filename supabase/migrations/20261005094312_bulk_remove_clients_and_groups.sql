
create or replace function public.remove_owners(p_project uuid, p_owners uuid[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare eid uuid; n integer;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  select entity_id into eid from public.projects where id = p_project;
  with gone as (
    delete from public.project_owners
     where project_id = p_project and (p_owners is null or owner_id = any(p_owners))
    returning owner_id)
  select count(*) into n from gone;
  delete from public.client_list_members
   where list_id in (select id from public.client_lists where entity_id = eid)
     and not exists (select 1 from public.project_owners po where po.project_id = p_project and po.owner_id = client_list_members.owner_id);
  return n;
end $$;

create or replace function public.delete_client_lists(p_entity uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_perm(p_entity, 'owner.manage') then raise exception 'Not allowed'; end if;
  with gone as (delete from public.client_lists where entity_id = p_entity returning id)
  select count(*) into n from gone;
  return n;   -- the clients themselves stay
end $$;

revoke all on function public.remove_owners(uuid, uuid[]) from public, anon;
revoke all on function public.delete_client_lists(uuid) from public, anon;
grant execute on function public.remove_owners(uuid, uuid[]) to authenticated;
grant execute on function public.delete_client_lists(uuid) to authenticated;
