-- take clients out of one group only; they stay in the client list and in their other groups
create or replace function public.remove_from_group(p_list uuid, p_owners uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare l public.client_lists; n integer;
begin
  select * into l from public.client_lists where id = p_list;
  if l.id is null or not public.has_perm(l.entity_id, 'owner.manage') then raise exception 'Not allowed'; end if;
  with gone as (
    delete from public.client_list_members where list_id = p_list and owner_id = any(p_owners) returning owner_id)
  select count(*) into n from gone;
  return n;
end $$;

revoke all on function public.remove_from_group(uuid, uuid[]) from public, anon;
grant execute on function public.remove_from_group(uuid, uuid[]) to authenticated;
